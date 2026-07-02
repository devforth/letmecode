import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  type ModelUsageRow,
  type ProviderStatsOptions,
  type ProviderStats,
  type ProviderTraceLogger,
  type UsageTotals
} from "./contract.js";
import {
  applyRateLimits,
  asRecord,
  buildWindowLists,
  createLimitWindowAggregates,
  numberOrZero
} from "./limits.js";
import {
  addDailyUsage,
  buildDailyUsageRows,
  createDailyUsageAggregates
} from "./daily.js";
import { resolveUsageRate, type UsageRate } from "./pricing.js";

const RATE_CARD: Record<string, UsageRate> = {
  "claude-fable-5": { input: 10, cacheRead: 1, cacheWrite: 12.5, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 },
  "claude-opus-4-8": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-opus-4-7": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-opus-4-6": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-opus-4-5": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-opus-4-1": { input: 15, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite5m: 18.75, cacheWrite1h: 30, output: 75 },
  "claude-opus-4": { input: 15, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite5m: 18.75, cacheWrite1h: 30, output: 75 },
  "claude-sonnet-5": {
    input: 3,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    output: 15,
    // Intro pricing (~0.66x) through 2026-08-31; reverts to the standard rate above on 2026-09-01.
    introOffer: {
      effectiveUntilMs: Date.UTC(2026, 8, 1),
      rate: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 }
    }
  },
  "claude-sonnet-4-6": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite5m: 3.75, cacheWrite1h: 6, output: 15 },
  "claude-sonnet-4-5": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite5m: 3.75, cacheWrite1h: 6, output: 15 },
  "claude-sonnet-4": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite5m: 3.75, cacheWrite1h: 6, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 },
  "claude-haiku-3-5": { input: 0.8, cacheRead: 0.08, cacheWrite: 1, cacheWrite5m: 1, cacheWrite1h: 1.6, output: 4 }
};

const execFileAsync = promisify(execFile);
const USD_TO_CREDITS = 100;
const VSCODE_CLAUDE_EXTENSION_PREFIX = "anthropic.claude-code-";
const CLAUDE_SESSION_WINDOW_MINUTES = 5 * 60;
const CLAUDE_WEEK_WINDOW_MINUTES = 7 * 24 * 60;
const ANSI_ESCAPE_SEQUENCE = /\u001B\[[0-9;]*[A-Za-z]/g;

const MONTH_INDEX_BY_LABEL: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11
};

const parsedClaudeSessionFilesCache = new Map<string, Promise<ParsedClaudeSessionFile[]>>();
const claudeBinaryPathCache = new Map<string, Promise<string | null>>();
const claudeUsageOutputCache = new Map<string, Promise<string | null>>();
const claudeAuthStatusOutputCache = new Map<string, Promise<string | null>>();
const claudeOauthCredentialsOutputCache = new Map<string, Promise<string | null>>();

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
  id?: string;
  label?: string;
  readUsageCommandOutput?: () => Promise<string | null>;
  readAuthStatusOutput?: () => Promise<string | null>;
  readOauthCredentials?: () => Promise<string | null>;
  now?: () => Date;
};

type ClaudeOauthCredentials = {
  subscriptionType: string | null;
  rateLimitTier: string | null;
};

type ParsedUsageEvent = {
  entrypoint: string;
  filePath: string;
  lineNumber: number;
  usageKeys: string[];
  usageSignature: string;
  timestampMs: number;
  modelId: string;
  usage: ClaudeUsage;
  totals: UsageTotals;
  rateLimits: Record<string, unknown> | null;
};

type ParsedClaudeSessionFile = {
  filePath: string;
  linesRead: number;
  malformedLines: number;
  events: ParsedUsageEvent[];
};

type ParsedUsageEventAccumulator = {
  keyedEvents: Map<string, ParsedUsageEvent>;
  unkeyedEvents: ParsedUsageEvent[];
  lastUnkeyedEventsBySignature: Map<string, { event: ParsedUsageEvent; index: number }>;
  duplicateUsageKeys: number;
  duplicateUsageKeyCollisions: number;
  duplicateUnkeyedEvents: number;
};

type LiveUsageWindowSnapshot = {
  scope: "primary" | "secondary";
  label: "session" | "week";
  limitId: string;
  modelFamily: string | null;
  modelType?: string;
  usedPercent: number;
  resetsAtMs: number;
  windowMinutes: number;
};

type ClaudeSessionsRootCandidate = {
  rootLabel: string;
  rootPath: string;
};

type FileAccessCheckResult = {
  ok: boolean;
  errorMessage?: string;
};

export class ClaudeUsageProvider extends UsageProviderBase {
  private readonly root: string;
  private readonly readUsageCommandOutput?: () => Promise<string | null>;
  private readonly readAuthStatusOutput?: () => Promise<string | null>;
  private readonly readOauthCredentials?: () => Promise<string | null>;
  private readonly now: () => Date;

  constructor(options: ClaudeUsageProviderOptions = {}) {
    super(options.id ?? "claude", options.label ?? "Claude");
    this.root = path.resolve(options.root ?? os.homedir());
    this.readUsageCommandOutput = options.readUsageCommandOutput;
    this.readAuthStatusOutput = options.readAuthStatusOutput;
    this.readOauthCredentials = options.readOauthCredentials;
    this.now = options.now ?? (() => new Date());
  }

