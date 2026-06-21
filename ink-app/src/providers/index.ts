import { ClaudeUsageProvider } from "./claude.js";
import { CodexUsageProvider } from "./codex.js";
import type { UsageProviderBase } from "./contract.js";

export function createProviders(): UsageProviderBase[] {
  return [new CodexUsageProvider(), new ClaudeUsageProvider()];
}

export { ClaudeUsageProvider } from "./claude.js";
export { CodexUsageProvider } from "./codex.js";
export { UsageProviderBase } from "./contract.js";
export type {
  DailyUsageRow,
  LimitWindowRow,
  LimitWindowScope,
  ModelUsageRow,
  ProviderStats,
  ProviderStatsOptions,
  ProviderSummary,
  UsageTotals
} from "./contract.js";
