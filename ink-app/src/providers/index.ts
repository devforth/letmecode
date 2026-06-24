import { ClaudeUsageProvider } from "./claude.js";
import { CodexUsageProvider } from "./codex.js";
import { CopilotUsageProvider } from "./copilot.js";
import type { UsageProviderBase } from "./contract.js";

export function createProviders(): UsageProviderBase[] {
  return [new CodexUsageProvider(), new ClaudeUsageProvider(), new CopilotUsageProvider()];
}

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
  AnthropicTokenBreakdown,
  DailyUsageRow,
  LimitWindowRow,
  LimitWindowScope,
  ModelUsageRow,
  OpenAiTokenBreakdown,
  ProviderStats,
  ProviderStatsOptions,
  ProviderSummary,
  UsageTokenBreakdown,
  UsageTokenSchema,
  UsageTotals
} from "./contract.js";
