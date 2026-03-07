/**
 * Deterministic diary archive & memory pruning.
 *
 * Two complementary mechanisms keep agent memory files manageable:
 *
 * 1. **Full archive** (default every 14 days): moves `memory/diary.md`,
 *    `memory/identity-scratchpad.md`, and `memory/self-review.md` to
 *    `memory/archive/YYYY-MM/` and resets them to clean templates.  The
 *    new `diary.md` is seeded with a raw excerpt (last ~30 lines) from
 *    the old diary plus a marker pointing to the full archive.
 *
 * 2. **Size-triggered pruning** (checked every tick): if any memory file
 *    exceeds {@link MAX_MEMORY_FILE_BYTES} (30 KB), the oldest entries
 *    are moved to an overflow archive, keeping only the most recent
 *    {@link MAX_ENTRIES_TO_KEEP} entries in the hot file.  This prevents
 *    files from growing large enough to cause LLM edit failures.
 *
 * Lifecycle: started alongside the CronService in `server-cron.ts`.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveWorkspaceTemplateDir } from "../agents/workspace-templates.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("diary-archive");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default archive interval: 14 days in ms. */
export const DEFAULT_DIARY_ARCHIVE_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

/** Timer tick interval — check every 60 seconds whether an archive is due. */
const TIMER_TICK_MS = 60_000;

/** Number of tail lines to include as an excerpt in the new diary. */
const EXCERPT_TAIL_LINES = 30;

const DIARY_RELATIVE_PATH = "memory/diary.md";
const SCRATCHPAD_RELATIVE_PATH = "memory/identity-scratchpad.md";
const SELF_REVIEW_RELATIVE_PATH = "memory/self-review.md";
const ARCHIVE_STATE_FILENAME = ".diary-archive-state.json";

/** Downloads older than this are pruned from the agent workspace downloads/ folder. */
const DOWNLOADS_PRUNE_AFTER_MS = 10 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Size-triggered pruning constants
// ---------------------------------------------------------------------------

/** Prune a memory file once it exceeds this size.  30 KB keeps files
 *  comfortably within LLM edit-tool reliability bounds. */
export const MAX_MEMORY_FILE_BYTES = 30 * 1024;

/** How many most-recent entries to retain in the hot file after pruning. */
export const MAX_ENTRIES_TO_KEEP = 15;

// ---------------------------------------------------------------------------
// Download pruning
// ---------------------------------------------------------------------------

/**
 * Delete files in `<workspaceDir>/downloads/` that have not been modified
 * for longer than `maxAgeMs`. Subdirectories are left intact.
 */
async function pruneOldDownloads(
  workspaceDir: string,
  maxAgeMs: number = DOWNLOADS_PRUNE_AFTER_MS,
): Promise<void> {
  const downloadsDir = path.join(workspaceDir, "downloads");
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(downloadsDir, { withFileTypes: true });
  } catch {
    // Downloads folder doesn't exist yet — nothing to prune
    return;
  }
  const cutoffMs = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(downloadsDir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoffMs) {
        await fs.unlink(filePath);
        pruned += 1;
      }
    } catch {
      // Best-effort; skip files we can't stat or delete
    }
  }
  if (pruned > 0) {
    log.info(`diary-archive: pruned ${pruned} old download(s) from ${downloadsDir}`);
  }
}

// ---------------------------------------------------------------------------
// Entry parsing for size-triggered pruning
// ---------------------------------------------------------------------------

/**
 * Describes how entries are delimited in a particular memory file.
 * - `h3Date`: entries start with `### YYYY-MM-DD` (diary, scratchpad)
 * - `bracketDate`: entries start with `[YYYY-MM-DD` (self-review)
 */
export type EntryFormat = "h3Date" | "bracketDate";

const ENTRY_FORMAT_MAP: Record<string, EntryFormat> = {
  [DIARY_RELATIVE_PATH]: "h3Date",
  [SCRATCHPAD_RELATIVE_PATH]: "h3Date",
  [SELF_REVIEW_RELATIVE_PATH]: "bracketDate",
};

