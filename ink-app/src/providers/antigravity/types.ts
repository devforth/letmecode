import type { LimitWindowScope } from "../contract.js";

export type AntigravityModelScope = "gemini" | "third-party";

export type AntigravityUsageRecord = {
  type: "usage";
  sessionId: string;
  responseId: string;
  timestamp: number;
  modelId: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};

export type AntigravityQuotaEntry = {
  limitId: string;
  modelScope: AntigravityModelScope;
  remainingFraction: number;
  resetAt: number;
  windowMinutes: number;
  scope: LimitWindowScope;
};

export type AntigravityQuotaSnapshot = {
  entries: AntigravityQuotaEntry[];
  fetchedAt: number;
  planType: string;
  userIdHash: string | null;
};

/**
 * Raw quota-summary shapes returned by RetrieveUserQuotaSummary. These are
 * intentionally permissive — parseAntigravityQuotaEntries() is the single
 * validation authority that turns them into AntigravityQuotaEntry values.
 */
export type AntigravityQuotaBucket = {
  bucketId?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
};

export type AntigravityQuotaGroup = {
  displayName?: string;
  description?: string;
  buckets?: AntigravityQuotaBucket[];
};
