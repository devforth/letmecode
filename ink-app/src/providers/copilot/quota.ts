import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import { asRecord } from "../limits.js";

// ────────────────────────────────────────────────────────────────────────────
// Domain model
//
// One GitHub GET (`/copilot_internal/user`) feeds the Copilot plan/quota limit
// windows. Credential discovery, the HTTP fetch, and quota parsing live together
// here because they form a single, small responsibility.
// ────────────────────────────────────────────────────────────────────────────

export type GitHubCredentialSource =
  | "gh-token-env"
  | "github-token-env"
  | "gh-cli-config"
  | "keychain";

export type GitHubCredentials = {
  token: string;
  source: GitHubCredentialSource;
};

export type GitHubCredentialResult = {
  credentials: GitHubCredentials | null;
  warnings: string[];
};

export type CopilotQuota = {
  id: string;
  label: string;
  total?: number;
  remaining?: number;
  used?: number;
  usedPercent?: number;
  remainingPercent?: number;
};

export type CopilotQuotaInfo = {
  plan?: string;
  resetAt?: string;
  quotas: CopilotQuota[];
};

export type CopilotUserInfoResult = {
  quotaInfo?: CopilotQuotaInfo;
  warnings: string[];
  credentialSource?: GitHubCredentialSource;
};

/** Transport-level result. `data` is raw decoded JSON; parsing happens below. */
export type CopilotUserApiResult =
  | { ok: true; data: unknown }
  | { ok: false; warning: string };

// ────────────────────────────────────────────────────────────────────────────
// Orchestration
// ────────────────────────────────────────────────────────────────────────────

export type GetCopilotUserInfoOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  resolveCredentials?: typeof resolveGitHubCredentials;
  fetchUser?: typeof getCopilotUser;
};

/**
 * Resolves GitHub credentials and fetches the Copilot quota/plan, returning a
 * domain-level {@link CopilotUserInfoResult}. The GitHub token is never echoed
 * into the result, warnings, or errors. Credential resolution and the HTTP fetch
 * are injectable so tests run fully offline.
 */
export async function getCopilotUserInfo(
  options?: GetCopilotUserInfoOptions
): Promise<CopilotUserInfoResult> {
  const resolveCredentials = options?.resolveCredentials ?? resolveGitHubCredentials;
  const fetchUser = options?.fetchUser ?? getCopilotUser;

  const credentialResult = await resolveCredentials({
    env: options?.env,
    home: options?.home
  });
  const credentials = credentialResult.credentials;

  if (credentials === null) {
    return {
      quotaInfo: undefined,
      warnings: [
        "GitHub credentials were not found; Copilot plan and quota are unavailable."
      ]
    };
  }

  const apiResult = await fetchUser(credentials.token);
  if (!apiResult.ok) {
    return {
      warnings: [apiResult.warning],
      credentialSource: credentials.source
    };
  }

  return {
    quotaInfo: parseCopilotQuota(apiResult.data),
    credentialSource: credentials.source,
    warnings: []
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Credential resolution (no dependency on the `gh` CLI at runtime)
//
// Order: GH_TOKEN env → GITHUB_TOKEN env → gh CLI hosts.yml → macOS keychain.
// A missing token is NOT an error: it resolves to `{ credentials: null }`. The
// token is NEVER placed in any warning.
// ────────────────────────────────────────────────────────────────────────────

export type ResolveGitHubCredentialsOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
};

const KEYCHAIN_TIMEOUT_MS = 2_000;

export async function resolveGitHubCredentials(
  options?: ResolveGitHubCredentialsOptions
): Promise<GitHubCredentialResult> {
  const env = options?.env ?? process.env;
  const home = options?.home ?? os.homedir();

  const ghToken = trimToken(env.GH_TOKEN);
  if (ghToken) {
    return ok({ token: ghToken, source: "gh-token-env" });
  }

  const githubToken = trimToken(env.GITHUB_TOKEN);
  if (githubToken) {
    return ok({ token: githubToken, source: "github-token-env" });
  }

  const configToken = await readGhHostsToken(env, home);
  if (configToken) {
    return ok({ token: configToken, source: "gh-cli-config" });
  }

  if (process.platform === "darwin") {
    const keychainToken = await readKeychainToken();
    if (keychainToken) {
      return ok({ token: keychainToken, source: "keychain" });
    }
  }

  return { credentials: null, warnings: [] };
}

function ok(credentials: GitHubCredentials): GitHubCredentialResult {
  return { credentials, warnings: [] };
}

function trimToken(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? decodeKeyringToken(trimmed) : undefined;
}

const GO_KEYRING_BASE64_PREFIX = "go-keyring-base64:";

/**
 * The `gh` keyring backend (and some hosts.yml/keychain entries) store the token
 * as `go-keyring-base64:<base64>`. Decode that envelope so the raw token is used
 * on the wire. A value without the prefix, or an undecodable payload, is returned
 * unchanged.
 */
function decodeKeyringToken(value: string): string {
  if (!value.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    return value;
  }
  const encoded = value.slice(GO_KEYRING_BASE64_PREFIX.length);
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
    return decoded.length > 0 ? decoded : value;
  } catch {
    return value;
  }
}

function resolveGhConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const fromConfigDir = trimToken(env.GH_CONFIG_DIR);
  if (fromConfigDir) {
    return fromConfigDir;
  }

  const xdgConfigHome = trimToken(env.XDG_CONFIG_HOME);
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, "gh");
  }

  if (process.platform === "win32") {
    const appData = trimToken(env.APPDATA) ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "GitHub CLI");
  }

  return path.join(home, ".config", "gh");
}

async function readGhHostsToken(
  env: NodeJS.ProcessEnv,
  home: string
): Promise<string | undefined> {
  const hostsPath = path.join(resolveGhConfigDir(env, home), "hosts.yml");

  let contents: string;
  try {
    contents = await readFile(hostsPath, "utf8");
  } catch {
    return undefined;
  }

  return parseGhHostsToken(contents);
}

/**
 * Minimal hosts.yml parse: find the `github.com:` block and read an
 * `oauth_token:` (or `token:`) entry nested under it. If the host block exists
 * but stores no plain token (keyring storage), treat as not found.
 */
function parseGhHostsToken(contents: string): string | undefined {
  const lines = contents.split(/\r?\n/);
  let inGithubBlock = false;
  let blockIndent = -1;

  for (const line of lines) {
    if (line.trim().length === 0 || line.trim().startsWith("#")) {
      continue;
    }

    const indent = line.length - line.trimStart().length;

    if (!inGithubBlock) {
      if (/^\s*github\.com\s*:\s*$/.test(line)) {
        inGithubBlock = true;
        blockIndent = indent;
      }
      continue;
    }

    // A line at or below the block's own indent ends the github.com block.
    if (indent <= blockIndent) {
      break;
    }

    const match = line.match(/^\s*(oauth_token|token)\s*:\s*(.+?)\s*$/);
    if (match) {
      const token = stripYamlScalar(match[2]);
      if (token) {
        return token;
      }
    }
  }

  return undefined;
}

function stripYamlScalar(raw: string): string | undefined {
  let value = raw.trim();
  if (value.length === 0) {
    return undefined;
  }
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  value = value.trim();
  return value.length > 0 ? value : undefined;
}

