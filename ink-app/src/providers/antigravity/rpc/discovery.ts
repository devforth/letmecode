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
    const processes = await findAntigravityProcesses();
    if (processes.length === 0) {
        return null;
    }

    const portsByPid = await readListeningPortsByPid();

    for (const process of processes) {
        for (const port of portsByPid.get(process.pid) ?? []) {
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

async function readListeningPortsByPid(): Promise<Map<number, number[]>> {
    const { stdout } = await execFileAsync(
        "ss",
        ["-H", "-ltnp"],
        {
            encoding: "utf8",
            timeout: 5_000
        }
    );

    const portsByPid = new Map<number, Set<number>>();

    for (const line of stdout.split("\n")) {
        const loopbackPorts = [
            ...line.matchAll(/(?:127\.0\.0\.1|\[::1\]):(\d+)/g)
        ].map((match) => Number(match[1]));

        if (loopbackPorts.length === 0) {
            continue;
        }

        for (const pidMatch of line.matchAll(/pid=(\d+),/g)) {
            const pid = Number(pidMatch[1]);
            const ports = portsByPid.get(pid) ?? new Set<number>();
            for (const port of loopbackPorts) {
                ports.add(port);
            }
            portsByPid.set(pid, ports);
        }
    }

    return new Map(
        [...portsByPid.entries()].map(([pid, ports]) => [pid, [...ports]])
    );
}
