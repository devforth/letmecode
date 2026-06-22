import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  UsageProviderBase,
  addUsageTotals,
  createEmptyUsageTotals,
  sumUsageTotals,
  type ModelUsageRow,
  type ProviderStats,
  type UsageTotals
} from "./contract.js";
import {
  addDailyUsage,
  buildDailyUsageRows,
  createDailyUsageAggregates,
  type DailyUsageAggregates
} from "./daily.js";
import { asRecord, numberOrZero } from "./limits.js";

const VSCODE_OTEL_SETTINGS = {
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.captureContent": false
} as const;

type CopilotUsageProviderOptions = {
  root?: string;
};

type ParseTotals = {
  filesScanned: number;
  linesRead: number;
  tokenEvents: number;
  malformedLines: number;
};

type CopilotUsageEvent = {
  timestampMs: number;
  modelId: string;
  planType: string;
  totals: UsageTotals;
};

export type CopilotVsCodeLoggingOptions = {
  root?: string;
  settingsPath?: string;
  outfile?: string;
};

export type CopilotVsCodeLoggingResult = {
  settingsPath: string;
  outfile: string;
  changed: boolean;
};

export class CopilotUsageProvider extends UsageProviderBase {
  private readonly root: string;

  constructor(options: CopilotUsageProviderOptions = {}) {
    super("copilot", "Copilot");
    this.root = path.resolve(options.root ?? os.homedir());
  }

  async getStats(): Promise<ProviderStats> {
    const sessionStateRoot = path.join(this.root, ".copilot", "session-state");
    const vscodeOtelFile = path.join(this.root, ".copilot", "otel", "vscode.jsonl");
    const byModel = new Map<string, UsageTotals>();
    const byDay = createDailyUsageAggregates();
    const planTypes = new Set<string>();
    const warnings: string[] = [];
    const parseTotals: ParseTotals = {
      filesScanned: 0,
      linesRead: 0,
      tokenEvents: 0,
      malformedLines: 0
    };

    for await (const file of walkSessionFiles(sessionStateRoot)) {
      parseTotals.filesScanned += 1;
      const fileStats = await parseCopilotJsonlFile(file, "cli", byModel, byDay, planTypes);
      addParseTotals(parseTotals, fileStats);
    }

    if (await isReadableFile(vscodeOtelFile)) {
      parseTotals.filesScanned += 1;
      const fileStats = await parseCopilotJsonlFile(vscodeOtelFile, "vscode", byModel, byDay, planTypes);
      addParseTotals(parseTotals, fileStats);
    }

    if (parseTotals.malformedLines > 0) {
      warnings.push(`Skipped ${parseTotals.malformedLines} malformed Copilot JSONL line(s).`);
    }

    if (parseTotals.filesScanned === 0) {
      warnings.push(`No Copilot usage files found under ${sessionStateRoot} or ${vscodeOtelFile}.`);
    } else if (parseTotals.tokenEvents === 0) {
      warnings.push("No Copilot token usage events found. For VS Code, run Start logging VS Code and reload VS Code.");
    }

    const modelUsage = [...byModel.entries()]
      .map<ModelUsageRow>(([modelId, totals]) => ({ modelId, totals }))
      .sort((left, right) => right.totals.estimatedCredits - left.totals.estimatedCredits);

    return {
      providerId: this.id,
      providerLabel: this.label,
      summary: {
        filesScanned: parseTotals.filesScanned,
        linesRead: parseTotals.linesRead,
        tokenEvents: parseTotals.tokenEvents,
        totals: sumUsageTotals(modelUsage.map((row) => row.totals)),
        distinctModels: modelUsage.map((row) => row.modelId),
        distinctPlanTypes: [...planTypes].sort(),
        rootLabel: "~/.copilot",
        rootPath: path.join(this.root, ".copilot")
      },
      modelUsage,
      dayUsage: buildDailyUsageRows(byDay),
      primaryLimitWindows: [],
      secondaryLimitWindows: [],
      warnings
    };
  }
}

