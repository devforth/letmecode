import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeUsageProvider } from "../dist/providers/claude.js";
import { CodexUsageProvider } from "../dist/providers/codex.js";
import { createProviders } from "../dist/providers/index.js";

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

async function writeClaudeSession(root, relativePath, lines) {
  const target = path.join(root, ".claude", "projects", relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, lines.join("\n"), "utf8");
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

function claudeAssistantEvent({
  timestamp,
  requestId,
  messageId,
  model,
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

test("provider registry stays UI-generic", async () => {
  const providers = createProviders();
  assert.equal(providers.length, 2);
  assert.equal(providers[0].id, "codex");
  assert.equal(providers[1].id, "claude");
  assert.equal(typeof providers[0].getStats, "function");
  assert.equal(typeof providers[1].getStats, "function");
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
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 100);
    assert.equal(stats.primaryLimitWindows[0].totals.cachedInputTokens, 20);
    assert.equal(stats.primaryLimitWindows[0].totals.outputTokens, 10);
    assert.equal(stats.primaryLimitWindows[0].totals.eventCount, 1);
    assert.equal(stats.dayUsage.length, 1);
    assert.equal(stats.dayUsage[0].dayKey, "2026-06-18");
    assert.equal(stats.dayUsage[0].totals.inputTokens, 100);
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
    assert.equal(stats.dayUsage[0].totals.inputTokens, 80);
    assert.equal(stats.dayUsage[0].totals.cachedInputTokens, 20);
    assert.equal(stats.dayUsage[0].totals.outputTokens, 10);
    assert.deepEqual(stats.dayUsage[0].distinctPlanTypes, ["plus"]);
    assert.equal(stats.dayUsage[0].firstEventUtcIso, "2026-06-19T08:00:01Z");
    assert.equal(stats.dayUsage[0].lastEventUtcIso, "2026-06-19T08:00:01Z");
    assert.equal(stats.dayUsage[1].totals.inputTokens, 100);
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
    assert.equal(stats.summary.totals.inputTokens, 360);
    assert.equal(stats.summary.totals.cachedInputTokens, 100);
    assert.equal(stats.summary.totals.nonCachedInputTokens, 260);
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
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 220);
    assert.equal(stats.primaryLimitWindows[0].totals.cachedInputTokens, 40);
    assert.equal(stats.primaryLimitWindows[0].totals.outputTokens, 25);
    assert.equal(stats.primaryLimitWindows[0].totals.eventCount, 2);
    assert.equal(stats.summary.totals.inputTokens, 360);
    assert.equal(stats.summary.totals.cachedInputTokens, 70);
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
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 220);
    assert.equal(stats.primaryLimitWindows[0].totals.cachedInputTokens, 40);
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
    assert.equal(stats.summary.totals.inputTokens, 250);
    assert.equal(stats.summary.totals.cachedInputTokens, 80);
    assert.equal(stats.summary.totals.nonCachedInputTokens, 170);
    assert.equal(stats.summary.totals.outputTokens, 15);
    assert.equal(stats.modelUsage.length, 2);
    assert.deepEqual(
      stats.dayUsage.map((row) => row.dayKey),
      ["2026-06-19", "2026-06-18"]
    );
    assert.equal(stats.dayUsage[0].totals.inputTokens, 80);
    assert.equal(stats.dayUsage[0].totals.outputTokens, 5);
    assert.deepEqual(stats.dayUsage[0].distinctPlanTypes, []);
    assert.equal(stats.dayUsage[1].totals.inputTokens, 170);
    assert.deepEqual(stats.dayUsage[1].distinctPlanTypes, ["max"]);
    assert.deepEqual(
      stats.modelUsage.map((row) => row.modelId).sort(),
      ["claude-opus-4-8", "claude-sonnet-4-6"]
    );
    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].totals.eventCount, 1);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 170);
    assert.equal(stats.summary.distinctPlanTypes.includes("max"), true);
    assert.deepEqual(stats.secondaryLimitWindows, []);
  });
});
