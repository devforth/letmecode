import fs from "node:fs";
import readline from "node:readline";

import { asRecord } from "../../limits.js";
import type { UsageValueStatus } from "../../contract.js";
import type { CopilotOtelFile } from "./discover.js";

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

const TIMESTAMP_KEYS = [
  "endTime",
  "startTime",
  "hrTime",
  "_hrTime",
  "time",
  "timestamp",
  "observedTimestamp",
  "timeUnixNano"
] as const;

export type CopilotUsageEvent = {
  timestampMs: number;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningOutputTokens: number;
  cacheReadStatus: UsageValueStatus;
  cacheWriteStatus: UsageValueStatus;
  traceId?: string;
  spanId?: string;
  responseId?: string;
  sessionId?: string;
  durationMs?: number;
  filePath: string;
  lineNumber: number;
};

export type CopilotOtelParseResult = {
  events: CopilotUsageEvent[];
  filesScanned: number;
  linesRead: number;
  malformedLines: number;
  duplicatesRemoved: number;
  warnings: string[];
};

type RawRecord = {
  payload: unknown;
  filePath: string;
  lineNumber: number;
  fileModifiedAtMs: number;
};

type TraceContext = {
  modelId?: string;
};

export async function parseCopilotOtelFiles(
  files: CopilotOtelFile[]
): Promise<CopilotOtelParseResult> {
  const records: RawRecord[] = [];
  const warnings: string[] = [];
  let linesRead = 0;
  let malformedLines = 0;

  for (const file of files) {
    try {
      const result = await readJsonlFile(file);
      records.push(...result.records);
      linesRead += result.linesRead;
      malformedLines += result.malformedLines;
    } catch (error) {
      warnings.push(
        `Failed to read Copilot OTEL file ${file.path}: ${describeReadError(error)}.`
      );
    }
  }

  const traceContexts = collectTraceContexts(records);
  const { events, duplicatesRemoved } = normalizeAndDeduplicate(
    records,
    traceContexts
  );

  return {
    events,
    filesScanned: files.length,
    linesRead,
    malformedLines,
    duplicatesRemoved,
    warnings
  };
}

async function readJsonlFile(file: CopilotOtelFile): Promise<{
  records: RawRecord[];
  linesRead: number;
  malformedLines: number;
}> {
  const records: RawRecord[] = [];
  const stream = fs.createReadStream(file.path, { encoding: "utf8" });
  const lineReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });
  let lineNumber = 0;
  let malformedLines = 0;

  try {
    for await (const line of lineReader) {
      lineNumber += 1;
      if (!line.trim()) {
        continue;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }

      records.push({
        payload,
        filePath: file.path,
        lineNumber,
        fileModifiedAtMs: file.modifiedAtMs
      });
    }
  } finally {
    lineReader.close();
    stream.destroy();
  }

  return { records, linesRead: lineNumber, malformedLines };
}

function collectTraceContexts(records: RawRecord[]): Map<string, TraceContext> {
  const contexts = new Map<string, TraceContext>();
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (!payload) {
      continue;
    }
    const attributes = flatAttributes(payload.attributes);
    if (!attributes) {
      continue;
    }
    const traceId = resolveTraceId(payload, attributes);
    if (!traceId) {
      continue;
    }
    const context = contexts.get(traceId) ?? {};
    context.modelId ??= resolveModelId(payload, attributes);
    contexts.set(traceId, context);
  }
  return contexts;
}

function normalizeAndDeduplicate(
  records: RawRecord[],
  traceContexts: Map<string, TraceContext>
): { events: CopilotUsageEvent[]; duplicatesRemoved: number } {
  const events = new Map<string, CopilotUsageEvent>();
  let duplicatesRemoved = 0;

  for (const record of records) {
    const event = normalizeRecord(record, traceContexts);
    if (!event) {
      continue;
    }

    const key =
      event.traceId && event.spanId
        ? `${event.traceId}:${event.spanId}`
        : `${event.filePath}:${event.lineNumber}`;
    if (events.has(key)) {
      duplicatesRemoved += 1;
      continue;
    }
    events.set(key, event);
  }

  return {
    events: [...events.values()].sort(compareEvents),
    duplicatesRemoved
  };
}

