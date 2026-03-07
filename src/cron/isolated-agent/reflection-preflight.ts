import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { isCronSessionKey } from "../../routing/session-key.js";
import type { CronJob } from "../types.js";

const REFLECTION_JOB_SUFFIXES = ["consciousness", "self-review", "deep-review"] as const;
const REFLECTION_WATCHED_FILES = [
  "WORKING.md",
  "IDENTITY.md",
  "MEMORY.md",
  "memory/diary.md",
  "memory/identity-scratchpad.md",
  "memory/open-loops.md",
  "memory/self-review.md",
] as const;

const QUIET_CONSCIOUSNESS_SUMMARY = "HEARTBEAT_OK\nNEXT_WAKE: 6h";
const QUIET_REFLECTION_SUMMARY = "HEARTBEAT_OK";

export type ReflectionRunPreflight = {
  shouldSkip: boolean;
  summary?: string;
};

function normalizeJobId(jobId: string | undefined): string {
  return jobId?.trim().toLowerCase() ?? "";
}

function isReflectionJobId(jobId: string | undefined): boolean {
  const normalized = normalizeJobId(jobId);
  return REFLECTION_JOB_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`-${suffix}`),
  );
}

function isConsciousnessJobId(jobId: string | undefined): boolean {
  const normalized = normalizeJobId(jobId);
  return normalized === "consciousness" || normalized.endsWith("-consciousness");
}

async function haveRelevantFilesChangedSince(params: {
  workspaceDir: string;
  lastRunAtMs: number;
}): Promise<boolean> {
  for (const relativePath of REFLECTION_WATCHED_FILES) {
    const absolutePath = path.join(params.workspaceDir, relativePath);
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.mtimeMs > params.lastRunAtMs) {
        return true;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        continue;
      }
      // Fail open when we cannot confidently inspect the workspace.
      return true;
    }
  }
  return false;
}

function hasRelevantSessionActivitySince(params: {
  cfg: OpenClawConfig;
  agentId: string;
  lastRunAtMs: number;
}): boolean {
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const store = loadSessionStore(storePath, { skipCache: true });
    return Object.entries(store).some(([sessionKey, entry]) => {
      if (isCronSessionKey(sessionKey)) {
        return false;
      }
      return typeof entry?.updatedAt === "number" && entry.updatedAt > params.lastRunAtMs;
    });
  } catch {
    // Fail open when we cannot confidently inspect recent session activity.
    return true;
  }
}

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

  if (
    hasRelevantSessionActivitySince({
      cfg: params.cfg,
      agentId: params.agentId,
      lastRunAtMs,
    })
  ) {
    return { shouldSkip: false };
  }

  if (
    await haveRelevantFilesChangedSince({
      workspaceDir: params.workspaceDir,
      lastRunAtMs,
    })
  ) {
    return { shouldSkip: false };
  }

  return {
    shouldSkip: true,
    summary: isConsciousnessJobId(params.job.id)
      ? QUIET_CONSCIOUSNESS_SUMMARY
      : QUIET_REFLECTION_SUMMARY,
  };
}
