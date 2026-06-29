import type { AntigravityModelScope } from "./types.js";

/**
 * Single source of truth for mapping Antigravity model identifiers to canonical
 * model ids. Covers both the opaque RPC placeholders (MODEL_PLACEHOLDER_*) and
 * the dated/suffixed aliases that show up in usage records.
 */
const MODEL_IDS: Record<string, string> = {
  MODEL_PLACEHOLDER_M20: "gemini-3.5-flash",
  MODEL_PLACEHOLDER_M132: "gemini-3.5-flash",
  MODEL_PLACEHOLDER_M187: "gemini-3.5-flash",

  MODEL_PLACEHOLDER_M36: "gemini-3.1-pro",
  MODEL_PLACEHOLDER_M16: "gemini-3.1-pro",

  MODEL_PLACEHOLDER_M35: "claude-sonnet-4-6",
  MODEL_PLACEHOLDER_M26: "claude-opus-4-6",

  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: "gpt-oss-120b",

  "gemini-3-flash-a": "gemini-3-flash",
  "gemini-3-flash-preview": "gemini-3-flash",
  "gemini-3.1-pro-preview": "gemini-3.1-pro",
  "gemini-3.5-flash-preview": "gemini-3.5-flash",
  "claude-sonnet-4-6-20251201": "claude-sonnet-4-6",
  "claude-opus-4-6-20251201": "claude-opus-4-6"
};

export function normalizeAntigravityModelId(modelId: string): string {
  return MODEL_IDS[modelId] ?? (modelId || "unknown");
}

export function antigravityModelScope(rawModelId: string): AntigravityModelScope {
  const modelId = normalizeAntigravityModelId(rawModelId);

  if (modelId.startsWith("gemini")) {
    return "gemini";
  }
  if (modelId.startsWith("claude") || modelId.startsWith("gpt")) {
    return "third-party";
  }

  return "unknown";
}

export function modelScopeMatches(scope: AntigravityModelScope, modelId: string): boolean {
  return antigravityModelScope(modelId) === scope;
}

export function modelScopeLabel(scope: AntigravityModelScope): string {
  if (scope === "gemini") {
    return "Gemini";
  }
  if (scope === "third-party") {
    return "Claude/GPT";
  }

  return "Unknown";
}
