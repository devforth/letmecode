import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  GitHubCredentialResult,
  GitHubCredentials
} from "../types.js";

export type ResolveGitHubCredentialsOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
};

const KEYCHAIN_TIMEOUT_MS = 2_000;

/**
 * Resolve a GitHub token without depending on the `gh` CLI at runtime.
 *
 * Resolution order: GH_TOKEN env → GITHUB_TOKEN env → gh CLI hosts.yml →
 * macOS keychain (best-effort). A missing token is NOT an error: it resolves
 * to `{ credentials: null, warnings: [] }`. The token is NEVER placed in any
 * warning.
 */
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
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveGhConfigDir(
  env: NodeJS.ProcessEnv,
  home: string
): string {
  const fromConfigDir = trimToken(env.GH_CONFIG_DIR);
  if (fromConfigDir) {
    return fromConfigDir;
  }

  const xdgConfigHome = trimToken(env.XDG_CONFIG_HOME);
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, "gh");
  }

  if (process.platform === "win32") {
    const appData =
      trimToken(env.APPDATA) ?? path.join(home, "AppData", "Roaming");
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
    const token = await new Promise<string | undefined>((resolve) => {
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
    return token;
  } catch {
    return undefined;
  }
}
