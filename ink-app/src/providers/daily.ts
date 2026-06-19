import {
  addUsageTotals,
  createEmptyUsageTotals,
  type DailyUsageRow,
  type UsageTotals
} from "./contract.js";

type DailyUsageAggregate = {
  dayKey: string;
  sortTimeMs: number;
  firstEventMs: number | null;
  lastEventMs: number | null;
  totals: UsageTotals;
  models: Set<string>;
  planTypes: Set<string>;
};

export type DailyUsageAggregates = Map<string, DailyUsageAggregate>;

export function createDailyUsageAggregates(): DailyUsageAggregates {
  return new Map<string, DailyUsageAggregate>();
}

export function addDailyUsage(
  rows: DailyUsageAggregates,
  eventTimeMs: number,
  modelId: string,
  planType: string | undefined,
  deltaTotals: UsageTotals
): void {
  const { dayKey, sortTimeMs } = resolveDayBucket(eventTimeMs);
  const resolvedModelId = modelId || "unknown";
  const existing = rows.get(dayKey);

  if (!existing) {
    const models = new Set<string>();
    models.add(resolvedModelId);
    const planTypes = new Set<string>();
    if (planType) {
      planTypes.add(planType);
    }

    rows.set(dayKey, {
      dayKey,
      sortTimeMs,
      firstEventMs: Number.isFinite(eventTimeMs) ? eventTimeMs : null,
      lastEventMs: Number.isFinite(eventTimeMs) ? eventTimeMs : null,
      totals: { ...deltaTotals },
      models,
      planTypes
    });
    return;
  }

  addUsageTotals(existing.totals, deltaTotals);
  existing.models.add(resolvedModelId);
  if (planType) {
    existing.planTypes.add(planType);
  }

  if (Number.isFinite(eventTimeMs)) {
    existing.sortTimeMs = Math.max(existing.sortTimeMs, sortTimeMs);
    existing.firstEventMs =
      existing.firstEventMs === null ? eventTimeMs : Math.min(existing.firstEventMs, eventTimeMs);
    existing.lastEventMs =
      existing.lastEventMs === null ? eventTimeMs : Math.max(existing.lastEventMs, eventTimeMs);
  }
}

export function buildDailyUsageRows(rows: DailyUsageAggregates): DailyUsageRow[] {
  return [...rows.values()]
    .sort((left, right) => right.sortTimeMs - left.sortTimeMs || right.dayKey.localeCompare(left.dayKey))
    .map<DailyUsageRow>((row) => ({
      dayKey: row.dayKey,
      firstEventUtcIso: row.firstEventMs === null ? null : formatIsoFromMilliseconds(row.firstEventMs),
      lastEventUtcIso: row.lastEventMs === null ? null : formatIsoFromMilliseconds(row.lastEventMs),
      distinctModels: [...row.models].sort(),
      distinctPlanTypes: [...row.planTypes].sort(),
      totals: { ...row.totals }
    }));
}

function resolveDayBucket(eventTimeMs: number): { dayKey: string; sortTimeMs: number } {
  if (!Number.isFinite(eventTimeMs)) {
    return { dayKey: "unknown", sortTimeMs: Number.NEGATIVE_INFINITY };
  }

  const dayKey = new Date(eventTimeMs).toISOString().slice(0, 10);
  return {
    dayKey,
    sortTimeMs: Date.parse(`${dayKey}T00:00:00.000Z`)
  };
}

function formatIsoFromMilliseconds(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(".000Z", "Z");
}
