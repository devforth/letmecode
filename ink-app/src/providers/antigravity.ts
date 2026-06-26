import { execFile } from "node:child_process";
import https from "node:https";
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

const ANTIGRAVITY_PRIMARY_WINDOW_MINUTES = 5 * 60;
const ANTIGRAVITY_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const ANTIGRAVITY_QUOTA_SUMMARY_PATH =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const ANTIGRAVITY_DEBUG_LOG_PATH =
  process.env.LETMECODE_ANTIGRAVITY_DEBUG_LOG ??
  path.join(os.tmpdir(), "letmecode-antigravity-debug.jsonl");

const GEMINI_QUOTA_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash"
];

const THIRD_PARTY_QUOTA_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "gpt-oss-120b"
];

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
  planType: string;
};

export type AntigravityQuotaSnapshot = {
  entries: AntigravityQuotaEntry[];
  fetchedAt: number;
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
      options.collectUsage ??
      collectAntigravityUsageFromTokscale;
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
        "Could not synchronize Antigravity token usage through Tokscale."
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
    if (isAntigravityDebugEnabled()) {
      warnings.push(
        `Antigravity debug log: ${ANTIGRAVITY_DEBUG_LOG_PATH}`
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
        rootPath: getAntigravityCacheRoot()
      },
      modelUsage,
      dayUsage: buildDailyUsageRows(byDay),
      primaryLimitWindows: limitWindows.filter(
        (window) => window.scope === "primary"
      ),
      secondaryLimitWindows: limitWindows.filter(
        (window) => window.scope === "secondary"
      ),
      warnings
    };
  }
}

export async function collectAntigravityUsage(): Promise<
  AntigravityUsageRecord[]
> {
  return collectAntigravityUsageFromTokscale();
}

export async function collectAntigravityQuota(): Promise<AntigravityQuotaSnapshot> {
  return collectAntigravityQuotaFromLocalRpc();
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

async function collectAntigravityQuotaFromLocalRpc(): Promise<AntigravityQuotaSnapshot> {
  const server = await findAntigravityLocalServer();
  if (!server) {
    throw new Error("Antigravity local language server was not found.");
  }

  const fetchedAt = Date.now();
  const payload = await readAntigravityQuotaSummary(server);
  const entries = parseAntigravityQuotaEntries(payload);
  await writeAntigravityDebugEvent("quota-rpc-response", {
    port: server.port,
    path: ANTIGRAVITY_QUOTA_SUMMARY_PATH,
    entries: entries.map((entry) => ({
      limitId: entry.limitId,
      remainingFraction: entry.remainingFraction,
      resetAt: new Date(entry.resetAt).toISOString(),
      windowMinutes: entry.windowMinutes,
      scope: entry.scope,
      modelIds: entry.modelIds
    })),
    ...(isAntigravityRawDebugEnabled() ? { payload } : {})
  });
  return {
    entries,
    fetchedAt
  };
}

function recordsForQuotaWindow(
  quota: AntigravityQuotaEntry,
  records: AntigravityUsageRecord[]
): AntigravityUsageRecord[] {
  if (quota.modelIds.length === 0) {
    return [];
  }

  const endMs = quota.resetAt;
  const startMs = endMs - quota.windowMinutes * 60_000;
  const modelIds = new Set(quota.modelIds.map(resolveModelId));

  return records.filter((record) => {
    const modelId = resolveModelId(record.modelId);

    return (
      record.timestamp >= startMs &&
      record.timestamp < endMs &&
      modelIds.has(modelId)
    );
  });
}

function buildAntigravityLimitWindow(
  quota: AntigravityQuotaEntry,
  records: AntigravityUsageRecord[],
  fetchedAt: number
): LimitWindowRow {
  const matchingRecords = recordsForQuotaWindow(quota, records);
  const totals = sumUsageTotals(
    matchingRecords.map((record) =>
      usageRecordToTotals(
        resolveModelId(record.modelId),
        record
      )
    )
  );
  const usedPercent = clampPercent((1 - quota.remainingFraction) * 100);

  // Quota percentage is authoritative from Antigravity RPC. Token totals are
  // reconstructed from locally available Tokscale events inside the same time
  // window and may not match Antigravity's internal quota accounting exactly.
  return {
    scope: quota.scope,
    planType: quota.planType,
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

const antigravityHttpsAgent = new https.Agent({
  rejectUnauthorized: false
});

async function findAntigravityLocalServer(): Promise<AntigravityLocalServer | null> {
  const process = await findAntigravityProcess();
  if (!process) {
    await writeAntigravityDebugEvent("process-not-found", {});
    return null;
  }

  const ports = await findListeningLoopbackPorts(process.pid);
  await writeAntigravityDebugEvent("process-found", {
    pid: process.pid,
    ports
  });
  return probeAntigravityPorts(ports, process.csrfToken);
}

async function findAntigravityProcess(): Promise<AntigravityProcess | null> {
  const fromProc = await findAntigravityProcessFromProc();
  if (fromProc) {
    return fromProc;
  }

  return findAntigravityProcessFromPs();
}

async function findAntigravityProcessFromProc(): Promise<AntigravityProcess | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir("/proc", { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }

    const pid = Number(entry.name);
    const cmdline = await readProcCmdline(path.join("/proc", entry.name, "cmdline"));
    const process = parseAntigravityProcessFromArgs(pid, cmdline);
    if (process) {
      return process;
    }
  }

  return null;
}

async function readProcCmdline(filePath: string): Promise<string[]> {
  try {
    const content = await fs.promises.readFile(filePath);
    return content
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function findAntigravityProcessFromPs(): Promise<AntigravityProcess | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 5_000
    });

    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }

      const process = parseAntigravityProcessFromArgs(
        Number(match[1]),
        splitCommandLineForDiscovery(match[2])
      );
      if (process) {
        return process;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function splitCommandLineForDiscovery(value: string): string[] {
  return value.match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) =>
    part.replace(/^['"]|['"]$/g, "")
  ) ?? [];
}

function parseAntigravityProcessFromArgs(pid: number, args: string[]): AntigravityProcess | null {
  if (!Number.isInteger(pid) || pid <= 0 || !isAntigravityLanguageServerCommand(args)) {
    return null;
  }

  const csrfToken = readNamedArg(args, "--csrf_token")?.trim();
  if (!csrfToken) {
    return null;
  }

  return { pid, csrfToken };
}

function isAntigravityLanguageServerCommand(args: string[]): boolean {
  const normalized = args.join(" ").toLowerCase();
  return (
    normalized.includes("antigravity") &&
    (
      normalized.includes("language-server") ||
      normalized.includes("language_server") ||
      normalized.includes("extension-server") ||
      normalized.includes("extension_server")
    )
  );
}

function readNamedArg(args: string[], name: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      return args[index + 1] ?? null;
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }

  return null;
}

async function findListeningLoopbackPorts(pid: number): Promise<number[]> {
  const parsers: Array<() => Promise<number[]>> = [
    () => findListeningLoopbackPortsWithSs(pid),
    () => findListeningLoopbackPortsWithLsof(pid)
  ];

  for (const parse of parsers) {
    const ports = await parse();
    if (ports.length > 0) {
      return ports;
    }
  }

  return [];
}

async function findListeningLoopbackPortsWithSs(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("ss", ["-H", "-ltnp"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5_000
    });

    return uniquePorts(
      stdout
        .split(/\r?\n/)
        .filter((line) => line.includes(`pid=${pid},`) && isLoopbackListenLine(line))
        .map(extractPortFromListenLine)
    );
  } catch {
    return [];
  }
}

