import fs from "node:fs";
import { applyEdits, modify, parse } from "jsonc-parser";
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
import { asRecord } from "./limits.js";

const VSCODE_OTEL_SETTINGS = {
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.captureContent": false
} as const;

type Rate = { input: number; cachedInput: number; cacheWrite?: number; output: number };

type LongContextRate = Rate & { thresholdInputTokens: number };

const RATE_CARD: Record<string, Rate> = {
  "gpt-5-mini": { input: 25, cachedInput: 2.5, output: 200 },
  "gpt-5.3-codex": { input: 175, cachedInput: 17.5, output: 1400 },
  "gpt-5.4": { input: 250, cachedInput: 25, output: 1500 },
  "gpt-5.4-mini": { input: 75, cachedInput: 7.5, output: 450 },
  "gpt-5.4-nano": { input: 20, cachedInput: 2, output: 125 },
  "gpt-5.5": { input: 500, cachedInput: 50, output: 3000 },
  "claude-haiku-4-5": { input: 100, cachedInput: 10, cacheWrite: 125, output: 500 },
  "claude-sonnet-4-5": { input: 300, cachedInput: 30, cacheWrite: 375, output: 1500 },
  "claude-sonnet-4-6": { input: 300, cachedInput: 30, cacheWrite: 375, output: 1500 },
  "claude-opus-4-5": { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500 },
  "claude-opus-4-6": { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500 },
  "claude-opus-4-7": { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500 },
  "claude-opus-4-8": { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500 },
  "claude-fable-5": { input: 1000, cachedInput: 100, cacheWrite: 1250, output: 5000 },
  "gemini-2.5-pro": { input: 125, cachedInput: 12.5, output: 1000 },
  "gemini-3-flash": { input: 50, cachedInput: 5, output: 300 },
  "gemini-3.1-pro": { input: 200, cachedInput: 20, output: 1200 },
  "gemini-3.5-flash": { input: 150, cachedInput: 15, output: 900 },
  "mai-code-1-flash": { input: 75, cachedInput: 7.5, output: 450 },
  "raptor-mini": { input: 25, cachedInput: 2.5, output: 200 }
};

const LONG_CONTEXT_RATE_CARD: Record<string, LongContextRate> = {
  "gpt-5.4": { thresholdInputTokens: 272_000, input: 500, cachedInput: 50, output: 2250 },
  "gpt-5.5": { thresholdInputTokens: 272_000, input: 1000, cachedInput: 100, output: 4500 },
  "gemini-3.1-pro": { thresholdInputTokens: 200_000, input: 400, cachedInput: 40, output: 1800 }
};

const NON_BILLABLE_MODEL_PREFIXES = ["copilot-nes", "copilot-suggestion"] as const;

type CopilotUsageProviderOptions = {
  root?: string;
};

type ParseTotals = {
  linesRead: number;
  tokenEvents: number;
  malformedLines: number;
};

type CopilotUsageEvent = {
  timestampMs: number;
  modelId: string;
  totals: UsageTotals;
};

type CopilotRawUsage = {
  inputTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
};

