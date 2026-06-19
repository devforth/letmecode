import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  UsageProviderBase,
  createEmptyUsageTotals,
  type LimitWindowRow,
  type LimitWindowScope,
  type ModelUsageRow,
  type ProviderStats,
  type UsageTotals
} from "./contract.js";

type Rate = { input: number; cachedInput: number; output: number };

const RATE_CARD: Record<string, Rate> = {
  "gpt-5.5": { input: 125, cachedInput: 12.5, output: 750 },
  "gpt-5.4": { input: 62.5, cachedInput: 6.25, output: 375 },
  "gpt-5.4-mini": { input: 18.75, cachedInput: 1.875, output: 113 }
};

type RawUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

type LimitWindowAggregate = {
  scope: LimitWindowScope;
  limitId: string;
  planType: string;
  windowMinutes: number;
  minStartsAt: number;
  maxResetsAt: number;
  firstSeenMs: number;
  lastSeenMs: number;
  minUsedPercent: number;
  maxUsedPercent: number;
  totals: UsageTotals;
};

type ParseTotals = {
  filesScanned: number;
  linesRead: number;
  tokenEvents: number;
  malformedLines: number;
};

type CodexUsageProviderOptions = {
  root?: string;
};

export class CodexUsageProvider extends UsageProviderBase {
  private readonly root: string;

  constructor(options: CodexUsageProviderOptions = {}) {
    super("codex", "Codex");
    this.root = path.resolve(options.root ?? os.homedir());
  }

  async getStats(): Promise<ProviderStats> {
    const sessionsRoot = path.join(this.root, ".codex", "sessions");
    const byModel = new Map<string, UsageTotals>();
    const windows = new Map<string, LimitWindowAggregate>();
    const planTypes = new Set<string>();
    const warnings: string[] = [];
    const parseTotals: ParseTotals = {
      filesScanned: 0,
      linesRead: 0,
      tokenEvents: 0,
      malformedLines: 0
    };

    for await (const file of walkSessionFiles(sessionsRoot)) {
      parseTotals.filesScanned += 1;
      const fileStats = await parseSessionFile(file, byModel, windows, planTypes);
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
      .filter((modelId) => !RATE_CARD[modelId]);
    if (unknownPricedModels.length > 0) {
      warnings.push(`No credit rate configured for: ${unknownPricedModels.join(", ")}.`);
    }

    if (parseTotals.filesScanned === 0) {
      warnings.push(`No Codex session files found under ${sessionsRoot}.`);
    }

    const summaryTotals = sumUsageTotals(modelUsage.map((row) => row.totals));
    const [primaryLimitWindows, secondaryLimitWindows] = buildWindowLists(windows);

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
        rootLabel: "~/.codex/sessions",
        rootPath: sessionsRoot
      },
      modelUsage,
      primaryLimitWindows,
      secondaryLimitWindows,
      warnings
    };
  }
}

function createEmptyRawUsage(): RawUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeRawUsage(value: unknown): RawUsage {
  const usage = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    inputTokens: numberOrZero(usage.input_tokens),
    cachedInputTokens: numberOrZero(usage.cached_input_tokens),
    outputTokens: numberOrZero(usage.output_tokens),
    reasoningOutputTokens: numberOrZero(usage.reasoning_output_tokens),
    totalTokens: numberOrZero(usage.total_tokens)
  };
}

function subtractRawUsage(current: RawUsage, previous: RawUsage): RawUsage {
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - previous.reasoningOutputTokens),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens)
  };
}

function creditsFor(modelId: string, usage: RawUsage): number {
  const rate = RATE_CARD[modelId];
  if (!rate) {
    return 0;
  }

  const cachedInputTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const nonCachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
  return (
    (nonCachedInputTokens / 1_000_000) * rate.input +
    (cachedInputTokens / 1_000_000) * rate.cachedInput +
    (usage.outputTokens / 1_000_000) * rate.output
  );
}

function rawUsageToTotals(usage: RawUsage): UsageTotals {
  const cachedInputTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens,
    nonCachedInputTokens: Math.max(0, usage.inputTokens - cachedInputTokens),
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens,
    estimatedCredits: 0,
    eventCount: 0
  };
}

function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.nonCachedInputTokens += source.nonCachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
  target.estimatedCredits += source.estimatedCredits;
  target.eventCount += source.eventCount;
}

function createUsageTotalsForModel(modelId: string, usage: RawUsage): UsageTotals {
  const resolvedModelId = modelId || "unknown";
  const deltaTotals = rawUsageToTotals(usage);
  deltaTotals.estimatedCredits = creditsFor(resolvedModelId, usage);
  deltaTotals.eventCount = 1;
  return deltaTotals;
}

function addModelUsage(byModel: Map<string, UsageTotals>, modelId: string, deltaTotals: UsageTotals): void {
  const resolvedModelId = modelId || "unknown";
  const totals = byModel.get(resolvedModelId) ?? createEmptyUsageTotals();
  addUsageTotals(totals, deltaTotals);
  byModel.set(resolvedModelId, totals);
}

function sumUsageTotals(rows: UsageTotals[]): UsageTotals {
  const totals = createEmptyUsageTotals();
  for (const row of rows) {
    addUsageTotals(totals, row);
  }
  return totals;
}

function formatIsoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function formatIsoFromMilliseconds(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(".000Z", "Z");
}

function makeWindowKey(scope: LimitWindowScope, rateLimits: Record<string, unknown>, window: Record<string, unknown>): string {
  return [
    scope,
    String(rateLimits.limit_id ?? "unknown"),
    String(rateLimits.plan_type ?? "unknown"),
    numberOrZero(window.window_minutes),
    Math.round(numberOrZero(window.resets_at) / 60)
  ].join("|");
}

