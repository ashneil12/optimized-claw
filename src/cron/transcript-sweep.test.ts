import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { sweepTranscriptsForWorkspace, runTranscriptSweep } from "./transcript-sweep.js";

let suiteRoot = "";
let caseCounter = 0;

async function createCaseDir(prefix = "case"): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}-${caseCounter}`);
  caseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function createTranscriptFile(
  workspaceDir: string,
  filename: string,
  content: string,
): Promise<string> {
  const transcriptsDir = path.join(workspaceDir, "transcripts");
  await fs.mkdir(transcriptsDir, { recursive: true });
  const filePath = path.join(transcriptsDir, filename);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

async function readTranscript(workspaceDir: string, filename: string): Promise<string> {
  return fs.readFile(path.join(workspaceDir, "transcripts", filename), "utf-8");
}

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-sweep-"));
});

afterAll(async () => {
  if (suiteRoot) {
    await fs.rm(suiteRoot, { recursive: true, force: true });
    suiteRoot = "";
    caseCounter = 0;
  }
});

describe("transcript security sweep", () => {
  it("redacts secrets in existing transcript files", async () => {
    const dir = await createCaseDir("workspace");
    const secretKey = "sk-abcdef1234567890abcdef1234567890";
    await createTranscriptFile(
      dir,
      "2026-03-04.md",
      `## 14:32:05 — user: +1234567890 (telegram)\n\nMy API key is ${secretKey}\n\n---\n`,
    );

    const result = await sweepTranscriptsForWorkspace(dir);

    expect(result.filesScanned).toBe(1);
    expect(result.filesRedacted).toBe(1);

    const content = await readTranscript(dir, "2026-03-04.md");
    expect(content).not.toContain(secretKey);
    expect(content).toContain("sk-abc");
  });

  it("skips files that are already clean", async () => {
    const dir = await createCaseDir("workspace");
    await createTranscriptFile(
      dir,
      "2026-03-04.md",
      `## 14:32:05 — user: +1234567890 (telegram)\n\nHello there, nothing secret here\n\n---\n`,
    );

    const result = await sweepTranscriptsForWorkspace(dir);

    expect(result.filesScanned).toBe(1);
    expect(result.filesRedacted).toBe(0);
  });

  it("handles missing transcripts directory gracefully", async () => {
    const dir = await createCaseDir("workspace");
    // No transcripts dir created

    const result = await sweepTranscriptsForWorkspace(dir);

    expect(result.filesScanned).toBe(0);
    expect(result.filesRedacted).toBe(0);
  });

  it("processes multiple files in one sweep", async () => {
    const dir = await createCaseDir("workspace");
    const secret1 = "ghp_abcdefghijklmnopqrstuvwxyz1234";
    const secret2 = "sk-1234567890abcdef1234567890abcdef";

    await createTranscriptFile(
      dir,
      "2026-03-04.md",
      `## 10:00:00 — user (telegram)\n\nGitHub token: ${secret1}\n\n---\n`,
    );
    await createTranscriptFile(
      dir,
      "2026-03-05.md",
      `## 10:00:00 — user (telegram)\n\nOpenAI key: ${secret2}\n\n---\n`,
    );
    await createTranscriptFile(
      dir,
      "2026-03-06.md",
      `## 10:00:00 — user (telegram)\n\nJust a normal message\n\n---\n`,
    );

    const result = await sweepTranscriptsForWorkspace(dir);

    expect(result.filesScanned).toBe(3);
    expect(result.filesRedacted).toBe(2);

    const content4 = await readTranscript(dir, "2026-03-04.md");
    expect(content4).not.toContain(secret1);

    const content5 = await readTranscript(dir, "2026-03-05.md");
    expect(content5).not.toContain(secret2);
  });

  it("writes sweep state after completion", async () => {
    const dir = await createCaseDir("workspace");
    await createTranscriptFile(dir, "2026-03-04.md", "Hello\n");

    const beforeMs = Date.now();
    await sweepTranscriptsForWorkspace(dir);

    const statePath = path.join(dir, "transcripts", ".sweep-state.json");
    const raw = await fs.readFile(statePath, "utf-8");
    const state = JSON.parse(raw) as { lastSweepAtMs?: number };

    expect(state.lastSweepAtMs).toBeDefined();
    expect(state.lastSweepAtMs!).toBeGreaterThanOrEqual(beforeMs);
  });

  it("respects sweep interval in multi-agent sweep", async () => {
    const dir = await createCaseDir("workspace");
    await createTranscriptFile(dir, "2026-03-04.md", "Hello\n");

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: dir } },
    };

    // First sweep should run
    const results1 = await runTranscriptSweep(cfg, 1000);
    expect(results1.length).toBe(1);

    // Immediate second sweep should skip (not due yet)
    const results2 = await runTranscriptSweep(cfg, 1000);
    expect(results2.length).toBe(0);
  });

  it("sweeps multiple agent workspaces", async () => {
    const rootDir = await createCaseDir("root");
    const mainWorkspace = path.join(rootDir, "workspace-main");
    const subWorkspace = path.join(rootDir, "workspace-research");

    const mainSecret = "sk-main1234567890abcdef1234567890";
    const subSecret = "ghp_research1234567890abcdef12345";

    await createTranscriptFile(
      mainWorkspace,
      "2026-03-04.md",
      `Main agent secret: ${mainSecret}\n`,
    );
    await createTranscriptFile(subWorkspace, "2026-03-04.md", `Sub agent secret: ${subSecret}\n`);

    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", workspace: mainWorkspace },
          { id: "research", workspace: subWorkspace },
        ],
      },
    };

    const results = await runTranscriptSweep(cfg);

    expect(results.length).toBe(2);
    const totalRedacted = results.reduce((sum, r) => sum + r.filesRedacted, 0);
    expect(totalRedacted).toBe(2);

    const mainContent = await readTranscript(mainWorkspace, "2026-03-04.md");
    expect(mainContent).not.toContain(mainSecret);

    const subContent = await readTranscript(subWorkspace, "2026-03-04.md");
    expect(subContent).not.toContain(subSecret);
  });
});