  async getStats(options: ProviderStatsOptions = {}): Promise<ProviderStats> {
    traceClaude(
      options.traceLogger,
      `Starting stats collection with root=${this.root} (aggregating all Claude entrypoints).`
    );
    const resolvedSessionsRoot = await resolveClaudeSessionsRoot(this.root, options.traceLogger);
    const sessionsRoot = resolvedSessionsRoot.rootPath;
    const agentName = normalizeAnalyticsAgentName(this.label);
    const userIdHash = await readClaudeUserIdHash(
      this.root,
      this.readAuthStatusOutput,
      agentName,
      options.traceLogger
    );
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

    const parsedSessionFiles = await loadParsedClaudeSessionFiles(sessionsRoot, options.traceLogger);
    traceClaude(
      options.traceLogger,
      `Loaded ${parsedSessionFiles.length} parsed session file(s) from ${sessionsRoot}.`
    );

    for (const file of parsedSessionFiles) {
      const matchingEvents = file.events;
      traceClaude(
        options.traceLogger,
        [
          `Session file ${describeSessionFilePath(sessionsRoot, file.filePath)}:`,
          `lines=${file.linesRead}`,
          `malformed=${file.malformedLines}`,
          `assistantUsageEvents=${file.events.length}`,
          `matchingEvents=${matchingEvents.length}`,
          `entrypoints=${summarizeEventCounts(file.events.map((event) => event.entrypoint || "<empty>"))}`,
          `models=${summarizeDistinctValues(file.events.map((event) => event.modelId || "unknown"))}`
        ].join(" ")
      );
      if (matchingEvents.length === 0) {
        continue;
      }

      parseTotals.filesScanned += 1;
      parseTotals.linesRead += file.linesRead;
      parseTotals.malformedLines += file.malformedLines;

      for (const event of matchingEvents) {
        recordParsedUsageEvent(parsedEvents, event);
      }
    }

    const selectedEvents = [
      ...new Set(parsedEvents.keyedEvents.values()),
      ...parsedEvents.unkeyedEvents
    ];
    traceClaude(
      options.traceLogger,
      [
        `Transcript selection summary: filesWithMatches=${parseTotals.filesScanned}/${parsedSessionFiles.length}`,
        `selectedEvents=${selectedEvents.length}`,
        `duplicateUsageKeys=${parsedEvents.duplicateUsageKeys}`,
        `duplicateUsageKeyCollisions=${parsedEvents.duplicateUsageKeyCollisions}`,
        `duplicateUnkeyedEvents=${parsedEvents.duplicateUnkeyedEvents}`
      ].join(" ")
    );
    if (selectedEvents.length === 0 && parsedSessionFiles.length > 0) {
      traceClaude(
        options.traceLogger,
        "No assistant usage events were found in the parsed Claude session files."
      );
    }

    for (const event of selectedEvents) {
      addModelUsage(byModel, event.modelId, event.totals);
      const planType = typeof event.rateLimits?.plan_type === "string" ? event.rateLimits.plan_type : undefined;
      const safeEventTimeMs = Number.isFinite(event.timestampMs) ? event.timestampMs : 0;

      addDailyUsage(byDay, event.timestampMs, event.modelId, planType, event.totals);
      applyRateLimits(windows, event.rateLimits, safeEventTimeMs, event.modelId, event.totals, planTypes);
    }

    parseTotals.tokenEvents = selectedEvents.length;

    if (parseTotals.malformedLines > 0) {
      warnings.push(`Skipped ${parseTotals.malformedLines} malformed JSONL line(s).`);
    }

    if (options.verbose && parsedEvents.duplicateUsageKeys > 0) {
      warnings.push(`Collapsed ${parsedEvents.duplicateUsageKeys} duplicate Claude usage event(s) by request/message key.`);
    }

    if (options.verbose && parsedEvents.duplicateUsageKeyCollisions > 0) {
      warnings.push(
        `Detected ${parsedEvents.duplicateUsageKeyCollisions} Claude usage key collision(s) with different token usage; kept the most complete same-key snapshot to avoid double-counting cumulative snapshots.`
      );
    }

    if (options.verbose && parsedEvents.duplicateUnkeyedEvents > 0) {
      warnings.push(
        `Collapsed ${parsedEvents.duplicateUnkeyedEvents} adjacent duplicate unkeyed Claude usage event(s) by usage signature.`
      );
    }

    const modelUsage = [...byModel.entries()]
      .map<ModelUsageRow>(([modelId, totals]) => ({ modelId, totals }))
      .sort((left, right) => right.totals.estimatedCredits - left.totals.estimatedCredits);

    const unknownPricedModels = modelUsage
      .map((row) => row.modelId)
      .filter((modelId) => !resolveRate(modelId) && !isInternalClaudeModel(modelId));
    if (unknownPricedModels.length > 0) {
      warnings.push(`No credit rate configured for: ${unknownPricedModels.join(", ")}.`);
    }

    if (parsedSessionFiles.length === 0) {
      warnings.push(`No Claude session files found under ${sessionsRoot}.`);
    }

    const summaryTotals = sumUsageTotals(modelUsage.map((row) => row.totals));
    const dayUsage = buildDailyUsageRows(byDay);
    const [fallbackPrimaryLimitWindows, fallbackSecondaryLimitWindows] = buildWindowLists(windows);
    const liveLimitWindows = await buildLiveLimitWindows({
      root: this.root,
      readUsageCommandOutput: this.readUsageCommandOutput,
      readOauthCredentials: this.readOauthCredentials,
      traceLogger: options.traceLogger,
      now: this.now(),
      selectedEvents
    });

    const primaryLimitWindows =
      liveLimitWindows.primaryLimitWindows.length > 0
        ? liveLimitWindows.primaryLimitWindows
        : fallbackPrimaryLimitWindows;
    const secondaryLimitWindows =
      liveLimitWindows.secondaryLimitWindows.length > 0
        ? liveLimitWindows.secondaryLimitWindows
        : fallbackSecondaryLimitWindows;
    traceClaude(
      options.traceLogger,
      [
        `Finished stats collection:`,
        `filesScanned=${parseTotals.filesScanned}`,
        `linesRead=${parseTotals.linesRead}`,
        `tokenEvents=${parseTotals.tokenEvents}`,
        `models=${modelUsage.length}`,
        `primaryWindows=${primaryLimitWindows.length}`,
        `secondaryWindows=${secondaryLimitWindows.length}`,
        `input=${summaryTotals.inputTokens}`,
        `output=${summaryTotals.outputTokens}`,
        `cacheRead=${summaryTotals.cacheReadInputTokens}`,
        `cacheWrite=${summaryTotals.cacheWriteInputTokens}`
      ].join(" ")
    );

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
        rootLabel: resolvedSessionsRoot.rootLabel,
        rootPath: sessionsRoot
      },
      modelUsage,
      dayUsage,
      primaryLimitWindows,
      secondaryLimitWindows,
      warnings,
      analytics: {
        agentName,
        userIdHash
      }
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

function resolveRate(modelId: string, timestampMs?: number): UsageRate | undefined {
  return resolveUsageRate(RATE_CARD, modelId, 0, { prefixMatch: true, timestampMs });
}

function isInternalClaudeModel(modelId: string): boolean {
  return modelId === "<synthetic>";
}

function creditsFor(modelId: string, usage: ClaudeUsage, timestampMs?: number): number {
  const rate = resolveRate(modelId, timestampMs);
  if (!rate) {
    return 0;
  }

  const cacheWriteBreakdown = resolveClaudeCacheWriteBreakdown(usage);
  const inferenceMultiplier = usage.inferenceGeo === "us" ? 1.1 : 1;

  return (
    ((usage.inputTokens / 1_000_000) * rate.input +
      (usage.cacheReadInputTokens / 1_000_000) * rate.cacheRead +
      (cacheWriteBreakdown.cacheWrite5mInputTokens / 1_000_000) * rate.cacheWrite5m +
      (cacheWriteBreakdown.cacheWrite1hInputTokens / 1_000_000) * rate.cacheWrite1h +
      (usage.outputTokens / 1_000_000) * rate.output) *
    inferenceMultiplier *
    USD_TO_CREDITS
  );
}

function usageToTotals(modelId: string, usage: ClaudeUsage, timestampMs?: number): UsageTotals {
  const cacheWriteBreakdown = resolveClaudeCacheWriteBreakdown(usage);
  const cacheWriteInputTokens =
    cacheWriteBreakdown.cacheWrite5mInputTokens +
    cacheWriteBreakdown.cacheWrite1hInputTokens;

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheWriteInputTokens,
    cacheWrite5mInputTokens: cacheWriteBreakdown.cacheWrite5mInputTokens,
    cacheWrite1hInputTokens: cacheWriteBreakdown.cacheWrite1hInputTokens,
    reasoningOutputTokens: 0,
    totalTokens:
      usage.inputTokens +
      usage.cacheReadInputTokens +
      cacheWriteInputTokens +
      usage.outputTokens,
    estimatedCredits: creditsFor(modelId, usage, timestampMs),
    eventCount: 1
  };
}

