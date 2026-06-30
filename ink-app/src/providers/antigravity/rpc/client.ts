import https from "node:https";

export type AntigravityLocalServer = {
    port: number;
    csrfToken: string;
};

export type AntigravityRpcMetadata = {
    ideName: string;
    extensionName: string;
    ideVersion?: string;
    locale?: string;
};

export const ANTIGRAVITY_RPC_PATHS = {
    quotaSummary:
        "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",

    userStatus:
        "/exa.language_server_pb.LanguageServerService/GetUserStatus",

    trajectories:
        "/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories",

    trajectorySteps:
        "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps"
} as const;

export async function rpc<
    TResponse,
    TPayload extends object = Record<string, never>
>(
    server: AntigravityLocalServer,
    endpoint: string,
    payload?: TPayload
): Promise<TResponse> {
    const body = JSON.stringify(payload ?? {});

    return new Promise<TResponse>((resolve, reject) => {
        const request = https.request(
            {
                hostname: "127.0.0.1",
                port: server.port,
                path: endpoint,
                method: "POST",
                rejectUnauthorized: false,
                timeout: 5_000,
                headers: {
                    "X-Codeium-Csrf-Token": server.csrfToken,
                    "Content-Type": "application/json",
                    "Connect-Protocol-Version": "1",
                    "Content-Length": Buffer.byteLength(body)
                }
            },
            (response) => {
                const chunks: Buffer[] = [];

                response.on("data", (chunk: Buffer) => {
                    chunks.push(chunk);
                });

                response.on("end", () => {
                    const responseBody = Buffer.concat(chunks).toString("utf8");

                    if (
                        response.statusCode === undefined ||
                        response.statusCode >= 300
                    ) {
                        reject(
                            new Error(
                                `Antigravity RPC ${endpoint} failed with status ${response.statusCode ?? "unknown"
                                }.`
                            )
                        );
                        return;
                    }

                    if (!responseBody) {
                        resolve({} as TResponse);
                        return;
                    }

                    try {
                        resolve(JSON.parse(responseBody) as TResponse);
                    } catch (error) {
                        reject(
                            new Error(
                                `Antigravity RPC ${endpoint} returned invalid JSON.`,
                                { cause: error }
                            )
                        );
                    }
                });
            }
        );

        request.on("timeout", () => {
            request.destroy(
                new Error(`Antigravity RPC ${endpoint} timed out.`)
            );
        });

        request.on("error", reject);
        request.end(body);
    });
}