export async function configureCopilotVsCodeLogging(
  options: CopilotVsCodeLoggingOptions = {}
): Promise<CopilotVsCodeLoggingResult> {
  const root = path.resolve(options.root ?? os.homedir());
  const outfile = options.outfile ?? path.join(root, ".copilot", "otel", "vscode.jsonl");
  const settingsPath = options.settingsPath ?? getDefaultVsCodeSettingsPath(root);
  const settings = await readJsonSettings(settingsPath);
  const nextSettings = {
    ...settings,
    ...VSCODE_OTEL_SETTINGS,
    "github.copilot.chat.otel.outfile": outfile
  };
  const changed = JSON.stringify(settings) !== JSON.stringify(nextSettings);

  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(outfile), { recursive: true });
  await fs.promises.writeFile(settingsPath, `${JSON.stringify(nextSettings, null, 4)}\n`, "utf8");

  return { settingsPath, outfile, changed };
}

function addParseTotals(target: ParseTotals, source: ParseTotals): void {
  target.linesRead += source.linesRead;
  target.tokenEvents += source.tokenEvents;
  target.malformedLines += source.malformedLines;
}

async function parseCopilotJsonlFile(
  filePath: string,
  fallbackPlanType: string,
  byModel: Map<string, UsageTotals>,
  byDay: DailyUsageAggregates,
  planTypes: Set<string>
): Promise<ParseTotals> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const parseTotals: ParseTotals = {
    filesScanned: 0,
    linesRead: 0,
    tokenEvents: 0,
    malformedLines: 0
  };

  for await (const line of lineReader) {
    parseTotals.linesRead += 1;
    if (!line.trim()) {
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      parseTotals.malformedLines += 1;
      continue;
    }

    const events = extractCopilotUsageEvents(payload, fallbackPlanType);
    for (const event of events) {
      parseTotals.tokenEvents += 1;
      addModelUsage(byModel, event.modelId, event.totals);
      planTypes.add(event.planType);
      addDailyUsage(byDay, event.timestampMs, event.modelId, event.planType, event.totals);
    }
  }

  return parseTotals;
}

function extractCopilotUsageEvents(payload: unknown, fallbackPlanType: string): CopilotUsageEvent[] {
  const record = asRecord(payload);
  if (!record) {
    return [];
  }

  if (record.type === "session.shutdown") {
    return extractShutdownUsageEvents(record, fallbackPlanType);
  }

  return extractOtelUsageEvents(record, fallbackPlanType);
}

function extractShutdownUsageEvents(record: Record<string, unknown>, fallbackPlanType: string): CopilotUsageEvent[] {
  const data = asRecord(record.data);
  const modelMetrics = asRecord(data?.modelMetrics);
  if (!data || !modelMetrics) {
    return [];
  }

  const timestampMs = parseTimestamp(record.timestamp) ?? parseTimestamp(data.sessionStartTime) ?? 0;
  return Object.entries(modelMetrics)
    .map<CopilotUsageEvent | null>(([modelId, rawMetrics]) => {
      const metrics = asRecord(rawMetrics);
      const usage = asRecord(metrics?.usage);
      if (!metrics || !usage) {
        return null;
      }

      const inputTokens = numberOrZero(usage.inputTokens);
      const cachedInputTokens = Math.min(inputTokens, numberOrZero(usage.cacheReadTokens));
      const outputTokens = numberOrZero(usage.outputTokens);
      const reasoningOutputTokens = numberOrZero(usage.reasoningTokens);
      if (inputTokens <= 0 && outputTokens <= 0 && reasoningOutputTokens <= 0) {
        return null;
      }

      return {
        timestampMs,
        modelId: modelId || String(data.currentModel ?? "unknown"),
        planType: fallbackPlanType,
        totals: createUsageTotals({
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningOutputTokens,
          estimatedCredits: numberOrZero(asRecord(metrics.requests)?.cost)
        })
      };
    })
    .filter((event): event is CopilotUsageEvent => event !== null);
}

