import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { isChromeReachable, resolveOpenClawUserDataDir } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { resolveProfile } from "./config.js";
import { BrowserProfileNotFoundError, toBrowserErrorResponse } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import {
  refreshResolvedBrowserConfigFromDisk,
  resolveBrowserProfileWithHotReload,
} from "./resolved-config-refresh.js";
import { createProfileAvailability } from "./server-context.availability.js";
import { PROFILE_STATUS_TAB_LIST_TIMEOUT_MS } from "./server-context.constants.js";
import { createProfileResetOps } from "./server-context.reset.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { createProfileTabOps } from "./server-context.tab-ops.js";
import type {
  BrowserServerState,
  BrowserRouteContext,
  BrowserTab,
  ContextOptions,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";

export type {
  BrowserRouteContext,
  BrowserServerState,
  BrowserTab,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";

export function listKnownProfileNames(state: BrowserServerState): string[] {
  const names = new Set(Object.keys(state.resolved.profiles));
  for (const name of state.profiles.keys()) {
    names.add(name);
  }
  return [...names];
}

async function listTabsForStatus(params: {
  ctx: ProfileContext;
  profile: ResolvedBrowserProfile;
}): Promise<BrowserTab[]> {
  const { ctx, profile } = params;
  if (profile.cdpIsLoopback) {
    return await ctx.listTabs();
  }
  return await new Promise<BrowserTab[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`profile status tab listing timed out for "${profile.name}"`));
    }, PROFILE_STATUS_TAB_LIST_TIMEOUT_MS);
    void ctx.listTabs().then(
      (tabs) => {
        clearTimeout(timer);
        resolve(tabs);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Create a profile-scoped context for browser operations.
 */
function createProfileContext(
  opts: ContextOptions,
  profile: ResolvedBrowserProfile,
): ProfileContext {
  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  const getProfileState = (): ProfileRuntimeState => {
    const current = state();
    let profileState = current.profiles.get(profile.name);
    if (!profileState) {
      profileState = { profile, running: null, lastTargetId: null, reconcile: null };
      current.profiles.set(profile.name, profileState);
    }
    return profileState;
  };

  const setProfileRunning = (running: ProfileRuntimeState["running"]) => {
    const profileState = getProfileState();
    profileState.running = running;
  };

  const { listTabs, openTab } = createProfileTabOps({
    profile,
    state,
    getProfileState,
  });

  const { ensureBrowserAvailable, isHttpReachable, isReachable, stopRunningBrowser } =
    createProfileAvailability({
      opts,
      profile,
      state,
      getProfileState,
      setProfileRunning,
    });

  const { ensureTabAvailable, focusTab, closeTab } = createProfileSelectionOps({
    profile,
    getProfileState,
    ensureBrowserAvailable,
    listTabs,
    openTab,
  });

  const { resetProfile } = createProfileResetOps({
    profile,
    getProfileState,
    stopRunningBrowser,
    isHttpReachable,
    resolveOpenClawUserDataDir,
  });

  return {
    profile,
    ensureBrowserAvailable,
    ensureTabAvailable,
    isHttpReachable,
    isReachable,
    listTabs,
    openTab,
    focusTab,
    closeTab,
    stopRunningBrowser,
    resetProfile,
  };
}

export function createBrowserRouteContext(opts: ContextOptions): BrowserRouteContext {
  const refreshConfigFromDisk = opts.refreshConfigFromDisk === true;

  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  const forProfile = (profileName?: string): ProfileContext => {
    const current = state();
    const name = profileName ?? current.resolved.defaultProfile;
    const profile = resolveBrowserProfileWithHotReload({
      current,
      refreshConfigFromDisk,
      name,
    });

    if (!profile) {
      const available = Object.keys(current.resolved.profiles).join(", ");
      throw new BrowserProfileNotFoundError(
        `Profile "${name}" not found. Available profiles: ${available || "(none)"}`,
      );
    }
    return createProfileContext(opts, profile);
  };

  const listProfiles = async (): Promise<ProfileStatus[]> => {
    const current = state();
    refreshResolvedBrowserConfigFromDisk({
      current,
      refreshConfigFromDisk,
      mode: "cached",
    });
    // Check all profiles in parallel to avoid serial CDP timeout compounding.
    // With N remote profiles checked serially, worst case is N × remoteCdpTimeoutMs;
    // parallel checks reduce this to a single timeout window.
    const profileNames = listKnownProfileNames(current);
    const result = await Promise.all(
      profileNames.map(async (name): Promise<ProfileStatus | null> => {
        const profileState = current.profiles.get(name);
        const profile = resolveProfile(current.resolved, name) ?? profileState?.profile;
        if (!profile) {
          return null;
        }
        const capabilities = getBrowserProfileCapabilities(profile);

        let tabCount = 0;
        let running = false;
        const profileCtx = createProfileContext(opts, profile);

        if (capabilities.usesChromeMcp) {
          try {
            running = await profileCtx.isReachable(300);
            if (running) {
              const tabs = await profileCtx.listTabs();
              tabCount = tabs.filter((t) => t.type === "page").length;
            }
          } catch {
            // Chrome MCP not available
          }
        } else if (profileState?.running) {
          running = true;
          try {
            const tabs = await listTabsForStatus({ ctx: profileCtx, profile });
            tabCount = tabs.filter((t) => t.type === "page").length;
          } catch {
            // Browser might not be responsive
          }
        } else {
          // Check if something is listening on the port
          try {
            const reachable = await isChromeReachable(profile.cdpUrl, 200);
            if (reachable) {
              running = true;
              const tabs = await listTabsForStatus({ ctx: profileCtx, profile }).catch(() => []);
              tabCount = tabs.filter((t) => t.type === "page").length;
            }
          } catch {
            // Not reachable
          }
        }

        return {
          name,
          transport: capabilities.usesChromeMcp ? "chrome-mcp" : "cdp",
          cdpPort: capabilities.usesChromeMcp ? null : profile.cdpPort,
          cdpUrl: capabilities.usesChromeMcp ? null : profile.cdpUrl,
          color: profile.color,
          driver: profile.driver,
          running,
          tabCount,
          isDefault: name === current.resolved.defaultProfile,
          isRemote: !profile.cdpIsLoopback,
          missingFromConfig: !(name in current.resolved.profiles) || undefined,
          reconcileReason: profileState?.reconcile?.reason ?? null,
        };
      }),
    );

    return result.filter((p): p is ProfileStatus => p !== null);
  };

  // Create default profile context for backward compatibility
  const getDefaultContext = () => forProfile();

  const mapTabError = (err: unknown) => {
    const browserMapped = toBrowserErrorResponse(err);
    if (browserMapped) {
      return browserMapped;
    }
    if (err instanceof SsrFBlockedError) {
      return { status: 400, message: err.message };
    }
    if (err instanceof InvalidBrowserNavigationUrlError) {
      return { status: 400, message: err.message };
    }
    return null;
  };

  return {
    state,
    forProfile,
    listProfiles,
    // Legacy methods delegate to default profile
    ensureBrowserAvailable: () => getDefaultContext().ensureBrowserAvailable(),
    ensureTabAvailable: (targetId) => getDefaultContext().ensureTabAvailable(targetId),
    isHttpReachable: (timeoutMs) => getDefaultContext().isHttpReachable(timeoutMs),
    isReachable: (timeoutMs) => getDefaultContext().isReachable(timeoutMs),
    listTabs: () => getDefaultContext().listTabs(),
    openTab: (url) => getDefaultContext().openTab(url),
    focusTab: (targetId) => getDefaultContext().focusTab(targetId),
    closeTab: (targetId) => getDefaultContext().closeTab(targetId),
    stopRunningBrowser: () => getDefaultContext().stopRunningBrowser(),
    resetProfile: () => getDefaultContext().resetProfile(),
    mapTabError,
  };
}
