import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parse as parseJsonc } from "jsonc-parser";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeUsageProvider } from "../dist/providers/claude.js";
import { CodexUsageProvider } from "../dist/providers/codex.js";
import {
  CopilotUsageProvider,
  configureCopilotVsCodeLogging
} from "../dist/providers/copilot.js";
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
  assert.equal(providers.length, 3);
  assert.equal(providers[0].id, "codex");
  assert.equal(providers[1].id, "claude");
  assert.equal(providers[2].id, "copilot");
  assert.equal(typeof providers[0].getStats, "function");
  assert.equal(typeof providers[1].getStats, "function");
  assert.equal(typeof providers[2].getStats, "function");
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

    const stats = await new CopilotUsageProvider({ root }).getStats();
    assert.equal(stats.providerId, "copilot");
    assert.equal(stats.providerLabel, "Copilot");
    assert.equal(stats.summary.filesScanned, 1);
    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 30);
    assert.equal(stats.summary.totals.cachedInputTokens, 5);
    assert.equal(stats.summary.totals.nonCachedInputTokens, 25);
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

    const stats = await new CopilotUsageProvider({ root }).getStats();

    assert.equal(stats.summary.tokenEvents, 0);
    assert.equal(stats.summary.totals.cachedInputTokens, 0);
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

    const stats = await new CopilotUsageProvider({ root }).getStats();

    assert.equal(stats.summary.tokenEvents, 0);
    assert.equal(stats.summary.totals.inputTokens, 0);
    assert.equal(stats.summary.totals.cachedInputTokens, 0);
    assert.equal(stats.dayUsage.length, 0);
  });
});

test("CopilotUsageProvider uses only hrTime for timestamps", async () => {
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

    const stats = await new CopilotUsageProvider({ root }).getStats();

    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.dayUsage.length, 1);
    assert.equal(stats.dayUsage[0].dayKey, "2026-06-23");
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

    const stats = await new CopilotUsageProvider({ root }).getStats();

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

    const stats = await new CopilotUsageProvider({ root }).getStats();

    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.modelUsage[0].modelId, "gpt-5.4-2026-03-01");
    assert.equal(stats.modelUsage[0].totals.estimatedCredits, 0);
    assert.equal(stats.modelUsage[0].totals.estimatedCreditsStatus, "unavailable");
    assert.equal(stats.modelUsage[0].totals.cacheStatus, "unavailable");
    assert.equal(
      stats.warnings.some((warning) => warning.includes("cache token attributes are unavailable")),
      true
    );
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

    const stats = await new CopilotUsageProvider({ root }).getStats();

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

    const stats = await new CopilotUsageProvider({ root }).getStats();

    assert.equal(stats.summary.tokenEvents, 1);
    assert.equal(stats.summary.totals.inputTokens, 100000);
    assert.equal(stats.summary.totals.cachedInputTokens, 20000);
    assert.equal(stats.summary.totals.nonCachedInputTokens, 80000);
    assert.equal(stats.summary.totals.outputTokens, 1000);
    assert.equal(stats.summary.totals.reasoningOutputTokens, 1000);
    assert.equal(stats.summary.totals.totalTokens, 101000);
    assert.ok(Math.abs(stats.summary.totals.estimatedCredits - 8.95) < 0.0000001);
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

    const stats = await new CopilotUsageProvider({ root }).getStats();
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

    const stats = await new CopilotUsageProvider({ root }).getStats();
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

    const stats = await new CopilotUsageProvider({ root }).getStats();
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

    const stats = await new CopilotUsageProvider({ root }).getStats();

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
          "gen_ai.response.model": "gpt-5.4-2026-03-01",
          "gen_ai.operation.name": "chat",
          "gen_ai.usage.input_tokens": 84275,
          "gen_ai.usage.output_tokens": 328
        }
      }),
      JSON.stringify({
        hrTime: [1782130578, 154000000],
        attributes: {
          "event.name": "copilot_chat.agent.turn",
          "gen_ai.operation.name": "invoke_agent",
          "turn.index": 0,
          "gen_ai.usage.input_tokens": 84275,
          "gen_ai.usage.output_tokens": 328
        }
      })
    ]);

    const stats = await new CopilotUsageProvider({ root }).getStats();

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

test("CopilotUsageProvider warns when VS Code logging is enabled but no OTEL file exists yet", async () => {
  await withTempRoot(async (root) => {
    const outfile = path.join(root, ".copilot", "otel", "vscode.jsonl");
    await configureCopilotVsCodeLogging({
      root,
      settingsPath: path.join(root, ".config", "Code", "User", "settings.json")
    });

    const stats = await new CopilotUsageProvider({ root }).getStats();

    assert.equal(stats.summary.tokenEvents, 0);
    assert.equal(
      stats.warnings.some((warning) => warning.includes("has not been created yet")),
      true
    );
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
    assert.equal(stats.warnings.some((warning) => warning.includes("Collapsed 1 duplicate Claude usage event")), true);
  });
});

test("ClaudeUsageProvider keeps the highest-cost keyed usage row instead of first-write-wins", async () => {
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
    assert.equal(stats.summary.totals.inputTokens, 170);
    assert.equal(stats.summary.totals.cachedInputTokens, 50);
    assert.equal(stats.summary.totals.nonCachedInputTokens, 120);
    assert.equal(stats.summary.totals.outputTokens, 10);
    assert.equal(stats.primaryLimitWindows.length, 1);
    assert.equal(stats.primaryLimitWindows[0].totals.inputTokens, 170);
    assert.equal(
      stats.warnings.some((warning) => warning.includes("highest-cost/latest event per key")),
      true
    );
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
    assert.equal(stats.summary.totals.inputTokens, 80);
    assert.equal(stats.summary.totals.cachedInputTokens, 30);
    assert.equal(stats.summary.totals.nonCachedInputTokens, 50);
    assert.equal(stats.summary.totals.outputTokens, 5);
    assert.equal(
      stats.warnings.some((warning) => warning.includes("Collapsed 1 duplicate unkeyed Claude usage event")),
      true
    );
  });
});
