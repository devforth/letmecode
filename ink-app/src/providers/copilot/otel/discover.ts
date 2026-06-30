import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getConfiguredCopilotOutfiles, getCopilotOtelPath } from "./configure.js";

export type DiscoverCopilotOtelFilesOptions = {
  root?: string;
  env?: NodeJS.ProcessEnv;
};

export type CopilotOtelFile = {
  path: string;
  modifiedAtMs: number;
};

export type CopilotOtelDiscoveryResult = {
  files: CopilotOtelFile[];
  warnings: string[];
};

function dedupKey(resolvedPath: string): string {
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function isPermissionError(error: unknown): boolean {
  const code =
    error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Discover the Copilot OTEL JSONL files to read, from three sources:
 *   1. the `COPILOT_OTEL_FILE_EXPORTER_PATH` env var (Copilot CLI),
 *   2. the `outfile` configured in VS Code / Insiders settings, and
 *   3. every `*.jsonl` in `<root>/.copilot/otel/`.
 * This covers the VS Code extension, a standalone Copilot CLI, and the CLI run
 * from VS Code, on Linux/Windows/macOS. Paths are resolved and de-duplicated
 * (case-insensitively on Windows); the first occurrence wins.
 */
export async function discoverCopilotOtelFiles(
  options?: DiscoverCopilotOtelFilesOptions
): Promise<CopilotOtelDiscoveryResult> {
  const root = options?.root ?? process.cwd();
  const env = options?.env ?? process.env;

  const warnings: string[] = [];
  const candidatePaths: string[] = [];

  // 1. Environment exporter path.
  const envPath = env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  if (typeof envPath === "string" && envPath.length > 0) {
    candidatePaths.push(envPath);
  }

  // 2. VS Code / Insiders configured outfiles.
  try {
    for (const entry of await getConfiguredCopilotOutfiles(root)) {
      candidatePaths.push(entry.path);
    }
  } catch (error) {
    if (isPermissionError(error)) {
      warnings.push("Failed to read VS Code Copilot settings: permission denied.");
    }
    // Missing settings or any other read issue is not an error here.
  }

  // 3. Directory scan of <root>/.copilot/otel/*.jsonl.
  const otelDir = path.dirname(getCopilotOtelPath(root));
  try {
    const entries = await fs.readdir(otelDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name.toLowerCase().endsWith(".jsonl")) {
        candidatePaths.push(path.join(otelDir, entry.name));
      }
    }
  } catch (error) {
    if (isPermissionError(error)) {
      warnings.push(`Failed to read Copilot OTEL directory ${otelDir}: permission denied.`);
    }
    // ENOENT (missing directory) and similar are not errors — skip.
  }

  // Resolve, de-dup by path (first wins), and keep readable regular files.
  const seen = new Set<string>();
  const files: CopilotOtelFile[] = [];
  for (const candidate of candidatePaths) {
    const resolved = path.resolve(candidate);
    const key = dedupKey(resolved);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    try {
      const stats = await fs.stat(resolved);
      if (!stats.isFile()) {
        continue;
      }
      await fs.access(resolved, fs.constants.R_OK);
      files.push({ path: resolved, modifiedAtMs: stats.mtimeMs });
    } catch (error) {
      if (isPermissionError(error)) {
        warnings.push(`Failed to read Copilot OTEL file ${resolved}: permission denied.`);
      }
      // Missing file or other failures simply drop the candidate.
    }
  }

  // Stable sort by modifiedAtMs ASC, then path ASC.
  files.sort((a, b) => {
    if (a.modifiedAtMs !== b.modifiedAtMs) {
      return a.modifiedAtMs - b.modifiedAtMs;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return { files, warnings };
}
