import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONSCIOUSNESS_IDENTITY_COOLDOWN_MS,
  applyReflectionRunPostflight,
  captureReflectionFileSnapshot,
  dedupeSelfReviewFile,
  updateReflectionInbox,
} from "./reflection-artifacts.js";

let rootDir = "";
let workspaceDir = "";
let sessionStorePath = "";

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reflection-artifacts-"));
  workspaceDir = path.join(rootDir, "workspace");
  sessionStorePath = path.join(rootDir, "sessions.json");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "WORKING.md"), "working\n", "utf-8");
  await fs.writeFile(
    path.join(workspaceDir, "IDENTITY.md"),
    "# IDENTITY\n\n## CRITICAL Rules\n",
    "utf-8",
  );
  await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# MEMORY\n", "utf-8");
  await fs.writeFile(path.join(workspaceDir, "memory", "diary.md"), "# Diary\n", "utf-8");
  await fs.writeFile(
    path.join(workspaceDir, "memory", "identity-scratchpad.md"),
    "# Scratchpad\n",
    "utf-8",
  );
  await fs.writeFile(path.join(workspaceDir, "memory", "open-loops.md"), "# Loops\n", "utf-8");
  await fs.writeFile(
    path.join(workspaceDir, "memory", "self-review.md"),
    "# Self-Review Log\n\n[2026-03-07 10:00 UTC]\n\nTAG: [scope] MISS: missed the check. FIX: verify the result first.\n",
    "utf-8",
  );
  await fs.writeFile(
    sessionStorePath,
    JSON.stringify({
      "agent:main:main": { sessionId: "main", updatedAt: Date.parse("2026-03-07T11:00:00Z") },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe("updateReflectionInbox", () => {
  it("writes a deterministic inbox with activity, file changes, and promotion watchlist", async () => {
    const lastRunAtMs = Date.parse("2026-03-07T10:30:00Z");
    const touchedAt = new Date(Date.parse("2026-03-07T10:45:00Z"));
    await fs.utimes(path.join(workspaceDir, "WORKING.md"), touchedAt, touchedAt);
    await fs.writeFile(
      path.join(workspaceDir, "memory", "self-review.md"),
      "# Self-Review Log\n\n[2026-03-06 10:00 UTC]\n\nTAG: [scope] MISS: one. FIX: verify the result first.\n\n[2026-03-07 10:00 UTC]\n\nTAG: [scope] MISS: two. FIX: verify the result first.\n",
      "utf-8",
    );

    const summary = await updateReflectionInbox({
      cfg: { session: { store: sessionStorePath } } as never,
      agentId: "main",
      workspaceDir,
      lastRunAtMs,
    });

    expect(summary.sessionActivity.countSinceLastRun).toBe(1);
    expect(summary.changedFiles).toContain("WORKING.md");
    expect(summary.watchFixes).toEqual(["verify the result first. (2x)"]);

    const inbox = await fs.readFile(
      path.join(workspaceDir, "memory", "reflection-inbox.md"),
      "utf-8",
    );
    expect(inbox).toContain("Non-cron session activity: 1 updated session(s).");
    expect(inbox).toContain("Changed reflection files: WORKING.md");
    expect(inbox).toContain("verify the result first. (2x)");
  });
});

describe("applyReflectionRunPostflight", () => {
  it("reverts self-review identity edits and reapplies only deterministic promotions", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "memory", "self-review.md"),
      "# Self-Review Log\n\n[2026-03-05 10:00 UTC]\n\nTAG: [scope] MISS: one. FIX: verify the result first.\n\n[2026-03-06 10:00 UTC]\n\nTAG: [scope] MISS: two. FIX: verify the result first.\n\n[2026-03-07 10:00 UTC]\n\nTAG: [scope] MISS: three. FIX: verify the result first.\n",
      "utf-8",
    );
    const before = await captureReflectionFileSnapshot({
      jobId: "self-review",
      workspaceDir,
    });
    await fs.writeFile(
      path.join(workspaceDir, "IDENTITY.md"),
      "# IDENTITY\n\n## CRITICAL Rules\n\n- **CRITICAL:** invented broad rewrite\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "identity-scratchpad.md"),
      "# Scratchpad\n\nmade a bookkeeping-only change\n",
      "utf-8",
    );

    await applyReflectionRunPostflight({
      jobId: "self-review",
      workspaceDir,
      before,
      nowMs: Date.parse("2026-03-07T12:00:00Z"),
    });

    const identity = await fs.readFile(path.join(workspaceDir, "IDENTITY.md"), "utf-8");
    expect(identity).not.toContain("invented broad rewrite");
    expect(identity).toContain("CRITICAL");
    expect(identity).toContain("Verify the result first.");

    const scratchpad = await fs.readFile(
      path.join(workspaceDir, "memory", "identity-scratchpad.md"),
      "utf-8",
    );
    expect(scratchpad).toBe("# Scratchpad\n");
  });

  it("reverts consciousness identity churn when the cooldown is active", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "memory", ".reflection-state.json"),
      `${JSON.stringify(
        {
          lastIdentityWriteAtMs: Date.parse("2026-03-07T11:30:00Z"),
          lastIdentityWriteByJobId: "deep-review",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const before = await captureReflectionFileSnapshot({
      jobId: "consciousness",
      workspaceDir,
    });

    await fs.writeFile(
      path.join(workspaceDir, "IDENTITY.md"),
      "# IDENTITY\n\n## CRITICAL Rules\n\n- changed too soon\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "identity-scratchpad.md"),
      "# Scratchpad\n\ncandidate identity edit\n",
      "utf-8",
    );

    await applyReflectionRunPostflight({
      jobId: "consciousness",
      workspaceDir,
      before,
      nowMs: Date.parse("2026-03-07T12:00:00Z"),
    });

    const identity = await fs.readFile(path.join(workspaceDir, "IDENTITY.md"), "utf-8");
    const scratchpad = await fs.readFile(
      path.join(workspaceDir, "memory", "identity-scratchpad.md"),
      "utf-8",
    );
    expect(identity).not.toContain("changed too soon");
    expect(scratchpad).toBe("# Scratchpad\n");

    const state = JSON.parse(
      await fs.readFile(path.join(workspaceDir, "memory", ".reflection-state.json"), "utf-8"),
    ) as { lastIdentityWriteAtMs: number; lastIdentityWriteByJobId: string };
    expect(state.lastIdentityWriteAtMs).toBe(Date.parse("2026-03-07T11:30:00Z"));
    expect(state.lastIdentityWriteByJobId).toBe("deep-review");
    expect(Date.parse("2026-03-07T12:00:00Z") - state.lastIdentityWriteAtMs).toBeLessThan(
      CONSCIOUSNESS_IDENTITY_COOLDOWN_MS,
    );
  });
});

describe("dedupeSelfReviewFile", () => {
  it("keeps the newest copy of repeated meta-pattern entries", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "memory", "self-review.md"),
      "# Self-Review Log\n\n[2026-03-06 10:00 UTC]\n\nPattern check: same-cycle closure discipline is holding.\n\n[2026-03-07 10:00 UTC]\n\nPattern check: same-cycle closure discipline is holding.\n",
      "utf-8",
    );

    const result = await dedupeSelfReviewFile(workspaceDir);

    expect(result.removedEntries).toBe(1);
    const selfReview = await fs.readFile(
      path.join(workspaceDir, "memory", "self-review.md"),
      "utf-8",
    );
    expect(selfReview.match(/Pattern check:/g)).toHaveLength(1);
    expect(selfReview).toContain("[2026-03-07 10:00 UTC]");
  });
});
