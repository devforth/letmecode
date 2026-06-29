import type { ProviderStatsOptions } from "../contract.js";
import type { AntigravityLocalServer } from "./rpc/client.js";
import { fetchAntigravityUsageRpcData } from "./rpc/usage.js";
import { normalizeAntigravityModelId } from "./models.js";
import type { AntigravityUsageRecord } from "./types.js";

export async function collectUsageFromLocalRpc(
  server: AntigravityLocalServer,
  options?: ProviderStatsOptions
): Promise<AntigravityUsageRecord[]> {
  const usage = await fetchAntigravityUsageRpcData(server);

  options?.traceLogger?.log(
    `[Antigravity] usage: ${JSON.stringify(usage, null, 2)}`
  );

  return usage.flatMap((entry) => {
    const timestamp = Date.parse(entry.created);

    if (!Number.isFinite(timestamp)) {
      return [];
    }

    return [{
      type: "usage" as const,
      sessionId: entry.cascadeId,
      responseId: entry.responseId,
      timestamp,
      modelId: normalizeAntigravityModelId(entry.model),
      input: entry.input,
      cacheRead: entry.cacheRead,
      cacheWrite: 0,
      output: entry.output,
      reasoning: entry.reasoning
    }];
  });
}
