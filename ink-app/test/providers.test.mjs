import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { parse as parseJsonc } from "jsonc-parser";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AntigravityUsageProvider,
  parseAntigravityQuotaEntries
} from "../dist/providers/antigravity.js";
import { ClaudeUsageProvider } from "../dist/providers/claude.js";
import { CodexUsageProvider } from "../dist/providers/codex.js";
import { buildAnonymousUsagePayload, buildAnonymousUsageReports } from "../dist/reporting.js";
import {
  CopilotUsageProvider,
  configureCopilotVsCodeLogging
} from "../dist/providers/copilot.js";
import { createProviders } from "../dist/providers/index.js";

// Keep the Copilot provider tests hermetic: never resolve a real GitHub token or
// hit the network for quota. OTEL-focused tests inject "no quota"; quota-focused
// tests inject their own fetchUserInfo.
const copilotNoQuota = async () => ({ quotaInfo: undefined, warnings: [] });

async function withTempRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "letmecode-codex-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeSession(root, relativePath, lines) {
  const target = path.join(root, ".codex", "sessions", relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, lines.join("\n"), "utf8");
}

async function writeCodexModelsCache(root, models) {
  const target = path.join(root, ".codex", "models_cache.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ models }, null, 2), "utf8");
}

async function writeCodexAuth(root, payload) {
  const target = path.join(root, ".codex", "auth.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf8");
}

async function writeClaudeSession(root, relativePath, lines) {
  const target = path.join(root, ".claude", "projects", relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, lines.join("\n"), "utf8");
}

async function writeClaudeSessionAt(targetRoot, relativePath, lines) {
  const target = path.join(targetRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, lines.join("\n"), "utf8");
}

async function writeExecutable(target, contents) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
  await fs.chmod(target, 0o755);
}

async function writeCopilotSession(root, relativePath, lines) {
  const target = path.join(root, ".copilot", "session-state", relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, lines.join("\n"), "utf8");
}

async function writeCopilotOtel(root, lines) {
  const target = path.join(root, ".copilot", "otel", "vscode.jsonl");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, lines.join("\n"), "utf8");
}

async function writeTokscaleAntigravitySession(root, relativePath, lines, syncedAt = "2026-06-24T12:56:10.967Z") {
  const target = path.join(root, ".config", "tokscale", "antigravity-cache", "sessions", relativePath);
  const manifest = path.join(root, ".config", "tokscale", "antigravity-cache", "manifest.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, lines.join("\n"), "utf8");
  await fs.writeFile(manifest, JSON.stringify({ version: 1, syncedAt }), "utf8");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function turnContext(model, cwd = "/tmp/project") {
  return JSON.stringify({
    timestamp: "2026-06-18T20:00:00.000Z",
    type: "turn_context",
    payload: {
      model,
      cwd
    }
  });
}

function tokenEvent({
  timestamp,
  total,
  last,
  planType = "team",
  primary,
  secondary
}) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        ...(last ? { last_token_usage: last } : {})
      },
      rate_limits: {
        limit_id: "codex",
        plan_type: planType,
        primary,
        secondary
      }
    }
  });
}

function fakeJwt(payload) {
  const header = encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  return `${header}.${encodedPayload}.signature`;
}

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function claudeAssistantEvent({
  timestamp,
  requestId,
  messageId,
  model,
  entrypoint = "sdk-cli",
  inputTokens,
  cacheReadInputTokens = 0,
  cacheCreation5mInputTokens = 0,
  cacheCreation1hInputTokens = 0,
  outputTokens,
  rateLimits
}) {
  return JSON.stringify({
    type: "assistant",
    sessionId: "claude-session-1",
    requestId,
    timestamp,
    entrypoint,
    ...(rateLimits ? { rate_limits: rateLimits } : {}),
    message: {
      id: messageId,
      model,
      role: "assistant",
      usage: {
        input_tokens: inputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        cache_creation_input_tokens: cacheCreation5mInputTokens + cacheCreation1hInputTokens,
        output_tokens: outputTokens,
        cache_creation: {
          ephemeral_5m_input_tokens: cacheCreation5mInputTokens,
          ephemeral_1h_input_tokens: cacheCreation1hInputTokens
        }
      }
    }
  });
}

function claudeOpenedFileInIdeAttachment({
  timestamp,
  entrypoint = "cli",
  sessionId = "claude-session-1",
  filePath = "/tmp/project/app.ts",
  version = "2.1.190"
}) {
  return JSON.stringify({
    type: "attachment",
    timestamp,
    sessionId,
    entrypoint,
    version,
    attachment: {
      type: "opened_file_in_ide",
      filename: filePath
    }
  });
}

function claudeIdeToolsAttachment({
  timestamp,
  entrypoint = "cli",
  sessionId = "claude-session-1",
  version = "2.1.190"
}) {
  return JSON.stringify({
    type: "attachment",
    timestamp,
    sessionId,
    entrypoint,
    version,
    attachment: {
      type: "deferred_tools_delta",
      addedNames: ["mcp__ide__getDiagnostics"]
    }
  });
}

test("provider registry stays UI-generic", async () => {
  const providers = createProviders();
  assert.equal(providers.length, 4);
  assert.equal(providers[0].id, "codex");
  assert.equal(providers[1].id, "claude");
  assert.equal(providers[2].id, "copilot");
  assert.equal(providers[3].id, "antigravity");
  assert.equal(typeof providers[0].getStats, "function");
  assert.equal(typeof providers[1].getStats, "function");
  assert.equal(typeof providers[2].getStats, "function");
  assert.equal(typeof providers[3].getStats, "function");
});

test("AntigravityUsageProvider parses one normalized usage record", async () => {
  const stats = await new AntigravityUsageProvider({
    collectUsage: async () => [
      {
        type: "usage",
        sessionId: "s1",
        responseId: "r1",
        timestamp: 1782304784564,
        modelId: "gemini-3-flash-a",
        input: 5528,
        cacheRead: 16294,
        cacheWrite: 100,
        output: 158,
        reasoning: 78
      }
    ]
  }).getStats();

  assert.equal(stats.providerId, "antigravity");
  assert.equal(stats.summary.filesScanned, 0);
  assert.equal(stats.summary.tokenEvents, 1);
  assert.equal(stats.modelUsage[0].modelId, "gemini-3-flash");
  assert.equal(stats.summary.totals.inputTokens, 5528);
  assert.equal(stats.summary.totals.cacheReadInputTokens, 16294);
  assert.equal(stats.summary.totals.cacheWriteInputTokens, 100);
  assert.equal(stats.summary.totals.outputTokens, 158);
  assert.equal(stats.summary.totals.reasoningOutputTokens, 78);
  assert.equal(stats.summary.totals.totalTokens, 22080);
  assert.ok(Math.abs(stats.summary.totals.estimatedCredits - 0.41027) < 0.0000001);
});

test("AntigravityUsageProvider sums multiple per-response records without deltas", async () => {
  const stats = await new AntigravityUsageProvider({
    collectUsage: async () => [
      {
        type: "usage",
        sessionId: "s1",
        responseId: "r1",
        timestamp: 1782304784564,
        modelId: "gemini-3-flash-a",
        input: 10,
        cacheRead: 20,
        cacheWrite: 3,
        output: 4,
        reasoning: 2
      },
      {
        type: "usage",
        sessionId: "s1",
        responseId: "r2",
        timestamp: 1782391184564,
        modelId: "unknown-model",
        input: 30,
        cacheRead: 40,
        cacheWrite: 5,
        output: 6,
        reasoning: 1
      }
    ]
  }).getStats();
  const byModel = new Map(stats.modelUsage.map((row) => [row.modelId, row.totals]));

  assert.equal(stats.summary.totals.eventCount, 2);
  assert.equal(stats.summary.totals.inputTokens, 40);
  assert.equal(stats.summary.totals.cacheReadInputTokens, 60);
  assert.equal(stats.summary.totals.cacheWriteInputTokens, 8);
  assert.equal(stats.dayUsage.length, 2);
  assert.equal(byModel.get("unknown-model")?.estimatedCreditsStatus, "unavailable");
  assert.equal(stats.warnings.some((warning) => warning.includes("unknown-model")), true);
});

test("AntigravityUsageProvider prices expanded rate card models and suppresses unpriced models", async () => {
  const stats = await new AntigravityUsageProvider({
    collectUsage: async () => [
      {
        type: "usage",
        sessionId: "s1",
        responseId: "r1",
        timestamp: 1782304784564,
        modelId: "gemini-3.1-pro",
        input: 250000,
        cacheRead: 100000,
        cacheWrite: 50000,
        output: 1000,
        reasoning: 100
      },
      {
        type: "usage",
        sessionId: "s2",
        responseId: "r2",
        timestamp: 1782304784564,
        modelId: "claude-sonnet-4-6",
        input: 1000,
        cacheRead: 500,
        cacheWrite: 200,
        output: 100,
        reasoning: 0
      },
      {
        type: "usage",
        sessionId: "s3",
        responseId: "r3",
        timestamp: 1782304784564,
        modelId: "gpt-oss-120b",
        input: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 100,
        reasoning: 0
      }
    ]
  }).getStats();
  const byModel = new Map(stats.modelUsage.map((row) => [row.modelId, row.totals]));

  assert.ok(Math.abs((byModel.get("gemini-3.1-pro")?.estimatedCredits ?? 0) - 125.8) < 0.0000001);
  assert.ok(Math.abs((byModel.get("claude-sonnet-4-6")?.estimatedCredits ?? 0) - 0.54) < 0.0000001);
  assert.equal(byModel.get("gpt-oss-120b")?.estimatedCredits, 0);
  assert.equal(byModel.get("gpt-oss-120b")?.estimatedCreditsStatus, "unavailable");
  assert.equal(stats.warnings.some((warning) => warning.includes("gpt-oss-120b")), false);
});

test("AntigravityUsageProvider keeps same timestamp responses with different response IDs", async () => {
  const stats = await new AntigravityUsageProvider({
    collectUsage: async () => [
      {
        type: "usage",
        sessionId: "s1",
        responseId: "r1",
        timestamp: 1782304784564,
        modelId: "gemini-3-flash-a",
        input: 10,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1,
        reasoning: 1
      },
      {
        type: "usage",
        sessionId: "s1",
        responseId: "r2",
        timestamp: 1782304784564,
        modelId: "gemini-3-flash-a",
        input: 20,
        cacheRead: 0,
        cacheWrite: 0,
        output: 2,
        reasoning: 1
      }
    ]
  }).getStats();

  assert.equal(stats.summary.totals.eventCount, 2);
  assert.equal(stats.summary.totals.inputTokens, 30);
  assert.equal(stats.summary.totals.cacheReadInputTokens, 0);
  assert.equal(stats.summary.totals.outputTokens, 3);
});

test("AntigravityUsageProvider deduplicates duplicate responses", async () => {
  const duplicate = {
    type: "usage",
    sessionId: "s1",
    responseId: "r1",
    timestamp: 1782304784564,
    modelId: "gemini-3-flash-a",
    input: 10,
    cacheRead: 20,
    cacheWrite: 0,
    output: 1,
    reasoning: 1
  };
  const stats = await new AntigravityUsageProvider({
    collectUsage: async () => [duplicate, duplicate]
  }).getStats();

  assert.equal(stats.summary.filesScanned, 0);
  assert.equal(stats.summary.totals.eventCount, 1);
  assert.equal(stats.summary.totals.inputTokens, 10);
  assert.equal(stats.warnings.some((warning) => warning.includes("Collapsed 1 duplicate")), true);
});

test("AntigravityUsageProvider does not warn that IDE is closed after empty successful sync", async () => {
  const stats = await new AntigravityUsageProvider({
    collectUsage: async () => []
  }).getStats();

  assert.equal(stats.summary.filesScanned, 0);
  assert.equal(stats.summary.totals.eventCount, 0);
  assert.equal(stats.warnings.some((warning) => warning.includes("Open Antigravity IDE")), false);
});

function antigravityQuotaSummaryPayload(overrides = {}) {
  return {
    response: {
      groups: [
        {
          displayName: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit",
              window: "weekly",
              remainingFraction: 0.9623046,
              resetTime: "2026-07-02T10:34:04Z"
            },
            {
              bucketId: "gemini-5h",
              displayName: "Five Hour Limit",
              window: "5h",
              remainingFraction: 0.7738277,
              resetTime: "2026-06-25T15:34:04Z"
            }
          ]
        },
        {
          displayName: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              bucketId: "3p-weekly",
              displayName: "Weekly Limit",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-07-02T13:04:14Z"
            },
            {
              bucketId: "3p-5h",
              displayName: "Five Hour Limit",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-06-25T18:04:14Z"
            }
          ]
        }
      ],
      ...overrides
    }
  };
}

test("Antigravity quota parser reads confirmed RetrieveUserQuotaSummary buckets", () => {
  const entries = parseAntigravityQuotaEntries(antigravityQuotaSummaryPayload().response.groups);
  const byId = new Map(entries.map((entry) => [entry.limitId, entry]));

  assert.equal(entries.length, 4);
  assert.equal(byId.get("gemini-5h")?.scope, "primary");
  assert.equal(byId.get("gemini-5h")?.windowMinutes, 300);
  assert.equal(byId.get("gemini-weekly")?.scope, "secondary");
  assert.equal(byId.get("gemini-weekly")?.windowMinutes, 10080);
  assert.equal(byId.get("gemini-weekly")?.resetAt, Date.parse("2026-07-02T10:34:04Z"));
  assert.equal(byId.get("gemini-weekly")?.remainingFraction, 0.9623046);
  assert.equal(byId.get("gemini-5h")?.modelScope, "gemini");
  assert.equal(byId.get("3p-5h")?.modelScope, "third-party");
  assert.equal(byId.get("3p-5h")?.remainingFraction, 1);
});