function upsertWindow(
  windows: Map<string, LimitWindowAggregate>,
  scope: LimitWindowScope,
  rateLimits: Record<string, unknown>,
  window: Record<string, unknown> | null,
  eventTimeMs: number,
  deltaTotals: UsageTotals
): void {
  if (!window) {
    return;
  }

  const windowMinutes = numberOrZero(window.window_minutes);
  const resetsAt = numberOrZero(window.resets_at);
  if (!windowMinutes || !resetsAt) {
    return;
  }

  const startsAt = resetsAt - windowMinutes * 60;
  const usedPercent = numberOrZero(window.used_percent);
  const key = makeWindowKey(scope, rateLimits, window);
  const existing = windows.get(key);

  if (!existing) {
    windows.set(key, {
      scope,
      limitId: String(rateLimits.limit_id ?? "unknown"),
      planType: String(rateLimits.plan_type ?? "unknown"),
      windowMinutes,
      minStartsAt: startsAt,
      maxResetsAt: resetsAt,
      firstSeenMs: eventTimeMs,
      lastSeenMs: eventTimeMs,
      minUsedPercent: usedPercent,
      maxUsedPercent: usedPercent,
      totals: createEmptyUsageTotals()
    });
    addUsageTotals(windows.get(key)!.totals, deltaTotals);
    return;
  }

  existing.minStartsAt = Math.min(existing.minStartsAt, startsAt);
  existing.maxResetsAt = Math.max(existing.maxResetsAt, resetsAt);
  existing.firstSeenMs = Math.min(existing.firstSeenMs, eventTimeMs);
  existing.lastSeenMs = Math.max(existing.lastSeenMs, eventTimeMs);
  existing.minUsedPercent = Math.min(existing.minUsedPercent, usedPercent);
  existing.maxUsedPercent = Math.max(existing.maxUsedPercent, usedPercent);
  addUsageTotals(existing.totals, deltaTotals);
}

function buildWindowLists(windows: Map<string, LimitWindowAggregate>): [LimitWindowRow[], LimitWindowRow[]] {
  const rows = [...windows.values()]
    .map<LimitWindowRow>((window) => ({
      scope: window.scope,
      planType: window.planType,
      limitId: window.limitId,
      windowMinutes: window.windowMinutes,
      startTimeUtcIso: formatIsoFromSeconds(window.minStartsAt),
      endTimeUtcIso: formatIsoFromSeconds(window.maxResetsAt),
      firstSeenUtcIso: formatIsoFromMilliseconds(window.firstSeenMs),
      lastSeenUtcIso: formatIsoFromMilliseconds(window.lastSeenMs),
      minUsedPercent: window.minUsedPercent,
      maxUsedPercent: window.maxUsedPercent,
      totals: { ...window.totals },
      eventCount: window.totals.eventCount
    }))
    .sort((left, right) => right.endTimeUtcIso.localeCompare(left.endTimeUtcIso));

  const primary = rows.filter((row) => row.scope === "primary").slice(0, 5);
  const secondary = rows.filter((row) => row.scope === "secondary").slice(0, 5);
  return [primary, secondary];
}

function isSessionFile(filePath: string): boolean {
  return filePath.endsWith(".jsonl") && filePath.includes(`${path.sep}.codex${path.sep}sessions${path.sep}`);
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
  windows: Map<string, LimitWindowAggregate>,
  planTypes: Set<string>
): Promise<{ linesRead: number; tokenEvents: number; malformedLines: number }> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let currentModel = "unknown";
  let previousTotal: RawUsage | undefined;
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

    if (payloadObject.type === "turn_context") {
      const payload = payloadObject.payload as Record<string, unknown> | undefined;
      const collaborationMode = payload?.collaboration_mode as Record<string, unknown> | undefined;
      const settings = collaborationMode?.settings as Record<string, unknown> | undefined;
      currentModel = String(payload?.model ?? settings?.model ?? currentModel);
      continue;
    }

    if (payloadObject.type !== "event_msg") {
      continue;
    }

    const payload = payloadObject.payload as Record<string, unknown> | undefined;
    if (payload?.type !== "token_count") {
      continue;
    }

    const info = payload.info as Record<string, unknown> | undefined;
    const rateLimits = payload.rate_limits as Record<string, unknown> | undefined;
    const totalUsage = normalizeRawUsage(info?.total_token_usage);
    const lastUsage = info?.last_token_usage;
    const usage = lastUsage ? normalizeRawUsage(lastUsage) : previousTotal ? subtractRawUsage(totalUsage, previousTotal) : totalUsage;
    previousTotal = totalUsage;
    const resolvedModelId = currentModel || "unknown";
    const deltaTotals = createUsageTotalsForModel(resolvedModelId, usage);

    tokenEvents += 1;
    addModelUsage(byModel, resolvedModelId, deltaTotals);

    if (typeof rateLimits?.plan_type === "string") {
      planTypes.add(rateLimits.plan_type);
    }

    const eventTimeMs = Date.parse(String(payloadObject.timestamp ?? ""));
    const safeEventTimeMs = Number.isFinite(eventTimeMs) ? eventTimeMs : 0;

    upsertWindow(windows, "primary", rateLimits ?? {}, asRecord(rateLimits?.primary), safeEventTimeMs, deltaTotals);
    upsertWindow(windows, "secondary", rateLimits ?? {}, asRecord(rateLimits?.secondary), safeEventTimeMs, deltaTotals);
  }

  return { linesRead, tokenEvents, malformedLines };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
