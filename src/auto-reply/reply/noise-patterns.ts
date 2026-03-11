/**
 * Shared noise-filtering primitives for session transcript processing.
 *
 * These patterns identify lines injected by the OpenClaw runtime into the
 * "user" role of a conversation transcript that are NOT typed by a human.
 * Both the trajectory compressor and the legacy session-context extractor
 * import from here to guarantee they stay in sync.
 *
 * Patterns covered:
 *  - `Sender (untrusted metadata):` — channel/sender metadata injections
 *  - `[SYSTEM: ...]` — system prompt injections (BOOTSTRAP.md, heartbeat triggers, etc.)
 *  - Bare `HEARTBEAT_OK` / `HEARTBEAT` — cron-driven heartbeat acknowledgements
 *  - JSON blobs with a `"label"` or `"openclaw-control-ui"` key — UI control metadata
 */
export const NOISE_LINE_PATTERNS: readonly RegExp[] = [
  /^Sender\s*\(untrusted metadata\)\s*:?\s*$/i,
  /^\s*\[SYSTEM:/i,
  /^\s*HEARTBEAT_OK\s*$/i,
  /^\s*HEARTBEAT\s*$/i,
  // JSON blobs that are metadata payloads (start with { and have a "label" or "id" key)
  /^\s*\{[^}]*"label"\s*:/i,
  /^\s*\{[^}]*"openclaw-control-ui"/i,
];

/**
 * Minimum character count for cleaned user content to be considered a real
 * human message (not just noise residue).
 */
export const MEANINGFUL_CONTENT_MIN_CHARS = 4;

/**
 * Strip known system-injected noise patterns from the text of a user message.
 * Drops lines that match any noise pattern and trims the result.
 * Returns an empty string if the entire message was noise.
 */
export function cleanUserContent(text: string): string {
  const lines = text.split("\n");
  const cleaned = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }
    return !NOISE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
  });
  return cleaned.join("\n").trim();
}

/**
 * Returns true if the (already-cleaned) user content represents a real human
 * message — i.e. has enough text to convey intent.
 */
export function isMeaningfulUserContent(text: string): boolean {
  return text.trim().length >= MEANINGFUL_CONTENT_MIN_CHARS;
}