test("Antigravity quota parser rejects unsupported buckets and unknown groups", () => {
  const entries = parseAntigravityQuotaEntries([
    {
      displayName: "Gemini Models",
      description: "Models within this group: Gemini Flash",
      buckets: [
        {
          bucketId: "bad-window",
          window: "monthly",
          remainingFraction: 0.5,
          resetTime: "2026-07-02T10:34:04Z"
        },
        {
          bucketId: "bad-fraction",
          window: "5h",
          remainingFraction: 2,
          resetTime: "2026-07-02T10:34:04Z"
        },
        {
          bucketId: "bad-reset",
          window: "5h",
          remainingFraction: 0.5,
          resetTime: "not-a-date"
        },
        {
          bucketId: "good",
          window: "5h",
          remainingFraction: 0.5,
          resetTime: "2026-07-02T10:34:04Z"
        }
      ]
    },
    {
      displayName: "Autocomplete",
      description: "Non-agent quota",
      buckets: [
        {
          bucketId: "autocomplete-5h",
          window: "5h",
          remainingFraction: 0.1,
          resetTime: "2026-07-02T10:34:04Z"
        }
      ]
    }
  ]);

  assert.deepEqual(entries.map((entry) => entry.limitId), ["good"]);
});


test("AntigravityUsageProvider reconstructs confirmed quota buckets by model pool and window", async () => {
  const payload = antigravityQuotaSummaryPayload();
  const stats = await new AntigravityUsageProvider({
    collectQuota: async () => ({
      fetchedAt: Date.parse("2026-06-25T14:00:00.000Z"),
      entries: parseAntigravityQuotaEntries(payload.response.groups),
      planType: "pro",
      userIdHash: "antigravity-user"
    }),
    collectUsage: async () => [
      {
        type: "usage",
        sessionId: "s1",
        responseId: "gemini-in-5h",
        timestamp: Date.parse("2026-06-25T12:00:00.000Z"),
        modelId: "gemini-3-flash-a",
        input: 100,
        cacheRead: 10,
        cacheWrite: 5,
        output: 20,
        reasoning: 3
      },
      {
        type: "usage",
        sessionId: "s2",
        responseId: "gemini-out-5h",
        timestamp: Date.parse("2026-06-25T10:00:00.000Z"),
        modelId: "gemini-3-flash-a",
        input: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 10,
        reasoning: 0
      },
      {
        type: "usage",
        sessionId: "s3",
        responseId: "claude-in-3p",
        timestamp: Date.parse("2026-06-25T14:00:00.000Z"),
        modelId: "claude-sonnet-4-6",
        input: 200,
        cacheRead: 20,
        cacheWrite: 10,
        output: 30,
        reasoning: 5
      },
      {
        type: "usage",
        sessionId: "s4",
        responseId: "gpt-in-3p",
        timestamp: Date.parse("2026-06-25T15:00:00.000Z"),
        modelId: "gpt-oss-120b",
        input: 300,
        cacheRead: 0,
        cacheWrite: 0,
        output: 40,
        reasoning: 0
      }
    ]
  }).getStats();
  const primary = new Map(stats.primaryLimitWindows.map((row) => [row.limitId, row]));
  const secondary = new Map(stats.secondaryLimitWindows.map((row) => [row.limitId, row]));

  assert.deepEqual(stats.analytics, {
    agentName: "Antigravity",
    userIdHash: "antigravity-user"
  });
  assert.deepEqual([...primary.keys()].sort(), ["3p-5h", "gemini-5h"]);
  assert.deepEqual([...secondary.keys()].sort(), ["3p-weekly", "gemini-weekly"]);
  assert.ok(Math.abs((primary.get("gemini-5h")?.maxUsedPercent ?? 0) - 22.61723) < 0.00001);
  assert.equal(primary.get("3p-5h")?.maxUsedPercent, 0);
  assert.equal(primary.get("gemini-5h")?.totals.inputTokens, 100);
  assert.equal(primary.get("gemini-5h")?.eventCount, 1);
  assert.equal(primary.get("3p-5h")?.totals.inputTokens, 500);
  assert.equal(primary.get("3p-5h")?.eventCount, 2);
  assert.equal(secondary.get("gemini-weekly")?.totals.inputTokens, 100);
  assert.equal(secondary.get("3p-weekly")?.totals.inputTokens, 500);
});

test("AntigravityUsageProvider reconstructs live quota windows from quota snapshot and usage records", async () => {
  const resetAt = Date.parse("2026-06-24T15:00:00.000Z");
  const fetchedAt = Date.parse("2026-06-24T12:45:00.000Z");
  const stats = await new AntigravityUsageProvider({
    collectQuota: async () => ({
      fetchedAt,
      planType: "google-ai-pro",
      userIdHash: null,
      entries: [
        {
          limitId: "gemini-primary",
          modelScope: "gemini",
          remainingFraction: 0.25,
          resetAt,
          windowMinutes: 300,
          scope: "primary"
        }
      ]
    }),
    collectUsage: async () => [
      {
        type: "usage",
        sessionId: "s1",
        responseId: "in-window",
        timestamp: Date.parse("2026-06-24T11:00:00.000Z"),
        modelId: "gemini-3-flash-a",
        input: 100,
        cacheRead: 20,
        cacheWrite: 5,
        output: 10,
        reasoning: 3
      },
      {
        type: "usage",
        sessionId: "s2",
        responseId: "outside-window",
        timestamp: Date.parse("2026-06-24T09:59:59.000Z"),
        modelId: "gemini-3-flash-a",
        input: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 10,
        reasoning: 0
      },
      {
        type: "usage",
        sessionId: "s3",
        responseId: "wrong-model",
        timestamp: Date.parse("2026-06-24T11:30:00.000Z"),
        modelId: "claude-sonnet-4-6",
        input: 500,
        cacheRead: 0,
        cacheWrite: 0,
        output: 10,
        reasoning: 0
      }
    ]
  }).getStats();

  assert.equal(stats.primaryLimitWindows.length, 1);
  assert.equal(stats.secondaryLimitWindows.length, 0);
  const row = stats.primaryLimitWindows[0];
  assert.equal(row.limitId, "gemini-primary");
  assert.equal(row.planType, "google-ai-pro");
  assert.equal(row.windowMinutes, 300);
  assert.equal(row.startTimeUtcIso, "2026-06-24T10:00:00.000Z");
  assert.equal(row.endTimeUtcIso, "2026-06-24T15:00:00.000Z");
  // first/last-seen reflect the single in-window usage record (11:00), not the fetch time.
  assert.equal(row.firstSeenUtcIso, "2026-06-24T11:00:00.000Z");
  assert.equal(row.lastSeenUtcIso, "2026-06-24T11:00:00.000Z");
  assert.equal(row.minUsedPercent, 75);
  assert.equal(row.maxUsedPercent, 75);
  assert.equal(row.eventCount, 1);
  assert.equal(row.totals.eventCount, 1);
  assert.equal(row.totals.inputTokens, 100);
  assert.equal(row.totals.cacheReadInputTokens, 20);
  assert.equal(row.totals.cacheWriteInputTokens, 5);
  assert.equal(row.totals.outputTokens, 10);
  assert.deepEqual(stats.summary.distinctPlanTypes, ["google-ai-pro"]);
});

test("AntigravityUsageProvider returns live quota windows when usage collection fails", async () => {
  const resetAt = Date.parse("2026-06-24T15:00:00.000Z");
  const stats = await new AntigravityUsageProvider({
    collectUsage: async () => {
      throw new Error("sync failed");
    },
    collectQuota: async () => ({
      fetchedAt: Date.parse("2026-06-24T12:45:00.000Z"),
      planType: "unknown",
      userIdHash: null,
      entries: [
        {
          limitId: "shared-primary",
          modelScope: "gemini",
          remainingFraction: 0.6,
          resetAt,
          windowMinutes: 300,
          scope: "primary"
        }
      ]
    })
  }).getStats();

  assert.equal(stats.summary.tokenEvents, 0);
  assert.equal(stats.primaryLimitWindows.length, 1);
  assert.equal(stats.primaryLimitWindows[0].maxUsedPercent, 40);
  assert.equal(stats.primaryLimitWindows[0].eventCount, 0);
  assert.equal(stats.primaryLimitWindows[0].totals.eventCount, 0);
  assert.equal(stats.warnings.some((warning) => warning.includes("Antigravity usage")), true);
});

test("AntigravityUsageProvider returns historical usage when quota collection fails", async () => {
  const stats = await new AntigravityUsageProvider({
    collectQuota: async () => {
      throw new Error("quota failed");
    },
    collectUsage: async () => [
      {
        type: "usage",
        sessionId: "s1",
        responseId: "r1",
        timestamp: 1782304784564,
        modelId: "gemini-3-flash-a",
        input: 10,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1,
        reasoning: 0
      }
    ]
  }).getStats();

  assert.equal(stats.summary.tokenEvents, 1);
  assert.equal(stats.primaryLimitWindows.length, 0);
  assert.equal(stats.warnings.some((warning) => warning.includes("Live Antigravity quota is unavailable")), true);
});

test("AntigravityUsageProvider does not import Tokscale cache as IDE sync", async () => {
  await withTempRoot(async (root) => {
    await writeTokscaleAntigravitySession(root, "session-1.jsonl", [
      JSON.stringify({
        type: "usage",
        sessionId: "s1",
        responseId: "r1",
        timestamp: 1782304784564,
        modelId: "gemini-3-flash-a",
        input: 10,
        cacheRead: 20,
        cacheWrite: 3,
        output: 4,
        reasoning: 2
      })
    ]);

    const stats = await new AntigravityUsageProvider({
      collectUsage: async () => []
    }).getStats();
    const importedFile = path.join(root, ".letmecode", "cache", "antigravity", "sessions", "session-1.jsonl");

    assert.equal(await fileExists(importedFile), false);
    assert.equal(stats.summary.filesScanned, 0);
    assert.equal(stats.summary.totals.eventCount, 0);
    assert.equal(stats.summary.totals.inputTokens, 0);
    assert.equal(stats.warnings.some((warning) => warning.includes("Imported existing normalized Antigravity usage cache")), false);
  });
});

test("CopilotUsageProvider parses only VS Code OTEL usage and ignores old session-state metrics", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotSession(root, "cli-session/events.jsonl", [
      JSON.stringify({
        type: "session.shutdown",
        timestamp: "2026-06-18T20:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5-mini": {
              requests: { count: 2, cost: 0.25 },
              usage: {
                inputTokens: 100,
                cacheReadTokens: 40,
                outputTokens: 10,
                reasoningTokens: 3
              }
            }
          }
        }
      })
    ]);

    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [1781800000, 0],
        attributes: {
          "gen_ai.response.model": "gpt-4.1",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 30,
          "gen_ai.usage.cache_read.input_tokens": 5,
          "gen_ai.usage.output_tokens": 7
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();
    assert.equal(stats.providerId, "copilot");
    assert.equal(stats.providerLabel, "Copilot");
    assert.equal(stats.summary.filesScanned, 1);
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 25);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 5);
    assert.equal(stats.summary.totals.outputTokens, 7);
    assert.equal(stats.summary.totals.reasoningOutputTokens, 0);
    assert.equal(stats.summary.totals.estimatedCredits, 0);
    assert.deepEqual(stats.summary.distinctPlanTypes, []);
    assert.deepEqual(
      stats.modelUsage.map((row) => row.modelId).sort(),
      ["gpt-4.1"]
    );
    assert.equal(stats.dayUsage.length > 0, true);
  });
});

test("CopilotUsageProvider ignores generic OTLP log envelopes", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "1781800000000000000",
                    body: {
                      attributes: {
                        "gen_ai.response.model": "gpt-4.1",
                        "gen_ai.operation.name": "chat",
                        "gen_ai.usage.input_tokens": 30,
                        "gen_ai.usage.cache_read.input_tokens": 5,
                        "gen_ai.usage.output_tokens": 7
                      }
                    }
                  }
                ]
              }
            ]
          }
        ]
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();

    assert.equal(stats.summary.tokenEvents, 0);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 0);
    assert.equal(stats.dayUsage.length, 0);
  });
});

test("CopilotUsageProvider ignores OTLP key/value attributes and unix nano timestamps", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {},
                  {
                    startTimeUnixNano: "1782130578148000000",
                    attributes: [
                      { key: "gen_ai.response.model", value: { stringValue: "gpt-5-mini" } },
                      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                      { key: "gen_ai.usage.input_tokens", value: { intValue: "100000" } },
                      { key: "gen_ai.usage.input_tokens.cached", value: { intValue: "40000" } },
                      { key: "gen_ai.usage.output_tokens", value: { intValue: "1000" } }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();

    assert.equal(stats.summary.tokenEvents, 0);
    assert.equal(stats.summary.totals.inputTokens, 0);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 0);
    assert.equal(stats.dayUsage.length, 0);
  });
});

test("CopilotUsageProvider prefers completion time (startTime over hrTime)", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        startTime: [1782130578, 148000000],
        hrTime: [1782206354, 661000000],
        attributes: {
          "gen_ai.response.model": "gpt-4.1",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 50,
          "gen_ai.usage.output_tokens": 9
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();

    // startTime (1782130578) wins over hrTime (1782206354), which are on
    // different days; the day bucket reflects the startTime day.
    const startDay = new Date(1782130578 * 1000).toISOString().slice(0, 10);
    const hrDay = new Date(1782206354 * 1000).toISOString().slice(0, 10);
    assert.notEqual(startDay, hrDay);
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.dayUsage.length, 1);
    assert.equal(stats.dayUsage[0].dayKey, startDay);
  });
});

test("CopilotUsageProvider parses file exporter hrTime timestamps", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [1782206354, 661000000],
        hrTimeObserved: [1782206354, 661000000],
        attributes: {
          "gen_ai.response.model": "gpt-4.1",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 50,
          "gen_ai.usage.output_tokens": 9
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();

    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.dayUsage.length, 1);
    assert.equal(stats.dayUsage[0].dayKey, "2026-06-23");
  });
});

test("CopilotUsageProvider estimates credits when Copilot telemetry omits premium request cost", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [1782130578, 148000000],
        attributes: {
          "gen_ai.response.model": "gpt-5.4-2026-03-01",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 84275,
          "gen_ai.usage.output_tokens": 328
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();

    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.modelUsage[0].modelId, "gpt-5.4-2026-03-01");
    assert.equal(stats.modelUsage[0].totals.estimatedCredits, 0);
    assert.equal(stats.modelUsage[0].totals.estimatedCreditsStatus, "unavailable");
    assert.equal(stats.modelUsage[0].totals.cacheReadStatus, "unavailable");
    assert.equal(stats.modelUsage[0].totals.cacheWriteStatus, "unavailable");
  });
});