export type CopilotVsCodeLoggingOptions = {
  root?: string;
  settingsPath?: string;
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
    const vscodeOtelFile = getCopilotOtelPath(this.root);
    const byModel = new Map<string, UsageTotals>();
    const byDay = createDailyUsageAggregates();
    const warnings: string[] = [];
    const parseTotals: ParseTotals = {
      linesRead: 0,
      tokenEvents: 0,
      malformedLines: 0
    };

    const vscodeOtelFileExists = await isReadableFile(vscodeOtelFile);
    if (vscodeOtelFileExists) {
      const fileStats = await parseCopilotJsonlFile(vscodeOtelFile, byModel, byDay);
      parseTotals.linesRead += fileStats.linesRead;
      parseTotals.tokenEvents += fileStats.tokenEvents;
      parseTotals.malformedLines += fileStats.malformedLines;
    } else if (await isCopilotVsCodeLoggingEnabled(this.root, vscodeOtelFile)) {
      warnings.push(
        `VS Code Copilot logging is enabled, but ${vscodeOtelFile} has not been created yet. Reload VS Code and send a Copilot Chat request.`
      );
    }

    if (parseTotals.malformedLines > 0) {
      warnings.push(`Skipped ${parseTotals.malformedLines} malformed Copilot JSONL line(s).`);
    }

    const filesScanned = vscodeOtelFileExists ? 1 : 0;
    if (filesScanned === 0) {
      warnings.push(`No Copilot VS Code OTEL usage file found at ${vscodeOtelFile}.`);
    } else if (parseTotals.tokenEvents === 0) {
      warnings.push("No Copilot token usage events found. For VS Code, run Start logging VS Code and reload VS Code.");
    }

    const modelUsage = [...byModel.entries()]
      .map<ModelUsageRow>(([modelId, totals]) => ({ modelId, totals }))
      .sort((left, right) => right.totals.estimatedCredits - left.totals.estimatedCredits);
    const summaryTotals = sumUsageTotals(modelUsage.map((row) => row.totals));

    if (summaryTotals.cacheStatus === "unavailable") {
      warnings.push(
        "Copilot cache token attributes are unavailable for some events; cached/non-cached tokens and estimated credits are shown as unknown."
      );
    }

    return {
      providerId: this.id,
      providerLabel: this.label,
      summary: {
        filesScanned,
        linesRead: parseTotals.linesRead,
        tokenEvents: parseTotals.tokenEvents,
        totals: summaryTotals,
        distinctModels: modelUsage.map((row) => row.modelId),
        distinctPlanTypes: [],
        rootLabel: "~/.copilot/otel/vscode.jsonl",
        rootPath: vscodeOtelFile
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
  const outfile = getCopilotOtelPath(root);
  const settingsPath = options.settingsPath ?? (await getVsCodeSettingsPath(root));
  const settingsText = await readTextFileOrEmpty(settingsPath);
  const { text, changed } = updateJsoncSettings(settingsText, {
    ...VSCODE_OTEL_SETTINGS,
    "github.copilot.chat.otel.outfile": toVsCodeOutfilePath(outfile)
  });

  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(outfile), { recursive: true });
  if (changed) {
    await fs.promises.writeFile(settingsPath, text, "utf8");
  }

  return { settingsPath, outfile, changed };
}

function getCopilotOtelPath(root: string): string {
  return path.join(root, ".copilot", "otel", "vscode.jsonl");
}

function toVsCodeOutfilePath(filePath: string): string {
  return process.platform === "win32" ? filePath.replace(/\\/g, "/") : filePath;
}

async function getVsCodeSettingsPath(root: string): Promise<string> {
  const userRoots = getVsCodeUserRoots(root);
  for (const userRoot of userRoots) {
    if (await isDirectory(userRoot)) {
      return path.join(userRoot, "settings.json");
    }
  }

  return path.join(userRoots[0], "settings.json");
}

function getVsCodeUserRoots(root: string): string[] {
  if (process.platform === "darwin") {
    const applicationSupport = path.join(root, "Library", "Application Support");
    return [
      path.join(applicationSupport, "Code", "User"),
      path.join(applicationSupport, "Code - Insiders", "User")
    ];
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(root, "AppData", "Roaming");
    return [path.join(appData, "Code", "User"), path.join(appData, "Code - Insiders", "User")];
  }

  const configRoot = path.join(root, ".config");
  return [path.join(configRoot, "Code", "User"), path.join(configRoot, "Code - Insiders", "User")];
}

async function parseCopilotJsonlFile(
  filePath: string,
  byModel: Map<string, UsageTotals>,
  byDay: DailyUsageAggregates
): Promise<ParseTotals> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const parseTotals: ParseTotals = {
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

    const event = extractCopilotUsageEvent(payload);
    if (event) {
      parseTotals.tokenEvents += 1;
      addModelUsage(byModel, event.modelId, event.totals);
      addDailyUsage(byDay, event.timestampMs, event.modelId, undefined, event.totals);
    }
  }

  return parseTotals;
}

function extractCopilotUsageEvent(payload: unknown): CopilotUsageEvent | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const attributes = asRecord(record.attributes);
  if (!attributes || !isCopilotChatSpan(attributes)) {
    return null;
  }

  const usage = usageFromAttributes(attributes);
  if (!usage) {
    return null;
  }

  const modelId = stringAttribute(attributes, "gen_ai.response.model") ?? "unknown";
  const timestampMs = hrTimeToMs(record.hrTime) ?? Number.NaN;

  return {
    timestampMs,
    modelId,
    totals: createUsageTotals(modelId, usage)
  };
}

function usageFromAttributes(attributes: Record<string, unknown>): CopilotRawUsage | null {
  const inputTokens = numberAttribute(attributes, "gen_ai.usage.input_tokens") ?? 0;
  const outputTokens = numberAttribute(attributes, "gen_ai.usage.output_tokens") ?? 0;
  const reasoningOutputTokens = numberAttribute(attributes, "gen_ai.usage.reasoning.output_tokens");
  const cachedInputTokens = numberAttribute(attributes, "gen_ai.usage.cache_read.input_tokens");
  const cacheCreationInputTokens = numberAttribute(attributes, "gen_ai.usage.cache_creation.input_tokens");

  if (inputTokens <= 0 && outputTokens <= 0 && (reasoningOutputTokens ?? 0) <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens
  };
}

function isCopilotChatSpan(attributes: Record<string, unknown>): boolean {
  return stringAttribute(attributes, "gen_ai.operation.name") === "chat";
}

