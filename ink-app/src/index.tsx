import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import { createProviders, type LimitWindowRow, type ProviderStats, type UsageProviderBase } from "./providers/index.js";

type VerticalTabId = "limit-windows" | "usage-by-model";

type ProviderLoadState =
  | { provider: UsageProviderBase; status: "loading" }
  | { provider: UsageProviderBase; status: "ready"; stats: ProviderStats }
  | { provider: UsageProviderBase; status: "error"; errorMessage: string };

const VERTICAL_TABS: Array<{ id: VerticalTabId; label: string }> = [
  { id: "limit-windows", label: "Limit windows" },
  { id: "usage-by-model", label: "Usage by model" }
];

function App(): React.JSX.Element {
  const { exit } = useApp();
  const providers = React.useState(() => createProviders())[0];
  const [providerStates, setProviderStates] = useState<ProviderLoadState[]>(
    providers.map((provider) => ({ provider, status: "loading" }))
  );
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(0);
  const [selectedVerticalTabIndex, setSelectedVerticalTabIndex] = useState(0);

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

  const selectedProvider = providerStates[selectedProviderIndex];
  const selectedVerticalTab = VERTICAL_TABS[selectedVerticalTabIndex];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        letmecode usage dashboard
      </Text>
      <Text color="gray">tab/shift+tab or left/right to switch providers, j/k or up/down for details, q to quit</Text>
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

      <Box marginTop={1} borderStyle="round" paddingX={1} paddingY={0} flexDirection="column">
        <SummarySection providerState={selectedProvider} />
      </Box>

      <Box marginTop={1}>
        <Box flexDirection="column" width={22} marginRight={2}>
          {VERTICAL_TABS.map((tab, index) => (
            <VerticalTab key={tab.id} label={tab.label} active={index === selectedVerticalTabIndex} />
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <ContentPanel providerState={selectedProvider} tabId={selectedVerticalTab.id} />
        </Box>
      </Box>

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

function SummarySection(props: { providerState: ProviderLoadState }): React.JSX.Element {
  if (props.providerState.status === "loading") {
    return (
      <>
        <Text bold>{props.providerState.provider.label}</Text>
        <Text color="yellow">Loading stats from local sessions...</Text>
      </>
    );
  }

  if (props.providerState.status === "error") {
    return (
      <>
        <Text bold>{props.providerState.provider.label}</Text>
        <Text color="red">Failed to load provider stats: {props.providerState.errorMessage}</Text>
      </>
    );
  }

  const { summary } = props.providerState.stats;
  return (
    <>
      <Text bold>{props.providerState.stats.providerLabel}</Text>
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
    </>
  );
}

function ContentPanel(props: { providerState: ProviderLoadState; tabId: VerticalTabId }): React.JSX.Element {
  if (props.providerState.status === "loading") {
    return <Text color="yellow">Loading {props.providerState.provider.label} stats...</Text>;
  }

  if (props.providerState.status === "error") {
    return <Text color="red">Provider error: {props.providerState.errorMessage}</Text>;
  }

  if (props.tabId === "limit-windows") {
    return <LimitWindowsPanel stats={props.providerState.stats} />;
  }

  return <UsageByModelPanel stats={props.providerState.stats} />;
}

function LimitWindowsPanel(props: { stats: ProviderStats }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>Primary</Text>
      <LimitWindowSection windows={props.stats.primaryLimitWindows} />
      <Box marginTop={1} />
      <Text bold>Secondary</Text>
      <LimitWindowSection windows={props.stats.secondaryLimitWindows} />
    </Box>
  );
}

function LimitWindowSection(props: { windows: LimitWindowRow[] }): React.JSX.Element {
  if (props.windows.length === 0) {
    return <Text color="gray">No windows found.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text color="gray">plan       limit      window    used          start                end                  events</Text>
      {props.windows.map((window) => {
        const windowLabel = formatWindowMinutes(window.windowMinutes);
        const usedLabel = `${window.minUsedPercent}%->${window.maxUsedPercent}%`;
        return (
          <Text key={`${window.scope}-${window.planType}-${window.limitId}-${window.endTimeIso}`}>
            {pad(window.planType, 10)} {pad(window.limitId, 10)} {pad(windowLabel, 8)} {pad(usedLabel, 12)} {pad(shortIso(window.startTimeIso), 20)} {pad(shortIso(window.endTimeIso), 20)} {formatInteger(window.eventCount)}
          </Text>
        );
      })}
    </Box>
  );
}

function UsageByModelPanel(props: { stats: ProviderStats }): React.JSX.Element {
  if (props.stats.modelUsage.length === 0) {
    return <Text color="gray">No model usage found.</Text>;
  }

  const totals = props.stats.summary.totals;
  return (
    <Box flexDirection="column">
      <Text color="gray">model            input        cached       non-cached   output       credits      events</Text>
      {props.stats.modelUsage.map((row) => (
        <Text key={row.modelId}>
          {pad(row.modelId, 16)} {pad(formatInteger(row.totals.inputTokens), 12)} {pad(formatInteger(row.totals.cachedInputTokens), 12)} {pad(formatInteger(row.totals.nonCachedInputTokens), 12)} {pad(formatInteger(row.totals.outputTokens), 12)} {pad(formatCredits(row.totals.estimatedCredits), 12)} {pad(formatInteger(row.totals.eventCount), 8)}
        </Text>
      ))}
      <Text color="cyan">
        {pad("TOTAL", 16)} {pad(formatInteger(totals.inputTokens), 12)} {pad(formatInteger(totals.cachedInputTokens), 12)} {pad(formatInteger(totals.nonCachedInputTokens), 12)} {pad(formatInteger(totals.outputTokens), 12)} {pad(formatCredits(totals.estimatedCredits), 12)} {pad(formatInteger(totals.eventCount), 8)}
      </Text>
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

function formatWindowMinutes(value: number): string {
  const hours = value / 60;
  if (hours >= 24) {
    return `${(hours / 24).toFixed(2)}d`;
  }

  return `${hours.toFixed(2)}h`;
}

function shortIso(value: string): string {
  return value.replace(".000Z", "Z").slice(0, 19) + "Z";
}

function pad(value: string, length: number): string {
  return value.length >= length ? value.slice(0, length) : value.padEnd(length);
}

export function main(): void {
  render(<App />);
}

main();
