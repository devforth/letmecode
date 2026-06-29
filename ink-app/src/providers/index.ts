import { ClaudeUsageProvider } from "./claude.js";
import { CodexUsageProvider } from "./codex.js";
import { CopilotUsageProvider } from "./copilot.js";
import { AntigravityUsageProvider } from "./antigravity/provider.js";
import type { UsageProviderBase } from "./contract.js";

export function createProviders(): UsageProviderBase[] {
  return [
    new CodexUsageProvider(),
    new ClaudeUsageProvider(),
    new CopilotUsageProvider(),
    new AntigravityUsageProvider()
  ];
}

export { AntigravityUsageProvider } from "./antigravity/provider.js";
export type {
  AntigravityQuotaEntry,
  AntigravityQuotaSnapshot,
  AntigravityUsageProviderOptions,
  AntigravityUsageRecord
} from "./antigravity/provider.js";
export { ClaudeUsageProvider } from "./claude.js";
export { CodexUsageProvider } from "./codex.js";
export {
  CopilotUsageProvider,
  configureCopilotVsCodeLogging
} from "./copilot.js";
export type {
  CopilotVsCodeLoggingOptions,
  CopilotVsCodeLoggingResult
} from "./copilot.js";
export { UsageProviderBase } from "./contract.js";
export type {
  DailyUsageRow,
  LimitWindowRow,
  LimitWindowScope,
  ModelUsageRow,
  ProviderAnalytics,
  ProviderStats,
  ProviderStatsOptions,
  ProviderTraceLogger,
  ProviderSummary,
  UsageTotals
} from "./contract.js";