function createUsageTotals(modelId: string, usage: CopilotRawUsage): UsageTotals {
  const hasCacheInfo = usage.cachedInputTokens !== undefined || usage.cacheCreationInputTokens !== undefined;
  const hasKnownCreditPricing = isNonBillableModel(modelId) || (hasCacheInfo && rateForModel(modelId, usage.inputTokens) !== undefined);
  const cachedInputTokens = hasCacheInfo ? Math.max(0, usage.cachedInputTokens ?? 0) : 0;
  const cacheWriteInputTokens = hasCacheInfo ? Math.max(0, usage.cacheCreationInputTokens ?? 0) : 0;
  const uncachedInputTokens = hasCacheInfo
    ? Math.max(0, usage.inputTokens - cachedInputTokens - cacheWriteInputTokens)
    : 0;
  return {
    inputTotalTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: Math.min(usage.reasoningOutputTokens ?? 0, usage.outputTokens),
    totalTokens: usage.inputTokens + usage.outputTokens,
    estimatedCredits: creditsFor(modelId, usage),
    eventCount: 1,
    tokenBreakdown: {
      schema: "openai",
      nonCachedInputTokens: uncachedInputTokens,
      cachedInputTokens,
      outputTokens: usage.outputTokens
    },
    cacheStatus: hasCacheInfo ? "known" : "unavailable",
    estimatedCreditsStatus: hasKnownCreditPricing ? "known" : "unavailable"
  };
}

function creditsFor(modelId: string, usage: CopilotRawUsage): number {
  if (isNonBillableModel(modelId)) {
    return 0;
  }

  const rate = rateForModel(modelId, usage.inputTokens);
  if (!rate) {
    return 0;
  }

  if (usage.cachedInputTokens === undefined && usage.cacheCreationInputTokens === undefined) {
    return 0;
  }

  const cacheRead = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const cacheWrite = Math.min(usage.cacheCreationInputTokens ?? 0, Math.max(0, usage.inputTokens - cacheRead));
  const regularInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  return (
    (regularInput / 1_000_000) * rate.input +
    (cacheRead / 1_000_000) * rate.cachedInput +
    (cacheWrite / 1_000_000) * (rate.cacheWrite ?? rate.input) +
    (usage.outputTokens / 1_000_000) * rate.output
  );
}

function rateForModel(modelId: string, inputTokens: number): Rate | undefined {
  const candidates = Object.keys(RATE_CARD).sort((left, right) => right.length - left.length);
  const model = candidates.find((candidate) => modelId === candidate || modelId.startsWith(`${candidate}-`));
  if (!model) {
    return undefined;
  }

  const longContextRate = LONG_CONTEXT_RATE_CARD[model];
  if (longContextRate && inputTokens > longContextRate.thresholdInputTokens) {
    return longContextRate;
  }

  return RATE_CARD[model];
}

function isNonBillableModel(modelId: string): boolean {
  return NON_BILLABLE_MODEL_PREFIXES.some((prefix) => modelId === prefix || modelId.startsWith(`${prefix}-`));
}

function addModelUsage(byModel: Map<string, UsageTotals>, modelId: string, deltaTotals: UsageTotals): void {
  const resolvedModelId = modelId || "unknown";
  const totals = byModel.get(resolvedModelId) ?? createEmptyUsageTotals("openai");
  addUsageTotals(totals, deltaTotals);
  byModel.set(resolvedModelId, totals);
}

function numberAttribute(attributes: Record<string, unknown>, key: string): number | undefined {
  const value = attributes[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return undefined;
}

function stringAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  if (typeof value === "string" && value) {
    return value;
  }

  return undefined;
}

function hrTimeToMs(value: unknown): number | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const [seconds, nanoseconds] = value;
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    typeof nanoseconds !== "number" ||
    !Number.isFinite(nanoseconds)
  ) {
    return undefined;
  }

  return seconds * 1000 + nanoseconds / 1_000_000;
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isCopilotVsCodeLoggingEnabled(root: string, outfile: string): Promise<boolean> {
  const settings = await readJsonSettings(await getVsCodeSettingsPath(root));
  const configuredOutfile = settings["github.copilot.chat.otel.outfile"];
  return (
    settings["github.copilot.chat.otel.enabled"] === true &&
    settings["github.copilot.chat.otel.exporterType"] === "file" &&
    typeof configuredOutfile === "string" &&
    normalizeComparablePath(configuredOutfile) === normalizeComparablePath(toVsCodeOutfilePath(outfile))
  );
}

function normalizeComparablePath(filePath: string): string {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function readJsonSettings(filePath: string): Promise<Record<string, unknown>> {
  return parseJsoncSettings(await readTextFileOrEmpty(filePath));
}

async function readTextFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function parseJsoncSettings(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }

  const parsed = parse(raw) as unknown;
  return asRecord(parsed) ?? {};
}

function updateJsoncSettings(raw: string, values: Record<string, unknown>): { text: string; changed: boolean } {
  let text = raw.trim() ? raw : "{\n}";
  let changed = false;
  for (const [key, value] of Object.entries(values)) {
    if (parseJsoncSettings(text)[key] === value) {
      continue;
    }

    const edits = modify(text, [key], value, {
      formattingOptions: {
        eol: "\n",
        insertSpaces: true,
        tabSize: 4
      }
    });
    if (edits.length > 0) {
      text = applyEdits(text, edits);
      changed = true;
    }
  }

  if (changed && !text.endsWith("\n")) {
    text += "\n";
  }

  return { text, changed };
}