function extractOtelUsageEvents(record: Record<string, unknown>, fallbackPlanType: string): CopilotUsageEvent[] {
  const events: CopilotUsageEvent[] = [];
  visitRecords(record, (candidate) => {
    const attributes = normalizeAttributes(candidate.attributes);
    const usage = usageFromAttributes(attributes);
    if (!usage) {
      return;
    }

    const modelId =
      stringAttribute(attributes, [
        "gen_ai.response.model",
        "gen_ai.request.model",
        "model",
        "model_id",
        "chat.model"
      ]) ?? "unknown";
    const timestampMs =
      parseTimestamp(candidate.timeUnixNano) ??
      parseTimestamp(candidate.observedTimeUnixNano) ??
      parseTimestamp(candidate.timestamp) ??
      0;

    events.push({
      timestampMs,
      modelId,
      planType: fallbackPlanType,
      totals: usage
    });
  });

  return events;
}

function visitRecords(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  const record = asRecord(value);
  if (record) {
    if (record.attributes) {
      visit(record);
    }

    for (const child of Object.values(record)) {
      visitRecords(child, visit);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const child of value) {
      visitRecords(child, visit);
    }
  }
}

function usageFromAttributes(attributes: Record<string, unknown>): UsageTotals | null {
  const inputTokens = numberAttribute(attributes, [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.prompt_tokens",
    "input_tokens",
    "inputTokens",
    "prompt_tokens"
  ]);
  const outputTokens = numberAttribute(attributes, [
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.completion_tokens",
    "output_tokens",
    "outputTokens",
    "completion_tokens"
  ]);
  const reasoningOutputTokens = numberAttribute(attributes, [
    "gen_ai.usage.reasoning_tokens",
    "reasoning_tokens",
    "reasoningTokens"
  ]);
  const cachedInputTokens = Math.min(
    inputTokens,
    numberAttribute(attributes, [
      "gen_ai.usage.cached_input_tokens",
      "gen_ai.usage.cache_read_input_tokens",
      "cached_input_tokens",
      "cache_read_tokens",
      "cachedInputTokens"
    ])
  );

  if (inputTokens <= 0 && outputTokens <= 0 && reasoningOutputTokens <= 0) {
    return null;
  }

  return createUsageTotals({
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    estimatedCredits: numberAttribute(attributes, [
      "gen_ai.usage.premium_requests",
      "premium_requests",
      "request_cost",
      "cost"
    ])
  });
}

function createUsageTotals(usage: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  estimatedCredits: number;
}): UsageTotals {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    nonCachedInputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    estimatedCredits: usage.estimatedCredits,
    eventCount: 1
  };
}

function addModelUsage(byModel: Map<string, UsageTotals>, modelId: string, deltaTotals: UsageTotals): void {
  const resolvedModelId = modelId || "unknown";
  const totals = byModel.get(resolvedModelId) ?? createEmptyUsageTotals();
  addUsageTotals(totals, deltaTotals);
  byModel.set(resolvedModelId, totals);
}

function normalizeAttributes(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((entry) => {
          const record = asRecord(entry);
          const key = typeof record?.key === "string" ? record.key : undefined;
          return key && record ? [key, unwrapOtelValue(record.value)] : undefined;
        })
        .filter((entry): entry is [string, unknown] => Array.isArray(entry))
    );
  }

  return asRecord(value) ?? {};
}

function unwrapOtelValue(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) {
    return value;
  }

  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
    if (key in record) {
      return record[key];
    }
  }

  return value;
}

function numberAttribute(attributes: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return 0;
}

function stringAttribute(attributes: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }

  return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000_000 ? Math.floor(value / 1_000_000) : value;
  }

  if (typeof value !== "string" || !value) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return value.length > 13 ? Math.floor(numericValue / 1_000_000) : numericValue;
    }
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function* walkSessionFiles(directory: string): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkSessionFiles(fullPath);
    } else if (entry.isFile() && entry.name === "events.jsonl") {
      yield fullPath;
    }
  }
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readJsonSettings(filePath: string): Promise<Record<string, unknown>> {
  let raw = "";
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }

  if (!raw.trim()) {
    return {};
  }

  const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
  return asRecord(parsed) ?? {};
}

function stripJsonComments(value: string): string {
  return value
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,\s*([}\]])/g, "$1");
}

function getDefaultVsCodeSettingsPath(root: string): string {
  if (process.platform === "darwin") {
    return path.join(root, "Library", "Application Support", "Code", "User", "settings.json");
  }

  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(root, "AppData", "Roaming"), "Code", "User", "settings.json");
  }

  return path.join(root, ".config", "Code", "User", "settings.json");
}