function addModelUsage(byModel: Map<string, UsageTotals>, modelId: string, deltaTotals: UsageTotals): void {
  const resolvedModelId = modelId || "unknown";
  const totals = byModel.get(resolvedModelId) ?? createEmptyUsageTotals();
  addUsageTotals(totals, deltaTotals);
  byModel.set(resolvedModelId, totals);
}

function resolveClaudeCacheWriteBreakdown(usage: ClaudeUsage): {
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
} {
  const cacheWriteKnownTokens = usage.cacheCreation5mInputTokens + usage.cacheCreation1hInputTokens;
  const cacheWriteFallbackTokens = Math.max(0, usage.cacheCreationInputTokens - cacheWriteKnownTokens);

  return {
    cacheWrite5mInputTokens: usage.cacheCreation5mInputTokens + cacheWriteFallbackTokens,
    cacheWrite1hInputTokens: usage.cacheCreation1hInputTokens
  };
}

function isSessionFile(filePath: string): boolean {
  return filePath.endsWith(".jsonl");
}

async function resolveClaudeSessionsRoot(
  root: string,
  traceLogger?: ProviderTraceLogger
): Promise<ClaudeSessionsRootCandidate> {
  const candidates = buildClaudeSessionsRootCandidates(root);
  traceClaude(traceLogger, `Checking ${candidates.length} Claude session root candidate(s).`);

  for (const candidate of candidates) {
    const exists = await isDirectory(candidate.rootPath);
    traceClaude(
      traceLogger,
      `Session root candidate ${candidate.rootLabel} -> ${candidate.rootPath} (${exists ? "exists" : "missing"}).`
    );
    if (exists) {
      traceClaude(
        traceLogger,
        `Selected session root ${candidate.rootLabel} -> ${candidate.rootPath}.`
      );
      return candidate;
    }
  }

  const fallbackCandidate = candidates[0] ?? {
    rootLabel: "~/.claude/projects",
    rootPath: path.join(path.resolve(root), ".claude", "projects")
  };
  traceClaude(
    traceLogger,
    `No session root candidate exists yet; defaulting to ${fallbackCandidate.rootLabel} -> ${fallbackCandidate.rootPath}.`
  );
  return fallbackCandidate;
}

function buildClaudeSessionsRootCandidates(root: string): ClaudeSessionsRootCandidate[] {
  const resolvedRoot = path.resolve(root);
  const baseName = path.basename(resolvedRoot);
  const parentBaseName = path.basename(path.dirname(resolvedRoot));
  const candidates: ClaudeSessionsRootCandidate[] = [];

  if (baseName === "projects") {
    if (parentBaseName === ".claude") {
      candidates.push({
        rootLabel: "~/.claude/projects",
        rootPath: resolvedRoot
      });
    } else if (parentBaseName === "claude" || parentBaseName === "Claude") {
      candidates.push({
        rootLabel: `~/.config/${parentBaseName}/projects`,
        rootPath: resolvedRoot
      });
    } else {
      candidates.push({
        rootLabel: "projects",
        rootPath: resolvedRoot
      });
    }
  }

  if (baseName === ".claude") {
    candidates.push({
      rootLabel: "~/.claude/projects",
      rootPath: path.join(resolvedRoot, "projects")
    });
  }

  if (parentBaseName === ".config" && (baseName === "claude" || baseName === "Claude")) {
    candidates.push({
      rootLabel: `~/.config/${baseName}/projects`,
      rootPath: path.join(resolvedRoot, "projects")
    });
  }

  candidates.push(
    {
      rootLabel: "~/.claude/projects",
      rootPath: path.join(resolvedRoot, ".claude", "projects")
    },
    {
      rootLabel: "~/.config/claude/projects",
      rootPath: path.join(resolvedRoot, ".config", "claude", "projects")
    },
    {
      rootLabel: "~/.config/Claude/projects",
      rootPath: path.join(resolvedRoot, ".config", "Claude", "projects")
    }
  );

  const dedupedCandidates = new Map<string, ClaudeSessionsRootCandidate>();
  for (const candidate of candidates) {
    const normalizedPath = path.resolve(candidate.rootPath);
    if (!dedupedCandidates.has(normalizedPath)) {
      dedupedCandidates.set(normalizedPath, {
        rootLabel: candidate.rootLabel,
        rootPath: normalizedPath
      });
    }
  }

  return [...dedupedCandidates.values()];
}

