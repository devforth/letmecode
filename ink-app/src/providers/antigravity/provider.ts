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
import { resolveUsageRate, type UsageRate, type UsageRateValue } from "../pricing.js";
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

const RATE_CARD: Record<string, UsageRate> = {
  "gemini-3.5-flash": {
    input: 150,
    cacheRead: 15,
    cacheWrite: 150,
    cacheWrite5m: 150,
    cacheWrite1h: 150,
    output: 900
  },
  "gemini-3.1-pro": {
    input: 200,
    cacheRead: 20,
    cacheWrite: 200,
    cacheWrite5m: 200,
    cacheWrite1h: 200,
    output: 1200,
    longContext: {
      thresholdTokens: 200_000,
      rate: {
        input: 400,
        cacheRead: 40,
        cacheWrite: 400,
        cacheWrite5m: 400,
        cacheWrite1h: 400,
        output: 1800
      }
    }
  },
  "gemini-3-flash": {
    input: 50,
    cacheRead: 5,
    cacheWrite: 50,
    cacheWrite5m: 50,
    cacheWrite1h: 50,
    output: 300
  },
  "claude-sonnet-4-6": {
    input: 300,
    cacheRead: 30,
    cacheWrite: 375,
    cacheWrite5m: 375,
    cacheWrite1h: 600,
    output: 1500
  },
  "claude-opus-4-6": {
    input: 500,
    cacheRead: 50,
    cacheWrite: 625,
    cacheWrite5m: 625,
    cacheWrite1h: 1000,
    output: 2500
  }
};

const UNPRICED_MODELS = new Set([
  "gpt-oss-120b"
]);

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

    const byModel = new Map<string, UsageTotals>();
    const byDay = createDailyUsageAggregates();

    for (const record of selectedRecords) {
      const modelId = normalizeAntigravityModelId(record.modelId);
      const totals = usageRecordToTotals(modelId, record);
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
      .filter((row) => !rateForModel(row.modelId, rowInputTokens(row)) && !UNPRICED_MODELS.has(row.modelId))
      .map((row) => row.modelId);
    if (unknownPricedModels.length > 0) {
      warnings.push(
        `No Antigravity estimated API-equivalent rate configured for: ${unknownPricedModels.join(", ")}.`
      );
    }

    const limitWindows =
      quotaSnapshot?.entries.map((quota) =>
        buildAntigravityLimitWindow(
          quota,
          quotaSnapshot.planType,
          selectedRecords,
          quotaSnapshot.fetchedAt
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
  fetchedAt: number
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
      usageRecordToTotals(modelId, record)
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
    byKey.set(
      `${record.sessionId}:${record.responseId}`,
      record
    );
  }

  return [...byKey.values()];
}

function usageRecordToTotals(
  modelId: string,
  record: AntigravityUsageRecord
): UsageTotals {
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
    estimatedCredits: creditsFor(modelId, record),
    eventCount: 1,
    // No cache status is set: cacheRead is a real value and renders as-is, while
    // cacheWrite is 0 and already renders as "-" (zero tokens), so a status flag
    // would add nothing.
    estimatedCreditsStatus: rateForModel(modelId, record.input)
      ? "known"
      : "unavailable"
  };
}

function creditsFor(
  modelId: string,
  record: AntigravityUsageRecord
): number {
  const rate = rateForModel(modelId, record.input);

  if (!rate) {
    return 0;
  }

  return (
    (record.input / 1_000_000) * rate.input +
    (record.cacheRead / 1_000_000) * rate.cacheRead +
    (record.cacheWrite / 1_000_000) * rate.cacheWrite +
    (record.output / 1_000_000) * rate.output
  );
}

function rateForModel(
  modelId: string,
  inputTokens: number
): UsageRateValue | undefined {
  return resolveUsageRate(RATE_CARD, modelId, inputTokens);
}

function rowInputTokens(row: ModelUsageRow): number {
  return row.totals.inputTokens + row.totals.cacheReadInputTokens + row.totals.cacheWriteInputTokens;
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
