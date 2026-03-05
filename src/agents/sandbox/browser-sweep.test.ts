import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectBrowserContainer,
  listSandboxBrowserContainers,
  pullBrowserImage,
  sweepStaleBrowserContainers,
} from "./browser-sweep.js";

const dockerMocks = vi.hoisted(() => ({
  execDocker: vi.fn(),
  readDockerContainerImageId: vi.fn(),
  readDockerImageId: vi.fn(),
}));

vi.mock("./docker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./docker.js")>();
  return {
    ...actual,
    execDocker: dockerMocks.execDocker,
    readDockerContainerImageId: dockerMocks.readDockerContainerImageId,
    readDockerImageId: dockerMocks.readDockerImageId,
  };
});

const IMAGE = "ghcr.io/example/browser:main";
const FRESH_IMAGE_ID = "sha256:aabbccdd1234";
const STALE_IMAGE_ID = "sha256:oldoldold5678";

function mockDockerSuccess(stdout = "") {
  return { stdout, stderr: "", code: 0 };
}

function mockDockerFailure(stderr = "error") {
  return { stdout: "", stderr, code: 1 };
}

/**
 * Helper: mock the two Docker calls that listSandboxBrowserContainers makes.
 * Pass labelStdout for label-based results and nameStdout for name-based results.
 * By default nameStdout is empty (no legacy containers).
 */
function mockListContainers(labelStdout: string, nameStdout = "") {
  dockerMocks.execDocker.mockResolvedValueOnce(mockDockerSuccess(labelStdout)); // label query
  dockerMocks.execDocker.mockResolvedValueOnce(mockDockerSuccess(nameStdout)); // name query
}

describe("pullBrowserImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns image ID on successful pull", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce(mockDockerSuccess()); // pull
    dockerMocks.readDockerImageId.mockResolvedValueOnce(FRESH_IMAGE_ID);

    const result = await pullBrowserImage(IMAGE);
    expect(result).toBe(FRESH_IMAGE_ID);
    expect(dockerMocks.execDocker).toHaveBeenCalledWith(["pull", IMAGE], { allowFailure: true });
  });

  it("returns null when pull fails", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce(mockDockerFailure("pull failed"));

    const result = await pullBrowserImage(IMAGE);
    expect(result).toBeNull();
  });
});

describe("listSandboxBrowserContainers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns containers from label query", async () => {
    mockListContainers("browser-agent1\nbrowser-agent2\n");

    const names = await listSandboxBrowserContainers();
    expect(names).toContain("browser-agent1");
    expect(names).toContain("browser-agent2");
  });

  it("returns legacy containers from name query", async () => {
    // No label results, but name-based results find legacy containers
    mockListContainers(
      "", // no label matches
      "browser-jael\tghcr.io/example/browser:main\nbrowser-ezra\tghcr.io/example/browser:main\n",
    );

    const names = await listSandboxBrowserContainers({ browserImage: IMAGE });
    expect(names).toContain("browser-jael");
    expect(names).toContain("browser-ezra");
  });

  it("deduplicates across both strategies", async () => {
    mockListContainers(
      "browser-agent1\n", // found by label
      "browser-agent1\tghcr.io/example/browser:main\n", // also found by name
    );

    const names = await listSandboxBrowserContainers({ browserImage: IMAGE });
    expect(names).toEqual(["browser-agent1"]);
  });

  it("excludes compose-managed containers (moltbot- prefix)", async () => {
    mockListContainers(
      "",
      "moltbot-browser-1\tghcr.io/example/browser:main\nbrowser-agent1\tghcr.io/example/browser:main\n",
    );

    const names = await listSandboxBrowserContainers({ browserImage: IMAGE });
    expect(names).toEqual(["browser-agent1"]);
  });

  it("returns empty array when no containers found", async () => {
    mockListContainers("", "");

    const names = await listSandboxBrowserContainers();
    expect(names).toEqual([]);
  });

  it("returns empty array when both queries fail", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce(mockDockerFailure()); // label fails
    dockerMocks.execDocker.mockResolvedValueOnce(mockDockerFailure()); // name fails

    const names = await listSandboxBrowserContainers();
    expect(names).toEqual([]);
  });
});

