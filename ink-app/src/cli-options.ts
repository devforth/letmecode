import fs from "node:fs";
import path from "node:path";
import type { ProviderStatsOptions, ProviderTraceLogger } from "./providers/contract.js";

export type ParsedCliOptions = {
  showHelp: boolean;
  verbose: boolean;
  logToPath?: string;
};

export function parseCliOptions(argv: string[]): ParsedCliOptions {
  let showHelp = false;
  let verbose = false;
  let logToPath: string | undefined;

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
    }
  }

  return { showHelp, verbose, logToPath };
}

export function buildProviderStatsOptions(options: ParsedCliOptions): ProviderStatsOptions {
  return {
    verbose: options.verbose,
    traceLogger: options.logToPath ? createFileTraceLogger(options.logToPath) : undefined
  };
}

export function buildHelpText(): string {
  return [
    "letmecode - provider-based terminal usage dashboard",
    "",
    "Usage:",
    "  letmecode [options]",
    "",
    "Options:",
    "  -h, --help         Show this help and exit",
    "  -v, --verbose      Show extra provider warnings",
    "  --log-to PATH      Write trace logs to PATH",
    "",
    "Controls:",
    "  [ ] / Tab          Switch providers",
    "  Shift+Tab          Switch providers backward",
    "  j / k              Switch dashboard sections",
    "  Up / Down          Switch dashboard sections",
    "  Left / Right       Select the previous or next row",
    "  1, h / l, Enter    Run Copilot setup actions",
    "  q or Esc           Quit",
    "",
    "Trace logging:",
    "  --log-to PATH writes Claude CLI SDK and Claude VSCode detection details,",
    "  session root selection, parsed session file summaries, entrypoint matching,",
    "  every candidate binary path check, the final found/not-found result,",
    "  and the raw /usage command output plus live window matching details."
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
