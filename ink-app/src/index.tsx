import React, { useEffect, useRef, useState } from "react";
import { Box, Text, measureElement, useApp, useInput, useStdout, render } from "ink";
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

type ScrollableLine = {
  key: string;
  text: string;
  bold?: boolean;
  color?: string;
  inverse?: boolean;
};

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

const OPENAI_MODEL_USAGE_COLUMNS = {
  model: 17,
  input: 12,
  cached: 12,
  output: 11,
  credits: 12,
  value: 12
} as const;

const ANTHROPIC_MODEL_USAGE_COLUMNS = {
  model: 17,
  input: 10,
  cacheWrite5m: 10,
  cacheWrite1h: 10,
  cacheRead: 10,
  output: 10,
  credits: 12,
  value: 12
} as const;

const OPENAI_DAY_USAGE_COLUMNS = {
  day: 11,
  events: 6,
  input: 11,
  output: 10,
  value: 10
} as const;

const ANTHROPIC_DAY_USAGE_COLUMNS = {
  day: 11,
  events: 6,
  input: 10,
  cacheWrite5m: 10,
  cacheWrite1h: 10,
  cacheRead: 10,
  output: 10,
  value: 10
} as const;

const COPILOT_ACTIONS: Array<{ id: CopilotActionId; label: string; enabled: boolean }> = [
  { id: "vscode", label: "Start logging VS Code", enabled: true }
];

const ENTER_FULLSCREEN_MODE = "\u001B[?1049h\u001B[2J\u001B[H";
const EXIT_FULLSCREEN_MODE = "\u001B[?1049l";
const SCROLLBAR_TRACK_GLYPH = "│";
const SCROLLBAR_THUMB_GLYPH = "█";

function App(props: { statsOptions: ProviderStatsOptions }): React.JSX.Element {
  const { exit } = useApp();
  const viewportHeight = useViewportHeight();
  const { ref: contentPanelRef, height: contentPanelHeight } = useMeasuredElementSize();
  const providers = React.useState(() => createProviders())[0];
  const [providerStates, setProviderStates] = useState<ProviderLoadState[]>(
    providers.map((provider) => ({ provider, status: "loading" }))
  );
  const [selectedProviderId, setSelectedProviderId] = useState(providers[0]?.id ?? "");
  const [hasUserSelectedProvider, setHasUserSelectedProvider] = useState(false);
  const [selectedVerticalTabIndex, setSelectedVerticalTabIndex] = useState(0);
  const [selectedLimitRowIndex, setSelectedLimitRowIndex] = useState(0);
  const [selectedDayRowIndex, setSelectedDayRowIndex] = useState(0);
  const [selectedModelRowIndex, setSelectedModelRowIndex] = useState(0);
  const [selectedCopilotActionIndex, setSelectedCopilotActionIndex] = useState(0);
  const [copilotActionMessage, setCopilotActionMessage] = useState<string | undefined>();

  const sortedProviderStates = React.useMemo(() => sortProviderStatesByUsage(providerStates), [providerStates]);
  const selectedProviderIndex = Math.max(
    0,
    sortedProviderStates.findIndex((state) => state.provider.id === selectedProviderId)
  );
  const selectedProvider = sortedProviderStates[selectedProviderIndex];
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

  useEffect(() => {
    if (hasUserSelectedProvider || providerStates.some((state) => state.status === "loading")) {
      return;
    }

    const topProvider = sortedProviderStates[0];
    if (providerUsageScore(topProvider) <= 0) {
      return;
    }

    setSelectedProviderId(topProvider.provider.id);
  }, [hasUserSelectedProvider, providerStates, sortedProviderStates]);

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
      setSelectedProviderId(sortedProviderStates[(selectedProviderIndex + 1) % sortedProviderStates.length].provider.id);
      setHasUserSelectedProvider(true);
      return;
    }

    if ((key.tab && key.shift) || input === "[") {
      setSelectedProviderId(
        sortedProviderStates[(selectedProviderIndex - 1 + sortedProviderStates.length) % sortedProviderStates.length]
          .provider.id
      );
      setHasUserSelectedProvider(true);
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
    <Box flexDirection="column" paddingX={1} height={viewportHeight} overflow="hidden">
      <Text bold color="cyan">
        letmecode usage dashboard
      </Text>
      <Text color="gray">
        [/]/tab to switch providers, j/k or up/down for details, left/right to select a row, enter for actions, q to quit
      </Text>
      <Box marginTop={1}>
        {sortedProviderStates.map((state) => (
          <ProviderTab
            key={state.provider.id}
            label={state.provider.label}
            active={state.provider.id === selectedProvider.provider.id}
            status={state.status}
          />
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column" flexGrow={1} overflow="hidden">
        <Box flexGrow={1} overflow="hidden">
          <Box flexDirection="column" width={VERTICAL_TAB_WIDTH} marginRight={2} overflow="hidden">
            {VERTICAL_TABS.map((tab, index) => (
              <VerticalTab key={tab.id} label={tab.label} active={index === selectedVerticalTabIndex} />
            ))}
          </Box>
          <Box ref={contentPanelRef} flexDirection="column" flexGrow={1} overflow="hidden">
            <ContentPanel
              providerState={selectedProvider}
              tabId={selectedVerticalTab.id}
              selectedLimitRowKey={selectedLimitRow ? getLimitRowKey(selectedLimitRow) : undefined}
              selectedDayKey={selectedDayRow?.dayKey}
              selectedModelId={selectedModelRow?.modelId}
              availableHeight={contentPanelHeight}
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
          <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column" overflow="hidden">
            <Text color="yellow">Warnings</Text>
            {selectedProvider.stats.warnings.map((warning) => (
              <Text key={warning}>{warning}</Text>
            ))}
          </Box>
        ) : null}
      </Box>
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
      setCopilotActionMessage(formatCopilotLoggingResult(result));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setCopilotActionMessage(`Failed to update VS Code settings: ${message}`);
    });
}

