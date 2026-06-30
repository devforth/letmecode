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
import { aggregateCopilotUsage } from "./usage/aggregate.js";

export { configureCopilotVsCodeLogging, getCopilotCliOtelEnv };
export type {
  CopilotVsCodeLoggingOptions,
  CopilotVsCodeLoggingResult
} from "./otel/configure.js";

/**
 * Quota buckets that map to the primary (most prominent) limit windows in the
 * dashboard. Everything else is surfaced as a secondary window.
 */
const COPILOT_PRIMARY_QUOTA_IDS: ReadonlySet<string> = new Set([
  "premium_interactions",
  "chat",
  "completions"
]);

export type CopilotUsageProviderOptions = {
  root?: string;
  env?: NodeJS.ProcessEnv;
  fetchUserInfo?: (options: {
    env: NodeJS.ProcessEnv;
    home: string;
  }) => Promise<CopilotUserInfoResult>;
};

/**
 * Orchestration layer for Copilot usage. It joins two INDEPENDENT sources:
 *   - the Copilot internal HTTP API (plan + request quota windows), and
 *   - local OTEL JSONL files (token usage).
 * A failure in either source degrades to warnings and never blocks the other.
 */
export class CopilotUsageProvider extends UsageProviderBase {
  private readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchUserInfo: (options: {
    env: NodeJS.ProcessEnv;
    home: string;
  }) => Promise<CopilotUserInfoResult>;

  constructor(options: CopilotUsageProviderOptions = {}) {
    super("copilot", "Copilot");
    this.root = path.resolve(options.root ?? os.homedir());
    this.env = options.env ?? process.env;
    this.fetchUserInfo =
      options.fetchUserInfo ?? ((opts) => getCopilotUserInfo(opts));
  }

  async getStats(_options: ProviderStatsOptions = {}): Promise<ProviderStats> {
    const warnings: string[] = [];

    // API quota and local OTEL discovery are independent; run them concurrently
    // and turn any rejection into a controlled warning (never a stack trace).
    const [quotaSettled, discoverySettled] = await Promise.allSettled([
      this.fetchUserInfo({ env: this.env, home: this.root }),
      discoverCopilotOtelFiles({ root: this.root, env: this.env })
    ]);

    let quotaInfo: CopilotQuotaInfo | undefined;
    if (quotaSettled.status === "fulfilled") {
      warnings.push(...quotaSettled.value.warnings);
      quotaInfo = quotaSettled.value.quotaInfo;
    } else {
      warnings.push("Copilot plan and quota are unavailable.");
    }

    let files: Awaited<
      ReturnType<typeof discoverCopilotOtelFiles>
    >["files"] = [];
    if (discoverySettled.status === "fulfilled") {
      files = discoverySettled.value.files;
      warnings.push(...discoverySettled.value.warnings);
    } else {
      warnings.push("Could not search for Copilot OTEL files.");
    }

    // Usage pipeline. Parsing owns JSONL streaming, chat-span filtering, simple
    // trace/span deduplication, and token normalization.
    const parseResult = await parseCopilotOtelFiles(files);
    warnings.push(...parseResult.warnings);
    if (parseResult.malformedLines > 0) {
      warnings.push(
        `Skipped ${parseResult.malformedLines} malformed Copilot JSONL line(s).`
      );
    }

    if (parseResult.duplicatesRemoved > 0) {
      warnings.push(
        `Removed ${parseResult.duplicatesRemoved} duplicate Copilot usage event(s).`
      );
    }

    const aggregated = aggregateCopilotUsage(parseResult.events);
    warnings.push(...aggregated.warnings);

    if (files.length === 0) {
      const configuredWarning = await describeMissingOtelFile(this.root, files);
      warnings.push(configuredWarning ?? "No Copilot OTEL files were found.");
    } else if (aggregated.tokenEvents === 0) {
      warnings.push(
        "No Copilot token usage events were found in the discovered OTEL file(s)."
      );
    }

    const limitWindows = quotaInfo ? buildCopilotLimitWindows(quotaInfo) : [];

    // A quota with no usable percent/total renders as 0% used, which reads as
    // "nothing used" when the value is actually unknown. Keep the window visible
    // but warn so the 0% is not mistaken for a real measurement.
    if (quotaInfo) {
      const unknown = quotaInfo.quotas
        .filter((quota) => !quotaUsedPercentIsKnown(quota))
        .map((quota) => quota.label);
      if (unknown.length > 0) {
        warnings.push(
          `Copilot quota usage is unknown for: ${unknown.join(", ")} (shown as 0%).`
        );
      }
    }

    return {
      providerId: this.id,
      providerLabel: this.label,
      summary: {
        filesScanned: parseResult.filesScanned,
        linesRead: parseResult.linesRead,
        tokenEvents: aggregated.tokenEvents,
        totals: aggregated.summaryTotals,
        distinctModels: aggregated.distinctModels,
        distinctPlanTypes: quotaInfo?.plan ? [quotaInfo.plan] : [],
        rootLabel: "~/.copilot/otel",
        rootPath: path.join(this.root, ".copilot", "otel")
      },
      modelUsage: aggregated.modelUsage,
      dayUsage: aggregated.dayUsage,
      primaryLimitWindows: limitWindows.filter(
        (window) => window.scope === "primary"
      ),
      secondaryLimitWindows: limitWindows.filter(
        (window) => window.scope === "secondary"
      ),
      warnings: dedupeWarnings(warnings)
    };
  }
}