async function readKeychainToken(): Promise<string | undefined> {
  try {
    return await new Promise<string | undefined>((resolve) => {
      const child = execFile(
        "security",
        ["find-generic-password", "-s", "gh:github.com", "-w"],
        { timeout: KEYCHAIN_TIMEOUT_MS },
        (error, stdout) => {
          if (error) {
            resolve(undefined);
            return;
          }
          resolve(trimToken(stdout));
        }
      );
      child.on("error", () => resolve(undefined));
    });
  } catch {
    return undefined;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP transport
//
// Mirror the header set the working client sends to the unstable
// /copilot_internal/user endpoint. Concrete versions (not "0.x" placeholders)
// are required: the endpoint rejects/ignores requests with implausible versions.
// Failures return `{ ok: false, warning }` with an actionable message that
// contains NEITHER the token NOR the response body.
// ────────────────────────────────────────────────────────────────────────────

const COPILOT_USER_HOSTNAME = "api.github.com";
const COPILOT_USER_PATH = "/copilot_internal/user";
const DEFAULT_TIMEOUT_MS = 10_000;

const USER_AGENT = "GitHubCopilotChat/0.26.7";
const EDITOR_VERSION = "vscode/1.96.2";
const EDITOR_PLUGIN_VERSION = "copilot-chat/0.26.7";
const GITHUB_API_VERSION = "2025-04-01";

export type GetCopilotUserOptions = { timeoutMs?: number };

export async function getCopilotUser(
  token: string,
  options?: GetCopilotUserOptions
): Promise<CopilotUserApiResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  return new Promise<CopilotUserApiResult>((resolve) => {
    let settled = false;
    const finish = (result: CopilotUserApiResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const request = https.request(
      {
        hostname: COPILOT_USER_HOSTNAME,
        path: COPILOT_USER_PATH,
        method: "GET",
        signal: ac.signal,
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "Editor-Version": EDITOR_VERSION,
          "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
          "X-GitHub-Api-Version": GITHUB_API_VERSION
        }
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const rateLimitRemaining = response.headers["x-ratelimit-remaining"];
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          if (status === 200) {
            const bodyText = Buffer.concat(chunks).toString("utf8");
            try {
              const data: unknown = JSON.parse(bodyText);
              finish({ ok: true, data });
            } catch {
              finish({ ok: false, warning: "Copilot quota API returned invalid JSON." });
            }
            return;
          }

          if (status === 401) {
            finish({
              ok: false,
              warning: "Copilot quota API returned 401; run `gh auth login` again."
            });
            return;
          }

          if (status === 403) {
            finish({
              ok: false,
              warning: "Copilot quota API returned 403; the token may lack Copilot access."
            });
            return;
          }

          if (status === 404) {
            finish({
              ok: false,
              warning: "Copilot quota API returned 404; the Copilot user endpoint is unavailable."
            });
            return;
          }

          if (status === 429 || isRateLimitExhausted(rateLimitRemaining)) {
            finish({
              ok: false,
              warning: "Copilot quota API is rate limited; try again later."
            });
            return;
          }

          if (status >= 500) {
            finish({ ok: false, warning: `Copilot quota API returned ${status}.` });
            return;
          }

          finish({ ok: false, warning: "Copilot quota API request failed." });
        });
      }
    );

    request.on("error", (error: NodeJS.ErrnoException) => {
      if (ac.signal.aborted || error.name === "AbortError") {
        finish({ ok: false, warning: "Copilot quota API request timed out." });
        return;
      }
      finish({ ok: false, warning: "Copilot quota API request failed." });
    });

    request.end();
  });
}

