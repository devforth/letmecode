import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  UsageProviderBase,
  addUsageTotals,
  createEmptyUsageTotals,
  sumUsageTotals,
  type LimitWindowRow,
  type LimitWindowScope,
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
import { parseAntigravityQuotaEntries } from "./quota-parser.js";
import { findAntigravityLocalServer } from "./rpc/discovery.js";
import { fetchAntigravityQuotaRpcData } from "./rpc/quota.js";
import { collectUsageFromRpc } from "./usage-parse.js";

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

const ANTIGRAVITY_CACHE_ROOT = path.join(
  os.homedir(),
  ".config",
  "tokscale",
  "antigravity-cache"
);

const MODEL_ALIASES: Record<string, string> = {
  "gemini-3-flash-a": "gemini-3-flash",
  "gemini-3-flash-preview": "gemini-3-flash",
  "gemini-3.1-pro-preview": "gemini-3.1-pro",
  "gemini-3.5-flash-preview": "gemini-3.5-flash",
  "claude-sonnet-4-6-20251201": "claude-sonnet-4-6",
  "claude-opus-4-6-20251201": "claude-opus-4-6"
};

export type AntigravityUsageRecord = {
  type: "usage";
  sessionId: string;
  responseId: string;
  timestamp: number;
  modelId: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};

export type AntigravityQuotaEntry = {
  limitId: string;
  modelIds: string[];
  remainingFraction: number;
  resetAt: number;
  windowMinutes: number;
  scope: LimitWindowScope;
};

export type AntigravityQuotaSnapshot = {
  entries: AntigravityQuotaEntry[];
  fetchedAt: number;
  planType: string;
  userIdHash: string | null;
};

export type AntigravityUsageProviderOptions = {
  collectUsage?: (
    options?: ProviderStatsOptions
  ) => Promise<AntigravityUsageRecord[]>;
  collectQuota?: () => Promise<AntigravityQuotaSnapshot>;
};

export class AntigravityUsageProvider extends UsageProviderBase {
  private readonly collectUsage: (
    options?: ProviderStatsOptions
  ) => Promise<AntigravityUsageRecord[]>;
  private readonly collectQuota: () => Promise<AntigravityQuotaSnapshot>;

  constructor(options: AntigravityUsageProviderOptions = {}) {
    super("antigravity", "Antigravity");
    this.collectUsage = options.collectUsage ?? collectUsageFromRpc;
    this.collectQuota =
      options.collectQuota ?? collectAntigravityQuotaFromLocalRpc;
  }

  async getStats(
    options: ProviderStatsOptions = {}
  ): Promise<ProviderStats> {
    const warnings: string[] = [];
    const [usageResult, quotaResult] = await Promise.allSettled([
      this.collectUsage(options),
      this.collectQuota()
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
        "Could not read Antigravity token usage cache."
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
      const modelId = resolveModelId(record.modelId);
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
        filesScanned: records.length > 0 ? 1 : 0,
        linesRead: records.length,
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
        rootLabel: "Tokscale usage + Antigravity local quota",
        rootPath: ANTIGRAVITY_CACHE_ROOT
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

async function collectAntigravityQuotaFromLocalRpc(): Promise<AntigravityQuotaSnapshot> {
  const server = await findAntigravityLocalServer();
  if (!server) {
    throw new Error("Antigravity local language server was not found.");
  }

  const data = await fetchAntigravityQuotaRpcData(server);

  return {
    // The RPC layer normalizes the quota summary; re-wrap it in the raw payload
    // shape so the shared parser maps windows and model pools consistently.
    entries: parseAntigravityQuotaEntries({
      response: { groups: data.groups }
    }),
    fetchedAt: Date.now(),
    planType: data.planName ?? "unknown",
    userIdHash: data.email
      ? createHash("md5").update(data.email).digest("hex")
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
  const modelIds = new Set(quota.modelIds.map(resolveModelId));
  const byModel = new Map<string, UsageTotals>();

  for (const record of records) {
    const modelId = resolveModelId(record.modelId);
    if (
      record.timestamp < startAt ||
      record.timestamp >= quota.resetAt ||
      !modelIds.has(modelId)
    ) {
      continue;
    }

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

  // Quota percentage is authoritative from Antigravity RPC. Token totals are
  // reconstructed from locally available usage events inside the same time
  // window and may not match Antigravity's internal quota accounting exactly.
  return {
    scope: quota.scope,
    planType,
    limitId: quota.limitId,
    modelType: modelGroupLabel(quota.modelIds),
    windowMinutes: quota.windowMinutes,
    startTimeUtcIso: new Date(startAt).toISOString(),
    endTimeUtcIso: new Date(quota.resetAt).toISOString(),
    firstSeenUtcIso: new Date(fetchedAt).toISOString(),
    lastSeenUtcIso: new Date(fetchedAt).toISOString(),
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
    cacheStatus: "known",
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

function resolveModelId(modelId: string): string {
  return MODEL_ALIASES[modelId] ?? (modelId || "unknown");
}

function modelGroupLabel(modelIds: string[]): string | undefined {
  const families: string[] = [];

  for (const modelId of modelIds) {
    const family = modelFamilyLabel(modelId);
    if (family && !families.includes(family)) {
      families.push(family);
    }
  }

  return families.length > 0 ? families.join("/") : undefined;
}

function modelFamilyLabel(modelId: string): string | null {
  if (modelId.startsWith("gemini")) {
    return "Gemini";
  }
  if (modelId.startsWith("claude")) {
    return "Claude";
  }
  if (modelId.startsWith("gpt")) {
    return "GPT";
  }

  return null;
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
