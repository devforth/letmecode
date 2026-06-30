import os from "node:os";
import path from "node:path";
import {
  UsageProviderBase,
  createEmptyUsageTotals,
  type LimitWindowRow,
  type ProviderStats,
  type ProviderStatsOptions
} from "../contract.js";
import {
  configureCopilotVsCodeLogging,
  getCopilotCliOtelEnv,
  getConfiguredCopilotOutfiles
} from "./otel/configure.js";
import { discoverCopilotOtelFiles } from "./otel/discover.js";
import { parseCopilotOtelFiles } from "./otel/parse.js";
import {
  getCopilotUserInfo,
  type CopilotQuota,
  type CopilotQuotaInfo,
  type CopilotUserInfoResult
} from "./quota.js";
import { aggregateCopilotUsage, type CopilotAggregatedUsage } from "./usage/aggregate.js";

export { configureCopilotVsCodeLogging, getCopilotCliOtelEnv };
export type {
  CopilotVsCodeLoggingOptions,
  CopilotVsCodeLoggingResult
} from "./otel/configure.js";

// Quota buckets shown as the most prominent (primary) limit windows.
const PRIMARY_QUOTA_IDS: ReadonlySet<string> = new Set([
  "premium_interactions",
  "chat",
  "completions"
]);

export type CopilotUsageProviderOptions = {
  root?: string;
  env?: NodeJS.ProcessEnv;
  fetchUserInfo?: (options: { env: NodeJS.ProcessEnv }) => Promise<CopilotUserInfoResult>;
};

type UsageLoad = {
  filesScanned: number;
  linesRead: number;
  aggregated: CopilotAggregatedUsage;
  warnings: string[];
};

/**
 * Joins two INDEPENDENT sources — the Copilot quota HTTP API and local OTEL
 * JSONL token usage. A failure in either degrades to a warning and never blocks
 * the other.
 */
export class CopilotUsageProvider extends UsageProviderBase {
  private readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchUserInfo: (options: { env: NodeJS.ProcessEnv }) => Promise<CopilotUserInfoResult>;

  constructor(options: CopilotUsageProviderOptions = {}) {
    super("copilot", "Copilot");
    this.root = path.resolve(options.root ?? os.homedir());
    this.env = options.env ?? process.env;
    this.fetchUserInfo = options.fetchUserInfo ?? getCopilotUserInfo;
  }

  async getStats(_options: ProviderStatsOptions = {}): Promise<ProviderStats> {
    const [quotaResult, usageResult] = await Promise.allSettled([
      this.fetchUserInfo({ env: this.env }),
      this.loadUsage()
    ]);

    const warnings: string[] = [];

    let quotaInfo: CopilotQuotaInfo | undefined;
    if (quotaResult.status === "fulfilled") {
      warnings.push(...quotaResult.value.warnings);
      quotaInfo = quotaResult.value.quotaInfo;
    } else {
      warnings.push("Copilot plan and quota are unavailable.");
    }

    const usage: UsageLoad =
      usageResult.status === "fulfilled"
        ? usageResult.value
        : {
            filesScanned: 0,
            linesRead: 0,
            aggregated: aggregateCopilotUsage([]),
            warnings: ["Copilot OTEL usage is unavailable."]
          };
    warnings.push(...usage.warnings);

    const { windows, unknownLabels } = quotaInfo
      ? buildLimitWindows(quotaInfo)
      : { windows: [], unknownLabels: [] };
    if (unknownLabels.length > 0) {
      warnings.push(`Copilot quota usage is unknown for: ${unknownLabels.join(", ")}.`);
    }

    const { aggregated } = usage;
    return {
      providerId: this.id,
      providerLabel: this.label,
      summary: {
        filesScanned: usage.filesScanned,
        linesRead: usage.linesRead,
        tokenEvents: aggregated.tokenEvents,
        totals: aggregated.summaryTotals,
        distinctModels: aggregated.distinctModels,
        distinctPlanTypes: quotaInfo?.plan ? [quotaInfo.plan] : [],
        rootLabel: "~/.copilot/otel",
        rootPath: path.join(this.root, ".copilot", "otel")
      },
      modelUsage: aggregated.modelUsage,
      dayUsage: aggregated.dayUsage,
      primaryLimitWindows: windows.filter((w) => w.scope === "primary"),
      secondaryLimitWindows: windows.filter((w) => w.scope === "secondary"),
      warnings: dedupeWarnings(warnings)
    };
  }

