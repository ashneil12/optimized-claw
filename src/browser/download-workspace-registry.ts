/**
 * Maps a CDP URL (normalised) to the agent workspace directory that should
 * receive automatic browser downloads for that profile.
 *
 * Set by the browser server context when a profile is initialised.
 * Read by the Playwright session layer when a download event fires.
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// CDP URL → workspace registry
// ---------------------------------------------------------------------------

const registry = new Map<string, string>();

function normalizeCdpUrlForRegistry(cdpUrl: string): string {
  return cdpUrl.trim().replace(/\/$/, "").toLowerCase();
}

/** Register (or clear) the agent workspace dir for a given CDP URL. */
export function setDownloadWorkspaceForCdp(cdpUrl: string, workspaceDir: string | null): void {
  const norm = normalizeCdpUrlForRegistry(cdpUrl);
  if (workspaceDir) {
    registry.set(norm, workspaceDir);
  } else {
    registry.delete(norm);
  }
}

/** Retrieve the registered agent workspace dir for a CDP URL, or null. */
export function getDownloadWorkspaceForCdp(cdpUrl: string): string | null {
  const norm = normalizeCdpUrlForRegistry(cdpUrl);
  return registry.get(norm) ?? null;
}

// ---------------------------------------------------------------------------
// Shared filename sanitisation
// ---------------------------------------------------------------------------

/**
 * Sanitise a browser-supplied download filename for safe filesystem use.
 *
 * - Strips directory separators (posix + win32) to block path traversal
 * - Strips C0 control characters and DEL
 * - Normalises dots-only / empty names to a fallback
 * - Clamps length to 200 characters
 *
 * This is the single source of truth used by both the explicit `download`
 * command and the automatic post-click download capture.
 */
export function sanitizeDownloadFilename(fileName: string): string {
  const trimmed = String(fileName ?? "").trim();
  if (!trimmed) {
    return "download.bin";
  }
  // Force basename on both platforms to strip any path separators.
  let base = path.posix.basename(trimmed);
  base = path.win32.basename(base);
  // Strip control characters (C0 range + DEL) character by character.
  let cleaned = "";
  for (let i = 0; i < base.length; i++) {
    const code = base.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    cleaned += base[i];
  }
  base = cleaned.trim();
  if (!base || base === "." || base === "..") {
    return "download.bin";
  }
  if (base.length > 200) {
    base = base.slice(0, 200);
  }
  return base;
}

/**
 * Like `sanitizeDownloadFilename` but appends a millisecond timestamp before
 * the extension to avoid collisions when the agent downloads the same file
 * multiple times. Used exclusively by auto-download capture.
 */
export function sanitizeAutoDownloadFilename(fileName: string): string {
  const base = sanitizeDownloadFilename(fileName);
  const ts = Date.now();
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  return `${stem}-${ts}${ext}`;
}
