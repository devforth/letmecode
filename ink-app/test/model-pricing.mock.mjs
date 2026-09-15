import {
  configureModelPricingTransport,
  modelPricingSlug
} from "../dist/providers/pricing.js";

const prices = {
  "gpt-5-mini": [0.25, 0.025, 0, 0, 2],
  "gpt-5-2": [1.75, 0.175, 0, 0, 14],
  "gpt-5-3-codex": [1.75, 0.175, 0, 0, 14],
  "gpt-5-4": [2.5, 0.25, 0, 0, 15],
  "gpt-5-4-mini": [0.75, 0.075, 0, 0, 4.5],
  "gpt-5-4-nano": [0.2, 0.02, 0, 0, 1.25],
  "gpt-5-5": [5, 0.5, 0, 0, 30],
  "gpt-5-6-luna": [0.2, 0.02, 0.25, 0.25, 1.2],
  "gpt-5-6-sol": [4, 0.4, 5, 5, 20],
  "gpt-5-6-terra": [2, 0.2, 2.5, 2.5, 12],
  "gpt-6-astra": [10, 1, 12.5, 12.5, 50],
  "claude-4-5-haiku-reasoning": [1, 0.1, 1.25, 2, 5],
  "claude-4-5-sonnet-thinking": [3, 0.3, 3.75, 6, 15],
  "claude-sonnet-4": [3, 0.3, 3.75, 6, 15],
  "claude-sonnet-4-6": [3, 0.3, 3.75, 6, 15],
  "claude-sonnet-5": [2, 0.2, 2.5, 4, 10],
  "claude-opus-4": [15, 1.5, 18.75, 30, 75],
  "claude-opus-4-1": [15, 1.5, 18.75, 30, 75],
  "claude-opus-4-5": [5, 0.5, 6.25, 10, 25],
  "claude-opus-4-6": [5, 0.5, 6.25, 10, 25],
  "claude-opus-4-7": [5, 0.5, 6.25, 10, 25],
  "claude-opus-4-8": [5, 0.5, 6.25, 10, 25],
  "claude-opus-4-8-fast": [10, 1, 12.5, 20, 50],
  "claude-opus-5": [5, 0.5, 6.25, 10, 25],
  "claude-fable-5": [10, 1, 12.5, 20, 50],
  "claude-fable-5-1": [10, 0.25, 12.5, 20, 50],
  "claude-mythos-5": [10, 1, 12.5, 20, 50],
  "claude-mythos-5-1": [10, 0.25, 12.5, 20, 50],
  "claude-haiku-3-5": [0.8, 0.08, 1, 1.6, 4],
  "gemini-2-5-pro": [1.25, 0.125, 1.25, 1.25, 10],
  "gemini-3-flash": [0.5, 0.05, 0.5, 0.5, 3],
  "gemini-3-1-pro-preview": [2, 0.2, 2, 2, 12],
  "gemini-3-5-flash": [1.5, 0.15, 1.5, 1.5, 9],
  "gemini-3-6-flash": [0.75, 0.075, 0.75, 0.75, 3.75],
  "gemini-3-7-flash": [0.75, 0.075, 0.75, 0.75, 3.75],
  "gemini-3-8-flash": [0.75, 0.075, 0.75, 0.75, 3.75],
  "mai-code-1-flash": [0.75, 0.075, 0, 0, 4.5],
  "mai-code-1-1-flash": [0.2, 0.02, 0, 0, 1.2],
  "grok-4-5": [2, 0.5, 0, 0, 6],
  "grok-4-6": [2, 0.5, 0, 0, 6],
  "kimi-k2-7-code": [0.95, 0.19, 0, 0, 4],
  "kimi-k3": [3, 0.3, 0, 0, 15],
  "raptor-mini": [0.25, 0.025, 0, 0, 2]
};

const longContextPrices = {
  "gpt-5-4": [272_000, 5, 0.5, 0, 0, 22.5],
  "gpt-5-5": [272_000, 10, 1, 0, 0, 45],
  "gpt-5-6-luna": [272_000, 0.4, 0.04, 0.5, 0.5, 1.8],
  "gpt-5-6-sol": [272_000, 8, 0.8, 10, 10, 30],
  "gpt-5-6-terra": [272_000, 4, 0.4, 5, 5, 18],
  "gpt-6-astra": [272_000, 20, 2, 25, 25, 75]
};

function longContextPricingFor(slug) {
  const price = longContextPrices[slug];
  if (!price) return null;
  const [inputTokensThreshold, input, inputCacheRead, inputCacheWrite5m, inputCacheWrite1h, output] = price;
  return {
    inputTokensThreshold,
    input,
    output,
    inputCacheRead,
    inputCacheWrite5m,
    inputCacheWrite1h
  };
}

export const modelPricingRequests = [];

export function pricingFor(modelIds) {
  return new Map(modelIds.flatMap((modelId) => {
    const price = prices[modelPricingSlug(modelId)];
    if (!price) return [];
    const [input, inputCacheRead, inputCacheWrite5m, inputCacheWrite1h, output] = price;
    return [[modelId, {
      input,
      output,
      inputCacheRead,
      inputCacheWrite5m,
      inputCacheWrite1h,
      longContext: longContextPricingFor(modelPricingSlug(modelId))
    }]];
  }));
}

export function installModelPricingMock(overrides = {}) {
  modelPricingRequests.length = 0;
  configureModelPricingTransport(async (request) => {
    modelPricingRequests.push(request);
    return {
      ok: true,
      currency: "USD",
      unit: "per_1M_tokens",
      models: request.slugs.flatMap((slug) => {
        const price = overrides[slug] ?? prices[slug];
        if (!price) return [];
        const [input, input_cache_read, input_cache_w5m, input_cache_w1h, output] = price;
        const longContext = longContextPricingFor(slug);
        return [{
          slug,
          input,
          output,
          input_cache_read,
          input_cache_w5m,
          input_cache_w1h,
          long_context: longContext
            ? {
                input_tokens_threshold: longContext.inputTokensThreshold,
                input: longContext.input,
                output: longContext.output,
                input_cache_read: longContext.inputCacheRead,
                input_cache_w5m: longContext.inputCacheWrite5m,
                input_cache_w1h: longContext.inputCacheWrite1h
              }
            : null
        }];
      })
    };
  });
}

installModelPricingMock();