async function isDirectory(directoryPath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(directoryPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
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

async function loadParsedClaudeSessionFiles(
  sessionsRoot: string,
  traceLogger?: ProviderTraceLogger
): Promise<ParsedClaudeSessionFile[]> {
  const cacheKey = path.resolve(sessionsRoot);
  const cached = parsedClaudeSessionFilesCache.get(cacheKey);
  if (cached) {
    const files = await cached;
    traceClaude(traceLogger, `Session parse cache hit for ${sessionsRoot} (${files.length} file(s)).`);
    return files;
  }

  const pending = (async () => {
    const files: ParsedClaudeSessionFile[] = [];
    traceClaude(traceLogger, `Scanning session files under ${sessionsRoot}.`);
    for await (const filePath of walkSessionFiles(sessionsRoot)) {
      files.push(await parseSessionFile(filePath));
    }
    traceClaude(
      traceLogger,
      `Completed session file scan under ${sessionsRoot}: ${files.length} file(s) parsed.`
    );

    return files;
  })();

  parsedClaudeSessionFilesCache.set(cacheKey, pending);
  return pending;
}

async function parseSessionFile(filePath: string): Promise<ParsedClaudeSessionFile> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let linesRead = 0;
  let malformedLines = 0;
  const events: ParsedUsageEvent[] = [];

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
    const entrypoint = typeof payloadObject.entrypoint === "string" ? payloadObject.entrypoint : "";
    const rateLimits = extractRateLimits(payloadObject, message);
    const normalizedUsage = normalizeUsage(usage);
    const usageKeys = buildUsageEventKeys(payloadObject, message);
    const usageSignature = buildUsageSignature(payloadObject, modelId, normalizedUsage);
    events.push({
      entrypoint,
      filePath,
      lineNumber: linesRead,
      usageKeys,
      usageSignature,
      timestampMs: eventTimeMs,
      modelId,
      usage: normalizedUsage,
      totals: usageToTotals(modelId, normalizedUsage, eventTimeMs),
      rateLimits
    });
  }

  return {
    filePath,
    linesRead,
    malformedLines,
    events
  };
}

function buildUsageEventKeys(payloadObject: Record<string, unknown>, message: Record<string, unknown> | null): string[] {
  const sessionId = String(payloadObject.sessionId ?? "");
  const requestId = typeof payloadObject.requestId === "string" ? payloadObject.requestId : "";
  const messageId = typeof message?.id === "string" ? message.id : "";

  return [...new Set([
    requestId ? `${sessionId}|request:${requestId}` : "",
    messageId ? `${sessionId}|message:${messageId}` : ""
  ].filter(Boolean))];
}

function buildUsageSignature(payloadObject: Record<string, unknown>, modelId: string, usage: ClaudeUsage): string {
  return buildUsageSignatureFromParts(String(payloadObject.sessionId ?? ""), modelId, usage);
}

function buildUsageSignatureFromParts(sessionId: string, modelId: string, usage: ClaudeUsage): string {
  return [
    sessionId,
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
    unkeyedEvents: [],
    lastUnkeyedEventsBySignature: new Map<string, { event: ParsedUsageEvent; index: number }>(),
    duplicateUsageKeys: 0,
    duplicateUsageKeyCollisions: 0,
    duplicateUnkeyedEvents: 0
  };
}

function recordParsedUsageEvent(parsedEvents: ParsedUsageEventAccumulator, event: ParsedUsageEvent): void {
  if (event.usageKeys.length > 0) {
    const previousMatches = [...new Set(
      event.usageKeys
        .map((usageKey) => parsedEvents.keyedEvents.get(usageKey))
        .filter((candidate): candidate is ParsedUsageEvent => Boolean(candidate))
    )];
    if (previousMatches.length === 0) {
      for (const usageKey of event.usageKeys) {
        parsedEvents.keyedEvents.set(usageKey, event);
      }
      return;
    }

    parsedEvents.duplicateUsageKeys += 1;
    const distinctUsageSignatures = new Set([
      event.usageSignature,
      ...previousMatches.map((candidate) => candidate.usageSignature)
    ]);
    if (distinctUsageSignatures.size > 1) {
      parsedEvents.duplicateUsageKeyCollisions += 1;
    }

    const mergedEvent = previousMatches.reduce(mergeParsedUsageEvents, event);
    for (const usageKey of mergedEvent.usageKeys) {
      parsedEvents.keyedEvents.set(usageKey, mergedEvent);
    }
    return;
  }

  const previousRecord = parsedEvents.lastUnkeyedEventsBySignature.get(event.usageSignature);
  if (!previousRecord || !canCollapseAdjacentUnkeyedUsageEvents(previousRecord.event, event)) {
    parsedEvents.unkeyedEvents.push(event);
    parsedEvents.lastUnkeyedEventsBySignature.set(event.usageSignature, {
      event,
      index: parsedEvents.unkeyedEvents.length - 1
    });
    return;
  }

  parsedEvents.duplicateUnkeyedEvents += 1;
  if (normalizeTimestamp(event.timestampMs) > normalizeTimestamp(previousRecord.event.timestampMs)) {
    parsedEvents.unkeyedEvents[previousRecord.index] = event;
    parsedEvents.lastUnkeyedEventsBySignature.set(event.usageSignature, {
      event,
      index: previousRecord.index
    });
  }
}

function mergeParsedUsageEvents(previous: ParsedUsageEvent, next: ParsedUsageEvent): ParsedUsageEvent {
  // Same-key events are repeated/streamed snapshots of one logical request. Rather than
  // synthesizing a field-wise maximum (which can fabricate token totals when a snapshot
  // splits cache-write tokens across the 5m/1h buckets differently), keep the single most
  // complete real snapshot and discard the rest.
  const primaryEvent = selectMergedSnapshotEvent(previous, next);
  const otherEvent = primaryEvent === previous ? next : previous;
  const usage = primaryEvent.usage;
  const modelId = selectMergedEventModelId(primaryEvent, otherEvent);
  const latestEvent = normalizeTimestamp(next.timestampMs) >= normalizeTimestamp(previous.timestampMs) ? next : previous;
  const sessionId = extractUsageKeySessionId(previous.usageKeys) || extractUsageKeySessionId(next.usageKeys);

  return {
    entrypoint: latestEvent.entrypoint || previous.entrypoint || next.entrypoint,
    filePath: latestEvent.filePath,
    lineNumber: latestEvent.lineNumber,
    usageKeys: [...new Set([...previous.usageKeys, ...next.usageKeys])],
    usageSignature: buildUsageSignatureFromParts(sessionId, modelId, usage),
    timestampMs: Math.max(normalizeTimestamp(previous.timestampMs), normalizeTimestamp(next.timestampMs)),
    modelId,
    usage,
    totals: usageToTotals(modelId, usage, primaryEvent.timestampMs),
    rateLimits: latestEvent.rateLimits ?? previous.rateLimits ?? next.rateLimits
  };
}

// Pick the snapshot that carries the most usage. Cumulative snapshots are monotonic, so the
// largest total is the final state; this also keeps a real synthetic-followup row (0 tokens)
// from clobbering the real usage it follows. Ties fall back to the later, then the earlier-seen
// event for deterministic output.
function selectMergedSnapshotEvent(previous: ParsedUsageEvent, next: ParsedUsageEvent): ParsedUsageEvent {
  if (next.totals.totalTokens !== previous.totals.totalTokens) {
    return next.totals.totalTokens > previous.totals.totalTokens ? next : previous;
  }

  return normalizeTimestamp(next.timestampMs) > normalizeTimestamp(previous.timestampMs) ? next : previous;
}

