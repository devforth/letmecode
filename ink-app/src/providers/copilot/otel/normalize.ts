import { asRecord } from "../../limits.js";
import type {
  CopilotNormalizeResult,
  CopilotRawOtelRecord,
  CopilotUsageEvent,
  CopilotUsageEventSource
} from "../types.js";

// ────────────────────────────────────────────────────────────────────────────
// Token attribute aliases (read from the FLAT top-level `attributes` object).
// ────────────────────────────────────────────────────────────────────────────

const INPUT_KEY = "gen_ai.usage.input_tokens";
const OUTPUT_KEY = "gen_ai.usage.output_tokens";

const CACHE_READ_KEYS = [
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cache_read_input_tokens"
] as const;

const CACHE_WRITE_KEYS = [
  "gen_ai.usage.cache_write.input_tokens",
  "gen_ai.usage.cache_creation.input_tokens",
  "gen_ai.usage.cache_write_input_tokens",
  "gen_ai.usage.cache_creation_input_tokens"
] as const;

const REASONING_KEYS = [
  "gen_ai.usage.reasoning.output_tokens",
  "gen_ai.usage.reasoning_tokens"
] as const;

/**
 * Convert raw Copilot OTEL records into normalized usage events.
 *
 * Only the FLAT top-level `attributes` object is inspected — OTLP envelopes
 * (resourceLogs/resourceSpans/…) and array-form attribute lists are NOT
 * descended into and therefore yield no events. `inputTokens` is the RAW
 * reported input (it already includes cache-read tokens); aggregate.ts derives
 * the uncached portion. Never captures prompt/response content.
 */
export function normalizeCopilotOtelRecords(
  records: CopilotRawOtelRecord[]
): CopilotNormalizeResult {
  const events: CopilotUsageEvent[] = [];

  for (const record of records) {
    const event = normalizeRecord(record);
    if (event) {
      events.push(event);
    }
  }

  return { events, warnings: [] };
}

function normalizeRecord(record: CopilotRawOtelRecord): CopilotUsageEvent | null {
  const payload = asRecord(record.payload);
  if (!payload) {
    return null;
  }

  const attributes = flatAttributes(payload.attributes);
  if (!attributes) {
    return null;
  }

  const reportedInput = tokenValue(attributes[INPUT_KEY]);
  const output = tokenValue(attributes[OUTPUT_KEY]);

  const hasCacheRead = CACHE_READ_KEYS.some((key) => attributes[key] !== undefined);
  const hasCacheWrite = CACHE_WRITE_KEYS.some((key) => attributes[key] !== undefined);
  const hasCacheInfo = hasCacheRead || hasCacheWrite;

  const cacheRead = firstTokenValue(attributes, CACHE_READ_KEYS);
  const cacheWrite = firstTokenValue(attributes, CACHE_WRITE_KEYS);
  const reasoning = firstTokenValue(attributes, REASONING_KEYS);

  if (
    reportedInput <= 0 &&
    output <= 0 &&
    cacheRead <= 0 &&
    cacheWrite <= 0 &&
    reasoning <= 0
  ) {
    return null;
  }

  const status = hasCacheInfo ? "known" : "unavailable";

  const event: CopilotUsageEvent = {
    timestampMs: resolveTimestampMs(payload) ?? record.fileModifiedAtMs,
    modelId: resolveModelId(payload, attributes),

    inputTokens: reportedInput,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    reasoningOutputTokens: reasoning,

    cacheReadStatus: status,
    cacheWriteStatus: status,

    sourceType: classifySourceType(payload, attributes),

    filePath: record.filePath,
    lineNumber: record.lineNumber
  };

  applyIdentity(event, payload, attributes);

  return event;
}

/**
 * Return the flat top-level attributes map only if it is a plain object. Arrays
 * (OTLP key/value lists) are rejected so they yield no event.
 */
function flatAttributes(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return null;
  }
  return asRecord(value);
}

// ────────────────────────────────────────────────────────────────────────────
// Source classification
// ────────────────────────────────────────────────────────────────────────────

function classifySourceType(
  payload: Record<string, unknown>,
  attributes: Record<string, unknown>
): CopilotUsageEventSource {
  const operation = stringValue(attributes["gen_ai.operation.name"]);
  const eventName = stringValue(attributes["event.name"]);
  const recordName = stringValue(payload.name);

  if (operation === "chat" || recordName === "chat") {
    return "chat-span";
  }

  if (eventName === "copilot_chat.agent.turn" || operation === "invoke_agent") {
    if (eventName && eventName.includes("agent.summary")) {
      return "agent-summary-span";
    }
    return "agent-turn-log";
  }

  if (eventName && eventName.includes("agent.summary")) {
    return "agent-summary-span";
  }

  if (operation === "inference") {
    return "inference-log";
  }

  return "chat-span";
}

