import type { OpenClawConfig } from "../../config/config.js";
import type { CronJob } from "../types.js";
import {
  isConsciousnessJobId,
  isReflectionJobId,
  updateReflectionInbox,
} from "./reflection-artifacts.js";

const QUIET_CONSCIOUSNESS_SUMMARY = "HEARTBEAT_OK\nNEXT_WAKE: 6h";
const QUIET_REFLECTION_SUMMARY = "HEARTBEAT_OK";

export type ReflectionRunPreflight = {
  shouldSkip: boolean;
  summary?: string;
};

export async function resolveReflectionRunPreflight(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  workspaceDir: string;
}): Promise<ReflectionRunPreflight> {
  if (!isReflectionJobId(params.job.id)) {
    return { shouldSkip: false };
  }

  const lastRunAtMs = params.job.state?.lastRunAtMs;
  if (typeof lastRunAtMs !== "number" || !Number.isFinite(lastRunAtMs)) {
    return { shouldSkip: false };
  }

  let inbox: Awaited<ReturnType<typeof updateReflectionInbox>>;
  try {
    inbox = await updateReflectionInbox({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      lastRunAtMs,
    });
  } catch {
    return { shouldSkip: false };
  }

  if (inbox.sessionActivity.countSinceLastRun > 0 || inbox.changedFiles.length > 0) {
    return { shouldSkip: false };
  }

  return {
    shouldSkip: true,
    summary: isConsciousnessJobId(params.job.id)
      ? QUIET_CONSCIOUSNESS_SUMMARY
      : QUIET_REFLECTION_SUMMARY,
  };
}
