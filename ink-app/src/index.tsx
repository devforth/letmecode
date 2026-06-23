import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import {
  configureCopilotVsCodeLogging,
  createProviders,
  type DailyUsageRow,
  type LimitWindowRow,
  type ModelUsageRow,
  type ProviderStatsOptions,
  type ProviderStats,
  type UsageProviderBase,
  type UsageTotals
} from "./providers/index.js";

type VerticalTabId = "limit-windows" | "summary" | "day-to-day-analyses" | "usage-by-model";

type ProviderLoadState =
  | { provider: UsageProviderBase; status: "loading" }
  | { provider: UsageProviderBase; status: "ready"; stats: ProviderStats }
  | { provider: UsageProviderBase; status: "error"; errorMessage: string };

type CopilotActionId = "vscode";

const VERTICAL_TABS: Array<{ id: VerticalTabId; label: string }> = [
  { id: "limit-windows", label: "Limits" },
  { id: "summary", label: "Summary" },
  { id: "day-to-day-analyses", label: "day to day" },
  { id: "usage-by-model", label: "by model" }
];

const CODEX_CREDIT_COST_USD = 0.01;
const VERTICAL_TAB_WIDTH = 12;

const LIMIT_WINDOW_COLUMNS = {
  plan: 8,
  window: 8,
  used: 10,
  date: 17,
  value: 10
} as const;

const MODEL_USAGE_COLUMNS = {
  model: 17,
  input: 12,
  cached: 12,
  nonCached: 12,
  output: 11,
  credits: 12,
  value: 12
} as const;

const DAY_USAGE_COLUMNS = {
  day: 11,
  events: 6,
  input: 11,
  output: 10,
  value: 10
} as const;

const COPILOT_ACTIONS: Array<{ id: CopilotActionId; label: string; enabled: boolean }> = [
  { id: "vscode", label: "Start logging VS Code", enabled: true }
];

