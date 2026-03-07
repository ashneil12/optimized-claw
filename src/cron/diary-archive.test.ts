import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractEntries,
  pruneMemoryFileIfNeeded,
  countMissPatterns,
  extractExistingCriticalRules,
  promoteMissPatterns,
  type EntryFormat,
  type PruneResult,
} from "./diary-archive.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "diary-archive-test-"));
  // Create memory/archive structure
  await fs.mkdir(path.join(tmpDir, "memory", "archive"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Generate a diary-style entry (### YYYY-MM-DD HH:MM UTC — Title). */
function diaryEntry(day: number, content = "Some reflection text."): string {
  const dd = day.toString().padStart(2, "0");
  return `### 2026-03-${dd} 12:00 UTC — Consciousness pass\n\n${content}\n\n---\n`;
}

/** Generate a self-review-style entry ([YYYY-MM-DD]). */
function selfReviewEntry(day: number, content = "TAG: [depth] HIT: Good. KEEP: this."): string {
  const dd = day.toString().padStart(2, "0");
  return `[2026-03-${dd}]\n\n${content}\n`;
}

/** Generate a scratchpad-style entry (### YYYY-MM-DD HH:MM UTC — Review). */
function scratchpadEntry(day: number, content = "No changes to IDENTITY.md."): string {
  const dd = day.toString().padStart(2, "0");
  return `### 2026-03-${dd} 06:00 UTC — Identity review (no-change)\n\n- **What changed:** ${content}\n`;
}

const DIARY_HEADER = `# Diary

> Your reflective journal.
> Archived automatically when the file grows large.

---

## Entries

`;

const SELF_REVIEW_HEADER = `# Self-Review Log

> Read on boot. Log mistakes (MISS) and successes (HIT).
> If same MISS appears 3x, promote to CRITICAL rule.

---

## Log

`;

const SCRATCHPAD_HEADER = `# Identity Scratchpad

> WHY you added things to IDENTITY.md.
> Read during identity reviews to evaluate whether entries still make sense.

---

## Notes

`;

// ---------------------------------------------------------------------------
// extractEntries tests
// ---------------------------------------------------------------------------

describe("extractEntries", () => {
  it("parses diary entries (h3Date format)", () => {
    const content = DIARY_HEADER + diaryEntry(1) + diaryEntry(2) + diaryEntry(3);
    const { header, entries } = extractEntries(content, "h3Date");

    expect(header).toBe(DIARY_HEADER.slice(0, -1)); // trailing \n is in the join
    expect(entries).toHaveLength(3);
    expect(entries[0]).toContain("2026-03-01");
    expect(entries[2]).toContain("2026-03-03");
  });

  it("parses self-review entries (bracketDate format)", () => {
    const content = SELF_REVIEW_HEADER + selfReviewEntry(5) + selfReviewEntry(6);
    const { header, entries } = extractEntries(content, "bracketDate");

    expect(header).toBe(SELF_REVIEW_HEADER.slice(0, -1));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain("[2026-03-05]");
    expect(entries[1]).toContain("[2026-03-06]");
  });

  it("parses scratchpad entries (h3Date format)", () => {
    const content = SCRATCHPAD_HEADER + scratchpadEntry(1) + scratchpadEntry(2);
    const { header, entries } = extractEntries(content, "h3Date");

    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain("2026-03-01");
  });

  it("returns no entries for header-only content", () => {
    const { header, entries } = extractEntries(DIARY_HEADER, "h3Date");

    expect(header).toBe(DIARY_HEADER);
    expect(entries).toHaveLength(0);
  });

  it("returns entire content as header when no entries match format", () => {
    const content = "Just some random text\nWith no date headers";
    const { header, entries } = extractEntries(content, "h3Date");

    expect(header).toBe(content);
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pruneMemoryFileIfNeeded tests
// ---------------------------------------------------------------------------

describe("pruneMemoryFileIfNeeded", () => {
  it("skips files under the size threshold", async () => {
    const filePath = path.join(tmpDir, "memory", "diary.md");
    await fs.writeFile(filePath, DIARY_HEADER + diaryEntry(1));

    const result = await pruneMemoryFileIfNeeded(tmpDir, "memory/diary.md", 100_000, 5);

    expect(result.pruned).toBe(false);
    expect(result.entriesMoved).toBe(0);
  });

  it("skips non-existent files", async () => {
    const result = await pruneMemoryFileIfNeeded(tmpDir, "memory/diary.md");

    expect(result.pruned).toBe(false);
  });

  it("prunes diary.md when over threshold", async () => {
    // Generate 20 entries, each ~500 bytes, with a low threshold
    const entries = Array.from({ length: 20 }, (_, i) =>
      diaryEntry(i + 1, "A".repeat(400)),
    );
    const content = DIARY_HEADER + entries.join("");
    const filePath = path.join(tmpDir, "memory", "diary.md");
    await fs.writeFile(filePath, content);

    // Set threshold very low so pruning triggers, keep last 5
    const result = await pruneMemoryFileIfNeeded(tmpDir, "memory/diary.md", 1, 5);

    expect(result.pruned).toBe(true);
    expect(result.entriesMoved).toBe(15);
    expect(result.overflowPath).toBeTruthy();

    // Verify hot file has header + 5 entries
    const hotContent = await fs.readFile(filePath, "utf-8");
    const { header, entries: hotEntries } = extractEntries(hotContent, "h3Date");
    expect(header).toContain("# Diary");
    expect(hotEntries).toHaveLength(5);
    // Should be the last 5 (days 16-20)
    expect(hotEntries[0]).toContain("2026-03-16");
    expect(hotEntries[4]).toContain("2026-03-20");

    // Verify overflow file has 15 entries
    const overflowContent = await fs.readFile(result.overflowPath!, "utf-8");
    const { entries: overflowEntries } = extractEntries(overflowContent, "h3Date");
    expect(overflowEntries).toHaveLength(15);
    expect(overflowEntries[0]).toContain("2026-03-01");
  });

  it("prunes self-review.md with bracketDate format", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      selfReviewEntry(i + 1, "TAG: [scope] MISS: " + "B".repeat(300)),
    );
    const content = SELF_REVIEW_HEADER + entries.join("");
    const filePath = path.join(tmpDir, "memory", "self-review.md");
    await fs.writeFile(filePath, content);

    const result = await pruneMemoryFileIfNeeded(tmpDir, "memory/self-review.md", 1, 3);

    expect(result.pruned).toBe(true);
    expect(result.entriesMoved).toBe(7);

    // Hot file should have header + 3 entries
    const hotContent = await fs.readFile(filePath, "utf-8");
    const { entries: hotEntries } = extractEntries(hotContent, "bracketDate");
    expect(hotEntries).toHaveLength(3);
    expect(hotEntries[0]).toContain("[2026-03-08]");
  });

  it("prunes identity-scratchpad.md", async () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      scratchpadEntry(i + 1, "No change. " + "C".repeat(300)),
    );
    const content = SCRATCHPAD_HEADER + entries.join("");
    const filePath = path.join(tmpDir, "memory", "identity-scratchpad.md");
    await fs.writeFile(filePath, content);

    const result = await pruneMemoryFileIfNeeded(
      tmpDir,
      "memory/identity-scratchpad.md",
      1,
      4,
    );

    expect(result.pruned).toBe(true);
    expect(result.entriesMoved).toBe(8);
  });

  it("preserves header after pruning", async () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      diaryEntry(i + 1, "X".repeat(200)),
    );
    const content = DIARY_HEADER + entries.join("");
    const filePath = path.join(tmpDir, "memory", "diary.md");
    await fs.writeFile(filePath, content);

    await pruneMemoryFileIfNeeded(tmpDir, "memory/diary.md", 1, 3);

    const hotContent = await fs.readFile(filePath, "utf-8");
    expect(hotContent).toContain("# Diary");
    expect(hotContent).toContain("reflective journal");
    expect(hotContent).toContain("## Entries");
  });

  it("does not prune when entry count is below threshold", async () => {
    // File is large (over maxBytes) but has few entries
    const content = DIARY_HEADER + diaryEntry(1, "Z".repeat(5000));
    const filePath = path.join(tmpDir, "memory", "diary.md");
    await fs.writeFile(filePath, content);

    const result = await pruneMemoryFileIfNeeded(tmpDir, "memory/diary.md", 1, 5);

    expect(result.pruned).toBe(false);
    expect(result.entriesMoved).toBe(0);
  });

  it("appends to existing overflow file on same day", async () => {
    // Create an existing overflow file
    const now = new Date();
    const archiveSubdir = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}`;
    const dateSuffix = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
    const overflowDir = path.join(tmpDir, "memory", "archive", archiveSubdir);
    await fs.mkdir(overflowDir, { recursive: true });
    const overflowPath = path.join(overflowDir, `diary-overflow-${dateSuffix}.md`);
    await fs.writeFile(overflowPath, "### 2026-02-28 — Old overflow entry\n\nPrevious overflow.\n");

    // Create a file that needs pruning
    const entries = Array.from({ length: 10 }, (_, i) =>
      diaryEntry(i + 1, "D".repeat(200)),
    );
    const filePath = path.join(tmpDir, "memory", "diary.md");
    await fs.writeFile(filePath, DIARY_HEADER + entries.join(""));

    await pruneMemoryFileIfNeeded(tmpDir, "memory/diary.md", 1, 3);

    // Overflow should contain previous content + new cold entries
    const overflowContent = await fs.readFile(overflowPath, "utf-8");
    expect(overflowContent).toContain("Old overflow entry");
    expect(overflowContent).toContain("2026-03-01");
  });
});

// ---------------------------------------------------------------------------
// countMissPatterns tests
// ---------------------------------------------------------------------------

describe("countMissPatterns", () => {
  it("counts unique MISS FIX patterns", () => {
    const content = `
[2026-03-01] MISS: Didn't check API status — FIX: Always verify API health before calling
[2026-03-02] MISS: Same issue again — FIX: Always verify API health before calling
[2026-03-03] MISS: Third time — FIX: Always verify API health before calling
[2026-03-04] MISS: Different issue — FIX: Check file existence before reading
`;
    const counts = countMissPatterns(content);
    expect(counts.get("always verify api health before calling")).toBe(3);
    expect(counts.get("check file existence before reading")).toBe(1);
  });

  it("ignores trivially short FIX texts", () => {
    const content = "MISS: thing — FIX: do it";
    const counts = countMissPatterns(content);
    expect(counts.size).toBe(0);
  });

  it("normalizes whitespace and case", () => {
    const content = `
MISS: a — FIX: Always  CHECK  the  Status  First
MISS: b — FIX: always check the status first
`;
    const counts = countMissPatterns(content);
    expect(counts.get("always check the status first")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// extractExistingCriticalRules tests
// ---------------------------------------------------------------------------

describe("extractExistingCriticalRules", () => {
  it("extracts existing CRITICAL rules", () => {
    const content = `
## CRITICAL Rules

- **CRITICAL:** Always verify API health before calling
- **CRITICAL:** Never deploy without tests
`;
    const rules = extractExistingCriticalRules(content);
    expect(rules.has("always verify api health before calling")).toBe(true);
    expect(rules.has("never deploy without tests")).toBe(true);
  });

  it("returns empty set for no CRITICAL rules", () => {
    const content = "# IDENTITY.md\n\nJust normal content";
    const rules = extractExistingCriticalRules(content);
    expect(rules.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// promoteMissPatterns tests
// ---------------------------------------------------------------------------

describe("promoteMissPatterns", () => {
  it("promotes MISS patterns that hit threshold", async () => {
    // Create self-review with 3x same MISS
    const selfReview = `
[2026-03-01] MISS: Failed to check — FIX: Always verify API health before operations
[2026-03-02] MISS: Same thing — FIX: Always verify API health before operations
[2026-03-03] MISS: Again — FIX: Always verify API health before operations
`;
    await fs.writeFile(
      path.join(tmpDir, "memory", "self-review.md"),
      selfReview,
    );

    // Create identity without CRITICAL section
    const identity = `# IDENTITY.md\n\n## How You Work\n\n- Does stuff\n`;
    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), identity);

    const result = await promoteMissPatterns(tmpDir, 3);

    expect(result.promoted).toBe(1);
    expect(result.promotedFixes).toHaveLength(1);
    expect(result.promotedFixes[0]).toContain("verify api health");

    // Verify IDENTITY.md was updated
    const updatedIdentity = await fs.readFile(
      path.join(tmpDir, "IDENTITY.md"),
      "utf-8",
    );
    expect(updatedIdentity).toContain("CRITICAL Rules");
    expect(updatedIdentity).toContain("CRITICAL:");
    expect(updatedIdentity).toContain("verify api health");
  });

  it("skips patterns below threshold", async () => {
    const selfReview = `
[2026-03-01] MISS: Failed — FIX: Always verify API health before operations
[2026-03-02] MISS: Again — FIX: Always verify API health before operations
`;
    await fs.writeFile(
      path.join(tmpDir, "memory", "self-review.md"),
      selfReview,
    );
    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), "# IDENTITY\n");

    const result = await promoteMissPatterns(tmpDir, 3);
    expect(result.promoted).toBe(0);
  });

  it("skips patterns already in IDENTITY.md", async () => {
    const selfReview = `
[2026-03-01] MISS: x — FIX: Always verify API health before operations
[2026-03-02] MISS: x — FIX: Always verify API health before operations
[2026-03-03] MISS: x — FIX: Always verify API health before operations
`;
    await fs.writeFile(
      path.join(tmpDir, "memory", "self-review.md"),
      selfReview,
    );

    const identity = `# IDENTITY\n\n## CRITICAL Rules\n\n- **CRITICAL:** Always verify API health before operations\n`;
    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), identity);

    const result = await promoteMissPatterns(tmpDir, 3);
    expect(result.promoted).toBe(0);
  });

  it("appends to existing CRITICAL Rules section", async () => {
    const selfReview = `
[2026-03-01] MISS: x — FIX: Check file existence before reading it
[2026-03-02] MISS: x — FIX: Check file existence before reading it
[2026-03-03] MISS: x — FIX: Check file existence before reading it
`;
    await fs.writeFile(
      path.join(tmpDir, "memory", "self-review.md"),
      selfReview,
    );

    const identity = `# IDENTITY\n\n## CRITICAL Rules\n\n- **CRITICAL:** Existing rule about something\n\n## How You Work\n`;
    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), identity);

    const result = await promoteMissPatterns(tmpDir, 3);
    expect(result.promoted).toBe(1);

    const updatedIdentity = await fs.readFile(
      path.join(tmpDir, "IDENTITY.md"),
      "utf-8",
    );
    expect(updatedIdentity).toContain("Existing rule about something");
    expect(updatedIdentity).toContain("file existence");
  });

  it("no-ops when self-review.md is missing", async () => {
    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), "# IDENTITY\n");
    const result = await promoteMissPatterns(tmpDir, 3);
    expect(result.promoted).toBe(0);
  });

  it("no-ops when IDENTITY.md is missing", async () => {
    await fs.writeFile(
      path.join(tmpDir, "memory", "self-review.md"),
      "MISS: x — FIX: do something important here\nMISS: x — FIX: do something important here\nMISS: x — FIX: do something important here\n",
    );
    const result = await promoteMissPatterns(tmpDir, 3);
    expect(result.promoted).toBe(0);
  });

  it("skips substantially similar existing rules", async () => {
    const selfReview = `
MISS: x — FIX: Always verify the API health status before calling
MISS: x — FIX: Always verify the API health status before calling
MISS: x — FIX: Always verify the API health status before calling
`;
    await fs.writeFile(
      path.join(tmpDir, "memory", "self-review.md"),
      selfReview,
    );

    // Existing rule is similar but not identical
    const identity = `# IDENTITY\n\n## CRITICAL Rules\n\n- **CRITICAL:** Always verify API health before calling endpoints\n`;
    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), identity);

    const result = await promoteMissPatterns(tmpDir, 3);
    // Should detect similarity and skip
    expect(result.promoted).toBe(0);
  });
});
