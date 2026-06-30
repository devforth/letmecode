import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseCopilotQuota, getCopilotUserInfo } from "../dist/providers/copilot/quota.js";
import { parseCopilotOtelFiles } from "../dist/providers/copilot/otel/parse.js";
import { discoverCopilotOtelFiles } from "../dist/providers/copilot/otel/discover.js";
import { aggregateCopilotUsage } from "../dist/providers/copilot/usage/aggregate.js";

// ─── helpers ────────────────────────────────────────────────────────────────

async function withTempRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "letmecode-copilot-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeOtel(root, name, lines) {
  const target = path.join(root, ".copilot", "otel", name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, lines.join("\n"), "utf8");
  return target;
}

async function parseCopilotRecords(records) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "letmecode-copilot-parse-"));
  try {
    const target = path.join(root, "otel.jsonl");
    await fs.writeFile(
      target,
      records.map((record) => JSON.stringify(record.payload)).join("\n"),
      "utf8"
    );
    return await parseCopilotOtelFiles([
      {
        path: target,
        modifiedAtMs: records[0]?.fileModifiedAtMs ?? 1_700_000_000_000
      }
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function rawRecord(payload, overrides = {}) {
  return {
    payload,
    fileModifiedAtMs: overrides.fileModifiedAtMs ?? 1_700_000_000_000
  };
}

function chatRecord(attributes, payloadExtras = {}, overrides = {}) {
  return rawRecord(
    { hrTime: [1782130578, 148000000], attributes, ...payloadExtras },
    overrides
  );
}

function usageEvent(overrides = {}) {
  return {
    timestampMs: 1_782_130_578_148,
    modelId: "gpt-4.1",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
    cacheReadStatus: "known",
    cacheWriteStatus: "known",
    filePath: "/a.jsonl",
    lineNumber: 1,
    ...overrides
  };
}

function byModel(aggregated) {
  return new Map(aggregated.modelUsage.map((row) => [row.modelId, row.totals]));
}

// ─── quota-parser ─────────────────────────────────────────────────────────────

test("quota-parser reads a paid quota_snapshots response", () => {
  const info = parseCopilotQuota({
    copilot_plan: "copilot_pro",
    quota_reset_date: "2026-07-01",
    quota_snapshots: {
      premium_interactions: {
        percent_remaining: 80,
        entitlement: 300,
        remaining: 240,
        quota_id: "premium_interactions"
      },
      chat: { percent_remaining: 100, entitlement: 0 }
    }
  });

  assert.equal(info.plan, "copilot_pro");
  assert.equal(info.resetAt, "2026-07-01");
  const quotas = new Map(info.quotas.map((q) => [q.id, q]));
  const premium = quotas.get("premium_interactions");
  assert.equal(premium.label, "Premium");
  assert.equal(premium.total, 300);
  assert.equal(premium.remaining, 240);
  assert.equal(premium.used, 60);
  assert.equal(premium.usedPercent, 20);
  assert.equal(premium.remainingPercent, 80);
  assert.equal(quotas.get("chat").label, "Chat");
  assert.equal(quotas.get("chat").usedPercent, 0);
});

test("quota-parser reads a free monthly/limited response", () => {
  const info = parseCopilotQuota({
    copilot_plan: "copilot_free",
    monthly_quotas: { chat: 50, completions: 2000 },
    limited_user_quotas: { chat: 10, completions: 500 },
    limited_user_reset_date: "2026-07-15"
  });

  assert.equal(info.plan, "copilot_free");
  assert.equal(info.resetAt, "2026-07-15");
  const quotas = new Map(info.quotas.map((q) => [q.id, q]));
  assert.equal(quotas.get("chat").total, 50);
  assert.equal(quotas.get("chat").remaining, 10);
  assert.equal(quotas.get("chat").used, 40);
  assert.equal(quotas.get("chat").usedPercent, 80);
  assert.equal(quotas.get("completions").used, 1500);
  assert.equal(quotas.get("completions").usedPercent, 75);
});

test("quota-parser tolerates missing fields without throwing", () => {
  assert.deepEqual(parseCopilotQuota(null), { quotas: [] });
  assert.deepEqual(parseCopilotQuota("nonsense"), { quotas: [] });
  assert.deepEqual(parseCopilotQuota({ copilot_plan: "x" }), { plan: "x", quotas: [] });
});

test("quota-parser keeps unknown quota keys with a readable fallback label", () => {
  const info = parseCopilotQuota({
    quota_snapshots: { some_new_bucket: { percent_remaining: 50 } }
  });
  assert.equal(info.quotas.length, 1);
  assert.equal(info.quotas[0].id, "some_new_bucket");
  assert.equal(info.quotas[0].label, "Some New Bucket");
  assert.equal(info.quotas[0].usedPercent, 50);
});

test("quota-parser clamps invalid percentages into 0..100", () => {
  const info = parseCopilotQuota({
    quota_snapshots: { chat: { percent_remaining: 150 } }
  });
  assert.equal(info.quotas[0].remainingPercent, 100);
  assert.equal(info.quotas[0].usedPercent, 0);
});

test("quota-parser guards remaining greater than total", () => {
  const info = parseCopilotQuota({
    quota_snapshots: { chat: { remaining: 500, entitlement: 300 } }
  });
  assert.equal(info.quotas[0].total, 300);
  assert.equal(info.quotas[0].remaining, 300);
  assert.equal(info.quotas[0].used, 0);
  assert.equal(info.quotas[0].usedPercent, 0);
});

// ─── parse ─────────────────────────────────────────────────────────────────

test("parse parses a standard VS Code chat span", async () => {
  const { events } = await parseCopilotRecords([
    chatRecord({
      "gen_ai.response.model": "gpt-4.1",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.cache_read.input_tokens": 20,
      "gen_ai.usage.output_tokens": 10
    })
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].modelId, "gpt-4.1");
  assert.equal(events[0].inputTokens, 100); // RAW reported input (includes cache-read)
  assert.equal(events[0].cacheReadInputTokens, 20);
  assert.equal(events[0].outputTokens, 10);
  assert.equal(events[0].cacheReadStatus, "known");
});

test("parse falls back to gen_ai.request.model", async () => {
  const { events } = await parseCopilotRecords([
    chatRecord({
      "gen_ai.request.model": "gpt-5-mini",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 5,
      "gen_ai.usage.output_tokens": 1
    })
  ]);
  assert.equal(events[0].modelId, "gpt-5-mini");
});

test("parse reads underscore cache aliases", async () => {
  const { events } = await parseCopilotRecords([
    chatRecord({
      "gen_ai.response.model": "claude-sonnet-4-6",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.cache_read_input_tokens": 30,
      "gen_ai.usage.cache_creation_input_tokens": 15,
      "gen_ai.usage.output_tokens": 9
    })
  ]);
  assert.equal(events[0].cacheReadInputTokens, 30);
  assert.equal(events[0].cacheWriteInputTokens, 15);
  assert.equal(events[0].cacheReadStatus, "known");
  assert.equal(events[0].cacheWriteStatus, "known");
});

test("parse reads dotted cache aliases", async () => {
  const { events } = await parseCopilotRecords([
    chatRecord({
      "gen_ai.response.model": "claude-sonnet-4-6",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.cache_read.input_tokens": 30,
      "gen_ai.usage.cache_creation.input_tokens": 15,
      "gen_ai.usage.output_tokens": 9
    })
  ]);
  assert.equal(events[0].cacheReadInputTokens, 30);
  assert.equal(events[0].cacheWriteInputTokens, 15);
});

test("parse keeps cache-only events", async () => {
  const { events } = await parseCopilotRecords([
    chatRecord({
      "gen_ai.response.model": "gpt-4.1",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.cache_read.input_tokens": 500
    })
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 0);
  assert.equal(events[0].outputTokens, 0);
  assert.equal(events[0].cacheReadInputTokens, 500);
});

test("parse accepts numeric string token values", async () => {
  const { events } = await parseCopilotRecords([
    chatRecord({
      "gen_ai.response.model": "gpt-4.1",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": "100",
      "gen_ai.usage.output_tokens": "10"
    })
  ]);
  assert.equal(events[0].inputTokens, 100);
  assert.equal(events[0].outputTokens, 10);
});

test("parse defaults missing model to unknown", async () => {
  const { events } = await parseCopilotRecords([
    chatRecord({
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 5,
      "gen_ai.usage.output_tokens": 1
    })
  ]);
  assert.equal(events[0].modelId, "unknown");
});

test("parse timestamp precedence: endTime > startTime > hrTime > file mtime", async () => {
  const day = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);
  const tokens = { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 5, "gen_ai.usage.output_tokens": 1 };

  // endTime wins over startTime and hrTime.
  const end = await parseCopilotRecords([
    rawRecord({ endTime: [1782300000, 0], startTime: [1782130578, 0], hrTime: [1782206354, 0], attributes: tokens })
  ]);
  assert.equal(new Date(end.events[0].timestampMs).toISOString().slice(0, 10), day(1782300000));

  // startTime is used when endTime is absent (over hrTime, different days).
  assert.notEqual(day(1782130578), day(1782206354));
  const start = await parseCopilotRecords([
    rawRecord({ startTime: [1782130578, 0], hrTime: [1782206354, 0], attributes: tokens })
  ]);
  assert.equal(new Date(start.events[0].timestampMs).toISOString().slice(0, 10), day(1782130578));

  // hrTime is the fallback when endTime/startTime are absent.
  const hr = await parseCopilotRecords([rawRecord({ hrTime: [1782206354, 0], attributes: tokens })]);
  assert.equal(new Date(hr.events[0].timestampMs).toISOString().slice(0, 10), day(1782206354));

  // ISO string is accepted.
  const iso = await parseCopilotRecords([rawRecord({ time: "2026-06-20T00:00:00.000Z", attributes: tokens })]);
  assert.equal(new Date(iso.events[0].timestampMs).toISOString().slice(0, 10), "2026-06-20");

  // Falls back to file mtime when no timestamp field is present.
  const fallback = await parseCopilotRecords([
    rawRecord({ attributes: tokens }, { fileModifiedAtMs: 1_782_000_000_000 })
  ]);
  assert.equal(fallback.events[0].timestampMs, 1_782_000_000_000);
});

test("parse reads the reasoning_tokens alias", async () => {
  const { events } = await parseCopilotRecords([
    chatRecord({
      "gen_ai.response.model": "gpt-4.1",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 50,
      "gen_ai.usage.reasoning_tokens": 20
    })
  ]);
  assert.equal(events[0].reasoningOutputTokens, 20);
});

test("parse keeps reported input intact when cache-write is present", async () => {
  const { events } = await parseCopilotRecords([
    chatRecord({
      "gen_ai.response.model": "claude-sonnet-4-6",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.cache_creation.input_tokens": 30,
      "gen_ai.usage.output_tokens": 9
    })
  ]);
  // cache-write is NOT subtracted at the normalize layer.
  assert.equal(events[0].inputTokens, 100);
  assert.equal(events[0].cacheWriteInputTokens, 30);
});

test("parse ignores OTLP envelopes and array-form attributes", async () => {
  const envelope = await parseCopilotRecords([
    rawRecord({ resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] })
  ]);
  assert.equal(envelope.events.length, 0);

  const arrayAttrs = await parseCopilotRecords([
    rawRecord({
      attributes: [{ key: "gen_ai.usage.input_tokens", value: { intValue: "100" } }]
    })
  ]);
  assert.equal(arrayAttrs.events.length, 0);
});

test("parse drops records that match no supported span/log type", async () => {
  // Tokens present, but no chat/inference/agent marker => not chat usage.
  const { events } = await parseCopilotRecords([
    chatRecord({
      "gen_ai.response.model": "gpt-4.1",
      "gen_ai.operation.name": "embeddings",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 0
    })
  ]);
  assert.equal(events.length, 0);
});

test("parse resolves trace id from spanContext", async () => {
  const { events } = await parseCopilotRecords([
    rawRecord({
      spanContext: { traceId: "trace-xyz", spanId: "span-1" },
      attributes: {
        "gen_ai.response.model": "gpt-4.1",
        "gen_ai.operation.name": "chat",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 1
      }
    })
  ]);
  assert.equal(events[0].traceId, "trace-xyz");
  assert.equal(events[0].spanId, "span-1");
});

test("parse deduplicates repeated chat spans by trace and span", async () => {
  const result = await parseCopilotRecords([
    chatRecord({
      "gen_ai.trace.id": "t1",
      "span_id": "s1",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 10
    }),
    chatRecord({
      "gen_ai.trace.id": "t1",
      "span_id": "s1",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 10
    })
  ]);
  assert.equal(result.events.length, 1);
  assert.equal(result.duplicatesRemoved, 1);
});

test("parse preserves separate chat spans in one conversation", async () => {
  const result = await parseCopilotRecords([
    chatRecord({
      "gen_ai.trace.id": "t1",
      "span_id": "s1",
      "conversation.id": "c1",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 10
    }),
    chatRecord({
      "gen_ai.trace.id": "t1",
      "span_id": "s2",
      "conversation.id": "c1",
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 20
    })
  ]);
  assert.equal(result.events.length, 2);
});

// ─── aggregate ───────────────────────────────────────────────────────────────

test("aggregate derives uncached input and treats cache-write as additive", () => {
  const aggregated = aggregateCopilotUsage([
    usageEvent({
      modelId: "claude-haiku-4-5-20251001",
      inputTokens: 100000,
      cacheReadInputTokens: 20000,
      cacheWriteInputTokens: 10000,
      outputTokens: 1000
    })
  ]);
  const totals = byModel(aggregated).get("claude-haiku-4-5-20251001");
  assert.equal(totals.inputTokens, 80000);
  assert.equal(totals.cacheReadInputTokens, 20000);
  assert.equal(totals.cacheWriteInputTokens, 10000);
  assert.equal(totals.totalTokens, 111000);
  assert.ok(Math.abs(totals.estimatedCredits - 9.95) < 1e-9);
  assert.equal(totals.estimatedCreditsStatus, "known");
});

test("aggregate preserves the full cache-read bucket for cache-only events", () => {
  // input 0, cache-read 500: capping cache-read at input would zero the bucket
  // and lose the usage. The bucket must keep all 500.
  const aggregated = aggregateCopilotUsage([
    usageEvent({
      modelId: "claude-haiku-4-5-20251001",
      inputTokens: 0,
      cacheReadInputTokens: 500,
      cacheWriteInputTokens: 0,
      outputTokens: 0
    })
  ]);
  const totals = byModel(aggregated).get("claude-haiku-4-5-20251001");
  assert.equal(totals.inputTokens, 0);
  assert.equal(totals.cacheReadInputTokens, 500);
  assert.equal(totals.totalTokens, 500);
});

test("aggregate marks unknown pricing and warns", () => {
  const aggregated = aggregateCopilotUsage([
    usageEvent({ modelId: "gpt-4.1", inputTokens: 100, cacheReadInputTokens: 5, outputTokens: 10 })
  ]);
  const totals = byModel(aggregated).get("gpt-4.1");
  assert.equal(totals.estimatedCredits, 0);
  assert.equal(totals.estimatedCreditsStatus, "unavailable");
  assert.equal(
    aggregated.warnings.some((w) => w.includes("Pricing is unavailable for models: gpt-4.1")),
    true
  );
});

test("aggregate zero-rates non-billable models without a pricing warning", () => {
  const aggregated = aggregateCopilotUsage([
    usageEvent({ modelId: "copilot-nes", inputTokens: 1000, outputTokens: 20 })
  ]);
  const totals = byModel(aggregated).get("copilot-nes");
  assert.equal(totals.estimatedCredits, 0);
  assert.equal(totals.estimatedCreditsStatus, "known");
  assert.equal(
    aggregated.warnings.some((w) => w.includes("Pricing is unavailable")),
    false
  );
});

test("aggregate reports unavailable credits when cache data is missing", () => {
  const aggregated = aggregateCopilotUsage([
    usageEvent({
      modelId: "gpt-5-mini",
      inputTokens: 100000,
      outputTokens: 1000,
      cacheReadStatus: "unavailable",
      cacheWriteStatus: "unavailable"
    })
  ]);
  const totals = byModel(aggregated).get("gpt-5-mini");
  assert.equal(totals.estimatedCredits, 0);
  assert.equal(totals.estimatedCreditsStatus, "unavailable");
  assert.equal(
    aggregated.warnings.some((w) => w.includes("cache token attributes are unavailable")),
    true
  );
});

test("aggregate groups by model and by day", () => {
  const aggregated = aggregateCopilotUsage([
    usageEvent({ modelId: "gpt-5-mini", timestampMs: Date.parse("2026-06-20T10:00:00Z"), cacheReadInputTokens: 1 }),
    usageEvent({ modelId: "gpt-5-mini", timestampMs: Date.parse("2026-06-20T12:00:00Z"), cacheReadInputTokens: 1 }),
    usageEvent({ modelId: "claude-sonnet-4-6", timestampMs: Date.parse("2026-06-21T12:00:00Z"), cacheReadInputTokens: 1 })
  ]);
  assert.equal(aggregated.modelUsage.length, 2);
  assert.equal(aggregated.dayUsage.length, 2);
  assert.equal(aggregated.tokenEvents, 3);
});

// ─── discover ─────────────────────────────────────────────────────────────

test("discover deduplicates a path found via env and directory scan", async () => {
  await withTempRoot(async (root) => {
    const file = await writeOtel(root, "vscode.jsonl", ["{}"]);
    const result = await discoverCopilotOtelFiles({
      root,
      env: { COPILOT_OTEL_FILE_EXPORTER_PATH: file }
    });
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, path.resolve(file));
  });
});

test("discover deduplicates unresolved env path against the directory entry", async () => {
  await withTempRoot(async (root) => {
    const file = await writeOtel(root, "vscode.jsonl", ["{}"]);
    const messy = path.join(path.dirname(file), ".", "vscode.jsonl");
    const result = await discoverCopilotOtelFiles({
      root,
      env: { COPILOT_OTEL_FILE_EXPORTER_PATH: messy }
    });
    assert.equal(result.files.length, 1);
  });
});

test("discover treats a missing OTEL directory as empty, not an error", async () => {
  await withTempRoot(async (root) => {
    const result = await discoverCopilotOtelFiles({ root, env: {} });
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.warnings, []);
  });
});

