import { createHash } from "node:crypto";
import {
  UsageProviderBase,
  addUsageTotals,
  createEmptyUsageTotals,
  sumUsageTotals,
  type LimitWindowRow,
  type ModelUsageRow,
  type ProviderStats,
  type ProviderStatsOptions,
  type UsageTotals
} from "../contract.js";
import {
  addDailyUsage,
  buildDailyUsageRows,
  createDailyUsageAggregates
} from "../daily.js";
import {
  fetchModelPricing,
  modelCostCredits,
  type ModelPricing
} from "../pricing.js";
import {
  modelScopeLabel,
  modelScopeMatches,
  normalizeAntigravityModelId
} from "./models.js";
import { parseAntigravityQuotaEntries } from "./quota-parser.js";
import {
  findAntigravityLocalServer,
  type AntigravityConnection
} from "./rpc/discovery.js";
import { extractQuotaGroups, fetchAntigravityUserStatus } from "./rpc/quota.js";
import { collectUsageFromLocalRpc } from "./usage-parse.js";
import type {
  AntigravityQuotaEntry,
  AntigravityQuotaSnapshot,
  AntigravityUsageRecord
} from "./types.js";

export type {
  AntigravityModelScope,
  AntigravityQuotaEntry,
  AntigravityQuotaSnapshot,
  AntigravityUsageRecord
} from "./types.js";

/*
Previous local prices in credits per 1M tokens, kept temporarily as requested:
gemini-3.8-flash, 3.7-flash, 3.6-flash 75 / 7.5 / 75 / 375
gemini-3.5-flash 150 / 15 / 150 / 900
gemini-3.1-pro 200 / 20 / 200 / 1200; >200k 400 / 40 / 400 / 1800
gemini-3-flash 50 / 5 / 50 / 300
claude-sonnet-4-6 300 / 30 / 375 / 1500
claude-opus-4-6 500 / 50 / 625 / 2500
Columns: input / cache read / cache write / output.
*/

export type AntigravityUsageProviderOptions = {
  collectUsage?: (
    options?: ProviderStatsOptions
  ) => Promise<AntigravityUsageRecord[]>;
  collectQuota?: () => Promise<AntigravityQuotaSnapshot>;
  findConnection?: () => Promise<AntigravityConnection | null>;
};

export class AntigravityUsageProvider extends UsageProviderBase {
  private readonly collectUsageOverride?: (
    options?: ProviderStatsOptions
  ) => Promise<AntigravityUsageRecord[]>;
  private readonly collectQuotaOverride?: () => Promise<AntigravityQuotaSnapshot>;
  private readonly findConnection: () => Promise<AntigravityConnection | null>;

  constructor(options: AntigravityUsageProviderOptions = {}) {
    super("antigravity", "Antigravity");
    this.collectUsageOverride = options.collectUsage;
    this.collectQuotaOverride = options.collectQuota;
    this.findConnection = options.findConnection ?? findAntigravityLocalServer;
  }

