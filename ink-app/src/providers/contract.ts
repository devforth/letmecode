export type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  nonCachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedCredits: number;
  eventCount: number;
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
  windowMinutes: number;
  startTimeUtcIso: string;
  endTimeUtcIso: string;
  firstSeenUtcIso: string;
  lastSeenUtcIso: string;
  minUsedPercent: number;
  maxUsedPercent: number;
  totals: UsageTotals;
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

export type ProviderStats = {
  providerId: string;
  providerLabel: string;
  summary: ProviderSummary;
  modelUsage: ModelUsageRow[];
  dayUsage: DailyUsageRow[];
  primaryLimitWindows: LimitWindowRow[];
  secondaryLimitWindows: LimitWindowRow[];
  warnings: string[];
};

export type ProviderStatsOptions = {
  verbose?: boolean;
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
    cachedInputTokens: 0,
    nonCachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCredits: 0,
    eventCount: 0
  };
}

export function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.nonCachedInputTokens += source.nonCachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
  target.estimatedCredits += source.estimatedCredits;
  target.eventCount += source.eventCount;
}

export function sumUsageTotals(rows: UsageTotals[]): UsageTotals {
  const totals = createEmptyUsageTotals();
  for (const row of rows) {
    addUsageTotals(totals, row);
  }

  return totals;
}