test("CopilotUsageProvider estimates credits for GPT-5 mini OTEL usage", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [1782130578, 148000000],
        attributes: {
          "gen_ai.response.model": "gpt-5-mini",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 100000,
          "gen_ai.usage.cache_read.input_tokens": 40000,
          "gen_ai.usage.output_tokens": 1000
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();

    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.modelUsage[0].modelId, "gpt-5-mini");
    assert.ok(Math.abs(stats.modelUsage[0].totals.estimatedCredits - 1.8) < 0.0000001);
  });
});

test("CopilotUsageProvider reads dotted cache attributes and Claude cache-write usage", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [1782130578, 148000000],
        attributes: {
          "gen_ai.response.model": "claude-haiku-4-5-20251001",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 100000,
          "gen_ai.usage.cache_read.input_tokens": 20000,
          "gen_ai.usage.cache_creation.input_tokens": 10000,
          "gen_ai.usage.output_tokens": 1000,
          "gen_ai.usage.reasoning.output_tokens": 1500
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();

    // Reported input INCLUDES cache-read but NOT cache-write, so uncached input
    // subtracts only cache-read (100000 - 20000); cache-write is additive.
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 20000);
    assert.equal(stats.summary.totals.inputTokens, 80000);
    assert.equal(stats.summary.totals.cacheWriteInputTokens, 10000);
    assert.equal(stats.summary.totals.outputTokens, 1000);
    assert.equal(stats.summary.totals.reasoningOutputTokens, 1000);
    assert.equal(stats.summary.totals.totalTokens, 111000);
    assert.ok(Math.abs(stats.summary.totals.estimatedCredits - 9.95) < 0.0000001);
  });
});

test("CopilotUsageProvider leaves GPT-4o mini credits unknown and estimates Claude Haiku Copilot models", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [1782130578, 148000000],
        attributes: {
          "gen_ai.response.model": "gpt-4o-mini-2024-07-18",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 20527,
          "gen_ai.usage.output_tokens": 283
        }
      }),
      JSON.stringify({
        hrTime: [1782130580, 148000000],
        attributes: {
          "gen_ai.response.model": "claude-haiku-4-5-20251001",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 261123,
          "gen_ai.usage.output_tokens": 874
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();
    const byModel = new Map(stats.modelUsage.map((row) => [row.modelId, row.totals]));

    assert.equal(byModel.get("gpt-4o-mini-2024-07-18")?.estimatedCredits, 0);
    assert.equal(byModel.get("gpt-4o-mini-2024-07-18")?.estimatedCreditsStatus, "unavailable");
    assert.equal(byModel.get("claude-haiku-4-5-20251001")?.estimatedCredits, 0);
    assert.equal(byModel.get("claude-haiku-4-5-20251001")?.estimatedCreditsStatus, "unavailable");
  });
});

test("CopilotUsageProvider treats Copilot NES and suggestion models as non-billable", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [1782130578, 148000000],
        attributes: {
          "gen_ai.response.model": "copilot-nes",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 1000,
          "gen_ai.usage.output_tokens": 20
        }
      }),
      JSON.stringify({
        hrTime: [1782130580, 148000000],
        attributes: {
          "gen_ai.response.model": "copilot-suggestion-2026-01-01",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 2000,
          "gen_ai.usage.output_tokens": 30
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();
    const byModel = new Map(stats.modelUsage.map((row) => [row.modelId, row.totals]));

    assert.equal(stats.summary.totals.inputTokens, 3000);
    assert.equal(stats.summary.totals.outputTokens, 50);
    assert.equal(stats.summary.totals.estimatedCredits, 0);
    assert.equal(byModel.get("copilot-nes")?.estimatedCredits, 0);
    assert.equal(byModel.get("copilot-suggestion-2026-01-01")?.estimatedCredits, 0);
  });
});

test("CopilotUsageProvider applies long-context rates for large GPT-5.4 and GPT-5.5 chat calls", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [1782130578, 148000000],
        attributes: {
          "gen_ai.response.model": "gpt-5.4-2026-03-01",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 272001,
          "gen_ai.usage.output_tokens": 1000
        }
      }),
      JSON.stringify({
        hrTime: [1782130580, 148000000],
        attributes: {
          "gen_ai.response.model": "gpt-5.5-2026-06-01",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 272001,
          "gen_ai.usage.cache_read.input_tokens": 72001,
          "gen_ai.usage.output_tokens": 1000
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();
    const byModel = new Map(stats.modelUsage.map((row) => [row.modelId, row.totals]));

    assert.equal(byModel.get("gpt-5.4-2026-03-01")?.estimatedCredits, 0);
    assert.equal(byModel.get("gpt-5.4-2026-03-01")?.estimatedCreditsStatus, "unavailable");
    assert.ok(Math.abs((byModel.get("gpt-5.5-2026-06-01")?.estimatedCredits ?? 0) - 211.7001) < 0.0000001);
  });
});

test("CopilotUsageProvider applies model-specific long-context thresholds", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [1782130578, 148000000],
        attributes: {
          "gen_ai.response.model": "gemini-3.1-pro",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 200001,
          "gen_ai.usage.output_tokens": 1000
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();

    assert.equal(stats.summary.totals.estimatedCredits, 0);
    assert.equal(stats.summary.totals.estimatedCreditsStatus, "unavailable");
  });
});

test("CopilotUsageProvider counts only Copilot chat spans instead of invoke_agent aggregate usage", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [1782130578, 148000000],
        attributes: {
          "gen_ai.trace.id": "trace-agent-1",
          "gen_ai.response.model": "gpt-5.4-2026-03-01",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 84275,
          "gen_ai.usage.output_tokens": 328
        }
      }),
      JSON.stringify({
        hrTime: [1782130578, 154000000],
        attributes: {
          "gen_ai.trace.id": "trace-agent-1",
          "event.name": "copilot_chat.agent.turn",
          "gen_ai.operation.name": "invoke_agent",
          "turn.index": 0,
          "gen_ai.usage.input_tokens": 84275,
          "gen_ai.usage.output_tokens": 328
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();

    // The invoke_agent record is an aggregate (agent-summary-span) sharing the
    // chat span's trace, so it is suppressed; only the granular chat span counts.
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 84275);
    assert.deepEqual(stats.modelUsage.map((row) => row.modelId), ["gpt-5.4-2026-03-01"]);
  });
});

test("configureCopilotVsCodeLogging writes user settings for file OTEL export", async () => {
  await withTempRoot(async (root) => {
    const settingsPath = path.join(root, "Code", "User", "settings.json");
    const outfile = path.join(root, ".copilot", "otel", "vscode.jsonl");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      [
        "{",
        "    // Keep this comment",
        '    "editor.tabSize": 2,',
        '    "example.url": "https://example.com/path//inside-string"',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await configureCopilotVsCodeLogging({ root, settingsPath });
    const rawSettings = await fs.readFile(settingsPath, "utf8");
    const settings = parseJsonc(rawSettings);

    assert.equal(result.changed, true);
    assert.equal(result.outfile, outfile);
    assert.equal(result.settingsPath, settingsPath);
    assert.equal(await fileExists(outfile), false);
    assert.equal(rawSettings.includes("// Keep this comment"), true);
    assert.equal(settings["example.url"], "https://example.com/path//inside-string");
    assert.equal(settings["editor.tabSize"], 2);
    assert.equal(settings["github.copilot.chat.otel.enabled"], true);
    assert.equal(settings["github.copilot.chat.otel.exporterType"], "file");
    assert.equal(settings["github.copilot.chat.otel.outfile"], outfile);
    assert.equal(settings["github.copilot.chat.otel.captureContent"], false);

    const unchangedResult = await configureCopilotVsCodeLogging({ root, settingsPath });
    assert.equal(unchangedResult.changed, false);
  });
});

test("configureCopilotVsCodeLogging falls back to Insiders when Stable user settings root is missing", async () => {
  await withTempRoot(async (root) => {
    const insidersSettingsPath = path.join(root, ".config", "Code - Insiders", "User", "settings.json");
    await fs.mkdir(path.dirname(insidersSettingsPath), { recursive: true });

    const result = await configureCopilotVsCodeLogging({ root });

    assert.equal(result.settingsPath, insidersSettingsPath);
    assert.equal(await fileExists(path.join(root, ".config", "Code", "User", "settings.json")), false);

    const settings = parseJsonc(await fs.readFile(insidersSettingsPath, "utf8"));
    assert.equal(settings["github.copilot.chat.otel.enabled"], true);
    assert.equal(settings["github.copilot.chat.otel.exporterType"], "file");
    assert.equal(settings["github.copilot.chat.otel.outfile"], path.join(root, ".copilot", "otel", "vscode.jsonl"));
    assert.equal(settings["github.copilot.chat.otel.captureContent"], false);
  });
});

test("CopilotUsageProvider warns when VS Code logging is enabled but no OTEL file exists yet", async () => {
  await withTempRoot(async (root) => {
    const outfile = path.join(root, ".copilot", "otel", "vscode.jsonl");
    const settingsPath = path.join(root, ".config", "Code", "User", "settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          "github.copilot.chat.otel.enabled": true,
          "github.copilot.chat.otel.exporterType": "file",
          "github.copilot.chat.otel.outfile": outfile
        },
        null,
        2
      ),
      "utf8"
    );

    const stats = await new CopilotUsageProvider({ root, env: {}, fetchUserInfo: copilotNoQuota }).getStats();

    assert.equal(stats.summary.tokenEvents, 0);
    assert.equal(
      stats.warnings.some((warning) => warning.includes("has not been created yet")),
      true
    );
  });
});

test("CopilotUsageProvider returns OTEL usage even when quota loading fails", async () => {
  await withTempRoot(async (root) => {
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [1782130578, 148000000],
        attributes: {
          "gen_ai.response.model": "gpt-5-mini",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 120,
          "gen_ai.usage.output_tokens": 12
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({
      root,
      env: {},
      fetchUserInfo: async () => {
        throw new Error("quota down");
      }
    }).getStats();

    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 120);
    assert.equal(stats.primaryLimitWindows.length, 0);
    assert.equal(
      stats.warnings.some((w) => w.includes("plan and quota are unavailable")),
      true
    );
  });
});

test("CopilotUsageProvider returns quota windows even when no OTEL files exist", async () => {
  await withTempRoot(async (root) => {
    const stats = await new CopilotUsageProvider({
      root,
      env: {},
      fetchUserInfo: async () => ({
        quotaInfo: {
          plan: "copilot_pro",
          quotas: [{ id: "chat", label: "Chat", usedPercent: 30, remainingPercent: 70 }]
        },
        warnings: []
      })
    }).getStats();

    assert.equal(stats.summary.tokenEvents, 0);
    assert.deepEqual(stats.summary.distinctPlanTypes, ["copilot_pro"]);
    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].limitId, "chat");
    assert.equal(stats.primaryLimitWindows[0].maxUsedPercent, 30);
    assert.equal(
      stats.warnings.some((w) => w.includes("No Copilot OTEL files were found")),
      true
    );
  });
});

test("CopilotUsageProvider joins the AI Credits window with in-window OTEL usage", async () => {
  await withTempRoot(async (root) => {
    const inWindowSec = Math.floor(Date.UTC(2026, 5, 15) / 1000); // 2026-06-15
    const beforeWindowSec = Math.floor(Date.UTC(2026, 4, 15) / 1000); // 2026-05-15 (outside)
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [inWindowSec, 0],
        attributes: {
          "gen_ai.response.model": "claude-haiku-4-5-20251001",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 100000,
          "gen_ai.usage.cache_read.input_tokens": 20000,
          "gen_ai.usage.cache_creation.input_tokens": 10000,
          "gen_ai.usage.output_tokens": 1000
        }
      }),
      JSON.stringify({
        hrTime: [beforeWindowSec, 0],
        attributes: {
          "gen_ai.response.model": "gpt-5-mini",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 500,
          "gen_ai.usage.output_tokens": 50
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({
      root,
      env: {},
      fetchUserInfo: async () => ({
        quotaInfo: {
          plan: "individual",
          tokenBasedBilling: true,
          resetAt: "2026-07-01T00:00:00.000Z",
          quotas: [
            { id: "chat", label: "Chat", unlimited: true },
            { id: "completions", label: "Completions", unlimited: true },
            {
              id: "premium_interactions",
              label: "Premium",
              total: 1500,
              used: 28.2,
              remaining: 1471.8,
              usedPercent: 1.9,
              remainingPercent: 98.1
            }
          ]
        },
        warnings: []
      })
    }).getStats();

    // All-time summary counts BOTH events; the window must not restrict it.
    assert.equal(stats.summary.tokenEvents, 2);

    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.secondaryLimitWindows.length, 0); // chat/completions unlimited
    const row = stats.primaryLimitWindows[0];
    assert.equal(row.limitId, "premium_interactions");
    assert.equal(row.modelType, "AI Credits");
    assert.equal(row.startTimeUtcIso, "2026-06-01T00:00:00.000Z");
    assert.equal(row.endTimeUtcIso, "2026-07-01T00:00:00.000Z");
    assert.equal(row.windowMinutes, 30 * 24 * 60); // June = 30 days
    assert.equal(row.maxUsedPercent, 1.9); // official quota percentage from the API
    // Totals = only the in-window OTEL event.
    assert.equal(row.eventCount, 1);
    assert.equal(row.totals.inputTokens, 80000);
    assert.equal(row.totals.cacheReadInputTokens, 20000);
    assert.equal(row.totals.cacheWriteInputTokens, 10000);
    assert.ok(row.totals.estimatedCredits > 0); // API-equivalent cost from local pricing
    assert.notEqual(row.totals.estimatedCreditsStatus, "unavailable");
    assert.equal(
      stats.warnings.some((w) => w.includes("cache token counts")),
      false
    ); // cache attributes were present, so no cache warning
  });
});

