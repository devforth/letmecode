export type UsageTokenSchema = "openai" | "anthropic";

export type OpenAiTokenBreakdown = {
  schema: "openai";
  /**
   * Important: for the OpenAI-style contract we assume `nonCachedInputTokens`
   * is already the uncached input token count.
   */
  nonCachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type AnthropicTokenBreakdown = {
  schema: "anthropic";
  /**
   * Important: this maps 1:1 to Claude API `input_tokens` and therefore always
   * covers only pure input tokens that were neither cache reads nor cache writes.
   */
  inputTokens: number;
  /**
   * Important: a single token must be counted in only one cache-write bucket,
   * never both `cacheWrite5mInputTokens` and `cacheWrite1hInputTokens`.
   */
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
};

export type UsageTokenBreakdown = OpenAiTokenBreakdown | AnthropicTokenBreakdown;

export type UsageTotals = {
  inputTotalTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedCredits: number;
  eventCount: number;
  tokenBreakdown: UsageTokenBreakdown;
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

export function createEmptyUsageTotals(schema: UsageTokenSchema = "openai"): UsageTotals {
  return {
    inputTotalTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCredits: 0,
    eventCount: 0,
    tokenBreakdown: createEmptyUsageTokenBreakdown(schema)
  };
}

export function cloneUsageTotals(totals: UsageTotals): UsageTotals {
  return {
    ...totals,
    tokenBreakdown: { ...totals.tokenBreakdown }
  };
}

export function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
  target.inputTotalTokens += source.inputTotalTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
  target.estimatedCredits += source.estimatedCredits;
  target.eventCount += source.eventCount;
  addUsageTokenBreakdown(target.tokenBreakdown, source.tokenBreakdown);
  if (source.cacheStatus === "unavailable") {
    target.cacheStatus = "unavailable";
  }
  if (source.estimatedCreditsStatus === "unavailable") {
    target.estimatedCreditsStatus = "unavailable";
  }
}

export function sumUsageTotals(rows: UsageTotals[]): UsageTotals {
  const totals = createEmptyUsageTotals(rows[0]?.tokenBreakdown.schema ?? "openai");
  for (const row of rows) {
    addUsageTotals(totals, row);
  }

  return totals;
}

function createEmptyUsageTokenBreakdown(schema: UsageTokenSchema): UsageTokenBreakdown {
  if (schema === "anthropic") {
    return {
      schema,
      inputTokens: 0,
      cacheWrite5mInputTokens: 0,
      cacheWrite1hInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0
    };
  }

  return {
    schema,
    nonCachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0
  };
}

function addUsageTokenBreakdown(target: UsageTokenBreakdown, source: UsageTokenBreakdown): void {
  if (target.schema !== source.schema) {
    throw new Error(`Cannot merge ${source.schema} usage totals into ${target.schema} totals.`);
  }

  target.outputTokens += source.outputTokens;

  if (target.schema === "anthropic" && source.schema === "anthropic") {
    target.inputTokens += source.inputTokens;
    target.cacheWrite5mInputTokens += source.cacheWrite5mInputTokens;
    target.cacheWrite1hInputTokens += source.cacheWrite1hInputTokens;
    target.cacheReadInputTokens += source.cacheReadInputTokens;
    return;
  }

  if (target.schema === "openai" && source.schema === "openai") {
    target.nonCachedInputTokens += source.nonCachedInputTokens;
    target.cachedInputTokens += source.cachedInputTokens;
  }
}