  async getStats(
    options: ProviderStatsOptions = {}
  ): Promise<ProviderStats> {
    const warnings: string[] = [];

    // Discover the local language server at most once per refresh and share the
    // resulting connection (and its probe payload) between both collectors.
    let connectionPromise: Promise<AntigravityConnection | null> | undefined;
    const connect = () => (connectionPromise ??= this.findConnection());

    const [usageResult, quotaResult] = await Promise.allSettled([
      this.collectUsageOverride
        ? this.collectUsageOverride(options)
        : collectUsageFromConnection(connect, options),
      this.collectQuotaOverride
        ? this.collectQuotaOverride()
        : collectQuotaFromConnection(connect)
    ]);

    const records =
      usageResult.status === "fulfilled"
        ? usageResult.value
        : [];
    const quotaSnapshot =
      quotaResult.status === "fulfilled"
        ? quotaResult.value
        : null;

    if (usageResult.status === "rejected") {
      warnings.push(
        "Could not read Antigravity usage from the local RPC."
      );
    }
    if (quotaResult.status === "rejected") {
      warnings.push(
        "Live Antigravity quota is unavailable. Ensure the Antigravity IDE is running."
      );
    } else if (quotaResult.value.entries.length === 0) {
      warnings.push(
        "Antigravity local quota RPC responded, but no recognized model quota windows were found."
      );
    }
    const selectedRecords = deduplicateRecords(records);
    const duplicateEvents =
      records.length - selectedRecords.length;
    if (duplicateEvents > 0) {
      warnings.push(
        `Collapsed ${duplicateEvents} duplicate Antigravity usage response(s).`
      );
    }

    let pricing = new Map<string, ModelPricing>();
    try {
      pricing = await fetchModelPricing(
        selectedRecords.map((record) => normalizeAntigravityModelId(record.modelId)),
        "antigravity"
      );
    } catch {
      warnings.push("Model pricing API is unavailable.");
    }

    const byModel = new Map<string, UsageTotals>();
    const byDay = createDailyUsageAggregates();

    for (const record of selectedRecords) {
      const modelId = normalizeAntigravityModelId(record.modelId);
      const totals = usageRecordToTotals(modelId, record, pricing);
      addModelUsage(byModel, modelId, totals);
      addDailyUsage(
        byDay,
        record.timestamp,
        modelId,
        undefined,
        totals
      );
    }

    const modelUsage = [...byModel.entries()]
      .map<ModelUsageRow>(([modelId, totals]) => ({
        modelId,
        totals
      }))
      .sort(
        (left, right) =>
          right.totals.estimatedCredits -
          left.totals.estimatedCredits
      );

    const unknownPricedModels = modelUsage
      .filter((row) => row.totals.estimatedCreditsStatus === "unavailable")
      .map((row) => row.modelId);
    if (unknownPricedModels.length > 0) {
      warnings.push(
        `No complete Antigravity API-equivalent pricing returned for: ${unknownPricedModels.join(", ")}.`
      );
    }

    const limitWindows =
      quotaSnapshot?.entries.map((quota) =>
        buildAntigravityLimitWindow(
          quota,
          quotaSnapshot.planType,
          selectedRecords,
          quotaSnapshot.fetchedAt,
          pricing
        )
      ) ?? [];

    return {
      providerId: this.id,
      providerLabel: this.label,
      summary: {
        // The provider reads no files or lines; usage comes from the local RPC.
        filesScanned: 0,
        linesRead: 0,
        tokenEvents: selectedRecords.length,
        totals: sumUsageTotals(
          modelUsage.map((row) => row.totals)
        ),
        distinctModels: modelUsage.map((row) => row.modelId),
        distinctPlanTypes: [
          ...new Set(
            limitWindows.map((window) => window.planType)
          )
        ],
        rootLabel: "Antigravity local RPC",
        rootPath: "127.0.0.1"
      },
      modelUsage,
      dayUsage: buildDailyUsageRows(byDay),
      primaryLimitWindows: limitWindows.filter(
        (window) => window.scope === "primary"
      ),
      secondaryLimitWindows: limitWindows.filter(
        (window) => window.scope === "secondary"
      ),
      warnings,
      analytics: quotaSnapshot?.userIdHash
        ? {
            agentName: this.label.replace(/\s/g, ""),
            userIdHash: quotaSnapshot.userIdHash
          }
        : undefined
    };
  }
}

async function collectUsageFromConnection(
  connect: () => Promise<AntigravityConnection | null>,
  options: ProviderStatsOptions
): Promise<AntigravityUsageRecord[]> {
  const connection = await connect();
  return connection
    ? collectUsageFromLocalRpc(connection.server, options)
    : [];
}

async function collectQuotaFromConnection(
  connect: () => Promise<AntigravityConnection | null>
): Promise<AntigravityQuotaSnapshot> {
  const connection = await connect();
  if (!connection) {
    throw new Error("Antigravity local language server was not found.");
  }

  const status = await fetchAntigravityUserStatus(connection.server);

  return {
    entries: parseAntigravityQuotaEntries(
      extractQuotaGroups(connection.quotaSummary)
    ),
    fetchedAt: Date.now(),
    planType: status.planName ?? "unknown",
    userIdHash: status.email
      ? createHash("md5").update(status.email).digest("hex")
      : null
  };
}