function formatCopilotLoggingResult(result: Awaited<ReturnType<typeof configureCopilotVsCodeLogging>>): string {
  const status = result.changed ? "VS Code logging enabled" : "VS Code logging already enabled";
  return [
    `${status}: ${result.outfile}`,
    `Settings written to: ${result.settingsPath}`,
    'Open "Preferences: Open User Settings (JSON)" in VS Code and verify that this is the active file.',
    "Expected settings:",
    '"github.copilot.chat.otel.enabled": true',
    '"github.copilot.chat.otel.exporterType": "file"',
    '"github.copilot.chat.otel.captureContent": false',
    `"github.copilot.chat.otel.outfile": "${result.outfile}"`
  ].join("\n");
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
  return (
    <Box flexDirection="column">
      <Text bold>{props.stats.providerLabel}</Text>
      <Text>
        root: {summary.rootLabel} ({summary.rootPath})
      </Text>
      <Text>
        files: {formatInteger(summary.filesScanned)}  lines: {formatInteger(summary.linesRead)}  token events: {formatInteger(summary.tokenEvents)}
      </Text>
      <UsageBreakdownLines totals={summary.totals} />
      <Text>
        estimated credits: {formatUsageCredits(summary.totals)} 
      </Text>
      <Text>IpO: {formatInputPerOutput(summary.totals)}</Text>
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
  availableHeight: number;
}): React.JSX.Element {
  if (props.providerState.status === "loading") {
    return <Text color="yellow">Loading {props.providerState.provider.label} stats...</Text>;
  }

  if (props.providerState.status === "error") {
    return <Text color="red">Provider error: {props.providerState.errorMessage}</Text>;
  }

  if (props.tabId === "limit-windows") {
    return (
      <LimitWindowsPanel
        stats={props.providerState.stats}
        selectedRowKey={props.selectedLimitRowKey}
        availableHeight={props.availableHeight}
      />
    );
  }

  if (props.tabId === "summary") {
    return <SummaryPanel stats={props.providerState.stats} />;
  }

  if (props.tabId === "day-to-day-analyses") {
    return (
      <DayToDayPanel
        stats={props.providerState.stats}
        selectedDayKey={props.selectedDayKey}
        availableHeight={props.availableHeight}
      />
    );
  }

  return (
    <UsageByModelPanel
      stats={props.providerState.stats}
      selectedModelId={props.selectedModelId}
      availableHeight={props.availableHeight}
    />
  );
}

function LimitWindowsPanel(props: {
  stats: ProviderStats;
  selectedRowKey?: string;
  availableHeight: number;
}): React.JSX.Element {
  const bodyLines = [
    { key: "primary-title", text: "Primary Limit Windows", bold: true },
    ...buildLimitWindowSectionLines("primary", props.stats.primaryLimitWindows, props.selectedRowKey),
    { key: "section-gap", text: "" },
    { key: "secondary-title", text: "Secondary Limit Windows", bold: true },
    ...buildLimitWindowSectionLines("secondary", props.stats.secondaryLimitWindows, props.selectedRowKey)
  ];

  return (
    <ScrollableLineViewport
      bodyLines={bodyLines}
      selectedBodyLineKey={props.selectedRowKey ? `limit-row:${props.selectedRowKey}` : undefined}
      availableHeight={props.availableHeight}
    />
  );
}