// ────────────────────────────────────────────────────────────────────────────
// Identity fields
// ────────────────────────────────────────────────────────────────────────────

function applyIdentity(
  event: CopilotUsageEvent,
  payload: Record<string, unknown>,
  attributes: Record<string, unknown>
): void {
  const traceId =
    stringValue(attributes["gen_ai.trace.id"]) ??
    stringValue(attributes["trace_id"]) ??
    stringValue(payload.traceId);
  if (traceId !== undefined) {
    event.traceId = traceId;
  }

  const spanId = stringValue(payload.spanId) ?? stringValue(attributes["span_id"]);
  if (spanId !== undefined) {
    event.spanId = spanId;
  }

  const responseId = stringValue(attributes["gen_ai.response.id"]);
  if (responseId !== undefined) {
    event.responseId = responseId;
  }

  const conversationId =
    stringValue(attributes["conversation.id"]) ??
    stringValue(attributes["gen_ai.conversation.id"]);
  if (conversationId !== undefined) {
    event.conversationId = conversationId;
  }

  const sessionId = stringValue(attributes["session.id"]);
  if (sessionId !== undefined) {
    event.sessionId = sessionId;
  }

  const agentId =
    stringValue(attributes["agent.id"]) ?? stringValue(attributes["gen_ai.agent.id"]);
  if (agentId !== undefined) {
    event.agentId = agentId;
  }

  const turnIndex = intValue(attributes["turn.index"]);
  if (turnIndex !== undefined) {
    event.turnIndex = turnIndex;
  }

  const durationMs = finiteNumber(attributes["duration.ms"]) ?? finiteNumber(payload.duration);
  if (durationMs !== undefined) {
    event.durationMs = durationMs;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Model resolution
// ────────────────────────────────────────────────────────────────────────────

function resolveModelId(
  payload: Record<string, unknown>,
  attributes: Record<string, unknown>
): string {
  return (
    stringValue(attributes["gen_ai.response.model"]) ??
    stringValue(attributes["gen_ai.request.model"]) ??
    stringValue(payload.model) ??
    "unknown"
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Timestamp resolution (hrTime FIRST)
// ────────────────────────────────────────────────────────────────────────────

const TIMESTAMP_KEYS = [
  "hrTime",
  "_hrTime",
  "endTime",
  "startTime",
  "time",
  "timestamp",
  "observedTimestamp",
  "timeUnixNano"
] as const;

function resolveTimestampMs(payload: Record<string, unknown>): number | undefined {
  for (const key of TIMESTAMP_KEYS) {
    const ms = timestampToMs(payload[key]);
    if (ms !== undefined) {
      return ms;
    }
  }
  return undefined;
}

function timestampToMs(value: unknown): number | undefined {
  // [seconds, nanoseconds] hrTime style.
  if (Array.isArray(value)) {
    const [seconds, nanoseconds] = value;
    if (
      typeof seconds === "number" &&
      Number.isFinite(seconds) &&
      typeof nanoseconds === "number" &&
      Number.isFinite(nanoseconds)
    ) {
      return seconds * 1000 + nanoseconds / 1_000_000;
    }
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (/^-?\d+$/.test(trimmed)) {
      return numericMagnitudeToMs(trimmed);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return numericMagnitudeToMs(String(Math.trunc(value)));
  }

  return undefined;
}

/**
 * Interpret an integer string by magnitude: <1e11 → unix seconds; <1e14 → unix
 * milliseconds; otherwise unix nanoseconds. Nanoseconds are divided via BigInt
 * to stay precise beyond Number.MAX_SAFE_INTEGER.
 */
function numericMagnitudeToMs(digits: string): number | undefined {
  let big: bigint;
  try {
    big = BigInt(digits);
  } catch {
    return undefined;
  }

  const abs = big < 0n ? -big : big;

  if (abs < 100_000_000_000n) {
    return Number(big) * 1000;
  }
  if (abs < 100_000_000_000_000n) {
    return Number(big);
  }
  return Number(big / 1_000_000n);
}

// ────────────────────────────────────────────────────────────────────────────
// Value coercion
// ────────────────────────────────────────────────────────────────────────────

function firstTokenValue(
  attributes: Record<string, unknown>,
  keys: readonly string[]
): number {
  for (const key of keys) {
    if (attributes[key] !== undefined) {
      return tokenValue(attributes[key]);
    }
  }
  return 0;
}

/** Token counts: number or numeric string, truncated to a non-negative int. */
function tokenValue(value: unknown): number {
  const num = finiteNumber(value);
  if (num === undefined) {
    return 0;
  }
  return Math.max(0, Math.trunc(num));
}

function intValue(value: unknown): number | undefined {
  const num = finiteNumber(value);
  return num === undefined ? undefined : Math.trunc(num);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value) {
    return value;
  }
  return undefined;
}