/** Regex that matches the start of a new entry for each format. */
const ENTRY_START_REGEX: Record<EntryFormat, RegExp> = {
  h3Date: /^### \d{4}-\d{2}-\d{2}/,
  bracketDate: /^\[\d{4}-\d{2}-\d{2}/,
};

/**
 * Split file content into a header (template / preamble before the first
 * entry) and an ordered list of entry strings.  Each entry includes its
 * delimiter line and all subsequent lines until the next entry or EOF.
 */
export function extractEntries(
  content: string,
  format: EntryFormat,
): { header: string; entries: string[] } {
  const lines = content.split("\n");
  const regex = ENTRY_START_REGEX[format];

  let firstEntryIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      firstEntryIdx = i;
      break;
    }
  }

  if (firstEntryIdx === -1) {
    // No entries found — entire content is header
    return { header: content, entries: [] };
  }

  const header = lines.slice(0, firstEntryIdx).join("\n");

  // Split remaining lines into entries
  const entries: string[] = [];
  let currentEntry: string[] = [];

  for (let i = firstEntryIdx; i < lines.length; i++) {
    if (regex.test(lines[i]) && currentEntry.length > 0) {
      entries.push(currentEntry.join("\n"));
      currentEntry = [];
    }
    currentEntry.push(lines[i]);
  }
  if (currentEntry.length > 0) {
    entries.push(currentEntry.join("\n"));
  }

  return { header, entries };
}

// ---------------------------------------------------------------------------
// Size-triggered pruning
// ---------------------------------------------------------------------------

export type PruneResult = {
  /** Relative path of the file that was checked. */
  file: string;
  /** Whether pruning actually occurred. */
  pruned: boolean;
  /** Number of entries moved to the overflow archive. */
  entriesMoved: number;
  /** Overflow archive path (if written). */
  overflowPath?: string;
};

/**
 * Check a single memory file.  If it exceeds {@link MAX_MEMORY_FILE_BYTES},
 * keep only the last {@link MAX_ENTRIES_TO_KEEP} entries and archive the
 * rest to `memory/archive/YYYY-MM/{type}-overflow-{date}.md`.
 */
export async function pruneMemoryFileIfNeeded(
  workspaceDir: string,
  relativePath: string,
  maxBytes: number = MAX_MEMORY_FILE_BYTES,
  maxEntries: number = MAX_ENTRIES_TO_KEEP,
): Promise<PruneResult> {
  const filePath = path.join(workspaceDir, relativePath);
  const result: PruneResult = { file: relativePath, pruned: false, entriesMoved: 0 };

  // 1. Check file size
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return result; // File doesn't exist
  }
  if (stat.size <= maxBytes) {
    return result; // Under threshold
  }

  // 2. Read and parse entries
  const format = ENTRY_FORMAT_MAP[relativePath];
  if (!format) {
    log.warn(`memory-prune: unknown entry format for ${relativePath}, skipping`);
    return result;
  }

  const content = await fs.readFile(filePath, "utf-8");
  const { header, entries } = extractEntries(content, format);

  if (entries.length <= maxEntries) {
    // Not enough entries to prune — file is big but not entry-dense.
    // This can happen if entries are very long.  We still log it.
    log.info(
      `memory-prune: ${relativePath} is ${Math.round(stat.size / 1024)}KB ` +
        `but only has ${entries.length} entries (threshold: ${maxEntries}), skipping`,
    );
    return result;
  }

  // 3. Split into cold (to archive) and hot (to keep)
  const coldEntries = entries.slice(0, entries.length - maxEntries);
  const hotEntries = entries.slice(entries.length - maxEntries);

  // 4. Write cold entries to overflow archive
  const now = new Date();
  const archiveSubdir = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}`;
  const dateSuffix = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
  const archiveDir = path.join(workspaceDir, "memory", "archive", archiveSubdir);
  await fs.mkdir(archiveDir, { recursive: true });

  // Derive basename: memory/diary.md → diary, memory/self-review.md → self-review
  const baseName = path.basename(relativePath, ".md");
  const overflowName = `${baseName}-overflow-${dateSuffix}.md`;
  const overflowPath = path.join(archiveDir, overflowName);

  // If an overflow file already exists today, append to it
  let existingOverflow = "";
  try {
    existingOverflow = await fs.readFile(overflowPath, "utf-8");
    if (!existingOverflow.endsWith("\n")) {
      existingOverflow += "\n";
    }
  } catch {
    // No existing overflow — start fresh
  }

  const overflowContent = existingOverflow + coldEntries.join("\n") + "\n";
  const tmpOverflow = `${overflowPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmpOverflow, overflowContent, "utf-8");
    await fs.rename(tmpOverflow, overflowPath);
  } catch (err) {
    await fs.unlink(tmpOverflow).catch(() => {});
    throw err;
  }

  // 5. Rewrite hot file: header + retained entries
  const hotContent = header + (header.endsWith("\n") ? "" : "\n") + hotEntries.join("\n") + "\n";
  const tmpHot = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmpHot, hotContent, "utf-8");
    await fs.rename(tmpHot, filePath);
  } catch (err) {
    await fs.unlink(tmpHot).catch(() => {});
    throw err;
  }

  result.pruned = true;
  result.entriesMoved = coldEntries.length;
  result.overflowPath = overflowPath;

  log.info(
    `memory-prune: pruned ${relativePath} — moved ${coldEntries.length} entries to ` +
      `${path.relative(workspaceDir, overflowPath)}, kept ${hotEntries.length}`,
  );

  return result;
}

