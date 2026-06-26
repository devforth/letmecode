import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, measureElement, useApp, useInput, useStdin, useStdout, render, type DOMElement } from "ink";
import { buildHelpText, buildProviderStatsOptions, parseCliOptions } from "./cli-options.js";
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
import { reportAnonymousUsage } from "./reporting.js";

type DetailTabId = "limit-windows" | "summary" | "day-to-day-analyses" | "usage-by-model";

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

type MouseClick = { column: number; row: number };

type Rect = { left: number; top: number; width: number; height: number };

const ESC = String.fromCharCode(0x1b);
// Normal mouse tracking (button press/release only) + SGR extended coordinates.
// This makes the tabs clickable while leaving Shift+drag native text selection
// available everywhere else, exactly like Midnight Commander.
const ENABLE_MOUSE_TRACKING = `${ESC}[?1000h${ESC}[?1006h`;
const DISABLE_MOUSE_TRACKING = `${ESC}[?1006l${ESC}[?1000l`;
// SGR mouse report: ESC [ < button ; column ; row, ending in M (press) or m (release).
const SGR_MOUSE_SEQUENCE = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g");

const DETAIL_TABS: Array<{ id: DetailTabId; label: string }> = [
  { id: "limit-windows", label: "Limits" },
  { id: "summary", label: "Summary" },
  { id: "day-to-day-analyses", label: "Daily" },
  { id: "usage-by-model", label: "Models" }
];

const CODEX_CREDIT_COST_USD = 0.01;

const LIMIT_TABLE_COLUMNS = [
  { header: "Plan", width: 5 },
  { header: "Window", width: 6 },
  { header: "Used", width: 8 },
  { header: "Start", width: 14 },
  { header: "End", width: 14 },
  { header: "API eq.", width: 8 }
] as const;

const DAILY_TABLE_COLUMNS = [
  { header: "Day", width: 9 },
  { header: "Ev", width: 5 },
  { header: "Input", width: 8 },
  { header: "Output", width: 7 },
  { header: "C read", width: 8 },
  { header: "C write", width: 7 },
  { header: "API eq.", width: 7 }
] as const;

const MODEL_TABLE_COLUMNS = [
  { header: "Model", width: 16 },
  { header: "Input", width: 7 },
  { header: "Output", width: 7 },
  { header: "C read", width: 7 },
  { header: "C write", width: 7 },
  { header: "API eq.", width: 7 }
] as const;

