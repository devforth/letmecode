/*
Previous local prices in credits per 1M tokens, kept temporarily as requested:
gpt-5-mini 25 / 2.5 / 0 / 200; gpt-5.3-codex 175 / 17.5 / 0 / 1400
gpt-5.4 250 / 25 / 0 / 1500; gpt-5.4-mini 75 / 7.5 / 0 / 450
gpt-5.4-nano 20 / 2 / 0 / 125; gpt-5.5 500 / 50 / 0 / 3000
gpt-5.6-luna 20 / 2 / 25 / 120; gpt-5.6-sol 400 / 40 / 500 / 2000
gpt-5.6-terra 200 / 20 / 250 / 1200; gpt-6-astra 1000 / 100 / 1250 / 5000
claude-haiku-4-5 100 / 10 / 125 / 200 / 500
claude-sonnet-4-5 and 4-6 300 / 30 / 375 / 600 / 1500
claude-opus-4-5, 4-6, 4-7, 4-8, 5 500 / 50 / 625 / 1000 / 2500
claude-opus-4-8-fast 1000 / 100 / 1250 / 2000 / 5000
claude-fable-5 1000 / 100 / 1250 / 2000 / 5000
claude-fable-5-1 1000 / 25 / 1250 / 2000 / 5000
claude-sonnet-5 200 / 20 / 250 / 400 / 1000
gemini-2.5-pro 125 / 12.5 / 0 / 1000; gemini-3-flash 50 / 5 / 0 / 300
gemini-3.1-pro 200 / 20 / 0 / 1200; gemini-3.5-flash 150 / 15 / 0 / 900
gemini-3.6-flash, 3.7-flash, 3.8-flash 75 / 7.5 / 0 / 375
mai-code-1-flash 75 / 7.5 / 0 / 450; mai-code-1.1-flash 20 / 2 / 0 / 120
grok-4.5 and 4.6 200 / 50 / 0 / 600
kimi-k2.7-code 95 / 19 / 0 / 400; kimi-k3 300 / 30 / 0 / 1500
raptor-mini 25 / 2.5 / 0 / 200
Columns with four values: input / cache read / cache write / output.
Columns with five values: input / cache read / cache write 5m / cache write 1h / output.
*/

export const NON_BILLABLE_MODEL_PREFIXES = [
  "copilot-nes",
  "copilot-suggestion",
  "copilot-suggestions"
] as const;

export function normalizeCopilotModelId(modelId: string): string {
  return modelId || "unknown";
}

export function isNonBillableCopilotModel(modelId: string): boolean {
  return NON_BILLABLE_MODEL_PREFIXES.some(
    (prefix) => modelId === prefix || modelId.startsWith(`${prefix}-`)
  );
}
