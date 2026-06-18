import {spawnSync} from "node:child_process";
import {join} from "node:path";

export function main(argv: string[] = process.argv.slice(2)): void {
  const inkCliPath = join(__dirname, "..", "ink-app", "dist", "index.js");
  const result = spawnSync(process.execPath, [inkCliPath, ...argv], {
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number") {
    process.exitCode = result.status;
    return;
  }

  process.exitCode = 1;
}