describe("inspectBrowserContainer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns full container info", async () => {
    dockerMocks.readDockerContainerImageId.mockResolvedValueOnce(STALE_IMAGE_ID);
    dockerMocks.execDocker
      .mockResolvedValueOnce(
        mockDockerSuccess("OPENCLAW_BROWSER_CDP_PORT=9222\nOPENCLAW_BROWSER_NO_SANDBOX=1\n"),
      ) // env
      .mockResolvedValueOnce(
        mockDockerSuccess("volume\tbrowser-home-agent1\t/tmp/openclaw-home\ttrue\n"),
      ) // mounts
      .mockResolvedValueOnce(
        mockDockerSuccess("openclaw.sandboxBrowser=1\nopenclaw.sessionKey=agent:main\n"),
      ) // labels
      .mockResolvedValueOnce(mockDockerSuccess("true")); // state

    const info = await inspectBrowserContainer("browser-agent1");
    expect(info).toEqual({
      name: "browser-agent1",
      imageId: STALE_IMAGE_ID,
      env: ["OPENCLAW_BROWSER_CDP_PORT=9222", "OPENCLAW_BROWSER_NO_SANDBOX=1"],
      mounts: [
        {
          type: "volume",
          source: "browser-home-agent1",
          destination: "/tmp/openclaw-home",
          rw: true,
        },
      ],
      labels: { "openclaw.sandboxBrowser": "1", "openclaw.sessionKey": "agent:main" },
      running: true,
    });
  });

  it("returns null when container does not exist", async () => {
    dockerMocks.readDockerContainerImageId.mockResolvedValueOnce(null);

    const info = await inspectBrowserContainer("nonexistent");
    expect(info).toBeNull();
  });
});

