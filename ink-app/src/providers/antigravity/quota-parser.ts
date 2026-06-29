import type { LimitWindowScope } from "../contract.js";
import type { AntigravityQuotaEntry } from "./provider.js";

const QUOTA_WINDOWS = {
  "5h": {
    scope: "primary",
    windowMinutes: 300
  },
  weekly: {
    scope: "secondary",
    windowMinutes: 10_080
  }
} satisfies Record<
  string,
  {
    scope: LimitWindowScope;
    windowMinutes: number;
  }
>;

const QUOTA_MODEL_GROUPS = [
  {
    pattern: /gemini/,
    models: [
      "gemini-3.5-flash",
      "gemini-3.1-pro",
      "gemini-3-flash"
    ]
  },
  {
    pattern: /claude|gpt/,
    models: [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gpt-oss-120b"
    ]
  }
];

type QuotaBucket = {
  bucketId?: string;
  window?: keyof typeof QUOTA_WINDOWS;
  remainingFraction?: number;
  resetTime?: string;
};

type QuotaGroup = {
  displayName?: string;
  description?: string;
  buckets?: QuotaBucket[];
};

type QuotaPayload = {
  response?: {
    groups?: QuotaGroup[];
  };
};

export function parseAntigravityQuotaEntries(
  payload: unknown
): AntigravityQuotaEntry[] {
  const groups = (payload as QuotaPayload).response?.groups ?? [];

  return groups.flatMap((group) => {
    const modelIds = resolveQuotaGroupModelIds(
      `${group.displayName ?? ""} ${group.description ?? ""}`
    );

    if (!modelIds.length) {
      return [];
    }

    return (group.buckets ?? []).flatMap((bucket) => {
      const window = bucket.window
        ? QUOTA_WINDOWS[bucket.window]
        : undefined;
      const resetAt = Date.parse(bucket.resetTime ?? "");

      if (
        !bucket.bucketId ||
        window === undefined ||
        !Number.isFinite(resetAt) ||
        typeof bucket.remainingFraction !== "number" ||
        bucket.remainingFraction < 0 ||
        bucket.remainingFraction > 1
      ) {
        return [];
      }

      return [{
        limitId: bucket.bucketId,
        modelIds,
        remainingFraction: bucket.remainingFraction,
        resetAt,
        ...window
      }];
    });
  });
}

function resolveQuotaGroupModelIds(text: string): string[] {
  return (
    QUOTA_MODEL_GROUPS.find(({ pattern }) =>
      pattern.test(text.toLowerCase())
    )?.models ?? []
  );
}
