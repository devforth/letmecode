import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

test("provider registry stays UI-generic", async () => {
  const providers = createProviders();
  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, "codex");
  assert.equal(typeof providers[0].getStats, "function");
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
    assert.deepEqual(stats.secondaryLimitWindows, []);
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

test("missing sessions directory yields empty but friendly stats", async () => {
  await withTempRoot(async (root) => {
    const stats = await new CodexUsageProvider({ root }).getStats();
    assert.equal(stats.summary.filesScanned, 0);
    assert.equal(stats.summary.tokenEvents, 0);
    assert.equal(stats.modelUsage.length, 0);
    assert.equal(stats.primaryLimitWindows.length, 0);
    assert.equal(stats.secondaryLimitWindows.length, 0);
    assert.equal(stats.warnings.some((warning) => warning.includes("No Codex session files found")), true);
  });
});
