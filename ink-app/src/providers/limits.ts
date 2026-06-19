import {
  addUsageTotals,
  createEmptyUsageTotals,
  type LimitWindowRow,
  type LimitWindowScope,
  type UsageTotals
} from "./contract.js";

type LimitWindowAggregate = {
  scope: LimitWindowScope;
  limitId: string;
  planType: string;
  windowMinutes: number;
  minStartsAt: number;
  maxResetsAt: number;
  firstSeenMs: number;
  lastSeenMs: number;
  minUsedPercent: number;
  maxUsedPercent: number;
  totals: UsageTotals;
};

export type LimitWindowAggregates = Map<string, LimitWindowAggregate>;

export function createLimitWindowAggregates(): LimitWindowAggregates {
  return new Map<string, LimitWindowAggregate>();
}

export function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function applyRateLimits(
  windows: LimitWindowAggregates,
  rateLimits: Record<string, unknown> | null,
  eventTimeMs: number,
  deltaTotals: UsageTotals,
  planTypes: Set<string>
): void {
  if (!rateLimits) {
    return;
  }

  if (typeof rateLimits.plan_type === "string") {
    planTypes.add(rateLimits.plan_type);
  }

  upsertWindow(windows, "primary", rateLimits, asRecord(rateLimits.primary), eventTimeMs, deltaTotals);
  upsertWindow(windows, "secondary", rateLimits, asRecord(rateLimits.secondary), eventTimeMs, deltaTotals);
}

export function buildWindowLists(windows: LimitWindowAggregates): [LimitWindowRow[], LimitWindowRow[]] {
  const rows = [...windows.values()]
    .map<LimitWindowRow>((window) => ({
      scope: window.scope,
      planType: window.planType,
      limitId: window.limitId,
      windowMinutes: window.windowMinutes,
      startTimeUtcIso: formatIsoFromSeconds(window.minStartsAt),
      endTimeUtcIso: formatIsoFromSeconds(window.maxResetsAt),
      firstSeenUtcIso: formatIsoFromMilliseconds(window.firstSeenMs),
      lastSeenUtcIso: formatIsoFromMilliseconds(window.lastSeenMs),
      minUsedPercent: window.minUsedPercent,
      maxUsedPercent: window.maxUsedPercent,
      totals: { ...window.totals },
      eventCount: window.totals.eventCount
    }))
    .sort((left, right) => right.endTimeUtcIso.localeCompare(left.endTimeUtcIso));

  const primary = rows.filter((row) => row.scope === "primary").slice(0, 5);
  const secondary = rows.filter((row) => row.scope === "secondary").slice(0, 5);
  return [primary, secondary];
}

function formatIsoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function formatIsoFromMilliseconds(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(".000Z", "Z");
}

function makeWindowKey(scope: LimitWindowScope, rateLimits: Record<string, unknown>, window: Record<string, unknown>): string {
  return [
    scope,
    String(rateLimits.limit_id ?? "unknown"),
    String(rateLimits.plan_type ?? "unknown"),
    numberOrZero(window.window_minutes),
    Math.round(numberOrZero(window.resets_at) / 60)
  ].join("|");
}

function upsertWindow(
  windows: LimitWindowAggregates,
  scope: LimitWindowScope,
  rateLimits: Record<string, unknown>,
  window: Record<string, unknown> | null,
  eventTimeMs: number,
  deltaTotals: UsageTotals
): void {
  if (!window) {
    return;
  }

  const windowMinutes = numberOrZero(window.window_minutes);
  const resetsAt = numberOrZero(window.resets_at);
  if (!windowMinutes || !resetsAt) {
    return;
  }

  const startsAt = resetsAt - windowMinutes * 60;
  const usedPercent = numberOrZero(window.used_percent);
  const key = makeWindowKey(scope, rateLimits, window);
  const existing = windows.get(key);

  if (!existing) {
    windows.set(key, {
      scope,
      limitId: String(rateLimits.limit_id ?? "unknown"),
      planType: String(rateLimits.plan_type ?? "unknown"),
      windowMinutes,
      minStartsAt: startsAt,
      maxResetsAt: resetsAt,
      firstSeenMs: eventTimeMs,
      lastSeenMs: eventTimeMs,
      minUsedPercent: usedPercent,
      maxUsedPercent: usedPercent,
      totals: createEmptyUsageTotals()
    });
    addUsageTotals(windows.get(key)!.totals, deltaTotals);
    return;
  }

  existing.minStartsAt = Math.min(existing.minStartsAt, startsAt);
  existing.maxResetsAt = Math.max(existing.maxResetsAt, resetsAt);
  existing.firstSeenMs = Math.min(existing.firstSeenMs, eventTimeMs);
  existing.lastSeenMs = Math.max(existing.lastSeenMs, eventTimeMs);
  existing.minUsedPercent = Math.min(existing.minUsedPercent, usedPercent);
  existing.maxUsedPercent = Math.max(existing.maxUsedPercent, usedPercent);
  addUsageTotals(existing.totals, deltaTotals);
}
