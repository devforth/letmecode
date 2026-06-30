import {
  addUsageTotals,
  sumUsageTotals,
  type ModelUsageRow,
  type UsageTotals,
  type UsageValueStatus
} from "../../contract.js";
import {
  addDailyUsage,
  buildDailyUsageRows,
  createDailyUsageAggregates
} from "../../daily.js";
import {
  isNonBillableCopilotModel,
  normalizeCopilotModelId,
  rateForCopilotModel
} from "../models.js";
import type { CopilotAggregatedUsage, CopilotUsageEvent } from "../types.js";

const CACHE_UNAVAILABLE_WARNING =
  "Copilot cache token attributes are unavailable for some events; cached/non-cached tokens and estimated credits are shown as unknown.";

/**
 * Aggregate normalized Copilot usage events into per-model and per-day rollups
 * plus summary totals, applying the corrected cache accounting model where the
 * reported input already INCLUDES cache-read tokens but NOT cache-write tokens.
 * Pure and deterministic: independent of input ordering.
 */
export function aggregateCopilotUsage(events: CopilotUsageEvent[]): CopilotAggregatedUsage {
  const byModel = new Map<string, UsageTotals>();
  const byDay = createDailyUsageAggregates();
  const unratedModels = new Set<string>();

  for (const event of events) {
    const modelId = normalizeCopilotModelId(event.modelId);
    const hasCacheInfo =
      event.cacheReadStatus === "known" || event.cacheWriteStatus === "known";

    const cacheRead = hasCacheInfo
      ? Math.min(event.cacheReadInputTokens, event.inputTokens)
      : 0;
    const uncachedInput = hasCacheInfo
      ? Math.max(0, event.inputTokens - cacheRead)
      : event.inputTokens;
    const cacheWrite = hasCacheInfo ? Math.max(0, event.cacheWriteInputTokens) : 0;
    const output = event.outputTokens;
    const reasoning = Math.min(event.reasoningOutputTokens, output);

    const nonBillable = isNonBillableCopilotModel(modelId);
    const rate = nonBillable ? undefined : rateForCopilotModel(modelId, event.inputTokens);
    if (!nonBillable && rate === undefined) {
      unratedModels.add(modelId);
    }

    const creditsKnown = nonBillable || (hasCacheInfo && rate !== undefined);
    const estimatedCreditsStatus: UsageValueStatus = creditsKnown ? "known" : "unavailable";
    const estimatedCredits =
      rate !== undefined && hasCacheInfo
        ? (uncachedInput / 1_000_000) * rate.input +
          (cacheRead / 1_000_000) * rate.cacheRead +
          (cacheWrite / 1_000_000) * rate.cacheWrite +
          (output / 1_000_000) * rate.output
        : 0;

    const totals: UsageTotals = {
      inputTokens: uncachedInput,
      outputTokens: output,
      cacheReadInputTokens: cacheRead,
      cacheWriteInputTokens: cacheWrite,
      cacheWrite5mInputTokens: 0,
      cacheWrite1hInputTokens: 0,
      reasoningOutputTokens: reasoning,
      totalTokens: uncachedInput + cacheRead + cacheWrite + output,
      estimatedCredits,
      eventCount: 1,
      cacheReadStatus: event.cacheReadStatus,
      cacheWriteStatus: event.cacheWriteStatus,
      estimatedCreditsStatus
    };

    const existing = byModel.get(modelId);
    if (existing) {
      addUsageTotals(existing, totals);
    } else {
      byModel.set(modelId, { ...totals });
    }

    addDailyUsage(byDay, event.timestampMs, modelId, undefined, totals);
  }

  const modelUsage: ModelUsageRow[] = [...byModel.entries()]
    .map(([modelId, totals]) => ({ modelId, totals }))
    .sort((left, right) => right.totals.estimatedCredits - left.totals.estimatedCredits);

  const summaryTotals = sumUsageTotals(modelUsage.map((row) => row.totals));
  const distinctModels = modelUsage.map((row) => row.modelId);
  const dayUsage = buildDailyUsageRows(byDay);

  const warnings: string[] = [];
  if (unratedModels.size > 0) {
    const sorted = [...unratedModels].sort();
    warnings.push(`Pricing is unavailable for models: ${sorted.join(", ")}.`);
  }
  if (
    summaryTotals.cacheReadStatus === "unavailable" ||
    summaryTotals.cacheWriteStatus === "unavailable"
  ) {
    warnings.push(CACHE_UNAVAILABLE_WARNING);
  }

  return {
    modelUsage,
    dayUsage,
    summaryTotals,
    distinctModels,
    tokenEvents: events.length,
    warnings
  };
}