test("CopilotUsageProvider warns when cache tokens are missing so cost cannot be estimated", async () => {
  await withTempRoot(async (root) => {
    const inWindowSec = Math.floor(Date.UTC(2026, 5, 15) / 1000);
    await writeCopilotOtel(root, [
      JSON.stringify({
        hrTime: [inWindowSec, 0],
        attributes: {
          "gen_ai.response.model": "gpt-5-mini",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 1000,
          "gen_ai.usage.output_tokens": 100
        } // no cache_read / cache_write attributes
      })
    ]);

    const stats = await new CopilotUsageProvider({
      root,
      env: {},
      fetchUserInfo: async () => ({
        quotaInfo: {
          plan: "individual",
          tokenBasedBilling: true,
          resetAt: "2026-07-01T00:00:00.000Z",
          quotas: [{ id: "premium_interactions", label: "Premium", total: 1500, used: 28.2, usedPercent: 1.9 }]
        },
        warnings: []
      })
    }).getStats();

    const row = stats.primaryLimitWindows[0];
    assert.equal(row.eventCount, 1);
    assert.equal(row.totals.estimatedCreditsStatus, "unavailable"); // cost unknown
    assert.equal(
      stats.warnings.some((w) => w.includes("cache token counts")),
      true
    );
  });
});

test("CopilotUsageProvider flags incomplete telemetry when official usage has no local events", async () => {
  await withTempRoot(async (root) => {
    const stats = await new CopilotUsageProvider({
      root,
      env: {},
      fetchUserInfo: async () => ({
        quotaInfo: {
          plan: "individual",
          tokenBasedBilling: true,
          resetAt: "2026-07-01T00:00:00.000Z",
          quotas: [
            { id: "premium_interactions", label: "Premium", total: 1500, used: 28.2, usedPercent: 1.9 }
          ]
        },
        warnings: []
      })
    }).getStats();

    assert.equal(stats.primaryLimitWindows.length, 1);
    const row = stats.primaryLimitWindows[0];
    assert.equal(row.eventCount, 0);
    // Not a trusted $0 — cost is marked unknown for the UI to render "-".
    assert.equal(row.totals.estimatedCreditsStatus, "unavailable");
    assert.equal(
      stats.warnings.some((w) => w.includes("Local token totals are incomplete")),
      true
    );
  });
});

test("CopilotUsageProvider shows only metered quota buckets, not unlimited ones", async () => {
  await withTempRoot(async (root) => {
    const stats = await new CopilotUsageProvider({
      root,
      env: {},
      fetchUserInfo: async () => ({
        quotaInfo: {
          plan: "individual",
          quotas: [
            { id: "chat", label: "Chat", unlimited: true, usedPercent: 0, remainingPercent: 100 },
            { id: "completions", label: "Completions", unlimited: true, usedPercent: 0, remainingPercent: 100 },
            { id: "premium_interactions", label: "Premium", usedPercent: 2, remainingPercent: 98 }
          ]
        },
        warnings: []
      })
    }).getStats();

    const allWindows = [...stats.primaryLimitWindows, ...stats.secondaryLimitWindows];
    assert.deepEqual(allWindows.map((w) => w.limitId), ["premium_interactions"]);
    assert.equal(stats.primaryLimitWindows[0].maxUsedPercent, 2);
    // Unlimited buckets are not "unknown" — they must not produce that warning.
    assert.equal(
      stats.warnings.some((w) => w.includes("quota usage is unknown")),
      false
    );
  });
});

test("CopilotUsageProvider omits an unknown-usage quota window and warns", async () => {
  await withTempRoot(async (root) => {
    const stats = await new CopilotUsageProvider({
      root,
      env: {},
      fetchUserInfo: async () => ({
        quotaInfo: {
          plan: "copilot_pro",
          quotas: [{ id: "chat", label: "Chat" }] // no usable percent/total
        },
        warnings: []
      })
    }).getStats();

    assert.equal(stats.primaryLimitWindows.length, 0);
    assert.equal(stats.secondaryLimitWindows.length, 0);
    assert.equal(
      stats.warnings.some((w) => w.includes("quota usage is unknown for: Chat")),
      true
    );
  });
});

test("CopilotUsageProvider does not duplicate warnings", async () => {
  await withTempRoot(async (root) => {
    const stats = await new CopilotUsageProvider({
      root,
      env: {},
      fetchUserInfo: copilotNoQuota
    }).getStats();
    assert.equal(stats.warnings.length, new Set(stats.warnings).size);
  });
});

test("CodexUsageProvider returns valid ProviderStats", async () => {
  await withTempRoot(async (root) => {
    await writeSession(root, "2026/06/18/fixture.jsonl", [
      turnContext("gpt-5.5"),
      tokenEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        total: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 110
        },
        last: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 110
        },
        primary: { used_percent: 1, window_minutes: 300, resets_at: 1780589753 }
      })
    ]);

    const stats = await new CodexUsageProvider({ root }).getStats();
    assert.equal(stats.providerId, "codex");
    assert.equal(stats.providerLabel, "Codex");
    assert.equal(stats.summary.filesScanned, 1);
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.modelUsage.length, 1);
    assert.equal(stats.modelUsage[0].modelId, "gpt-5.5");
    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].startTimeUtcIso.endsWith("Z"), true);
    assert.equal(stats.primaryLimitWindows[0].endTimeUtcIso.endsWith("Z"), true);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 80);
    assert.equal(stats.primaryLimitWindows[0].totals.cacheReadInputTokens, 20);
    assert.equal(stats.primaryLimitWindows[0].totals.outputTokens, 10);
    assert.equal(stats.primaryLimitWindows[0].totals.eventCount, 1);
    assert.equal(stats.dayUsage.length, 1);
    assert.equal(stats.dayUsage[0].dayKey, "2026-06-18");
    assert.equal(stats.dayUsage[0].totals.inputTokens, 80);
    assert.deepEqual(stats.dayUsage[0].distinctModels, ["gpt-5.5"]);
    assert.deepEqual(stats.dayUsage[0].distinctPlanTypes, ["team"]);
    assert.deepEqual(stats.secondaryLimitWindows, []);
  });
});

test("CodexUsageProvider groups usage into descending day buckets", async () => {
  await withTempRoot(async (root) => {
    await writeSession(root, "2026/06/18/day-buckets.jsonl", [
      turnContext("gpt-5.5"),
      tokenEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        total: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 110
        },
        last: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 110
        },
        primary: { used_percent: 1, window_minutes: 300, resets_at: 1780589753 }
      }),
      tokenEvent({
        timestamp: "2026-06-19T08:00:01.000Z",
        total: {
          input_tokens: 180,
          cached_input_tokens: 40,
          output_tokens: 20,
          reasoning_output_tokens: 7,
          total_tokens: 200
        },
        last: {
          input_tokens: 80,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 2,
          total_tokens: 90
        },
        planType: "plus",
        primary: { used_percent: 4, window_minutes: 300, resets_at: 1780675200 }
      })
    ]);

    const stats = await new CodexUsageProvider({ root }).getStats();
    assert.deepEqual(
      stats.dayUsage.map((row) => row.dayKey),
      ["2026-06-19", "2026-06-18"]
    );
    assert.equal(stats.dayUsage[0].totals.inputTokens, 60);
    assert.equal(stats.dayUsage[0].totals.cacheReadInputTokens, 20);
    assert.equal(stats.dayUsage[0].totals.outputTokens, 10);
    assert.deepEqual(stats.dayUsage[0].distinctPlanTypes, ["plus"]);
    assert.equal(stats.dayUsage[0].firstEventUtcIso, "2026-06-19T08:00:01Z");
    assert.equal(stats.dayUsage[0].lastEventUtcIso, "2026-06-19T08:00:01Z");
    assert.equal(stats.dayUsage[1].totals.inputTokens, 80);
    assert.deepEqual(stats.dayUsage[1].distinctPlanTypes, ["team"]);
  });
});

test("parser handles cumulative fallback, multiple models, unknown model warnings, and window caps", async () => {
  await withTempRoot(async (root) => {
    const lines = [turnContext("gpt-5.5")];

    lines.push(
      tokenEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        total: {
          input_tokens: 100,
          cached_input_tokens: 10,
          output_tokens: 20,
          reasoning_output_tokens: 3,
          total_tokens: 120
        },
        primary: { used_percent: 10, window_minutes: 300, resets_at: 1780589753 },
        secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1781176553 }
      })
    );

    lines.push(
      tokenEvent({
        timestamp: "2026-06-18T20:01:01.000Z",
        total: {
          input_tokens: 180,
          cached_input_tokens: 30,
          output_tokens: 35,
          reasoning_output_tokens: 5,
          total_tokens: 215
        },
        primary: { used_percent: 11, window_minutes: 300, resets_at: 1780589753 },
        secondary: { used_percent: 2, window_minutes: 10080, resets_at: 1781176553 }
      })
    );

    lines.push(turnContext("gpt-5.4-mini"));
    lines.push(
      tokenEvent({
        timestamp: "2026-06-18T20:02:01.000Z",
        total: {
          input_tokens: 300,
          cached_input_tokens: 100,
          output_tokens: 55,
          reasoning_output_tokens: 8,
          total_tokens: 355
        },
        last: {
          input_tokens: 120,
          cached_input_tokens: 40,
          output_tokens: 20,
          reasoning_output_tokens: 3,
          total_tokens: 140
        },
        planType: "plus",
        primary: { used_percent: 5, window_minutes: 300, resets_at: 1780590053 },
        secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1781176853 }
      })
    );

    lines.push(turnContext("gpt-9"));
    lines.push("{ definitely not json");
    for (let index = 0; index < 6; index += 1) {
      lines.push(
        tokenEvent({
          timestamp: `2026-06-18T20:${10 + index}:01.000Z`,
          total: {
            input_tokens: 400 + index * 10,
            cached_input_tokens: 100 + index * 5,
            output_tokens: 60 + index,
            reasoning_output_tokens: 8,
            total_tokens: 460 + index * 11
          },
          last: {
            input_tokens: 10,
            cached_input_tokens: 5,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            total_tokens: 11
          },
          primary: { used_percent: 20 + index, window_minutes: 300, resets_at: 1780591053 + index * 60 },
          secondary: { used_percent: 4 + index, window_minutes: 10080, resets_at: 1781177853 + index * 60 }
        })
      );
    }

    await writeSession(root, "2026/06/18/fixture.jsonl", lines);

    const stats = await new CodexUsageProvider({ root }).getStats();
    assert.equal(stats.summary.filesScanned, 1);
    assert.equal(stats.summary.linesRead, lines.length);
    assert.equal(stats.summary.tokenEvents, 9);
    assert.equal(stats.summary.totals.eventCount, 9);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 100);
    assert.equal(stats.summary.totals.inputTokens, 260);
    assert.equal(stats.summary.totals.outputTokens, 61);
    assert.equal(stats.summary.distinctModels.includes("gpt-5.5"), true);
    assert.equal(stats.summary.distinctModels.includes("gpt-5.4-mini"), true);
    assert.equal(stats.summary.distinctModels.includes("gpt-9"), true);
    assert.deepEqual(stats.summary.distinctPlanTypes, ["plus", "team"]);
    assert.equal(stats.modelUsage[0].modelId, "gpt-5.5");
    assert.equal(stats.primaryLimitWindows.length, 5);
    assert.equal(stats.secondaryLimitWindows.length, 5);
    assert.equal(stats.primaryLimitWindows[0].endTimeUtcIso > stats.primaryLimitWindows[4].endTimeUtcIso, true);
    assert.equal(stats.primaryLimitWindows[0].startTimeUtcIso.endsWith("Z"), true);
    assert.equal(stats.secondaryLimitWindows[0].endTimeUtcIso.endsWith("Z"), true);
    assert.equal(stats.primaryLimitWindows[0].eventCount, stats.primaryLimitWindows[0].totals.eventCount);
    assert.equal(stats.secondaryLimitWindows[0].eventCount, stats.secondaryLimitWindows[0].totals.eventCount);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens > 0, true);
    assert.equal(stats.warnings.some((warning) => warning.includes("malformed")), true);
    assert.equal(stats.warnings.some((warning) => warning.includes("gpt-9")), true);
    assert.equal(stats.modelUsage.find((row) => row.modelId === "gpt-9")?.totals.estimatedCreditsStatus, "unavailable");
  });
});

test("CodexUsageProvider suppresses missing-rate warnings for hidden internal Codex models", async () => {
  await withTempRoot(async (root) => {
    await writeCodexModelsCache(root, [
      { slug: "codex-auto-review", visibility: "hide" }
    ]);

    await writeSession(root, "2026/06/22/auto-review.jsonl", [
      turnContext("codex-auto-review"),
      tokenEvent({
        timestamp: "2026-06-22T14:10:31.000Z",
        total: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 0,
          total_tokens: 110
        },
        last: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 0,
          total_tokens: 110
        },
        primary: { used_percent: 1, window_minutes: 300, resets_at: 1782139200 }
      })
    ]);

    const stats = await new CodexUsageProvider({ root }).getStats();
    const autoReviewTotals = stats.modelUsage.find((row) => row.modelId === "codex-auto-review")?.totals;

    assert.equal(autoReviewTotals?.estimatedCredits, 0);
    assert.notEqual(autoReviewTotals?.estimatedCreditsStatus, "unavailable");
    assert.notEqual(stats.summary.totals.estimatedCreditsStatus, "unavailable");
    assert.equal(stats.warnings.some((warning) => warning.includes("codex-auto-review")), false);
  });
});

test("limit window totals stop accumulating after a seen window first reaches 100 percent", async () => {
  await withTempRoot(async (root) => {
    await writeSession(root, "2026/06/18/saturated-window.jsonl", [
      turnContext("gpt-5.5"),
      tokenEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        total: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 110
        },
        last: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 110
        },
        primary: { used_percent: 99, window_minutes: 300, resets_at: 1780589753 }
      }),
      tokenEvent({
        timestamp: "2026-06-18T20:01:01.000Z",
        total: {
          input_tokens: 220,
          cached_input_tokens: 40,
          output_tokens: 25,
          reasoning_output_tokens: 8,
          total_tokens: 245
        },
        last: {
          input_tokens: 120,
          cached_input_tokens: 20,
          output_tokens: 15,
          reasoning_output_tokens: 3,
          total_tokens: 135
        },
        primary: { used_percent: 100, window_minutes: 300, resets_at: 1780589753 }
      }),
      tokenEvent({
        timestamp: "2026-06-18T20:02:01.000Z",
        total: {
          input_tokens: 360,
          cached_input_tokens: 70,
          output_tokens: 40,
          reasoning_output_tokens: 12,
          total_tokens: 400
        },
        last: {
          input_tokens: 140,
          cached_input_tokens: 30,
          output_tokens: 15,
          reasoning_output_tokens: 4,
          total_tokens: 155
        },
        primary: { used_percent: 100, window_minutes: 300, resets_at: 1780589753 }
      })
    ]);

    const stats = await new CodexUsageProvider({ root }).getStats();
    assert.equal(stats.summary.tokenEvents, 3);
    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].minUsedPercent, 99);
    assert.equal(stats.primaryLimitWindows[0].maxUsedPercent, 100);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 180);
    assert.equal(stats.primaryLimitWindows[0].totals.cacheReadInputTokens, 40);
    assert.equal(stats.primaryLimitWindows[0].totals.outputTokens, 25);
    assert.equal(stats.primaryLimitWindows[0].totals.eventCount, 2);
    assert.equal(stats.summary.totals.inputTokens, 290);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 70);
    assert.equal(stats.summary.totals.outputTokens, 40);
    assert.equal(stats.summary.totals.eventCount, 3);
  });
});

