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

// Completion time first, then start, then the high-resolution clocks.
const TIMESTAMP_KEYS = ["endTime", "startTime", "hrTime", "_hrTime", "time"] as const;

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

/**
 * Stream the discovered JSONL files and produce de-duplicated canonical Copilot
 * chat token events. Only records explicitly recognizable as chat spans are
 * kept (see {@link isChatSpan}); anything else is ignored rather than guessed.
 */
export async function parseCopilotOtelFiles(
  files: CopilotOtelFile[]
): Promise<CopilotOtelParseResult> {
  const events: CopilotUsageEvent[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let linesRead = 0;
  let malformedLines = 0;
  let duplicatesRemoved = 0;

  for (const file of files) {
    try {
      await readJsonlFile(file, (payload, lineNumber) => {
        linesRead += 1;
        if (payload === MALFORMED) {
          malformedLines += 1;
          return;
        }
        const event = toUsageEvent(payload, file, lineNumber);
        if (!event) {
          return;
        }
        const key =
          event.traceId && event.spanId
            ? `${event.traceId}:${event.spanId}`
            : `${event.filePath}:${event.lineNumber}`;
        if (seen.has(key)) {
          duplicatesRemoved += 1;
          return;
        }
        seen.add(key);
        events.push(event);
      });
    } catch (error) {
      const reason = isPermissionError(error) ? "permission denied" : "read error";
      warnings.push(`Failed to read Copilot OTEL file ${file.path}: ${reason}.`);
    }
  }

  events.sort(compareEvents);
  return { events, filesScanned: files.length, linesRead, malformedLines, duplicatesRemoved, warnings };
}

const MALFORMED = Symbol("malformed");

async function readJsonlFile(
  file: CopilotOtelFile,
  onLine: (payload: unknown, lineNumber: number) => void
): Promise<void> {
  const stream = fs.createReadStream(file.path, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lineReader) {
      lineNumber += 1;
      if (!line.trim()) {
        continue;
      }
      try {
        onLine(JSON.parse(line), lineNumber);
      } catch {
        onLine(MALFORMED, lineNumber);
      }
    }
  } finally {
    lineReader.close();
    stream.destroy();
  }
}

function toUsageEvent(
  payload: unknown,
  file: CopilotOtelFile,
  lineNumber: number
): CopilotUsageEvent | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const attributes = flatAttributes(record.attributes);
  if (!attributes || !isChatSpan(record, attributes)) {
    return null;
  }

  const inputTokens = tokenValue(attributes[INPUT_KEY]);
  const outputTokens = tokenValue(attributes[OUTPUT_KEY]);
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

  const hasCache =
    CACHE_READ_KEYS.some((k) => attributes[k] !== undefined) ||
    CACHE_WRITE_KEYS.some((k) => attributes[k] !== undefined);
  const cacheStatus: UsageValueStatus = hasCache ? "known" : "unavailable";

  const event: CopilotUsageEvent = {
    timestampMs: resolveTimestampMs(record) ?? file.modifiedAtMs,
    modelId: resolveModelId(record, attributes),
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    reasoningOutputTokens,
    cacheReadStatus: cacheStatus,
    cacheWriteStatus: cacheStatus,
    filePath: file.path,
    lineNumber
  };

  const traceId =
    stringValue(attributes["gen_ai.trace.id"]) ??
    stringValue(attributes.trace_id) ??
    stringValue(record.traceId) ??
    spanContextValue(record, "traceId");
  if (traceId) {
    event.traceId = traceId;
  }
  const spanId =
    stringValue(record.spanId) ??
    stringValue(attributes.span_id) ??
    spanContextValue(record, "spanId");
  if (spanId) {
    event.spanId = spanId;
  }
  const responseId = stringValue(attributes["gen_ai.response.id"]);
  if (responseId) {
    event.responseId = responseId;
  }

  return event;
}

/** A canonical Copilot chat span: the only record kind we count. */
function isChatSpan(
  record: Record<string, unknown>,
  attributes: Record<string, unknown>
): boolean {
  const operation = stringValue(attributes["gen_ai.operation.name"]);
  const name = stringValue(record.name) ?? "";
  return operation === "chat" || name === "chat" || name.startsWith("chat ");
}

function resolveModelId(
  record: Record<string, unknown>,
  attributes: Record<string, unknown>
): string {
  return (
    stringValue(attributes["gen_ai.response.model"]) ??
    stringValue(attributes["gen_ai.request.model"]) ??
    stringValue(record.model) ??
    "unknown"
  );
}

function flatAttributes(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) ? null : asRecord(value);
}

function spanContextValue(
  record: Record<string, unknown>,
  key: "traceId" | "spanId"
): string | undefined {
  const spanContext = asRecord(record.spanContext);
  return spanContext ? stringValue(spanContext[key]) : undefined;
}

function resolveTimestampMs(record: Record<string, unknown>): number | undefined {
  for (const key of TIMESTAMP_KEYS) {
    const ms = timestampToMs(record[key]);
    if (ms !== undefined) {
      return ms;
    }
  }
  return undefined;
}

function timestampToMs(value: unknown): number | undefined {
  // [seconds, nanoseconds] hrTime/startTime/endTime form.
  if (Array.isArray(value)) {
    const [seconds, nanoseconds] = value;
    if (typeof seconds === "number" && typeof nanoseconds === "number") {
      return seconds * 1000 + nanoseconds / 1_000_000;
    }
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e11 ? value * 1000 : value; // unix seconds vs milliseconds
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return n < 1e11 ? n * 1000 : n;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstTokenValue(attributes: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    if (attributes[key] !== undefined) {
      return tokenValue(attributes[key]);
    }
  }
  return 0;
}

function tokenValue(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
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

function isPermissionError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "EACCES" || code === "EPERM";
}
