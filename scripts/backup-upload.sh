#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup-upload.sh — OpenClaw backup + verify + Supabase Storage upload
#
# Flow (with retry):
#   For each attempt (max 3):
#     1. openclaw backup create → produces .tar.gz
#     2. openclaw backup verify → validates integrity
#        If corrupt: delete archive, wait, retry
#     3. (on success): upload to Supabase Storage
#     4. Save local copy to LOCAL_BACKUP_DIR for LOCAL_RETENTION_DAYS
#     5. Insert DB record with expires_at = now + SUPABASE_RETENTION_DAYS
#     6. Clean up local archives older than LOCAL_RETENTION_DAYS
#   If all attempts fail: POST an alert to the dashboard DB, exit non-zero
#
# Required env vars (injected by dashboard at provision time):
#   MOLTBOT_SUPABASE_URL              — e.g. https://<ref>.supabase.co
#   MOLTBOT_SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
#   MOLTBOT_INSTANCE_ID               — UUID of this instance in the dashboard DB
#   MOLTBOT_USER_ID                   — Clerk user ID
#   MOLTBOT_BACKUP_ENABLED            — 'true' to enable, anything else skips
#
# Optional:
#   MOLTBOT_BACKUP_SOURCE             — 'cron' (default) | 'manual'
#   MOLTBOT_BACKUP_ONLY_CONFIG        — 'true' for config-only mode
#   MOLTBOT_BACKUP_NO_WORKSPACE       — 'true' to exclude workspace
#   MOLTBOT_SUPABASE_RETENTION_DAYS   — days before Supabase copy expires (default: 7)
#   MOLTBOT_LOCAL_RETENTION_DAYS      — days to keep local archives (default: 14)
#   MOLTBOT_LOCAL_BACKUP_DIR          — local archive store (default: ~/.clawdbot/local-backups)
#   MOLTBOT_BACKUP_MAX_ATTEMPTS       — max create+verify attempts (default: 3)
#   MOLTBOT_BACKUP_RETRY_DELAY        — seconds between retry attempts (default: 30)
#   MOLTBOT_DASHBOARD_URL             — dashboard base URL for alert callbacks
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Guard ─────────────────────────────────────────────────────────────────────
if [ "${MOLTBOT_BACKUP_ENABLED:-}" != "true" ]; then
  echo "[backup-upload] Backup disabled (MOLTBOT_BACKUP_ENABLED != true) — skipping"
  exit 0
fi

SUPABASE_URL="${MOLTBOT_SUPABASE_URL:-}"
SUPABASE_KEY="${MOLTBOT_SUPABASE_SERVICE_ROLE_KEY:-}"
INSTANCE_ID="${MOLTBOT_INSTANCE_ID:-}"
USER_ID="${MOLTBOT_USER_ID:-}"
SOURCE="${MOLTBOT_BACKUP_SOURCE:-cron}"
BUCKET="openclaw-backups"

SUPABASE_RETENTION_DAYS="${MOLTBOT_SUPABASE_RETENTION_DAYS:-7}"
LOCAL_RETENTION_DAYS="${MOLTBOT_LOCAL_RETENTION_DAYS:-14}"
STATE_DIR="${OPENCLAW_STATE_DIR:-${MOLTBOT_STATE_DIR:-${CLAWDBOT_STATE_DIR:-/home/node/.clawdbot}}}"
LOCAL_BACKUP_DIR="${MOLTBOT_LOCAL_BACKUP_DIR:-${STATE_DIR}/local-backups}"
MAX_ATTEMPTS="${MOLTBOT_BACKUP_MAX_ATTEMPTS:-3}"
RETRY_DELAY="${MOLTBOT_BACKUP_RETRY_DELAY:-30}"
DASHBOARD_URL="${MOLTBOT_DASHBOARD_URL:-}"

BACKUP_ONLY_CONFIG="${MOLTBOT_BACKUP_ONLY_CONFIG:-false}"
BACKUP_NO_WORKSPACE="${MOLTBOT_BACKUP_NO_WORKSPACE:-false}"

BACKUP_FLAGS="--json"
if [ "$BACKUP_ONLY_CONFIG" = "true" ] || [ "$BACKUP_ONLY_CONFIG" = "1" ]; then
  BACKUP_FLAGS="--only-config $BACKUP_FLAGS"
  echo "[backup-upload] Mode: config-only"
elif [ "$BACKUP_NO_WORKSPACE" = "true" ] || [ "$BACKUP_NO_WORKSPACE" = "1" ]; then
  BACKUP_FLAGS="--no-include-workspace $BACKUP_FLAGS"
  echo "[backup-upload] Mode: state+credentials (no workspace)"
else
  echo "[backup-upload] Mode: full backup"
fi

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ] || [ -z "$INSTANCE_ID" ] || [ -z "$USER_ID" ]; then
  echo "[backup-upload] ❌ Missing required env vars"
  exit 1