async function findListeningLoopbackPortsWithLsof(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-Pan", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5_000
    });

    return uniquePorts(
      stdout
        .split(/\r?\n/)
        .filter(isLoopbackListenLine)
        .map(extractPortFromListenLine)
    );
  } catch {
    return [];
  }
}

function isLoopbackListenLine(line: string): boolean {
  return /(?:127\.0\.0\.1|localhost|\[::1\]|::1):\d+\b/.test(line);
}

function extractPortFromListenLine(line: string): number | null {
  const matches = [...line.matchAll(/(?:127\.0\.0\.1|localhost|\[::1\]|::1):(\d+)/g)];
  const value = matches.at(-1)?.[1];
  const port = value ? Number(value) : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function uniquePorts(ports: Array<number | null>): number[] {
  return [...new Set(ports.filter((port): port is number => port !== null))];
}

async function probeAntigravityPorts(
  ports: number[],
  csrfToken: string
): Promise<AntigravityLocalServer | null> {
  for (const port of ports) {
    const server = { port, csrfToken };
    try {
      await readAntigravityQuotaSummary(server);
      await writeAntigravityDebugEvent("port-probe-ok", { port });
      return server;
    } catch (error) {
      await writeAntigravityDebugEvent("port-probe-failed", {
        port,
        error: error instanceof Error ? error.message : String(error)
      });
      // Try the next loopback listener owned by the same Antigravity process.
    }
  }

  return null;
}

async function readAntigravityQuotaSummary(server: AntigravityLocalServer): Promise<unknown> {
  return requestAntigravityQuotaSummary(server);
}

function requestAntigravityQuotaSummary(
  server: AntigravityLocalServer
): Promise<unknown> {
  const body = "{}";

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        path: ANTIGRAVITY_QUOTA_SUMMARY_PATH,
        method: "POST",
        timeout: 5_000,
        agent: antigravityHttpsAgent,
        headers: {
          "X-Codeium-Csrf-Token": server.csrfToken,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Unexpected Antigravity quota summary response: ${response.statusCode ?? "unknown"}`));
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
      request.destroy(new Error("Timed out reading Antigravity quota summary."));
    });
    request.on("error", reject);
    request.end(body);
  });
}

type RawQuotaSummaryBucket = {
  bucketId?: unknown;
  displayName?: unknown;
  description?: unknown;
  window?: unknown;
  remainingFraction?: unknown;
  resetTime?: unknown;
};

type RawQuotaSummaryGroup = {
  displayName?: unknown;
  description?: unknown;
  buckets?: unknown;
};

type RawQuotaSummaryResponse = {
  response?: {
    groups?: unknown;
  };
};

export function parseAntigravityQuotaEntries(payload: unknown): AntigravityQuotaEntry[] {
  const root = asRecord(payload) as RawQuotaSummaryResponse | null;
  const response = asRecord(root?.response);
  const groups = asArray(response?.groups);
  const entries: AntigravityQuotaEntry[] = [];

  for (const groupValue of groups) {
    const group = asRecord(groupValue) as RawQuotaSummaryGroup | null;
    if (!group) {
      continue;
    }

    const displayName = asString(group.displayName) ?? "";
    const description = asString(group.description) ?? "";
    const modelIds = resolveQuotaGroupModelIds(displayName, description);
    if (modelIds.length === 0) {
      void writeAntigravityDebugEvent("quota-group-skipped", {
        displayName,
        description
      });
      continue;
    }

    for (const bucketValue of asArray(group.buckets)) {
      const bucket = asRecord(bucketValue) as RawQuotaSummaryBucket | null;
      if (!bucket) {
        continue;
      }

      const bucketId = asString(bucket.bucketId);
      const windowConfig = resolveQuotaWindow(asString(bucket.window));
      const remainingFraction = asFiniteNumber(bucket.remainingFraction);
      const resetTime = asString(bucket.resetTime);
      const resetAt = resetTime === null ? NaN : Date.parse(resetTime);

      if (
        !bucketId ||
        remainingFraction === null ||
        remainingFraction < 0 ||
        remainingFraction > 1 ||
        !Number.isFinite(resetAt) ||
        !windowConfig
      ) {
        continue;
      }

      entries.push({
        limitId: bucketId,
        modelIds,
        remainingFraction,
        resetAt,
        windowMinutes: windowConfig.windowMinutes,
        scope: windowConfig.scope,
        planType: "unknown"
      });
    }
  }

  return entries;
}

function resolveQuotaWindow(
  window: string | null
): { scope: LimitWindowScope; windowMinutes: number } | null {
  switch (window) {
    case "5h":
      return {
        scope: "primary",
        windowMinutes: ANTIGRAVITY_PRIMARY_WINDOW_MINUTES
      };
    case "weekly":
      return {
        scope: "secondary",
        windowMinutes: ANTIGRAVITY_WEEKLY_WINDOW_MINUTES
      };
    default:
      return null;
  }
}

function resolveQuotaGroupModelIds(
  displayName: string,
  description: string
): string[] {
  const text = `${displayName} ${description}`.toLowerCase();

  if (text.includes("gemini")) {
    return GEMINI_QUOTA_MODELS;
  }
  if (text.includes("claude") || text.includes("gpt")) {
    return THIRD_PARTY_QUOTA_MODELS;
  }

  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAntigravityDebugEnabled(): boolean {
  const value = process.env.LETMECODE_DEBUG_ANTIGRAVITY;
  return value === "1" || value === "true" || value === "yes";
}

function isAntigravityRawDebugEnabled(): boolean {
  const value = process.env.LETMECODE_DEBUG_ANTIGRAVITY_RAW;
  return value === "1" || value === "true" || value === "yes";
}

async function writeAntigravityDebugEvent(
  event: string,
  data: Record<string, unknown>
): Promise<void> {
  if (!isAntigravityDebugEnabled()) {
    return;
  }

  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    data: redactDebugValue(data)
  });

  try {
    await fs.promises.mkdir(path.dirname(ANTIGRAVITY_DEBUG_LOG_PATH), {
      recursive: true
    });
    await fs.promises.appendFile(
      ANTIGRAVITY_DEBUG_LOG_PATH,
      `${line}\n`,
      "utf8"
    );
  } catch {
    // Debug logging must never break provider stats collection.
  }
}

function redactDebugValue(value: unknown, key = ""): unknown {
  if (isSensitiveDebugKey(key)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDebugValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      redactDebugValue(entryValue, entryKey)
    ])
  );
}

function isSensitiveDebugKey(key: string): boolean {
  return /token|csrf|authorization|cookie|email/i.test(key);
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