test("limit window saturation is based on event timestamps, not parse order", async () => {
  await withTempRoot(async (root) => {
    await writeSession(root, "2026/06/18/out-of-order-window.jsonl", [
      turnContext("gpt-5.5"),
      tokenEvent({
        timestamp: "2026-06-18T20:02:01.000Z",
        total: {
          input_tokens: 220,
          cached_input_tokens: 40,
          output_tokens: 25,
          reasoning_output_tokens: 8,
          total_tokens: 245
        },
        last: {
          input_tokens: 120,
          cached_input_tokens: 20,
          output_tokens: 15,
          reasoning_output_tokens: 3,
          total_tokens: 135
        },
        primary: { used_percent: 100, window_minutes: 300, resets_at: 1780589753 }
      }),
      tokenEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        total: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 110
        },
        last: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 110
        },
        primary: { used_percent: 99, window_minutes: 300, resets_at: 1780589753 }
      }),
      tokenEvent({
        timestamp: "2026-06-18T20:03:01.000Z",
        total: {
          input_tokens: 360,
          cached_input_tokens: 70,
          output_tokens: 40,
          reasoning_output_tokens: 12,
          total_tokens: 400
        },
        last: {
          input_tokens: 140,
          cached_input_tokens: 30,
          output_tokens: 15,
          reasoning_output_tokens: 4,
          total_tokens: 155
        },
        primary: { used_percent: 100, window_minutes: 300, resets_at: 1780589753 }
      })
    ]);

    const stats = await new CodexUsageProvider({ root }).getStats();
    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 180);
    assert.equal(stats.primaryLimitWindows[0].totals.cacheReadInputTokens, 40);
    assert.equal(stats.primaryLimitWindows[0].totals.outputTokens, 25);
    assert.equal(stats.primaryLimitWindows[0].totals.eventCount, 2);
  });
});

test("missing sessions directory yields empty but friendly stats", async () => {
  await withTempRoot(async (root) => {
    const stats = await new CodexUsageProvider({ root }).getStats();
    assert.equal(stats.summary.filesScanned, 0);
    assert.equal(stats.summary.tokenEvents, 0);
    assert.equal(stats.modelUsage.length, 0);
    assert.equal(stats.dayUsage.length, 0);
    assert.equal(stats.primaryLimitWindows.length, 0);
    assert.equal(stats.secondaryLimitWindows.length, 0);
    assert.equal(stats.warnings.some((warning) => warning.includes("No Codex session files found")), true);
  });
});

test("CodexUsageProvider exposes anonymous analytics identity from auth.json", async () => {
  await withTempRoot(async (root) => {
    await writeCodexAuth(root, {
      auth_mode: "chatgpt",
      tokens: {
        id_token: fakeJwt({
          email: "ivan@devforth.io",
          "https://api.openai.com/auth": {
            organizations: [
              { id: "org-devforth", title: "devforth", is_default: true },
              { id: "org-personal", title: "Personal", is_default: false }
            ]
          }
        })
      }
    });
    await writeSession(root, "2026/06/18/fixture.jsonl", [
      turnContext("gpt-5.4"),
      tokenEvent({
        timestamp: "2026-06-18T20:00:00.000Z",
        total: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          total_tokens: 110
        },
        primary: { used_percent: 3, window_minutes: 300, resets_at: 1780589753 }
      })
    ]);

    const stats = await new CodexUsageProvider({ root }).getStats();
    assert.deepEqual(stats.analytics, {
      agentName: "Codex",
      userIdHash: createHash("md5").update("Codex-ivan@devforth.io-org-devforth-devforth").digest("hex")
    });
  });
});

test("ClaudeUsageProvider dedupes repeated assistant transcript entries and parses optional limit windows", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/session.jsonl", [
      JSON.stringify({
        type: "user",
        sessionId: "claude-session-1",
        timestamp: "2026-06-18T20:00:00.000Z",
        message: { role: "user", content: "hello" }
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        requestId: "req-1",
        messageId: "msg-1",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        cacheReadInputTokens: 50,
        cacheCreation5mInputTokens: 20,
        outputTokens: 10,
        rateLimits: {
          limit_id: "claude",
          plan_type: "max",
          primary: { used_percent: 3, window_minutes: 300, resets_at: 1780589753 }
        }
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.100Z",
        requestId: "req-1",
        messageId: "msg-1",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        cacheReadInputTokens: 50,
        cacheCreation5mInputTokens: 20,
        outputTokens: 10,
        rateLimits: {
          limit_id: "claude",
          plan_type: "max",
          primary: { used_percent: 3, window_minutes: 300, resets_at: 1780589753 }
        }
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-19T20:05:01.000Z",
        requestId: "req-2",
        messageId: "msg-2",
        model: "claude-opus-4-8",
        inputTokens: 40,
        cacheReadInputTokens: 30,
        cacheCreation1hInputTokens: 10,
        outputTokens: 5
      })
    ]);

    const stats = await new ClaudeUsageProvider({ root }).getStats();
    assert.equal(stats.providerId, "claude");
    assert.equal(stats.providerLabel, "Claude");
    assert.equal(stats.summary.filesScanned, 1);
    assert.equal(stats.summary.tokenEvents, 2);
    assert.equal(stats.summary.totals.inputTokens, 140);
    assert.equal(stats.summary.totals.cacheWrite5mInputTokens, 20);
    assert.equal(stats.summary.totals.cacheWrite1hInputTokens, 10);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 80);
    assert.equal(stats.summary.totals.outputTokens, 15);
    assert.equal(stats.modelUsage.length, 2);
    assert.deepEqual(
      stats.dayUsage.map((row) => row.dayKey),
      ["2026-06-19", "2026-06-18"]
    );
    assert.equal(stats.dayUsage[0].totals.inputTokens, 40);
    assert.equal(stats.dayUsage[0].totals.outputTokens, 5);
    assert.deepEqual(stats.dayUsage[0].distinctPlanTypes, []);
    assert.equal(stats.dayUsage[1].totals.inputTokens, 100);
    assert.deepEqual(stats.dayUsage[1].distinctPlanTypes, ["max"]);
    assert.deepEqual(
      stats.modelUsage.map((row) => row.modelId).sort(),
      ["claude-opus-4-8", "claude-sonnet-4-6"]
    );
    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].totals.eventCount, 1);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 100);
    assert.equal(stats.summary.distinctPlanTypes.includes("max"), true);
    assert.deepEqual(stats.secondaryLimitWindows, []);
    assert.equal(stats.warnings.some((warning) => warning.includes("Collapsed 1 duplicate Claude usage event")), false);

    const verboseStats = await new ClaudeUsageProvider({ root }).getStats({ verbose: true });
    assert.equal(verboseStats.warnings.some((warning) => warning.includes("Collapsed 1 duplicate Claude usage event")), true);
  });
});

test("ClaudeUsageProvider merges keyed usage rows by per-field maxima instead of first-write-wins", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/key-collision.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        requestId: "req-1",
        messageId: "msg-1",
        model: "claude-sonnet-4-6",
        inputTokens: 40,
        cacheReadInputTokens: 10,
        outputTokens: 5,
        rateLimits: {
          limit_id: "claude",
          plan_type: "max",
          primary: { used_percent: 1, window_minutes: 300, resets_at: 1780589753 }
        }
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:02.000Z",
        requestId: "req-1",
        messageId: "msg-1",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        cacheReadInputTokens: 50,
        cacheCreation5mInputTokens: 20,
        outputTokens: 10,
        rateLimits: {
          limit_id: "claude",
          plan_type: "max",
          primary: { used_percent: 3, window_minutes: 300, resets_at: 1780589753 }
        }
      })
    ]);

    const stats = await new ClaudeUsageProvider({ root }).getStats();
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 100);
    assert.equal(stats.summary.totals.cacheWrite5mInputTokens, 20);
    assert.equal(stats.summary.totals.cacheWrite1hInputTokens, 0);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 50);
    assert.equal(stats.summary.totals.outputTokens, 10);
    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 100);
    assert.equal(
      stats.warnings.some((warning) => warning.includes("per-field maxima")),
      false
    );

    const verboseStats = await new ClaudeUsageProvider({ root }).getStats({ verbose: true });
    assert.equal(
      verboseStats.warnings.some((warning) => warning.includes("per-field maxima")),
      true
    );
  });
});

test("ClaudeUsageProvider dedupes keyed usage rows even when duplicate copies expose different ID subsets", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/mixed-key-aliases.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        requestId: "req-mixed-ids",
        messageId: "msg-mixed-ids",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        cacheReadInputTokens: 50,
        outputTokens: 10
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:02.000Z",
        messageId: "msg-mixed-ids",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        cacheReadInputTokens: 50,
        outputTokens: 10
      })
    ]);

    const stats = await new ClaudeUsageProvider({ root }).getStats();
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 100);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 50);
    assert.equal(stats.summary.totals.outputTokens, 10);

    const verboseStats = await new ClaudeUsageProvider({ root }).getStats({ verbose: true });
    assert.equal(
      verboseStats.warnings.some((warning) => warning.includes("Collapsed 1 duplicate Claude usage event")),
      true
    );
  });
});

test("ClaudeUsageProvider does not sum streamed same-key output snapshots as separate billable events", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/output-snapshots.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        requestId: "req-snapshot",
        messageId: "msg-snapshot",
        model: "claude-opus-4-8",
        inputTokens: 400,
        cacheReadInputTokens: 1200,
        cacheCreation1hInputTokens: 300,
        outputTokens: 200
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:02.000Z",
        requestId: "req-snapshot",
        messageId: "msg-snapshot",
        model: "claude-opus-4-8",
        inputTokens: 400,
        cacheReadInputTokens: 1200,
        cacheCreation1hInputTokens: 300,
        outputTokens: 800
      })
    ]);

    const stats = await new ClaudeUsageProvider({ root }).getStats();
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 400);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 1200);
    assert.equal(stats.summary.totals.cacheWrite1hInputTokens, 300);
    assert.equal(stats.summary.totals.outputTokens, 800);
    assert.equal(stats.dayUsage.length, 1);
    assert.equal(stats.dayUsage[0].totals.outputTokens, 800);

    const verboseStats = await new ClaudeUsageProvider({ root }).getStats({ verbose: true });
    assert.equal(verboseStats.summary.tokenEvents, 1);
    assert.equal(
      verboseStats.warnings.some((warning) => warning.includes("avoid double-counting cumulative snapshots")),
      true
    );
  });
});

test("ClaudeUsageProvider counts nested workflow subagent transcripts and dedupes their streamed snapshots", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "wf-project/sess-1.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:00.000Z",
        requestId: "req-orchestrator",
        messageId: "msg-orchestrator",
        model: "claude-opus-4-8",
        inputTokens: 1000,
        cacheReadInputTokens: 2000,
        cacheCreation1hInputTokens: 500,
        outputTokens: 100
      })
    ]);
    // Workflow subagents live in a deeply nested directory next to the parent
    // session file: <session>/subagents/workflows/<wf>/<agent>.jsonl
    await writeClaudeSession(root, "wf-project/sess-1/subagents/workflows/wf-audit/agent-verify.jsonl", [
      // Two streamed snapshots of the SAME request: identical input/cache, growing
      // output. They must collapse to a single billable event using the max output.
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        requestId: "req-sub-1",
        messageId: "msg-sub-1",
        model: "claude-opus-4-8",
        inputTokens: 200,
        cacheReadInputTokens: 800,
        cacheCreation5mInputTokens: 100,
        outputTokens: 5
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.200Z",
        requestId: "req-sub-1",
        messageId: "msg-sub-1",
        model: "claude-opus-4-8",
        inputTokens: 200,
        cacheReadInputTokens: 800,
        cacheCreation5mInputTokens: 100,
        outputTokens: 300
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:02.000Z",
        requestId: "req-sub-2",
        messageId: "msg-sub-2",
        model: "claude-opus-4-8",
        inputTokens: 50,
        cacheReadInputTokens: 900,
        outputTokens: 40
      })
    ]);

    const stats = await new ClaudeUsageProvider({ root }).getStats();
    assert.equal(stats.summary.filesScanned, 2);
    // 1 orchestrator + 2 subagent requests (the two snapshots of req-sub-1 collapse).
    assert.equal(stats.summary.tokenEvents, 3);
    assert.equal(stats.summary.totals.inputTokens, 1000 + 200 + 50);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 2000 + 800 + 900);
    assert.equal(stats.summary.totals.cacheWrite5mInputTokens, 100);
    assert.equal(stats.summary.totals.cacheWrite1hInputTokens, 500);
    // Subagent output is the final snapshot (300), never the partial (5) nor their sum (305).
    assert.equal(stats.summary.totals.outputTokens, 100 + 300 + 40);
  });
});

