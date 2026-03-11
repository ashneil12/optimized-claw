#!/usr/bin/env bash
# workspace-doc-converter.sh
#
# Deterministic, LLM-free file converter for the OpenClaw workspace.
# Watches WORKSPACE_DIR for non-markdown files and auto-converts them
# to markdown so that QMD can index them.
#
# Supported formats:
#   .pdf  → pdftotext (poppler-utils)
#   .txt  → direct copy with header
#   .docx .odt .rtf .epub → pandoc
#   .csv  → lightweight TSV-style markdown table
#
# The output .md file is placed alongside the original with the same basename:
#   business/plan.pdf → business/plan.md
#
# A marker comment at the top of the output file identifies the source.
# Re-runs are idempotent: if the .md already exists and is newer than the
# source, it is skipped (unless FORCE=1 is set).
#
# Usage:
#   workspace-doc-converter.sh [--once] [--force] [--interval <seconds>]
#
#   --once        Run a single pass then exit (useful for testing)
#   --force       Re-convert even if .md is already up to date
#   --interval N  Poll interval in seconds (default: 300 = 5 minutes)
#
# Environment:
#   WORKSPACE_DIR   Path to the agent workspace (default: /home/node/workspace)
#   CONVERTER_LOG   Log file path (default: $WORKSPACE_DIR/converter-log/converter.log)

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${CLAWDBOT_WORKSPACE_DIR:-/home/node/workspace}}"
POLL_INTERVAL=300
RUN_ONCE=false
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --once)     RUN_ONCE=true ;;
    --force)    FORCE=true ;;
    --interval) shift; POLL_INTERVAL="$1" ;;
  esac
done

LOG_DIR="${WORKSPACE_DIR}/converter-log"
LOG_FILE="${CONVERTER_LOG:-${LOG_DIR}/converter.log}"
MAX_LOG_BYTES=524288  # 512 KB — rotate when exceeded

# ─── Helpers ─────────────────────────────────────────────────────────────────

log() {
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "[${ts}] $*" | tee -a "$LOG_FILE"
}

rotate_log_if_needed() {
  if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$MAX_LOG_BYTES" ]; then
    mv "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null || true
    log "Log rotated."
  fi
}

# Write a standard source header for the converted file.
source_header() {
  local src_path="$1"
  local fmt="$2"
  cat <<HEADER
<!-- AUTO-CONVERTED: This is a markdown version of the original file.
     Source: ${src_path}
     Format: ${fmt}
     Converted: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
     To update, delete this file and re-run the converter, or wait for the
     next automatic conversion cycle. -->

HEADER
}

# Returns 0 if the .md output is already up to date (newer than source).
is_up_to_date() {
  local src="$1"
  local out="$2"
  if [ "$FORCE" = "true" ]; then
    return 1  # always reconvert
  fi
  if [ ! -f "$out" ]; then
    return 1  # no output yet
  fi
  # Compare modification times: if source is newer, reconvert.
  if [ "$src" -nt "$out" ]; then
    return 1
  fi
  # Check that the output starts with our marker (not a user-created file).
  if ! head -1 "$out" 2>/dev/null | grep -q "AUTO-CONVERTED"; then
    return 0  # user-created .md alongside the source — don't overwrite it
  fi
  return 0  # already up to date
}

# ─── Converters ───────────────────────────────────────────────────────────────

convert_pdf() {
  local src="$1" out="$2"
  if ! command -v pdftotext &>/dev/null; then
    log "SKIP $src — pdftotext not found (install poppler-utils)"
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  if pdftotext -layout "$src" "$tmp" 2>/dev/null; then
    {
      source_header "$src" "PDF"
      cat "$tmp"
    } > "$out"
    log "OK   $src → $out (pdftotext)"
  else
    log "FAIL $src — pdftotext returned an error"
  fi
  rm -f "$tmp"
}

convert_txt() {
  local src="$1" out="$2"
  {
    source_header "$src" "plain text"
    cat "$src"
  } > "$out"
  log "OK   $src → $out (txt)"
}

