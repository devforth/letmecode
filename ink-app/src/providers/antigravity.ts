import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import https from "node:https";
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
  type LimitWindowRow,
  type LimitWindowScope,
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

const ANTIGRAVITY_QUOTA_SUMMARY_PATH =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const ANTIGRAVITY_USER_STATUS_PATH =
  "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const ANTIGRAVITY_CACHE_ROOT = path.join(
  os.homedir(),
  ".config",
  "tokscale",
  "antigravity-cache"
);
const QUOTA_WINDOWS = {
  "5h": {
    scope: "primary",
    windowMinutes: 300
  },
  weekly: {
    scope: "secondary",
    windowMinutes: 10_080
  }
} satisfies Record<
  string,
  {
    scope: LimitWindowScope;
    windowMinutes: number;
  }
>;

const QUOTA_MODEL_GROUPS = [
  {
    pattern: /gemini/,
    models: [
      "gemini-3.5-flash",
      "gemini-3.1-pro",
      "gemini-3-flash"
    ]
  },
  {
    pattern: /claude|gpt/,
    models: [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gpt-oss-120b"
    ]
  }
];

const MODEL_ALIASES: Record<string, string> = {
  "gemini-3-flash-a": "gemini-3-flash",
  "gemini-3-flash-preview": "gemini-3-flash",
  "gemini-3.1-pro-preview": "gemini-3.1-pro",
  "gemini-3.5-flash-preview": "gemini-3.5-flash",
  "claude-sonnet-4-6-20251201": "claude-sonnet-4-6",
  "claude-opus-4-6-20251201": "claude-opus-4-6"
};

type QuotaBucket = {
  bucketId?: string;
  window?: keyof typeof QUOTA_WINDOWS;
  remainingFraction?: number;
  resetTime?: string;
};

type QuotaGroup = {
  displayName?: string;
  description?: string;
  buckets?: QuotaBucket[];
};

type QuotaPayload = {
  response?: {
    groups?: QuotaGroup[];
  };
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
  collectUsage?: () => Promise<AntigravityUsageRecord[]>;
  collectQuota?: () => Promise<AntigravityQuotaSnapshot>;
};

export class AntigravityUsageProvider extends UsageProviderBase {
  private readonly collectUsage: () => Promise<AntigravityUsageRecord[]>;
  private readonly collectQuota: () => Promise<AntigravityQuotaSnapshot>;

  constructor(options: AntigravityUsageProviderOptions = {}) {
    super("antigravity", "Antigravity");
    this.collectUsage =
      options.collectUsage ?? readAntigravityUsageCache;
    this.collectQuota =
      options.collectQuota ??
      collectAntigravityQuotaFromLocalRpc;
  }

