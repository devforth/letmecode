import fs from "node:fs";
import path from "node:path";
import type { ProviderTraceLogger } from "./contract.js";
import { asRecord } from "./limits.js";

/**
 * Claude reports limit usage as a percentage of the plan currently attached to
 * the account, and that percentage restarts when the account moves to another
 * plan - while the reported window keeps spanning days of pre-switch usage.
 * Pairing the fresh percentage with the whole window's tokens therefore
 * extrapolates an absurd limit value, so letmecode remembers which plan it saw
 * and when, and reports the moment a switch became visible.
 */
export type ClaudePlanObservation = {
  planType: string;
  firstSeenUtcIso: string;
  lastSeenUtcIso: string;
  /** Plan that was current the last time this observation was (re)started. */
  switchedFromPlanType?: string;
};

export type ClaudePlanState = {
  version: 1;
  observations: ClaudePlanObservation[];
};

const CLAUDE_PLAN_STATE_VERSION = 1;
const MAX_TRACKED_PLANS = 20;
// Refresh ticks re-resolve the same plan every few seconds; only persist the
// heartbeat once it is stale enough to matter for a switch boundary.
const LAST_SEEN_REFRESH_MS = 5 * 60_000;

export function getClaudePlanStatePath(root: string): string {
  return path.join(path.resolve(root), ".letmecode", "claude-plan-state.json");
}

/**
 * Record that `planType` is the plan in effect now and return the moment the
 * current plan first became visible, but only when letmecode had already seen a
 * different plan before it. A first-ever observation returns null: without a
 * previous plan on record there is no evidence that the provider's percentages
 * restarted, so the caller must keep pairing the full window.
 */
export async function recordClaudePlanObservation(options: {
  root: string;
  planType: string;
  now: Date;
  traceLogger?: ProviderTraceLogger;
}): Promise<number | null> {
  const statePath = getClaudePlanStatePath(options.root);
  const nowMs = options.now.getTime();
  const nowIso = new Date(nowMs).toISOString();
  const state = await readClaudePlanState(statePath);
  const observations = state.observations;
  const previous = resolveLatestObservation(observations, options.planType);
  const existing = observations.find((observation) => observation.planType === options.planType);

  let entry: ClaudePlanObservation;
  let changed = false;
  if (!existing) {
    entry = {
      planType: options.planType,
      firstSeenUtcIso: nowIso,
      lastSeenUtcIso: nowIso,
      ...(previous ? { switchedFromPlanType: previous.planType } : {})
    };
    observations.push(entry);
    changed = true;
  } else if (previous) {
    // The account came back to a plan letmecode saw earlier: its percentages
    // restarted again, so the stale first-seen no longer marks the boundary.
    existing.firstSeenUtcIso = nowIso;
    existing.lastSeenUtcIso = nowIso;
    existing.switchedFromPlanType = previous.planType;
    entry = existing;
    changed = true;
  } else {
    entry = existing;
    changed = nowMs - Date.parse(existing.lastSeenUtcIso) >= LAST_SEEN_REFRESH_MS;
    existing.lastSeenUtcIso = nowIso;
  }

  if (changed) {
    await writeClaudePlanState(statePath, {
      version: CLAUDE_PLAN_STATE_VERSION,
      observations: observations.slice(-MAX_TRACKED_PLANS)
    }, options.traceLogger);
  }

  if (!entry.switchedFromPlanType) {
    return null;
  }

  const planStartMs = Date.parse(entry.firstSeenUtcIso);
  return Number.isFinite(planStartMs) ? planStartMs : null;
}

/** Latest plan on record that is not `planType`, by the time it was last seen. */
function resolveLatestObservation(
  observations: ClaudePlanObservation[],
  planType: string
): ClaudePlanObservation | null {
  let latest: ClaudePlanObservation | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const observation of observations) {
    if (observation.planType === planType) {
      continue;
    }

    const lastSeenMs = Date.parse(observation.lastSeenUtcIso);
    if (Number.isFinite(lastSeenMs) && lastSeenMs > latestMs) {
      latest = observation;
      latestMs = lastSeenMs;
    }
  }

  return latest;
}

async function readClaudePlanState(statePath: string): Promise<ClaudePlanState> {
  let text: string;
  try {
    text = await fs.promises.readFile(statePath, { encoding: "utf8" });
  } catch {
    return { version: CLAUDE_PLAN_STATE_VERSION, observations: [] };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { version: CLAUDE_PLAN_STATE_VERSION, observations: [] };
  }

  const record = asRecord(payload);
  if (!record || record.version !== CLAUDE_PLAN_STATE_VERSION || !Array.isArray(record.observations)) {
    return { version: CLAUDE_PLAN_STATE_VERSION, observations: [] };
  }

  return {
    version: CLAUDE_PLAN_STATE_VERSION,
    observations: record.observations
      .map((value) => parseObservation(value))
      .filter((observation): observation is ClaudePlanObservation => observation !== null)
  };
}

function parseObservation(value: unknown): ClaudePlanObservation | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const planType = typeof record.planType === "string" ? record.planType.trim() : "";
  const firstSeenUtcIso = typeof record.firstSeenUtcIso === "string" ? record.firstSeenUtcIso : "";
  const lastSeenUtcIso = typeof record.lastSeenUtcIso === "string" ? record.lastSeenUtcIso : "";
  if (!planType || !Number.isFinite(Date.parse(firstSeenUtcIso)) || !Number.isFinite(Date.parse(lastSeenUtcIso))) {
    return null;
  }

  const switchedFromPlanType =
    typeof record.switchedFromPlanType === "string" && record.switchedFromPlanType.trim()
      ? record.switchedFromPlanType.trim()
      : undefined;

  return {
    planType,
    firstSeenUtcIso,
    lastSeenUtcIso,
    ...(switchedFromPlanType ? { switchedFromPlanType } : {})
  };
}

/** Never let a read-only or full disk break the dashboard. */
async function writeClaudePlanState(
  statePath: string,
  state: ClaudePlanState,
  traceLogger?: ProviderTraceLogger
): Promise<void> {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.promises.rename(temporaryPath, statePath);
  } catch (error: unknown) {
    traceLogger?.log(`[Claude] Could not persist plan state to ${statePath}: ${String(error)}`);
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
