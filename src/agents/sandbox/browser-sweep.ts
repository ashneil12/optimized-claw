/**
 * Browser startup sweep: auto-updates stale sandbox browser containers on gateway boot.
 *
 * When the gateway starts, this module:
 *  1. Pulls the latest browser image (gets newest tag from GHCR)
 *  2. Lists all sandbox browser containers (label: openclaw.sandboxBrowser=1)
 *  3. Compares each container's image digest to the freshly pulled one
 *  4. Recreates any stale containers with the same env/volumes/name
 *  5. Connects recreated containers to OPENCLAW_DOCKER_NETWORK
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { execDocker, readDockerContainerImageId, readDockerImageId } from "./docker.js";

const log = createSubsystemLogger("browser-sweep");

/** Parsed container info from `docker inspect`. */
export interface BrowserContainerInfo {
  name: string;
  imageId: string;
  env: string[];
  mounts: Array<{ type: string; source: string; destination: string; rw: boolean }>;
  labels: Record<string, string>;
  running: boolean;
}

/**
 * Pull the browser image. Returns the new local image ID, or null if pull/inspect fails.
 */
export async function pullBrowserImage(image: string): Promise<string | null> {
  const pullResult = await execDocker(["pull", image], { allowFailure: true });
  if (pullResult.code !== 0) {
    log.warn(`failed to pull browser image ${image}: ${pullResult.stderr.trim()}`);
    return null;
  }
  return await readDockerImageId(image);
}

/**
 * List all sandbox browser containers.
 * Uses two strategies to detect containers:
 *  1. Label filter: `openclaw.sandboxBrowser=1` (new containers created by ensureSandboxBrowser)
 *  2. Name pattern: `browser-*` (legacy containers from ensure-agent-browsers.sh)
 * Excludes compose-managed containers (prefixed with `moltbot-`), which are managed
 * by docker-compose, not the sweep.
 * Returns deduplicated container names regardless of running state.
 */
export async function listSandboxBrowserContainers(params?: {
  browserImage?: string;
}): Promise<string[]> {
  const names = new Set<string>();

  // Strategy 1: Label-based (preferred, works for new containers)
  const labelResult = await execDocker(
    ["ps", "-a", "--filter", "label=openclaw.sandboxBrowser=1", "--format", "{{.Names}}"],
    { allowFailure: true },
  );
  if (labelResult.code === 0) {
    for (const name of labelResult.stdout.trim().split(/\r?\n/)) {
      if (name.trim()) {
        names.add(name.trim());
      }
    }
  }

  // Strategy 2: Name pattern (catches legacy containers without the label)
  // Filter by the browser image if provided, otherwise match all `browser-*` containers.
  const nameArgs = ["ps", "-a", "--filter", "name=^browser-", "--format", "{{.Names}}\t{{.Image}}"];
  const nameResult = await execDocker(nameArgs, { allowFailure: true });
  if (nameResult.code === 0) {
    const browserImage = params?.browserImage;
    for (const line of nameResult.stdout.trim().split(/\r?\n/)) {
      const [name, image] = line.split("\t");
      if (!name?.trim()) {
        continue;
      }
      // Skip compose-managed containers (e.g., moltbot-browser-1)
      if (name.startsWith("moltbot-")) {
        continue;
      }
      // If we know the browser image, only include containers using it
      if (browserImage && image && !image.includes(browserImage.split(":")[0] ?? "")) {
        continue;
      }
      names.add(name.trim());
    }
  }

  return [...names];
}

/**
 * Read full container configuration needed to recreate it faithfully.
 */
export async function inspectBrowserContainer(
  containerName: string,
): Promise<BrowserContainerInfo | null> {
  const imageId = await readDockerContainerImageId(containerName);
  if (!imageId) {
    return null;
  }

  // Get env vars
  const envResult = await execDocker(
    ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", containerName],
    { allowFailure: true },
  );
  const env =
    envResult.code === 0
      ? envResult.stdout
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
      : [];

  // Get mounts (volumes)
  const mountResult = await execDocker(
    [
      "inspect",
      "--format",
      '{{range .Mounts}}{{.Type}}\t{{.Source}}\t{{.Destination}}\t{{.RW}}{{println ""}}{{end}}',
      containerName,
    ],
    { allowFailure: true },
  );
  const mounts: BrowserContainerInfo["mounts"] = [];
  if (mountResult.code === 0) {
    for (const line of mountResult.stdout.trim().split(/\r?\n/)) {
      const parts = line.split("\t");
      if (parts.length >= 4) {
        mounts.push({
          type: parts[0],
          source: parts[1],
          destination: parts[2],
          rw: parts[3] === "true",
        });
      }
    }
  }

  // Get labels
  const labelResult = await execDocker(
    [
      "inspect",
      "--format",
      '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println ""}}{{end}}',
      containerName,
    ],
    { allowFailure: true },
  );
  const labels: Record<string, string> = {};
  if (labelResult.code === 0) {
    for (const line of labelResult.stdout.trim().split(/\r?\n/)) {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        labels[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
      }
    }
  }

  // Get running state
  const stateResult = await execDocker(
    ["inspect", "--format", "{{.State.Running}}", containerName],
    { allowFailure: true },
  );
  const running = stateResult.code === 0 && stateResult.stdout.trim() === "true";

  return { name: containerName, imageId, env, mounts, labels, running };
}