/**
 * When no OTEL files were discovered, surface the actionable "logging is on but
 * the file does not exist yet" hint if VS Code is configured to export to a
 * path that has not been created. Returns undefined when no such configuration
 * is found (the caller falls back to the generic "no files" warning).
 */
async function describeMissingOtelFile(
  root: string,
  discovered: { path: string }[]
): Promise<string | undefined> {
  let configured: { path: string; enabled: boolean }[];
  try {
    configured = await getConfiguredCopilotOutfiles(root);
  } catch {
    return undefined;
  }

  const discoveredPaths = new Set(
    discovered.map((file) => normalizeComparablePath(file.path))
  );
  const missing = configured.find(
    (entry) =>
      entry.enabled && !discoveredPaths.has(normalizeComparablePath(entry.path))
  );
  if (!missing) {
    return undefined;
  }

  return `VS Code Copilot logging is enabled, but ${missing.path} has not been created yet. Reload VS Code and send a Copilot Chat request.`;
}

function buildCopilotLimitWindows(quotaInfo: CopilotQuotaInfo): LimitWindowRow[] {
  const planType = quotaInfo.plan ?? "unknown";
  return quotaInfo.quotas.map((quota) => {
    const usedPercent = resolveQuotaUsedPercent(quota);
    const endIso = resolveQuotaResetIso(quotaInfo.resetAt);
    const scope = COPILOT_PRIMARY_QUOTA_IDS.has(quota.id)
      ? "primary"
      : "secondary";

    return {
      scope,
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
      // Request quotas are a different metric from estimated token credits, so
      // these windows intentionally carry no token totals or model usage.
      totals: createEmptyUsageTotals(),
      modelUsage: [],
      eventCount: 0
    } satisfies LimitWindowRow;
  });
}

/** Whether a quota carries enough data to derive a real used-percent value. */
function quotaUsedPercentIsKnown(quota: CopilotQuota): boolean {
  return (
    quota.usedPercent !== undefined ||
    quota.remainingPercent !== undefined ||
    (quota.total !== undefined && quota.total > 0 && quota.used !== undefined)
  );
}

function resolveQuotaUsedPercent(quota: CopilotQuota): number {
  if (quota.usedPercent !== undefined) {
    return clampPercent(quota.usedPercent);
  }
  if (quota.remainingPercent !== undefined) {
    return clampPercent(100 - quota.remainingPercent);
  }
  if (
    quota.total !== undefined &&
    quota.total > 0 &&
    quota.used !== undefined
  ) {
    return clampPercent((quota.used / quota.total) * 100);
  }
  return 0;
}

function resolveQuotaResetIso(resetAt: string | undefined): string {
  if (resetAt) {
    const parsed = Date.parse(resetAt);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date(0).toISOString();
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

function normalizeComparablePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function dedupeWarnings(warnings: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const warning of warnings) {
    if (seen.has(warning)) {
      continue;
    }
    seen.add(warning);
    result.push(warning);
  }
  return result;
}
