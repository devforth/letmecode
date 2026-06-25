import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildHelpText,
  buildProviderStatsOptions,
  parseCliOptions
} from "../dist/cli-options.js";

async function withTempRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "letmecode-cli-options-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("parseCliOptions recognizes help, verbose, and log destination flags", () => {
  assert.deepEqual(parseCliOptions(["-h", "-v", "--log-to", "trace.log"]), {
    showHelp: true,
    verbose: true,
    logToPath: "trace.log"
  });
  assert.deepEqual(parseCliOptions(["--help", "--log-to=trace.txt"]), {
    showHelp: true,
    verbose: false,
    logToPath: "trace.txt"
  });
});

test("buildProviderStatsOptions creates a trace logger when --log-to is set", async () => {
  await withTempRoot(async (root) => {
    const logPath = path.join(root, "trace.log");
    const statsOptions = buildProviderStatsOptions(parseCliOptions(["--log-to", logPath, "--verbose"]));
    assert.equal(statsOptions.verbose, true);
    assert.ok(statsOptions.traceLogger);

    statsOptions.traceLogger.log("[test] hello");

    const content = await fs.readFile(logPath, "utf8");
    assert.match(content, /letmecode trace/);
    assert.match(content, /\[test\] hello/);
  });
});

test("buildHelpText documents the help and trace flags", () => {
  const helpText = buildHelpText();
  assert.match(helpText, /-h, --help/);
  assert.match(helpText, /--log-to PATH/);
  assert.match(helpText, /Trace logging:/);
});
