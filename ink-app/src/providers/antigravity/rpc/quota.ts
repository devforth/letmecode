import {
  ANTIGRAVITY_RPC_PATHS,
  rpc,
  type AntigravityLocalServer,
  type AntigravityRpcMetadata
} from "./client.js";

const METADATA: AntigravityRpcMetadata = {
  ideName: "antigravity",
  extensionName: "antigravity",
  ideVersion: "unknown",
  locale: "en"
};

export type AntigravityQuotaBucket = {
  bucketId: string;
  window: string;
  remainingFraction: number;
  resetTime: string;
};

export type AntigravityQuotaGroup = {
  displayName: string;
  description?: string;
  buckets: AntigravityQuotaBucket[];
};

export type AntigravityQuotaData = {
  email: string | null;
  planName: string | null;
  groups: AntigravityQuotaGroup[];
};

type QuotaResponse = {
  response?: {
    groups?: Array<
      Partial<Omit<AntigravityQuotaGroup, "buckets">> & {
        buckets?: Partial<AntigravityQuotaBucket>[];
      }
    >;
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

export async function fetchAntigravityQuotaRpcData(
  server: AntigravityLocalServer
): Promise<AntigravityQuotaData> {
  const [quota, status] = await Promise.all([
    rpc<QuotaResponse>(
      server,
      ANTIGRAVITY_RPC_PATHS.quotaSummary
    ),
    rpc<
      StatusResponse,
      { metadata: AntigravityRpcMetadata }
    >(
      server,
      ANTIGRAVITY_RPC_PATHS.userStatus,
      { metadata: METADATA }
    ).catch(() => null)
  ]);

  const groups = (quota.response?.groups ?? []).flatMap((group) => {
    if (!group.displayName) {
      return [];
    }

    const buckets = (group.buckets ?? []).flatMap((bucket) => {
      if (
        !bucket.bucketId ||
        !bucket.window ||
        !bucket.resetTime ||
        typeof bucket.remainingFraction !== "number" ||
        !Number.isFinite(bucket.remainingFraction)
      ) {
        return [];
      }

      return [{
        bucketId: bucket.bucketId,
        window: bucket.window,
        remainingFraction: bucket.remainingFraction,
        resetTime: bucket.resetTime
      }];
    });

    if (!buckets.length) {
      return [];
    }

    return [{
      displayName: group.displayName,
      ...(group.description === undefined
        ? {}
        : { description: group.description }),
      buckets
    }];
  });

  return {
    email: status?.userStatus?.email ?? null,
    planName:
      status?.userStatus?.planStatus?.planInfo?.planName ?? null,
    groups
  };
}