function UsageByModelPanel(props: {
  stats: ProviderStats;
  selectedModelId?: string;
  availableHeight: number;
}): React.JSX.Element {
  if (props.stats.modelUsage.length === 0) {
    return <Text color="gray">No model usage found.</Text>;
  }

  const totals = props.stats.summary.totals;
  if (totals.tokenBreakdown.schema === "anthropic") {
    return (
      <ScrollableLineViewport
        headerLines={[
          {
            key: "anthropic-model-header",
            text: `${pad("model", ANTHROPIC_MODEL_USAGE_COLUMNS.model)} ${pad("input", ANTHROPIC_MODEL_USAGE_COLUMNS.input)} ${pad("cacheW5m", ANTHROPIC_MODEL_USAGE_COLUMNS.cacheWrite5m)} ${pad("cacheW1h", ANTHROPIC_MODEL_USAGE_COLUMNS.cacheWrite1h)} ${pad("cacheRead", ANTHROPIC_MODEL_USAGE_COLUMNS.cacheRead)} ${pad("output", ANTHROPIC_MODEL_USAGE_COLUMNS.output)} ${pad("credits", ANTHROPIC_MODEL_USAGE_COLUMNS.credits)} value`,
            color: "gray"
          }
        ]}
        bodyLines={props.stats.modelUsage.flatMap((row) => {
          if (row.totals.tokenBreakdown.schema !== "anthropic") {
            return [];
          }

          return [
            {
              key: `model-row:${row.modelId}`,
              text: `${pad(row.modelId, ANTHROPIC_MODEL_USAGE_COLUMNS.model)} ${pad(formatInteger(row.totals.tokenBreakdown.inputTokens), ANTHROPIC_MODEL_USAGE_COLUMNS.input)} ${pad(formatInteger(row.totals.tokenBreakdown.cacheWrite5mInputTokens), ANTHROPIC_MODEL_USAGE_COLUMNS.cacheWrite5m)} ${pad(formatInteger(row.totals.tokenBreakdown.cacheWrite1hInputTokens), ANTHROPIC_MODEL_USAGE_COLUMNS.cacheWrite1h)} ${pad(formatInteger(row.totals.tokenBreakdown.cacheReadInputTokens), ANTHROPIC_MODEL_USAGE_COLUMNS.cacheRead)} ${pad(formatInteger(row.totals.outputTokens), ANTHROPIC_MODEL_USAGE_COLUMNS.output)} ${pad(formatUsageCredits(row.totals, row.modelId), ANTHROPIC_MODEL_USAGE_COLUMNS.credits)} ${pad(formatUsageUsd(row.totals, row.modelId), ANTHROPIC_MODEL_USAGE_COLUMNS.value)}`,
              inverse: props.selectedModelId === row.modelId,
              color: props.selectedModelId === row.modelId ? "cyan" : undefined
            }
          ];
        })}
        footerLines={[
          {
            key: "anthropic-model-total",
            text: `${pad("TOTAL", ANTHROPIC_MODEL_USAGE_COLUMNS.model)} ${pad(formatInteger(totals.tokenBreakdown.inputTokens), ANTHROPIC_MODEL_USAGE_COLUMNS.input)} ${pad(formatInteger(totals.tokenBreakdown.cacheWrite5mInputTokens), ANTHROPIC_MODEL_USAGE_COLUMNS.cacheWrite5m)} ${pad(formatInteger(totals.tokenBreakdown.cacheWrite1hInputTokens), ANTHROPIC_MODEL_USAGE_COLUMNS.cacheWrite1h)} ${pad(formatInteger(totals.tokenBreakdown.cacheReadInputTokens), ANTHROPIC_MODEL_USAGE_COLUMNS.cacheRead)} ${pad(formatInteger(totals.outputTokens), ANTHROPIC_MODEL_USAGE_COLUMNS.output)} ${pad(formatUsageCredits(totals), ANTHROPIC_MODEL_USAGE_COLUMNS.credits)} ${pad(formatUsageUsd(totals), ANTHROPIC_MODEL_USAGE_COLUMNS.value)}`,
            color: "cyan"
          }
        ]}
        selectedBodyLineKey={props.selectedModelId ? `model-row:${props.selectedModelId}` : undefined}
        availableHeight={props.availableHeight}
      />
    );
  }

  return (
    <ScrollableLineViewport
      headerLines={[
        {
          key: "openai-model-header",
          text: `${pad("model", OPENAI_MODEL_USAGE_COLUMNS.model)} ${pad("uncached", OPENAI_MODEL_USAGE_COLUMNS.input)} ${pad("cached", OPENAI_MODEL_USAGE_COLUMNS.cached)} ${pad("output", OPENAI_MODEL_USAGE_COLUMNS.output)} ${pad("credits", OPENAI_MODEL_USAGE_COLUMNS.credits)} value`,
          color: "gray"
        }
      ]}
      bodyLines={props.stats.modelUsage.flatMap((row) => {
        if (row.totals.tokenBreakdown.schema !== "openai") {
          return [];
        }

        return [
          {
            key: `model-row:${row.modelId}`,
            text: `${pad(row.modelId, OPENAI_MODEL_USAGE_COLUMNS.model)} ${pad(formatOpenAiTokens(row.totals, "non-cached"), OPENAI_MODEL_USAGE_COLUMNS.input)} ${pad(formatOpenAiTokens(row.totals, "cached"), OPENAI_MODEL_USAGE_COLUMNS.cached)} ${pad(formatInteger(row.totals.outputTokens), OPENAI_MODEL_USAGE_COLUMNS.output)} ${pad(formatUsageCredits(row.totals, row.modelId), OPENAI_MODEL_USAGE_COLUMNS.credits)} ${pad(formatUsageUsd(row.totals, row.modelId), OPENAI_MODEL_USAGE_COLUMNS.value)}`,
            inverse: props.selectedModelId === row.modelId,
            color: props.selectedModelId === row.modelId ? "cyan" : undefined
          }
        ];
      })}
      footerLines={[
        {
          key: "openai-model-total",
          text: `${pad("TOTAL", OPENAI_MODEL_USAGE_COLUMNS.model)} ${pad(formatOpenAiTokens(totals, "non-cached"), OPENAI_MODEL_USAGE_COLUMNS.input)} ${pad(formatOpenAiTokens(totals, "cached"), OPENAI_MODEL_USAGE_COLUMNS.cached)} ${pad(formatInteger(totals.outputTokens), OPENAI_MODEL_USAGE_COLUMNS.output)} ${pad(formatUsageCredits(totals), OPENAI_MODEL_USAGE_COLUMNS.credits)} ${pad(formatUsageUsd(totals), OPENAI_MODEL_USAGE_COLUMNS.value)}`,
          color: "cyan"
        }
      ]}
      selectedBodyLineKey={props.selectedModelId ? `model-row:${props.selectedModelId}` : undefined}
      availableHeight={props.availableHeight}
    />
  );
}

