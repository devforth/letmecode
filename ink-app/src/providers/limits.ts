import {
  addUsageTotals,
  cloneUsageTotals,
  createEmptyUsageTotals,
  type LimitWindowRow,
  type LimitWindowScope,
  type ModelUsageRow,
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
  events: Array<{
    eventTimeMs: number;
    modelId: string;
    usedPercent: number;
    totals: UsageTotals;
  }>;
};

export type LimitWindowAggregates = Map<string, LimitWindowAggregate>;

// Recent Codex monthly windows can report a reset timestamp that jitters by a
// few minutes while the logical quota cycle remains unchanged. Short and weekly
// windows retain exact reset identity so their established behavior is stable.
const MONTHLY_WINDOW_MINUTES = 30 * 24 * 60;
const MONTHLY_RESET_JITTER_SECONDS = 15 * 60;

export function createLimitWindowAggregates(): LimitWindowAggregates {
  return new Map<string, LimitWindowAggregate>();
}

export function isLimitWindowActive(
  window: Pick<LimitWindowRow, "startTimeUtcIso" | "endTimeUtcIso">,
  nowMs = Date.now()
): boolean {
  const startMs = Date.parse(window.startTimeUtcIso);
  const endMs = Date.parse(window.endTimeUtcIso);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= nowMs && nowMs <= endMs;
}

export function selectLatestActiveLimitWindows<
  T extends Pick<LimitWindowRow, "planType" | "windowMinutes" | "startTimeUtcIso" | "endTimeUtcIso">
>(windows: T[], nowMs = Date.now()): Set<T> {
  const latestByPlanAndWindow = new Map<string, { window: T; startMs: number }>();

  for (const window of windows) {
    if (!isLimitWindowActive(window, nowMs)) {
      continue;
    }

    const startMs = Date.parse(window.startTimeUtcIso);
    const groupKey = JSON.stringify([window.planType, window.windowMinutes]);
    const current = latestByPlanAndWindow.get(groupKey);
    if (!current || startMs > current.startMs) {
      latestByPlanAndWindow.set(groupKey, { window, startMs });
    }
  }

  return new Set([...latestByPlanAndWindow.values()].map((entry) => entry.window));
}

