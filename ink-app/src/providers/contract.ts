export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedCredits: number;
  eventCount: number;
  cacheStatus?: "known" | "unavailable";
  estimatedCreditsStatus?: "known" | "unavailable";
};

export type ModelUsageRow = {
  modelId: string;
  totals: UsageTotals;
};

export type DailyUsageRow = {
  dayKey: string;
  firstEventUtcIso: string | null;
  lastEventUtcIso: string | null;
  distinctModels: string[];
  distinctPlanTypes: string[];
  totals: UsageTotals;
};

export type LimitWindowScope = "primary" | "secondary";

export type LimitWindowRow = {
  scope: LimitWindowScope;
  planType: string;
  limitId: string;
  modelType?: string;
  windowMinutes: number;
  startTimeUtcIso: string;
  endTimeUtcIso: string;
  firstSeenUtcIso: string;
  lastSeenUtcIso: string;
  minUsedPercent: number;
  maxUsedPercent: number;
  totals: UsageTotals;
  modelUsage: ModelUsageRow[];
  eventCount: number;
};

export type ProviderSummary = {
  filesScanned: number;
  linesRead: number;
  tokenEvents: number;
  totals: UsageTotals;
  distinctModels: string[];
  distinctPlanTypes: string[];
  rootLabel: string;
  rootPath: string;
};

export type ProviderAnalytics = {
  agentName: string;
  userIdHash: string | null;
};

export type ProviderTraceLogger = {
  log(message: string): void;
};

export type ProviderStats = {
  providerId: string;
  providerLabel: string;
  summary: ProviderSummary;
  modelUsage: ModelUsageRow[];
  dayUsage: DailyUsageRow[];
  primaryLimitWindows: LimitWindowRow[];
  secondaryLimitWindows: LimitWindowRow[];
  warnings: string[];
  analytics?: ProviderAnalytics;
};

export type ProviderStatsOptions = {
  verbose?: boolean;
  traceLogger?: ProviderTraceLogger;
};

export abstract class UsageProviderBase {
  public readonly id: string;
  public readonly label: string;

  protected constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }

  abstract getStats(options?: ProviderStatsOptions): Promise<ProviderStats>;
}

export function createEmptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCredits: 0,
    eventCount: 0
  };
}

export function cloneUsageTotals(totals: UsageTotals): UsageTotals {
  return { ...totals };
}

export function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.cacheWriteInputTokens += source.cacheWriteInputTokens;
  target.cacheWrite5mInputTokens += source.cacheWrite5mInputTokens;
  target.cacheWrite1hInputTokens += source.cacheWrite1hInputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
  target.estimatedCredits += source.estimatedCredits;
  target.eventCount += source.eventCount;
  if (source.cacheStatus === "unavailable") {
    target.cacheStatus = "unavailable";
  }
  if (source.estimatedCreditsStatus === "unavailable") {
    target.estimatedCreditsStatus = "unavailable";
  }
}

export function sumUsageTotals(rows: UsageTotals[]): UsageTotals {
  const totals = createEmptyUsageTotals();
  for (const row of rows) {
    addUsageTotals(totals, row);
  }

  return totals;
}