  /** Discover → parse → aggregate local OTEL usage, collecting warnings. */
  private async loadUsage(): Promise<UsageLoad> {
    const discovery = await discoverCopilotOtelFiles({ root: this.root, env: this.env });
    const parsed = await parseCopilotOtelFiles(discovery.files);
    const aggregated = aggregateCopilotUsage(parsed.events);

    const warnings = [...discovery.warnings, ...parsed.warnings, ...aggregated.warnings];
    if (parsed.malformedLines > 0) {
      warnings.push(`Skipped ${parsed.malformedLines} malformed Copilot JSONL line(s).`);
    }
    if (parsed.duplicatesRemoved > 0) {
      warnings.push(`Removed ${parsed.duplicatesRemoved} duplicate Copilot usage event(s).`);
    }
    if (discovery.files.length === 0) {
      warnings.push((await describeMissingOtelFile(this.root)) ?? "No Copilot OTEL files were found.");
    } else if (aggregated.tokenEvents === 0) {
      warnings.push("No Copilot token usage events were found in the discovered OTEL file(s).");
    }

    return {
      filesScanned: parsed.filesScanned,
      linesRead: parsed.linesRead,
      aggregated,
      warnings
    };
  }
}

/**
 * When no OTEL files were discovered but VS Code is configured to export to one,
 * surface the actionable "logging is on, file not created yet" hint.
 */
async function describeMissingOtelFile(root: string): Promise<string | undefined> {
  let configured: { path: string; enabled: boolean }[];
  try {
    configured = await getConfiguredCopilotOutfiles(root);
  } catch {
    return undefined;
  }
  const missing = configured.find((entry) => entry.enabled);
  return missing
    ? `VS Code Copilot logging is enabled, but ${missing.path} has not been created yet. Reload VS Code and send a Copilot Chat request.`
    : undefined;
}

function buildLimitWindows(
  quotaInfo: CopilotQuotaInfo
): { windows: LimitWindowRow[]; unknownLabels: string[] } {
  const planType = quotaInfo.plan ?? "unknown";
  const endIso = resolveResetIso(quotaInfo.resetAt);
  const windows: LimitWindowRow[] = [];
  const unknownLabels: string[] = [];

  for (const quota of quotaInfo.quotas) {
    const usedPercent = usedPercentOf(quota);
    // LimitWindowRow cannot represent an unknown percent without showing a false
    // 0%, so an unusable bucket is omitted and reported as a warning instead.
    if (usedPercent === undefined) {
      unknownLabels.push(quota.label);
      continue;
    }
    windows.push({
      scope: PRIMARY_QUOTA_IDS.has(quota.id) ? "primary" : "secondary",
      planType,
      limitId: quota.id,
      modelType: quota.label,
      windowMinutes: 0,
      startTimeUtcIso: endIso,
      endTimeUtcIso: endIso,
      firstSeenUtcIso: endIso,
      lastSeenUtcIso: endIso,
      minUsedPercent: usedPercent,
      maxUsedPercent: usedPercent,
      // Request quotas are a different metric from estimated token credits.
      totals: createEmptyUsageTotals(),
      modelUsage: [],
      eventCount: 0
    } satisfies LimitWindowRow);
  }

  return { windows, unknownLabels };
}

/** The used percent when derivable from valid data, otherwise undefined. */
function usedPercentOf(quota: CopilotQuota): number | undefined {
  if (quota.usedPercent !== undefined) {
    return clampPercent(quota.usedPercent);
  }
  if (quota.remainingPercent !== undefined) {
    return clampPercent(100 - quota.remainingPercent);
  }
  if (quota.total !== undefined && quota.total > 0 && quota.used !== undefined) {
    return clampPercent((quota.used / quota.total) * 100);
  }
  return undefined;
}

function resolveResetIso(resetAt: string | undefined): string {
  if (resetAt) {
    const parsed = Date.parse(resetAt);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date(0).toISOString();
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}