function DayToDayPanel(props: {
  stats: ProviderStats;
  selectedDayKey?: string;
  availableHeight: number;
}): React.JSX.Element {
  if (props.stats.dayUsage.length === 0) {
    return <Text color="gray">No day-by-day usage found.</Text>;
  }

  const totals = props.stats.summary.totals;
  if (totals.tokenBreakdown.schema === "anthropic") {
    return (
      <ScrollableLineViewport
        headerLines={[
          {
            key: "anthropic-day-header",
            text: `${pad("day", ANTHROPIC_DAY_USAGE_COLUMNS.day)} ${pad("events", ANTHROPIC_DAY_USAGE_COLUMNS.events)} ${pad("input", ANTHROPIC_DAY_USAGE_COLUMNS.input)} ${pad("cacheW5m", ANTHROPIC_DAY_USAGE_COLUMNS.cacheWrite5m)} ${pad("cacheW1h", ANTHROPIC_DAY_USAGE_COLUMNS.cacheWrite1h)} ${pad("cacheRead", ANTHROPIC_DAY_USAGE_COLUMNS.cacheRead)} ${pad("output", ANTHROPIC_DAY_USAGE_COLUMNS.output)} value`,
            color: "gray"
          }
        ]}
        bodyLines={props.stats.dayUsage.flatMap((row) => {
          if (row.totals.tokenBreakdown.schema !== "anthropic") {
            return [];
          }

          return [
            {
              key: `day-row:${row.dayKey}`,
              text: `${pad(formatUtcDay(row.dayKey), ANTHROPIC_DAY_USAGE_COLUMNS.day)} ${pad(formatInteger(row.totals.eventCount), ANTHROPIC_DAY_USAGE_COLUMNS.events)} ${pad(formatInteger(row.totals.tokenBreakdown.inputTokens), ANTHROPIC_DAY_USAGE_COLUMNS.input)} ${pad(formatInteger(row.totals.tokenBreakdown.cacheWrite5mInputTokens), ANTHROPIC_DAY_USAGE_COLUMNS.cacheWrite5m)} ${pad(formatInteger(row.totals.tokenBreakdown.cacheWrite1hInputTokens), ANTHROPIC_DAY_USAGE_COLUMNS.cacheWrite1h)} ${pad(formatInteger(row.totals.tokenBreakdown.cacheReadInputTokens), ANTHROPIC_DAY_USAGE_COLUMNS.cacheRead)} ${pad(formatInteger(row.totals.outputTokens), ANTHROPIC_DAY_USAGE_COLUMNS.output)} ${pad(formatUsageUsd(row.totals), ANTHROPIC_DAY_USAGE_COLUMNS.value)}`,
              inverse: props.selectedDayKey === row.dayKey,
              color: props.selectedDayKey === row.dayKey ? "cyan" : undefined
            }
          ];
        })}
        selectedBodyLineKey={props.selectedDayKey ? `day-row:${props.selectedDayKey}` : undefined}
        availableHeight={props.availableHeight}
      />
    );
  }

  return (
    <ScrollableLineViewport
      headerLines={[
        {
          key: "openai-day-header",
          text: `${pad("day", OPENAI_DAY_USAGE_COLUMNS.day)} ${pad("events", OPENAI_DAY_USAGE_COLUMNS.events)} ${pad("input", OPENAI_DAY_USAGE_COLUMNS.input)} ${pad("output", OPENAI_DAY_USAGE_COLUMNS.output)} value`,
          color: "gray"
        }
      ]}
      bodyLines={props.stats.dayUsage.flatMap((row) => {
        if (row.totals.tokenBreakdown.schema !== "openai") {
          return [];
        }

        return [
          {
            key: `day-row:${row.dayKey}`,
            text: `${pad(formatUtcDay(row.dayKey), OPENAI_DAY_USAGE_COLUMNS.day)} ${pad(formatInteger(row.totals.eventCount), OPENAI_DAY_USAGE_COLUMNS.events)} ${pad(formatInteger(row.totals.inputTotalTokens), OPENAI_DAY_USAGE_COLUMNS.input)} ${pad(formatInteger(row.totals.outputTokens), OPENAI_DAY_USAGE_COLUMNS.output)} ${pad(formatUsageUsd(row.totals), OPENAI_DAY_USAGE_COLUMNS.value)}`,
            inverse: props.selectedDayKey === row.dayKey,
            color: props.selectedDayKey === row.dayKey ? "cyan" : undefined
          }
        ];
      })}
      selectedBodyLineKey={props.selectedDayKey ? `day-row:${props.selectedDayKey}` : undefined}
      availableHeight={props.availableHeight}
    />
  );
}