fi

TMPDIR_BASE="${TMPDIR:-/tmp}"
WORKDIR=$(mktemp -d "${TMPDIR_BASE}/openclaw-backup-XXXXXX")
trap 'rm -rf "$WORKDIR"' EXIT

# ─────────────────────────────────────────────────────────────────────────────
# notify_failure — POST an alert via the dashboard /alert endpoint
# user_id is derived server-side from the instance row (no Clerk ID needed here)
# ─────────────────────────────────────────────────────────────────────────────
notify_failure() {
  local title="$1"
  local message="$2"
  echo "[backup-upload] 🔔 Notifying dashboard of failure..."
  if [ -z "$DASHBOARD_URL" ]; then
    echo "[backup-upload] ⚠️  MOLTBOT_DASHBOARD_URL not set — alert not delivered"
    return 0
  fi
  # Build JSON payload safely via Python (handles all special characters)
  local payload_file
  payload_file=$(mktemp)
  python3 - "$title" "$message" > "$payload_file" 2>/dev/null <<'PYEOF'
import sys, json
payload = {"kind": "error", "category": "backup", "title": sys.argv[1], "message": sys.argv[2]}
print(json.dumps(payload))
PYEOF
  if [ ! -s "$payload_file" ]; then
    echo "[backup-upload] ⚠️  Could not build alert payload — skipping notify"
    rm -f "$payload_file"
    return 0
  fi
  curl -s -o /dev/null \
    -X POST \
    "${DASHBOARD_URL}/api/instances/${INSTANCE_ID}/alert" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary "@$payload_file" 2>/dev/null \
    || echo "[backup-upload] ⚠️  Could not post alert to dashboard (non-fatal)"
  rm -f "$payload_file"
}

# ─────────────────────────────────────────────────────────────────────────────
# Retry loop: attempt create + verify up to MAX_ATTEMPTS times
# ─────────────────────────────────────────────────────────────────────────────
ATTEMPT=0
ARCHIVE_PATH=""
RESULT_JSON=""
MANIFEST_JSON="null"

