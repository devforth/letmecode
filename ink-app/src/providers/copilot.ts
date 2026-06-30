// Backward-compatible entry point for the Copilot usage provider. The
// implementation was split by responsibility under ./copilot/* — this module
// only re-exports the public surface so existing import paths keep working.
export {
  CopilotUsageProvider,
  configureCopilotVsCodeLogging,
  getCopilotCliOtelEnv
} from "./copilot/provider.js";
export type { CopilotUsageProviderOptions } from "./copilot/provider.js";
export type {
  CopilotVsCodeLoggingOptions,
  CopilotVsCodeLoggingResult
} from "./copilot/provider.js";
