import type {
  DailyUsageRow,
  LimitWindowScope,
  ModelUsageRow,
  UsageTotals,
  UsageValueStatus
} from "../contract.js";

// ────────────────────────────────────────────────────────────────────────────
// GitHub credentials (api/credentials.ts)
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

/**
 * Result of credential discovery. A missing token is NOT an error — it is a
 * controlled `credentials: null`, which user-info.ts turns into a warning.
 * The token is never echoed into `warnings`.
 */
export type GitHubCredentialResult = {
  credentials: GitHubCredentials | null;
  warnings: string[];
};

// ────────────────────────────────────────────────────────────────────────────
// Copilot quota / user info (api/quota-parser.ts, api/user-info.ts)
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
  credentialSource?: GitHubCredentialSource;
};

/**
 * Transport-level result from the Copilot internal HTTP endpoint. `data` is the
 * raw decoded JSON (unknown — quota-parser.ts is the validation authority). A
 * failure carries an actionable warning that NEVER contains the token or the
 * raw response body.
 */
export type CopilotUserApiResult =
  | { ok: true; data: unknown }
  | { ok: false; warning: string };

// ────────────────────────────────────────────────────────────────────────────
// OTEL discovery (otel/discover.ts) + raw parsing (otel/parse.ts)
// ────────────────────────────────────────────────────────────────────────────

export type CopilotOtelFileSource =
  | "vscode"
  | "vscode-insiders"
  | "copilot-cli"
  | "environment"
  | "explicit"
  | "unknown";

export type CopilotOtelFile = {
  path: string;
  source: CopilotOtelFileSource;
  modifiedAtMs: number;
  sizeBytes: number;
};

export type CopilotOtelDiscoveryResult = {
  files: CopilotOtelFile[];
  warnings: string[];
};

export type CopilotRawOtelRecord = {
  payload: unknown;
  filePath: string;
  fileSource: CopilotOtelFileSource;
  lineNumber: number;
  fileModifiedAtMs: number;
};

export type CopilotOtelParseResult = {
  records: CopilotRawOtelRecord[];
  filesScanned: number;
  linesRead: number;
  malformedLines: number;
  warnings: string[];
};

// ────────────────────────────────────────────────────────────────────────────
// Normalized usage event (otel/normalize.ts)
// ────────────────────────────────────────────────────────────────────────────

export type CopilotUsageEventSource =
  | "chat-span"
  | "inference-log"
  | "agent-turn-log"
  | "agent-summary-span";

/**
 * A single normalized Copilot usage event. `inputTokens` is the RAW reported
 * input as emitted by the Copilot OTEL exporter — it already INCLUDES
 * cache-read tokens but NOT cache-write/creation tokens. usage/aggregate.ts is
 * responsible for deriving uncached input (`max(0, inputTokens - cacheRead)`).
 */
export type CopilotUsageEvent = {
  timestampMs: number;
  modelId: string;

  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningOutputTokens: number;

  cacheReadStatus: UsageValueStatus;
  cacheWriteStatus: UsageValueStatus;

  traceId?: string;
  spanId?: string;
  responseId?: string;
  conversationId?: string;
  sessionId?: string;
  agentId?: string;
  turnIndex?: number;
  durationMs?: number;

  sourceType: CopilotUsageEventSource;

  filePath: string;
  lineNumber: number;
};

export type CopilotNormalizeResult = {
  events: CopilotUsageEvent[];
  warnings: string[];
};

// ────────────────────────────────────────────────────────────────────────────
// Deduplication (otel/deduplicate.ts)
// ────────────────────────────────────────────────────────────────────────────

export type CopilotDeduplicationResult = {
  events: CopilotUsageEvent[];
  duplicatesRemoved: number;
  warnings: string[];
};

// ────────────────────────────────────────────────────────────────────────────
// Aggregation (usage/aggregate.ts)
// ────────────────────────────────────────────────────────────────────────────

export type CopilotAggregatedUsage = {
  modelUsage: ModelUsageRow[];
  dayUsage: DailyUsageRow[];
  summaryTotals: UsageTotals;
  distinctModels: string[];
  tokenEvents: number;
  warnings: string[];
};

// ────────────────────────────────────────────────────────────────────────────
// Public options / results (otel/configure.ts, provider.ts)
// ────────────────────────────────────────────────────────────────────────────

export type CopilotVsCodeLoggingOptions = {
  root?: string;
  settingsPath?: string;
};

export type CopilotVsCodeLoggingResult = {
  settingsPath: string;
  outfile: string;
  changed: boolean;
};

export type CopilotLimitWindowScope = LimitWindowScope;

/**
 * Quota buckets that map to the primary (most prominent) limit windows in the
 * dashboard. Everything else is surfaced as a secondary window.
 */
export const COPILOT_PRIMARY_QUOTA_IDS: ReadonlySet<string> = new Set([
  "premium_interactions",
  "chat",
  "completions"
]);
