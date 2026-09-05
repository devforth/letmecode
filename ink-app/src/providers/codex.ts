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

// One credit equals $0.01 (see CODEX_CREDIT_COST_USD in index.tsx), so credits
// equal USD * 100. Rate cards are expressed in the model's actual API price in
// USD per 1M tokens and scaled to credits in creditsFor, matching the Claude
// provider. These are the real OpenAI API prices, not the (4x cheaper) Codex
// subscription credit prices.
// Source: https://developers.openai.com/api/docs/pricing (checked 2026-09-05).
// GPT-5.6 Sol's current promotional rate is guaranteed only through at least
// 2026-11-21, so it must be rechecked after that date.
const USD_TO_CREDITS = 100;

const GPT_6_ASTRA_RATE: UsageRate = {
  input: 10,
  cacheRead: 1,
  cacheWrite: 12.5,
  cacheWrite5m: 12.5,
  cacheWrite1h: 12.5,
  output: 50,
  longContext: {
    thresholdTokens: 272_000,
    rate: { input: 20, cacheRead: 2, cacheWrite: 25, cacheWrite5m: 25, cacheWrite1h: 25, output: 75 }
  }
};

const GPT_5_6_SOL_RATE: UsageRate = {
  input: 4,
  cacheRead: 0.4,
  cacheWrite: 5,
  cacheWrite5m: 5,
  cacheWrite1h: 5,
  output: 20,
  longContext: {
    thresholdTokens: 272_000,
    rate: { input: 8, cacheRead: 0.8, cacheWrite: 10, cacheWrite5m: 10, cacheWrite1h: 10, output: 30 }
  }
};

const RATE_CARD: Record<string, UsageRate> = {
  "gpt-6-astra": GPT_6_ASTRA_RATE,
  "gpt-5.6-sol": GPT_5_6_SOL_RATE,
  "gpt-5.6-terra": {
    input: 2,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    cacheWrite5m: 2.5,
    cacheWrite1h: 2.5,
    output: 12,
    longContext: {
      thresholdTokens: 272_000,
      rate: { input: 4, cacheRead: 0.4, cacheWrite: 5, cacheWrite5m: 5, cacheWrite1h: 5, output: 18 }
    }
  },
  "gpt-5.6-luna": {
    input: 0.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    cacheWrite5m: 0.25,
    cacheWrite1h: 0.25,
    output: 1.2,
    longContext: {
      thresholdTokens: 272_000,
      rate: { input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, cacheWrite5m: 0.5, cacheWrite1h: 0.5, output: 1.8 }
    }
  },
  "gpt-5.5": {
    input: 5,
    cacheRead: 0.5,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 30,
    longContext: {
      thresholdTokens: 272_000,
      rate: { input: 10, cacheRead: 1, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 45 }
    }
  },
  "gpt-5.4": {
    input: 2.5,
    cacheRead: 0.25,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 15,
    longContext: {
      thresholdTokens: 272_000,
      rate: { input: 5, cacheRead: 0.5, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 22.5 }
    }
  },
  "gpt-5.4-mini": { input: 0.75, cacheRead: 0.075, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 4.5 },
  "gpt-5.3-codex": { input: 1.75, cacheRead: 0.175, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 14 },
  "gpt-5.2": { input: 1.75, cacheRead: 0.175, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 14 }
};

type RawUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
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
    const codexRoot = path.join(this.root, ".codex");
    const sessionRoots = [
      path.join(codexRoot, "sessions"),
      path.join(codexRoot, "archived_sessions")
    ];
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

    const seenSessionFiles = new Set<string>();
    for (const sessionRoot of sessionRoots) {
      for await (const file of walkSessionFiles(sessionRoot)) {
        // Archiving normally moves a rollout, but guard against a transient copy
        // existing in both locations while Codex updates its session index.
        const sessionFileId = path.basename(file);
        if (seenSessionFiles.has(sessionFileId)) {
          continue;
        }
        seenSessionFiles.add(sessionFileId);

        parseTotals.filesScanned += 1;
        const fileStats = await parseSessionFile(file, byModel, byDay, windows, planTypes, knownModels);
        parseTotals.linesRead += fileStats.linesRead;
        parseTotals.tokenEvents += fileStats.tokenEvents;
        parseTotals.malformedLines += fileStats.malformedLines;
      }
    }

    if (parseTotals.malformedLines > 0) {
      warnings.push(`Skipped ${parseTotals.malformedLines} malformed JSONL line(s).`);
    }
    const modelUsage = [...byModel.entries()]
      .map<ModelUsageRow>(([modelId, totals]) => ({ modelId, totals }))
      .sort((left, right) => right.totals.estimatedCredits - left.totals.estimatedCredits);

    const unknownPricedModels = modelUsage
      .filter((row) => row.totals.totalTokens > 0)
      .map((row) => row.modelId)
      .filter((modelId) => !rateForCodexModel(modelId) && !isAssumedZeroRatedCodexModel(modelId, knownModels));
    if (unknownPricedModels.length > 0) {
      warnings.push(`No API-equivalent rate configured for: ${unknownPricedModels.join(", ")}.`);
    }

    if (parseTotals.filesScanned === 0) {
      warnings.push(`No Codex session files found under ${codexRoot}.`);
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
        rootLabel: "~/.codex",
        rootPath: codexRoot
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
    cacheWriteInputTokens: 0,
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
    cacheWriteInputTokens: numberOrZero(usage.cache_write_input_tokens),
    outputTokens: numberOrZero(usage.output_tokens),
    reasoningOutputTokens: numberOrZero(usage.reasoning_output_tokens),
    totalTokens: numberOrZero(usage.total_tokens)
  };
}

function creditsFor(modelId: string, usage: RawUsage, serviceTier?: string): number {
  const rate = rateForCodexModel(modelId, usage.inputTokens);
  if (!rate) {
    return 0;
  }

  const { inputTokens, cacheReadInputTokens, cacheWriteInputTokens } = resolveCodexInputBreakdown(usage);

  return (
    ((inputTokens / 1_000_000) * rate.input +
      (cacheReadInputTokens / 1_000_000) * rate.cacheRead +
      (cacheWriteInputTokens / 1_000_000) * rate.cacheWrite +
      (usage.outputTokens / 1_000_000) * rate.output) *
    serviceTierPriceMultiplier(serviceTier) *
    USD_TO_CREDITS
  );
}

function serviceTierPriceMultiplier(serviceTier?: string): number {
  switch (serviceTier?.trim().toLowerCase()) {
    case "fast":
    case "priority":
      return 2;
    case "flex":
      return 0.5;
    default:
      return 1;
  }
}

function isSupportedServiceTier(serviceTier?: string): boolean {
  return ["default", "priority", "fast", "flex"].includes(
    serviceTier?.trim().toLowerCase() ?? ""
  );
}

function rateForCodexModel(modelId: string, inputTokens = 0) {
  // The unsuffixed API alias routes to Sol. Normalize only the exact alias so
  // an unknown future gpt-5.6-* tier is not accidentally charged at Sol rates.
  const pricedModelId =
    modelId === "gpt-5.6"
      ? "gpt-5.6-sol"
      : modelId === "codex-auto-review"
        ? "gpt-5.4"
        : modelId;
  return resolveUsageRate(RATE_CARD, pricedModelId, inputTokens, { prefixMatch: true });
}

function rawUsageToTotals(usage: RawUsage): UsageTotals {
  const { inputTokens, cacheReadInputTokens, cacheWriteInputTokens } = resolveCodexInputBreakdown(usage);

  return {
    inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    cacheWrite5mInputTokens: cacheWriteInputTokens,
    cacheWrite1hInputTokens: 0,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: inputTokens + cacheReadInputTokens + cacheWriteInputTokens + usage.outputTokens,
    estimatedCredits: 0,
    eventCount: 0
  };
}

