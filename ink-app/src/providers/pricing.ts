import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const MODEL_PRICING_ENDPOINT =
  process.env.LETMECODE_MODEL_PRICING_ENDPOINT ??
  "https://devforth.io/admin/adminapi/v1/get_model_pricing";
const PRICE_CACHE_TTL_MS = 5 * 60_000;
const USD_TO_CREDITS = 100;
const MODEL_SLUG_ALIASES: Record<string, string> = {
  "claude-haiku-4-5": "claude-4-5-haiku-reasoning",
  "claude-sonnet-4-5": "claude-4-5-sonnet-thinking",
  "gemini-3-1-pro": "gemini-3-1-pro-preview"
};

export type ModelPricingSource =
  | "codex"
  | "claude_code"
  | "github_copilot"
  | "antigravity";

type ModelPricingRates = {
  input: number;
  output: number;
  inputCacheRead: number;
  inputCacheWrite5m: number | null;
  inputCacheWrite1h: number | null;
};

export type ModelLongContextPricing = ModelPricingRates & {
  inputTokensThreshold: number;
};

export type ModelPricing = ModelPricingRates & {
  longContext: ModelLongContextPricing | null;
};

export type ModelPricingRequest = {
  slugs: string[];
  available_in: {
    main: ModelPricingSource[];
    other: ModelPricingSource[];
  };
};

type ModelPricingResponseRow = {
  slug: string;
  input: number;
  output: number;
  input_cache_read: number;
  input_cache_w5m: number | null;
  input_cache_w1h: number | null;
  long_context: {
    input_tokens_threshold: number;
    input: number;
    output: number;
    input_cache_read: number;
    input_cache_w5m: number | null;
    input_cache_w1h: number | null;
  } | null;
};

export type ModelPricingResponse = {
  ok: boolean;
  currency: "USD";
  unit: "per_1M_tokens";
  models: ModelPricingResponseRow[];
};

export type ModelPricingTransport = (
  request: ModelPricingRequest
) => Promise<ModelPricingResponse>;

type CachedResponse = {
  expiresAt: number;
  response: Promise<ModelPricingResponse>;
};

const responseCache = new Map<string, CachedResponse>();
let pricingTransport: ModelPricingTransport = postModelPricingRequest;

export function configureModelPricingTransport(transport: ModelPricingTransport): void {
  pricingTransport = transport;
  responseCache.clear();
}

export function modelPricingSlug(modelId: string): string {
  const slug = modelId
    .trim()
    .toLowerCase()
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  return MODEL_SLUG_ALIASES[slug] ?? slug;
}

export async function fetchModelPricing(
  modelIds: string[],
  source: ModelPricingSource
): Promise<Map<string, ModelPricing>> {
  const slugByModelId = new Map(
    [...new Set(modelIds)]
      .filter((modelId) => modelId !== "unknown" && modelId !== "<synthetic>")
      .map((modelId) => [modelId, modelPricingSlug(modelId)])
  );
  const slugs = [...new Set(slugByModelId.values())].sort();
  if (slugs.length === 0) {
    return new Map();
  }

  const request: ModelPricingRequest = {
    slugs,
    available_in: { main: [source], other: [] }
  };
  const response = await fetchCached(request);
  const pricingBySlug = new Map(
    response.models.map((model) => [
      model.slug,
      {
        input: model.input,
        output: model.output,
        inputCacheRead: model.input_cache_read,
        inputCacheWrite5m: model.input_cache_w5m,
        inputCacheWrite1h: model.input_cache_w1h,
        longContext: model.long_context
          ? {
              inputTokensThreshold: model.long_context.input_tokens_threshold,
              input: model.long_context.input,
              output: model.long_context.output,
              inputCacheRead: model.long_context.input_cache_read,
              inputCacheWrite5m: model.long_context.input_cache_w5m,
              inputCacheWrite1h: model.long_context.input_cache_w1h
            }
          : null
      }
    ] satisfies [string, ModelPricing])
  );

  return new Map(
    [...slugByModelId.entries()].flatMap(([modelId, slug]) => {
      const pricing = pricingBySlug.get(slug);
      return pricing ? [[modelId, pricing]] : [];
    })
  );
}

export function modelCostCredits(
  pricing: ModelPricing | undefined,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheWrite5mInputTokens: number;
    cacheWrite1hInputTokens: number;
  }
): number | undefined {
  if (!pricing) {
    return undefined;
  }
  const totalInputTokens =
    usage.inputTokens +
    usage.cacheReadInputTokens +
    usage.cacheWrite5mInputTokens +
    usage.cacheWrite1hInputTokens;
  const rates =
    pricing.longContext && totalInputTokens > pricing.longContext.inputTokensThreshold
      ? pricing.longContext
      : pricing;

  if (usage.cacheWrite5mInputTokens > 0 && rates.inputCacheWrite5m === null) {
    return undefined;
  }
  if (usage.cacheWrite1hInputTokens > 0 && rates.inputCacheWrite1h === null) {
    return undefined;
  }

  return (
    (usage.inputTokens / 1_000_000) * rates.input +
    (usage.cacheReadInputTokens / 1_000_000) * rates.inputCacheRead +
    (usage.cacheWrite5mInputTokens / 1_000_000) * (rates.inputCacheWrite5m ?? 0) +
    (usage.cacheWrite1hInputTokens / 1_000_000) * (rates.inputCacheWrite1h ?? 0) +
    (usage.outputTokens / 1_000_000) * rates.output
  ) * USD_TO_CREDITS;
}

async function fetchCached(request: ModelPricingRequest): Promise<ModelPricingResponse> {
  const key = JSON.stringify(request);
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.response;
  }

  const response = pricingTransport(request);
  responseCache.set(key, {
    expiresAt: Date.now() + PRICE_CACHE_TTL_MS,
    response
  });
  try {
    return await response;
  } catch (error) {
    responseCache.delete(key);
    throw error;
  }
}

async function postModelPricingRequest(
  body: ModelPricingRequest
): Promise<ModelPricingResponse> {
  return new Promise((resolve, reject) => {
    const encodedBody = Buffer.from(JSON.stringify(body), "utf8");
    const target = new URL(MODEL_PRICING_ENDPOINT);
    const request = target.protocol === "http:" ? httpRequest : httpsRequest;
    const req = request(
      {
        method: "POST",
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: {
          "content-type": "application/json",
          "content-length": encodedBody.byteLength
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Model pricing request failed with status ${res.statusCode ?? "unknown"}`));
            return;
          }
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelPricingResponse);
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(5_000, () => {
      req.destroy(new Error("Model pricing request timed out"));
    });
    req.write(encodedBody);
    req.end();
  });
}
