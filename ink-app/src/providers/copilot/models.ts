import { resolveUsageRate, type UsageRate, type UsageRateValue } from "../pricing.js";

/**
 * Copilot-specific estimated API-equivalent rate card (micro-credits per
 * million tokens). This is intentionally separate from the Codex and
 * Antigravity rate cards — Copilot bills the same model families at different
 * effective rates, so there is no single shared source of truth to reuse.
 */
export const RATE_CARD: Record<string, UsageRate> = {
  "gpt-5-mini": { input: 25, cacheRead: 2.5, cacheWrite: 25, cacheWrite5m: 25, cacheWrite1h: 25, output: 200 },
  "gpt-5.3-codex": { input: 175, cacheRead: 17.5, cacheWrite: 175, cacheWrite5m: 175, cacheWrite1h: 175, output: 1400 },
  "gpt-5.4": { input: 250, cacheRead: 25, cacheWrite: 250, cacheWrite5m: 250, cacheWrite1h: 250, output: 1500, longContext: { thresholdTokens: 272_000, rate: { input: 500, cacheRead: 50, cacheWrite: 500, cacheWrite5m: 500, cacheWrite1h: 500, output: 2250 } } },
  "gpt-5.4-mini": { input: 75, cacheRead: 7.5, cacheWrite: 75, cacheWrite5m: 75, cacheWrite1h: 75, output: 450 },
  "gpt-5.4-nano": { input: 20, cacheRead: 2, cacheWrite: 20, cacheWrite5m: 20, cacheWrite1h: 20, output: 125 },
  "gpt-5.5": { input: 500, cacheRead: 50, cacheWrite: 500, cacheWrite5m: 500, cacheWrite1h: 500, output: 3000, longContext: { thresholdTokens: 272_000, rate: { input: 1000, cacheRead: 100, cacheWrite: 1000, cacheWrite5m: 1000, cacheWrite1h: 1000, output: 4500 } } },
  "claude-haiku-4-5": { input: 100, cacheRead: 10, cacheWrite: 125, cacheWrite5m: 125, cacheWrite1h: 200, output: 500 },
  "claude-sonnet-4-5": { input: 300, cacheRead: 30, cacheWrite: 375, cacheWrite5m: 375, cacheWrite1h: 600, output: 1500 },
  "claude-sonnet-4-6": { input: 300, cacheRead: 30, cacheWrite: 375, cacheWrite5m: 375, cacheWrite1h: 600, output: 1500 },
  "claude-opus-4-5": { input: 500, cacheRead: 50, cacheWrite: 625, cacheWrite5m: 625, cacheWrite1h: 1000, output: 2500 },
  "claude-opus-4-6": { input: 500, cacheRead: 50, cacheWrite: 625, cacheWrite5m: 625, cacheWrite1h: 1000, output: 2500 },
  "claude-opus-4-7": { input: 500, cacheRead: 50, cacheWrite: 625, cacheWrite5m: 625, cacheWrite1h: 1000, output: 2500 },
  "claude-opus-4-8": { input: 500, cacheRead: 50, cacheWrite: 625, cacheWrite5m: 625, cacheWrite1h: 1000, output: 2500 },
  "claude-fable-5": { input: 1000, cacheRead: 100, cacheWrite: 1250, cacheWrite5m: 1250, cacheWrite1h: 2000, output: 5000 },
  "gemini-2.5-pro": { input: 125, cacheRead: 12.5, cacheWrite: 125, cacheWrite5m: 125, cacheWrite1h: 125, output: 1000 },
  "gemini-3-flash": { input: 50, cacheRead: 5, cacheWrite: 50, cacheWrite5m: 50, cacheWrite1h: 50, output: 300 },
  "gemini-3.1-pro": { input: 200, cacheRead: 20, cacheWrite: 200, cacheWrite5m: 200, cacheWrite1h: 200, output: 1200, longContext: { thresholdTokens: 200_000, rate: { input: 400, cacheRead: 40, cacheWrite: 400, cacheWrite5m: 400, cacheWrite1h: 400, output: 1800 } } },
  "gemini-3.5-flash": { input: 150, cacheRead: 15, cacheWrite: 150, cacheWrite5m: 150, cacheWrite1h: 150, output: 900 },
  "mai-code-1-flash": { input: 75, cacheRead: 7.5, cacheWrite: 75, cacheWrite5m: 75, cacheWrite1h: 75, output: 450 },
  "raptor-mini": { input: 25, cacheRead: 2.5, cacheWrite: 25, cacheWrite5m: 25, cacheWrite1h: 25, output: 200 }
};

/**
 * Model id prefixes that Copilot does not bill (inline completions / next-edit
 * suggestions). These are zero-rated rather than "unknown" so they never turn
 * aggregate credit totals unknown.
 */
export const NON_BILLABLE_MODEL_PREFIXES = ["copilot-nes", "copilot-suggestion"] as const;

/**
 * Canonicalize a Copilot model id. The exporter already emits stable,
 * human-readable ids (including dated suffixes like `gpt-5.4-2026-03-01`), and
 * the dashboard surfaces those verbatim, so this only guards the empty case.
 * Prefix-based rate resolution (see {@link rateForCopilotModel}) handles dated
 * suffixes without collapsing the displayed id.
 */
export function normalizeCopilotModelId(modelId: string): string {
  return modelId || "unknown";
}

export function rateForCopilotModel(modelId: string, inputTokens: number): UsageRateValue | undefined {
  return resolveUsageRate(RATE_CARD, modelId, inputTokens, { prefixMatch: true });
}

export function isNonBillableCopilotModel(modelId: string): boolean {
  return NON_BILLABLE_MODEL_PREFIXES.some(
    (prefix) => modelId === prefix || modelId.startsWith(`${prefix}-`)
  );
}