test("ClaudeUsageProvider groups nested workflow subagents with their parent session for source classification", async () => {
  await withTempRoot(async (root) => {
    // Parent session is an IDE session...
    await writeClaudeSession(root, "wf-project/sess-vscode.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:00.000Z",
        requestId: "req-parent",
        messageId: "msg-parent",
        entrypoint: "claude-vscode",
        model: "claude-opus-4-8",
        inputTokens: 100,
        outputTokens: 10
      })
    ]);
    // ...while its workflow subagent reports only a generic "cli" entrypoint with no
    // IDE hints. If the subagent is grouped with the parent (correct), it inherits the
    // parent's "vscode" classification; if it lands in its own group (the bug), it is
    // classified "cli" instead.
    await writeClaudeSession(root, "wf-project/sess-vscode/subagents/workflows/wf-audit/agent-verify.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        requestId: "req-sub",
        messageId: "msg-sub",
        entrypoint: "cli",
        model: "claude-opus-4-8",
        inputTokens: 200,
        outputTokens: 20
      })
    ]);

    const logs = [];
    const traceLogger = {
      log(message) {
        logs.push(message);
      }
    };
    await new ClaudeUsageProvider({ root }).getStats({ traceLogger });

    const subagentTraceLine = logs.find((line) =>
      line.includes("subagents/workflows/wf-audit/agent-verify.jsonl")
    );
    assert.ok(subagentTraceLine, "expected a trace line for the nested workflow subagent transcript");
    assert.match(subagentTraceLine, /source=vscode/);
  });
});

test("ClaudeUsageProvider preserves real model usage when a later same-key synthetic row appears", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/keyed-synthetic-followup.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        requestId: "req-synthetic-followup",
        messageId: "msg-synthetic-followup",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        cacheReadInputTokens: 50,
        outputTokens: 10
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:02.000Z",
        requestId: "req-synthetic-followup",
        messageId: "msg-synthetic-followup",
        model: "<synthetic>",
        inputTokens: 0,
        outputTokens: 0
      })
    ]);

    const stats = await new ClaudeUsageProvider({ root }).getStats();
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 100);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 50);
    assert.equal(stats.summary.totals.outputTokens, 10);
    assert.equal(stats.modelUsage.some((row) => row.modelId === "<synthetic>"), false);
    assert.equal(stats.modelUsage.some((row) => row.modelId === "claude-sonnet-4-6"), true);

    const verboseStats = await new ClaudeUsageProvider({ root }).getStats({ verbose: true });
    assert.equal(
      verboseStats.warnings.some((warning) => warning.includes("avoid double-counting cumulative snapshots")),
      true
    );
  });
});

test("ClaudeUsageProvider aggregates Claude entrypoints and builds live usage windows", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/mixed-entrypoints.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-25T08:00:00.000Z",
        requestId: "req-vscode-session",
        messageId: "msg-vscode-session",
        entrypoint: "claude-vscode",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 10
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-20T14:00:00.000Z",
        requestId: "req-vscode-week",
        messageId: "msg-vscode-week",
        entrypoint: "claude-vscode",
        model: "claude-opus-4-8",
        inputTokens: 40,
        outputTokens: 5
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-25T09:00:00.000Z",
        requestId: "req-cli-session",
        messageId: "msg-cli-session",
        entrypoint: "sdk-cli",
        model: "claude-sonnet-4-5",
        inputTokens: 70,
        outputTokens: 7
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-25T09:30:00.000Z",
        requestId: "req-unknown-entrypoint",
        messageId: "msg-unknown-entrypoint",
        entrypoint: "mystery-cli",
        model: "claude-sonnet-4-5",
        inputTokens: 999,
        outputTokens: 99
      })
    ]);

    const readUsageCommandOutput = async () =>
      [
        "Current session: 20% used · resets Jun 25, 12:30pm (UTC)",
        "Current week (all models): 63% used · resets Jun 25, 12pm (UTC)"
      ].join("\n");
    const readAuthStatusOutput = async () =>
      JSON.stringify(
        {
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          email: "ivan@devforth.io",
          orgId: "6688e4cf-c09a-4dc6-ba4a-20ffe66aa43c",
          orgName: "Devforth",
          subscriptionType: "team"
        },
        null,
        2
      );
    const now = () => new Date("2026-06-25T10:00:00.000Z");

    const stats = await new ClaudeUsageProvider({
      root,
      readUsageCommandOutput,
      readAuthStatusOutput,
      now
    }).getStats();

    assert.equal(stats.summary.filesScanned, 1);
    assert.equal(stats.summary.tokenEvents, 4);
    assert.equal(stats.summary.totals.inputTokens, 1209);
    assert.equal(stats.summary.totals.outputTokens, 121);
    assert.deepEqual(
      stats.modelUsage.map((row) => row.modelId).sort(),
      ["claude-opus-4-8", "claude-sonnet-4-5", "claude-sonnet-4-6"]
    );
    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].planType, "team");
    assert.equal(stats.primaryLimitWindows[0].windowMinutes, 300);
    assert.equal(stats.primaryLimitWindows[0].minUsedPercent, 20);
    assert.equal(stats.primaryLimitWindows[0].maxUsedPercent, 20);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 1169);
    assert.equal(stats.primaryLimitWindows[0].totals.outputTokens, 116);
    assert.equal(stats.secondaryLimitWindows.length, 1);
    assert.equal(stats.secondaryLimitWindows[0].planType, "team");
    assert.equal(stats.secondaryLimitWindows[0].windowMinutes, 10080);
    assert.equal(stats.secondaryLimitWindows[0].minUsedPercent, 63);
    assert.equal(stats.secondaryLimitWindows[0].maxUsedPercent, 63);
    assert.equal(stats.secondaryLimitWindows[0].totals.inputTokens, 1209);
    assert.equal(stats.secondaryLimitWindows[0].totals.outputTokens, 121);
    assert.equal(stats.warnings.some((warning) => warning.includes("mystery-cli")), false);
    assert.deepEqual(stats.analytics, {
      agentName: "Claude",
      userIdHash: createHash("md5").update("Claude-ivan@devforth.io-6688e4cf-c09a-4dc6-ba4a-20ffe66aa43c-Devforth").digest("hex")
    });
  });
});

test("ClaudeUsageProvider detects Team Premium Sonnet-only weekly windows", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/team-premium.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-25T08:00:00.000Z",
        requestId: "req-premium-sonnet-session",
        messageId: "msg-premium-sonnet-session",
        entrypoint: "claude-vscode",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 10
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-25T09:00:00.000Z",
        requestId: "req-premium-opus-session",
        messageId: "msg-premium-opus-session",
        entrypoint: "sdk-cli",
        model: "claude-opus-4-8",
        inputTokens: 80,
        outputTokens: 8
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-20T10:00:00.000Z",
        requestId: "req-premium-sonnet-week",
        messageId: "msg-premium-sonnet-week",
        entrypoint: "claude-vscode",
        model: "claude-sonnet-4-5",
        inputTokens: 50,
        outputTokens: 5
      })
    ]);

    const stats = await new ClaudeUsageProvider({
      root,
      readUsageCommandOutput: async () =>
        [
          "Current session: 2% used · resets Jun 25, 12:30pm (UTC)",
          "Current week (all models): 9% used · resets Jun 25, 12pm (UTC)",
          "Current week (Sonnet only): 4% used · resets Jun 25, 12pm (UTC)"
        ].join("\n"),
      readAuthStatusOutput: async () =>
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          email: "premium@devforth.io",
          orgId: "premium-org",
          orgName: "Premium Org",
          subscriptionType: "team"
        }),
      now: () => new Date("2026-06-25T10:00:00.000Z")
    }).getStats();

    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].planType, "team_premium");
    assert.equal(stats.primaryLimitWindows[0].limitId, "current-session");
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 180);
    assert.equal(stats.primaryLimitWindows[0].totals.outputTokens, 18);

    assert.equal(stats.secondaryLimitWindows.length, 2);

    const allModelsWeek = stats.secondaryLimitWindows.find((row) => row.limitId === "current-week");
    assert.equal(allModelsWeek?.planType, "team_premium");
    assert.equal(allModelsWeek?.totals.inputTokens, 230);
    assert.equal(allModelsWeek?.totals.outputTokens, 23);

    const sonnetOnlyWeek = stats.secondaryLimitWindows.find(
      (row) => row.limitId === "current-week-sonnet-only"
    );
    assert.equal(sonnetOnlyWeek?.planType, "team_premium");
    assert.equal(sonnetOnlyWeek?.modelType, "sonnet only");
    assert.equal(sonnetOnlyWeek?.totals.inputTokens, 150);
    assert.equal(sonnetOnlyWeek?.totals.outputTokens, 15);
    assert.deepEqual(
      sonnetOnlyWeek?.modelUsage.map((row) => row.modelId).sort(),
      ["claude-sonnet-4-5", "claude-sonnet-4-6"]
    );
  });
});

test("ClaudeUsageProvider captures the Sonnet-only weekly window when its reset is omitted", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/sonnet-only.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-28T08:00:00.000Z",
        requestId: "req-sonnet-week",
        messageId: "msg-sonnet-week",
        entrypoint: "claude-vscode",
        model: "claude-sonnet-4-6",
        inputTokens: 40,
        outputTokens: 4
      })
    ]);

    const stats = await new ClaudeUsageProvider({
      root,
      readUsageCommandOutput: async () =>
        [
          "Current session: 4% used · resets Jun 29, 3:40pm (UTC)",
          "Current week (all models): 0% used · resets Jun 30, 1pm (UTC)",
          "Current week (Sonnet only): 0% used"
        ].join("\n"),
      readAuthStatusOutput: async () =>
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          email: "premium@devforth.io",
          orgId: "premium-org",
          orgName: "Premium Org",
          subscriptionType: "team"
        }),
      now: () => new Date("2026-06-29T11:30:00.000Z")
    }).getStats();

    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.secondaryLimitWindows.length, 2);

    const allModelsWeek = stats.secondaryLimitWindows.find((row) => row.limitId === "current-week");
    const sonnetOnlyWeek = stats.secondaryLimitWindows.find(
      (row) => row.limitId === "current-week-sonnet-only"
    );
    assert.ok(sonnetOnlyWeek, "expected a Sonnet-only weekly window even without an explicit reset");
    assert.equal(sonnetOnlyWeek.modelType, "sonnet only");
    // The Sonnet-only week inherits the weekly reset printed on the all-models week.
    assert.equal(sonnetOnlyWeek.endTimeUtcIso, allModelsWeek.endTimeUtcIso);
    assert.equal(sonnetOnlyWeek.totals.inputTokens, 40);
  });
});

test("ClaudeUsageProvider prefers VSCode Claude binaries before falling back to other locations", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "trace-project/mixed.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-25T09:00:00.000Z",
        requestId: "req-trace-cli",
        messageId: "msg-trace-cli",
        entrypoint: "sdk-cli",
        model: "claude-sonnet-4-5",
        inputTokens: 70,
        outputTokens: 7
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-25T10:00:00.000Z",
        requestId: "req-trace-vscode",
        messageId: "msg-trace-vscode",
        entrypoint: "claude-vscode",
        model: "claude-sonnet-4-6",
        inputTokens: 80,
        outputTokens: 8
      })
    ]);
    const cliBinary = path.join(root, ".local", "bin", "claude");
    const vscodeMissingBinary = path.join(
      root,
      ".vscode",
      "extensions",
      "anthropic.claude-code-1.9.0",
      "resources",
      "native-binary",
      "claude"
    );
    const vscodeBinary = path.join(
      root,
      ".vscode",
      "extensions",
      "anthropic.claude-code-1.8.1",
      "resources",
      "native-binary",
      "claude"
    );
    const buildFakeClaudeBinary = (usageLines) => `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
cat <<'EOF'
{
  "loggedIn": true,
  "email": "trace@example.com",
  "orgId": "org-1",
  "orgName": "Trace Org",
  "subscriptionType": "team"
}
EOF
exit 0
fi
if [ "$1" = "-p" ] && [ "$2" = "/usage" ]; then
cat <<'EOF'
${usageLines.join("\n")}
EOF
exit 0
fi
echo "unexpected args: $*" >&2
exit 1
`;

    await writeExecutable(
      cliBinary,
      buildFakeClaudeBinary([
        "Current session: 12% used · resets Jun 25, 12:30pm (UTC)",
        "Current week (all models): 34% used · resets Jun 28, 12pm (UTC)"
      ])
    );
    await fs.mkdir(path.dirname(vscodeMissingBinary), { recursive: true });
    await writeExecutable(
      vscodeBinary,
      buildFakeClaudeBinary([
        "Current session: 56% used · resets Jun 25, 1:30pm (UTC)",
        "Current week (all models): 78% used · resets Jun 29, 3pm (UTC)"
      ])
    );

    const logs = [];
    const traceLogger = {
      log(message) {
        logs.push(message);
      }
    };

    await new ClaudeUsageProvider({ root }).getStats({ traceLogger });

    const combinedLogs = logs.join("\n");
    assert.equal(combinedLogs.includes(`[Claude] Session root candidate ~/.claude/projects -> ${path.join(root, ".claude", "projects")} (exists).`), true);
    assert.equal(combinedLogs.includes("[Claude] Session file trace-project/mixed.jsonl: lines=2 malformed=0 assistantUsageEvents=2 matchingEvents=2 source=vscode entrypoints=claude-vscode:1, sdk-cli:1"), true);
    assert.equal(combinedLogs.includes(`[Claude] Checked ${vscodeMissingBinary} -> failure (`), true);
    assert.equal(combinedLogs.includes(`[Claude] Checked ${vscodeBinary} -> success.`), true);
    assert.equal(combinedLogs.includes(`[Claude] Binary detection result: found ${vscodeBinary}.`), true);
    assert.equal(combinedLogs.includes(`[Claude] Checked ${cliBinary} -> success.`), false);
    assert.equal(combinedLogs.includes("[Claude] Usage returned:\nCurrent session: 56% used"), true);
    assert.equal(combinedLogs.includes("Current week (all models): 78% used"), true);
    assert.equal(combinedLogs.includes("[Claude] Live window primary/session: used=56%"), true);
  });
});

