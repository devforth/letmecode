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

export type LimitWindowScope = "primary" | "secondary";

export type LimitWindowRow = {
  scope: LimitWindowScope;
  planType: string;
  limitId: string;
  windowMinutes: number;
  startTimeIso: string;
  endTimeIso: string;
  firstSeenIso: string;
  lastSeenIso: string;
  minUsedPercent: number;
  maxUsedPercent: number;
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
  primaryLimitWindows: LimitWindowRow[];
  secondaryLimitWindows: LimitWindowRow[];
  warnings: string[];
};

export abstract class UsageProviderBase {
  public readonly id: string;
  public readonly label: string;

  protected constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }

  abstract getStats(): Promise<ProviderStats>;
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