describe("sweepStaleBrowserContainers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips when pull fails", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce(mockDockerFailure("network error")); // pull fails

    const stats = await sweepStaleBrowserContainers({ browserImage: IMAGE });
    expect(stats.pulled).toBe(false);
    expect(stats.checked).toBe(0);
    expect(stats.recreated).toBe(0);
  });

  it("reports zero when no containers exist", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce(mockDockerSuccess()); // pull
    dockerMocks.readDockerImageId.mockResolvedValueOnce(FRESH_IMAGE_ID);
    mockListContainers("", ""); // no containers

    const stats = await sweepStaleBrowserContainers({ browserImage: IMAGE });
    expect(stats.pulled).toBe(true);
    expect(stats.checked).toBe(0);
  });

  it("skips up-to-date containers", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce(mockDockerSuccess()); // pull
    dockerMocks.readDockerImageId.mockResolvedValueOnce(FRESH_IMAGE_ID);
    mockListContainers("browser-agent1\n"); // list via label

    // inspectBrowserContainer mock chain
    dockerMocks.readDockerContainerImageId.mockResolvedValueOnce(FRESH_IMAGE_ID); // same as fresh!
    dockerMocks.execDocker
      .mockResolvedValueOnce(mockDockerSuccess("")) // env
      .mockResolvedValueOnce(mockDockerSuccess("")) // mounts
      .mockResolvedValueOnce(mockDockerSuccess("")) // labels
      .mockResolvedValueOnce(mockDockerSuccess("true")); // state

    const stats = await sweepStaleBrowserContainers({ browserImage: IMAGE });
    expect(stats.checked).toBe(1);
    expect(stats.recreated).toBe(0);
  });

  it("recreates stale containers", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce(mockDockerSuccess()); // pull
    dockerMocks.readDockerImageId.mockResolvedValueOnce(FRESH_IMAGE_ID);
    mockListContainers("browser-agent1\n"); // list via label

    // inspectBrowserContainer: container has STALE image
    dockerMocks.readDockerContainerImageId.mockResolvedValueOnce(STALE_IMAGE_ID);
    dockerMocks.execDocker
      .mockResolvedValueOnce(
        mockDockerSuccess("OPENCLAW_BROWSER_CDP_PORT=9222\nOPENCLAW_BROWSER_NO_SANDBOX=1\n"),
      ) // env
      .mockResolvedValueOnce(
        mockDockerSuccess("volume\tbrowser-home-agent1\t/tmp/openclaw-home\ttrue\n"),
      ) // mounts
      .mockResolvedValueOnce(mockDockerSuccess("openclaw.sandboxBrowser=1\n")) // labels
      .mockResolvedValueOnce(mockDockerSuccess("true")); // state

    // recreateBrowserContainer calls
    dockerMocks.execDocker
      .mockResolvedValueOnce(mockDockerSuccess()) // rm -f
      .mockResolvedValueOnce(mockDockerSuccess()) // create
      .mockResolvedValueOnce(mockDockerSuccess()) // start
      .mockResolvedValueOnce(mockDockerSuccess()); // network connect

    const stats = await sweepStaleBrowserContainers({
      browserImage: IMAGE,
      dockerNetwork: "moltbot_default",
    });

    expect(stats.pulled).toBe(true);
    expect(stats.checked).toBe(1);
    expect(stats.recreated).toBe(1);
    expect(stats.failed).toBe(0);

    // Verify rm -f was called
    const rmCall = dockerMocks.execDocker.mock.calls.find(
      (call: string[][]) => call[0]?.[0] === "rm" && call[0]?.[1] === "-f",
    );
    expect(rmCall).toBeDefined();

    // Verify create used the new image
    const createCall = dockerMocks.execDocker.mock.calls.find(
      (call: string[][]) => call[0]?.[0] === "create",
    );
    expect(createCall).toBeDefined();
    expect(createCall![0]).toContain(IMAGE);

    // Verify network connect
    const networkCall = dockerMocks.execDocker.mock.calls.find(
      (call: string[][]) => call[0]?.[0] === "network" && call[0]?.[1] === "connect",
    );
    expect(networkCall).toBeDefined();
    expect(networkCall![0]).toContain("moltbot_default");
    expect(networkCall![0]).toContain("browser-agent1");
  });

  it("continues after individual container failure", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce(mockDockerSuccess()); // pull
    dockerMocks.readDockerImageId.mockResolvedValueOnce(FRESH_IMAGE_ID);
    mockListContainers("browser-fail\nbrowser-ok\n"); // list 2 containers

    // First container: inspect fails
    dockerMocks.readDockerContainerImageId.mockResolvedValueOnce(null);

    // Second container: up-to-date
    dockerMocks.readDockerContainerImageId.mockResolvedValueOnce(FRESH_IMAGE_ID);
    dockerMocks.execDocker
      .mockResolvedValueOnce(mockDockerSuccess("")) // env
      .mockResolvedValueOnce(mockDockerSuccess("")) // mounts
      .mockResolvedValueOnce(mockDockerSuccess("")) // labels
      .mockResolvedValueOnce(mockDockerSuccess("true")); // state

    const stats = await sweepStaleBrowserContainers({ browserImage: IMAGE });
    expect(stats.checked).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.recreated).toBe(0);
  });

  it("detects legacy containers by name pattern", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce(mockDockerSuccess()); // pull
    dockerMocks.readDockerImageId.mockResolvedValueOnce(FRESH_IMAGE_ID);
    // Label query: no results. Name query: finds legacy container.
    mockListContainers(
      "", // no label matches
      `browser-legacy\t${IMAGE}\n`,
    );

    // Container is up-to-date
    dockerMocks.readDockerContainerImageId.mockResolvedValueOnce(FRESH_IMAGE_ID);
    dockerMocks.execDocker
      .mockResolvedValueOnce(mockDockerSuccess("")) // env
      .mockResolvedValueOnce(mockDockerSuccess("")) // mounts
      .mockResolvedValueOnce(mockDockerSuccess("")) // labels
      .mockResolvedValueOnce(mockDockerSuccess("true")); // state

    const stats = await sweepStaleBrowserContainers({ browserImage: IMAGE });
    expect(stats.checked).toBe(1);
    expect(stats.recreated).toBe(0);
  });
});
