import {
  ANTIGRAVITY_RPC_PATHS,
  rpc,
  type AntigravityLocalServer,
  type AntigravityRpcMetadata
} from "./client.js";
import type { AntigravityQuotaGroup } from "../types.js";

const METADATA: AntigravityRpcMetadata = {
  ideName: "antigravity",
  extensionName: "antigravity",
  ideVersion: "unknown",
  locale: "en"
};

type QuotaResponse = {
  response?: {
    groups?: AntigravityQuotaGroup[];
  };
};

type StatusResponse = {
  userStatus?: {
    email?: string;
    planStatus?: {
      planInfo?: {
        planName?: string;
      };
    };
  };
};

export type AntigravityUserStatus = {
  email: string | null;
  planName: string | null;
};

/**
 * Pulls the raw quota groups out of a RetrieveUserQuotaSummary payload.
 * Validation and normalization are the parser's responsibility, so this only
 * unwraps the envelope.
 */
export function extractQuotaGroups(payload: unknown): AntigravityQuotaGroup[] {
  return (payload as QuotaResponse).response?.groups ?? [];
}

export async function fetchAntigravityUserStatus(
  server: AntigravityLocalServer
): Promise<AntigravityUserStatus> {
  const status = await rpc<
    StatusResponse,
    { metadata: AntigravityRpcMetadata }
  >(
    server,
    ANTIGRAVITY_RPC_PATHS.userStatus,
    { metadata: METADATA }
  ).catch(() => null);

  return {
    email: status?.userStatus?.email ?? null,
    planName:
      status?.userStatus?.planStatus?.planInfo?.planName ?? null
  };
}
