import type { ProviderStatsOptions } from "../contract.js";
import type { AntigravityLocalServer } from "./rpc/client.js";
import { findAntigravityLocalServer } from "./rpc/discovery.js";
import { fetchAntigravityUsageRpcData } from "./rpc/usage.js";

const MODEL_IDS: Record<string, string> = {
  MODEL_PLACEHOLDER_M20: "gemini-3.5-flash",
  MODEL_PLACEHOLDER_M132: "gemini-3.5-flash",
  MODEL_PLACEHOLDER_M187: "gemini-3.5-flash",

  MODEL_PLACEHOLDER_M36: "gemini-3.1-pro",
  MODEL_PLACEHOLDER_M16: "gemini-3.1-pro",

  MODEL_PLACEHOLDER_M35: "claude-sonnet-4-6",
  MODEL_PLACEHOLDER_M26: "claude-opus-4-6",

  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: "gpt-oss-120b"
};

export type AntigravityUsageRecord = {
  type: "usage";
  sessionId: string;
  responseId: string;
  timestamp: number;
  modelId: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};

export async function collectUsageFromRpc(
  options?: ProviderStatsOptions
): Promise<AntigravityUsageRecord[]> {
  const server = await findAntigravityLocalServer();

  return server
    ? collectUsageFromLocalRpc(server, options)
    : [];
}

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
      modelId: MODEL_IDS[entry.model] ?? entry.model,
      input: entry.input,
      cacheRead: entry.cacheRead,
      cacheWrite: 0,
      output: entry.output,
      reasoning: entry.reasoning
    }];
  });
}