test("ClaudeUsageProvider falls back to direct Claude binaries when VSCode extension binaries are unavailable", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "trace-project/cli-fallback.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-25T09:00:00.000Z",
        requestId: "req-trace-cli-only",
        messageId: "msg-trace-cli-only",
        entrypoint: "cli",
        model: "claude-sonnet-4-5",
        inputTokens: 70,
        outputTokens: 7
      })
    ]);
    const cliBinary = path.join(root, ".local", "bin", "claude");
    const vscodeMissingBinary = path.join(
      root,
      ".vscode",
      "extensions",
      "anthropic.claude-code-2.1.191-linux-x64",
      "resources",
      "native-binary",
      "claude"
    );

    await fs.mkdir(path.dirname(vscodeMissingBinary), { recursive: true });
    await writeExecutable(
      cliBinary,
      `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
cat <<'EOF'
{
  "loggedIn": true,
  "email": "trace@example.com",
  "orgId": "org-1",
  "orgName": "Trace Org",
  "subscriptionType": "team"
}
EOF
exit 0
fi
if [ "$1" = "-p" ] && [ "$2" = "/usage" ]; then
cat <<'EOF'
Current session: 12% used · resets Jun 25, 12:30pm (UTC)
Current week (all models): 34% used · resets Jun 28, 12pm (UTC)
EOF
exit 0
fi
echo "unexpected args: $*" >&2
exit 1
`
    );

    const logs = [];
    const traceLogger = {
      log(message) {
        logs.push(message);
      }
    };

    await new ClaudeUsageProvider({ root }).getStats({ traceLogger });

    const combinedLogs = logs.join("\n");
    assert.equal(combinedLogs.includes(`[Claude] Checked ${vscodeMissingBinary} -> failure (`), true);
    assert.equal(combinedLogs.includes(`[Claude] Checked ${cliBinary} -> success.`), true);
    assert.equal(combinedLogs.includes(`[Claude] Binary detection result: found ${cliBinary}.`), true);
    assert.equal(combinedLogs.includes("[Claude] Usage returned:\nCurrent session: 12% used"), true);
  });
});

test("ClaudeUsageProvider forces TZ=UTC for Claude command execution", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/kyiv-session.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-25T15:30:00.000Z",
        requestId: "req-kyiv-session",
        messageId: "msg-kyiv-session",
        entrypoint: "claude-vscode",
        model: "claude-sonnet-4-6",
        inputTokens: 120,
        outputTokens: 12
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-24T10:00:00.000Z",
        requestId: "req-kyiv-week",
        messageId: "msg-kyiv-week",
        entrypoint: "claude-vscode",
        model: "claude-opus-4-8",
        inputTokens: 80,
        outputTokens: 8
      })
    ]);

    const vscodeBinary = path.join(
      root,
      ".vscode",
      "extensions",
      "anthropic.claude-code-2.1.191-linux-x64",
      "resources",
      "native-binary",
      "claude"
    );
    await writeExecutable(
      vscodeBinary,
      `#!/bin/sh
if [ "$TZ" != "UTC" ]; then
  echo "TZ was not forced to UTC: ${"$"}TZ" >&2
  exit 1
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
cat <<'EOF'
{
  "loggedIn": true,
  "email": "kyiv@example.com",
  "orgId": "org-kyiv",
  "orgName": "Kyiv Org",
  "subscriptionType": "team"
}
EOF
exit 0
fi
if [ "$1" = "-p" ] && [ "$2" = "/usage" ]; then
cat <<'EOF'
Current session: 26% used · resets Jun 25, 6:50pm (UTC)
Current week (all models): 34% used · resets Jun 28, 8pm (UTC)
EOF
exit 0
fi
echo "unexpected args: ${"$"}*" >&2
exit 1
`
    );

    const stats = await new ClaudeUsageProvider({
      root,
      now: () => new Date("2026-06-25T14:19:42.154Z")
    }).getStats();

    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].planType, "team");
    assert.equal(stats.primaryLimitWindows[0].minUsedPercent, 26);
    assert.equal(stats.primaryLimitWindows[0].maxUsedPercent, 26);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 120);
    assert.equal(stats.primaryLimitWindows[0].totals.outputTokens, 12);
    assert.equal(stats.secondaryLimitWindows.length, 1);
    assert.equal(stats.secondaryLimitWindows[0].planType, "team");
    assert.equal(stats.secondaryLimitWindows[0].minUsedPercent, 34);
    assert.equal(stats.secondaryLimitWindows[0].maxUsedPercent, 34);
    assert.equal(stats.secondaryLimitWindows[0].totals.inputTokens, 200);
    assert.equal(stats.secondaryLimitWindows[0].totals.outputTokens, 20);
  });
});

test("ClaudeUsageProvider finds Linux Claude sessions under ~/.config/claude/projects", async () => {
  await withTempRoot(async (root) => {
    const sessionsRoot = path.join(root, ".config", "claude", "projects");
    await writeClaudeSessionAt(sessionsRoot, "ubuntu-vscode/session.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-25T08:00:00.000Z",
        requestId: "req-ubuntu-vscode",
        messageId: "msg-ubuntu-vscode",
        entrypoint: "claude-vscode",
        model: "claude-opus-4-8",
        inputTokens: 120,
        outputTokens: 12
      })
    ]);

    const stats = await new ClaudeUsageProvider({ root }).getStats();

    assert.equal(stats.summary.filesScanned, 1);
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 120);
    assert.equal(stats.summary.totals.outputTokens, 12);
    assert.equal(stats.summary.rootLabel, "~/.config/claude/projects");
    assert.equal(stats.summary.rootPath, sessionsRoot);
  });
});

test("ClaudeUsageProvider traces Linux Claude limits from shared Claude transcripts", async () => {
  await withTempRoot(async (root) => {
    const sessionsRoot = path.join(root, ".config", "claude", "projects");
    await writeClaudeSessionAt(sessionsRoot, "ubuntu-cli/session.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-25T18:00:00.000Z",
        requestId: "req-linux-vscode-only",
        messageId: "msg-linux-vscode-only",
        entrypoint: "claude-vscode",
        model: "claude-sonnet-4-6",
        inputTokens: 120,
        outputTokens: 12
      })
    ]);

    const logs = [];
    const traceLogger = {
      log(message) {
        logs.push(message);
      }
    };
    const stats = await new ClaudeUsageProvider({
      root,
      readUsageCommandOutput: async () =>
        [
          "Current session: 44% used · resets Jun 25, 8pm (UTC)",
          "Current week (all models): 6% used · resets Jul 2, 3pm (UTC)"
        ].join("\n"),
      readAuthStatusOutput: async () =>
        JSON.stringify({
          loggedIn: true,
          email: "linux@example.com",
          orgId: "org-linux",
          orgName: "Linux Org",
          subscriptionType: "team"
        }),
      now: () => new Date("2026-06-25T19:15:00.000Z")
    }).getStats({ traceLogger });

    assert.equal(stats.summary.filesScanned, 1);
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].eventCount, 1);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 120);

    const combinedLogs = logs.join("\n");
    assert.equal(combinedLogs.includes(`[Claude] Session root candidate ~/.config/claude/projects -> ${sessionsRoot} (exists).`), true);
    assert.equal(combinedLogs.includes("[Claude] Session file ubuntu-cli/session.jsonl: lines=1 malformed=0 assistantUsageEvents=1 matchingEvents=1 source=vscode entrypoints=claude-vscode:1"), true);
    assert.equal(combinedLogs.includes("[Claude] Live window primary/session: used=44%"), true);
    assert.equal(combinedLogs.includes("matchedEvents=1 input=120 output=12"), true);
  });
});

test("ClaudeUsageProvider accepts a root that already points at a raw Claude projects dump", async () => {
  await withTempRoot(async (root) => {
    const projectsRoot = path.join(root, "projects");
    await writeClaudeSessionAt(projectsRoot, "-home-vsemeniuk-Desktop-tugabet-e2e/session.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-25T08:00:00.000Z",
        requestId: "req-dump-vscode",
        messageId: "msg-dump-vscode",
        entrypoint: "cli",
        model: "claude-sonnet-4-6",
        inputTokens: 90,
        outputTokens: 9
      })
    ]);

    const stats = await new ClaudeUsageProvider({ root: projectsRoot }).getStats();

    assert.equal(stats.summary.filesScanned, 1);
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 90);
    assert.equal(stats.summary.totals.outputTokens, 9);
    assert.equal(stats.summary.rootLabel, "projects");
    assert.equal(stats.summary.rootPath, projectsRoot);
  });
});

test("ClaudeUsageProvider aggregates generic cli Linux sessions regardless of IDE hints", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/linux-cli-terminal.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-25T08:00:00.000Z",
        requestId: "req-linux-cli-terminal",
        messageId: "msg-linux-cli-terminal",
        entrypoint: "cli",
        model: "claude-sonnet-4-6",
        inputTokens: 70,
        outputTokens: 7
      })
    ]);
    await writeClaudeSession(root, "sample-project/linux-cli-vscode.jsonl", [
      claudeOpenedFileInIdeAttachment({
        timestamp: "2026-06-25T08:59:00.000Z",
        sessionId: "claude-session-1"
      }),
      claudeIdeToolsAttachment({
        timestamp: "2026-06-25T08:59:30.000Z",
        sessionId: "claude-session-1"
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-25T09:00:00.000Z",
        requestId: "req-linux-cli-vscode-main",
        messageId: "msg-linux-cli-vscode-main",
        entrypoint: "cli",
        model: "claude-opus-4-8",
        inputTokens: 120,
        outputTokens: 12
      })
    ]);
    await writeClaudeSession(root, "sample-project/linux-cli-vscode/subagents/agent-1.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-25T09:10:00.000Z",
        requestId: "req-linux-cli-vscode-subagent",
        messageId: "msg-linux-cli-vscode-subagent",
        entrypoint: "cli",
        model: "claude-haiku-4-5-20251001",
        inputTokens: 30,
        outputTokens: 3
      })
    ]);

    const readUsageCommandOutput = async () => "Current session: 26% used · resets Jun 25, 12pm (UTC)";
    const readAuthStatusOutput = async () =>
      JSON.stringify({
        loggedIn: true,
        email: "linux-cli@example.com",
        orgId: "org-linux-cli",
        orgName: "Linux CLI Org",
        subscriptionType: "team"
      });
    const now = () => new Date("2026-06-25T10:00:00.000Z");

    const stats = await new ClaudeUsageProvider({
      root,
      readUsageCommandOutput,
      readAuthStatusOutput,
      now
    }).getStats();
    assert.equal(stats.summary.tokenEvents, 3);
    assert.equal(stats.summary.totals.inputTokens, 220);
    assert.equal(stats.summary.totals.outputTokens, 22);
    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 220);
    assert.equal(stats.primaryLimitWindows[0].totals.outputTokens, 22);
  });
});

test("ClaudeUsageProvider dedupes identical unkeyed usage rows by signature", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/unkeyed-duplicates.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        model: "claude-opus-4-8",
        inputTokens: 40,
        cacheReadInputTokens: 30,
        cacheCreation1hInputTokens: 10,
        outputTokens: 5
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:03.000Z",
        model: "claude-opus-4-8",
        inputTokens: 40,
        cacheReadInputTokens: 30,
        cacheCreation1hInputTokens: 10,
        outputTokens: 5
      })
    ]);

    const stats = await new ClaudeUsageProvider({ root }).getStats();
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 40);
    assert.equal(stats.summary.totals.cacheWrite5mInputTokens, 0);
    assert.equal(stats.summary.totals.cacheWrite1hInputTokens, 10);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 30);
    assert.equal(stats.summary.totals.outputTokens, 5);
    assert.equal(
      stats.warnings.some((warning) => warning.includes("adjacent duplicate unkeyed Claude usage event")),
      false
    );

    const verboseStats = await new ClaudeUsageProvider({ root }).getStats({ verbose: true });
    assert.equal(
      verboseStats.warnings.some((warning) => warning.includes("adjacent duplicate unkeyed Claude usage event")),
      true
    );
  });
});

test("ClaudeUsageProvider keeps non-adjacent unkeyed usage rows with identical signatures as separate events", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/unkeyed-separated.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        model: "claude-opus-4-8",
        inputTokens: 40,
        cacheReadInputTokens: 30,
        cacheCreation1hInputTokens: 10,
        outputTokens: 5
      }),
      JSON.stringify({
        type: "user",
        sessionId: "claude-session-1",
        timestamp: "2026-06-18T20:00:02.000Z",
        message: { role: "user", content: "run again" }
      }),
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:03.000Z",
        model: "claude-opus-4-8",
        inputTokens: 40,
        cacheReadInputTokens: 30,
        cacheCreation1hInputTokens: 10,
        outputTokens: 5
      })
    ]);

    const stats = await new ClaudeUsageProvider({ root }).getStats();
    assert.equal(stats.summary.tokenEvents, 2);
    assert.equal(stats.summary.totals.inputTokens, 80);
    assert.equal(stats.summary.totals.cacheWrite5mInputTokens, 0);
    assert.equal(stats.summary.totals.cacheWrite1hInputTokens, 20);
    assert.equal(stats.summary.totals.cacheReadInputTokens, 60);
    assert.equal(stats.summary.totals.outputTokens, 10);
    assert.equal(
      stats.warnings.some((warning) => warning.includes("adjacent duplicate unkeyed Claude usage event")),
      false
    );
  });
});

test("ClaudeUsageProvider suppresses missing-rate warnings for internal synthetic model rows", async () => {
  await withTempRoot(async (root) => {
    await writeClaudeSession(root, "sample-project/synthetic.jsonl", [
      claudeAssistantEvent({
        timestamp: "2026-06-18T20:00:01.000Z",
        requestId: "req-synthetic",
        messageId: "msg-synthetic",
        model: "<synthetic>",
        inputTokens: 40,
        cacheReadInputTokens: 10,
        outputTokens: 5
      })
    ]);

    const stats = await new ClaudeUsageProvider({ root }).getStats();
    const syntheticTotals = stats.modelUsage.find((row) => row.modelId === "<synthetic>")?.totals;

    assert.equal(syntheticTotals?.estimatedCredits, 0);
    assert.equal(stats.warnings.some((warning) => warning.includes("<synthetic>")), false);
  });
});

