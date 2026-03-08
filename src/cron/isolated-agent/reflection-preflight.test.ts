import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveReflectionRunPreflight } from "./reflection-preflight.js";

async function makeWorkspaceFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reflection-preflight-"));
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "WORKING.md"), "working\n", "utf-8");
  await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "identity\n", "utf-8");
  await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "memory\n", "utf-8");
  await fs.writeFile(path.join(workspaceDir, "memory", "diary.md"), "diary\n", "utf-8");
  await fs.writeFile(
    path.join(workspaceDir, "memory", "identity-scratchpad.md"),
    "scratchpad\n",
    "utf-8",
  );
  await fs.writeFile(path.join(workspaceDir, "memory", "open-loops.md"), "loops\n", "utf-8");
  await fs.writeFile(path.join(workspaceDir, "memory", "self-review.md"), "review\n", "utf-8");
  return { root, workspaceDir };
}

async function setWorkspaceMtime(workspaceDir: string, atMs: number) {
  const at = new Date(atMs);
  await fs.utimes(path.join(workspaceDir, "WORKING.md"), at, at);
  await fs.utimes(path.join(workspaceDir, "IDENTITY.md"), at, at);
  await fs.utimes(path.join(workspaceDir, "MEMORY.md"), at, at);
  await fs.utimes(path.join(workspaceDir, "memory", "diary.md"), at, at);
  await fs.utimes(path.join(workspaceDir, "memory", "identity-scratchpad.md"), at, at);
  await fs.utimes(path.join(workspaceDir, "memory", "open-loops.md"), at, at);
  await fs.utimes(path.join(workspaceDir, "memory", "self-review.md"), at, at);
}

describe("resolveReflectionRunPreflight", () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("skips quiet consciousness runs when neither sessions nor watched files changed", async () => {
    const { root, workspaceDir } = await makeWorkspaceFixture();
    cleanupRoots.push(root);
    const lastRunAtMs = Date.now();
    await setWorkspaceMtime(workspaceDir, lastRunAtMs - 10_000);
    const sessionStorePath = path.join(root, "sessions.json");
    await fs.writeFile(
      sessionStorePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "main-1", updatedAt: lastRunAtMs - 20_000 },
        "agent:main:cron:consciousness": { sessionId: "cron-1", updatedAt: lastRunAtMs + 5_000 },
      }),
      "utf-8",
    );

    const result = await resolveReflectionRunPreflight({
      cfg: { session: { store: sessionStorePath } } as never,
      job: {
        id: "consciousness",
        state: { lastRunAtMs },
      } as never,
      agentId: "main",
      workspaceDir,
    });

    expect(result).toEqual({
      shouldSkip: true,
      summary: "HEARTBEAT_OK\nNEXT_WAKE: 6h",
    });
    const inbox = await fs.readFile(
      path.join(workspaceDir, "memory", "reflection-inbox.md"),
      "utf-8",
    );
    expect(inbox).toContain("Changed reflection files: none.");
  });

  it("runs when a non-cron session changed after the last reflection pass", async () => {
    const { root, workspaceDir } = await makeWorkspaceFixture();
    cleanupRoots.push(root);
    const lastRunAtMs = Date.now();
    await setWorkspaceMtime(workspaceDir, lastRunAtMs - 10_000);
    const sessionStorePath = path.join(root, "sessions.json");
    await fs.writeFile(
      sessionStorePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "main-1", updatedAt: lastRunAtMs + 5_000 },
      }),
      "utf-8",
    );

    const result = await resolveReflectionRunPreflight({
      cfg: { session: { store: sessionStorePath } } as never,
      job: {
        id: "consciousness",
        state: { lastRunAtMs },
      } as never,
      agentId: "main",
      workspaceDir,
    });

    expect(result).toEqual({ shouldSkip: false });
  });

  it("runs when a watched reflection file changed after the last pass", async () => {
    const { root, workspaceDir } = await makeWorkspaceFixture();
    cleanupRoots.push(root);
    const lastRunAtMs = Date.now();
    await setWorkspaceMtime(workspaceDir, lastRunAtMs - 10_000);
    const touchedAt = new Date(lastRunAtMs + 5_000);
    await fs.utimes(path.join(workspaceDir, "memory", "self-review.md"), touchedAt, touchedAt);
    const sessionStorePath = path.join(root, "sessions.json");
    await fs.writeFile(
      sessionStorePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "main-1", updatedAt: lastRunAtMs - 20_000 },
      }),
      "utf-8",
    );

    const result = await resolveReflectionRunPreflight({
      cfg: { session: { store: sessionStorePath } } as never,
      job: {
        id: "deep-review",
        state: { lastRunAtMs },
      } as never,
      agentId: "main",
      workspaceDir,
    });

    expect(result).toEqual({ shouldSkip: false });
  });
});