function buildAntigravityLimitWindow(
  quota: AntigravityQuotaEntry,
  planType: string,
  records: AntigravityUsageRecord[],
  fetchedAt: number,
  pricing: ReadonlyMap<string, ModelPricing>
): LimitWindowRow {
  const startAt = quota.resetAt - quota.windowMinutes * 60_000;
  const byModel = new Map<string, UsageTotals>();
  const matchingTimestamps: number[] = [];

  for (const record of records) {
    const modelId = normalizeAntigravityModelId(record.modelId);
    if (
      record.timestamp < startAt ||
      record.timestamp >= quota.resetAt ||
      !modelScopeMatches(quota.modelScope, modelId)
    ) {
      continue;
    }

    matchingTimestamps.push(record.timestamp);
    addModelUsage(
      byModel,
      modelId,
      usageRecordToTotals(modelId, record, pricing)
    );
  }

  const modelUsage = [...byModel.entries()]
    .map<ModelUsageRow>(([modelId, totals]) => ({
      modelId,
      totals
    }))
    .sort(
      (left, right) =>
        right.totals.estimatedCredits -
        left.totals.estimatedCredits
    );
  const totals = sumUsageTotals(modelUsage.map((row) => row.totals));
  const usedPercent = clampPercent((1 - quota.remainingFraction) * 100);

  // The first/last-seen range reflects the matched local usage events inside
  // the window. With no matches, fall back to the window start and the fetch
  // time. Quota percentage is authoritative from Antigravity RPC; token totals
  // are reconstructed locally and may not match its internal accounting exactly.
  const firstSeenMs = matchingTimestamps.length
    ? Math.min(...matchingTimestamps)
    : startAt;
  const lastSeenMs = matchingTimestamps.length
    ? Math.max(...matchingTimestamps)
    : fetchedAt;

  return {
    scope: quota.scope,
    planType,
    limitId: quota.limitId,
    modelType: modelScopeLabel(quota.modelScope),
    windowMinutes: quota.windowMinutes,
    startTimeUtcIso: new Date(startAt).toISOString(),
    endTimeUtcIso: new Date(quota.resetAt).toISOString(),
    firstSeenUtcIso: new Date(firstSeenMs).toISOString(),
    lastSeenUtcIso: new Date(lastSeenMs).toISOString(),
    minUsedPercent: usedPercent,
    maxUsedPercent: usedPercent,
    totals,
    modelUsage,
    eventCount: totals.eventCount
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, value));
}

function deduplicateRecords(
  records: AntigravityUsageRecord[]
): AntigravityUsageRecord[] {
  const byKey = new Map<string, AntigravityUsageRecord>();

  for (const record of records) {
    const key = `${record.sessionId}:${record.responseId}`;
    const existing = byKey.get(key);
    // The RPC may surface the same response more than once (e.g. progressive
    // snapshots in unspecified order). Keep the largest coherent total rather
    // than trusting iteration order, so we never undercount a final snapshot.
    if (!existing || recordTokenTotal(record) > recordTokenTotal(existing)) {
      byKey.set(key, record);
    }
  }

  return [...byKey.values()];
}

function recordTokenTotal(record: AntigravityUsageRecord): number {
  return record.input + record.cacheRead + record.cacheWrite + record.output;
}

function usageRecordToTotals(
  modelId: string,
  record: AntigravityUsageRecord,
  pricing: ReadonlyMap<string, ModelPricing>
): UsageTotals {
  const estimatedCredits = creditsFor(modelId, record, pricing);
  return {
    inputTokens: record.input,
    outputTokens: record.output,
    cacheReadInputTokens: record.cacheRead,
    cacheWriteInputTokens: record.cacheWrite,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    reasoningOutputTokens: Math.min(
      record.reasoning,
      record.output
    ),
    totalTokens:
      record.input +
      record.cacheRead +
      record.cacheWrite +
      record.output,
    estimatedCredits: estimatedCredits ?? 0,
    eventCount: 1,
    // The local RPC reports cache reads but never cache writes, so a zero cache
    // write is genuinely unknown (not a confirmed zero) and is surfaced as "-".
    // A positive value only appears when a source explicitly reports it, in
    // which case it is both billed (see creditsFor) and shown as known.
    cacheReadStatus: "known",
    cacheWriteStatus: record.cacheWrite > 0 ? "known" : "unavailable",
    estimatedCreditsStatus: estimatedCredits === undefined ? "unavailable" : "known"
  };
}

function creditsFor(
  modelId: string,
  record: AntigravityUsageRecord,
  pricing: ReadonlyMap<string, ModelPricing>
): number | undefined {
  return modelCostCredits(pricing.get(modelId), {
    inputTokens: record.input,
    outputTokens: record.output,
    cacheReadInputTokens: record.cacheRead,
    cacheWrite5mInputTokens: record.cacheWrite,
    cacheWrite1hInputTokens: 0
  });
}

function addModelUsage(
  byModel: Map<string, UsageTotals>,
  modelId: string,
  deltaTotals: UsageTotals
): void {
  const totals =
    byModel.get(modelId) ?? createEmptyUsageTotals();
  addUsageTotals(totals, deltaTotals);
  byModel.set(modelId, totals);
}
