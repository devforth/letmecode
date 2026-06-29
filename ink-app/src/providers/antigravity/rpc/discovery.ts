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

export async function findAntigravityLocalServer():
    Promise<AntigravityLocalServer | null> {
    const process = await findAntigravityProcess();

    if (!process) {
        return null;
    }

    const ports = await findListeningPorts(process.pid);

    for (const port of ports) {
        const server: AntigravityLocalServer = {
            port,
            csrfToken: process.csrfToken
        };

        try {
            await rpc<unknown>(
                server,
                ANTIGRAVITY_RPC_PATHS.quotaSummary
            );

            return server;
        } catch {
            // This port does not expose the expected Antigravity RPC API.
        }
    }

    return null;
}

async function findAntigravityProcess():
    Promise<AntigravityProcess | null> {
    const entries = await fs.promises
        .readdir("/proc")
        .catch(() => []);

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

        return {
            pid: Number(entry),
            csrfToken
        };
    }

    return null;
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