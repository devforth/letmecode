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

const STEPS_CONCURRENCY = 8;

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

// A cascade's completed steps are immutable, so its usage only changes when the
// step count changes. Cache per cascade to avoid refetching every full step
// list on each refresh when nothing has happened.
const cascadeUsageCache = new Map<
  string,
  { stepCount: number; usage: AntigravityUsage[] }
>();

/**
 * Reconstructs per-response model usage from the Antigravity local language
 * server.
 *
 * Every billable model call is recorded on a trajectory step as
 * `metadata.modelUsage`, identified by `responseId`, and usage is spread across
 * several step types (planner responses, checkpoints, ...). This reads every
 * step rather than filtering by type. `GetCascadeTrajectorySteps` returns the
 * full step list for a cascade in one response, so each cascade is fetched
 * once, and cascades are fetched concurrently. De-duplication of responses is
 * the caller's responsibility.
 */
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

  const cascades = Object.entries(trajectories.trajectorySummaries ?? {})
    .map(([cascadeId, summary]) => ({
      cascadeId,
      stepCount: summary.stepCount ?? 0
    }))
    .filter((cascade) => cascade.stepCount > 0);

  const perCascade = await mapWithConcurrency(
    cascades,
    STEPS_CONCURRENCY,
    (cascade) => fetchCascadeUsage(server, cascade.cascadeId, cascade.stepCount)
  );

  return perCascade.flat();
}

async function fetchCascadeUsage(
  server: AntigravityLocalServer,
  cascadeId: string,
  stepCount: number
): Promise<AntigravityUsage[]> {
  const cached = cascadeUsageCache.get(cascadeId);
  if (cached && cached.stepCount === stepCount) {
    return cached.usage;
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

  const usage: AntigravityUsage[] = [];

  for (const step of response.steps ?? []) {
    const modelUsage = step.metadata?.modelUsage;
    const created = step.metadata?.createdAt;
    const responseId = modelUsage?.responseId;
    const model = modelUsage?.model;

    if (!modelUsage || !created || !responseId || !model) {
      continue;
    }

    usage.push({
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

  cascadeUsageCache.set(cascadeId, { stepCount, usage });
  return usage;
}

function toTokenCount(value: TokenCount | undefined): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await task(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}
