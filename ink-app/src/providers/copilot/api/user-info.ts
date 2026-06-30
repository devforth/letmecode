import type { CopilotUserInfoResult } from "../types.js";
import {
  resolveGitHubCredentials,
  type ResolveGitHubCredentialsOptions
} from "./credentials.js";
import { getCopilotUser } from "./client.js";
import { parseCopilotQuota } from "./quota-parser.js";

export type GetCopilotUserInfoOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  resolveCredentials?: typeof resolveGitHubCredentials;
  fetchUser?: typeof getCopilotUser;
};

/**
 * Resolves the GitHub credentials and fetches the Copilot quota/plan, returning
 * a domain-level {@link CopilotUserInfoResult}. The GitHub token is never echoed
 * into the result, warnings, or errors. Credential resolution and the HTTP fetch
 * are injectable so tests can run fully offline.
 */
export async function getCopilotUserInfo(
  options?: GetCopilotUserInfoOptions
): Promise<CopilotUserInfoResult> {
  const resolveCredentials = options?.resolveCredentials ?? resolveGitHubCredentials;
  const fetchUser = options?.fetchUser ?? getCopilotUser;

  const credentialOptions: ResolveGitHubCredentialsOptions = {
    env: options?.env,
    home: options?.home
  };
  const credentialResult = await resolveCredentials(credentialOptions);
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
