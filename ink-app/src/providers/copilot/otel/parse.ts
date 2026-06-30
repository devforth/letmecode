import fs from "node:fs";
import readline from "node:readline";

import type {
  CopilotOtelFile,
  CopilotOtelParseResult,
  CopilotRawOtelRecord
} from "../types.js";

/**
 * Physical JSONL reading only. Streams each discovered Copilot OTEL file
 * line-by-line and turns each non-empty, well-formed line into a
 * {@link CopilotRawOtelRecord}. It does NOT inspect gen_ai attributes,
 * resolve models, count tokens, deduplicate, price, or build daily usage —
 * that is the job of the normalize/aggregate stages.
 */
export async function parseCopilotOtelFiles(
  files: CopilotOtelFile[]
): Promise<CopilotOtelParseResult> {
  const records: CopilotRawOtelRecord[] = [];
  const warnings: string[] = [];
  let linesRead = 0;
  let malformedLines = 0;

  for (const file of files) {
    try {
      await parseOneFile(file, records, () => {
        linesRead += 1;
      }, () => {
        malformedLines += 1;
      });
    } catch (error) {
      warnings.push(
        `Failed to read Copilot OTEL file ${file.path}: ${describeReadError(error)}.`
      );
    }
  }

  return {
    records,
    filesScanned: files.length,
    linesRead,
    malformedLines,
    warnings
  };
}

async function parseOneFile(
  file: CopilotOtelFile,
  records: CopilotRawOtelRecord[],
  onLine: () => void,
  onMalformed: () => void
): Promise<void> {
  const stream = fs.createReadStream(file.path, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;

  try {
    for await (const line of lineReader) {
      lineNumber += 1;
      onLine();

      if (!line.trim()) {
        continue;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        onMalformed();
        continue;
      }

      records.push({
        payload,
        filePath: file.path,
        fileSource: file.source,
        lineNumber,
        fileModifiedAtMs: file.modifiedAtMs
      });
    }
  } finally {
    lineReader.close();
    stream.destroy();
  }
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