function isRateLimitExhausted(remaining: string | string[] | undefined): boolean {
  const value = Array.isArray(remaining) ? remaining[0] : remaining;
  if (value === undefined) {
    return false;
  }
  return Number(value) === 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Quota parsing
//
// The endpoint returns one of two shapes: a paid `quota_snapshots` form or a
// free `monthly_quotas`/`limited_user_quotas` form.
// ────────────────────────────────────────────────────────────────────────────

type RawPaidSnapshot = {
  percent_remaining?: unknown;
  remaining?: unknown;
  entitlement?: unknown;
  quota_id?: unknown;
};

const KNOWN_LABELS: Record<string, string> = {
  premium_interactions: "Premium",
  chat: "Chat",
  completions: "Completions"
};

/**
 * Parse the raw Copilot user/quota JSON into {@link CopilotQuotaInfo}. Tolerates
 * both response shapes, never throws on missing/malformed fields, clamps every
 * percentage to 0..100, rejects NaN/Infinity/negatives, and keeps unknown quota
 * keys with a readable fallback label.
 */
export function parseCopilotQuota(raw: unknown): CopilotQuotaInfo {
  const root = asRecord(raw);
  if (!root) {
    return { quotas: [] };
  }

  const plan = asString(root.copilot_plan);
  const snapshots = asRecord(root.quota_snapshots);

  // Prefer the paid `quota_snapshots` form, but fall back to the free form when
  // the snapshot object is present yet yields no usable quotas (e.g. an empty
  // `quota_snapshots: {}`). Selecting paid purely on presence would silently
  // drop a free account's quotas.
  const paid = snapshots !== null ? parsePaidQuotas(snapshots) : [];
  const usePaid = paid.length > 0;
  const quotas = usePaid ? paid : parseFreeQuotas(root);

  const resetAt = usePaid
    ? asString(root.quota_reset_date)
    : asString(root.limited_user_reset_date);

  const info: CopilotQuotaInfo = {
    quotas: quotas.sort((left, right) => left.id.localeCompare(right.id))
  };
  if (plan !== undefined) {
    info.plan = plan;
  }
  if (resetAt !== undefined) {
    info.resetAt = resetAt;
  }
  return info;
}

function parsePaidQuotas(snapshots: Record<string, unknown>): CopilotQuota[] {
  const quotas: CopilotQuota[] = [];

  for (const [key, value] of Object.entries(snapshots)) {
    const snapshot = asRecord(value) as RawPaidSnapshot | null;
    if (!snapshot) {
      quotas.push(makeQuota(idForSnapshot(key, undefined), key));
      continue;
    }

    const id = idForSnapshot(key, asString(snapshot.quota_id));
    const quota = makeQuota(id, key);

    const total = finiteNonNegative(snapshot.entitlement);
    if (total !== undefined) {
      quota.total = total;
    }

    const percentRemaining = finiteNonNegative(snapshot.percent_remaining);
    const rawRemaining = finiteNonNegative(snapshot.remaining);

    if (percentRemaining !== undefined) {
      const remainingPercent = clampPercent(percentRemaining);
      quota.remainingPercent = remainingPercent;
      quota.usedPercent = clampPercent(100 - remainingPercent);
    } else if (rawRemaining !== undefined && total !== undefined && total > 0) {
      const remainingPercent = clampPercent((rawRemaining / total) * 100);
      quota.remainingPercent = remainingPercent;
      quota.usedPercent = clampPercent(100 - remainingPercent);
    }

    if (rawRemaining !== undefined) {
      const remaining = total !== undefined ? Math.min(rawRemaining, total) : rawRemaining;
      quota.remaining = remaining;
      if (total !== undefined) {
        quota.used = Math.max(0, total - remaining);
      }
    }

    quotas.push(quota);
  }

  return quotas;
}

function parseFreeQuotas(root: Record<string, unknown>): CopilotQuota[] {
  const monthly = asRecord(root.monthly_quotas) ?? {};
  const limited = asRecord(root.limited_user_quotas) ?? {};

  const keys = new Set<string>([...Object.keys(monthly), ...Object.keys(limited)]);
  const quotas: CopilotQuota[] = [];

  for (const key of keys) {
    const quota = makeQuota(key, key);

    const total = finiteNonNegative(monthly[key]);
    const rawRemaining = finiteNonNegative(limited[key]);

    if (total !== undefined) {
      quota.total = total;
    }

    if (rawRemaining !== undefined) {
      const remaining = total !== undefined ? Math.min(rawRemaining, total) : rawRemaining;
      quota.remaining = remaining;

      if (total !== undefined) {
        const used = Math.max(0, total - remaining);
        quota.used = used;
        if (total > 0) {
          const usedPercent = clampPercent((used / total) * 100);
          quota.usedPercent = usedPercent;
          quota.remainingPercent = clampPercent(100 - usedPercent);
        }
      }
    }

    quotas.push(quota);
  }

  return quotas;
}

function makeQuota(id: string, key: string): CopilotQuota {
  return { id, label: labelForKey(key) };
}

function idForSnapshot(key: string, quotaId: string | undefined): string {
  return quotaId !== undefined && quotaId.length > 0 ? quotaId : key;
}

function labelForKey(key: string): string {
  const known = KNOWN_LABELS[key];
  if (known !== undefined) {
    return known;
  }
  return titleCase(key);
}

function titleCase(key: string): string {
  const words = key.replace(/_/g, " ").trim().split(/\s+/);
  if (words.length === 0 || words[0] === "") {
    return key;
  }
  return words
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Coerce number-or-numeric-string into a finite non-negative number, else undefined. */
function finiteNonNegative(value: unknown): number | undefined {
  let n: number | undefined;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    n = Number(value);
  }
  if (n === undefined || !Number.isFinite(n) || n < 0) {
    return undefined;
  }
  return n;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}
