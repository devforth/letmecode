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
import {
  addDailyUsage,
  buildDailyUsageRows,
  createDailyUsageAggregates,
  type DailyUsageAggregates
} from "./daily.js";

type ClaudeRate = {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
};

const RATE_CARD: Record<string, ClaudeRate> = {
  "claude-opus-4-8": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-opus-4-7": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-opus-4-6": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-opus-4-5": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-opus-4-1": { input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5, output: 75 },
  "claude-opus-4": { input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5, output: 75 },
  "claude-sonnet-4-6": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4-5": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
  "claude-haiku-3-5": { input: 0.8, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08, output: 4 }
};

const USD_TO_CREDITS = 100;

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

type ParsedUsageEvent = {
  usageKey: string | null;
  usageSignature: string;
  timestampMs: number;
  modelId: string;
  totals: UsageTotals;
  rateLimits: Record<string, unknown> | null;
};

type ParsedUsageEventAccumulator = {
  keyedEvents: Map<string, ParsedUsageEvent>;
  unkeyedEvents: Map<string, ParsedUsageEvent>;
  duplicateUsageKeys: number;
  duplicateUsageKeyCollisions: number;
  duplicateUnkeyedEvents: number;
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
    const byDay = createDailyUsageAggregates();
    const windows = createLimitWindowAggregates();
    const planTypes = new Set<string>();
    const warnings: string[] = [];
    const parsedEvents = createParsedUsageEventAccumulator();
    const parseTotals: ParseTotals = {
      filesScanned: 0,
      linesRead: 0,
      tokenEvents: 0,
      malformedLines: 0
    };

    for await (const file of walkSessionFiles(sessionsRoot)) {
      parseTotals.filesScanned += 1;
      const fileStats = await parseSessionFile(file, parsedEvents);
      parseTotals.linesRead += fileStats.linesRead;
      parseTotals.malformedLines += fileStats.malformedLines;
    }

    const selectedEvents = [
      ...parsedEvents.keyedEvents.values(),
      ...parsedEvents.unkeyedEvents.values()
    ];

    for (const event of selectedEvents) {
      addModelUsage(byModel, event.modelId, event.totals);
      const planType = typeof event.rateLimits?.plan_type === "string" ? event.rateLimits.plan_type : undefined;
      const safeEventTimeMs = Number.isFinite(event.timestampMs) ? event.timestampMs : 0;

      addDailyUsage(byDay, event.timestampMs, event.modelId, planType, event.totals);
      applyRateLimits(windows, event.rateLimits, safeEventTimeMs, event.totals, planTypes);
    }

    parseTotals.tokenEvents = selectedEvents.length;

    if (parseTotals.malformedLines > 0) {
      warnings.push(`Skipped ${parseTotals.malformedLines} malformed JSONL line(s).`);
    }

    if (parsedEvents.duplicateUsageKeys > 0) {
      warnings.push(`Collapsed ${parsedEvents.duplicateUsageKeys} duplicate Claude usage event(s) by request/message key.`);
    }

    if (parsedEvents.duplicateUsageKeyCollisions > 0) {
      warnings.push(
        `Detected ${parsedEvents.duplicateUsageKeyCollisions} Claude usage key collision(s) with different token usage; keeping the highest-cost/latest event per key.`
      );
    }

    if (parsedEvents.duplicateUnkeyedEvents > 0) {
      warnings.push(`Collapsed ${parsedEvents.duplicateUnkeyedEvents} duplicate unkeyed Claude usage event(s) by usage signature.`);
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
    const dayUsage = buildDailyUsageRows(byDay);
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
      dayUsage,
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
    inferenceMultiplier *
    USD_TO_CREDITS
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
  parsedEvents: ParsedUsageEventAccumulator
): Promise<{ linesRead: number; malformedLines: number }> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let linesRead = 0;
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

    const modelId = String(message?.model ?? "unknown");
    const eventTimeMs = Date.parse(String(payloadObject.timestamp ?? ""));
    const rateLimits = extractRateLimits(payloadObject, message);
    const normalizedUsage = normalizeUsage(usage);
    const usageKey = buildUsageEventKey(payloadObject, message);
    const usageSignature = buildUsageSignature(payloadObject, modelId, normalizedUsage);
    const parsedEvent: ParsedUsageEvent = {
      usageKey,
      usageSignature,
      timestampMs: eventTimeMs,
      modelId,
      totals: usageToTotals(modelId, normalizedUsage),
      rateLimits
    };

    recordParsedUsageEvent(parsedEvents, parsedEvent);
  }

  return { linesRead, malformedLines };
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

function buildUsageSignature(payloadObject: Record<string, unknown>, modelId: string, usage: ClaudeUsage): string {
  return [
    String(payloadObject.sessionId ?? ""),
    modelId,
    usage.inputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheCreation5mInputTokens,
    usage.cacheCreation1hInputTokens,
    usage.cacheReadInputTokens,
    usage.outputTokens,
    usage.inferenceGeo
  ].join("|");
}

function createParsedUsageEventAccumulator(): ParsedUsageEventAccumulator {
  return {
    keyedEvents: new Map<string, ParsedUsageEvent>(),
    unkeyedEvents: new Map<string, ParsedUsageEvent>(),
    duplicateUsageKeys: 0,
    duplicateUsageKeyCollisions: 0,
    duplicateUnkeyedEvents: 0
  };
}

function recordParsedUsageEvent(parsedEvents: ParsedUsageEventAccumulator, event: ParsedUsageEvent): void {
  if (event.usageKey) {
    const previous = parsedEvents.keyedEvents.get(event.usageKey);
    if (!previous) {
      parsedEvents.keyedEvents.set(event.usageKey, event);
      return;
    }

    parsedEvents.duplicateUsageKeys += 1;
    if (previous.usageSignature !== event.usageSignature) {
      parsedEvents.duplicateUsageKeyCollisions += 1;
    }

    if (shouldReplaceUsageEvent(previous, event)) {
      parsedEvents.keyedEvents.set(event.usageKey, event);
    }

    return;
  }

  const previous = parsedEvents.unkeyedEvents.get(event.usageSignature);
  if (!previous) {
    parsedEvents.unkeyedEvents.set(event.usageSignature, event);
    return;
  }

  parsedEvents.duplicateUnkeyedEvents += 1;
  if (shouldReplaceUsageEvent(previous, event)) {
    parsedEvents.unkeyedEvents.set(event.usageSignature, event);
  }
}

function shouldReplaceUsageEvent(previous: ParsedUsageEvent, next: ParsedUsageEvent): boolean {
  if (next.totals.estimatedCredits > previous.totals.estimatedCredits) {
    return true;
  }

  if (next.totals.estimatedCredits === previous.totals.estimatedCredits) {
    return normalizeTimestamp(next.timestampMs) > normalizeTimestamp(previous.timestampMs);
  }

  return false;
}

function normalizeTimestamp(value: number): number {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function extractRateLimits(
  payloadObject: Record<string, unknown>,
  message: Record<string, unknown> | null
): Record<string, unknown> | null {
  return asRecord(payloadObject.rate_limits) ?? asRecord(message?.rate_limits);
}