function App(props: { statsOptions: ProviderStatsOptions }): React.JSX.Element {
  const { exit } = useApp();
  const providers = React.useState(() => createProviders())[0];
  const [providerStates, setProviderStates] = useState<ProviderLoadState[]>(
    providers.map((provider) => ({ provider, status: "loading" }))
  );
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(0);
  const [selectedVerticalTabIndex, setSelectedVerticalTabIndex] = useState(0);
  const [selectedLimitRowIndex, setSelectedLimitRowIndex] = useState(0);
  const [selectedDayRowIndex, setSelectedDayRowIndex] = useState(0);
  const [selectedModelRowIndex, setSelectedModelRowIndex] = useState(0);
  const [selectedCopilotActionIndex, setSelectedCopilotActionIndex] = useState(0);
  const [copilotActionMessage, setCopilotActionMessage] = useState<string | undefined>();

  const selectedProvider = providerStates[selectedProviderIndex];
  const selectedVerticalTab = VERTICAL_TABS[selectedVerticalTabIndex];
  const limitRows = getLimitRows(selectedProvider);
  const dayRows = getDayRows(selectedProvider);
  const modelRows = getModelRows(selectedProvider);
  const activeLimitRowIndex = clampSelectionIndex(selectedLimitRowIndex, limitRows.length);
  const activeDayRowIndex = clampSelectionIndex(selectedDayRowIndex, dayRows.length);
  const activeModelRowIndex = clampSelectionIndex(selectedModelRowIndex, modelRows.length);
  const selectedLimitRow = activeLimitRowIndex >= 0 ? limitRows[activeLimitRowIndex] : undefined;
  const selectedDayRow = activeDayRowIndex >= 0 ? dayRows[activeDayRowIndex] : undefined;
  const selectedModelRow = activeModelRowIndex >= 0 ? modelRows[activeModelRowIndex] : undefined;

  useEffect(() => {
    let cancelled = false;

    for (const provider of providers) {
      void provider
        .getStats(props.statsOptions)
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
  }, [props.statsOptions, providers]);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
      return;
    }

    if (selectedProvider.provider.id === "copilot" && input >= "1" && input <= String(COPILOT_ACTIONS.length)) {
      setSelectedCopilotActionIndex(Number(input) - 1);
      return;
    }

    if (selectedProvider.provider.id === "copilot" && key.return) {
      runCopilotAction(COPILOT_ACTIONS[selectedCopilotActionIndex].id, setCopilotActionMessage);
      return;
    }

    if (selectedProvider.provider.id === "copilot" && input === "l") {
      setSelectedCopilotActionIndex((current) => (current + 1) % COPILOT_ACTIONS.length);
      return;
    }

    if (selectedProvider.provider.id === "copilot" && input === "h") {
      setSelectedCopilotActionIndex((current) => (current - 1 + COPILOT_ACTIONS.length) % COPILOT_ACTIONS.length);
      return;
    }

    if (key.rightArrow) {
      if (selectedVerticalTab.id === "limit-windows") {
        setSelectedLimitRowIndex(clampSelectionIndex(activeLimitRowIndex + 1, limitRows.length));
        return;
      }

      if (selectedVerticalTab.id === "usage-by-model") {
        setSelectedModelRowIndex(clampSelectionIndex(activeModelRowIndex + 1, modelRows.length));
        return;
      }

      if (selectedVerticalTab.id === "day-to-day-analyses") {
        setSelectedDayRowIndex(clampSelectionIndex(activeDayRowIndex + 1, dayRows.length));
        return;
      }
    }

    if (key.leftArrow) {
      if (selectedVerticalTab.id === "limit-windows") {
        setSelectedLimitRowIndex(clampSelectionIndex(activeLimitRowIndex - 1, limitRows.length));
        return;
      }

      if (selectedVerticalTab.id === "usage-by-model") {
        setSelectedModelRowIndex(clampSelectionIndex(activeModelRowIndex - 1, modelRows.length));
        return;
      }

      if (selectedVerticalTab.id === "day-to-day-analyses") {
        setSelectedDayRowIndex(clampSelectionIndex(activeDayRowIndex - 1, dayRows.length));
        return;
      }
    }

    if ((key.tab && !key.shift) || input === "]") {
      setSelectedProviderIndex((current) => (current + 1) % providerStates.length);
      return;
    }

    if ((key.tab && key.shift) || input === "[") {
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
        [/]/tab to switch providers, j/k or up/down for details, left/right to select a row, enter for actions, q to quit
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
        <Box flexDirection="column" width={VERTICAL_TAB_WIDTH} marginRight={2}>
          {VERTICAL_TABS.map((tab, index) => (
            <VerticalTab key={tab.id} label={tab.label} active={index === selectedVerticalTabIndex} />
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <ContentPanel
            providerState={selectedProvider}
            tabId={selectedVerticalTab.id}
            selectedLimitRowKey={selectedLimitRow ? getLimitRowKey(selectedLimitRow) : undefined}
            selectedDayKey={selectedDayRow?.dayKey}
            selectedModelId={selectedModelRow?.modelId}
          />
        </Box>
      </Box>

      <SelectionDetailsPanel
        providerState={selectedProvider}
        tabId={selectedVerticalTab.id}
        selectedLimitRow={selectedLimitRow}
        selectedDayRow={selectedDayRow}
        selectedModelRow={selectedModelRow}
      />

      <CopilotActionsPanel
        providerState={selectedProvider}
        actionMessage={copilotActionMessage}
        selectedActionIndex={selectedCopilotActionIndex}
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

function CopilotActionsPanel(props: {
  providerState: ProviderLoadState;
  actionMessage?: string;
  selectedActionIndex?: number;
}): React.JSX.Element | null {
  if (props.providerState.provider.id !== "copilot") {
    return null;
  }

  const hasNoUsage = props.providerState.status === "ready" && props.providerState.stats.summary.tokenEvents === 0;
  const accentColor = hasNoUsage ? "red" : "cyan";

  return (
    <Box marginTop={1} borderStyle="round" borderColor={accentColor} paddingX={1} flexDirection="column">
      <Text color={accentColor}>Copilot setup</Text>
      <Box>
        {COPILOT_ACTIONS.map((action, index) => (
          <Box key={action.id} marginRight={1}>
            <Text
              inverse={index === (props.selectedActionIndex ?? 0)}
              bold={hasNoUsage && action.id === "vscode"}
              color={action.enabled ? (hasNoUsage && action.id === "vscode" ? accentColor : undefined) : "gray"}
            >
              {`${index + 1} ${action.label}`}
            </Text>
          </Box>
        ))}
      </Box>
      <Text color={hasNoUsage ? accentColor : "gray"}>Press 1 or h/l to select an action, enter to run selected.</Text>
      {props.actionMessage ? <Text>{props.actionMessage}</Text> : null}
    </Box>
  );
}

function runCopilotAction(
  actionId: CopilotActionId,
  setCopilotActionMessage: React.Dispatch<React.SetStateAction<string | undefined>>
): void {
  setCopilotActionMessage("Updating VS Code settings...");
  void configureCopilotVsCodeLogging()
    .then((result) => {
      setCopilotActionMessage(
        result.changed
          ? `VS Code logging enabled: ${result.outfile}`
          : `VS Code logging already enabled: ${result.outfile}`
      );
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setCopilotActionMessage(`Failed to update VS Code settings: ${message}`);
    });
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
    <Box width={VERTICAL_TAB_WIDTH}>
      <Text wrap="truncate-end" inverse={props.active}>
        {props.active ? ` ${props.label} ` : ` ${props.label}`}
      </Text>
    </Box>
  );
}

function SummaryPanel(props: { stats: ProviderStats }): React.JSX.Element {
  const { summary } = props.stats;
  const inputPerOutput = formatInputPerOutput(summary.totals);
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
        input: {formatInteger(summary.totals.inputTokens)}  cached: {formatCacheTokens(summary.totals, "cached")}  non-cached: {formatCacheTokens(summary.totals, "non-cached")}
      </Text>
      <Text>
        output: {formatInteger(summary.totals.outputTokens)}  reasoning: {formatInteger(summary.totals.reasoningOutputTokens)}  total: {formatInteger(summary.totals.totalTokens)}
      </Text>
      <Text>
        estimated credits: {formatUsageCredits(summary.totals)} 
      </Text>
      <Text>
        IpO: {inputPerOutput.cached}:{inputPerOutput.nonCached}:{inputPerOutput.output}
      </Text>
      <Text>
        models: {summary.distinctModels.join(", ") || "none"}
      </Text>
      <Text>
        plans: {summary.distinctPlanTypes.join(", ") || "none"}
      </Text>
    </Box>
  );
}

function ContentPanel(props: {
  providerState: ProviderLoadState;
  tabId: VerticalTabId;
  selectedLimitRowKey?: string;
  selectedDayKey?: string;
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

  if (props.tabId === "day-to-day-analyses") {
    return <DayToDayPanel stats={props.providerState.stats} selectedDayKey={props.selectedDayKey} />;
  }

  return <UsageByModelPanel stats={props.providerState.stats} selectedModelId={props.selectedModelId} />;
}

function LimitWindowsPanel(props: { stats: ProviderStats; selectedRowKey?: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>Primary Limit Windows</Text>
      <LimitWindowSection windows={props.stats.primaryLimitWindows} selectedRowKey={props.selectedRowKey} />
      <Box marginTop={1} />
      <Text bold>Secondary Limit Windows</Text>
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
        {pad("plan", LIMIT_WINDOW_COLUMNS.plan)} {pad("window", LIMIT_WINDOW_COLUMNS.window)} {pad("used", LIMIT_WINDOW_COLUMNS.used)} {pad("start", LIMIT_WINDOW_COLUMNS.date)} {pad("end", LIMIT_WINDOW_COLUMNS.date)} value
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
            {pad(window.planType, LIMIT_WINDOW_COLUMNS.plan)} {pad(windowLabel, LIMIT_WINDOW_COLUMNS.window)} {pad(usedLabel, LIMIT_WINDOW_COLUMNS.used)} {pad(formatLocalDateTime(window.startTimeUtcIso), LIMIT_WINDOW_COLUMNS.date)} {pad(formatLocalDateTime(window.endTimeUtcIso), LIMIT_WINDOW_COLUMNS.date)} {pad(formatUsd(window.totals.estimatedCredits * CODEX_CREDIT_COST_USD), LIMIT_WINDOW_COLUMNS.value)}
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
      <Text color="gray">
        {pad("model", MODEL_USAGE_COLUMNS.model)} {pad("input", MODEL_USAGE_COLUMNS.input)} {pad("cached", MODEL_USAGE_COLUMNS.cached)} {pad("non-cached", MODEL_USAGE_COLUMNS.nonCached)} {pad("output", MODEL_USAGE_COLUMNS.output)} {pad("credits", MODEL_USAGE_COLUMNS.credits)} value
      </Text>
      {props.stats.modelUsage.map((row) => {
        const isSelected = props.selectedModelId === row.modelId;
        return (
          <Text key={row.modelId} inverse={isSelected} color={isSelected ? "cyan" : undefined}>
            {pad(row.modelId, MODEL_USAGE_COLUMNS.model)} {pad(formatInteger(row.totals.inputTokens), MODEL_USAGE_COLUMNS.input)} {pad(formatCacheTokens(row.totals, "cached"), MODEL_USAGE_COLUMNS.cached)} {pad(formatCacheTokens(row.totals, "non-cached"), MODEL_USAGE_COLUMNS.nonCached)} {pad(formatInteger(row.totals.outputTokens), MODEL_USAGE_COLUMNS.output)} {pad(formatUsageCredits(row.totals), MODEL_USAGE_COLUMNS.credits)} {pad(formatUsageUsd(row.totals), MODEL_USAGE_COLUMNS.value)}
          </Text>
        );
      })}
      <Text color="cyan">
        {pad("TOTAL", MODEL_USAGE_COLUMNS.model)} {pad(formatInteger(totals.inputTokens), MODEL_USAGE_COLUMNS.input)} {pad(formatCacheTokens(totals, "cached"), MODEL_USAGE_COLUMNS.cached)} {pad(formatCacheTokens(totals, "non-cached"), MODEL_USAGE_COLUMNS.nonCached)} {pad(formatInteger(totals.outputTokens), MODEL_USAGE_COLUMNS.output)} {pad(formatUsageCredits(totals), MODEL_USAGE_COLUMNS.credits)} {pad(formatUsageUsd(totals), MODEL_USAGE_COLUMNS.value)}
      </Text>
    </Box>
  );
}

function DayToDayPanel(props: { stats: ProviderStats; selectedDayKey?: string }): React.JSX.Element {
  if (props.stats.dayUsage.length === 0) {
    return <Text color="gray">No day-by-day usage found.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text color="gray">
        {pad("day", DAY_USAGE_COLUMNS.day)} {pad("events", DAY_USAGE_COLUMNS.events)} {pad("input", DAY_USAGE_COLUMNS.input)} {pad("output", DAY_USAGE_COLUMNS.output)} value
      </Text>
      {props.stats.dayUsage.map((row) => {
        const isSelected = props.selectedDayKey === row.dayKey;
        return (
          <Text key={row.dayKey} inverse={isSelected} color={isSelected ? "cyan" : undefined}>
            {pad(formatUtcDay(row.dayKey), DAY_USAGE_COLUMNS.day)} {pad(formatInteger(row.totals.eventCount), DAY_USAGE_COLUMNS.events)} {pad(formatInteger(row.totals.inputTokens), DAY_USAGE_COLUMNS.input)} {pad(formatInteger(row.totals.outputTokens), DAY_USAGE_COLUMNS.output)} {pad(formatUsageUsd(row.totals), DAY_USAGE_COLUMNS.value)}
          </Text>
        );
      })}
    </Box>
  );
}

function SelectionDetailsPanel(props: {
  providerState: ProviderLoadState;
  tabId: VerticalTabId;
  selectedLimitRow?: LimitWindowRow;
  selectedDayRow?: DailyUsageRow;
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

  if (props.tabId === "day-to-day-analyses" && props.selectedDayRow) {
    const row = props.selectedDayRow;
    return (
      <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
        <Text color="cyan">Day details</Text>
        <Text>
          day: {formatUtcDay(row.dayKey)}  events: {formatInteger(row.totals.eventCount)}  models: {formatInteger(row.distinctModels.length)}  plans: {formatInteger(row.distinctPlanTypes.length)}
        </Text>
        <Text>range: {formatEventRange(row.firstEventUtcIso, row.lastEventUtcIso)}</Text>
        <Text>input: {formatInteger(row.totals.inputTokens)}  cached: {formatCacheTokens(row.totals, "cached")}</Text>
        <Text>non-cached: {formatCacheTokens(row.totals, "non-cached")}  output: {formatInteger(row.totals.outputTokens)}</Text>
        <Text>models: {row.distinctModels.join(", ") || "none"}</Text>
        <Text>plans: {row.distinctPlanTypes.join(", ") || "none"}</Text>
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
      <Text>Total credits burned: {formatUsageCredits(totals)}</Text>
      <Text>Credits Value (@ $0.01/credit): {formatUsageUsd(totals)}</Text>
      <Text>IpO: {inputPerOutput.cached}:{inputPerOutput.nonCached}:{inputPerOutput.output}</Text>
    </Box>
  );
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatCredits(value: number): string {
  if (value > 0 && value < 0.01) {
    return "<0.01";
  }

  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatUsageCredits(totals: UsageTotals): string {
  return totals.estimatedCreditsStatus === "unavailable" ? "unknown" : formatCredits(totals.estimatedCredits);
}

function formatUsageUsd(totals: UsageTotals): string {
  return totals.estimatedCreditsStatus === "unavailable"
    ? "unknown"
    : formatUsd(totals.estimatedCredits * CODEX_CREDIT_COST_USD);
}

function formatCacheTokens(totals: UsageTotals, kind: "cached" | "non-cached"): string {
  if (totals.cacheStatus === "unavailable") {
    return "unknown";
  }

  return formatInteger(kind === "cached" ? totals.cachedInputTokens : totals.nonCachedInputTokens);
}

function formatUsd(value: number): string {
  if (value > 0 && value < 0.0001) {
    return "<$0.0001";
  }

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

function formatUtcDay(value: string): string {
  if (value === "unknown") {
    return "unknown";
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "2-digit",
    timeZone: "UTC"
  }).formatToParts(new Date(`${value}T00:00:00.000Z`));

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.day} ${lookup.month} ${lookup.year}`;
}

function formatEventRange(firstEventUtcIso: string | null, lastEventUtcIso: string | null): string {
  if (!firstEventUtcIso || !lastEventUtcIso) {
    return "unknown";
  }

  return `${formatLocalDateTime(firstEventUtcIso)} -> ${formatLocalDateTime(lastEventUtcIso)}`;
}

function pad(value: string, length: number): string {
  return value.length >= length ? value.slice(0, length) : value.padEnd(length);
}

function formatInputPerOutput(totals: UsageTotals): { cached: string; nonCached: string; output: string } {
  if (totals.cacheStatus === "unavailable") {
    return { cached: "unknown", nonCached: "unknown", output: "1" };
  }

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

function getDayRows(providerState: ProviderLoadState): DailyUsageRow[] {
  if (providerState.status !== "ready") {
    return [];
  }

  return providerState.stats.dayUsage;
}

function getLimitRowKey(row: LimitWindowRow): string {
  return `${row.scope}-${row.planType}-${row.limitId}-${row.startTimeUtcIso}-${row.endTimeUtcIso}`;
}

function parseStatsOptions(argv: string[]): ProviderStatsOptions {
  return {
    verbose: argv.includes("-v") || argv.includes("--verbose")
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  render(<App statsOptions={parseStatsOptions(argv)} />);
}

main();