/**
 * Run the size-triggered pruner on all three memory files for a workspace.
 * This is cheap to call repeatedly — it no-ops when files are small.
 */
export async function runMemoryPruneForWorkspace(workspaceDir: string): Promise<PruneResult[]> {
  const results: PruneResult[] = [];
  for (const relPath of [
    DIARY_RELATIVE_PATH,
    SCRATCHPAD_RELATIVE_PATH,
    SELF_REVIEW_RELATIVE_PATH,
  ]) {
    try {
      results.push(await pruneMemoryFileIfNeeded(workspaceDir, relPath));
    } catch (err) {
      log.warn(`memory-prune: failed to prune ${relPath} in ${workspaceDir}: ${String(err)}`);
      results.push({ file: relPath, pruned: false, entriesMoved: 0 });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Deterministic MISS → CRITICAL promotion (Fix 1)
// ---------------------------------------------------------------------------

const IDENTITY_RELATIVE_PATH = "IDENTITY.md";

/** Minimum number of MISS occurrences with the same FIX before auto-promotion. */
export const MISS_PROMOTION_THRESHOLD = 3;

export type MissPromotionResult = {
  /** Number of new CRITICAL rules added to IDENTITY.md. */
  promoted: number;
  /** The FIX texts that were promoted. */
  promotedFixes: string[];
};

/**
 * Extract MISS entries with their FIX text from self-review.md content.
 * Returns a map of normalized FIX text → occurrence count.
 */
export function countMissPatterns(selfReviewContent: string): Map<string, number> {
  const counts = new Map<string, number>();
  // Match lines like: MISS: ... FIX: <concrete fix text>
  // or: MISS: ... — FIX: <concrete fix text>
  const missFixRegex = /MISS:.*?(?:—\s*)?FIX:\s*(.+)/g;
  let match: RegExpExecArray | null;

  while ((match = missFixRegex.exec(selfReviewContent)) !== null) {
    // Normalize: trim, lowercase, collapse whitespace
    const fix = match[1].trim().toLowerCase().replace(/\s+/g, " ");
    if (fix.length > 10) {
      // Skip trivially short FIX texts
      counts.set(fix, (counts.get(fix) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * Extract existing CRITICAL rules from IDENTITY.md content.
 * Returns them as normalized lowercase strings for dedup comparison.
 */
export function extractExistingCriticalRules(identityContent: string): Set<string> {
  const rules = new Set<string>();
  // Match both plain "CRITICAL:" and markdown "**CRITICAL:**" variants
  const criticalRegex = /\*{0,2}CRITICAL:?\*{0,2}\s*(.+)/g;
  let match: RegExpExecArray | null;

  while ((match = criticalRegex.exec(identityContent)) !== null) {
    // Strip any remaining markdown bold markers from the captured text
    const cleaned = match[1].replace(/\*{2}/g, "").trim().toLowerCase().replace(/\s+/g, " ");
    if (cleaned.length > 0) {
      rules.add(cleaned);
    }
  }

  return rules;
}

/**
 * Deterministically scan self-review.md for MISS patterns that have hit
 * the promotion threshold.  For each qualifying pattern, append a
 * `CRITICAL:` rule to IDENTITY.md if not already present.
 *
 * This is the machine-enforced backstop: even if the LLM fails to
 * self-promote during its cron sessions, this function will do it.
 */
export async function promoteMissPatterns(
  workspaceDir: string,
  threshold: number = MISS_PROMOTION_THRESHOLD,
): Promise<MissPromotionResult> {
  const result: MissPromotionResult = { promoted: 0, promotedFixes: [] };

  const selfReviewPath = path.join(workspaceDir, SELF_REVIEW_RELATIVE_PATH);
  const identityPath = path.join(workspaceDir, IDENTITY_RELATIVE_PATH);

  // Read self-review
  let selfReviewContent: string;
  try {
    selfReviewContent = await fs.readFile(selfReviewPath, "utf-8");
  } catch {
    return result; // No self-review file
  }

  // Read identity
  let identityContent: string;
  try {
    identityContent = await fs.readFile(identityPath, "utf-8");
  } catch {
    return result; // No identity file
  }

  // Count MISS patterns
  const missCounts = countMissPatterns(selfReviewContent);
  const existingRules = extractExistingCriticalRules(identityContent);

  // Find patterns that qualify for promotion
  const toPromote: string[] = [];
  for (const [fix, count] of missCounts) {
    if (count >= threshold && !existingRules.has(fix)) {
      // Check if any existing rule is substantially similar (contains the key parts)
      const alreadyCovered = [...existingRules].some((existing) => {
        // Simple overlap check: if 60%+ of words match, consider it covered
        const fixWords = new Set(fix.split(" ").filter((w) => w.length > 3));
        const existingWords = new Set(existing.split(" ").filter((w) => w.length > 3));
        if (fixWords.size === 0) {
          return false;
        }
        let overlap = 0;
        for (const word of fixWords) {
          if (existingWords.has(word)) {
            overlap++;
          }
        }
        return overlap / fixWords.size > 0.6;
      });

      if (!alreadyCovered) {
        // Capitalize first letter for the CRITICAL rule
        const capitalizedFix = fix.charAt(0).toUpperCase() + fix.slice(1);
        toPromote.push(capitalizedFix);
      }
    }
  }

  if (toPromote.length === 0) {
    return result;
  }

  // Append CRITICAL rules to IDENTITY.md
  // Find or create the "## CRITICAL Rules" section
  const criticalSectionHeader = "## CRITICAL Rules";
  let newIdentityContent: string;

  if (
    identityContent.includes(criticalSectionHeader) ||
    identityContent.includes("## Critical Rules")
  ) {
    // Append after the existing section header
    const insertPoint = identityContent.includes(criticalSectionHeader)
      ? criticalSectionHeader
      : "## Critical Rules";
    const idx = identityContent.indexOf(insertPoint);
    const afterHeader = idx + insertPoint.length;
    // Find the end of the line
    const lineEnd = identityContent.indexOf("\n", afterHeader);
    const insertIdx = lineEnd === -1 ? identityContent.length : lineEnd;

    const newRules = toPromote.map((fix) => `\n- **CRITICAL:** ${fix}`).join("");

    newIdentityContent =
      identityContent.slice(0, insertIdx) + newRules + identityContent.slice(insertIdx);
  } else {
    // Create new CRITICAL Rules section before the first ## section or at end
    const newSection =
      `\n\n${criticalSectionHeader}\n` +
      toPromote.map((fix) => `\n- **CRITICAL:** ${fix}`).join("") +
      "\n";

    // Try to insert before "## How You Work" or "## Personal Preferences" or append
    const insertBefore = identityContent.indexOf("## How You Work");
    if (insertBefore !== -1) {
      newIdentityContent =
        identityContent.slice(0, insertBefore) +
        newSection +
        "\n" +
        identityContent.slice(insertBefore);
    } else {
      newIdentityContent = identityContent + newSection;
    }
  }

  // Atomic write
  const tmpPath = `${identityPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmpPath, newIdentityContent, "utf-8");
    await fs.rename(tmpPath, identityPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

  result.promoted = toPromote.length;
  result.promotedFixes = toPromote;

  log.info(
    `miss-promotion: promoted ${toPromote.length} MISS pattern(s) to CRITICAL in ` +
      `${path.basename(workspaceDir)}/IDENTITY.md: ${toPromote.join("; ")}`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

type DiaryArchiveState = {
  lastArchiveAtMs?: number;
};

async function readArchiveState(workspaceDir: string): Promise<DiaryArchiveState> {
  const statePath = path.join(workspaceDir, "memory", ARCHIVE_STATE_FILENAME);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      lastArchiveAtMs:
        typeof parsed.lastArchiveAtMs === "number" ? parsed.lastArchiveAtMs : undefined,
    };
  } catch {
    return {};
  }
}

async function writeArchiveState(workspaceDir: string, state: DiaryArchiveState): Promise<void> {
  const dir = path.join(workspaceDir, "memory");
  await fs.mkdir(dir, { recursive: true });
  const statePath = path.join(dir, ARCHIVE_STATE_FILENAME);
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

async function loadTemplateContent(relativePath: string): Promise<string> {
  const templateDir = await resolveWorkspaceTemplateDir();
  const templatePath = path.join(templateDir, relativePath);
  try {
    return await fs.readFile(templatePath, "utf-8");
  } catch {
    // Good-enough fallback if template isn't packaged
    if (relativePath.includes("diary")) {
      return "# Diary\n\n> Your reflective journal. Updated by the diary cron job.\n";
    }
    if (relativePath.includes("self-review")) {
      return "# Self-Review Log\n\n> Read on boot. Log mistakes (MISS) and successes (HIT).\n> If same MISS appears 3x, promote to CRITICAL rule.\n";
    }
    return "# Identity Scratchpad\n\n> Document reasoning behind identity changes here.\n> Archived every 2 weeks alongside the diary.\n";
  }
}

// ---------------------------------------------------------------------------
// Core archive logic
// ---------------------------------------------------------------------------

export type DiaryArchiveResult = {
  workspaceDir: string;
  diaryArchived: boolean;
  scratchpadArchived: boolean;
  selfReviewArchived: boolean;
  archivePath?: string;
  error?: string;
};

/**
 * Archive diary.md and identity-scratchpad.md for a single workspace.
 * Returns details about what was archived.
 */
export async function runDiaryArchiveForWorkspace(
  workspaceDir: string,
): Promise<DiaryArchiveResult> {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, "0");
  const dd = now.getDate().toString().padStart(2, "0");
  const archiveSubdir = `${yyyy}-${mm}`;
  const dateSuffix = `${yyyy}-${mm}-${dd}`;

  const archiveDir = path.join(workspaceDir, "memory", "archive", archiveSubdir);
  const diaryPath = path.join(workspaceDir, DIARY_RELATIVE_PATH);
  const scratchpadPath = path.join(workspaceDir, SCRATCHPAD_RELATIVE_PATH);
  const selfReviewPath = path.join(workspaceDir, SELF_REVIEW_RELATIVE_PATH);

  const result: DiaryArchiveResult = {
    workspaceDir,
    diaryArchived: false,
    scratchpadArchived: false,
    selfReviewArchived: false,
  };

  // Read existing diary content before archiving
  let oldDiaryContent = "";
  try {
    oldDiaryContent = await fs.readFile(diaryPath, "utf-8");
  } catch {
    // Diary doesn't exist — nothing to archive
  }

  // Check if diary has any real content beyond the template header
  const diaryTemplate = await loadTemplateContent("memory/diary.md");
  const hasContent =
    oldDiaryContent.trim().length > 0 && oldDiaryContent.trim() !== diaryTemplate.trim();

  if (!hasContent) {
    log.info(`diary-archive: ${workspaceDir} — diary is empty/template, skipping archive`);
    return result;
  }

  // Create archive directory
  await fs.mkdir(archiveDir, { recursive: true });
  result.archivePath = archiveDir;

  // Archive diary
  try {
    const archiveDiaryName = `diary-${dateSuffix}.md`;
    const archiveDiaryPath = path.join(archiveDir, archiveDiaryName);

    // Avoid overwriting an existing archive from the same day
    try {
      await fs.access(archiveDiaryPath);
      log.info(`diary-archive: archive already exists at ${archiveDiaryPath}, skipping diary`);
    } catch {
      await fs.writeFile(archiveDiaryPath, oldDiaryContent, "utf-8");
      result.diaryArchived = true;
      log.info(`diary-archive: archived diary → ${archiveDiaryPath}`);
    }
  } catch (err) {
    log.warn(`diary-archive: failed to archive diary: ${String(err)}`);
    result.error = `diary archive failed: ${String(err)}`;
    return result;
  }

  // Archive identity-scratchpad
  try {
    const scratchpadContent = await fs.readFile(scratchpadPath, "utf-8");
    const scratchpadTemplate = await loadTemplateContent("memory/identity-scratchpad.md");
    const scratchpadHasContent =
      scratchpadContent.trim().length > 0 && scratchpadContent.trim() !== scratchpadTemplate.trim();

    if (scratchpadHasContent) {
      const archiveScratchpadName = `scratchpad-${dateSuffix}.md`;
      const archiveScratchpadPath = path.join(archiveDir, archiveScratchpadName);

      try {
        await fs.access(archiveScratchpadPath);
        log.info(
          `diary-archive: scratchpad archive already exists at ${archiveScratchpadPath}, skipping`,
        );
      } catch {
        await fs.writeFile(archiveScratchpadPath, scratchpadContent, "utf-8");
        result.scratchpadArchived = true;
        log.info(`diary-archive: archived scratchpad → ${archiveScratchpadPath}`);
      }
    }
  } catch {
    // Scratchpad missing is fine — not an error
  }

  // Build the new diary with excerpt from old one
  const archiveRef = `memory/archive/${archiveSubdir}/diary-${dateSuffix}.md`;
  const excerpt = extractTailExcerpt(oldDiaryContent, EXCERPT_TAIL_LINES);
  const newDiaryContent = buildNewDiary(diaryTemplate, archiveRef, excerpt);

  // Reset diary to new template + excerpt
  await fs.writeFile(diaryPath, newDiaryContent, "utf-8");
  log.info(`diary-archive: reset diary with continuity excerpt`);

  // Reset identity-scratchpad to template
  if (result.scratchpadArchived) {
    const scratchpadTemplate = await loadTemplateContent("memory/identity-scratchpad.md");
    await fs.writeFile(scratchpadPath, scratchpadTemplate, "utf-8");
    log.info(`diary-archive: reset identity-scratchpad to template`);
  }

  // Archive self-review.md
  try {
    const selfReviewContent = await fs.readFile(selfReviewPath, "utf-8");
    const selfReviewTemplate = await loadTemplateContent("memory/self-review.md");
    const selfReviewHasContent =
      selfReviewContent.trim().length > 0 && selfReviewContent.trim() !== selfReviewTemplate.trim();

    if (selfReviewHasContent) {
      const archiveSelfReviewName = `self-review-${dateSuffix}.md`;
      const archiveSelfReviewPath = path.join(archiveDir, archiveSelfReviewName);

      try {
        await fs.access(archiveSelfReviewPath);
        log.info(
          `diary-archive: self-review archive already exists at ${archiveSelfReviewPath}, skipping`,
        );
      } catch {
        await fs.writeFile(archiveSelfReviewPath, selfReviewContent, "utf-8");
        result.selfReviewArchived = true;
        log.info(`diary-archive: archived self-review → ${archiveSelfReviewPath}`);
      }
    }
  } catch {
    // Self-review missing is fine — not an error
  }

  // Reset self-review to template
  if (result.selfReviewArchived) {
    const selfReviewTemplate = await loadTemplateContent("memory/self-review.md");
    await fs.writeFile(selfReviewPath, selfReviewTemplate, "utf-8");
    log.info(`diary-archive: reset self-review to template`);
  }

  // Update state
  await writeArchiveState(workspaceDir, { lastArchiveAtMs: Date.now() });

  return result;
}

// ---------------------------------------------------------------------------
// Excerpt & template helpers
// ---------------------------------------------------------------------------

/**
 * Extract the last N non-empty lines from content for use as a continuity excerpt.
 */
export function extractTailExcerpt(content: string, lineCount: number): string {
  const lines = content.split("\n");
  // Take from the tail, skipping trailing blanks
  let endIdx = lines.length;
  while (endIdx > 0 && lines[endIdx - 1].trim() === "") {
    endIdx--;
  }
  const startIdx = Math.max(0, endIdx - lineCount);
  return lines.slice(startIdx, endIdx).join("\n");
}

/**
 * Build a fresh diary.md with a reference to the archived diary and an excerpt.
 */
export function buildNewDiary(template: string, archiveRef: string, excerpt: string): string {
  const sections = [
    template.trimEnd(),
    "",
    "## Previous Period",
    `<!-- PREVIOUS_ARCHIVE: ${archiveRef} -->`,
    `> Archived to: \`${archiveRef}\``,
    "> A continuity summary will be written by the diary-post-archive job.",
    ">",
    "> **Excerpt (last entries):**",
  ];

  // Blockquote the excerpt lines
  if (excerpt.trim()) {
    for (const line of excerpt.split("\n")) {
      sections.push(`> ${line}`);
    }
  } else {
    sections.push("> _(no entries)_");
  }

  sections.push(""); // trailing newline
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Multi-agent sweep
// ---------------------------------------------------------------------------

/**
 * Run diary archive for all agent workspaces that are due, and run
 * the size-triggered memory pruner on **every** workspace regardless
 * of whether a full archive is due.
 */
export async function runDiaryArchiveSweep(
  cfg: OpenClawConfig,
  intervalMs: number = DEFAULT_DIARY_ARCHIVE_INTERVAL_MS,
): Promise<DiaryArchiveResult[]> {
  const agentIds = listAgentIds(cfg);
  const results: DiaryArchiveResult[] = [];
  const nowMs = Date.now();

  for (const agentId of agentIds) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    try {
      // Check if workspace exists
      await fs.access(workspaceDir);
    } catch {
      continue; // Workspace doesn't exist, skip
    }

    // ── Size-triggered pruning (every tick, cheap no-op when small) ──
    await runMemoryPruneForWorkspace(workspaceDir).catch((err) =>
      log.warn(`memory-prune: sweep failed for ${workspaceDir}: ${String(err)}`),
    );

    // ── Deterministic MISS → CRITICAL promotion (every tick, cheap scan) ──
    await promoteMissPatterns(workspaceDir).catch((err) =>
      log.warn(`miss-promotion: sweep failed for ${workspaceDir}: ${String(err)}`),
    );

    // ── Full archive (time-gated) ──
    const state = await readArchiveState(workspaceDir);
    if (state.lastArchiveAtMs && nowMs - state.lastArchiveAtMs < intervalMs) {
      // Not due for full archive — still do download pruning
      await pruneOldDownloads(workspaceDir).catch((err) =>
        log.warn(`diary-archive: download prune failed for ${workspaceDir}: ${String(err)}`),
      );
      continue;
    }

    try {
      const result = await runDiaryArchiveForWorkspace(workspaceDir);
      results.push(result);
    } catch (err) {
      log.warn(`diary-archive: failed for workspace ${workspaceDir}: ${String(err)}`);
      results.push({
        workspaceDir,
        diaryArchived: false,
        scratchpadArchived: false,
        selfReviewArchived: false,
        error: String(err),
      });
    }

    // Always prune old downloads regardless of whether a diary archive ran.
    await pruneOldDownloads(workspaceDir).catch((err) =>
      log.warn(`diary-archive: download prune failed for ${workspaceDir}: ${String(err)}`),
    );
  }

  if (results.length > 0) {
    const archived = results.filter((r) => r.diaryArchived).length;
    log.info(`diary-archive: sweep complete — ${archived}/${results.length} workspace(s) archived`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Timer lifecycle
// ---------------------------------------------------------------------------

let activeTimer: ReturnType<typeof setInterval> | null = null;

export type DiaryArchiveTimerDeps = {
  cfg: OpenClawConfig;
  intervalMs?: number;
};

/**
 * Start the diary archive timer. Checks every 60s whether any workspace is due.
 * Safe to call multiple times — stops any existing timer first.
 */
export function startDiaryArchiveTimer(deps: DiaryArchiveTimerDeps): void {
  stopDiaryArchiveTimer();

  const intervalMs = deps.intervalMs ?? DEFAULT_DIARY_ARCHIVE_INTERVAL_MS;

  const tick = () => {
    void runDiaryArchiveSweep(deps.cfg, intervalMs).catch((err) => {
      log.warn(`diary-archive: sweep failed unexpectedly: ${String(err)}`);
    });
  };

  activeTimer = setInterval(tick, TIMER_TICK_MS);

  // Unref so the timer doesn't prevent process exit
  if (activeTimer && typeof activeTimer === "object" && "unref" in activeTimer) {
    activeTimer.unref();
  }

  const intervalDays = Math.round(intervalMs / (24 * 60 * 60 * 1000));
  log.info(`diary-archive: timer started — archive interval is ${intervalDays} day(s)`);

  // Run an immediate check on startup
  tick();
}

/**
 * Stop the diary archive timer.
 */
export function stopDiaryArchiveTimer(): void {
  if (activeTimer !== null) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
}
