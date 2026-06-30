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
import { parseCopilotOtelFiles, type CopilotUsageEvent } from "./otel/parse.js";
import {
  getCopilotUserInfo,
  subtractOneUtcCalendarMonth,
  type CopilotQuota,
  type CopilotQuotaInfo,
  type CopilotUserInfoResult
} from "./quota.js";
import {
  aggregateCopilotUsage,
  filterCopilotUsageEvents,
  type CopilotAggregatedUsage
} from "./usage/aggregate.js";

// The token-metered bucket that maps to the "AI Credits" window.
const AI_CREDITS_QUOTA_ID = "premium_interactions";

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
  events: CopilotUsageEvent[];
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
            events: [],
            aggregated: aggregateCopilotUsage([]),
            warnings: ["Copilot OTEL usage is unavailable."]
          };
    warnings.push(...usage.warnings);

    const { windows, unknownLabels, windowWarnings } = quotaInfo
      ? buildLimitWindows(quotaInfo, usage.events)
      : { windows: [], unknownLabels: [], windowWarnings: [] };
    if (unknownLabels.length > 0) {
      warnings.push(`Copilot quota usage is unknown for: ${unknownLabels.join(", ")}.`);
    }
    warnings.push(...windowWarnings);

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

    const warnings = [...discovery.warnings, ...parsed.warnings];
    if (parsed.malformedLines > 0) {
      warnings.push(`Skipped ${parsed.malformedLines} malformed Copilot JSONL line(s).`);
    }
    if (discovery.files.length === 0) {
      warnings.push((await describeMissingOtelFile(this.root)) ?? "No Copilot OTEL files were found.");
    } else if (aggregated.tokenEvents === 0) {
      warnings.push("No Copilot token usage events were found in the discovered OTEL file(s).");
    }

    return {
      filesScanned: parsed.filesScanned,
      linesRead: parsed.linesRead,
      events: parsed.events,
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

type BillingWindow = {
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
  windowMinutes: number;
};

function buildLimitWindows(
  quotaInfo: CopilotQuotaInfo,
  events: CopilotUsageEvent[]
): { windows: LimitWindowRow[]; unknownLabels: string[]; windowWarnings: string[] } {
  const planType = quotaInfo.plan ?? "unknown";
  const billing = deriveBillingWindow(quotaInfo.resetAt);
  const windows: LimitWindowRow[] = [];
  const unknownLabels: string[] = [];
  const windowWarnings: string[] = [];

  for (const quota of quotaInfo.quotas) {
    // Unlimited buckets (e.g. chat/completions on paid plans) are not limits, so
    // they get no window and no "unknown" warning.
    if (quota.unlimited) {
      continue;
    }
    const usedPercent = usedPercentOf(quota);
    // LimitWindowRow cannot represent an unknown percent without showing a false
    // 0%, so an unusable bucket is omitted and reported as a warning instead.
    if (usedPercent === undefined) {
      unknownLabels.push(quota.label);
      continue;
    }

    const isAiCredits =
      quotaInfo.tokenBasedBilling === true && quota.id === AI_CREDITS_QUOTA_ID;

    const startIso = billing ? billing.startIso : resolveResetIso(quotaInfo.resetAt);
    const endIso = billing ? billing.endIso : startIso;
    const windowMinutes = billing ? billing.windowMinutes : 0;

    let totals = createEmptyUsageTotals();
    let modelUsage: LimitWindowRow["modelUsage"] = [];
    let eventCount = 0;
    let firstSeenIso = startIso;
    let lastSeenIso = startIso;

    // For the metered AI Credits bucket, join the official percentage with the
    // local OTEL token usage that falls inside this billing window.
    if (isAiCredits && billing) {
      const windowEvents = filterCopilotUsageEvents(events, billing.startMs, billing.endMs);
      const windowUsage = aggregateCopilotUsage(windowEvents);
      totals = windowUsage.summaryTotals;
      modelUsage = windowUsage.modelUsage;
      eventCount = windowUsage.tokenEvents;

      if (windowEvents.length > 0) {
        const times = windowEvents.map((event) => event.timestampMs);
        firstSeenIso = new Date(Math.min(...times)).toISOString();
        lastSeenIso = new Date(Math.max(...times)).toISOString();

        // Some Copilot surfaces export no cache token attributes; without them
        // the API-equivalent cost cannot be computed, so say so explicitly
        // instead of presenting a misleading number.
        if (
          totals.cacheReadStatus === "unavailable" ||
          totals.cacheWriteStatus === "unavailable"
        ) {
          windowWarnings.push(
            "Copilot did not report cache token counts for some events, so the API-equivalent cost cannot be estimated exactly."
          );
        }
      } else if (officialUsageIsPositive(quota)) {
        // GitHub reports consumption but local telemetry has no matching events.
        // Don't present a trusted $0 — mark the cost unknown and warn.
        totals = {
          ...totals,
          estimatedCreditsStatus: "unavailable",
          cacheReadStatus: "unavailable",
          cacheWriteStatus: "unavailable"
        };
        windowWarnings.push(
          "Copilot reports usage in the current billing period, but no matching local OTEL events were found. Local token totals are incomplete."
        );
      }
    }

    windows.push({
      scope: PRIMARY_QUOTA_IDS.has(quota.id) ? "primary" : "secondary",
      planType,
      limitId: quota.id,
      modelType: isAiCredits ? "AI Credits" : quota.label,
      windowMinutes,
      startTimeUtcIso: startIso,
      endTimeUtcIso: endIso,
      firstSeenUtcIso: firstSeenIso,
      lastSeenUtcIso: lastSeenIso,
      minUsedPercent: usedPercent,
      maxUsedPercent: usedPercent,
      totals,
      modelUsage,
      eventCount
    } satisfies LimitWindowRow);
  }

  return { windows, unknownLabels, windowWarnings };
}

/**
 * Copilot's monthly subscriber quota always resets on the 1st at 00:00 UTC, so
 * the current window is [1st of the previous month, 1st of the reset month).
 * Returns null when no/invalid reset date is available.
 */
function deriveBillingWindow(resetAt: string | undefined): BillingWindow | null {
  if (!resetAt) {
    return null;
  }
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs)) {
    return null;
  }
  const reset = new Date(resetMs);
  const end = new Date(Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth(), 1));
  const start = subtractOneUtcCalendarMonth(end);
  const startMs = start.getTime();
  const endMs = end.getTime();
  return {
    startMs,
    endMs,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    windowMinutes: (endMs - startMs) / 60_000
  };
}

function officialUsageIsPositive(quota: CopilotQuota): boolean {
  return (
    (quota.used !== undefined && quota.used > 0) ||
    (quota.usedPercent !== undefined && quota.usedPercent > 0)
  );
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
