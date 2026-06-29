import type { LimitWindowScope } from "../contract.js";
import type {
  AntigravityModelScope,
  AntigravityQuotaEntry,
  AntigravityQuotaGroup
} from "./types.js";

const QUOTA_WINDOWS: Record<
  string,
  {
    scope: LimitWindowScope;
    windowMinutes: number;
  }
> = {
  "5h": {
    scope: "primary",
    windowMinutes: 300
  },
  weekly: {
    scope: "secondary",
    windowMinutes: 10_080
  }
};

export function parseAntigravityQuotaEntries(
  groups: AntigravityQuotaGroup[]
): AntigravityQuotaEntry[] {
  return groups.flatMap((group) => {
    const modelScope = resolveQuotaGroupScope(
      `${group.displayName ?? ""} ${group.description ?? ""}`
    );

    if (!modelScope) {
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
        modelScope,
        remainingFraction: bucket.remainingFraction,
        resetAt,
        ...window
      }];
    });
  });
}

function resolveQuotaGroupScope(
  text: string
): AntigravityModelScope | null {
  const normalized = text.toLowerCase();

  if (/gemini/.test(normalized)) {
    return "gemini";
  }
  if (/claude|gpt/.test(normalized)) {
    return "third-party";
  }

  return null;
}