function normalizeRecord(
  record: RawRecord,
  traceContexts: Map<string, TraceContext>
): CopilotUsageEvent | null {
  const payload = asRecord(record.payload);
  if (!payload) {
    return null;
  }
  const attributes = flatAttributes(payload.attributes);
  if (!attributes || !isChatSpan(payload, attributes)) {
    return null;
  }

  const inputTokens = tokenValue(attributes[INPUT_KEY]);
  const outputTokens = tokenValue(attributes[OUTPUT_KEY]);
  const hasCacheRead = CACHE_READ_KEYS.some(
    (key) => attributes[key] !== undefined
  );
  const hasCacheWrite = CACHE_WRITE_KEYS.some(
    (key) => attributes[key] !== undefined
  );
  const cacheReadInputTokens = firstTokenValue(attributes, CACHE_READ_KEYS);
  const cacheWriteInputTokens = firstTokenValue(attributes, CACHE_WRITE_KEYS);
  const reasoningOutputTokens = firstTokenValue(attributes, REASONING_KEYS);

  if (
    inputTokens <= 0 &&
    outputTokens <= 0 &&
    cacheReadInputTokens <= 0 &&
    cacheWriteInputTokens <= 0 &&
    reasoningOutputTokens <= 0
  ) {
    return null;
  }

  const traceId = resolveTraceId(payload, attributes);
  const context = traceId ? traceContexts.get(traceId) : undefined;
  const cacheStatus: UsageValueStatus =
    hasCacheRead || hasCacheWrite ? "known" : "unavailable";

  const event: CopilotUsageEvent = {
    timestampMs: resolveTimestampMs(payload) ?? record.fileModifiedAtMs,
    modelId: resolveModelId(payload, attributes) ?? context?.modelId ?? "unknown",
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    reasoningOutputTokens,
    cacheReadStatus: cacheStatus,
    cacheWriteStatus: cacheStatus,
    filePath: record.filePath,
    lineNumber: record.lineNumber
  };

  applyOptionalIdentity(event, payload, attributes, traceId);
  return event;
}

function isChatSpan(
  payload: Record<string, unknown>,
  attributes: Record<string, unknown>
): boolean {
  const operation = stringValue(attributes["gen_ai.operation.name"]);
  const name = stringValue(payload.name) ?? "";
  return operation === "chat" || name === "chat" || name.startsWith("chat ");
}

function applyOptionalIdentity(
  event: CopilotUsageEvent,
  payload: Record<string, unknown>,
  attributes: Record<string, unknown>,
  traceId: string | undefined
): void {
  if (traceId) {
    event.traceId = traceId;
  }

  const spanId = resolveSpanId(payload, attributes);
  if (spanId) {
    event.spanId = spanId;
  }

  const responseId = stringValue(attributes["gen_ai.response.id"]);
  if (responseId) {
    event.responseId = responseId;
  }

  const sessionId =
    stringValue(attributes["session.id"]) ??
    stringValue(attributes["copilot_chat.session_id"]) ??
    stringValue(attributes["copilot_chat.chat_session_id"]) ??
    stringValue(attributes["github.copilot.interaction_id"]);
  if (sessionId) {
    event.sessionId = sessionId;
  }

  const durationMs = finiteNumber(attributes["duration.ms"]) ?? finiteNumber(payload.duration);
  if (durationMs !== undefined) {
    event.durationMs = durationMs;
  }
}

function flatAttributes(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return null;
  }
  return asRecord(value);
}

function resolveModelId(
  payload: Record<string, unknown>,
  attributes: Record<string, unknown>
): string | undefined {
  return (
    stringValue(attributes["gen_ai.response.model"]) ??
    stringValue(attributes["gen_ai.request.model"]) ??
    stringValue(payload.model)
  );
}

function resolveTraceId(
  payload: Record<string, unknown>,
  attributes: Record<string, unknown>
): string | undefined {
  return (
    stringValue(attributes["gen_ai.trace.id"]) ??
    stringValue(attributes.trace_id) ??
    stringValue(payload.traceId) ??
    spanContextValue(payload, "traceId")
  );
}

function resolveSpanId(
  payload: Record<string, unknown>,
  attributes: Record<string, unknown>
): string | undefined {
  return (
    stringValue(payload.spanId) ??
    stringValue(attributes.span_id) ??
    spanContextValue(payload, "spanId")
  );
}

function spanContextValue(
  payload: Record<string, unknown>,
  key: "traceId" | "spanId"
): string | undefined {
  const spanContext = asRecord(payload.spanContext);
  return spanContext ? stringValue(spanContext[key]) : undefined;
}

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
  if (abs < 100_000_000_000_000_000n) {
    return Number(big / 1_000n);
  }
  return Number(big / 1_000_000n);
}

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

function tokenValue(value: unknown): number {
  const num = finiteNumber(value);
  return num === undefined ? 0 : Math.max(0, Math.trunc(num));
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compareEvents(a: CopilotUsageEvent, b: CopilotUsageEvent): number {
  if (a.timestampMs !== b.timestampMs) {
    return a.timestampMs - b.timestampMs;
  }
  if (a.filePath !== b.filePath) {
    return a.filePath < b.filePath ? -1 : 1;
  }
  return a.lineNumber - b.lineNumber;
}

function describeReadError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;

  if (code === "EACCES") {
    return "permission denied";
  }
  if (typeof code === "string" && code.length > 0) {
    return code;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "unknown error";
}
