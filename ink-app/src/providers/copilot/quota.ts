import { execFile } from "node:child_process";

import { asRecord } from "../limits.js";

// ────────────────────────────────────────────────────────────────────────────
// Domain model
//
// One GitHub GET (`/copilot_internal/user`) feeds the Copilot plan/quota limit
// windows. Token resolution, the HTTP fetch, and quota parsing live together
// because they form one small responsibility.
// ────────────────────────────────────────────────────────────────────────────

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
};

/** Transport result. `data` is raw decoded JSON; parsing happens separately. */
type CopilotUserApiResult =
  | { ok: true; data: unknown }
  | { ok: false; warning: string };

export type GetCopilotUserInfoOptions = {
  env?: NodeJS.ProcessEnv;
  resolveToken?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  fetchUser?: (token: string) => Promise<CopilotUserApiResult>;
};

/**
 * Resolve a GitHub token and fetch the Copilot quota/plan. The token is never
 * echoed into the result or warnings. Token resolution and the HTTP fetch are
 * injectable so tests run fully offline. A missing token is not an error — it
 * yields a warning and no quota, leaving local OTEL usage unaffected.
 */
export async function getCopilotUserInfo(
  options?: GetCopilotUserInfoOptions
): Promise<CopilotUserInfoResult> {
  const env = options?.env ?? process.env;
  const resolveToken = options?.resolveToken ?? resolveGitHubToken;
  const fetchUser = options?.fetchUser ?? getCopilotUser;

  const token = await resolveToken(env);
  if (!token) {
    return {
      warnings: [
        "Copilot plan and quota are unavailable: no GitHub token found. " +
          "Set GH_TOKEN or GITHUB_TOKEN, or install GitHub CLI and run `gh auth login`."
      ]
    };
  }

  const result = await fetchUser(token);
  if (!result.ok) {
    return { warnings: [result.warning] };
  }
  return { quotaInfo: parseCopilotQuota(result.data), warnings: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// Token resolution: GH_TOKEN → GITHUB_TOKEN → `gh auth token`
// ────────────────────────────────────────────────────────────────────────────

const GH_TIMEOUT_MS = 2_000;

async function resolveGitHubToken(env: NodeJS.ProcessEnv): Promise<string | null> {
  const fromEnv = nonEmpty(env.GH_TOKEN) ?? nonEmpty(env.GITHUB_TOKEN);
  if (fromEnv) {
    return fromEnv;
  }
  return ghAuthToken();
}

function ghAuthToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: GH_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : nonEmpty(stdout));
    });
  });
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP transport (Node built-in fetch)
// ────────────────────────────────────────────────────────────────────────────

const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
const REQUEST_TIMEOUT_MS = 10_000;

// Header values mirror a real Copilot Chat client; the endpoint ignores requests
// with implausible editor/plugin versions.
const HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "Editor-Version": "vscode/1.96.2",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "X-GitHub-Api-Version": "2025-04-01"
};

async function getCopilotUser(token: string): Promise<CopilotUserApiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(COPILOT_USER_URL, {
      headers: { ...HEADERS, Authorization: `token ${token}` },
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, warning: warningForStatus(response.status) };
    }
    try {
      return { ok: true, data: await response.json() };
    } catch {
      return { ok: false, warning: "Copilot quota API returned invalid JSON." };
    }
  } catch {
    // Aborts (timeout) and network failures land here; the response body, if any,
    // is never read or logged.
    return { ok: false, warning: "Copilot quota API request failed." };
  } finally {
    clearTimeout(timer);
  }
}

