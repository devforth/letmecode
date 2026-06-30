import type {
  CopilotDeduplicationResult,
  CopilotUsageEvent,
  CopilotUsageEventSource
} from "../types.js";

const SOURCE_PRIORITY: Record<CopilotUsageEventSource, number> = {
  "chat-span": 4,
  "inference-log": 3,
  "agent-turn-log": 2,
  "agent-summary-span": 1
};

function isGranular(event: CopilotUsageEvent): boolean {
  return event.sourceType === "chat-span" || event.sourceType === "inference-log";
}

/** Stable ordering used both as the processing pre-sort and as a tie-break. */
function compareByLocation(a: CopilotUsageEvent, b: CopilotUsageEvent): number {
  if (a.filePath !== b.filePath) {
    return a.filePath < b.filePath ? -1 : 1;
  }
  return a.lineNumber - b.lineNumber;
}

/** Final output ordering: timestamp first, then file location. */
function compareForOutput(a: CopilotUsageEvent, b: CopilotUsageEvent): number {
  if (a.timestampMs !== b.timestampMs) {
    return a.timestampMs - b.timestampMs;
  }
  return compareByLocation(a, b);
}

/**
 * Compute the identity key for step-1 dedup.
 *
 * A trace+span pair uniquely identifies a single inference call, so it is used
 * directly when present. Otherwise we deliberately do NOT key on a bare
 * `gen_ai.response.id`: the Copilot exporter reuses one response id across
 * several distinct sequential calls within a turn, so collapsing by response id
 * alone would discard real usage. Instead, without a strong span id, the same
 * call emitted redundantly (e.g. as a chat-span and an inference-log, or the
 * same span written twice) is identified by a content fingerprint — response id
 * plus timestamp plus the token tuple — which matches true duplicates while
 * preserving distinct calls that merely share a response id. With no response
 * id at all we fall back to file location, so each logged line stands alone.
 */
function identityKey(event: CopilotUsageEvent): string {
  if (event.traceId && event.spanId) {
    return `ts|${event.traceId}|${event.spanId}`;
  }
  // Reached only when there is no trace+span pair. Use whichever weak id exists.
  const weakId = event.responseId ?? event.traceId;
  if (weakId) {
    return [
      "fp",
      weakId,
      event.turnIndex ?? "",
      event.timestampMs,
      event.inputTokens,
      event.outputTokens,
      event.cacheReadInputTokens,
      event.cacheWriteInputTokens
    ].join("|");
  }
  return `fl|${event.filePath}:${event.lineNumber}`;
}

/** True when the aggregate event carries no id that could link it to a granular event. */
function hasNoLinkingId(event: CopilotUsageEvent): boolean {
  return (
    !event.traceId &&
    !event.spanId &&
    !event.responseId &&
    !event.conversationId &&
    !event.sessionId
  );
}

/** True when two events share at least one linking context id. */
function sharesContext(agg: CopilotUsageEvent, other: CopilotUsageEvent): boolean {
  if (agg.conversationId && other.conversationId === agg.conversationId) {
    return true;
  }
  if (agg.sessionId && other.sessionId === agg.sessionId) {
    return true;
  }
  if (agg.traceId && other.traceId === agg.traceId) {
    return true;
  }
  if (agg.responseId && other.responseId === agg.responseId) {
    return true;
  }
  return false;
}

export function deduplicateCopilotUsageEvents(
  events: CopilotUsageEvent[]
): CopilotDeduplicationResult {
  // Make the entire process order-independent by sorting the working set first.
  const working = [...events].sort(compareByLocation);

  // ── Step 1: identity dedup ────────────────────────────────────────────────
  const byIdentity = new Map<string, CopilotUsageEvent>();
  let duplicatesRemoved = 0;

  for (const event of working) {
    const key = identityKey(event);
    const existing = byIdentity.get(key);
    if (existing === undefined) {
      byIdentity.set(key, event);
      continue;
    }
    duplicatesRemoved += 1;
    const existingPriority = SOURCE_PRIORITY[existing.sourceType];
    const candidatePriority = SOURCE_PRIORITY[event.sourceType];
    if (candidatePriority > existingPriority) {
      byIdentity.set(key, event);
    } else if (candidatePriority === existingPriority) {
      // Deterministic tie-break by (filePath, lineNumber): keep the earlier one.
      if (compareByLocation(event, existing) < 0) {
        byIdentity.set(key, event);
      }
    }
  }

  const afterStep1 = [...byIdentity.values()].sort(compareByLocation);

  // ── Step 2: aggregate suppression ─────────────────────────────────────────
  const granular = afterStep1.filter(isGranular);
  const aggregates = afterStep1.filter((e) => !isGranular(e));

  const kept: CopilotUsageEvent[] = [...granular];

  for (const agg of aggregates) {
    let drop = false;

    // Covered by a granular event sharing context, or (when unlinked) a granular
    // event sitting in the same file.
    for (const g of granular) {
      if (sharesContext(agg, g)) {
        drop = true;
        break;
      }
      if (hasNoLinkingId(agg) && g.filePath === agg.filePath) {
        drop = true;
        break;
      }
    }

    // An agent-summary-span is also dropped if an agent-turn-log covers it.
    if (!drop && agg.sourceType === "agent-summary-span") {
      for (const turn of aggregates) {
        if (turn.sourceType !== "agent-turn-log") {
          continue;
        }
        if (sharesContext(agg, turn)) {
          drop = true;
          break;
        }
      }
    }

    if (drop) {
      duplicatesRemoved += 1;
    } else {
      kept.push(agg);
    }
  }

  kept.sort(compareForOutput);

  return {
    events: kept,
    duplicatesRemoved,
    warnings: []
  };
}