test("buildAnonymousUsageReports derives used percents for saturated and live windows", async () => {
  const reports = await buildAnonymousUsageReports([
    {
      providerId: "codex",
      providerLabel: "Codex",
      summary: {
        filesScanned: 1,
        linesRead: 1,
        tokenEvents: 1,
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          cacheWrite5mInputTokens: 0,
          cacheWrite1hInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          estimatedCredits: 0,
          eventCount: 0
        },
        distinctModels: [],
        distinctPlanTypes: [],
        rootLabel: "~/.codex/sessions",
        rootPath: "/tmp/.codex/sessions"
      },
      modelUsage: [],
      dayUsage: [],
      primaryLimitWindows: [
        {
          scope: "primary",
          planType: "team",
          limitId: "codex",
          windowMinutes: 300,
          startTimeUtcIso: "2026-06-25T07:30:00Z",
          endTimeUtcIso: "2026-06-25T12:30:00Z",
          firstSeenUtcIso: "2026-06-25T07:35:00Z",
          lastSeenUtcIso: "2026-06-25T12:25:00Z",
          minUsedPercent: 3.123456,
          maxUsedPercent: 100,
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            cacheWrite5mInputTokens: 0,
            cacheWrite1hInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
            estimatedCredits: 250,
            eventCount: 1
          },
          modelUsage: [
            {
              modelId: "gpt-5.5",
              totals: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheWriteInputTokens: 0,
                cacheWrite5mInputTokens: 0,
                cacheWrite1hInputTokens: 0,
                reasoningOutputTokens: 0,
                totalTokens: 0,
                estimatedCredits: 150,
                eventCount: 1
              }
            },
            {
              modelId: "gpt-5.4-mini",
              totals: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheWriteInputTokens: 0,
                cacheWrite5mInputTokens: 0,
                cacheWrite1hInputTokens: 0,
                reasoningOutputTokens: 0,
                totalTokens: 0,
                estimatedCredits: 100,
                eventCount: 0
              }
            }
          ],
          eventCount: 1
        }
      ],
      secondaryLimitWindows: [],
      warnings: [],
      analytics: {
        agentName: "Codex",
        userIdHash: "codex-user"
      }
    },
    {
      providerId: "claude",
      providerLabel: "Claude",
      summary: {
        filesScanned: 1,
        linesRead: 1,
        tokenEvents: 1,
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          cacheWrite5mInputTokens: 0,
          cacheWrite1hInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          estimatedCredits: 0,
          eventCount: 0
        },
        distinctModels: [],
        distinctPlanTypes: [],
        rootLabel: "~/.claude/projects",
        rootPath: "/tmp/.claude/projects"
      },
      modelUsage: [],
      dayUsage: [],
      primaryLimitWindows: [
        {
          scope: "primary",
          planType: "team",
          limitId: "current-session",
          windowMinutes: 300,
          startTimeUtcIso: "2026-06-25T07:30:00Z",
          endTimeUtcIso: "2026-06-25T12:30:00Z",
          firstSeenUtcIso: "2026-06-25T07:30:00Z",
          lastSeenUtcIso: "2026-06-25T10:00:00Z",
          minUsedPercent: 20.25,
          maxUsedPercent: 20.25,
          totals: {
            inputTokens: 11,
            outputTokens: 22,
            cacheReadInputTokens: 33,
            cacheWriteInputTokens: 99,
            cacheWrite5mInputTokens: 44,
            cacheWrite1hInputTokens: 55,
            reasoningOutputTokens: 0,
            totalTokens: 0,
            estimatedCredits: 50,
            eventCount: 1
          },
          modelUsage: [
            {
              modelId: "claude-sonnet-4-6",
              totals: {
                inputTokens: 11,
                outputTokens: 22,
                cacheReadInputTokens: 33,
                cacheWriteInputTokens: 99,
                cacheWrite5mInputTokens: 44,
                cacheWrite1hInputTokens: 55,
                reasoningOutputTokens: 0,
                totalTokens: 0,
                estimatedCredits: 50,
                eventCount: 1
              }
            }
          ],
          eventCount: 1
        }
      ],
      secondaryLimitWindows: [],
      warnings: [],
      analytics: {
        agentName: "Claude",
        userIdHash: "claude-user"
      }
    }
  ]);

  assert.equal(reports.length, 2);
  assert.deepEqual(
    reports.map((report) => ({
      agent: report.agent,
      model_type: report.model_type,
      used_percents: report.used_percents,
      used_exhausted: report.used_exhausted,
      value_dollars: report.value_dollars,
      usage_raw: report.usage_raw
    })),
    [
      {
        agent: "Codex",
        model_type: "codex",
        used_percents: 96.876544,
        used_exhausted: true,
        value_dollars: 2.5,
        usage_raw: {
          "gpt-5.5": {
            output: 0,
            input_non_cache: 0,
            input_cache_read: 0,
            input_cache_w5m: 0,
            input_cache_w1h: 0
          },
          "gpt-5.4-mini": {
            output: 0,
            input_non_cache: 0,
            input_cache_read: 0,
            input_cache_w5m: 0,
            input_cache_w1h: 0
          }
        }
      },
      {
        agent: "Claude",
        model_type: "all",
        used_percents: 20.25,
        used_exhausted: false,
        value_dollars: 0.5,
        usage_raw: {
          "claude-sonnet-4-6": {
            output: 22,
            input_non_cache: 11,
            input_cache_read: 33,
            input_cache_w5m: 44,
            input_cache_w1h: 55
          }
        }
      }
    ]
  );
  assert.equal("input_cache_w5m" in reports[0].usage_raw["gpt-5.5"], true);
  assert.equal("input_cache_w1h" in reports[0].usage_raw["gpt-5.5"], true);
  assert.equal(reports[0].letmecode_version.length > 0, true);
});

test("buildAnonymousUsagePayload wraps reports in a data array", async () => {
  const payload = await buildAnonymousUsagePayload([
    {
      providerId: "codex",
      providerLabel: "Codex",
      summary: {
        filesScanned: 1,
        linesRead: 1,
        tokenEvents: 1,
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          cacheWrite5mInputTokens: 0,
          cacheWrite1hInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          estimatedCredits: 0,
          eventCount: 0
        },
        distinctModels: [],
        distinctPlanTypes: [],
        rootLabel: "~/.codex/sessions",
        rootPath: "/tmp/.codex/sessions"
      },
      modelUsage: [],
      dayUsage: [],
      primaryLimitWindows: [
        {
          scope: "primary",
          planType: "team",
          limitId: "codex",
          windowMinutes: 300,
          startTimeUtcIso: "2026-06-25T07:30:00Z",
          endTimeUtcIso: "2026-06-25T12:30:00Z",
          firstSeenUtcIso: "2026-06-25T07:35:00Z",
          lastSeenUtcIso: "2026-06-25T12:25:00Z",
          minUsedPercent: 3,
          maxUsedPercent: 100,
          totals: {
            inputTokens: 12,
            outputTokens: 34,
            cacheReadInputTokens: 56,
            cacheWriteInputTokens: 0,
            cacheWrite5mInputTokens: 0,
            cacheWrite1hInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
            estimatedCredits: 250,
            eventCount: 1
          },
          modelUsage: [
            {
              modelId: "gpt-5.5",
              totals: {
                inputTokens: 12,
                outputTokens: 34,
                cacheReadInputTokens: 56,
                cacheWriteInputTokens: 0,
                cacheWrite5mInputTokens: 0,
                cacheWrite1hInputTokens: 0,
                reasoningOutputTokens: 0,
                totalTokens: 0,
                estimatedCredits: 250,
                eventCount: 1
              }
            }
          ],
          eventCount: 1
        }
      ],
      secondaryLimitWindows: [],
      warnings: [],
      analytics: {
        agentName: "Codex",
        userIdHash: "codex-user"
      }
    }
  ]);

  assert.deepEqual(Object.keys(payload), ["data"]);
  assert.equal(Array.isArray(payload.data), true);
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0].agent, "Codex");
  assert.equal(payload.data[0].model_type, "codex");
  assert.equal("modelType" in payload.data[0], false);
  assert.deepEqual(payload.data[0].usage_raw, {
    "gpt-5.5": {
      output: 34,
      input_non_cache: 12,
      input_cache_read: 56,
      input_cache_w5m: 0,
      input_cache_w1h: 0
    }
  });
  assert.equal("input_cache_w5m" in payload.data[0].usage_raw["gpt-5.5"], true);
  assert.equal("input_cache_w1h" in payload.data[0].usage_raw["gpt-5.5"], true);
});

test("buildAnonymousUsagePayload skips windows below one percent usage", async () => {
  const totals = (overrides = {}) => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCredits: 0,
    eventCount: 0,
    ...overrides
  });
  const window = (limitId, minUsedPercent, maxUsedPercent) => ({
    scope: "primary",
    planType: "team",
    limitId,
    windowMinutes: 300,
    startTimeUtcIso: "2026-06-25T07:30:00Z",
    endTimeUtcIso: "2026-06-25T12:30:00Z",
    firstSeenUtcIso: "2026-06-25T07:35:00Z",
    lastSeenUtcIso: "2026-06-25T12:25:00Z",
    minUsedPercent,
    maxUsedPercent,
    totals: totals({ estimatedCredits: 25, eventCount: 1 }),
    modelUsage: [
      {
        modelId: "gpt-5.5",
        totals: totals({ inputTokens: 10, outputTokens: 5, estimatedCredits: 25, eventCount: 1 })
      }
    ],
    eventCount: 1
  });

  const payload = await buildAnonymousUsagePayload([
    {
      providerId: "codex",
      providerLabel: "Codex",
      summary: {
        filesScanned: 1,
        linesRead: 1,
        tokenEvents: 1,
        totals: totals(),
        distinctModels: [],
        distinctPlanTypes: [],
        rootLabel: "~/.codex/sessions",
        rootPath: "/tmp/.codex/sessions"
      },
      modelUsage: [],
      dayUsage: [],
      primaryLimitWindows: [
        window("zero-usage", 0, 0),
        window("tiny-live-window", 99.5, 100),
        window("reportable-window", 99, 100)
      ],
      secondaryLimitWindows: [],
      warnings: [],
      analytics: {
        agentName: "Codex",
        userIdHash: "codex-user"
      }
    }
  ]);

  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0].model_type, "reportable-window");
  assert.equal(payload.data[0].used_percents, 1);
});

test("buildAnonymousUsagePayload reports Antigravity data", async () => {
  const totals = (overrides = {}) => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCredits: 0,
    eventCount: 0,
    ...overrides
  });
  const window = (limitId, scope) => ({
    scope,
    planType: "pro",
    limitId,
    windowMinutes: scope === "primary" ? 300 : 10080,
    startTimeUtcIso: "2026-06-25T07:30:00Z",
    endTimeUtcIso: "2026-06-25T12:30:00Z",
    firstSeenUtcIso: "2026-06-25T07:35:00Z",
    lastSeenUtcIso: "2026-06-25T12:25:00Z",
    minUsedPercent: 0,
    maxUsedPercent: 10,
    totals: totals({ estimatedCredits: 100, eventCount: 1 }),
    modelUsage: [
      {
        modelId: limitId.startsWith("3p") ? "claude-sonnet-4-6" : "gemini-3.5-flash",
        totals: totals({ estimatedCredits: 100, eventCount: 1 })
      }
    ],
    eventCount: 1
  });

  const payload = await buildAnonymousUsagePayload([
    {
      providerId: "antigravity",
      providerLabel: "Antigravity",
      summary: {
        filesScanned: 1,
        linesRead: 1,
        tokenEvents: 1,
        totals: totals(),
        distinctModels: [],
        distinctPlanTypes: ["pro"],
        rootLabel: "Antigravity local trajectories",
        rootPath: "/tmp/antigravity"
      },
      modelUsage: [],
      dayUsage: [],
      primaryLimitWindows: [window("gemini-5h", "primary")],
      secondaryLimitWindows: [window("3p-weekly", "secondary")],
      warnings: [],
      analytics: {
        agentName: "Antigravity",
        userIdHash: "antigravity-user"
      }
    }
  ]);

  assert.equal(payload.data.length, 2);
  const byModelType = new Map(payload.data.map((report) => [report.model_type, report]));
  const gemini = byModelType.get("gemini");
  const thirdParty = byModelType.get("third-party");

  assert.ok(gemini, "expected a gemini Antigravity report");
  assert.ok(thirdParty, "expected a third-party Antigravity report");
  assert.equal(gemini.agent, "Antigravity");
  assert.equal(gemini.userid_hash, "antigravity-user");
  assert.equal(gemini.plan_id, "pro");
  assert.equal(gemini.used_percents, 10);
  assert.equal(gemini.value_dollars, 1);
  assert.equal(gemini.window_duration_seconds, 18000);
  assert.equal(thirdParty.window_duration_seconds, 604800);
});

test("buildAnonymousUsageReports prefers explicit limit-window model types", async () => {
  const reports = await buildAnonymousUsageReports([
    {
      providerId: "claude",
      providerLabel: "Claude",
      summary: {
        filesScanned: 1,
        linesRead: 1,
        tokenEvents: 1,
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          cacheWrite5mInputTokens: 0,
          cacheWrite1hInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          estimatedCredits: 0,
          eventCount: 0
        },
        distinctModels: [],
        distinctPlanTypes: ["team_premium"],
        rootLabel: "~/.claude/projects",
        rootPath: "/tmp/.claude/projects"
      },
      modelUsage: [],
      dayUsage: [],
      primaryLimitWindows: [],
      secondaryLimitWindows: [
        {
          scope: "secondary",
          planType: "team_premium",
          limitId: "current-week-sonnet-only",
          modelType: "sonnet only",
          windowMinutes: 10080,
          startTimeUtcIso: "2026-06-19T12:00:00Z",
          endTimeUtcIso: "2026-06-26T12:00:00Z",
          firstSeenUtcIso: "2026-06-20T10:00:00Z",
          lastSeenUtcIso: "2026-06-25T08:00:00Z",
          minUsedPercent: 0,
          maxUsedPercent: 4,
          totals: {
            inputTokens: 150,
            outputTokens: 15,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            cacheWrite5mInputTokens: 0,
            cacheWrite1hInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
            estimatedCredits: 75,
            eventCount: 2
          },
          modelUsage: [
            {
              modelId: "claude-sonnet-4-6",
              totals: {
                inputTokens: 150,
                outputTokens: 15,
                cacheReadInputTokens: 0,
                cacheWriteInputTokens: 0,
                cacheWrite5mInputTokens: 0,
                cacheWrite1hInputTokens: 0,
                reasoningOutputTokens: 0,
                totalTokens: 0,
                estimatedCredits: 75,
                eventCount: 2
              }
            }
          ],
          eventCount: 2
        }
      ],
      warnings: [],
      analytics: {
        agentName: "Claude",
        userIdHash: "claude-user"
      }
    }
  ]);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].plan_id, "team_premium");
  assert.equal(reports[0].model_type, "sonnet-only");
});
