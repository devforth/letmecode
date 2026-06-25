import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  UsageProviderBase,
  addUsageTotals,
  createEmptyUsageTotals,
  type ModelUsageRow,
  type ProviderStatsOptions,
  type ProviderStats,
  sumUsageTotals,
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
import { resolveUsageRate, type UsageRate } from "./pricing.js";

const RATE_CARD: Record<string, UsageRate> = {
  "gpt-5.5": { input: 125, cacheRead: 12.5, cacheWrite: 125, cacheWrite5m: 125, cacheWrite1h: 125, output: 750 },
  "gpt-5.4": { input: 62.5, cacheRead: 6.25, cacheWrite: 62.5, cacheWrite5m: 62.5, cacheWrite1h: 62.5, output: 375 },
  "gpt-5.4-mini": { input: 18.75, cacheRead: 1.875, cacheWrite: 18.75, cacheWrite5m: 18.75, cacheWrite1h: 18.75, output: 113 }
};

type RawUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
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

type CodexModelMetadata = {
  visibility: string;
};

export class CodexUsageProvider extends UsageProviderBase {
  private readonly root: string;

  constructor(options: CodexUsageProviderOptions = {}) {
    super("codex", "Codex");
    this.root = path.resolve(options.root ?? os.homedir());
  }

  async getStats(_options: ProviderStatsOptions = {}): Promise<ProviderStats> {
    const sessionsRoot = path.join(this.root, ".codex", "sessions");
    const knownModels = await readCodexModelMetadata(this.root);
    const userIdHash = await readCodexUserIdHash(this.root, this.label);
    const byModel = new Map<string, UsageTotals>();
    const byDay = createDailyUsageAggregates();
    const windows = createLimitWindowAggregates();
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
      const fileStats = await parseSessionFile(file, byModel, byDay, windows, planTypes, knownModels);
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
      .filter((modelId) => !RATE_CARD[modelId] && !isAssumedZeroRatedCodexModel(modelId, knownModels));
    if (unknownPricedModels.length > 0) {
      warnings.push(`No credit rate configured for: ${unknownPricedModels.join(", ")}.`);
    }

    if (parseTotals.filesScanned === 0) {
      warnings.push(`No Codex session files found under ${sessionsRoot}.`);
    }

    const summaryTotals = sumUsageTotals(modelUsage.map((row) => row.totals));
    const dayUsage = buildDailyUsageRows(byDay);
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
      dayUsage,
      primaryLimitWindows,
      secondaryLimitWindows,
      warnings,
      analytics: {
        agentName: normalizeAnalyticsAgentName(this.label),
        userIdHash
      }
    };
  }
}

async function readCodexModelMetadata(root: string): Promise<Map<string, CodexModelMetadata>> {
  const modelsCachePath = path.join(root, ".codex", "models_cache.json");

  let fileText: string;
  try {
    fileText = await fs.promises.readFile(modelsCachePath, "utf8");
  } catch {
    return new Map();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(fileText);
  } catch {
    return new Map();
  }

  const models = asRecord(payload)?.models;
  if (!Array.isArray(models)) {
    return new Map();
  }

  const metadata = new Map<string, CodexModelMetadata>();
  for (const model of models) {
    const record = asRecord(model);
    const slug = typeof record?.slug === "string" ? record.slug : "";
    if (!slug) {
      continue;
    }

    metadata.set(slug, {
      visibility: typeof record?.visibility === "string" ? record.visibility : ""
    });
  }

  return metadata;
}

async function readCodexUserIdHash(root: string, agentName: string): Promise<string | null> {
  const authPath = path.join(root, ".codex", "auth.json");

  let fileText: string;
  try {
    fileText = await fs.promises.readFile(authPath, "utf8");
  } catch {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(fileText);
  } catch {
    return null;
  }

  const tokens = asRecord(asRecord(payload)?.tokens);
  const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : "";
  const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
  const identity = extractCodexIdentity(idToken) ?? extractCodexIdentity(accessToken);
  if (!identity) {
    return null;
  }

  return buildUserIdHash([
    normalizeAnalyticsAgentName(agentName),
    identity.email,
    identity.orgId,
    identity.orgName
  ]);
}

