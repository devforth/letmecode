import { CodexUsageProvider } from "./codex.js";
import type { UsageProviderBase } from "./contract.js";

export function createProviders(): UsageProviderBase[] {
  return [new CodexUsageProvider()];
}

export { CodexUsageProvider } from "./codex.js";
export { UsageProviderBase } from "./contract.js";
export type {
  LimitWindowRow,
  LimitWindowScope,
  ModelUsageRow,
  ProviderStats,
  ProviderSummary,
  UsageTotals
} from "./contract.js";