function selectMergedEventModelId(primary: ParsedUsageEvent, other: ParsedUsageEvent): string {
  if (primary.modelId === other.modelId) {
    return primary.modelId;
  }

  // The chosen snapshot's own model is authoritative, except when it is the internal
  // <synthetic> placeholder and the other event names a real, priceable model.
  if (isInternalClaudeModel(primary.modelId) && !isInternalClaudeModel(other.modelId)) {
    return other.modelId;
  }

  return primary.modelId;
}

function canCollapseAdjacentUnkeyedUsageEvents(previous: ParsedUsageEvent, next: ParsedUsageEvent): boolean {
  return previous.filePath === next.filePath && next.lineNumber === previous.lineNumber + 1;
}

function extractUsageKeySessionId(usageKeys: string[]): string {
  const usageKey = usageKeys[0];
  if (!usageKey) {
    return "";
  }

  const separatorIndex = usageKey.indexOf("|");
  return separatorIndex >= 0 ? usageKey.slice(0, separatorIndex) : usageKey;
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

function traceClaude(traceLogger: ProviderTraceLogger | undefined, message: string): void {
  if (!traceLogger) {
    return;
  }

  traceLogger.log(`[Claude] ${message}`);
}

function formatErrorMessage(error: unknown): string {
  if (!error) {
    return "Unknown error";
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

function describeUsageOutput(output: string | null): string {
  if (output == null) {
    return "<null>";
  }

  return output.trim() ? output : "<empty>";
}

function describeSessionFilePath(sessionsRoot: string, filePath: string): string {
  const relativePath = path.relative(sessionsRoot, filePath);
  if (!relativePath || relativePath.startsWith("..")) {
    return filePath;
  }

  return relativePath;
}

function summarizeEventCounts(values: Iterable<string>): string {
  const counts = new Map<string, number>();

  for (const value of values) {
    const normalizedValue = value || "<empty>";
    counts.set(normalizedValue, (counts.get(normalizedValue) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return "<none>";
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value, count]) => `${value}:${count}`)
    .join(", ");
}

function summarizeDistinctValues(values: Iterable<string>, limit = 5): string {
  const distinctValues = [...new Set([...values].filter(Boolean))].sort();

  if (distinctValues.length === 0) {
    return "<none>";
  }

  const visibleValues = distinctValues.slice(0, limit);
  const remainder = distinctValues.length - visibleValues.length;
  return remainder > 0
    ? `${visibleValues.join(", ")} (+${remainder} more)`
    : visibleValues.join(", ");
}

function buildClaudeCommandEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TZ: "UTC"
  };
}

async function buildLiveLimitWindows(options: {
  root: string;
  readUsageCommandOutput?: () => Promise<string | null>;
  readOauthCredentials?: () => Promise<string | null>;
  traceLogger?: ProviderTraceLogger;
  now: Date;
  selectedEvents: ParsedUsageEvent[];
}): Promise<{ primaryLimitWindows: LimitWindowRow[]; secondaryLimitWindows: LimitWindowRow[] }> {
  const [usageOutput, credentials] = await Promise.all([
    readClaudeUsageCommandOutput(options.root, options.readUsageCommandOutput, options.traceLogger),
    readClaudeOauthCredentials(options.root, options.readOauthCredentials, options.traceLogger)
  ]);
  const snapshots = parseLiveUsageWindowSnapshots(usageOutput, options.now);
  traceClaude(options.traceLogger, `Parsed ${snapshots.length} live usage snapshot(s) from /usage output.`);
  if (snapshots.length === 0) {
    traceClaude(options.traceLogger, "No live usage snapshots matched the expected /usage format.");
  }
  const resolvedPlanType = resolveClaudeLivePlanType(credentials);
  traceClaude(options.traceLogger, `Resolved live plan type ${resolvedPlanType}.`);

  const primaryLimitWindows = snapshots
    .filter((snapshot) => snapshot.scope === "primary")
    .map((snapshot) => buildLiveLimitWindowRow(snapshot, resolvedPlanType, options.selectedEvents, options.now));
  const secondaryLimitWindows = snapshots
    .filter((snapshot) => snapshot.scope === "secondary")
    .map((snapshot) => buildLiveLimitWindowRow(snapshot, resolvedPlanType, options.selectedEvents, options.now));

  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    const row =
      snapshot.scope === "primary"
        ? primaryLimitWindows.find((window) => window.limitId === snapshot.limitId)
        : secondaryLimitWindows.find((window) => window.limitId === snapshot.limitId);
    if (!row) {
      continue;
    }

    traceClaude(
      options.traceLogger,
      [
        `Live window ${snapshot.scope}/${snapshot.label}:`,
        `used=${snapshot.usedPercent}%`,
        `limit=${snapshot.limitId}`,
        `range=${row.startTimeUtcIso}->${row.endTimeUtcIso}`,
        `matchedEvents=${row.eventCount}`,
        `input=${row.totals.inputTokens}`,
        `output=${row.totals.outputTokens}`,
        `cacheRead=${row.totals.cacheReadInputTokens}`,
        `cacheWrite=${row.totals.cacheWriteInputTokens}`
      ].join(" ")
    );
  }

  return {
    primaryLimitWindows,
    secondaryLimitWindows
  };
}

// Reported as-is: the claude.ai OAuth `rateLimitTier` is not mapped to a friendly tier name
// anymore, it is combined with `subscriptionType` verbatim (e.g. "team|default_claude_max_5x").
function resolveClaudeLivePlanType(credentials: ClaudeOauthCredentials | null): string {
  const subscriptionType = credentials?.subscriptionType;
  if (!subscriptionType) {
    return "live";
  }

  return credentials?.rateLimitTier ? `${subscriptionType}|${credentials.rateLimitTier}` : subscriptionType;
}

async function readClaudeOauthCredentials(
  root: string,
  override: (() => Promise<string | null>) | undefined,
  traceLogger?: ProviderTraceLogger
): Promise<ClaudeOauthCredentials | null> {
  const output = await readClaudeOauthCredentialsOutput(root, override, traceLogger);
  const credentials = parseClaudeOauthCredentials(output);
  if (output && !credentials) {
    traceClaude(traceLogger, "Could not parse claude.ai OAuth credentials from credentials file.");
  }
  traceClaude(
    traceLogger,
    `OAuth credentials result: subscriptionType=${credentials?.subscriptionType ?? "<none>"} rateLimitTier=${credentials?.rateLimitTier ?? "<none>"}.`
  );
  return credentials;
}

