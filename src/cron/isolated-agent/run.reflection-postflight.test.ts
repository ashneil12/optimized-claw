import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyReflectionRunPostflightMock,
  captureReflectionFileSnapshotMock,
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "consciousness",
      name: "Self-Improvement: Consciousness Loop",
      schedule: { kind: "every", everyMs: 18_000_000, anchorMs: 0 },
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

describe("runCronIsolatedAgentTurn reflection postflight", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronSessionMock.mockReturnValue(makeCronSession());
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("captures and applies reflection postflight after a completed run", async () => {
    captureReflectionFileSnapshotMock.mockResolvedValue({ identity: "before" });

    await runCronIsolatedAgentTurn(makeParams());

    expect(captureReflectionFileSnapshotMock).toHaveBeenCalledWith({
      jobId: "consciousness",
      workspaceDir: "/tmp/workspace",
    });
    expect(applyReflectionRunPostflightMock).toHaveBeenCalledWith({
      jobId: "consciousness",
      workspaceDir: "/tmp/workspace",
      before: { identity: "before" },
    });
  });
});