function ScrollableLineViewport(props: {
  headerLines?: ScrollableLine[];
  bodyLines: ScrollableLine[];
  footerLines?: ScrollableLine[];
  selectedBodyLineKey?: string;
  availableHeight: number;
}): React.JSX.Element {
  const headerLines = props.headerLines ?? [];
  const footerLines = props.footerLines ?? [];
  const layout = resolveScrollableViewportLayout(
    props.availableHeight,
    headerLines.length,
    props.bodyLines.length,
    footerLines.length
  );
  const selectedBodyLineIndex = props.selectedBodyLineKey
    ? props.bodyLines.findIndex((line) => line.key === props.selectedBodyLineKey)
    : -1;
  const scrollOffset = useAutoScrollOffset(selectedBodyLineIndex, props.bodyLines.length, layout.bodyVisibleCount);
  const visibleHeaderLines = headerLines.slice(0, layout.headerVisibleCount);
  const visibleBodyLines = props.bodyLines.slice(scrollOffset, scrollOffset + layout.bodyVisibleCount);
  const visibleFooterLines = footerLines.slice(
    Math.max(0, footerLines.length - layout.footerVisibleCount)
  );
  const bodyScrollbarLines = buildScrollbarLines(layout.bodyVisibleCount, props.bodyLines.length, scrollOffset);
  const showScrollbar = bodyScrollbarLines.length > 0;

  return (
    <Box flexDirection="row" overflow="hidden">
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visibleHeaderLines.map((line) => (
          <ScrollableViewportLine key={line.key} line={line} />
        ))}
        {visibleBodyLines.map((line) => (
          <ScrollableViewportLine key={line.key} line={line} />
        ))}
        {visibleFooterLines.map((line) => (
          <ScrollableViewportLine key={line.key} line={line} />
        ))}
      </Box>
      {showScrollbar ? (
        <Box flexDirection="column" marginLeft={1}>
          {visibleHeaderLines.map((line) => (
            <Text key={`${line.key}-scrollbar`} color="gray">
              {" "}
            </Text>
          ))}
          {bodyScrollbarLines.map((line, index) => (
            <Text key={`scrollbar-${index}`} color={line === "#" ? "cyan" : "gray"}>
              {line}
            </Text>
          ))}
          {visibleFooterLines.map((line) => (
            <Text key={`${line.key}-scrollbar`} color="gray">
              {" "}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function ScrollableViewportLine(props: { line: ScrollableLine }): React.JSX.Element {
  return (
    <Text bold={props.line.bold} color={props.line.color} inverse={props.line.inverse} wrap="truncate-end">
      {props.line.text}
    </Text>
  );
}

function buildLimitWindowSectionLines(
  scope: "primary" | "secondary",
  windows: LimitWindowRow[],
  selectedRowKey?: string
): ScrollableLine[] {
  if (windows.length === 0) {
    return [{ key: `${scope}-empty`, text: "No windows found.", color: "gray" }];
  }

  return [
    {
      key: `${scope}-header`,
      text: `${pad("plan", LIMIT_WINDOW_COLUMNS.plan)} ${pad("window", LIMIT_WINDOW_COLUMNS.window)} ${pad("used", LIMIT_WINDOW_COLUMNS.used)} ${pad("start", LIMIT_WINDOW_COLUMNS.date)} ${pad("end", LIMIT_WINDOW_COLUMNS.date)} value`,
      color: "gray"
    },
    ...windows.map<ScrollableLine>((window) => {
      const lineKey = getLimitRowKey(window);
      const windowLabel = formatWindowMinutes(window.windowMinutes);
      const usedLabel = `${window.minUsedPercent}%->${window.maxUsedPercent}%`;
      const isSelected = selectedRowKey === lineKey;
      return {
        key: `limit-row:${lineKey}`,
        text: `${pad(window.planType, LIMIT_WINDOW_COLUMNS.plan)} ${pad(windowLabel, LIMIT_WINDOW_COLUMNS.window)} ${pad(usedLabel, LIMIT_WINDOW_COLUMNS.used)} ${pad(formatLocalDateTime(window.startTimeUtcIso), LIMIT_WINDOW_COLUMNS.date)} ${pad(formatLocalDateTime(window.endTimeUtcIso), LIMIT_WINDOW_COLUMNS.date)} ${pad(formatUsd(window.totals.estimatedCredits * CODEX_CREDIT_COST_USD), LIMIT_WINDOW_COLUMNS.value)}`,
        inverse: isSelected,
        color: isSelected ? "cyan" : undefined
      };
    })
  ];
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
        <UsageTotalsDetails totals={props.selectedModelRow.totals} modelId={props.selectedModelRow.modelId} />
      </Box>
    );
  }

  return null;
}

function UsageTotalsDetails(props: { totals: UsageTotals; modelId?: string }): React.JSX.Element {
  const { totals } = props;
  return (
    <Box flexDirection="column">
      <UsageBreakdownLines totals={totals} />
      <Text>Burned tokens for: {formatUsageUsd(totals, props.modelId)}</Text>
      <Text>IpO: {formatInputPerOutput(totals)}</Text>
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

function formatUsageCredits(totals: UsageTotals, modelId?: string): string {
  if (isInternalUsageModel(modelId)) {
    return "N/A";
  }

  return totals.estimatedCreditsStatus === "unavailable" ? "unknown" : formatCredits(totals.estimatedCredits);
}

function formatUsageUsd(totals: UsageTotals, modelId?: string): string {
  if (isInternalUsageModel(modelId)) {
    return "N/A";
  }

  return totals.estimatedCreditsStatus === "unavailable"
    ? "unknown"
    : formatUsd(totals.estimatedCredits * CODEX_CREDIT_COST_USD);
}

function isInternalUsageModel(modelId?: string): boolean {
  return modelId === "codex-auto-review" || modelId === "<synthetic>";
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

function UsageBreakdownLines(props: { totals: UsageTotals }): React.JSX.Element {
  const { totals } = props;
  if (totals.tokenBreakdown.schema === "anthropic") {
    return (
      <Box flexDirection="column">
        <Text>
          input total: {formatInteger(totals.inputTotalTokens)}  input: {formatInteger(totals.tokenBreakdown.inputTokens)}  cacheW5m: {formatInteger(totals.tokenBreakdown.cacheWrite5mInputTokens)}
        </Text>
        <Text>
          cacheW1h: {formatInteger(totals.tokenBreakdown.cacheWrite1hInputTokens)}  cacheRead: {formatInteger(totals.tokenBreakdown.cacheReadInputTokens)}  output: {formatInteger(totals.outputTokens)}  reasoning: {formatInteger(totals.reasoningOutputTokens)}  total: {formatInteger(totals.totalTokens)}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        input total: {formatInteger(totals.inputTotalTokens)}  uncached: {formatOpenAiTokens(totals, "non-cached")}  cached: {formatOpenAiTokens(totals, "cached")}
      </Text>
      <Text>
        output: {formatInteger(totals.outputTokens)}  reasoning: {formatInteger(totals.reasoningOutputTokens)}  total: {formatInteger(totals.totalTokens)}
      </Text>
    </Box>
  );
}

function formatOpenAiTokens(totals: UsageTotals, kind: "non-cached" | "cached"): string {
  if (totals.tokenBreakdown.schema !== "openai" || totals.cacheStatus === "unavailable") {
    return "unknown";
  }

  return formatInteger(kind === "non-cached" ? totals.tokenBreakdown.nonCachedInputTokens : totals.tokenBreakdown.cachedInputTokens);
}

function formatInputPerOutput(totals: UsageTotals): string {
  if (totals.outputTokens <= 0) {
    return totals.tokenBreakdown.schema === "anthropic" ? "input:cacheW5m:cacheW1h:cacheRead:output = 0:0:0:0:0" : "uncached:cached:output = 0:0:0";
  }

  if (totals.tokenBreakdown.schema === "anthropic") {
    return `input:cacheW5m:cacheW1h:cacheRead:output = ${formatInteger(Math.round(totals.tokenBreakdown.inputTokens / totals.outputTokens))}:${formatInteger(Math.round(totals.tokenBreakdown.cacheWrite5mInputTokens / totals.outputTokens))}:${formatInteger(Math.round(totals.tokenBreakdown.cacheWrite1hInputTokens / totals.outputTokens))}:${formatInteger(Math.round(totals.tokenBreakdown.cacheReadInputTokens / totals.outputTokens))}:1`;
  }

  if (totals.cacheStatus === "unavailable") {
    return "uncached:cached:output = unknown:unknown:1";
  }

  return `uncached:cached:output = ${formatInteger(Math.round(totals.tokenBreakdown.nonCachedInputTokens / totals.outputTokens))}:${formatInteger(Math.round(totals.tokenBreakdown.cachedInputTokens / totals.outputTokens))}:1`;
}

function useMeasuredElementSize(): {
  ref: React.MutableRefObject<any>;
  height: number;
  width: number;
} {
  const ref = useRef<any>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!ref.current) {
      return;
    }

    const nextSize = measureElement(ref.current);
    setSize((current) =>
      current.width === nextSize.width && current.height === nextSize.height ? current : nextSize
    );
  });

  return {
    ref,
    width: size.width,
    height: size.height
  };
}

function useAutoScrollOffset(selectedIndex: number, rowCount: number, viewportSize: number): number {
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    const maxOffset = Math.max(0, rowCount - Math.max(0, viewportSize));
    setScrollOffset((current) => {
      let next = Math.max(0, Math.min(current, maxOffset));
      if (selectedIndex < 0 || viewportSize <= 0) {
        return next;
      }

      if (selectedIndex < next) {
        next = selectedIndex;
      } else if (selectedIndex >= next + viewportSize) {
        next = selectedIndex - viewportSize + 1;
      }

      return Math.max(0, Math.min(next, maxOffset));
    });
  }, [rowCount, selectedIndex, viewportSize]);

  return scrollOffset;
}

function resolveScrollableViewportLayout(
  availableHeight: number,
  headerCount: number,
  bodyCount: number,
  footerCount: number
): { headerVisibleCount: number; bodyVisibleCount: number; footerVisibleCount: number } {
  const totalHeight = Math.max(1, availableHeight || 1);
  if (bodyCount === 0) {
    const headerVisibleCount = Math.min(headerCount, totalHeight);
    return {
      headerVisibleCount,
      bodyVisibleCount: 0,
      footerVisibleCount: Math.min(footerCount, Math.max(0, totalHeight - headerVisibleCount))
    };
  }

  let headerVisibleCount = Math.min(headerCount, totalHeight);
  let footerVisibleCount = Math.min(footerCount, Math.max(0, totalHeight - headerVisibleCount - 1));
  let bodyVisibleCount = Math.min(bodyCount, Math.max(0, totalHeight - headerVisibleCount - footerVisibleCount));

  if (bodyVisibleCount === 0 && footerVisibleCount > 0) {
    footerVisibleCount -= 1;
    bodyVisibleCount = Math.min(bodyCount, Math.max(0, totalHeight - headerVisibleCount - footerVisibleCount));
  }

  if (bodyVisibleCount === 0 && headerVisibleCount > 0) {
    headerVisibleCount -= 1;
    bodyVisibleCount = Math.min(bodyCount, Math.max(0, totalHeight - headerVisibleCount - footerVisibleCount));
  }

  if (bodyVisibleCount === 0) {
    return {
      headerVisibleCount: 0,
      bodyVisibleCount: Math.min(bodyCount, totalHeight),
      footerVisibleCount: 0
    };
  }

  return { headerVisibleCount, bodyVisibleCount, footerVisibleCount };
}

function buildScrollbarLines(viewportSize: number, rowCount: number, scrollOffset: number): string[] {
  if (viewportSize <= 0 || rowCount <= viewportSize) {
    return [];
  }

  const thumbSize = Math.max(1, Math.round((viewportSize * viewportSize) / rowCount));
  const maxThumbOffset = Math.max(0, viewportSize - thumbSize);
  const maxScrollOffset = Math.max(1, rowCount - viewportSize);
  const thumbOffset = Math.round((Math.max(0, Math.min(scrollOffset, maxScrollOffset)) / maxScrollOffset) * maxThumbOffset);

  return Array.from({ length: viewportSize }, (_, index) =>
    index >= thumbOffset && index < thumbOffset + thumbSize ? SCROLLBAR_THUMB_GLYPH : SCROLLBAR_TRACK_GLYPH
  );
}

function clampSelectionIndex(value: number, rowCount: number): number {
  if (rowCount === 0) {
    return -1;
  }

  return Math.max(0, Math.min(value, rowCount - 1));
}

function sortProviderStatesByUsage(states: ProviderLoadState[]): ProviderLoadState[] {
  return states
    .map((state, index) => ({ state, index }))
    .sort(
      (left, right) =>
        providerUsageScore(right.state) - providerUsageScore(left.state) ||
        left.index - right.index
    )
    .map((entry) => entry.state);
}

function providerUsageScore(state: ProviderLoadState): number {
  if (state.status !== "ready") {
    return 0;
  }

  const totals = state.stats.summary.totals;
  return totals.inputTotalTokens + totals.outputTokens;
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

function useViewportHeight(): number {
  const { stdout } = useStdout();
  const [viewportHeight, setViewportHeight] = useState(() => resolveViewportHeight(stdout.rows));

  useEffect(() => {
    const updateViewportHeight = () => {
      setViewportHeight(resolveViewportHeight(stdout.rows));
    };

    updateViewportHeight();
    if (!stdout.isTTY) {
      return;
    }

    stdout.on("resize", updateViewportHeight);
    return () => {
      stdout.off("resize", updateViewportHeight);
    };
  }, [stdout]);

  return viewportHeight;
}

function resolveViewportHeight(rows: number | undefined): number {
  const terminalRows = typeof rows === "number" && rows > 0 ? rows : 24;
  // Keep Ink below the terminal height so it stays on its incremental redraw path
  // instead of the full-screen print path that can leave the viewport scrolled.
  return Math.max(1, terminalRows - 1);
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const restoreFullscreen = enterFullscreenMode(process.stdout);
  const exitHandler = () => {
    restoreFullscreen();
  };
  process.once("exit", exitHandler);

  const instance = render(<App statsOptions={parseStatsOptions(argv)} />, {
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr
  });

  void instance.waitUntilExit().finally(() => {
    process.off("exit", exitHandler);
    instance.cleanup();
    restoreFullscreen();
  });
}

function enterFullscreenMode(stdout: NodeJS.WriteStream): () => void {
  if (!stdout.isTTY) {
    return () => {};
  }

  let restored = false;
  stdout.write(ENTER_FULLSCREEN_MODE);

  return () => {
    if (restored) {
      return;
    }

    restored = true;
    stdout.write(EXIT_FULLSCREEN_MODE);
  };
}

main();