async function readClaudeOauthCredentialsOutput(
  root: string,
  override: (() => Promise<string | null>) | undefined,
  traceLogger?: ProviderTraceLogger
): Promise<string | null> {
  if (override) {
    try {
      const output = await override();
      traceClaude(traceLogger, "Using injected OAuth credentials override.");
      return output;
    } catch {
      traceClaude(traceLogger, "Injected OAuth credentials override failed.");
      return null;
    }
  }

  const credentialsPath = path.join(path.resolve(root), ".claude", ".credentials.json");
  const cacheKey = credentialsPath;
  const cached = claudeOauthCredentialsOutputCache.get(cacheKey);
  if (cached) {
    traceClaude(traceLogger, "OAuth credentials cache hit.");
    return cached;
  }

  const pending = (async () => {
    try {
      const output = await fs.promises.readFile(credentialsPath, { encoding: "utf8" });
      traceClaude(traceLogger, `Read OAuth credentials from ${credentialsPath}.`);
      return output;
    } catch {
      traceClaude(traceLogger, `No readable OAuth credentials at ${credentialsPath}.`);
      return null;
    }
  })();

  claudeOauthCredentialsOutputCache.set(cacheKey, pending);
  return pending;
}

function parseClaudeOauthCredentials(output: string | null): ClaudeOauthCredentials | null {
  if (!output) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return null;
  }

  const oauth = asRecord(asRecord(payload)?.claudeAiOauth);
  if (!oauth) {
    return null;
  }

  const subscriptionType =
    typeof oauth.subscriptionType === "string" && oauth.subscriptionType.trim()
      ? oauth.subscriptionType.trim()
      : null;
  const rateLimitTier =
    typeof oauth.rateLimitTier === "string" && oauth.rateLimitTier.trim()
      ? oauth.rateLimitTier.trim()
      : null;

  if (!subscriptionType && !rateLimitTier) {
    return null;
  }

  return { subscriptionType, rateLimitTier };
}

async function readClaudeAuthStatusOutput(
  root: string,
  override?: () => Promise<string | null>,
  traceLogger?: ProviderTraceLogger
): Promise<string | null> {
  if (override) {
    try {
      const output = await override();
      traceClaude(traceLogger, "Using injected auth status output override.");
      return output;
    } catch {
      traceClaude(traceLogger, "Injected auth status output override failed.");
      return null;
    }
  }

  const cacheKey = path.resolve(root);
  const cached = claudeAuthStatusOutputCache.get(cacheKey);
  if (cached) {
    traceClaude(traceLogger, "Auth status output cache hit.");
    return cached;
  }

  const pending = (async () => {
    const binaryPath = await resolveClaudeBinaryPath(root, traceLogger);
    if (!binaryPath) {
      traceClaude(traceLogger, "Skipping auth status command because no Claude binary was found.");
      return null;
    }

    try {
      traceClaude(traceLogger, `Running auth status command with ${binaryPath} (TZ=UTC).`);
      const { stdout, stderr } = await execFileAsync(binaryPath, ["auth", "status"], {
        encoding: "utf8",
        env: buildClaudeCommandEnvironment(),
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
        windowsHide: true
      });
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      traceClaude(traceLogger, "Auth status command completed successfully.");
      return combined || null;
    } catch (error: unknown) {
      const combined = extractExecOutput(error);
      traceClaude(traceLogger, `Auth status command failed: ${formatErrorMessage(error)}.`);
      return combined || null;
    }
  })();

  claudeAuthStatusOutputCache.set(cacheKey, pending);
  return pending;
}

function parseClaudeAuthStatusSnapshot(output: string | null): {
  email: string;
  orgId: string;
  orgName: string;
  subscriptionType: string;
} | null {
  if (!output) {
    return null;
  }

  const normalizedOutput = output.replace(ANSI_ESCAPE_SEQUENCE, "").trim();
  const firstBraceIndex = normalizedOutput.indexOf("{");
  const lastBraceIndex = normalizedOutput.lastIndexOf("}");
  if (firstBraceIndex < 0 || lastBraceIndex <= firstBraceIndex) {
    return null;
  }

  try {
    const payload = JSON.parse(normalizedOutput.slice(firstBraceIndex, lastBraceIndex + 1));
    const record = asRecord(payload);
    const email = typeof record?.email === "string" ? record.email.trim() : "";
    const orgId = typeof record?.orgId === "string" ? record.orgId.trim() : "";
    const orgName = typeof record?.orgName === "string" ? record.orgName.trim() : "";
    const subscriptionType = typeof record?.subscriptionType === "string" ? record.subscriptionType.trim() : "";
    if (!email || !orgId || !orgName || !subscriptionType) {
      return null;
    }

    return { email, orgId, orgName, subscriptionType };
  } catch {
    return null;
  }
}

async function readClaudeUserIdHash(
  root: string,
  override: (() => Promise<string | null>) | undefined,
  agentName: string,
  traceLogger?: ProviderTraceLogger
): Promise<string | null> {
  const authStatusOutput = await readClaudeAuthStatusOutput(root, override, traceLogger);
  const snapshot = parseClaudeAuthStatusSnapshot(authStatusOutput);
  if (!snapshot) {
    traceClaude(traceLogger, "Auth status output did not yield an analytics identity snapshot.");
    return null;
  }

  return buildUserIdHash([agentName, snapshot.email, snapshot.orgId, snapshot.orgName]);
}

async function readClaudeUsageCommandOutput(
  root: string,
  override?: () => Promise<string | null>,
  traceLogger?: ProviderTraceLogger
): Promise<string | null> {
  if (override) {
    try {
      const output = await override();
      traceClaude(traceLogger, "Using injected /usage output override.");
      traceClaude(traceLogger, `Usage returned:\n${describeUsageOutput(output)}`);
      return output;
    } catch {
      traceClaude(traceLogger, "Injected /usage output override failed.");
      return null;
    }
  }

  const cacheKey = path.resolve(root);
  const cached = claudeUsageOutputCache.get(cacheKey);
  if (cached) {
    traceClaude(traceLogger, "Usage output cache hit.");
    return cached;
  }

  const pending = (async () => {
    const binaryPath = await resolveClaudeBinaryPath(root, traceLogger);
    if (!binaryPath) {
      traceClaude(traceLogger, "Skipping /usage command because no Claude binary was found.");
      traceClaude(traceLogger, "Usage returned:\n<not available>");
      return null;
    }

    try {
      traceClaude(traceLogger, `Running /usage command with ${binaryPath} (TZ=UTC).`);
      const { stdout, stderr } = await execFileAsync(binaryPath, ["-p", "/usage"], {
        encoding: "utf8",
        env: buildClaudeCommandEnvironment(),
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
        windowsHide: true
      });
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      traceClaude(traceLogger, "Usage command completed successfully.");
      traceClaude(traceLogger, `Usage returned:\n${describeUsageOutput(combined || null)}`);
      return combined || null;
    } catch (error: unknown) {
      const combined = extractExecOutput(error);
      traceClaude(traceLogger, `Usage command failed: ${formatErrorMessage(error)}.`);
      traceClaude(traceLogger, `Usage returned:\n${describeUsageOutput(combined || null)}`);
      return combined || null;
    }
  })();

  claudeUsageOutputCache.set(cacheKey, pending);
  return pending;
}

