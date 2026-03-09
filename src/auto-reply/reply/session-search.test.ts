import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SessionSearchIndex,
  indexTranscriptForSearch,
  type SessionMessage,
} from "./session-search.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function buildTranscriptLine(role: string, content: string, opts?: { timestamp?: string }): string {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  return JSON.stringify({
    type: "message",
    timestamp,
    message: { role, content },
  });
}

function writeTranscript(lines: string[]): string {
  const filePath = path.join(tmpDir, "transcript.jsonl");
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionSearchIndex", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-test-"));
    SessionSearchIndex.clearCache();
  });

  afterEach(() => {
    SessionSearchIndex.clearCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it("opens and initializes a new index", () => {
    const index = SessionSearchIndex.open(tmpDir);
    expect(index).not.toBeNull();
    expect(index!.isFtsAvailable).toBe(true);

    // Verify DB file exists
    const dbPath = path.join(tmpDir, "memory", "sessions.db");
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("returns cached instance for same workspace", () => {
    const index1 = SessionSearchIndex.open(tmpDir);
    const index2 = SessionSearchIndex.open(tmpDir);
    expect(index1).toBe(index2);
  });

  it("indexes and searches messages", () => {
    const index = SessionSearchIndex.open(tmpDir)!;

    const messages: SessionMessage[] = [
      {
        sessionId: "session-1",
        agentId: "agent-a",
        role: "user",
        content: "How do I configure Docker for production?",
        timestamp: Date.now(),
      },
      {
        sessionId: "session-1",
        agentId: "agent-a",
        role: "assistant",
        content: "You can use a multi-stage Dockerfile to optimize the build.",
        timestamp: Date.now(),
      },
    ];

    const count = index.indexMessages(messages);
    expect(count).toBe(2);
    expect(index.count()).toBe(2);

    // Search should find the Docker message
    const results = index.search("Docker");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("Docker");
  });

  it("filters by agent ID", () => {
    const index = SessionSearchIndex.open(tmpDir)!;

    index.indexMessages([
      {
        sessionId: "s1",
        agentId: "agent-a",
        role: "user",
        content: "Redis caching strategy",
        timestamp: Date.now(),
      },
      {
        sessionId: "s2",
        agentId: "agent-b",
        role: "user",
        content: "Redis connection pooling",
        timestamp: Date.now(),
      },
    ]);

    const allResults = index.search("Redis");
    expect(allResults).toHaveLength(2);

    const agentAResults = index.search("Redis", { agentId: "agent-a" });
    expect(agentAResults).toHaveLength(1);
    expect(agentAResults[0].agentId).toBe("agent-a");
  });

  it("filters by channel", () => {
    const index = SessionSearchIndex.open(tmpDir)!;

    index.indexMessages([
      {
        sessionId: "s1",
        agentId: "agent-a",
        role: "user",
        content: "Deploy the build",
        timestamp: Date.now(),
        channel: "telegram",
      },
      {
        sessionId: "s2",
        agentId: "agent-a",
        role: "user",
        content: "Deploy the pipeline",
        timestamp: Date.now(),
        channel: "discord",
      },
    ]);

    const telegramResults = index.search("Deploy", { channel: "telegram" });
    expect(telegramResults).toHaveLength(1);
    expect(telegramResults[0].channel).toBe("telegram");
  });

  it("searches with phrases", () => {
    const index = SessionSearchIndex.open(tmpDir)!;

    index.indexMessages([
      {
        sessionId: "s1",
        agentId: "agent-a",
        role: "user",
        content: "The quick brown fox jumps over the lazy dog",
        timestamp: Date.now(),
      },
      {
        sessionId: "s1",
        agentId: "agent-a",
        role: "user",
        content: "The dog is lazy and the fox is quick",
        timestamp: Date.now(),
      },
    ]);

    // Exact phrase should be more specific
    const phraseResults = index.search('"brown fox"');
    expect(phraseResults).toHaveLength(1);
    expect(phraseResults[0].content).toContain("brown fox");
  });

  it("limits results", () => {
    const index = SessionSearchIndex.open(tmpDir)!;

    const messages = Array.from({ length: 20 }, (_, i) => ({
      sessionId: "s1",
      agentId: "agent-a",
      role: "user" as const,
      content: `Test message number ${i} about configuration`,
      timestamp: Date.now() + i,
    }));

    index.indexMessages(messages);

    const limited = index.search("configuration", { limit: 5 });
    expect(limited).toHaveLength(5);
  });

  it("returns empty for empty query", () => {
    const index = SessionSearchIndex.open(tmpDir)!;
    const results = index.search("   ");
    expect(results).toHaveLength(0);
  });

  it("counts messages", () => {
    const index = SessionSearchIndex.open(tmpDir)!;

    index.indexMessages([
      { sessionId: "s1", agentId: "a1", role: "user", content: "Hello", timestamp: Date.now() },
      { sessionId: "s1", agentId: "a2", role: "user", content: "World", timestamp: Date.now() },
    ]);

    expect(index.count()).toBe(2);
    expect(index.count("a1")).toBe(1);
    expect(index.count("a2")).toBe(1);
    expect(index.count("nonexistent")).toBe(0);
  });

  it("skips empty content messages", () => {
    const index = SessionSearchIndex.open(tmpDir)!;

    const count = index.indexMessages([
      { sessionId: "s1", agentId: "a1", role: "user", content: "", timestamp: Date.now() },
      { sessionId: "s1", agentId: "a1", role: "user", content: "   ", timestamp: Date.now() },
      { sessionId: "s1", agentId: "a1", role: "user", content: "Valid", timestamp: Date.now() },
    ]);

    expect(count).toBe(1);
    expect(index.count()).toBe(1);
  });
});

describe("indexTranscriptForSearch", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-test-"));
    SessionSearchIndex.clearCache();
  });

  afterEach(() => {
    SessionSearchIndex.clearCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it("indexes user and assistant messages from transcript", () => {
    const transcriptPath = writeTranscript([
      buildTranscriptLine("user", "Fix the Docker build"),
      buildTranscriptLine("assistant", "I'll look at the Dockerfile."),
      buildTranscriptLine("tool", "FROM node:20...", { timestamp: new Date().toISOString() }),
      buildTranscriptLine("assistant", "Fixed the issue."),
    ]);

    indexTranscriptForSearch({
      transcriptPath,
      workspaceDir: tmpDir,
      agentId: "test-agent",
      sessionId: "test-session-1",
      channel: "telegram",
    });

    const index = SessionSearchIndex.open(tmpDir)!;
    // Should have 3 messages (2 assistant + 1 user, tool message skipped)
    expect(index.count()).toBe(3);

    const results = index.search("Docker");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sessionId).toBe("test-session-1");
  });

  it("handles nonexistent transcript gracefully", () => {
    expect(() =>
      indexTranscriptForSearch({
        transcriptPath: "/tmp/nonexistent.jsonl",
        workspaceDir: tmpDir,
        agentId: "test-agent",
        sessionId: "test-session",
      }),
    ).not.toThrow();
  });

  it("handles malformed transcript lines", () => {
    const transcriptPath = writeTranscript([
      "not json",
      buildTranscriptLine("user", "Valid message"),
      '{"type":"session"}',
    ]);

    indexTranscriptForSearch({
      transcriptPath,
      workspaceDir: tmpDir,
      agentId: "test-agent",
      sessionId: "test-session",
    });

    const index = SessionSearchIndex.open(tmpDir)!;
    expect(index.count()).toBe(1);
  });
});
