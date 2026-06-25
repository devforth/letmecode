import { request } from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LimitWindowRow, ProviderStats } from "./providers/index.js";

const REPORTING_ENDPOINT = "https://devforth.io/admin/api/report_ussage_anonymous";
const CREDIT_TO_DOLLARS = 0.01;

let versionCache: Promise<string> | null = null;

export type AnonymousUsageReport = {
  agent: string;
  userid_hash: string;
  plan_id: string;
  window_duration_seconds: number;
  window_start_utc_iso: string;
  window_end_utc_iso: string;
  used_percents: number;
  used_exhausted: boolean;
  value_dollars: number;
  letmecode_version: string;
};

export type AnonymousUsagePayload = {
  data: AnonymousUsageReport[];
};

export async function reportAnonymousUsage(statsList: ProviderStats[]): Promise<void> {
  const payload = await buildAnonymousUsagePayload(statsList);
  if (payload.data.length === 0) {
    return;
  }

  await postJson(REPORTING_ENDPOINT, payload);
}

export async function buildAnonymousUsageReports(statsList: ProviderStats[]): Promise<AnonymousUsageReport[]> {
  const letmecodeVersion = await readLetmecodeVersion();

  return statsList.flatMap((stats) => {
    if (!stats.analytics?.userIdHash) {
      return [];
    }

    return [...stats.primaryLimitWindows, ...stats.secondaryLimitWindows].map((window) =>
      buildAnonymousUsageReport(stats, window, letmecodeVersion)
    );
  });
}

export async function buildAnonymousUsagePayload(statsList: ProviderStats[]): Promise<AnonymousUsagePayload> {
  return {
    data: await buildAnonymousUsageReports(statsList)
  };
}

function buildAnonymousUsageReport(
  stats: ProviderStats,
  window: LimitWindowRow,
  letmecodeVersion: string
): AnonymousUsageReport {
  return {
    agent: stats.analytics?.agentName ?? stats.providerLabel.replace(/\s+/g, ""),
    userid_hash: stats.analytics?.userIdHash ?? "",
    plan_id: window.planType,
    window_duration_seconds: window.windowMinutes * 60,
    window_start_utc_iso: window.startTimeUtcIso,
    window_end_utc_iso: window.endTimeUtcIso,
    used_percents: resolveReportedUsedPercents(window),
    used_exhausted: window.maxUsedPercent >= 100,
    value_dollars: roundDollars(window.totals.estimatedCredits * CREDIT_TO_DOLLARS),
    letmecode_version: letmecodeVersion
  };
}

function resolveReportedUsedPercents(window: LimitWindowRow): number {
  if (window.minUsedPercent === window.maxUsedPercent) {
    return clampPercent(window.maxUsedPercent);
  }

  return clampPercent(window.maxUsedPercent - window.minUsedPercent);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function roundDollars(value: number): number {
  return Number(value.toFixed(6));
}

async function readLetmecodeVersion(): Promise<string> {
  if (versionCache) {
    return versionCache;
  }

  versionCache = (async () => {
    const currentFilePath = fileURLToPath(import.meta.url);
    const packageJsonPath = path.resolve(path.dirname(currentFilePath), "..", "..", "package.json");
    const fileText = await fs.readFile(packageJsonPath, "utf8");
    const payload = JSON.parse(fileText) as { version?: unknown };
    return typeof payload.version === "string" && payload.version ? payload.version : "unknown";
  })();

  return versionCache;
}

async function postJson(url: string, body: AnonymousUsagePayload): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const encodedBody = Buffer.from(JSON.stringify(body), "utf8");
    const target = new URL(url);
    const req = request(
      {
        method: "POST",
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: {
          "content-type": "application/json",
          "content-length": encodedBody.byteLength
        }
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
            return;
          }

          reject(new Error(`Unexpected response status: ${res.statusCode ?? "unknown"}`));
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(5_000, () => {
      req.destroy(new Error("Anonymous usage reporting timed out"));
    });
    req.write(encodedBody);
    req.end();
  });
}