function extractExecOutput(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }

  const stdout = typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "";
  const stderr = typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr : "";
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

async function resolveClaudeBinaryPath(
  root: string,
  traceLogger?: ProviderTraceLogger
): Promise<string | null> {
  const cacheKey = path.resolve(root);
  const cached = claudeBinaryPathCache.get(cacheKey);
  if (cached) {
    const binaryPath = await cached;
    traceClaude(
      traceLogger,
      `Binary detection cache hit: ${binaryPath ? `found ${binaryPath}` : "not found"}.`
    );
    return binaryPath;
  }

  const pending = (async () => {
    traceClaude(traceLogger, `Starting binary detection under ${root}.`);
    const binaryPath = await resolveMergedClaudeBinaryPath(root, traceLogger);
    traceClaude(
      traceLogger,
      `Binary detection result: ${binaryPath ? `found ${binaryPath}` : "not found"}.`
    );
    return binaryPath;
  })();

  claudeBinaryPathCache.set(cacheKey, pending);
  return pending;
}

async function resolveMergedClaudeBinaryPath(
  root: string,
  traceLogger?: ProviderTraceLogger
): Promise<string | null> {
  const candidates = [
    ...(await resolveVsCodeClaudeBinaryCandidates(root, traceLogger)),
    ...resolveDirectClaudeBinaryCandidates(root)
  ];

  for (const candidate of candidates) {
    const accessCheck = await checkReadableExecutableFile(candidate);
    traceClaude(
      traceLogger,
      `Checked ${candidate} -> ${accessCheck.ok ? "success" : `failure (${accessCheck.errorMessage ?? "unknown"})`}.`
    );
    if (accessCheck.ok) {
      return candidate;
    }
  }

  return null;
}

async function resolveVsCodeClaudeBinaryCandidates(
  root: string,
  traceLogger?: ProviderTraceLogger
): Promise<string[]> {
  const boosterDirectories = [
    path.join(root, ".vscode", "extensions"),
    path.join(root, ".vscode-server", "extensions"),
    path.join(root, ".vscode-server-insiders", "extensions")
  ];

  const candidates: string[] = [];
  for (const directory of boosterDirectories) {
    candidates.push(...(await resolveClaudeBinaryCandidatesFromExtensionDirectory(directory, traceLogger)));
  }

  return candidates;
}

async function resolveClaudeBinaryCandidatesFromExtensionDirectory(
  directory: string,
  traceLogger?: ProviderTraceLogger
): Promise<string[]> {
  let entries: fs.Dirent[];
  traceClaude(traceLogger, `Scanning extension directory ${directory}.`);
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    traceClaude(traceLogger, `Could not read ${directory}: ${formatErrorMessage(error)}.`);
    return [];
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(VSCODE_CLAUDE_EXTENSION_PREFIX))
    .map((entry) => entry.name)
    .sort(compareClaudeExtensionDirectoryNames);

  if (candidates.length === 0) {
    traceClaude(traceLogger, `No Claude VSCode extension candidates found in ${directory}.`);
    return [];
  }

  return candidates.map((candidate) =>
    path.join(directory, candidate, "resources", "native-binary", "claude")
  );
}

function compareClaudeExtensionDirectoryNames(left: string, right: string): number {
  const leftVersion = extractClaudeExtensionVersion(left);
  const rightVersion = extractClaudeExtensionVersion(right);
  const length = Math.max(leftVersion.length, rightVersion.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (rightVersion[index] ?? 0) - (leftVersion[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return right.localeCompare(left);
}

function extractClaudeExtensionVersion(directoryName: string): number[] {
  if (!directoryName.startsWith(VSCODE_CLAUDE_EXTENSION_PREFIX)) {
    return [];
  }

  const versionLabel = directoryName.slice(VSCODE_CLAUDE_EXTENSION_PREFIX.length).split("-")[0] ?? "";
  return versionLabel
    .split(".")
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function resolveDirectClaudeBinaryCandidates(root: string): string[] {
  return [
    path.join(root, ".local", "bin", "claude"),
    path.join(root, "bin", "claude")
  ];
}

async function checkReadableExecutableFile(filePath: string): Promise<FileAccessCheckResult> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK | fs.constants.X_OK);
    return { ok: true };
  } catch (error: unknown) {
    return {
      ok: false,
      errorMessage: formatErrorMessage(error)
    };
  }
}

type ParsedLiveUsageLine = {
  label: "session" | "week";
  windowQualifier: string;
  usedPercent: number;
  windowMinutes: number;
  resetString: string | null;
};

function parseLiveUsageWindowSnapshots(usageOutput: string | null, now: Date): LiveUsageWindowSnapshot[] {
  if (!usageOutput) {
    return [];
  }

  const normalizedOutput = usageOutput.replace(ANSI_ESCAPE_SEQUENCE, "");
  const parsedLines: ParsedLiveUsageLine[] = [];

  for (const line of normalizedOutput.split(/\r?\n/)) {
    const match = line
      .trim()
      .match(/^Current\s+(session|week)(?:\s+\(([^)]+)\))?:\s+(\d+)%\s+used\b(?:.*?\bresets\s+(.+))?$/i);
    if (!match) {
      continue;
    }

    const usedPercent = Number(match[3]);
    if (!Number.isFinite(usedPercent)) {
      continue;
    }

    const label = match[1].toLowerCase() === "session" ? "session" : "week";
    parsedLines.push({
      label,
      windowQualifier: (match[2] ?? "").trim().toLowerCase(),
      usedPercent,
      windowMinutes: label === "session" ? CLAUDE_SESSION_WINDOW_MINUTES : CLAUDE_WEEK_WINDOW_MINUTES,
      resetString: match[4]?.trim() || null
    });
  }

  const resetMsByLabel = new Map<"session" | "week", number>();
  for (const parsed of parsedLines) {
    if (!parsed.resetString || resetMsByLabel.has(parsed.label)) {
      continue;
    }

    const resetsAtMs = parseResetTimestampUtc(parsed.resetString, now.getTime(), parsed.windowMinutes);
    if (resetsAtMs) {
      resetMsByLabel.set(parsed.label, resetsAtMs);
    }
  }

  const snapshots = new Map<string, LiveUsageWindowSnapshot>();
  for (const parsed of parsedLines) {
    const resetsAtMs = resetMsByLabel.get(parsed.label) ?? null;
    if (!resetsAtMs) {
      continue;
    }

    const isModelScopedWeek =
      parsed.label === "week" && parsed.windowQualifier !== "" && parsed.windowQualifier !== "all models";
    const modelFamily = isModelScopedWeek ? parsed.windowQualifier.replace(/\s+only$/, "") : null;
    const limitId = modelFamily
      ? `current-week-${modelFamily.replace(/\s+/g, "-")}-only`
      : `current-${parsed.label}`;
    snapshots.set(limitId, {
      scope: parsed.label === "session" ? "primary" : "secondary",
      label: parsed.label,
      limitId,
      modelFamily,
      modelType: modelFamily ? parsed.windowQualifier : undefined,
      usedPercent: parsed.usedPercent,
      resetsAtMs,
      windowMinutes: parsed.windowMinutes
    });
  }

  return [...snapshots.values()].sort(
    (left, right) => left.windowMinutes - right.windowMinutes || left.limitId.localeCompare(right.limitId)
  );
}

