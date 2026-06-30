import https from "node:https";

import type { CopilotUserApiResult } from "../types.js";

// All endpoint / header constants live ONLY in this module.
const COPILOT_USER_HOSTNAME = "api.github.com";
const COPILOT_USER_PATH = "/copilot_internal/user";
const DEFAULT_TIMEOUT_MS = 10_000;

// Mirror the header set the working Tokscale client sends to the unstable
// /copilot_internal/user endpoint. Concrete versions (not "0.x" placeholders)
// are required: the endpoint rejects/ignores some requests with implausible
// editor/plugin versions.
const USER_AGENT = "GitHubCopilotChat/0.26.7";
const EDITOR_VERSION = "vscode/1.96.2";
const EDITOR_PLUGIN_VERSION = "copilot-chat/0.26.7";
const GITHUB_API_VERSION = "2025-04-01";

export type GetCopilotUserOptions = { timeoutMs?: number };

/**
 * Fetches the raw Copilot internal user payload. This module is transport-only:
 * it never parses the quota domain model, builds limit windows, reads OTEL, or
 * resolves credentials. Failures return `{ ok: false, warning }` with an
 * actionable message that contains NEITHER the token NOR the response body.
 */
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
              finish({
                ok: false,
                warning: "Copilot quota API returned invalid JSON."
              });
            }
            return;
          }

          if (status === 401) {
            finish({
              ok: false,
              warning:
                "Copilot quota API returned 401; run `gh auth login` again."
            });
            return;
          }

          if (status === 403) {
            finish({
              ok: false,
              warning:
                "Copilot quota API returned 403; the token may lack Copilot access."
            });
            return;
          }

          if (status === 404) {
            finish({
              ok: false,
              warning:
                "Copilot quota API returned 404; the Copilot user endpoint is unavailable."
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
            finish({
              ok: false,
              warning: `Copilot quota API returned ${status}.`
            });
            return;
          }

          finish({
            ok: false,
            warning: "Copilot quota API request failed."
          });
        });
      }
    );

    request.on("error", (error: NodeJS.ErrnoException) => {
      if (ac.signal.aborted || error.name === "AbortError") {
        finish({
          ok: false,
          warning: "Copilot quota API request timed out."
        });
        return;
      }
      finish({
        ok: false,
        warning: "Copilot quota API request failed."
      });
    });

    request.end();
  });
}

function isRateLimitExhausted(
  remaining: string | string[] | undefined
): boolean {
  const value = Array.isArray(remaining) ? remaining[0] : remaining;
  if (value === undefined) {
    return false;
  }
  return Number(value) === 0;
}