convert_pandoc() {
  local src="$1" out="$2" fmt="$3"
  if ! command -v pandoc &>/dev/null; then
    log "SKIP $src — pandoc not found"
    return 0
  fi
  local tmp
  tmp="$(mktemp --suffix=.md)"
  if pandoc --from="$fmt" --to=gfm --wrap=none -o "$tmp" "$src" 2>/dev/null; then
    {
      source_header "$src" "$fmt"
      cat "$tmp"
    } > "$out"
    log "OK   $src → $out (pandoc/$fmt)"
  else
    log "FAIL $src — pandoc/$fmt returned an error"
  fi
  rm -f "$tmp"
}

convert_csv() {
  local src="$1" out="$2"
  # Lightweight CSV → markdown table using awk.
  # Handles basic comma-separated values; does not handle quoted fields with
  # embedded commas (use pandoc for those).
  local tmp
  tmp="$(mktemp)"
  awk -F',' '
    NR==1 {
      # Header row
      hdr = "|"
      sep = "|"
      for (i=1; i<=NF; i++) {
        gsub(/^[ \t]+|[ \t]+$/, "", $i)
        hdr = hdr " " $i " |"
        sep = sep " --- |"
      }
      print hdr
      print sep
      next
    }
    {
      row = "|"
      for (i=1; i<=NF; i++) {
        gsub(/^[ \t]+|[ \t]+$/, "", $i)
        row = row " " $i " |"
      }
      print row
    }
  ' "$src" > "$tmp"
  {
    source_header "$src" "CSV"
    cat "$tmp"
  } > "$out"
  rm -f "$tmp"
  log "OK   $src → $out (csv→table)"
}

# ─── Main scan loop ───────────────────────────────────────────────────────────

run_pass() {
  if [ ! -d "$WORKSPACE_DIR" ]; then
    log "WARN workspace dir not found: $WORKSPACE_DIR — skipping"
    return 0
  fi

  local count=0

  # Use find to locate convertible files. Exclude:
  #   - Hidden directories (e.g. .git)
  #   - The converter-log directory itself
  #   - node_modules
  while IFS= read -r -d '' src; do
    local ext="${src##*.}"
    local out="${src%.*}.md"

    # Skip if an up-to-date .md already exists.
    if is_up_to_date "$src" "$out"; then
      continue
    fi

    case "$ext" in
      pdf)        convert_pdf    "$src" "$out" ;;
      txt)        convert_txt    "$src" "$out" ;;
      docx)       convert_pandoc "$src" "$out" "docx" ;;
      odt)        convert_pandoc "$src" "$out" "odt"  ;;
      rtf)        convert_pandoc "$src" "$out" "rtf"  ;;
      epub)       convert_pandoc "$src" "$out" "epub" ;;
      csv)        convert_csv    "$src" "$out" ;;
      *)          continue ;;
    esac

    count=$((count + 1))
  done < <(find "$WORKSPACE_DIR" \
    \( -name ".*" -o -name "converter-log" -o -name "node_modules" \) -prune \
    -o \( -name "*.pdf" -o -name "*.txt" -o -name "*.docx" \
          -o -name "*.odt" -o -name "*.rtf" -o -name "*.epub" \
          -o -name "*.csv" \) \
    -type f -print0)

  if [ "$count" -gt 0 ]; then
    log "Pass complete — converted ${count} file(s)"
  fi
}

# ─── Entrypoint ───────────────────────────────────────────────────────────────

mkdir -p "$LOG_DIR"
rotate_log_if_needed
log "workspace-doc-converter starting (workspace: $WORKSPACE_DIR, interval: ${POLL_INTERVAL}s)"

if [ "$RUN_ONCE" = "true" ]; then
  run_pass
  exit 0
fi

# Polling loop.
while true; do
  rotate_log_if_needed
  run_pass
  sleep "$POLL_INTERVAL"
done