function parseResetTimestampUtc(value: string, nowMs: number, windowMinutes: number): number | null {
  const match = value
    .trim()
    .match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+\(UTC\)$/i);
  if (!match) {
    return null;
  }

  const monthIndex = MONTH_INDEX_BY_LABEL[match[1].slice(0, 3).toLowerCase()];
  const day = Number(match[2]);
  const hour12 = Number(match[3]);
  const minute = Number(match[4] ?? "0");
  const meridiem = match[5].toLowerCase();

  if (
    monthIndex === undefined ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour12) ||
    !Number.isFinite(minute) ||
    day < 1 ||
    day > 31 ||
    hour12 < 1 ||
    hour12 > 12 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const hour24 = resolveHour24(hour12, meridiem);
  const currentYear = new Date(nowMs).getUTCFullYear();
  const candidates = [currentYear - 1, currentYear, currentYear + 1]
    .map((year) => Date.UTC(year, monthIndex, day, hour24, minute))
    .filter((candidate) => Number.isFinite(candidate));

  const maxFutureMs = nowMs + windowMinutes * 60_000 + 24 * 60 * 60 * 1000;
  const plausibleFutureCandidate = candidates
    .filter((candidate) => candidate >= nowMs - 60_000 && candidate <= maxFutureMs)
    .sort((left, right) => left - right)[0];

  if (plausibleFutureCandidate !== undefined) {
    return plausibleFutureCandidate;
  }

  const nearestCandidate = candidates.sort(
    (left, right) => Math.abs(left - nowMs) - Math.abs(right - nowMs)
  )[0];

  return nearestCandidate ?? null;
}

function resolveHour24(hour12: number, meridiem: string): number {
  if (hour12 === 12) {
    return meridiem === "am" ? 0 : 12;
  }

  return meridiem === "pm" ? hour12 + 12 : hour12;
}

function buildLiveLimitWindowRow(
  snapshot: LiveUsageWindowSnapshot,
  planType: string,
  selectedEvents: ParsedUsageEvent[],
  now: Date
): LimitWindowRow {
  const startTimeMs = snapshot.resetsAtMs - snapshot.windowMinutes * 60_000;
  const inWindowEvents = selectedEvents.filter(
    (event) =>
      Number.isFinite(event.timestampMs) &&
      event.timestampMs >= startTimeMs &&
      event.timestampMs < snapshot.resetsAtMs &&
      matchesClaudeLiveSnapshotModelScope(snapshot, event.modelId)
  );
  const totals = sumUsageTotals(inWindowEvents.map((event) => event.totals));
  if (snapshot.usedPercent > 0 && totals.eventCount === 0) {
    totals.estimatedCreditsStatus = "unavailable";
  }
  const fallbackLastSeenMs = Math.min(now.getTime(), snapshot.resetsAtMs);
  const firstSeenMs =
    inWindowEvents.reduce(
      (minimum, event) => Math.min(minimum, event.timestampMs),
      Number.POSITIVE_INFINITY
    );
  const lastSeenMs =
    inWindowEvents.reduce(
      (maximum, event) => Math.max(maximum, event.timestampMs),
      Number.NEGATIVE_INFINITY
    );

  return {
    scope: snapshot.scope,
    planType,
    limitId: snapshot.limitId,
    modelType: snapshot.modelType,
    windowMinutes: snapshot.windowMinutes,
    startTimeUtcIso: toUtcIso(startTimeMs),
    endTimeUtcIso: toUtcIso(snapshot.resetsAtMs),
    firstSeenUtcIso: toUtcIso(Number.isFinite(firstSeenMs) ? firstSeenMs : startTimeMs),
    lastSeenUtcIso: toUtcIso(Number.isFinite(lastSeenMs) ? lastSeenMs : fallbackLastSeenMs),
    minUsedPercent: snapshot.usedPercent,
    maxUsedPercent: snapshot.usedPercent,
    totals,
    modelUsage: buildModelUsageRowsForEvents(inWindowEvents),
    eventCount: totals.eventCount
  };
}

function matchesClaudeLiveSnapshotModelScope(
  snapshot: LiveUsageWindowSnapshot,
  modelId: string
): boolean {
  if (!snapshot.modelFamily) {
    return true;
  }

  return modelId.toLowerCase().includes(snapshot.modelFamily);
}

function buildModelUsageRowsForEvents(events: ParsedUsageEvent[]): ModelUsageRow[] {
  const byModel = new Map<string, UsageTotals>();

  for (const event of events) {
    addModelUsage(byModel, event.modelId, event.totals);
  }

  return [...byModel.entries()]
    .map<ModelUsageRow>(([modelId, totals]) => ({ modelId, totals }))
    .sort((left, right) => right.totals.estimatedCredits - left.totals.estimatedCredits);
}

function toUtcIso(value: number): string {
  return new Date(value).toISOString().replace(".000Z", "Z");
}

function buildUserIdHash(parts: string[]): string | null {
  if (parts.some((part) => !part)) {
    return null;
  }

  return createHash("md5").update(parts.join("-")).digest("hex");
}

function normalizeAnalyticsAgentName(label: string): string {
  return label.replace(/\s+/g, "");
}
