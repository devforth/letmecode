import fs from "node:fs";
import path from "node:path";
import type { ProviderStatsOptions, ProviderTraceLogger } from "./providers/contract.js";

export type ParsedCliOptions = {
  showHelp: boolean;
  verbose: boolean;
  logToPath?: string;
  enableAnonymousUsageReporting: boolean;
};

export function parseCliOptions(argv: string[]): ParsedCliOptions {
  let showHelp = false;
  let verbose = false;
  let logToPath: string | undefined;
  let enableAnonymousUsageReporting = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (argument === "-h" || argument === "--help") {
      showHelp = true;
      continue;
    }

    if (argument === "-v" || argument === "--verbose") {
      verbose = true;
      continue;
    }

    if (argument === "--log-to") {
      const nextArgument = argv[index + 1];
      if (!nextArgument) {
        throw new Error("Expected a file path after --log-to.");
      }

      logToPath = nextArgument;
      index += 1;
      continue;
    }

    if (argument.startsWith("--log-to=")) {
      const value = argument.slice("--log-to=".length);
      if (!value) {
        throw new Error("Expected a file path after --log-to=.");
      }

      logToPath = value;
      continue;
    }

    if (argument === "--no-usage") {
      enableAnonymousUsageReporting = false;
    }
  }

  return { showHelp, verbose, logToPath, enableAnonymousUsageReporting };
}

export function buildProviderStatsOptions(options: ParsedCliOptions): ProviderStatsOptions {
  return {
    verbose: options.verbose,
    traceLogger: options.logToPath ? createFileTraceLogger(options.logToPath) : undefined
  };
}

export function buildHelpText(): string {
  return [
    "letmecode - terminal AI usage dashboard",
    "",
    "Usage:",
    "  letmecode [options]",
    "",
    "Options:",
    "  -h, --help         Show this help and exit",
    "  -v, --verbose      Show extra provider warnings",
    "  --log-to PATH      Write trace logs to PATH",
    "  --no-usage         Disable anonymous usage reporting",
    "",
    "Controls:",
    "  Up / Down          Select Provider, View, or table rows",
    "  Left / Right       Change the selected Provider or View",
    "  Left / Right       Do nothing when table rows are selected",
    "  Tab / Shift+Tab    Switch providers without leaving the table",
    "  [ / ]              Switch views without leaving the table",
    "  1, Enter           Run Copilot setup actions",
    "  q or Esc           Quit",
    "",
    "Trace logging:",
    "  --log-to PATH writes Claude detection details,",
    "  session root selection, parsed session file summaries, aggregated usage selection,",
    "  every candidate binary path check, the final found/not-found result,",
    "  and the raw /usage command output plus live window matching details.",
    "",
    "Anonymous reporting:",
    "  Enabled by default. Use --no-usage to disable the best-effort",
    "  anonymous usage summary upload."
  ].join("\n");
}

export function createFileTraceLogger(logPath: string): ProviderTraceLogger {
  const resolvedPath = path.resolve(logPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(
    resolvedPath,
    [
      "# letmecode trace",
      `# started_at=${new Date().toISOString()}`,
      `# cwd=${process.cwd()}`,
      `# argv=${JSON.stringify(process.argv.slice(2))}`,
      ""
    ].join("\n"),
    "utf8"
  );

  return {
    log(message: string): void {
      const timestamp = new Date().toISOString();
      const formatted = message
        .split(/\r?\n/)
        .map((line, index) => (index === 0 ? `[${timestamp}] ${line}` : `  ${line}`))
        .join("\n");
      fs.appendFileSync(resolvedPath, `${formatted}\n`, "utf8");
    }
  };
}
