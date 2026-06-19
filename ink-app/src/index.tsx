import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import {
  createProviders,
  type LimitWindowRow,
  type ModelUsageRow,
  type ProviderStats,
  type UsageProviderBase,
  type UsageTotals
} from "./providers/index.js";

type VerticalTabId = "limit-windows" | "summary" | "usage-by-model";

type ProviderLoadState =
  | { provider: UsageProviderBase; status: "loading" }
  | { provider: UsageProviderBase; status: "ready"; stats: ProviderStats }
  | { provider: UsageProviderBase; status: "error"; errorMessage: string };

const VERTICAL_TABS: Array<{ id: VerticalTabId; label: string }> = [
  { id: "limit-windows", label: "Limits" },
  { id: "summary", label: "Summary" },
  { id: "usage-by-model", label: "by model" }
];

const CODEX_CREDIT_COST_USD = 0.01;

const LIMIT_WINDOW_COLUMNS = {
  plan: 8,
  window: 8,
  used: 10,
  date: 15,
  events: 8,
  limit: 8
} as const;

function App(): React.JSX.Element {
  const { exit } = useApp();
  const providers = React.useState(() => createProviders())[0];
  const [providerStates, setProviderStates] = useState<ProviderLoadState[]>(
    providers.map((provider) => ({ provider, status: "loading" }))
  );
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(0);
  const [selectedVerticalTabIndex, setSelectedVerticalTabIndex] = useState(0);
  const [selectedLimitRowIndex, setSelectedLimitRowIndex] = useState(0);
  const [selectedModelRowIndex, setSelectedModelRowIndex] = useState(0);

  const selectedProvider = providerStates[selectedProviderIndex];
  const selectedVerticalTab = VERTICAL_TABS[selectedVerticalTabIndex];
  const limitRows = getLimitRows(selectedProvider);
  const modelRows = getModelRows(selectedProvider);
  const activeLimitRowIndex = clampSelectionIndex(selectedLimitRowIndex, limitRows.length);
  const activeModelRowIndex = clampSelectionIndex(selectedModelRowIndex, modelRows.length);
  const selectedLimitRow = activeLimitRowIndex >= 0 ? limitRows[activeLimitRowIndex] : undefined;
  const selectedModelRow = activeModelRowIndex >= 0 ? modelRows[activeModelRowIndex] : undefined;

  useEffect(() => {
    let cancelled = false;

    for (const provider of providers) {
      void provider
        .getStats()
        .then((stats) => {
          if (cancelled) {
            return;
          }

          setProviderStates((current) =>
            current.map((entry) =>
              entry.provider.id === provider.id
                ? { provider, status: "ready", stats }
                : entry
            )
          );
        })
        .catch((error: unknown) => {
          if (cancelled) {
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          setProviderStates((current) =>
            current.map((entry) =>
              entry.provider.id === provider.id
                ? { provider, status: "error", errorMessage: message }
                : entry
            )
          );
        });
    }

    return () => {
      cancelled = true;
    };
  }, [providers]);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
      return;
    }

    if ((key.ctrl || key.shift) && key.downArrow) {
      if (selectedVerticalTab.id === "limit-windows") {
        setSelectedLimitRowIndex(clampSelectionIndex(activeLimitRowIndex + 1, limitRows.length));
        return;
      }

      if (selectedVerticalTab.id === "usage-by-model") {
        setSelectedModelRowIndex(clampSelectionIndex(activeModelRowIndex + 1, modelRows.length));
        return;
      }
    }

    if ((key.ctrl || key.shift) && key.upArrow) {
      if (selectedVerticalTab.id === "limit-windows") {
        setSelectedLimitRowIndex(clampSelectionIndex(activeLimitRowIndex - 1, limitRows.length));
        return;
      }

      if (selectedVerticalTab.id === "usage-by-model") {
        setSelectedModelRowIndex(clampSelectionIndex(activeModelRowIndex - 1, modelRows.length));
        return;
      }
    }

    if ((input === "\t" && !key.shift) || key.rightArrow) {
      setSelectedProviderIndex((current) => (current + 1) % providerStates.length);
      return;
    }

    if ((input === "\t" && key.shift) || key.leftArrow) {
      setSelectedProviderIndex((current) => (current - 1 + providerStates.length) % providerStates.length);
      return;
    }

    if (key.downArrow || input === "j") {
      setSelectedVerticalTabIndex((current) => (current + 1) % VERTICAL_TABS.length);
      return;
    }

    if (key.upArrow || input === "k") {
      setSelectedVerticalTabIndex((current) => (current - 1 + VERTICAL_TABS.length) % VERTICAL_TABS.length);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        letmecode usage dashboard
      </Text>
      <Text color="gray">
        tab/shift+tab or left/right to switch providers, j/k or up/down for details, ctrl+up/down or shift+up/down to select a row, q to quit
      </Text>
      <Box marginTop={1}>
        {providerStates.map((state, index) => (
          <ProviderTab
            key={state.provider.id}
            label={state.provider.label}
            active={index === selectedProviderIndex}
            status={state.status}
          />
        ))}
      </Box>

      <Box marginTop={1}>
        <Box flexDirection="column" width={12} marginRight={2}>
          {VERTICAL_TABS.map((tab, index) => (
            <VerticalTab key={tab.id} label={tab.label} active={index === selectedVerticalTabIndex} />
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <ContentPanel
            providerState={selectedProvider}
            tabId={selectedVerticalTab.id}
            selectedLimitRowKey={selectedLimitRow ? getLimitRowKey(selectedLimitRow) : undefined}
            selectedModelId={selectedModelRow?.modelId}
          />
        </Box>
      </Box>

      <SelectionDetailsPanel
        providerState={selectedProvider}
        tabId={selectedVerticalTab.id}
        selectedLimitRow={selectedLimitRow}
        selectedModelRow={selectedModelRow}
      />

      {selectedProvider.status === "ready" && selectedProvider.stats.warnings.length > 0 ? (
        <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow">Warnings</Text>
          {selectedProvider.stats.warnings.map((warning) => (
            <Text key={warning}>{warning}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function ProviderTab(props: { label: string; active: boolean; status: ProviderLoadState["status"] }): React.JSX.Element {
  const statusColor = props.status === "error" ? "red" : props.status === "loading" ? "yellow" : "green";
  const tabLabel = props.active ? ` ${props.label} ` : `[${props.label}]`;
  return (
    <Box marginRight={1}>
      <Text inverse={props.active} color={statusColor}>
        {tabLabel}
      </Text>
    </Box>
  );
}

function VerticalTab(props: { label: string; active: boolean }): React.JSX.Element {
  return (
    <Text inverse={props.active}>{props.active ? ` ${props.label} ` : ` ${props.label}`}</Text>
  );
}

function SummaryPanel(props: { stats: ProviderStats }): React.JSX.Element {
  const { summary } = props.stats;
  return (
    <Box flexDirection="column">
      <Text bold>{props.stats.providerLabel}</Text>
      <Text>
        root: {summary.rootLabel} ({summary.rootPath})
      </Text>
      <Text>
        files: {formatInteger(summary.filesScanned)}  lines: {formatInteger(summary.linesRead)}  token events: {formatInteger(summary.tokenEvents)}
      </Text>
      <Text>
        input: {formatInteger(summary.totals.inputTokens)}  cached: {formatInteger(summary.totals.cachedInputTokens)}  non-cached: {formatInteger(summary.totals.nonCachedInputTokens)}
      </Text>
      <Text>
        output: {formatInteger(summary.totals.outputTokens)}  reasoning: {formatInteger(summary.totals.reasoningOutputTokens)}  total: {formatInteger(summary.totals.totalTokens)}
      </Text>
      <Text>
        estimated credits: {formatCredits(summary.totals.estimatedCredits)}  models: {summary.distinctModels.join(", ") || "none"}  plans: {summary.distinctPlanTypes.join(", ") || "none"}
      </Text>
    </Box>
  );
}

function ContentPanel(props: {
  providerState: ProviderLoadState;
  tabId: VerticalTabId;
  selectedLimitRowKey?: string;
  selectedModelId?: string;
}): React.JSX.Element {
  if (props.providerState.status === "loading") {
    return <Text color="yellow">Loading {props.providerState.provider.label} stats...</Text>;
  }

  if (props.providerState.status === "error") {
    return <Text color="red">Provider error: {props.providerState.errorMessage}</Text>;
  }

  if (props.tabId === "limit-windows") {
    return <LimitWindowsPanel stats={props.providerState.stats} selectedRowKey={props.selectedLimitRowKey} />;
  }

  if (props.tabId === "summary") {
    return <SummaryPanel stats={props.providerState.stats} />;
  }

  return <UsageByModelPanel stats={props.providerState.stats} selectedModelId={props.selectedModelId} />;
}

function LimitWindowsPanel(props: { stats: ProviderStats; selectedRowKey?: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>Primary</Text>
      <LimitWindowSection windows={props.stats.primaryLimitWindows} selectedRowKey={props.selectedRowKey} />
      <Box marginTop={1} />
      <Text bold>Secondary</Text>
      <LimitWindowSection windows={props.stats.secondaryLimitWindows} selectedRowKey={props.selectedRowKey} />
    </Box>
  );
}

function LimitWindowSection(props: { windows: LimitWindowRow[]; selectedRowKey?: string }): React.JSX.Element {
  if (props.windows.length === 0) {
    return <Text color="gray">No windows found.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text color="gray">
        {pad("plan", LIMIT_WINDOW_COLUMNS.plan)} {pad("window", LIMIT_WINDOW_COLUMNS.window)} {pad("used", LIMIT_WINDOW_COLUMNS.used)} {pad("start", LIMIT_WINDOW_COLUMNS.date)} {pad("end", LIMIT_WINDOW_COLUMNS.date)} {pad("events", LIMIT_WINDOW_COLUMNS.events)} limit
      </Text>
      {props.windows.map((window) => {
        const windowLabel = formatWindowMinutes(window.windowMinutes);
        const usedLabel = `${window.minUsedPercent}%->${window.maxUsedPercent}%`;
        const isSelected = props.selectedRowKey === getLimitRowKey(window);
        return (
          <Text
            key={getLimitRowKey(window)}
            inverse={isSelected}
            color={isSelected ? "cyan" : undefined}
          >
            {pad(window.planType, LIMIT_WINDOW_COLUMNS.plan)} {pad(windowLabel, LIMIT_WINDOW_COLUMNS.window)} {pad(usedLabel, LIMIT_WINDOW_COLUMNS.used)} {pad(formatLocalDateTime(window.startTimeUtcIso), LIMIT_WINDOW_COLUMNS.date)} {pad(formatLocalDateTime(window.endTimeUtcIso), LIMIT_WINDOW_COLUMNS.date)} {pad(formatInteger(window.eventCount), LIMIT_WINDOW_COLUMNS.events)} {pad(window.limitId, LIMIT_WINDOW_COLUMNS.limit)}
          </Text>
        );
      })}
    </Box>
  );
}

function UsageByModelPanel(props: { stats: ProviderStats; selectedModelId?: string }): React.JSX.Element {
  if (props.stats.modelUsage.length === 0) {
    return <Text color="gray">No model usage found.</Text>;
  }

  const totals = props.stats.summary.totals;
  return (
    <Box flexDirection="column">
      <Text color="gray">model            input        cached       non-cached   output       credits      events</Text>
      {props.stats.modelUsage.map((row) => {
        const isSelected = props.selectedModelId === row.modelId;
        return (
          <Text key={row.modelId} inverse={isSelected} color={isSelected ? "cyan" : undefined}>
            {pad(row.modelId, 16)} {pad(formatInteger(row.totals.inputTokens), 12)} {pad(formatInteger(row.totals.cachedInputTokens), 12)} {pad(formatInteger(row.totals.nonCachedInputTokens), 12)} {pad(formatInteger(row.totals.outputTokens), 12)} {pad(formatCredits(row.totals.estimatedCredits), 12)} {pad(formatInteger(row.totals.eventCount), 8)}
          </Text>
        );
      })}
      <Text color="cyan">
        {pad("TOTAL", 16)} {pad(formatInteger(totals.inputTokens), 12)} {pad(formatInteger(totals.cachedInputTokens), 12)} {pad(formatInteger(totals.nonCachedInputTokens), 12)} {pad(formatInteger(totals.outputTokens), 12)} {pad(formatCredits(totals.estimatedCredits), 12)} {pad(formatInteger(totals.eventCount), 8)}
      </Text>
    </Box>
  );
}

function SelectionDetailsPanel(props: {
  providerState: ProviderLoadState;
  tabId: VerticalTabId;
  selectedLimitRow?: LimitWindowRow;
  selectedModelRow?: ModelUsageRow;
}): React.JSX.Element | null {
  if (props.providerState.status !== "ready") {
    return null;
  }

  if (props.tabId === "limit-windows" && props.selectedLimitRow) {
    const row = props.selectedLimitRow;
    return (
      <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
        <Text color="cyan">Limit details</Text>
        <Text>
          {row.scope}  plan: {row.planType}  window: {formatWindowMinutes(row.windowMinutes)}  used: {row.minUsedPercent}%{"->"}{row.maxUsedPercent}%  limit: {row.limitId}
        </Text>
        <Text>
          range: {formatLocalDateTime(row.startTimeUtcIso)} {"->"} {formatLocalDateTime(row.endTimeUtcIso)}  events: {formatInteger(row.eventCount)}
        </Text>
        <UsageTotalsDetails totals={row.totals} />
      </Box>
    );
  }

  if (props.tabId === "usage-by-model" && props.selectedModelRow) {
    return (
      <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
        <Text color="cyan">Model details</Text>
        <Text>
          model: {props.selectedModelRow.modelId}  events: {formatInteger(props.selectedModelRow.totals.eventCount)}
        </Text>
        <UsageTotalsDetails totals={props.selectedModelRow.totals} />
      </Box>
    );
  }

  return null;
}

function UsageTotalsDetails(props: { totals: UsageTotals }): React.JSX.Element {
  const { totals } = props;
  const inputPerOutput = formatInputPerOutput(totals);
  return (
    <Box flexDirection="column">
      <Text>Total credits burned: {formatCredits(totals.estimatedCredits)}</Text>
      <Text>Credits cost (@ $0.01/credit): {formatUsd(totals.estimatedCredits * CODEX_CREDIT_COST_USD)}</Text>
      <Text>IpO: {inputPerOutput.cached}:{inputPerOutput.nonCached}:{inputPerOutput.output}</Text>
    </Box>
  );
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatCredits(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatUsd(value: number): string {
  return value.toLocaleString("en-US", {
    currency: "USD",
    style: "currency",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  });
}

function formatWindowMinutes(value: number): string {
  const hours = value / 60;
  if (hours >= 24) {
    return `${(hours / 24).toFixed(2)}d`;
  }

  return `${hours.toFixed(2)}h`;
}

function formatLocalDateTime(value: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(new Date(value));

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.day} ${lookup.month} ${lookup.year} ${lookup.hour}:${lookup.minute}`;
}

function pad(value: string, length: number): string {
  return value.length >= length ? value.slice(0, length) : value.padEnd(length);
}

function formatInputPerOutput(totals: UsageTotals): { cached: string; nonCached: string; output: string } {
  if (totals.outputTokens <= 0) {
    return { cached: "0", nonCached: "0", output: "0" };
  }

  return {
    cached: formatInteger(Math.round(totals.cachedInputTokens / totals.outputTokens)),
    nonCached: formatInteger(Math.round(totals.nonCachedInputTokens / totals.outputTokens)),
    output: "1"
  };
}

function clampSelectionIndex(value: number, rowCount: number): number {
  if (rowCount === 0) {
    return -1;
  }

  return Math.max(0, Math.min(value, rowCount - 1));
}

function getLimitRows(providerState: ProviderLoadState): LimitWindowRow[] {
  if (providerState.status !== "ready") {
    return [];
  }

  return [...providerState.stats.primaryLimitWindows, ...providerState.stats.secondaryLimitWindows];
}

function getModelRows(providerState: ProviderLoadState): ModelUsageRow[] {
  if (providerState.status !== "ready") {
    return [];
  }

  return providerState.stats.modelUsage;
}

function getLimitRowKey(row: LimitWindowRow): string {
  return `${row.scope}-${row.planType}-${row.limitId}-${row.startTimeUtcIso}-${row.endTimeUtcIso}`;
}

export function main(): void {
  render(<App />);
}

main();