function resolveCodexInputBreakdown(usage: RawUsage): {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
} {
  const cacheReadInputTokens = Math.min(Math.max(0, usage.cachedInputTokens), usage.inputTokens);
  const inputAfterCacheRead = Math.max(0, usage.inputTokens - cacheReadInputTokens);
  const cacheWriteInputTokens = Math.min(Math.max(0, usage.cacheWriteInputTokens), inputAfterCacheRead);
  return {
    inputTokens: Math.max(0, inputAfterCacheRead - cacheWriteInputTokens),
    cacheReadInputTokens,
    cacheWriteInputTokens
  };
}

function createUsageTotalsForModel(
  modelId: string,
  usage: RawUsage,
  knownModels: Map<string, CodexModelMetadata>,
  serviceTier?: string
): UsageTotals {
  const resolvedModelId = modelId || "unknown";
  const deltaTotals = rawUsageToTotals(usage);
  deltaTotals.estimatedCredits = creditsFor(resolvedModelId, usage, serviceTier);
  deltaTotals.eventCount = 1;
  if (!rateForCodexModel(resolvedModelId, usage.inputTokens) && !isAssumedZeroRatedCodexModel(resolvedModelId, knownModels)) {
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
  // Synthetic bookkeeping rows carry no billable model call. Other hidden
  // models are not assumed free: Codex auto-review is mapped to GPT-5.4 above,
  // and an unknown hidden model must make the estimate explicitly unavailable.
  return modelId === "<synthetic>" && isHiddenCodexModel(modelId, knownModels);
}

function isSessionFile(filePath: string): boolean {
  return filePath.endsWith(".jsonl");
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
  let currentServiceTier: string | undefined;
  let pendingUsageRecord:
    | { modelId: string; usage: RawUsage; eventTimeMs: number; serviceTier?: string }
    | undefined;
  let firstSessionMetadataSeen = false;
  let forkStartedAtMs: number | null = null;
  let isOwnForkHistory = true;
  let linesRead = 0;
  let tokenEvents = 0;
  let malformedLines = 0;
  let pendingWebSearchCalls = 0;
  let lastSeenTimestampMs = 0;

  const recordUsage = (
    modelId: string,
    usage: RawUsage,
    eventTimeMs: number,
    rateLimits: Record<string, unknown> | null = null,
    serviceTier = currentServiceTier
  ): void => {
    const webSearchCostCredits = pendingWebSearchCalls;
    pendingWebSearchCalls = 0;
    // Current-format-only policy: without the applied tier the exact cost is
    // unknowable. Silently ignore the event instead of guessing Standard or
    // carrying compatibility warnings for legacy rollout formats.
    if (!isSupportedServiceTier(serviceTier)) {
      return;
    }
    if (!hasCountedRawUsage(usage) && webSearchCostCredits === 0) {
      return;
    }

    const resolvedModelId = modelId || "unknown";
    const deltaTotals = createUsageTotalsForModel(resolvedModelId, usage, knownModels, serviceTier);
    // OpenAI API web search is $10 / 1k calls: $0.01, or one dashboard
    // credit, per completed call. Search-content tokens are already present in
    // the model usage record and are priced normally above.
    deltaTotals.estimatedCredits += webSearchCostCredits;
    if (!hasCountedRawUsage(usage) && webSearchCostCredits > 0) {
      deltaTotals.estimatedCreditsStatus = "known";
    }
    const planType = typeof rateLimits?.plan_type === "string" ? rateLimits.plan_type : undefined;
    const safeEventTimeMs = Number.isFinite(eventTimeMs) ? eventTimeMs : 0;

    tokenEvents += 1;
    addModelUsage(byModel, resolvedModelId, deltaTotals);
    addDailyUsage(byDay, eventTimeMs, resolvedModelId, planType, deltaTotals);
    applyRateLimits(windows, rateLimits, safeEventTimeMs, resolvedModelId, deltaTotals, planTypes);
  };

  const flushPendingUsageRecord = (): void => {
    if (!pendingUsageRecord) {
      return;
    }
    recordUsage(
      pendingUsageRecord.modelId,
      pendingUsageRecord.usage,
      pendingUsageRecord.eventTimeMs,
      null,
      pendingUsageRecord.serviceTier
    );
    pendingUsageRecord = undefined;
  };

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
    const parsedTimestampMs = Date.parse(String(payloadObject.timestamp ?? ""));
    if (Number.isFinite(parsedTimestampMs)) {
      lastSeenTimestampMs = parsedTimestampMs;
    }

    if (payloadObject.type === "session_meta" && !firstSessionMetadataSeen) {
      firstSessionMetadataSeen = true;
      const payload = asRecord(payloadObject.payload);
      const sessionStartedAtMs = parseSortableCodexIdTimestamp(payload?.id);
      if (typeof payload?.forked_from_id === "string" && sessionStartedAtMs !== null) {
        forkStartedAtMs = sessionStartedAtMs;
        isOwnForkHistory = false;
      }
      continue;
    }

    if (payloadObject.type === "turn_context") {
      const payload = asRecord(payloadObject.payload);
      const turnStartedAtMs = parseSortableCodexIdTimestamp(payload?.turn_id);
      if (forkStartedAtMs !== null && turnStartedAtMs !== null && turnStartedAtMs < forkStartedAtMs) {
        continue;
      }
      if (!isOwnForkHistory) {
        if (forkStartedAtMs !== null && turnStartedAtMs === null) {
          continue;
        }
        isOwnForkHistory = true;
      }

      flushPendingUsageRecord();
      const collaborationMode = asRecord(payload?.collaboration_mode);
      const settings = asRecord(collaborationMode?.settings);
      currentModel = String(payload?.model ?? settings?.model ?? currentModel);
      continue;
    }

    // A fork inherits the latest thread settings from its parent history. Keep
    // tracking those settings while skipping the inherited usage itself, so a
    // child request is priced with the tier that was actually in force.
    if (payloadObject.type === "event_msg") {
      const payload = asRecord(payloadObject.payload);
      if (payload?.type === "thread_settings_applied") {
        const threadSettings = asRecord(payload.thread_settings);
        if (typeof threadSettings?.model === "string" && threadSettings.model.trim()) {
          currentModel = threadSettings.model;
        }
        if (typeof threadSettings?.service_tier === "string" && threadSettings.service_tier.trim()) {
          currentServiceTier = threadSettings.service_tier;
        }
        continue;
      }
    }

    if (!isOwnForkHistory) {
      continue;
    }

    if (payloadObject.type === "token_usage_record") {
      flushPendingUsageRecord();
      const payload = asRecord(payloadObject.payload);
      const usage = normalizeRawUsage(payload?.usage);
      if (hasCountedRawUsage(usage)) {
        pendingUsageRecord = {
          modelId: currentModel || "unknown",
          usage,
          eventTimeMs: Date.parse(String(payloadObject.timestamp ?? "")),
          serviceTier: currentServiceTier
        };
      }
      continue;
    }

    if (payloadObject.type !== "event_msg") {
      continue;
    }

    const payload = asRecord(payloadObject.payload);
    if (payload?.type === "web_search_end") {
      pendingWebSearchCalls += 1;
      continue;
    }
    if (payload?.type !== "token_count") {
      continue;
    }

    const eventTimeMs = Date.parse(String(payloadObject.timestamp ?? ""));
    const rateLimits = asRecord(payload.rate_limits);

    if (pendingUsageRecord) {
      const pending = pendingUsageRecord;
      pendingUsageRecord = undefined;
      recordUsage(pending.modelId, pending.usage, pending.eventTimeMs, rateLimits, pending.serviceTier);
    }
  }

  flushPendingUsageRecord();
  if (pendingWebSearchCalls > 0) {
    recordUsage(currentModel, createEmptyRawUsage(), lastSeenTimestampMs);
  }

  return { linesRead, tokenEvents, malformedLines };
}

function hasCountedRawUsage(usage: RawUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.cachedInputTokens > 0 ||
    usage.cacheWriteInputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.reasoningOutputTokens > 0
  );
}

function parseSortableCodexIdTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const timestampHex = value.replace(/-/g, "").slice(0, 12);
  if (!/^[0-9a-f]{12}$/i.test(timestampHex)) {
    return null;
  }

  const timestamp = Number.parseInt(timestampHex, 16);
  return Number.isFinite(timestamp) ? timestamp : null;
}