export function numberOrZero(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return 0;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export type LimitFullValueEstimate = {
  /** Point estimate, in the same unit as `usedValue` (e.g. credits or USD). */
  point: number;
  /** Lower bound (from the higher `usedPercent + tolerance`). */
  low: number;
  /**
   * Upper bound (from the lower `usedPercent - tolerance`). `Infinity` when that
   * lower percent bound is non-positive, i.e. the full value is unbounded above.
   */
  high: number;
};

/**
 * Extrapolate the full value of a limit from a partial observation: if
 * `usedValue` represents `usedPercent` of the limit, the full limit is
 * `usedValue / (usedPercent / 100)`. Because `usedPercent` is only known
 * approximately, a `±percentTolerance` band yields a low/high range around the
 * point estimate. Returns null when there is nothing to extrapolate from
 * (no observed value, or a non-positive percent).
 */
export function estimateLimitFullValue(
  usedValue: number,
  usedPercent: number,
  percentTolerance = 1
): LimitFullValueEstimate | null {
  if (!(usedValue > 0) || !(usedPercent > 0)) {
    return null;
  }

  const toFull = (percent: number) => usedValue / (percent / 100);
  const upperPercent = usedPercent - percentTolerance;

  return {
    point: toFull(usedPercent),
    low: toFull(usedPercent + percentTolerance),
    high: upperPercent > 0 ? toFull(upperPercent) : Infinity
  };
}

export function applyRateLimits(
  windows: LimitWindowAggregates,
  rateLimits: Record<string, unknown> | null,
  eventTimeMs: number,
  modelId: string,
  deltaTotals: UsageTotals,
  planTypes: Set<string>
): void {
  if (!rateLimits) {
    return;
  }

  if (typeof rateLimits.plan_type === "string") {
    planTypes.add(rateLimits.plan_type);
  }

  upsertWindow(windows, "primary", rateLimits, asRecord(rateLimits.primary), eventTimeMs, modelId, deltaTotals);
  upsertWindow(windows, "secondary", rateLimits, asRecord(rateLimits.secondary), eventTimeMs, modelId, deltaTotals);
}

export function buildWindowLists(windows: LimitWindowAggregates): [LimitWindowRow[], LimitWindowRow[]] {
  const rows = collapseNearbyWindows(
    [...windows.values()].map<LimitWindowRow>((window) => {
      const usage = computeWindowUsage(window.events);
      return {
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
        totals: usage.totals,
        modelUsage: usage.modelUsage,
        eventCount: 0
      };
    })
  )
    .map((row) => ({
      ...row,
      eventCount: row.totals.eventCount
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
    numberOrZero(window.resets_at)
  ].join("|");
}

function findMatchingWindowKey(
  windows: LimitWindowAggregates,
  scope: LimitWindowScope,
  rateLimits: Record<string, unknown>,
  windowMinutes: number,
  resetsAt: number
): string {
  const exactKey = makeWindowKey(scope, rateLimits, { window_minutes: windowMinutes, resets_at: resetsAt });
  if (windows.has(exactKey) || windowMinutes < MONTHLY_WINDOW_MINUTES) {
    return exactKey;
  }

  const limitId = String(rateLimits.limit_id ?? "unknown");
  const planType = String(rateLimits.plan_type ?? "unknown");
  let closestKey = exactKey;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const [key, candidate] of windows) {
    if (
      candidate.scope !== scope ||
      candidate.limitId !== limitId ||
      candidate.planType !== planType ||
      candidate.windowMinutes !== windowMinutes
    ) {
      continue;
    }

    const minResetsAt = candidate.minStartsAt + candidate.windowMinutes * 60;
    const distance =
      resetsAt < minResetsAt
        ? minResetsAt - resetsAt
        : resetsAt > candidate.maxResetsAt
          ? resetsAt - candidate.maxResetsAt
          : 0;
    if (distance <= MONTHLY_RESET_JITTER_SECONDS && distance < closestDistance) {
      closestKey = key;
      closestDistance = distance;
    }
  }

  return closestKey;
}

function collapseNearbyWindows(rows: LimitWindowRow[]): LimitWindowRow[] {
  const collapsed = new Map<string, LimitWindowRow>();

  for (const row of rows) {
    const key = [
      row.scope,
      row.limitId,
      row.planType,
      row.windowMinutes,
      Math.round(Date.parse(row.endTimeUtcIso) / 60_000)
    ].join("|");
    const existing = collapsed.get(key);
    if (!existing) {
      collapsed.set(key, {
        ...row,
        totals: cloneUsageTotals(row.totals),
        modelUsage: row.modelUsage.map((entry) => ({
          modelId: entry.modelId,
          totals: cloneUsageTotals(entry.totals)
        }))
      });
      continue;
    }

    existing.startTimeUtcIso =
      existing.startTimeUtcIso < row.startTimeUtcIso ? existing.startTimeUtcIso : row.startTimeUtcIso;
    existing.endTimeUtcIso =
      existing.endTimeUtcIso > row.endTimeUtcIso ? existing.endTimeUtcIso : row.endTimeUtcIso;
    existing.firstSeenUtcIso =
      existing.firstSeenUtcIso < row.firstSeenUtcIso ? existing.firstSeenUtcIso : row.firstSeenUtcIso;
    existing.lastSeenUtcIso =
      existing.lastSeenUtcIso > row.lastSeenUtcIso ? existing.lastSeenUtcIso : row.lastSeenUtcIso;
    existing.minUsedPercent = Math.min(existing.minUsedPercent, row.minUsedPercent);
    existing.maxUsedPercent = Math.max(existing.maxUsedPercent, row.maxUsedPercent);
    addUsageTotals(existing.totals, row.totals);
    existing.modelUsage = mergeModelUsageRows(existing.modelUsage, row.modelUsage);
    existing.eventCount = existing.totals.eventCount;
  }

  return [...collapsed.values()];
}

function computeWindowUsage(
  events: Array<{
    eventTimeMs: number;
    modelId: string;
    usedPercent: number;
    totals: UsageTotals;
  }>
): { totals: UsageTotals; modelUsage: ModelUsageRow[] } {
  // Session files are not guaranteed to be parsed in timestamp order, so
  // saturation has to be applied after we sort the captured window events.
  const totals = createEmptyUsageTotals();
  const byModel = new Map<string, UsageTotals>();
  let sawBelowCap = false;
  let isExhausted = false;

  for (const event of [...events].sort((left, right) => left.eventTimeMs - right.eventTimeMs)) {
    sawBelowCap ||= event.usedPercent < 100;
    if (!isExhausted) {
      addUsageTotals(totals, event.totals);
      addWindowModelUsage(byModel, event.modelId, event.totals);
      if (sawBelowCap && event.usedPercent >= 100) {
        isExhausted = true;
      }
    }
  }

  return {
    totals,
    modelUsage: buildModelUsageRows(byModel)
  };
}

function upsertWindow(
  windows: LimitWindowAggregates,
  scope: LimitWindowScope,
  rateLimits: Record<string, unknown>,
  window: Record<string, unknown> | null,
  eventTimeMs: number,
  modelId: string,
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
  const key = findMatchingWindowKey(windows, scope, rateLimits, windowMinutes, resetsAt);
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
      events: [{ eventTimeMs, modelId, usedPercent, totals: cloneUsageTotals(deltaTotals) }]
    });
    return;
  }

  existing.minStartsAt = Math.min(existing.minStartsAt, startsAt);
  existing.maxResetsAt = Math.max(existing.maxResetsAt, resetsAt);
  existing.firstSeenMs = Math.min(existing.firstSeenMs, eventTimeMs);
  existing.lastSeenMs = Math.max(existing.lastSeenMs, eventTimeMs);
  existing.minUsedPercent = Math.min(existing.minUsedPercent, usedPercent);
  existing.maxUsedPercent = Math.max(existing.maxUsedPercent, usedPercent);
  existing.events.push({ eventTimeMs, modelId, usedPercent, totals: cloneUsageTotals(deltaTotals) });
}

function addWindowModelUsage(byModel: Map<string, UsageTotals>, modelId: string, totals: UsageTotals): void {
  const existing = byModel.get(modelId);
  if (!existing) {
    byModel.set(modelId, cloneUsageTotals(totals));
    return;
  }

  addUsageTotals(existing, totals);
}

function buildModelUsageRows(byModel: Map<string, UsageTotals>): ModelUsageRow[] {
  return [...byModel.entries()]
    .map<ModelUsageRow>(([modelId, totals]) => ({ modelId, totals }))
    .sort((left, right) => right.totals.estimatedCredits - left.totals.estimatedCredits);
}

function mergeModelUsageRows(left: ModelUsageRow[], right: ModelUsageRow[]): ModelUsageRow[] {
  const byModel = new Map<string, UsageTotals>();

  for (const row of [...left, ...right]) {
    addWindowModelUsage(byModel, row.modelId, row.totals);
  }

  return buildModelUsageRows(byModel);
}