test("discover finds multiple JSONL files and ignores non-JSONL files", async () => {
  await withTempRoot(async (root) => {
    await writeOtel(root, "vscode.jsonl", ["{}"]);
    await writeOtel(root, "cli.jsonl", ["{}"]);
    await writeOtel(root, "notes.txt", ["ignore me"]);
    const result = await discoverCopilotOtelFiles({ root, env: {} });
    assert.equal(result.files.length, 2);
    assert.equal(result.files.every((f) => f.path.endsWith(".jsonl")), true);
  });
});

// ─── user-info (offline, injected fakes) ─────────────────────────────────────

test("user-info reports a controlled warning when no token is found", async () => {
  const result = await getCopilotUserInfo({ resolveToken: async () => null });
  assert.equal(result.quotaInfo, undefined);
  assert.equal(result.warnings.length, 1);
  const warning = result.warnings[0];
  assert.equal(warning.includes("no GitHub token found"), true);
  assert.equal(warning.includes("GH_TOKEN"), true);
  assert.equal(warning.includes("gh auth login"), true);
});

test("user-info parses quota from an injected fetch and never leaks the token", async () => {
  const result = await getCopilotUserInfo({
    resolveToken: async () => "secret-token",
    fetchUser: async (token) => {
      assert.equal(token, "secret-token");
      return { ok: true, data: { copilot_plan: "copilot_pro", quota_snapshots: { chat: { percent_remaining: 70 } } } };
    }
  });
  assert.equal(result.quotaInfo.plan, "copilot_pro");
  assert.equal(result.quotaInfo.quotas[0].usedPercent, 30);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
});

test("user-info surfaces a transport failure as a warning", async () => {
  const result = await getCopilotUserInfo({
    resolveToken: async () => "t",
    fetchUser: async () => ({ ok: false, warning: "Copilot quota API returned 401; run `gh auth login` again." })
  });
  assert.equal(result.quotaInfo, undefined);
  assert.equal(result.warnings.some((w) => w.includes("401")), true);
});