  async getStats(
    _options: ProviderStatsOptions = {}
  ): Promise<ProviderStats> {
    const warnings: string[] = [];
    const [usageResult, quotaResult] = await Promise.allSettled([
      this.collectUsage(),
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

  const [quota, status] = await Promise.all([
    rpc(server, ANTIGRAVITY_QUOTA_SUMMARY_PATH),
    rpc(server, ANTIGRAVITY_USER_STATUS_PATH, {
      metadata: {
        ideName: "antigravity",
        extensionName: "antigravity",
        ideVersion: "unknown",
        locale: "en"
      }
    }).catch(() => null)
  ]);
  
  return {
    entries: parseAntigravityQuotaEntries(quota),
    fetchedAt: Date.now(),
    planType: status.userStatus.planStatus.planInfo.planName ?? "unknown",
    userIdHash:  createHash("md5").update(status.userStatus.email).digest("hex")
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
  // reconstructed from locally available Tokscale events inside the same time
  // window and may not match Antigravity's internal quota accounting exactly.
  return {
    scope: quota.scope,
    planType,
    limitId: quota.limitId,
    windowMinutes: quota.windowMinutes,
    startTimeUtcIso: new Date(
      quota.resetAt - quota.windowMinutes * 60_000
    ).toISOString(),
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

type AntigravityProcess = {
  pid: number;
  csrfToken: string;
};

type AntigravityLocalServer = {
  port: number;
  csrfToken: string;
};

async function findAntigravityLocalServer(): Promise<AntigravityLocalServer | null> {
  const process = await findAntigravityProcess();
  if (!process) {
    return null;
  }

  for (const port of await findListeningPorts(process.pid)) {
    const server = {
      port,
      csrfToken: process.csrfToken
    };

    try {
      await rpc(server, ANTIGRAVITY_QUOTA_SUMMARY_PATH);
      return server;
    } catch {
      // Try the next loopback listener owned by the same Antigravity process.
    }
  }

  return null;
}

async function findAntigravityProcess(): Promise<AntigravityProcess | null> {
  const entries = await fs.promises.readdir("/proc").catch(() => []);

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }

    const args = await fs.promises
      .readFile(`/proc/${entry}/cmdline`, "utf8")
      .then((value) => value.split("\0").filter(Boolean))
      .catch((): string[] => []);
    const command = args.join(" ").toLowerCase();

    if (
      !command.includes("antigravity") ||
      !/(language|extension)[_-]server/.test(command)
    ) {
      continue;
    }

    const tokenArg = args.find((arg) =>
      arg.startsWith("--csrf_token=")
    );
    const tokenIndex = args.indexOf("--csrf_token");
    const csrfToken =
      tokenArg?.slice("--csrf_token=".length) ??
      args[tokenIndex + 1];

    if (csrfToken) {
      return {
        pid: Number(entry),
        csrfToken
      };
    }
  }

  return null;
}

async function findListeningPorts(pid: number): Promise<number[]> {
  const { stdout } = await execFileAsync(
    "ss",
    ["-H", "-ltnp"],
    { encoding: "utf8", timeout: 5_000 }
  );

  return [
    ...new Set(
      stdout
        .split("\n")
        .filter((line) => line.includes(`pid=${pid},`))
        .flatMap((line) => [
          ...line.matchAll(/(?:127\.0\.0\.1|\[::1\]):(\d+)/g)
        ])
        .map((match) => Number(match[1]))
    )
  ];
}

function rpc(
  server: AntigravityLocalServer,
  endpoint: string,
  payload: unknown = {}
): Promise<any> {
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        path: endpoint,
        method: "POST",
        rejectUnauthorized: false,
        timeout: 5_000,
        headers: {
          "X-Codeium-Csrf-Token": server.csrfToken,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1"
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (!response.statusCode || response.statusCode >= 300) {
            reject(new Error(`RPC failed: ${response.statusCode ?? "unknown"}`));
            return;
          }

          try {
            resolve(responseBody ? JSON.parse(responseBody) : {});
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error(`Timed out reading Antigravity RPC ${endpoint}.`));
    });
    request.on("error", reject);
    request.end(body);
  });
}

export function parseAntigravityQuotaEntries(
  payload: unknown
): AntigravityQuotaEntry[] {
  const groups = (payload as QuotaPayload).response?.groups ?? [];

  return groups.flatMap((group) => {
    const modelIds = resolveQuotaGroupModelIds(
      `${group.displayName ?? ""} ${group.description ?? ""}`
    );

    if (!modelIds.length) {
      return [];
    }

    return (group.buckets ?? []).flatMap((bucket) => {
      const window = bucket.window
        ? QUOTA_WINDOWS[bucket.window]
        : undefined;
      const resetAt = Date.parse(bucket.resetTime ?? "");

      if (
        !bucket.bucketId ||
        window === undefined ||
        !Number.isFinite(resetAt) ||
        typeof bucket.remainingFraction !== "number" ||
        bucket.remainingFraction < 0 ||
        bucket.remainingFraction > 1
      ) {
        return [];
      }

      return [{
        limitId: bucket.bucketId,
        modelIds,
        remainingFraction: bucket.remainingFraction,
        resetAt,
        ...window
      }];
    });
  });
}


function resolveQuotaGroupModelIds(text: string): string[] {
  return (
    QUOTA_MODEL_GROUPS.find(({ pattern }) => pattern.test(text.toLowerCase()))?.models ?? []
  );
}


function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, value));
}

async function readAntigravityUsageCache(): Promise<AntigravityUsageRecord[]> {
  const sessionsRoot = path.join(
    ANTIGRAVITY_CACHE_ROOT,
    "sessions"
  );
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