/**
 * Recreate a single browser container with a new image while preserving its configuration.
 */
export async function recreateBrowserContainer(params: {
  info: BrowserContainerInfo;
  newImage: string;
  dockerNetwork?: string;
}): Promise<void> {
  const { info, newImage, dockerNetwork } = params;

  // Remove old container
  await execDocker(["rm", "-f", info.name]);

  // Build create args
  const args = [
    "create",
    "--name",
    info.name,
    "--restart",
    "unless-stopped",
    "--user",
    "0:0",
    "--init",
    "--shm-size",
    "2g",
  ];

  // Restore env vars (skip PATH and DEBIAN_FRONTEND which come from the image)
  const imageDefaultEnvPrefixes = ["PATH=", "DEBIAN_FRONTEND="];
  for (const envEntry of info.env) {
    if (imageDefaultEnvPrefixes.some((prefix) => envEntry.startsWith(prefix))) {
      continue;
    }
    args.push("-e", envEntry);
  }

  // Restore volume mounts
  for (const mount of info.mounts) {
    if (mount.type === "volume") {
      const suffix = mount.rw ? "" : ":ro";
      args.push("-v", `${mount.source}:${mount.destination}${suffix}`);
    } else if (mount.type === "bind") {
      const suffix = mount.rw ? "" : ":ro";
      args.push("-v", `${mount.source}:${mount.destination}${suffix}`);
    }
  }

  // Restore labels and ensure the sandboxBrowser label is present
  // (legacy containers created before the labeling convention may lack it)
  const mergedLabels = { ...info.labels, "openclaw.sandboxBrowser": "1" };
  for (const [key, value] of Object.entries(mergedLabels)) {
    args.push("--label", `${key}=${value}`);
  }

  args.push(newImage);

  await execDocker(args);
  await execDocker(["start", info.name]);

  // Connect to gateway network
  if (dockerNetwork) {
    await execDocker(["network", "connect", dockerNetwork, info.name], {
      allowFailure: true,
    });
  }
}

/**
 * Main sweep entry point. Pulls the latest browser image and recreates any
 * sandbox browser containers that are running a stale image.
 *
 * Designed to be fire-and-forget — never throws. Individual container
 * errors are caught and logged.
 */
export async function sweepStaleBrowserContainers(params: {
  browserImage: string;
  dockerNetwork?: string;
}): Promise<{ pulled: boolean; checked: number; recreated: number; failed: number }> {
  const { browserImage, dockerNetwork } = params;
  const stats = { pulled: false, checked: 0, recreated: 0, failed: 0 };

  // Step 1: Pull the latest image
  const freshImageId = await pullBrowserImage(browserImage);
  if (!freshImageId) {
    log.warn("skipping browser sweep: failed to pull or inspect browser image");
    return stats;
  }
  stats.pulled = true;

  // Step 2: List sandbox browser containers
  const containers = await listSandboxBrowserContainers({ browserImage });
  if (containers.length === 0) {
    log.info("browser sweep: no sandbox browser containers found");
    return stats;
  }

  // Step 3: Check each container's image digest
  for (const containerName of containers) {
    stats.checked++;
    try {
      const info = await inspectBrowserContainer(containerName);
      if (!info) {
        log.warn(`browser sweep: could not inspect ${containerName}, skipping`);
        stats.failed++;
        continue;
      }

      if (info.imageId === freshImageId) {
        // Container is up-to-date
        continue;
      }

      // Step 4: Recreate stale container
      log.info(
        `browser sweep: recreating ${containerName} (image ${info.imageId.slice(0, 12)} → ${freshImageId.slice(0, 12)})`,
      );
      await recreateBrowserContainer({ info, newImage: browserImage, dockerNetwork });
      stats.recreated++;
      log.info(`browser sweep: successfully recreated ${containerName}`);
    } catch (err) {
      stats.failed++;
      log.warn(`browser sweep: failed to update ${containerName}: ${String(err)}`);
    }
  }

  log.info(
    `browser sweep complete: checked=${stats.checked} recreated=${stats.recreated} failed=${stats.failed}`,
  );
  return stats;
}
