import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { compressTrajectory, parseTranscriptTurns } from "./trajectory-compressor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTranscriptLine(
  role: string,
  content: string,
  opts?: { timestamp?: string; toolName?: string; toolCallId?: string },
): string {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  const msg: Record<string, unknown> = { role, content };
  if (opts?.toolCallId) {
    msg.tool_call_id = opts.toolCallId;
  }
  if (opts?.toolName && role === "assistant") {
    msg.content = [
      { type: "text", text: content },
      { type: "toolCall", name: opts.toolName, id: "call_1" },
    ];
  }
  if (opts?.toolName && role === "tool") {
    msg.name = opts.toolName;
    msg.tool_call_id = opts.toolCallId ?? "call_1";
  }
  return JSON.stringify({ type: "message", timestamp, message: msg });
}

function writeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trajectory-test-"));
  const filePath = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  return filePath;
}

function cleanupTranscript(filePath: string): void {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("trajectory-compressor", () => {
  describe("parseTranscriptTurns", () => {
    it("parses user and assistant turns from JSONL", () => {
      const transcript = writeTranscript([
        buildTranscriptLine("user", "Hello, can you help me?"),
        buildTranscriptLine("assistant", "Of course! What do you need?"),
      ]);
      try {
        const turns = parseTranscriptTurns(transcript);
        expect(turns).toHaveLength(2);
        expect(turns[0].role).toBe("user");
        expect(turns[0].content).toBe("Hello, can you help me?");
        expect(turns[1].role).toBe("assistant");
        expect(turns[1].content).toBe("Of course! What do you need?");
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("detects tool calls in assistant messages", () => {
      const transcript = writeTranscript([
        buildTranscriptLine("assistant", "Let me search for that.", {
          toolName: "web_search",
        }),
      ]);
      try {
        const turns = parseTranscriptTurns(transcript);
        expect(turns).toHaveLength(1);
        expect(turns[0].isToolCall).toBe(true);
        expect(turns[0].toolName).toBe("web_search");
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("detects tool results", () => {
      const transcript = writeTranscript([
        buildTranscriptLine("tool", "Search results: ...", {
          toolName: "web_search",
          toolCallId: "call_abc",
        }),
      ]);
      try {
        const turns = parseTranscriptTurns(transcript);
        expect(turns).toHaveLength(1);
        expect(turns[0].isToolResult).toBe(true);
        expect(turns[0].toolName).toBe("web_search");
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("returns empty array for nonexistent file", () => {
      const turns = parseTranscriptTurns("/tmp/nonexistent-transcript.jsonl");
      expect(turns).toHaveLength(0);
    });

    it("skips malformed lines gracefully", () => {
      const transcript = writeTranscript([
        "not json at all",
        buildTranscriptLine("user", "Valid message"),
        '{"type":"session","timestamp":"2026-01-01T00:00:00Z"}',
        "",
      ]);
      try {
        const turns = parseTranscriptTurns(transcript);
        expect(turns).toHaveLength(1);
        expect(turns[0].content).toBe("Valid message");
      } finally {
        cleanupTranscript(transcript);
      }
    });
  });

  describe("compressTrajectory", () => {
    it("returns empty summary for empty transcript", async () => {
      const transcript = writeTranscript([]);
      try {
        const result = await compressTrajectory({ transcriptPath: transcript });
        expect(result.summary).toBe("");
        expect(result.metrics.totalTurns).toBe(0);
        expect(result.metrics.usedLlm).toBe(false);
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("returns empty summary for nonexistent file", async () => {
      const result = await compressTrajectory({
        transcriptPath: "/tmp/no-such-file.jsonl",
      });
      expect(result.summary).toBe("");
      expect(result.metrics.totalTurns).toBe(0);
    });

    it("produces summary with session metadata", async () => {
      const ts = "2026-01-15T10:30:00.000Z";
      const transcript = writeTranscript([
        buildTranscriptLine("user", "Fix the Docker build", { timestamp: ts }),
        buildTranscriptLine("assistant", "I'll look at the Dockerfile.", {
          timestamp: ts,
        }),
        buildTranscriptLine("assistant", "Let me read the file", {
          timestamp: ts,
          toolName: "read",
        }),
        buildTranscriptLine("tool", "FROM node:20...", {
          timestamp: ts,
          toolName: "read",
          toolCallId: "call_1",
        }),
        buildTranscriptLine("assistant", "Fixed the issue by adding a COPY command for bun.", {
          timestamp: ts,
        }),
      ]);
      try {
        const result = await compressTrajectory({ transcriptPath: transcript });
        expect(result.summary).toContain("Session Summary");
        expect(result.summary).toContain("5 turns");
        expect(result.summary).toContain("read");
        expect(result.metrics.totalTurns).toBe(5);
        expect(result.metrics.usedLlm).toBe(false);
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("extracts key decisions from assistant messages", async () => {
      const transcript = writeTranscript([
        buildTranscriptLine("user", "Should we use Redis or Postgres?"),
        buildTranscriptLine("assistant", "Let me research both options."),
        buildTranscriptLine("assistant", "Looking at the docs", {
          toolName: "web_search",
        }),
        buildTranscriptLine("tool", "Results...", {
          toolName: "web_search",
          toolCallId: "call_1",
        }),
        buildTranscriptLine(
          "assistant",
          "I'll go with Postgres because it handles our use case better and avoids adding another dependency.",
        ),
        buildTranscriptLine("assistant", "Created the migration file with the new schema."),
        buildTranscriptLine("user", "Looks good, thanks!"),
      ]);
      try {
        const result = await compressTrajectory({ transcriptPath: transcript });
        // With 7 turns and default 3+4 protection, the "I'll go with" and "Created" turns
        // appear in the protected final context section rather than being compressed.
        expect(result.summary).toContain("I'll go with Postgres");
        expect(result.summary).toContain("Created the migration file");
        expect(result.metrics.totalTurns).toBe(7);
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("extracts user intents", async () => {
      const transcript = writeTranscript([
        buildTranscriptLine("user", "Fix the login page CSS"),
        buildTranscriptLine("assistant", "On it."),
        buildTranscriptLine("user", "Also add dark mode support"),
        buildTranscriptLine("assistant", "Done."),
      ]);
      try {
        const result = await compressTrajectory({ transcriptPath: transcript });
        expect(result.summary).toContain("User requests");
        expect(result.summary).toContain("Fix the login page CSS");
        expect(result.summary).toContain("Also add dark mode support");
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("respects maxOutputChars", async () => {
      const lines: string[] = [];
      for (let i = 0; i < 50; i++) {
        lines.push(buildTranscriptLine("user", `Request ${i}: ${"x".repeat(200)}`));
        lines.push(buildTranscriptLine("assistant", `Response ${i}: ${"y".repeat(200)}`));
      }
      const transcript = writeTranscript(lines);
      try {
        const result = await compressTrajectory({
          transcriptPath: transcript,
          config: { maxOutputChars: 2000 },
        });
        expect(result.summary.length).toBeLessThanOrEqual(2001); // +1 for trailing newline
        expect(result.metrics.totalTurns).toBe(100);
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("protects first and last turns", async () => {
      const transcript = writeTranscript([
        buildTranscriptLine("user", "FIRST_USER_MESSAGE"),
        buildTranscriptLine("assistant", "FIRST_ASSISTANT_RESPONSE"),
        buildTranscriptLine("user", "Middle message 1"),
        buildTranscriptLine("assistant", "Middle response 1"),
        buildTranscriptLine("user", "Middle message 2"),
        buildTranscriptLine("assistant", "Middle response 2"),
        buildTranscriptLine("user", "LAST_USER_MESSAGE"),
        buildTranscriptLine("assistant", "LAST_ASSISTANT_RESPONSE"),
      ]);
      try {
        const result = await compressTrajectory({
          transcriptPath: transcript,
          config: { protectFirstTurns: 2, protectLastTurns: 2 },
        });
        // Protected turns should appear in the summary
        expect(result.summary).toContain("FIRST_USER_MESSAGE");
        expect(result.summary).toContain("FIRST_ASSISTANT_RESPONSE");
        expect(result.summary).toContain("LAST_USER_MESSAGE");
        expect(result.summary).toContain("LAST_ASSISTANT_RESPONSE");
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("tracks tool usage counts", async () => {
      const transcript = writeTranscript([
        buildTranscriptLine("user", "Search for info"),
        buildTranscriptLine("assistant", "Searching", { toolName: "web_search" }),
        buildTranscriptLine("tool", "Results 1", {
          toolName: "web_search",
          toolCallId: "c1",
        }),
        buildTranscriptLine("assistant", "Need more", { toolName: "web_search" }),
        buildTranscriptLine("tool", "Results 2", {
          toolName: "web_search",
          toolCallId: "c2",
        }),
        buildTranscriptLine("assistant", "Reading file", { toolName: "read" }),
        buildTranscriptLine("tool", "File content", {
          toolName: "read",
          toolCallId: "c3",
        }),
        buildTranscriptLine("assistant", "Done."),
      ]);
      try {
        const result = await compressTrajectory({ transcriptPath: transcript });
        // web_search used 4 times (2 assistant calls + 2 tool results), read 2 times
        expect(result.summary).toContain("web_search");
        expect(result.summary).toContain("read");
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("uses LLM summarization when callback provided", async () => {
      const transcript = writeTranscript([
        buildTranscriptLine("user", "Hello"),
        buildTranscriptLine("assistant", "Hi there!"),
      ]);
      try {
        const mockSummarize = vi.fn().mockResolvedValue("LLM-generated summary here.");
        const result = await compressTrajectory({
          transcriptPath: transcript,
          config: { summarize: mockSummarize },
        });
        expect(result.summary).toBe("LLM-generated summary here.");
        expect(result.metrics.usedLlm).toBe(true);
        expect(mockSummarize).toHaveBeenCalledOnce();
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("falls back to mechanical when LLM callback returns undefined", async () => {
      const transcript = writeTranscript([
        buildTranscriptLine("user", "Fix the bug"),
        buildTranscriptLine("assistant", "I'll investigate."),
      ]);
      try {
        const mockSummarize = vi.fn().mockResolvedValue(undefined);
        const result = await compressTrajectory({
          transcriptPath: transcript,
          config: { summarize: mockSummarize },
        });
        expect(result.summary).toContain("Session Summary");
        expect(result.metrics.usedLlm).toBe(false);
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("falls back to mechanical when LLM callback throws", async () => {
      const transcript = writeTranscript([
        buildTranscriptLine("user", "Hello"),
        buildTranscriptLine("assistant", "Hi!"),
      ]);
      try {
        const mockSummarize = vi.fn().mockRejectedValue(new Error("API timeout"));
        const result = await compressTrajectory({
          transcriptPath: transcript,
          config: { summarize: mockSummarize },
        });
        expect(result.summary).toContain("Session Summary");
        expect(result.metrics.usedLlm).toBe(false);
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("reports correct compression metrics", async () => {
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(buildTranscriptLine("user", `Message ${i}`));
        lines.push(buildTranscriptLine("assistant", `Reply ${i}`));
      }
      const transcript = writeTranscript(lines);
      try {
        const result = await compressTrajectory({
          transcriptPath: transcript,
          config: { protectFirstTurns: 3, protectLastTurns: 4 },
        });
        expect(result.metrics.totalTurns).toBe(20);
        expect(result.metrics.protectedTurns).toBe(7);
        expect(result.metrics.compressedTurns).toBe(13);
        expect(result.metrics.inputChars).toBeGreaterThan(0);
        expect(result.metrics.outputChars).toBeGreaterThan(0);
      } finally {
        cleanupTranscript(transcript);
      }
    });

    it("handles short conversations where all turns are protected", async () => {
      const transcript = writeTranscript([
        buildTranscriptLine("user", "Quick question"),
        buildTranscriptLine("assistant", "Quick answer"),
      ]);
      try {
        const result = await compressTrajectory({
          transcriptPath: transcript,
          config: { protectFirstTurns: 3, protectLastTurns: 4 },
        });
        // With 2 turns and 7 protected slots, all turns are protected
        expect(result.metrics.totalTurns).toBe(2);
        expect(result.metrics.protectedTurns).toBe(2);
        expect(result.metrics.compressedTurns).toBe(0);
        expect(result.summary).toContain("Quick question");
      } finally {
        cleanupTranscript(transcript);
      }
    });
  });
});
