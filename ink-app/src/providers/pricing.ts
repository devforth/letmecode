export type UsageRate = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  longContext?: {
    thresholdTokens: number;
    rate: UsageRateValue;
  };
};

export type UsageRateValue = Omit<UsageRate, "longContext">;

export function resolveUsageRate(
  rateCard: Record<string, UsageRate>,
  modelId: string,
  inputTokens = 0,
  options: { prefixMatch?: boolean } = {}
): UsageRateValue | undefined {
  const model = options.prefixMatch
    ? Object.keys(rateCard)
        .sort((left, right) => right.length - left.length)
        .find((candidate) => modelId === candidate || modelId.startsWith(`${candidate}-`))
    : modelId;

  if (!model) {
    return undefined;
  }

  const rate = rateCard[model];
  if (!rate) {
    return undefined;
  }

  if (rate.longContext && inputTokens > rate.longContext.thresholdTokens) {
    return rate.longContext.rate;
  }

  return rate;
}
