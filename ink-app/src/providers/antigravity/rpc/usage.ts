import {
  ANTIGRAVITY_RPC_PATHS,
  rpc,
  type AntigravityLocalServer,
  type AntigravityRpcMetadata
} from "./client.js";

const TRAJECTORY_METADATA: AntigravityRpcMetadata = {
  ideName: "antigravity",
  extensionName: "antigravity"
};

type TokenCount = string | number;

type RpcModelUsage = {
  responseId?: string;
  model?: string;
  inputTokens?: TokenCount;
  outputTokens?: TokenCount;
  cacheReadTokens?: TokenCount;
  thinkingOutputTokens?: TokenCount;
};

type RpcTrajectoryStep = {
  metadata?: {
    createdAt?: string;
    modelUsage?: RpcModelUsage;
  };
};

type TrajectoriesResponse = {
  trajectorySummaries?: Record<
    string,
    {
      stepCount?: number;
    }
  >;
};

type StepsResponse = {
  steps?: RpcTrajectoryStep[];
};

export type AntigravityUsage = {
  responseId: string;
  cascadeId: string;
  created: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
};

export async function fetchAntigravityUsageRpcData(
  server: AntigravityLocalServer
): Promise<AntigravityUsage[]> {
  const trajectories = await rpc<
    TrajectoriesResponse,
    { metadata: AntigravityRpcMetadata }
  >(
    server,
    ANTIGRAVITY_RPC_PATHS.trajectories,
    {
      metadata: TRAJECTORY_METADATA
    }
  );

  const usageByResponse = new Map<string, AntigravityUsage>();

  for (
    const [cascadeId, trajectory]
    of Object.entries(trajectories.trajectorySummaries ?? {})
  ) {
    const stepCount = trajectory.stepCount ?? 0;
    if (stepCount <= 0) {
      continue;
    }

    const response = await rpc<
      StepsResponse,
      {
        cascadeId: string;
        startIndex: number;
        endIndex: number;
      }
    >(
      server,
      ANTIGRAVITY_RPC_PATHS.trajectorySteps,
      {
        cascadeId,
        startIndex: 0,
        endIndex: stepCount
      }
    );

    for (const step of response.steps ?? []) {
      const modelUsage = step.metadata?.modelUsage;
      const created = step.metadata?.createdAt;
      const responseId = modelUsage?.responseId;
      const model = modelUsage?.model;

      if (!modelUsage || !created || !responseId || !model) {
        continue;
      }

      const key = `${cascadeId}:${responseId}`;
      if (usageByResponse.has(key)) {
        continue;
      }

      usageByResponse.set(key, {
        responseId,
        cascadeId,
        created,
        model,
        input: toTokenCount(modelUsage.inputTokens),
        output: toTokenCount(modelUsage.outputTokens),
        cacheRead: toTokenCount(modelUsage.cacheReadTokens),
        reasoning: toTokenCount(modelUsage.thinkingOutputTokens)
      });
    }
  }

  return [...usageByResponse.values()];
}

function toTokenCount(value: TokenCount | undefined): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}
