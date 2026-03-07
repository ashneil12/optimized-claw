import { describe, expect, it, vi } from "vitest";
import { createMockCronStateForJobs } from "../service.test-harness.js";
import { applyJobResult, executeJobCore, parseNextWakeDuration } from "./timer.js";

function makeIsolatedEveryJob() {
  return {
    id: "consciousness",
    name: "Consciousness",
    enabled: true,
    schedule: { kind: "every", everyMs: 7_200_000, anchorMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message: "Background consciousness mode",
    },
    state: {},
  } as never;
}

describe("parseNextWakeDuration", () => {
  it("parses hours", () => {
    expect(parseNextWakeDuration("some text NEXT_WAKE: 4h")).toBe(4 * 60 * 60_000);
  });

  it("parses minutes", () => {
    // 30m is below the 1h minimum, so it gets clamped to 1h
    expect(parseNextWakeDuration("NEXT_WAKE: 30m")).toBe(60 * 60_000);
  });

  it("parses hours and minutes combined", () => {
    expect(parseNextWakeDuration("NEXT_WAKE: 4h30m")).toBe(4.5 * 60 * 60_000);
  });

  it("parses decimal hours", () => {
    expect(parseNextWakeDuration("NEXT_WAKE: 1.5h")).toBe(1.5 * 60 * 60_000);
  });

  it("clamps to minimum 1h", () => {
    expect(parseNextWakeDuration("NEXT_WAKE: 10m")).toBe(60 * 60_000);
  });

  it("clamps to maximum 12h", () => {
    expect(parseNextWakeDuration("NEXT_WAKE: 24h")).toBe(12 * 60 * 60_000);
  });

  it("returns undefined when no directive found", () => {
    expect(parseNextWakeDuration("nothing here")).toBeUndefined();
  });

  it("returns undefined for empty/undefined input", () => {
    expect(parseNextWakeDuration(undefined)).toBeUndefined();
    expect(parseNextWakeDuration("")).toBeUndefined();
  });

  it("handles multiline text", () => {
    const text = "I reflected on recent events.\nUpdated diary.\nNEXT_WAKE: 6h\n";
    expect(parseNextWakeDuration(text)).toBe(6 * 60 * 60_000);
  });

  it("ignores case in unit", () => {
    expect(parseNextWakeDuration("NEXT_WAKE: 3H")).toBe(3 * 60 * 60_000);
  });
});

describe("NEXT_WAKE scheduling", () => {
  it("extracts nextRunAfterMs from isolated job output", async () => {
    const job = makeIsolatedEveryJob();
    const state = createMockCronStateForJobs({ jobs: [job] });
    state.deps.runIsolatedAgentJob = vi.fn().mockResolvedValue({
      status: "ok",
      summary: "HEARTBEAT_OK",
      outputText: "HEARTBEAT_OK\nNEXT_WAKE: 6h",
    });

    const result = await executeJobCore(state, job);

    expect(result.nextRunAfterMs).toBe(6 * 60 * 60_000);
  });

  it("overrides the natural schedule when nextRunAfterMs is set", () => {
    const job = makeIsolatedEveryJob();
    const endedAt = Date.UTC(2026, 2, 7, 12, 0, 0);
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: endedAt });

    const shouldDelete = applyJobResult(state, job, {
      status: "ok",
      startedAt: endedAt - 5_000,
      endedAt,
      nextRunAfterMs: 6 * 60 * 60_000,
    });

    expect(shouldDelete).toBe(false);
    expect(job.state.nextRunAtMs).toBe(endedAt + 6 * 60 * 60_000);
  });
});