function extractCodexIdentity(token: string): { email: string; orgId: string; orgName: string } | null {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return null;
  }

  const authRecord = asRecord(payload["https://api.openai.com/auth"]);
  const profileRecord = asRecord(payload["https://api.openai.com/profile"]);
  const organizations = Array.isArray(authRecord?.organizations) ? authRecord.organizations : [];
  const defaultOrganizationRecord =
    organizations
      .map((organization) => asRecord(organization))
      .find((organization) => organization?.is_default === true) ??
    organizations
      .map((organization) => asRecord(organization))
      .find(Boolean) ??
    null;

  const emailCandidates = [
    typeof payload.email === "string" ? payload.email : "",
    typeof profileRecord?.email === "string" ? profileRecord.email : ""
  ];
  const email = emailCandidates.find((candidate) => candidate) ?? "";
  const orgId = typeof defaultOrganizationRecord?.id === "string" ? defaultOrganizationRecord.id : "";
  const orgName = typeof defaultOrganizationRecord?.title === "string" ? defaultOrganizationRecord.title : "";

  if (!email || !orgId || !orgName) {
    return null;
  }

  return { email, orgId, orgName };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    return null;
  }

  try {
    const payloadText = Buffer.from(normalizeBase64Url(parts[1]), "base64").toString("utf8");
    const payload = JSON.parse(payloadText);
    return asRecord(payload);
  } catch {
    return null;
  }
}

function normalizeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  return normalized + "=".repeat(paddingLength);
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

function createEmptyRawUsage(): RawUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
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
  const rate = resolveUsageRate(RATE_CARD, modelId);
  if (!rate) {
    return 0;
  }

  const cachedInputTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const nonCachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);

  return (
    (nonCachedInputTokens / 1_000_000) * rate.input +
    (cachedInputTokens / 1_000_000) * rate.cacheRead +
    (usage.outputTokens / 1_000_000) * rate.output
  );
}

function rawUsageToTotals(usage: RawUsage): UsageTotals {
  const cacheReadInputTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const inputTokens = Math.max(0, usage.inputTokens - cacheReadInputTokens);

  return {
    inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens: 0,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: inputTokens + cacheReadInputTokens + usage.outputTokens,
    estimatedCredits: 0,
    eventCount: 0
  };
}

function createUsageTotalsForModel(
  modelId: string,
  usage: RawUsage,
  knownModels: Map<string, CodexModelMetadata>
): UsageTotals {
  const resolvedModelId = modelId || "unknown";
  const deltaTotals = rawUsageToTotals(usage);
  deltaTotals.estimatedCredits = creditsFor(resolvedModelId, usage);
  deltaTotals.eventCount = 1;
  if (!RATE_CARD[resolvedModelId] && !isAssumedZeroRatedCodexModel(resolvedModelId, knownModels)) {
    deltaTotals.estimatedCreditsStatus = "unavailable";
  }
  return deltaTotals;
}

function addModelUsage(byModel: Map<string, UsageTotals>, modelId: string, deltaTotals: UsageTotals): void {
  const resolvedModelId = modelId || "unknown";
  const totals = byModel.get(resolvedModelId) ?? createEmptyUsageTotals();
  addUsageTotals(totals, deltaTotals);
  byModel.set(resolvedModelId, totals);
}

function isHiddenCodexModel(modelId: string, knownModels: Map<string, CodexModelMetadata>): boolean {
  return knownModels.get(modelId)?.visibility === "hide";
}

function isAssumedZeroRatedCodexModel(modelId: string, knownModels: Map<string, CodexModelMetadata>): boolean {
  // Hidden internal Codex models do not have a public rate card entry. For dashboard
  // rollups we treat them as zero-rated so they do not turn aggregate totals unknown.
  return isHiddenCodexModel(modelId, knownModels);
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
  byDay: DailyUsageAggregates,
  windows: LimitWindowAggregates,
  planTypes: Set<string>,
  knownModels: Map<string, CodexModelMetadata>
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
    const totalUsage = normalizeRawUsage(info?.total_token_usage);
    const lastUsage = info?.last_token_usage;
    const usage = lastUsage ? normalizeRawUsage(lastUsage) : previousTotal ? subtractRawUsage(totalUsage, previousTotal) : totalUsage;
    previousTotal = totalUsage;
    const resolvedModelId = currentModel || "unknown";
    const deltaTotals = createUsageTotalsForModel(resolvedModelId, usage, knownModels);

    tokenEvents += 1;
    addModelUsage(byModel, resolvedModelId, deltaTotals);

    const eventTimeMs = Date.parse(String(payloadObject.timestamp ?? ""));
    const safeEventTimeMs = Number.isFinite(eventTimeMs) ? eventTimeMs : 0;
    const rateLimits = asRecord(payload.rate_limits);
    const planType = typeof rateLimits?.plan_type === "string" ? rateLimits.plan_type : undefined;

    addDailyUsage(byDay, eventTimeMs, resolvedModelId, planType, deltaTotals);
    applyRateLimits(windows, rateLimits, safeEventTimeMs, deltaTotals, planTypes);
  }

  return { linesRead, tokenEvents, malformedLines };
}
