import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveCronSessionMock,
  resolveReflectionRunPreflightMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "consciousness",
      name: "Self-Improvement: Consciousness Loop",
      schedule: { kind: "every", everyMs: 7_200_000, anchorMs: 0 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "agentTurn",
        message: "Background consciousness mode",
      },
      state: {},
      enabled: true,
    } as never,
    message: "Background consciousness mode",
    sessionKey: "cron:consciousness",
  };
}

describe("runCronIsolatedAgentTurn reflection preflight", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronSessionMock.mockReturnValue(makeCronSession());
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("skips idle reflection runs before invoking the embedded agent", async () => {
    resolveReflectionRunPreflightMock.mockResolvedValue({
      shouldSkip: true,
      summary: "HEARTBEAT_OK\nNEXT_WAKE: 6h",
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(result.status).toBe("skipped");
    expect(result.summary).toBe("HEARTBEAT_OK\nNEXT_WAKE: 6h");
  });
});