type TextTableColumn = {
  header: string;
  width: number;
};

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
  const { getRegionRef, resolveClick } = useClickRegions();
  const providers = React.useState(() => createProviders())[0];
  const [providerStates, setProviderStates] = useState<ProviderLoadState[]>(
    providers.map((provider) => ({ provider, status: "loading" }))
  );
  const [selectedProviderId, setSelectedProviderId] = useState(providers[0]?.id ?? "");
  const [hasUserSelectedProvider, setHasUserSelectedProvider] = useState(false);
  const [selectedDetailTabIndex, setSelectedDetailTabIndex] = useState(0);
  const [selectedLimitRowIndex, setSelectedLimitRowIndex] = useState(0);
  const [selectedDayRowIndex, setSelectedDayRowIndex] = useState(0);
  const [selectedModelRowIndex, setSelectedModelRowIndex] = useState(0);
  const [selectedCopilotActionIndex, setSelectedCopilotActionIndex] = useState(0);
  const [copilotActionMessage, setCopilotActionMessage] = useState<string | undefined>();
  const hasReportedAnonymousUsageRef = useRef(false);

  const sortedProviderStates = React.useMemo(() => sortProviderStatesByUsage(providerStates), [providerStates]);
  const selectedProviderIndex = Math.max(
    0,
    sortedProviderStates.findIndex((state) => state.provider.id === selectedProviderId)
  );
  const selectedProvider = sortedProviderStates[selectedProviderIndex];
  const selectedDetailTab = DETAIL_TABS[selectedDetailTabIndex];
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

  useEffect(() => {
    if (hasReportedAnonymousUsageRef.current || providerStates.some((state) => state.status === "loading")) {
      return;
    }

    hasReportedAnonymousUsageRef.current = true;
    const readyStats = providerStates
      .filter((state): state is Extract<ProviderLoadState, { status: "ready" }> => state.status === "ready")
      .map((state) => state.stats);

    void reportAnonymousUsage(readyStats).catch(() => {
      // Anonymous usage reporting is best-effort and must never disturb the TUI.
    });
  }, [providerStates]);

  useMouseClick((click) => {
    const regionId = resolveClick(click);
    if (!regionId) {
      return;
    }

    if (regionId.startsWith("provider:")) {
      setSelectedProviderId(regionId.slice("provider:".length));
      setHasUserSelectedProvider(true);
      return;
    }

    if (regionId.startsWith("vtab:")) {
      setSelectedDetailTabIndex(Number(regionId.slice("vtab:".length)));
    }
  });

  const moveSelectedTableRow = useCallback((delta: number) => {
    if (selectedDetailTab.id === "limit-windows") {
      setSelectedLimitRowIndex(clampSelectionIndex(activeLimitRowIndex + delta, limitRows.length));
      return;
    }

    if (selectedDetailTab.id === "usage-by-model") {
      setSelectedModelRowIndex(clampSelectionIndex(activeModelRowIndex + delta, modelRows.length));
      return;
    }

    if (selectedDetailTab.id === "day-to-day-analyses") {
      setSelectedDayRowIndex(clampSelectionIndex(activeDayRowIndex + delta, dayRows.length));
    }
  }, [
    activeDayRowIndex,
    activeLimitRowIndex,
    activeModelRowIndex,
    dayRows.length,
    limitRows.length,
    modelRows.length,
    selectedDetailTab.id
  ]);

  useInput((input, key) => {
    // Mouse reports arrive as SGR escape sequences and are handled by useMouseClick.
    // Ink strips the leading ESC, leaving e.g. "[<0;10;5M" — never treat that as a key.
    if (input.startsWith("[<")) {
      return;
    }

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
      setSelectedDetailTabIndex((current) => (current + 1) % DETAIL_TABS.length);
      return;
    }

    if (key.leftArrow) {
      setSelectedDetailTabIndex((current) => (current - 1 + DETAIL_TABS.length) % DETAIL_TABS.length);
      return;
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
      moveSelectedTableRow(1);
      return;
    }

    if (key.upArrow || input === "k") {
      moveSelectedTableRow(-1);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} height={viewportHeight} overflow="hidden">
      <Text bold color="cyan">
        letmecode usage dashboard
      </Text>
      <Box marginTop={1}>
        <Text color="gray">Provider  </Text>
        {sortedProviderStates.map((state) => (
          <ProviderTab
            key={state.provider.id}
            label={state.provider.label}
            active={state.provider.id === selectedProvider.provider.id}
            status={state.status}
            regionRef={getRegionRef(`provider:${state.provider.id}`)}
          />
        ))}
      </Box>
      <Box>
        <Text color="gray">View      </Text>
        {DETAIL_TABS.map((tab, index) => (
          <DetailTab
            key={tab.id}
            label={tab.label}
            active={index === selectedDetailTabIndex}
            regionRef={getRegionRef(`vtab:${index}`)}
          />
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column" flexGrow={1} overflow="hidden">
        <Box flexGrow={1} overflow="hidden">
          <Box ref={contentPanelRef} flexDirection="column" flexGrow={1} overflow="hidden">
            <ContentPanel
              providerState={selectedProvider}
              tabId={selectedDetailTab.id}
              selectedLimitRowKey={selectedLimitRow ? getLimitRowKey(selectedLimitRow) : undefined}
              selectedDayKey={selectedDayRow?.dayKey}
              selectedModelId={selectedModelRow?.modelId}
              availableHeight={contentPanelHeight}
            />
          </Box>
        </Box>

        <SelectionDetailsPanel
          providerState={selectedProvider}
          tabId={selectedDetailTab.id}
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
      <Text color="gray">
        Tab provider · ←/→ view · ↑/↓ row · q quit
      </Text>
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

function ProviderTab(props: {
  label: string;
  active: boolean;
  status: ProviderLoadState["status"];
  regionRef?: (node: DOMElement | null) => void;
}): React.JSX.Element {
  const statusColor = props.status === "error" ? "red" : props.status === "loading" ? "yellow" : "green";
  const tabLabel = props.active ? `[${props.label}]` : ` ${props.label} `;
  return (
    <Box marginRight={2} ref={props.regionRef}>
      <Text color={statusColor} bold={props.active}>
        {tabLabel}
      </Text>
    </Box>
  );
}

function DetailTab(props: {
  label: string;
  active: boolean;
  regionRef?: (node: DOMElement | null) => void;
}): React.JSX.Element {
  const tabLabel = props.active ? `[${props.label}]` : ` ${props.label} `;

  return (
    <Box marginRight={2} ref={props.regionRef}>
      <Text wrap="truncate-end" bold={props.active}>
        {tabLabel}
      </Text>
    </Box>
  );
}

function SummaryPanel(props: { stats: ProviderStats }): React.JSX.Element {
  const { summary } = props.stats;
  const totals = summary.totals;
  const period = resolveSummaryPeriod(props.stats.dayUsage);
  const cacheRatio = resolveCacheRatio(totals);
  const averageTokensPerEvent =
    totals.eventCount > 0 ? totals.totalTokens / totals.eventCount : 0;
  const costPerEvent =
    totals.eventCount > 0
      ? (totals.estimatedCredits * CODEX_CREDIT_COST_USD) / totals.eventCount
      : 0;

  return (
    <Box flexDirection="column">
      <Text bold>{props.stats.providerLabel} overview</Text>
      <Text> </Text>
      <Box>
        <Box flexDirection="column" width={45}>
          <DetailRow label="Plan" value={summary.distinctPlanTypes.join(", ") || "none"} />
          <DetailRow label="Models" value={summary.distinctModels.join(", ") || "none"} />
          <DetailRow label="Period" value={period} />
          <Text> </Text>
          <Text color="cyan">Usage</Text>
          <DetailRow label="Events" value={formatInteger(totals.eventCount)} />
          <DetailRow label="Input" value={formatOverviewTokenCount(totals.inputTokens)} />
          <DetailRow label="Output" value={formatOverviewTokenCount(totals.outputTokens)} />
          <DetailRow label="Cache read" value={formatCacheOverviewTokenCount(totals, totals.cacheReadInputTokens)} />
          <DetailRow label="Reasoning" value={formatOverviewTokenCount(totals.reasoningOutputTokens)} />
          <DetailRow label="Total" value={formatOverviewTokenCount(totals.totalTokens)} />
          <DetailRow label="API equiv." value={formatUsageUsd(totals)} />
        </Box>
        <Box flexDirection="column">
          <Text color="cyan">Efficiency</Text>
          <DetailRow label="Cache ratio" value={formatPercent(cacheRatio)} />
          <DetailRow label="Input/output" value={formatInputOutputRatio(totals)} />
          <DetailRow label="Avg/event" value={`${formatOverviewTokenCount(averageTokensPerEvent)} tokens`} />
          <DetailRow label="Cost/event" value={formatUnitUsd(costPerEvent)} />
          <Text> </Text>
          <Text color="cyan">Data source</Text>
          <DetailRow label="Files" value={formatInteger(summary.filesScanned)} />
          <DetailRow label="Lines" value={formatInteger(summary.linesRead)} />
          <DetailRow label="Path" value={summary.rootPath} />
        </Box>
      </Box>
    </Box>
  );
}

function ContentPanel(props: {
  providerState: ProviderLoadState;
  tabId: DetailTabId;
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
    ...buildLimitWindowTableLines("primary", "Primary limits", props.stats.primaryLimitWindows, props.selectedRowKey),
    { key: "section-gap", text: "" },
    ...buildLimitWindowTableLines("secondary", "Secondary limits", props.stats.secondaryLimitWindows, props.selectedRowKey)
  ];

  return (
    <ScrollableLineViewport
      bodyLines={bodyLines}
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
  const bodyLines = buildModelUsageTableLines(
    props.stats.modelUsage,
    totals,
    props.selectedModelId
  );
  return (
    <ScrollableLineViewport
      bodyLines={bodyLines}
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

  const bodyLines = buildDailyUsageTableLines(props.stats.dayUsage, props.selectedDayKey);
  return (
    <ScrollableLineViewport
      bodyLines={bodyLines}
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

function buildTableBorder(
  columns: readonly TextTableColumn[],
  left: string,
  middle: string,
  right: string
): string {
  return `${left}${columns.map((column) => "─".repeat(column.width + 2)).join(middle)}${right}`;
}

function buildTableRow(
  columns: readonly TextTableColumn[],
  cells: string[]
): string {
  return `│${columns.map((column, index) => ` ${pad(cells[index] ?? "", column.width)} `).join("│")}│`;
}

function buildLimitWindowTableLines(
  scope: "primary" | "secondary",
  title: string,
  windows: LimitWindowRow[],
  selectedRowKey?: string
): ScrollableLine[] {
  if (windows.length === 0) {
    return [
      { key: `${scope}-title`, text: title, bold: true },
      { key: `${scope}-empty`, text: "No windows found.", color: "gray" }
    ];
  }

  return [
    { key: `${scope}-title`, text: title, bold: true },
    {
      key: `${scope}-top-border`,
      text: buildTableBorder(LIMIT_TABLE_COLUMNS, "┌", "┬", "┐"),
      color: "gray"
    },
    {
      key: `${scope}-header`,
      text: buildTableRow(LIMIT_TABLE_COLUMNS, LIMIT_TABLE_COLUMNS.map((column) => column.header)),
      color: "gray"
    },
    {
      key: `${scope}-header-border`,
      text: buildTableBorder(LIMIT_TABLE_COLUMNS, "├", "┼", "┤"),
      color: "gray"
    },
    ...windows.map<ScrollableLine>((window) => {
      const lineKey = getLimitRowKey(window);
      const windowLabel = formatCompactWindowMinutes(window.windowMinutes);
      const usedLabel = formatUsedPercentRange(window.minUsedPercent, window.maxUsedPercent);
      const isSelected = selectedRowKey === lineKey;
      return {
        key: `limit-row:${lineKey}`,
        text: buildTableRow(LIMIT_TABLE_COLUMNS, [
          window.planType,
          windowLabel,
          usedLabel,
          formatCompactLocalDateTime(window.startTimeUtcIso),
          formatCompactLocalDateTime(window.endTimeUtcIso),
          formatUsd(window.totals.estimatedCredits * CODEX_CREDIT_COST_USD)
        ]),
        inverse: isSelected,
        color: isSelected ? "cyan" : undefined
      };
    }),
    {
      key: `${scope}-bottom-border`,
      text: buildTableBorder(LIMIT_TABLE_COLUMNS, "└", "┴", "┘"),
      color: "gray"
    }
  ];
}

function buildDailyUsageTableLines(
  rows: DailyUsageRow[],
  selectedDayKey?: string
): ScrollableLine[] {
  return [
    { key: "daily-title", text: "Daily usage", bold: true },
    {
      key: "daily-top-border",
      text: buildTableBorder(DAILY_TABLE_COLUMNS, "┌", "┬", "┐"),
      color: "gray"
    },
    {
      key: "daily-header",
      text: buildTableRow(DAILY_TABLE_COLUMNS, DAILY_TABLE_COLUMNS.map((column) => column.header)),
      color: "gray"
    },
    {
      key: "daily-header-border",
      text: buildTableBorder(DAILY_TABLE_COLUMNS, "├", "┼", "┤"),
      color: "gray"
    },
    ...rows.map<ScrollableLine>((row) => {
      const isSelected = selectedDayKey === row.dayKey;
      return {
        key: `day-row:${row.dayKey}`,
        text: buildTableRow(DAILY_TABLE_COLUMNS, [
          formatUtcDay(row.dayKey),
          formatCompactTokenCount(row.totals.eventCount),
          formatCompactTokenCount(row.totals.inputTokens),
          formatCompactTokenCount(row.totals.outputTokens),
          formatCompactCacheTokens(row.totals, row.totals.cacheReadInputTokens),
          formatCompactCacheTokens(row.totals, row.totals.cacheWriteInputTokens),
          formatUsageUsd(row.totals)
        ]),
        inverse: isSelected,
        color: isSelected ? "cyan" : undefined
      };
    }),
    {
      key: "daily-bottom-border",
      text: buildTableBorder(DAILY_TABLE_COLUMNS, "└", "┴", "┘"),
      color: "gray"
    }
  ];
}

function buildModelUsageTableLines(
  rows: ModelUsageRow[],
  totals: UsageTotals,
  selectedModelId?: string
): ScrollableLine[] {
  return [
    { key: "model-title", text: "Model usage", bold: true },
    {
      key: "model-top-border",
      text: buildTableBorder(MODEL_TABLE_COLUMNS, "┌", "┬", "┐"),
      color: "gray"
    },
    {
      key: "model-header",
      text: buildTableRow(MODEL_TABLE_COLUMNS, MODEL_TABLE_COLUMNS.map((column) => column.header)),
      color: "gray"
    },
    {
      key: "model-header-border",
      text: buildTableBorder(MODEL_TABLE_COLUMNS, "├", "┼", "┤"),
      color: "gray"
    },
    ...rows.map<ScrollableLine>((row) => {
      const isSelected = selectedModelId === row.modelId;
      return {
        key: `model-row:${row.modelId}`,
        text: formatModelUsageTableRow(row.modelId, row.totals),
        inverse: isSelected,
        color: isSelected ? "cyan" : undefined
      };
    }),
    {
      key: "model-total-border",
      text: buildTableBorder(MODEL_TABLE_COLUMNS, "├", "┼", "┤"),
      color: "gray"
    },
    {
      key: "model-total",
      text: formatModelUsageTableRow("TOTAL", totals),
      color: "cyan"
    },
    {
      key: "model-bottom-border",
      text: buildTableBorder(MODEL_TABLE_COLUMNS, "└", "┴", "┘"),
      color: "gray"
    }
  ];
}

function SelectionDetailsPanel(props: {
  providerState: ProviderLoadState;
  tabId: DetailTabId;
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
      <DetailsPanelFrame>
        <Box>
          <Box flexDirection="column" width={25}>
            <DetailRow label="Plan" value={row.planType} />
            <DetailRow label="Window" value={formatCompactWindowMinutes(row.windowMinutes)} />
            <DetailRow label="Usage" value={formatUsedPercentRange(row.minUsedPercent, row.maxUsedPercent)} />
            <DetailRow label="Events" value={formatInteger(row.eventCount)} />
            <DetailRow label="API eq." value={formatUsageUsd(row.totals)} />
          </Box>
          <Box flexDirection="column">
            <DetailRow
              label="Period"
              value={`${formatCompactLocalDateTime(row.startTimeUtcIso)} → ${formatCompactLocalDateTime(row.endTimeUtcIso)}`}
            />
            <DetailRow label="Input" value={formatInteger(row.totals.inputTokens)} />
            <DetailRow label="Cache read" value={formatCacheTokens(row.totals, row.totals.cacheReadInputTokens)} />
            <DetailRow label="Cache write" value={formatCacheTokens(row.totals, row.totals.cacheWriteInputTokens)} />
            <DetailRow label="Output" value={formatInteger(row.totals.outputTokens)} />
            <DetailRow label="Total" value={formatInteger(row.totals.totalTokens)} />
          </Box>
        </Box>
      </DetailsPanelFrame>
    );
  }

  if (props.tabId === "day-to-day-analyses" && props.selectedDayRow) {
    const row = props.selectedDayRow;
    return (
      <DetailsPanelFrame>
        <Text>
          day: {formatUtcDay(row.dayKey)}  events: {formatInteger(row.totals.eventCount)}  models: {formatInteger(row.distinctModels.length)}  plans: {formatInteger(row.distinctPlanTypes.length)}
        </Text>
        <Text>range: {formatEventRange(row.firstEventUtcIso, row.lastEventUtcIso)}</Text>
        <Text>models: {row.distinctModels.join(", ") || "none"}</Text>
        <Text>plans: {row.distinctPlanTypes.join(", ") || "none"}</Text>
        <UsageTotalsDetails totals={row.totals} />
      </DetailsPanelFrame>
    );
  }

  if (props.tabId === "usage-by-model" && props.selectedModelRow) {
    return (
      <DetailsPanelFrame>
        <Text>
          model: {props.selectedModelRow.modelId}  events: {formatInteger(props.selectedModelRow.totals.eventCount)}
        </Text>
        <UsageTotalsDetails totals={props.selectedModelRow.totals} modelId={props.selectedModelRow.modelId} />
      </DetailsPanelFrame>
    );
  }

  return null;
}

function DetailsPanelFrame(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
      <Text color="cyan">Details</Text>
      {props.children}
    </Box>
  );
}

function DetailRow(props: { label: string; value: string }): React.JSX.Element {
  return (
    <Text>
      {pad(props.label, 14)}
      {props.value}
    </Text>
  );
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

function formatOverviewTokenCount(value: number): string {
  const roundedValue = Math.round(value);
  if (roundedValue >= 1_000_000_000) {
    return `${formatFixedCompactNumber(roundedValue / 1_000_000_000)}B`;
  }
  if (roundedValue >= 1_000_000) {
    return `${formatFixedCompactNumber(roundedValue / 1_000_000)}M`;
  }
  if (roundedValue >= 1_000) {
    return `${formatFixedCompactNumber(roundedValue / 1_000)}K`;
  }

  return formatInteger(roundedValue);
}

function formatCacheOverviewTokenCount(totals: UsageTotals, value: number): string {
  return totals.cacheStatus === "unavailable" ? "-" : formatOverviewTokenCount(value);
}

function formatFixedCompactNumber(value: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
    minimumFractionDigits: 0
  });
}

function formatCompactTokenCount(value: number): string {
  const roundedValue = Math.round(value);
  if (roundedValue < 1_000) {
    return formatInteger(roundedValue);
  }

  if (roundedValue < 100_000) {
    return `${formatCompactNumber(roundedValue / 1_000)}K`;
  }

  if (roundedValue < 1_000_000) {
    return `${formatInteger(Math.round(roundedValue / 1_000))}K`;
  }

  return `${formatCompactNumber(roundedValue / 1_000_000)}M`;
}

function formatCompactNumber(value: number): string {
  const maximumFractionDigits = value < 10 ? 2 : value < 100 ? 1 : 0;
  return value.toLocaleString("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0
  });
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

  return totals.estimatedCreditsStatus === "unavailable" ? "-" : formatCredits(totals.estimatedCredits);
}

function formatUsageUsd(totals: UsageTotals, modelId?: string): string {
  if (isInternalUsageModel(modelId)) {
    return "N/A";
  }

  return totals.estimatedCreditsStatus === "unavailable"
    ? "-"
    : formatUsd(totals.estimatedCredits * CODEX_CREDIT_COST_USD);
}

function isInternalUsageModel(modelId?: string): boolean {
  return modelId === "codex-auto-review" || modelId === "<synthetic>";
}

function formatUsd(value: number): string {
  const roundedUpValue = value > 0 ? Math.ceil(value * 100) / 100 : value;

  return roundedUpValue.toLocaleString("en-US", {
    currency: "USD",
    style: "currency",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatUnitUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return value.toLocaleString("en-US", {
    currency: "USD",
    style: "currency",
    minimumFractionDigits: value < 0.01 && value > 0 ? 4 : 3,
    maximumFractionDigits: value < 0.01 && value > 0 ? 4 : 3
  });
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return `${value.toLocaleString("en-US", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0
  })}%`;
}

function resolveCacheRatio(totals: UsageTotals): number {
  if (totals.cacheStatus === "unavailable") {
    return NaN;
  }

  const inputPool =
    totals.inputTokens +
    totals.cacheReadInputTokens +
    totals.cacheWriteInputTokens;

  return inputPool > 0
    ? (totals.cacheReadInputTokens / inputPool) * 100
    : 0;
}

function formatInputOutputRatio(totals: UsageTotals): string {
  if (totals.outputTokens <= 0) {
    return "-";
  }

  return `${(totals.inputTokens / totals.outputTokens).toLocaleString("en-US", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0
  })} : 1`;
}

function formatUsedPercentRange(minUsedPercent: number, maxUsedPercent: number): string {
  const fmt = (v: number) => `${Math.round(v)}%`;
  return minUsedPercent === maxUsedPercent
    ? fmt(minUsedPercent)
    : `${fmt(minUsedPercent)}–${fmt(maxUsedPercent)}`;
}

function formatWindowMinutes(value: number): string {
  const hours = value / 60;
  if (hours >= 24) {
    return `${(hours / 24).toFixed(2)}d`;
  }

  return `${hours.toFixed(2)}h`;
}

function formatCompactWindowMinutes(value: number): string {
  const hours = value / 60;
  if (hours >= 24) {
    return `${formatCompactNumber(hours / 24)}d`;
  }

  return `${formatCompactNumber(hours)}h`;
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

function formatCompactLocalDateTime(value: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(new Date(value));

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.day} ${lookup.month} ${lookup.hour}:${lookup.minute}`;
}

function resolveSummaryPeriod(dayUsage: DailyUsageRow[]): string {
  const timestamps = dayUsage.flatMap((row) => [
    row.firstEventUtcIso,
    row.lastEventUtcIso
  ]).filter((value): value is string => Boolean(value));

  if (timestamps.length === 0) {
    return "-";
  }

  const sortedTimestamps = timestamps.sort();
  return `${formatCompactLocalDateTime(sortedTimestamps[0])} → ${formatCompactLocalDateTime(sortedTimestamps[sortedTimestamps.length - 1])}`;
}

function formatUtcDay(value: string): string {
  if (value === "unknown") {
    return "-";
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
    return "-";
  }

  return `${formatLocalDateTime(firstEventUtcIso)} -> ${formatLocalDateTime(lastEventUtcIso)}`;
}

function pad(value: string, length: number): string {
  return value.length >= length ? value.slice(0, length) : value.padEnd(length);
}

function formatModelUsageTableRow(modelId: string, totals: UsageTotals): string {
  const displayModelId = modelId === "unknown" ? "-" : modelId;
  return buildTableRow(MODEL_TABLE_COLUMNS, [
    displayModelId,
    formatCompactTokenCount(totals.inputTokens),
    formatCompactTokenCount(totals.outputTokens),
    formatCompactCacheTokens(totals, totals.cacheReadInputTokens),
    formatCompactCacheTokens(totals, totals.cacheWriteInputTokens),
    formatUsageUsd(totals, modelId)
  ]);
}

function UsageBreakdownLines(props: { totals: UsageTotals }): React.JSX.Element {
  const { totals } = props;

  return (
    <Box flexDirection="column">
      <Text>
        input: {formatInteger(totals.inputTokens)}  output: {formatInteger(totals.outputTokens)}  cacheRead: {formatCacheTokens(totals, totals.cacheReadInputTokens)}
      </Text>
      <Text>
        cacheWrite: {formatCacheTokens(totals, totals.cacheWriteInputTokens)}  cacheW5m: {formatOptionalTokens(totals.cacheWrite5mInputTokens)}  cacheW1h: {formatOptionalTokens(totals.cacheWrite1hInputTokens)}  reasoning: {formatInteger(totals.reasoningOutputTokens)}  total: {formatInteger(totals.totalTokens)}
      </Text>
    </Box>
  );
}

function formatCacheTokens(totals: UsageTotals, value: number): string {
  if (totals.cacheStatus === "unavailable") {
    return "-";
  }

  return formatOptionalTokens(value);
}

function formatCompactCacheTokens(totals: UsageTotals, value: number): string {
  if (totals.cacheStatus === "unavailable") {
    return "-";
  }

  return formatOptionalCompactTokens(value);
}

function formatOptionalTokens(value: number): string {
  return value > 0 ? formatInteger(value) : "-";
}

function formatOptionalCompactTokens(value: number): string {
  return value > 0 ? formatCompactTokenCount(value) : "-";
}

function formatInputPerOutput(totals: UsageTotals): string {
  if (totals.outputTokens <= 0) {
    return "input:cacheRead:cacheWrite:output = 0:0:0:0";
  }

  if (totals.cacheStatus === "unavailable") {
    return `input:cacheRead:cacheWrite:output = ${formatInteger(Math.round(totals.inputTokens / totals.outputTokens))}:-:-:1`;
  }

  return `input:cacheRead:cacheWrite:output = ${formatInteger(Math.round(totals.inputTokens / totals.outputTokens))}:${formatInteger(Math.round(totals.cacheReadInputTokens / totals.outputTokens))}:${formatInteger(Math.round(totals.cacheWriteInputTokens / totals.outputTokens))}:1`;
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

// Walks the Yoga layout tree to get a node's absolute position/size (in terminal
// cells). Reading it live at click time keeps hit-testing correct across resizes,
// wrapping, and re-layouts without tracking coordinates by hand.
function getAbsoluteRect(node: DOMElement | undefined): Rect | undefined {
  const yogaNode = node?.yogaNode;
  if (!node || !yogaNode) {
    return undefined;
  }

  let left = 0;
  let top = 0;
  let current: DOMElement | undefined = node;
  while (current?.yogaNode) {
    left += current.yogaNode.getComputedLeft();
    top += current.yogaNode.getComputedTop();
    current = current.parentNode;
  }

  return {
    left,
    top,
    width: yogaNode.getComputedWidth(),
    height: yogaNode.getComputedHeight()
  };
}

function parseMouseClicks(chunk: string): MouseClick[] {
  const clicks: MouseClick[] = [];
  for (const match of chunk.matchAll(SGR_MOUSE_SEQUENCE)) {
    const buttonCode = Number(match[1]);
    const isPress = match[4] === "M";
    // Only react to a plain left-button press (button 0, no modifier bits). Any
    // press carrying Shift/Ctrl/Alt or motion/wheel bits is left alone so the
    // terminal can still use it for native text selection.
    if (!isPress || buttonCode !== 0) {
      continue;
    }

    clicks.push({ column: Number(match[2]), row: Number(match[3]) });
  }

  return clicks;
}

// Tracks the on-screen rectangle of named clickable regions (the tabs) via Ink
// refs and resolves a click coordinate back to a region id.
function useClickRegions(): {
  getRegionRef: (id: string) => (node: DOMElement | null) => void;
  resolveClick: (click: MouseClick) => string | undefined;
} {
  const nodesRef = useRef(new Map<string, DOMElement>());
  const refCallbacksRef = useRef(new Map<string, (node: DOMElement | null) => void>());

  const getRegionRef = useCallback((id: string) => {
    const cached = refCallbacksRef.current.get(id);
    if (cached) {
      return cached;
    }

    const callback = (node: DOMElement | null) => {
      if (node) {
        nodesRef.current.set(id, node);
      } else {
        nodesRef.current.delete(id);
      }
    };

    refCallbacksRef.current.set(id, callback);
    return callback;
  }, []);

  const resolveClick = useCallback((click: MouseClick) => {
    // SGR mouse coordinates are 1-based; Ink layout coordinates are 0-based.
    const column = click.column - 1;
    const row = click.row - 1;
    for (const [id, node] of nodesRef.current) {
      const rect = getAbsoluteRect(node);
      if (
        rect &&
        column >= rect.left &&
        column < rect.left + rect.width &&
        row >= rect.top &&
        row < rect.top + rect.height
      ) {
        return id;
      }
    }

    return undefined;
  }, []);

  return { getRegionRef, resolveClick };
}

// Parses left-clicks out of Ink's raw input stream and forwards them to onClick.
// Keyboard handling stays in useInput; this only consumes mouse reports.
function useMouseClick(onClick: (click: MouseClick) => void): void {
  const { internal_eventEmitter } = useStdin();
  const handlerRef = useRef(onClick);
  handlerRef.current = onClick;

  useEffect(() => {
    const handleInput = (chunk: string) => {
      for (const click of parseMouseClicks(chunk)) {
        handlerRef.current(click);
      }
    };

    internal_eventEmitter.on("input", handleInput);
    return () => {
      internal_eventEmitter.off("input", handleInput);
    };
  }, [internal_eventEmitter]);
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
  return totals.inputTokens + totals.outputTokens + totals.cacheReadInputTokens + totals.cacheWriteInputTokens;
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
  const cliOptions = parseCliOptions(argv);
  if (cliOptions.showHelp) {
    process.stdout.write(`${buildHelpText()}\n`);
    return;
  }

  const statsOptions: ProviderStatsOptions = buildProviderStatsOptions(cliOptions);
  const restoreFullscreen = enterFullscreenMode(process.stdout);
  const disableMouse = enableMouseReporting(process.stdout);
  const exitHandler = () => {
    disableMouse();
    restoreFullscreen();
  };
  process.once("exit", exitHandler);

  const instance = render(<App statsOptions={statsOptions} />, {
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr
  });

  void instance.waitUntilExit().finally(() => {
    process.off("exit", exitHandler);
    instance.cleanup();
    disableMouse();
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

function enableMouseReporting(stdout: NodeJS.WriteStream): () => void {
  if (!stdout.isTTY) {
    return () => {};
  }

  let disabled = false;
  stdout.write(ENABLE_MOUSE_TRACKING);

  return () => {
    if (disabled) {
      return;
    }

    disabled = true;
    stdout.write(DISABLE_MOUSE_TRACKING);
  };
}

main();
