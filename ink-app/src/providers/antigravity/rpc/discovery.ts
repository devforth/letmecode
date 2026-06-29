import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
    ANTIGRAVITY_RPC_PATHS,
    rpc,
    type AntigravityLocalServer
} from "./client.js";

const execFileAsync = promisify(execFile);

type AntigravityProcess = {
    pid: number;
    csrfToken: string;
};

/**
 * A discovered server plus the quota-summary payload fetched while probing it.
 * The probe is a real RetrieveUserQuotaSummary call, so its result is reused as
 * the quota source instead of issuing the same request again.
 */
export type AntigravityConnection = {
    server: AntigravityLocalServer;
    quotaSummary: unknown;
};

export async function findAntigravityLocalServer():
    Promise<AntigravityConnection | null> {
    for (const process of await findAntigravityProcesses()) {
        for (const port of await findListeningPorts(process.pid)) {
            const server: AntigravityLocalServer = {
                port,
                csrfToken: process.csrfToken
            };

            try {
                const quotaSummary = await rpc<unknown>(
                    server,
                    ANTIGRAVITY_RPC_PATHS.quotaSummary
                );

                return { server, quotaSummary };
            } catch {
                // This port does not expose the expected Antigravity RPC API.
            }
        }
    }

    return null;
}

async function findAntigravityProcesses():
    Promise<AntigravityProcess[]> {
    const entries = await fs.promises
        .readdir("/proc")
        .catch(() => []);

    const processes: AntigravityProcess[] = [];

    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) {
            continue;
        }

        const args = await fs.promises
            .readFile(`/proc/${entry}/cmdline`, "utf8")
            .then((value) => value.split("\0").filter(Boolean))
            .catch((): string[] => []);

        const command = args.join(" ").toLowerCase();

        if (
            !command.includes("antigravity") ||
            !/(language|extension)[_-]server/.test(command)
        ) {
            continue;
        }

        const inlineToken = args.find((arg) =>
            arg.startsWith("--csrf_token=")
        );

        const tokenIndex = args.indexOf("--csrf_token");

        const csrfToken =
            inlineToken?.slice("--csrf_token=".length) ??
            (tokenIndex >= 0 ? args[tokenIndex + 1] : undefined);

        if (!csrfToken) {
            continue;
        }

        processes.push({
            pid: Number(entry),
            csrfToken
        });
    }

    return processes;
}

async function findListeningPorts(pid: number): Promise<number[]> {
    const { stdout } = await execFileAsync(
        "ss",
        ["-H", "-ltnp"],
        {
            encoding: "utf8",
            timeout: 5_000
        }
    );

    const ports = stdout
        .split("\n")
        .filter((line) => line.includes(`pid=${pid},`))
        .flatMap((line) =>
            [...line.matchAll(/(?:127\.0\.0\.1|\[::1\]):(\d+)/g)]
        )
        .map((match) => Number(match[1]));

    return [...new Set(ports)];
}