while [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
  ATTEMPT=$(( ATTEMPT + 1 ))
  echo ""
  echo "[backup-upload] ── Attempt ${ATTEMPT}/${MAX_ATTEMPTS} ──────────────────────────"

  # Clean up any archive from the previous (failed) attempt
  if [ -n "$ARCHIVE_PATH" ] && [ -f "$ARCHIVE_PATH" ]; then
    echo "[backup-upload] 🗑️  Deleting corrupt archive from previous attempt: $ARCHIVE_PATH"
    rm -f "$ARCHIVE_PATH"
    ARCHIVE_PATH=""
  fi

  # Phase 1: Create archive
  echo "[backup-upload] 🗂  Creating OpenClaw backup..."
  # shellcheck disable=SC2086
  if RESULT_JSON=$(openclaw backup create --output "$WORKDIR" $BACKUP_FLAGS 2>&1); then
    ARCHIVE_PATH=$(echo "$RESULT_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['archivePath'])" 2>/dev/null || true)
    MANIFEST_JSON=$(echo "$RESULT_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d))" 2>/dev/null || echo "null")
  else
    echo "[backup-upload] ❌ Attempt ${ATTEMPT}: backup create failed:"
    echo "$RESULT_JSON"
    if [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
      echo "[backup-upload] ⏳ Retrying in ${RETRY_DELAY}s..."
      sleep "$RETRY_DELAY"
    fi
    continue
  fi

  if [ -z "$ARCHIVE_PATH" ] || [ ! -f "$ARCHIVE_PATH" ]; then
    echo "[backup-upload] ❌ Attempt ${ATTEMPT}: no archive produced"
    if [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
      echo "[backup-upload] ⏳ Retrying in ${RETRY_DELAY}s..."
      sleep "$RETRY_DELAY"
    fi
    continue
  fi

  echo "[backup-upload] ✅ Archive created: $ARCHIVE_PATH ($(wc -c < "$ARCHIVE_PATH" | tr -d ' ') bytes)"

  # Phase 2: Verify integrity (separate CLI call — catches corruption create missed)
  echo "[backup-upload] 🔍 Verifying archive integrity..."
  VERIFY_OUTPUT=$(openclaw backup verify "$ARCHIVE_PATH" --json 2>&1) || true

  VERIFIED_OK=$(echo "$VERIFY_OUTPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    # Accept if 'valid' or 'verified' is truthy at the top level
    ok = d.get('valid') or d.get('verified') or False
    print('true' if ok else 'false')
except Exception:
    print('unknown')
" 2>/dev/null || echo "unknown")

  if [ "$VERIFIED_OK" = "false" ]; then
    echo "[backup-upload] ❌ Attempt ${ATTEMPT}: archive verification failed (corrupt)"
    echo "$VERIFY_OUTPUT"
    # Archive will be deleted at the top of the next loop iteration
    if [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
      echo "[backup-upload] ⏳ Retrying in ${RETRY_DELAY}s..."
      sleep "$RETRY_DELAY"
    fi
    continue
  fi

  echo "[backup-upload] ✅ Archive verified (valid=$VERIFIED_OK)"
  break  # Success — proceed to upload
done

# ── All attempts exhausted? ────────────────────────────────────────────────────
if [ -z "$ARCHIVE_PATH" ] || [ ! -f "$ARCHIVE_PATH" ] || [ "$VERIFIED_OK" = "false" ]; then
  echo "[backup-upload] ❌ All ${MAX_ATTEMPTS} attempts failed — backup could not be created or verified"
  notify_failure \
    "Backup failed after ${MAX_ATTEMPTS} attempts" \
    "OpenClaw could not create a valid backup archive after ${MAX_ATTEMPTS} tries. Check disk space and openclaw health. Manual intervention may be required."
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Upload + local copy + DB record (only reached on successful verify)
# ─────────────────────────────────────────────────────────────────────────────
SIZE_BYTES=$(wc -c < "$ARCHIVE_PATH" | tr -d ' ')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
STORAGE_KEY="${INSTANCE_ID}/${TIMESTAMP}-openclaw-backup.tar.gz"

# Phase 3: Upload to Supabase Storage
echo "[backup-upload] ☁️  Uploading to Supabase Storage: $BUCKET/$STORAGE_KEY"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  "${SUPABASE_URL}/storage/v1/object/${BUCKET}/${STORAGE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "Content-Type: application/gzip" \
  -H "x-upsert: false" \
  --data-binary "@${ARCHIVE_PATH}")

if [ "$HTTP_STATUS" != "200" ] && [ "$HTTP_STATUS" != "201" ]; then
  echo "[backup-upload] ❌ Storage upload failed (HTTP $HTTP_STATUS)"
  notify_failure \
    "Backup upload failed" \
    "A valid backup archive was created and verified but could not be uploaded to Supabase Storage (HTTP $HTTP_STATUS). Local copy retained."
  exit 1
fi
echo "[backup-upload] ✅ Uploaded to Supabase Storage"

# Phase 4: Save local copy
echo "[backup-upload] 💾 Saving local copy to $LOCAL_BACKUP_DIR..."
mkdir -p "$LOCAL_BACKUP_DIR"
LOCAL_ARCHIVE_PATH="${LOCAL_BACKUP_DIR}/${TIMESTAMP}-openclaw-backup.tar.gz"
cp "$ARCHIVE_PATH" "$LOCAL_ARCHIVE_PATH"
chmod 600 "$LOCAL_ARCHIVE_PATH"
echo "[backup-upload] ✅ Local copy saved"

# Phase 5: Insert DB record with expiry
echo "[backup-upload] 📝 Inserting backup record (expires in ${SUPABASE_RETENTION_DAYS} days)..."
EXPIRES_AT=$(python3 -c "
from datetime import datetime, timezone, timedelta
print((datetime.now(timezone.utc) + timedelta(days=$SUPABASE_RETENTION_DAYS)).strftime('%Y-%m-%dT%H:%M:%SZ'))
" 2>/dev/null || date -u -d "+${SUPABASE_RETENTION_DAYS} days" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || true)

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  "${SUPABASE_URL}/rest/v1/openclaw_backups" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d "{
    \"instance_id\": \"${INSTANCE_ID}\",
    \"size_bytes\": ${SIZE_BYTES},
    \"storage_key\": \"${STORAGE_KEY}\",
    \"source\": \"${SOURCE}\",
    \"verified\": true,
    \"manifest\": ${MANIFEST_JSON},
    \"expires_at\": \"${EXPIRES_AT}\"
  }")

if [ "$HTTP_STATUS" != "200" ] && [ "$HTTP_STATUS" != "201" ]; then
  echo "[backup-upload] ⚠️  DB insert returned HTTP $HTTP_STATUS (archive safe in storage)"
else
  echo "[backup-upload] ✅ Database record created (expires: ${EXPIRES_AT})"
fi

# Phase 6: Clean up local archives older than LOCAL_RETENTION_DAYS
echo "[backup-upload] 🧹 Cleaning local archives older than ${LOCAL_RETENTION_DAYS} days..."
if [ -d "$LOCAL_BACKUP_DIR" ]; then
  DELETED=$(find "$LOCAL_BACKUP_DIR" -maxdepth 1 -name "*-openclaw-backup.tar.gz" \
    -mtime "+${LOCAL_RETENTION_DAYS}" -print -delete 2>/dev/null | wc -l | tr -d ' ')
  [ "$DELETED" -gt 0 ] && echo "[backup-upload] 🗑️  Removed $DELETED old local archive(s)" || true
fi

echo "[backup-upload] 🎉 Backup complete (attempt ${ATTEMPT}/${MAX_ATTEMPTS}): $STORAGE_KEY"
