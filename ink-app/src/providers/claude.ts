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
  applyRateLimits,
  asRecord,
  buildWindowLists,
  createLimitWindowAggregates,
  numberOrZero,
  type LimitWindowAggregates
} from "./limits.js";

type ClaudeRate = {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
};

const RATE_CARD: Record<string, ClaudeRate> = {
  "claude-opus-4-8": { input: 500, cacheWrite5m: 625, cacheWrite1h: 1000, cacheRead: 50, output: 2500 },
  "claude-opus-4-7": { input: 500, cacheWrite5m: 625, cacheWrite1h: 1000, cacheRead: 50, output: 2500 },
  "claude-opus-4-6": { input: 500, cacheWrite5m: 625, cacheWrite1h: 1000, cacheRead: 50, output: 2500 },
  "claude-opus-4-5": { input: 500, cacheWrite5m: 625, cacheWrite1h: 1000, cacheRead: 50, output: 2500 },
  "claude-opus-4-1": { input: 1500, cacheWrite5m: 1875, cacheWrite1h: 3000, cacheRead: 150, output: 7500 },
  "claude-opus-4": { input: 1500, cacheWrite5m: 1875, cacheWrite1h: 3000, cacheRead: 150, output: 7500 },
  "claude-sonnet-4-6": { input: 300, cacheWrite5m: 375, cacheWrite1h: 600, cacheRead: 30, output: 1500 },
  "claude-sonnet-4-5": { input: 300, cacheWrite5m: 375, cacheWrite1h: 600, cacheRead: 30, output: 1500 },
  "claude-sonnet-4": { input: 300, cacheWrite5m: 375, cacheWrite1h: 600, cacheRead: 30, output: 1500 },
  "claude-haiku-4-5": { input: 100, cacheWrite5m: 125, cacheWrite1h: 200, cacheRead: 10, output: 500 },
  "claude-haiku-3-5": { input: 80, cacheWrite5m: 100, cacheWrite1h: 160, cacheRead: 8, output: 400 }
};

type ClaudeUsage = {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
  outputTokens: number;
  inferenceGeo: string;
};

type ParseTotals = {
  filesScanned: number;
  linesRead: number;
  tokenEvents: number;
  malformedLines: number;
};

type ClaudeUsageProviderOptions = {
  root?: string;
};

export class ClaudeUsageProvider extends UsageProviderBase {
  private readonly root: string;

  constructor(options: ClaudeUsageProviderOptions = {}) {
    super("claude", "Claude");
    this.root = path.resolve(options.root ?? os.homedir());
  }

  async getStats(): Promise<ProviderStats> {
    const sessionsRoot = path.join(this.root, ".claude", "projects");
    const byModel = new Map<string, UsageTotals>();
    const windows = createLimitWindowAggregates();
    const planTypes = new Set<string>();
    const warnings: string[] = [];
    const seenUsageEvents = new Set<string>();
    const parseTotals: ParseTotals = {
      filesScanned: 0,
      linesRead: 0,
      tokenEvents: 0,
      malformedLines: 0
    };

    for await (const file of walkSessionFiles(sessionsRoot)) {
      parseTotals.filesScanned += 1;
      const fileStats = await parseSessionFile(file, byModel, windows, planTypes, seenUsageEvents);
      parseTotals.linesRead += fileStats.linesRead;
      parseTotals.tokenEvents += fileStats.tokenEvents;
      parseTotals.malformedLines += fileStats.malformedLines;
    }

    if (parseTotals.malformedLines > 0) {
      warnings.push(`Skipped ${parseTotals.malformedLines} malformed JSONL line(s).`);
    }

    const modelUsage = [...byModel.entries()]
      .map<ModelUsageRow>(([modelId, totals]) => ({ modelId, totals }))
      .sort((left, right) => right.totals.estimatedCredits - left.totals.estimatedCredits);

    const unknownPricedModels = modelUsage
      .map((row) => row.modelId)
      .filter((modelId) => !resolveRate(modelId));
    if (unknownPricedModels.length > 0) {
      warnings.push(`No credit rate configured for: ${unknownPricedModels.join(", ")}.`);
    }

    if (parseTotals.filesScanned === 0) {
      warnings.push(`No Claude session files found under ${sessionsRoot}.`);
    }

    const summaryTotals = sumUsageTotals(modelUsage.map((row) => row.totals));
    const [primaryLimitWindows, secondaryLimitWindows] = buildWindowLists(windows);

    if (
      parseTotals.filesScanned > 0 &&
      parseTotals.tokenEvents > 0 &&
      primaryLimitWindows.length === 0 &&
      secondaryLimitWindows.length === 0
    ) {
      warnings.push("Claude transcripts did not expose rate-limit windows in the local logs.");
    }

    return {
      providerId: this.id,
      providerLabel: this.label,
      summary: {
        filesScanned: parseTotals.filesScanned,
        linesRead: parseTotals.linesRead,
        tokenEvents: parseTotals.tokenEvents,
        totals: summaryTotals,
        distinctModels: modelUsage.map((row) => row.modelId),
        distinctPlanTypes: [...planTypes].sort(),
        rootLabel: "~/.claude/projects",
        rootPath: sessionsRoot
      },
      modelUsage,
      primaryLimitWindows,
      secondaryLimitWindows,
      warnings
    };
  }
}