function warningForStatus(status: number): string {
  switch (status) {
    case 401:
      return "Copilot quota API returned 401; run `gh auth login` again.";
    case 403:
      return "Copilot quota API returned 403; the token may lack Copilot access.";
    case 404:
      return "Copilot quota API returned 404; the Copilot user endpoint is unavailable.";
    case 429:
      return "Copilot quota API is rate limited; try again later.";
    default:
      return `Copilot quota API returned ${status}.`;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Quota parsing (two known response shapes)
// ────────────────────────────────────────────────────────────────────────────

const KNOWN_LABELS: Record<string, string> = {
  premium_interactions: "Premium",
  chat: "Chat",
  completions: "Completions"
};

/**
 * Parse the raw `/copilot_internal/user` JSON into {@link CopilotQuotaInfo}.
 * Tolerates both the paid (`quota_snapshots`) and free
 * (`monthly_quotas`/`limited_user_quotas`) shapes, never throws, derives
 * percentages only from valid data, clamps them to 0..100, and leaves an
 * unknown percentage undefined (never a false 0%). If the paid form yields no
 * usable buckets, the free form is used as a fallback.
 */
export function parseCopilotQuota(raw: unknown): CopilotQuotaInfo {
  const root = asRecord(raw);
  if (!root) {
    return { quotas: [] };
  }

  const snapshots = asRecord(root.quota_snapshots);
  const paid = snapshots ? parsePaidQuotas(snapshots) : [];
  const usePaid = paid.length > 0;
  const quotas = usePaid ? paid : parseFreeQuotas(root);

  const info: CopilotQuotaInfo = {
    quotas: quotas.sort((a, b) => a.id.localeCompare(b.id))
  };
  const plan = asString(root.copilot_plan);
  if (plan !== undefined) {
    info.plan = plan;
  }
  const resetAt = usePaid
    ? asString(root.quota_reset_date)
    : asString(root.limited_user_reset_date);
  if (resetAt !== undefined) {
    info.resetAt = resetAt;
  }
  return info;
}

function parsePaidQuotas(snapshots: Record<string, unknown>): CopilotQuota[] {
  const quotas: CopilotQuota[] = [];
  for (const [key, value] of Object.entries(snapshots)) {
    const snapshot = asRecord(value);
    const id = (snapshot && asString(snapshot.quota_id)) || key;
    const quota: CopilotQuota = { id, label: labelForKey(key) };
    if (!snapshot) {
      quotas.push(quota);
      continue;
    }

    const total = finiteNonNegative(snapshot.entitlement);
    if (total !== undefined) {
      quota.total = total;
    }

    const percentRemaining = finiteNonNegative(snapshot.percent_remaining);
    const rawRemaining = finiteNonNegative(snapshot.remaining);

    if (percentRemaining !== undefined) {
      quota.remainingPercent = clampPercent(percentRemaining);
      quota.usedPercent = clampPercent(100 - quota.remainingPercent);
    } else if (rawRemaining !== undefined && total !== undefined && total > 0) {
      quota.remainingPercent = clampPercent((rawRemaining / total) * 100);
      quota.usedPercent = clampPercent(100 - quota.remainingPercent);
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
  const keys = new Set([...Object.keys(monthly), ...Object.keys(limited)]);

  const quotas: CopilotQuota[] = [];
  for (const key of keys) {
    const quota: CopilotQuota = { id: key, label: labelForKey(key) };
    const total = finiteNonNegative(monthly[key]);
    const rawRemaining = finiteNonNegative(limited[key]);

    if (total !== undefined) {
      quota.total = total;
    }
    if (rawRemaining !== undefined) {
      const remaining = total !== undefined ? Math.min(rawRemaining, total) : rawRemaining;
      quota.remaining = remaining;
      if (total !== undefined) {
        quota.used = Math.max(0, total - remaining);
        if (total > 0) {
          quota.usedPercent = clampPercent((quota.used / total) * 100);
          quota.remainingPercent = clampPercent(100 - quota.usedPercent);
        }
      }
    }
    quotas.push(quota);
  }
  return quotas;
}

function labelForKey(key: string): string {
  if (KNOWN_LABELS[key] !== undefined) {
    return KNOWN_LABELS[key];
  }
  const words = key.replace(/_/g, " ").trim().split(/\s+/);
  return words
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ") || key;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Coerce a number-or-numeric-string into a finite, non-negative number. */
function finiteNonNegative(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : undefined;
  return n !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}
