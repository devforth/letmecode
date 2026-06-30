import { asRecord } from "../../limits.js";
import type { CopilotQuota, CopilotQuotaInfo } from "../types.js";

// ────────────────────────────────────────────────────────────────────────────
// Raw response shapes (LOCAL to this file — the public domain model lives in
// ../types.js). The GitHub Copilot internal user endpoint returns one of two
// shapes depending on the plan: a paid `quota_snapshots` form or a free
// `monthly_quotas`/`limited_user_quotas` form.
// ────────────────────────────────────────────────────────────────────────────

type RawPaidSnapshot = {
  percent_remaining?: unknown;
  remaining?: unknown;
  entitlement?: unknown;
  quota_id?: unknown;
};

const KNOWN_LABELS: Record<string, string> = {
  premium_interactions: "Premium",
  chat: "Chat",
  completions: "Completions"
};

/**
 * Parse the raw Copilot user/quota JSON into the normalized {@link CopilotQuotaInfo}.
 * Tolerates both the paid and free response shapes, never throws on missing or
 * malformed fields, clamps every percentage to 0..100, rejects NaN/Infinity and
 * negatives, and preserves unknown quota keys with a readable fallback label.
 */
export function parseCopilotQuota(raw: unknown): CopilotQuotaInfo {
  const root = asRecord(raw);
  if (!root) {
    return { quotas: [] };
  }

  const plan = asString(root.copilot_plan);
  const snapshots = asRecord(root.quota_snapshots);

  // Prefer the paid `quota_snapshots` form, but fall back to the free
  // `monthly/limited` form when the snapshot object is present yet yields no
  // usable quotas (e.g. an empty `quota_snapshots: {}`). Selecting paid purely
  // on the object's presence would silently drop a free account's quotas.
  const paid = snapshots !== null ? parsePaidQuotas(snapshots) : [];
  const usePaid = paid.length > 0;
  const quotas = usePaid ? paid : parseFreeQuotas(root);

  const resetAt = usePaid
    ? asString(root.quota_reset_date)
    : asString(root.limited_user_reset_date);

  const info: CopilotQuotaInfo = {
    quotas: quotas.sort((left, right) => left.id.localeCompare(right.id))
  };
  if (plan !== undefined) {
    info.plan = plan;
  }
  if (resetAt !== undefined) {
    info.resetAt = resetAt;
  }
  return info;
}

function parsePaidQuotas(snapshots: Record<string, unknown>): CopilotQuota[] {
  const quotas: CopilotQuota[] = [];

  for (const [key, value] of Object.entries(snapshots)) {
    const snapshot = asRecord(value) as RawPaidSnapshot | null;
    if (!snapshot) {
      quotas.push(makeQuota(idForSnapshot(key, undefined), key));
      continue;
    }

    const id = idForSnapshot(key, asString(snapshot.quota_id));
    const quota = makeQuota(id, key);

    const total = finiteNonNegative(snapshot.entitlement);
    if (total !== undefined) {
      quota.total = total;
    }

    const percentRemaining = finiteNonNegative(snapshot.percent_remaining);
    const rawRemaining = finiteNonNegative(snapshot.remaining);

    if (percentRemaining !== undefined) {
      const remainingPercent = clampPercent(percentRemaining);
      quota.remainingPercent = remainingPercent;
      quota.usedPercent = clampPercent(100 - remainingPercent);
    } else if (rawRemaining !== undefined && total !== undefined && total > 0) {
      const remainingPercent = clampPercent((rawRemaining / total) * 100);
      quota.remainingPercent = remainingPercent;
      quota.usedPercent = clampPercent(100 - remainingPercent);
    }

    if (rawRemaining !== undefined) {
      const remaining = total !== undefined ? Math.min(rawRemaining, total) : rawRemaining;
      quota.remaining = remaining;
      if (total !== undefined) {
        quota.used = Math.max(0, total - remaining);
      }
    }

    quotas.push(quota);
  }

  return quotas;
}

function parseFreeQuotas(root: Record<string, unknown>): CopilotQuota[] {
  const monthly = asRecord(root.monthly_quotas) ?? {};
  const limited = asRecord(root.limited_user_quotas) ?? {};

  const keys = new Set<string>([...Object.keys(monthly), ...Object.keys(limited)]);
  const quotas: CopilotQuota[] = [];

  for (const key of keys) {
    const quota = makeQuota(key, key);

    const total = finiteNonNegative(monthly[key]);
    const rawRemaining = finiteNonNegative(limited[key]);

    if (total !== undefined) {
      quota.total = total;
    }

    if (rawRemaining !== undefined) {
      const remaining = total !== undefined ? Math.min(rawRemaining, total) : rawRemaining;
      quota.remaining = remaining;

      if (total !== undefined) {
        const used = Math.max(0, total - remaining);
        quota.used = used;
        if (total > 0) {
          const usedPercent = clampPercent((used / total) * 100);
          quota.usedPercent = usedPercent;
          quota.remainingPercent = clampPercent(100 - usedPercent);
        }
      }
    }

    quotas.push(quota);
  }

  return quotas;
}

function makeQuota(id: string, key: string): CopilotQuota {
  return { id, label: labelForKey(key) };
}

function idForSnapshot(key: string, quotaId: string | undefined): string {
  return quotaId !== undefined && quotaId.length > 0 ? quotaId : key;
}

function labelForKey(key: string): string {
  const known = KNOWN_LABELS[key];
  if (known !== undefined) {
    return known;
  }
  return titleCase(key);
}

function titleCase(key: string): string {
  const words = key.replace(/_/g, " ").trim().split(/\s+/);
  if (words.length === 0 || words[0] === "") {
    return key;
  }
  return words
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Coerce number-or-numeric-string into a finite non-negative number, else undefined. */
function finiteNonNegative(value: unknown): number | undefined {
  let n: number | undefined;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    n = Number(value);
  }
  if (n === undefined || !Number.isFinite(n) || n < 0) {
    return undefined;
  }
  return n;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}