function normalizeUsage(value: unknown): ClaudeUsage {
  const usage = asRecord(value) ?? {};
  const cacheCreation = asRecord(usage.cache_creation);
  const cacheCreation5mInputTokens = numberOrZero(cacheCreation?.ephemeral_5m_input_tokens);
  const cacheCreation1hInputTokens = numberOrZero(cacheCreation?.ephemeral_1h_input_tokens);
  const cacheCreationInputTokens = Math.max(
    numberOrZero(usage.cache_creation_input_tokens),
    cacheCreation5mInputTokens + cacheCreation1hInputTokens
  );

  return {
    inputTokens: numberOrZero(usage.input_tokens),
    cacheReadInputTokens: numberOrZero(usage.cache_read_input_tokens),
    cacheCreationInputTokens,
    cacheCreation5mInputTokens,
    cacheCreation1hInputTokens,
    outputTokens: numberOrZero(usage.output_tokens),
    inferenceGeo: String(usage.inference_geo ?? "")
  };
}

function resolveRate(modelId: string): ClaudeRate | undefined {
  const candidates = Object.keys(RATE_CARD).sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    if (modelId === candidate || modelId.startsWith(`${candidate}-`)) {
      return RATE_CARD[candidate];
    }
  }

  return undefined;
}

function creditsFor(modelId: string, usage: ClaudeUsage): number {
  const rate = resolveRate(modelId);
  if (!rate) {
    return 0;
  }

  const cacheWriteKnownTokens = usage.cacheCreation5mInputTokens + usage.cacheCreation1hInputTokens;
  const cacheWriteFallbackTokens = Math.max(0, usage.cacheCreationInputTokens - cacheWriteKnownTokens);
  const inferenceMultiplier = usage.inferenceGeo === "us" ? 1.1 : 1;

  return (
    ((usage.inputTokens / 1_000_000) * rate.input +
      (usage.cacheReadInputTokens / 1_000_000) * rate.cacheRead +
      (usage.cacheCreation5mInputTokens / 1_000_000) * rate.cacheWrite5m +
      (usage.cacheCreation1hInputTokens / 1_000_000) * rate.cacheWrite1h +
      (cacheWriteFallbackTokens / 1_000_000) * rate.cacheWrite5m +
      (usage.outputTokens / 1_000_000) * rate.output) *
    inferenceMultiplier
  );
}

function usageToTotals(modelId: string, usage: ClaudeUsage): UsageTotals {
  const nonCachedInputTokens = usage.inputTokens + usage.cacheCreationInputTokens;
  const cachedInputTokens = usage.cacheReadInputTokens;

  return {
    inputTokens: nonCachedInputTokens + cachedInputTokens,
    cachedInputTokens,
    nonCachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: nonCachedInputTokens + cachedInputTokens + usage.outputTokens,
    estimatedCredits: creditsFor(modelId, usage),
    eventCount: 1
  };
}

function addModelUsage(byModel: Map<string, UsageTotals>, modelId: string, deltaTotals: UsageTotals): void {
  const resolvedModelId = modelId || "unknown";
  const totals = byModel.get(resolvedModelId) ?? createEmptyUsageTotals();
  addUsageTotals(totals, deltaTotals);
  byModel.set(resolvedModelId, totals);
}

function isSessionFile(filePath: string): boolean {
  return filePath.endsWith(".jsonl") && filePath.includes(`${path.sep}.claude${path.sep}projects${path.sep}`);
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
    } else if (entry.isFile() && isSessionFile(fullPath)) {
      yield fullPath;
    }
  }
}

async function parseSessionFile(
  filePath: string,
  byModel: Map<string, UsageTotals>,
  windows: LimitWindowAggregates,
  planTypes: Set<string>,
  seenUsageEvents: Set<string>
): Promise<{ linesRead: number; tokenEvents: number; malformedLines: number }> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let linesRead = 0;
  let tokenEvents = 0;
  let malformedLines = 0;

  for await (const line of lineReader) {
    linesRead += 1;
    if (!line.trim()) {
      continue;
    }

    let payloadObject: Record<string, unknown>;
    try {
      payloadObject = JSON.parse(line) as Record<string, unknown>;
    } catch {
      malformedLines += 1;
      continue;
    }

    if (payloadObject.type !== "assistant") {
      continue;
    }

    const message = asRecord(payloadObject.message);
    const usage = asRecord(message?.usage);
    if (!usage) {
      continue;
    }

    const usageKey = buildUsageEventKey(payloadObject, message);
    if (usageKey && seenUsageEvents.has(usageKey)) {
      continue;
    }

    if (usageKey) {
      seenUsageEvents.add(usageKey);
    }

    const modelId = String(message?.model ?? "unknown");
    const deltaTotals = usageToTotals(modelId, normalizeUsage(usage));
    addModelUsage(byModel, modelId, deltaTotals);
    tokenEvents += 1;

    const eventTimeMs = Date.parse(String(payloadObject.timestamp ?? ""));
    const safeEventTimeMs = Number.isFinite(eventTimeMs) ? eventTimeMs : 0;
    applyRateLimits(windows, extractRateLimits(payloadObject, message), safeEventTimeMs, deltaTotals, planTypes);
  }

  return { linesRead, tokenEvents, malformedLines };
}

function buildUsageEventKey(payloadObject: Record<string, unknown>, message: Record<string, unknown> | null): string | null {
  const sessionId = String(payloadObject.sessionId ?? "");
  const requestId = typeof payloadObject.requestId === "string" ? payloadObject.requestId : "";
  const messageId = typeof message?.id === "string" ? message.id : "";

  if (!requestId && !messageId) {
    return null;
  }

  return `${sessionId}|${requestId || messageId}`;
}

function extractRateLimits(
  payloadObject: Record<string, unknown>,
  message: Record<string, unknown> | null
): Record<string, unknown> | null {
  return asRecord(payloadObject.rate_limits) ?? asRecord(message?.rate_limits);
}
