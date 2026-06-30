import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import { asRecord } from "../../limits.js";
import type {
  CopilotVsCodeLoggingOptions,
  CopilotVsCodeLoggingResult
} from "../types.js";

const VSCODE_OTEL_SETTINGS = {
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.captureContent": false
} as const;

export async function configureCopilotVsCodeLogging(
  options: CopilotVsCodeLoggingOptions = {}
): Promise<CopilotVsCodeLoggingResult> {
  const root = path.resolve(options.root ?? os.homedir());
  const outfile = getCopilotOtelPath(root);
  const settingsPath = options.settingsPath ?? (await getVsCodeSettingsPath(root));
  const settingsText = await readTextFileOrEmpty(settingsPath);
  const { text, changed } = updateJsoncSettings(settingsText, {
    ...VSCODE_OTEL_SETTINGS,
    "github.copilot.chat.otel.outfile": toVsCodeOutfilePath(outfile)
  });

  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(outfile), { recursive: true });
  if (changed) {
    await fs.promises.writeFile(settingsPath, text, "utf8");
  }

  return { settingsPath, outfile, changed };
}

export function getCopilotOtelPath(root: string): string {
  return path.join(root, ".copilot", "otel", "vscode.jsonl");
}

export function toVsCodeOutfilePath(filePath: string): string {
  return process.platform === "win32" ? filePath.replace(/\\/g, "/") : filePath;
}

export async function getVsCodeSettingsPath(root: string): Promise<string> {
  const userRoots = getVsCodeUserRoots(root);
  for (const userRoot of userRoots) {
    if (await isDirectory(userRoot)) {
      return path.join(userRoot, "settings.json");
    }
  }

  return path.join(userRoots[0], "settings.json");
}

export function getVsCodeUserRoots(root: string): string[] {
  if (process.platform === "darwin") {
    const applicationSupport = path.join(root, "Library", "Application Support");
    return [
      path.join(applicationSupport, "Code", "User"),
      path.join(applicationSupport, "Code - Insiders", "User")
    ];
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(root, "AppData", "Roaming");
    return [path.join(appData, "Code", "User"), path.join(appData, "Code - Insiders", "User")];
  }

  const configRoot = path.join(root, ".config");
  return [path.join(configRoot, "Code", "User"), path.join(configRoot, "Code - Insiders", "User")];
}

export async function isCopilotVsCodeLoggingEnabled(root: string, outfile: string): Promise<boolean> {
  const settings = await readJsonSettings(await getVsCodeSettingsPath(root));
  const configuredOutfile = settings["github.copilot.chat.otel.outfile"];
  return (
    settings["github.copilot.chat.otel.enabled"] === true &&
    settings["github.copilot.chat.otel.exporterType"] === "file" &&
    typeof configuredOutfile === "string" &&
    normalizeComparablePath(configuredOutfile) === normalizeComparablePath(toVsCodeOutfilePath(outfile))
  );
}

/**
 * For each VS Code user root (stable + insiders), read settings.json and report
 * the configured Copilot OTEL outfile when file export is enabled. Used by the
 * provider to detect "logging configured but the file has not been created yet".
 */
export async function getConfiguredCopilotOutfiles(
  root: string
): Promise<{ path: string; enabled: boolean }[]> {
  const results: { path: string; enabled: boolean }[] = [];
  for (const userRoot of getVsCodeUserRoots(root)) {
    const settings = await readJsonSettings(path.join(userRoot, "settings.json"));
    const enabled = settings["github.copilot.chat.otel.enabled"] === true;
    const exporterType = settings["github.copilot.chat.otel.exporterType"];
    const outfile = settings["github.copilot.chat.otel.outfile"];
    if (enabled && exporterType === "file" && typeof outfile === "string") {
      results.push({ path: path.resolve(outfile), enabled: true });
    }
  }

  return results;
}

function normalizeComparablePath(filePath: string): string {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readJsonSettings(filePath: string): Promise<Record<string, unknown>> {
  return parseJsoncSettings(await readTextFileOrEmpty(filePath));
}

async function readTextFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function parseJsoncSettings(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }

  const parsed = parse(raw) as unknown;
  return asRecord(parsed) ?? {};
}

function updateJsoncSettings(raw: string, values: Record<string, unknown>): { text: string; changed: boolean } {
  let text = raw.trim() ? raw : "{\n}";
  let changed = false;
  for (const [key, value] of Object.entries(values)) {
    if (parseJsoncSettings(text)[key] === value) {
      continue;
    }

    const edits = modify(text, [key], value, {
      formattingOptions: {
        eol: "\n",
        insertSpaces: true,
        tabSize: 4
      }
    });
    if (edits.length > 0) {
      text = applyEdits(text, edits);
      changed = true;
    }
  }

  if (changed && !text.endsWith("\n")) {
    text += "\n";
  }

  return { text, changed };
}
