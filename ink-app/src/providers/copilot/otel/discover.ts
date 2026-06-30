import { promises as fs } from "node:fs";
import * as path from "node:path";

import type {
  CopilotOtelDiscoveryResult,
  CopilotOtelFile,
  CopilotOtelFileSource
} from "../types.js";
import {
  getConfiguredCopilotOutfiles,
  getCopilotOtelPath,
  getVsCodeUserRoots
} from "./configure.js";

export type DiscoverCopilotOtelFilesOptions = {
  root?: string;
  env?: NodeJS.ProcessEnv;
  explicitPaths?: string[];
};

type Candidate = {
  path: string;
  source: CopilotOtelFileSource;
};

// More specific sources win when the same resolved path appears from multiple
// origins. Higher number = more specific.
const SOURCE_PRIORITY: Record<CopilotOtelFileSource, number> = {
  explicit: 5,
  environment: 4,
  vscode: 3,
  "vscode-insiders": 3,
  "copilot-cli": 2,
  unknown: 1
};

function dedupKey(resolvedPath: string): string {
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

function isPermissionError(error: unknown): boolean {
  return isErrnoException(error) && (error.code === "EACCES" || error.code === "EPERM");
}

/**
 * Classify a configured VS Code outfile into "vscode" vs "vscode-insiders" by
 * locating which user root it lives under. The stable root is index 0 and the
 * Insiders root is index 1 (see getVsCodeUserRoots). Falls back to "vscode".
 */
function classifyVsCodeOutfile(resolvedOutfile: string, root: string): CopilotOtelFileSource {
  const userRoots = getVsCodeUserRoots(root);
  const key = dedupKey(resolvedOutfile);
  if (userRoots.length > 1) {
    const insidersRoot = dedupKey(path.resolve(userRoots[1]));
    if (key === insidersRoot || key.startsWith(insidersRoot + path.sep)) {
      return "vscode-insiders";
    }
  }
  return "vscode";
}

export async function discoverCopilotOtelFiles(
  options?: DiscoverCopilotOtelFilesOptions
): Promise<CopilotOtelDiscoveryResult> {
  const root = options?.root ?? process.cwd();
  const env = options?.env ?? process.env;
  const explicitPaths = options?.explicitPaths ?? [];

  const warnings: string[] = [];
  const candidates: Candidate[] = [];

  // 1. Explicit paths.
  for (const explicit of explicitPaths) {
    if (typeof explicit === "string" && explicit.length > 0) {
      candidates.push({ path: explicit, source: "explicit" });
    }
  }

  // 2. Environment exporter path.
  const envPath = env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  if (typeof envPath === "string" && envPath.length > 0) {
    candidates.push({ path: envPath, source: "environment" });
  }

  // 3. VS Code / Insiders configured outfiles.
  try {
    const configured = await getConfiguredCopilotOutfiles(root);
    for (const entry of configured) {
      const resolved = path.resolve(entry.path);
      candidates.push({ path: entry.path, source: classifyVsCodeOutfile(resolved, root) });
    }
  } catch (error) {
    if (isPermissionError(error)) {
      warnings.push("Failed to read VS Code Copilot settings: permission denied.");
    }
    // Missing settings or any other read issue is not an error here.
  }

  // 4. Directory scan of <root>/.copilot/otel/*.jsonl (copilot-cli).
  const otelDir = path.dirname(getCopilotOtelPath(root));
  try {
    const entries = await fs.readdir(otelDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".jsonl")) {
        continue;
      }
      candidates.push({ path: path.join(otelDir, entry.name), source: "copilot-cli" });
    }
  } catch (error) {
    if (isPermissionError(error)) {
      warnings.push(`Failed to read Copilot OTEL directory ${otelDir}: permission denied.`);
    }
    // ENOENT (missing directory) and similar are not errors — skip.
  }

  // Resolve + dedup, keeping the most specific source on collision.
  const bySource = new Map<string, Candidate & { resolved: string }>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path);
    const key = dedupKey(resolved);
    const existing = bySource.get(key);
    if (!existing || SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[existing.source]) {
      bySource.set(key, { ...candidate, resolved });
    }
  }

  // Filter to readable regular files and collect stat metadata.
  const files: CopilotOtelFile[] = [];
  for (const candidate of bySource.values()) {
    let isFile = false;
    let modifiedAtMs = 0;
    let sizeBytes = 0;
    try {
      const stats = await fs.stat(candidate.resolved);
      isFile = stats.isFile();
      modifiedAtMs = stats.mtimeMs;
      sizeBytes = stats.size;
    } catch (error) {
      if (isPermissionError(error)) {
        warnings.push(`Failed to read Copilot OTEL file ${candidate.resolved}: permission denied.`);
      }
      // Missing file or other stat failures simply drop the candidate.
      continue;
    }

    if (!isFile) {
      continue;
    }

    try {
      await fs.access(candidate.resolved, fs.constants.R_OK);
    } catch (error) {
      if (isPermissionError(error)) {
        warnings.push(`Failed to read Copilot OTEL file ${candidate.resolved}: permission denied.`);
      }
      continue;
    }

    files.push({
      path: candidate.resolved,
      source: candidate.source,
      modifiedAtMs,
      sizeBytes
    });
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
