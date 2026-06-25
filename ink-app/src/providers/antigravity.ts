import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
  UsageProviderBase,
  addUsageTotals,
  createEmptyUsageTotals,
  sumUsageTotals,
  type ModelUsageRow,
  type ProviderStats,
  type ProviderStatsOptions,
  type UsageTotals
} from "./contract.js";
import {
  addDailyUsage,
  buildDailyUsageRows,
  createDailyUsageAggregates
} from "./daily.js";
import { resolveUsageRate, type UsageRate, type UsageRateValue } from "./pricing.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

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

type AntigravityUsageProviderOptions = {
  collectUsage?: () => Promise<AntigravityUsageRecord[]>;
};

export class AntigravityUsageProvider extends UsageProviderBase {
  private readonly collectUsage: () => Promise<AntigravityUsageRecord[]>;

  constructor(options: AntigravityUsageProviderOptions = {}) {
    super("antigravity", "Antigravity");
    this.collectUsage =
      options.collectUsage ??
      collectAntigravityUsageFromTokscale;
  }

  async getStats(
    _options: ProviderStatsOptions = {}
  ): Promise<ProviderStats> {
    const warnings: string[] = [];
    let records: AntigravityUsageRecord[] = [];

    try {
      records = await this.collectUsage();
    } catch {
      warnings.push(
        "Open Antigravity IDE before running LetMeCode so token usage can be synchronized."
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
        distinctPlanTypes: [],
        rootLabel: "Antigravity IDE sync",
        rootPath: "antigravity-ide-rpc"
      },
      modelUsage,
      dayUsage: buildDailyUsageRows(byDay),
      primaryLimitWindows: [],
      secondaryLimitWindows: [],
      warnings
    };
  }
}

export async function collectAntigravityUsage(): Promise<
  AntigravityUsageRecord[]
> {
  return collectAntigravityUsageFromTokscale();
}

async function collectAntigravityUsageFromTokscale(): Promise<AntigravityUsageRecord[]> {
  await runTokscale([
    "antigravity",
    "sync"
  ]);

  return readAntigravityUsageCache(getAntigravityCacheRoot());
}

async function runTokscale(
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    [require.resolve("@tokscale/cli/dist/index.js"), ...args],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    }
  );
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
}

async function readAntigravityUsageCache(
  cacheRoot: string
): Promise<AntigravityUsageRecord[]> {
  const sessionsRoot = path.join(cacheRoot, "sessions");
  const records: AntigravityUsageRecord[] = [];

  for await (const filePath of walkJsonlFiles(sessionsRoot)) {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const lineReader = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });

    for await (const line of lineReader) {
      if (!line.trim()) {
        continue;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }

      const record = usageRecordFromCacheEntry(payload);
      if (record) {
        records.push(record);
      }
    }
  }

  return records;
}

function usageRecordFromCacheEntry(
  value: unknown
): AntigravityUsageRecord | null {
  const entry =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;

  if (!entry || entry.type !== "usage") {
    return null;
  }

  const sessionId =
    typeof entry.sessionId === "string" ? entry.sessionId : "";
  const responseId =
    typeof entry.responseId === "string" ? entry.responseId : "";
  const modelId =
    typeof entry.modelId === "string" ? entry.modelId : "";
  const timestamp = numberOrZero(entry.timestamp);

  if (!sessionId || !responseId || !modelId || timestamp <= 0) {
    return null;
  }

  return {
    type: "usage",
    sessionId,
    responseId,
    timestamp,
    modelId,
    input: numberOrZero(entry.input),
    cacheRead: numberOrZero(entry.cacheRead),
    cacheWrite: numberOrZero(entry.cacheWrite),
    output: numberOrZero(entry.output),
    reasoning: numberOrZero(entry.reasoning)
  };
}

function getAntigravityCacheRoot(): string {
  return path.join(
    os.homedir(),
    ".config",
    "tokscale",
    "antigravity-cache"
  );
}

async function* walkJsonlFiles(
  directory: string
): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, {
      withFileTypes: true
    });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonlFiles(fullPath);
    } else if (entry.isFile() && fullPath.endsWith(".jsonl")) {
      yield fullPath;
    }
  }
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
