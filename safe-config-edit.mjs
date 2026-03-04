#!/usr/bin/env node
// =============================================================================
// safe-config-edit.mjs — Safe config editor for AI agents
//
// Provides guardrailed JSON editing for openclaw.json. Agents should use this
// instead of raw shell commands, python3 -c, or node -e for config edits.
//
// Usage:
//   node safe-config-edit.mjs get  <json-path>
//   node safe-config-edit.mjs set  <json-path> <json-value>
//   node safe-config-edit.mjs remove <json-path> [--force]
//   node safe-config-edit.mjs validate
//   node safe-config-edit.mjs diff   (show diff between current and last backup)
//
// Options:
//   --config <path>   Config file path (default: /home/node/data/openclaw.json)
//   --dry-run         Show what would change without writing
//   --force           Required for remove operations (safety guard)
//
// Examples:
//   node safe-config-edit.mjs get "channels.telegram.accounts.jael"
//   node safe-config-edit.mjs set "channels.telegram.accounts.jael.streaming" '"partial"'
//   node safe-config-edit.mjs set "channels.telegram.accounts.jael.pairedUsers" '["5734948778"]'
//   node safe-config-edit.mjs remove "channels.telegram.accounts.jael.streaming" --force
// =============================================================================

import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Helpers ─────────────────────────────────────────────────────────────────

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function die(msg) {
  console.error(`${RED}✖ ${msg}${RESET}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`${YELLOW}⚠ ${msg}${RESET}`);
}

function info(msg) {
  console.log(`${CYAN}ℹ ${msg}${RESET}`);
}

function success(msg) {
  console.log(`${GREEN}✔ ${msg}${RESET}`);
}

/**
 * Navigate into an object by dot-separated path.
 * Returns { parent, key, value, exists }.
 */
function navigatePath(obj, path) {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current == null || typeof current !== "object") {
      return { parent: null, key: keys[keys.length - 1], value: undefined, exists: false };
    }
    current = current[keys[i]];
  }
  const key = keys[keys.length - 1];
  if (current == null || typeof current !== "object") {
    return { parent: null, key, value: undefined, exists: false };
  }
  return {
    parent: current,
    key,
    value: current[key],
    exists: Object.prototype.hasOwnProperty.call(current, key),
  };
}

/**
 * Set a value at a dot-separated path, creating intermediate objects as needed.
 */
function setAtPath(obj, path, value) {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] == null || typeof current[keys[i]] !== "object") {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Delete a key at a dot-separated path.
 */
function deleteAtPath(obj, path) {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current == null || typeof current !== "object") {
      return false;
    }
    current = current[keys[i]];
  }
  if (current == null || typeof current !== "object") {
    return false;
  }
  const key = keys[keys.length - 1];
  if (!Object.prototype.hasOwnProperty.call(current, key)) {
    return false;
  }
  delete current[key];
  return true;
}

/**
 * Compute a simple structural diff between two objects at a given path prefix.
 * Returns an array of { path, type: 'added'|'removed'|'changed', old?, new? }.
 */
function diffObjects(oldObj, newObj, prefix = "") {
  const changes = [];
  const allKeys = new Set([
    ...(oldObj && typeof oldObj === "object" ? Object.keys(oldObj) : []),
    ...(newObj && typeof newObj === "object" ? Object.keys(newObj) : []),
  ]);

  for (const key of allKeys) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const oldVal = oldObj?.[key];
    const newVal = newObj?.[key];

    if (oldVal === undefined && newVal !== undefined) {
      changes.push({ path: fullPath, type: "added", new: newVal });
    } else if (oldVal !== undefined && newVal === undefined) {
      changes.push({ path: fullPath, type: "removed", old: oldVal });
    } else if (
      typeof oldVal === "object" &&
      oldVal !== null &&
      typeof newVal === "object" &&
      newVal !== null
    ) {
      if (Array.isArray(oldVal) || Array.isArray(newVal)) {
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          changes.push({ path: fullPath, type: "changed", old: oldVal, new: newVal });
        }
      } else {
        changes.push(...diffObjects(oldVal, newVal, fullPath));
      }
    } else if (oldVal !== newVal) {
      changes.push({ path: fullPath, type: "changed", old: oldVal, new: newVal });
    }
  }

  return changes;
}

function formatDiff(changes) {
  if (changes.length === 0) {
    return `${DIM}(no changes)${RESET}`;
  }
  return changes
    .map((c) => {
      const val = (v) => (typeof v === "object" ? JSON.stringify(v) : String(v));
      switch (c.type) {
        case "added":
          return `  ${GREEN}+ ${c.path}: ${val(c.new)}${RESET}`;
        case "removed":
          return `  ${RED}- ${c.path}: ${val(c.old)}${RESET}`;
        case "changed":
          return `  ${YELLOW}~ ${c.path}: ${val(c.old)} → ${val(c.new)}${RESET}`;
        default:
          return "";
      }
    })
    .join("\n");
}

/**
 * Rotate backups and write config atomically.
 * Writes to a temp file first, validates, then renames.
 */
function safeWriteConfig(configPath, config) {
  const json = JSON.stringify(config, null, 2) + "\n";

  // Validate the output before touching the original file
  try {
    JSON.parse(json);
  } catch {
    die("INTERNAL ERROR: Generated output is not valid JSON — aborting write");
  }

  // Rotate backups: .bak → .bak.1, current → .bak
  const bak = configPath + ".bak";
  const bak1 = configPath + ".bak.1";
  try {
    if (existsSync(bak)) {
      copyFileSync(bak, bak1);
    }
    if (existsSync(configPath)) {
      copyFileSync(configPath, bak);
    }
  } catch (err) {
    warn(`Backup rotation failed: ${err.message}`);
  }

  // Atomic write: write to temp, then rename
  const tmpPath = join(tmpdir(), `openclaw-edit-${Date.now()}.json`);
  try {
    writeFileSync(tmpPath, json);
    renameSync(tmpPath, configPath);
  } catch {
    // renameSync can fail across mount points — fall back to direct write
    try {
      writeFileSync(configPath, json);
    } catch (writeErr) {
      die(`Failed to write config: ${writeErr.message}`);
    }
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdGet(configPath, jsonPath) {
  if (!existsSync(configPath)) {
    die(`Config file not found: ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    die(`Config is not valid JSON: ${err.message}`);
  }

  const { value, exists } = navigatePath(config, jsonPath);
  if (!exists) {
    die(`Path "${jsonPath}" does not exist in config`);
  }
  console.log(JSON.stringify(value, null, 2));
}

function cmdSet(configPath, jsonPath, rawValue, dryRun) {
  if (!existsSync(configPath)) {
    die(`Config file not found: ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    die(`Config is not valid JSON: ${err.message}`);
  }

  // Parse the value as JSON
  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    die(
      `Value is not valid JSON: ${rawValue}\nHint: strings must be quoted, e.g. '"partial"' or '{"key": "val"}'`,
    );
  }

  // Snapshot before
  const before = JSON.parse(JSON.stringify(config));

  // Apply the change
  setAtPath(config, jsonPath, value);

  // Compute and show diff
  const changes = diffObjects(before, config);
  if (changes.length === 0) {
    info("No changes — value is already set to the specified value");
    return;
  }

  console.log("\nChanges:");
  console.log(formatDiff(changes));

  // Check for collateral key loss (general protection)
  const removals = changes.filter((c) => c.type === "removed");
  if (removals.length > 0) {
    warn(
      `This edit would remove ${removals.length} existing key(s):\n` +
        removals.map((r) => `  - ${r.path}`).join("\n"),
    );
    if (!dryRun) {
      warn("Proceeding because this is a set operation (keys were overwritten, not deleted)");
    }
  }

  if (dryRun) {
    info("Dry run — no changes written");
    return;
  }

  safeWriteConfig(configPath, config);
  success(`Updated ${jsonPath} in ${configPath}`);
}

function cmdRemove(configPath, jsonPath, force, dryRun) {
  if (!existsSync(configPath)) {
    die(`Config file not found: ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    die(`Config is not valid JSON: ${err.message}`);
  }

  const { exists, value } = navigatePath(config, jsonPath);
  if (!exists) {
    die(`Path "${jsonPath}" does not exist in config`);
  }

  // General protection: ALL removals require --force
  if (!force) {
    const preview = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
    const truncated = preview.length > 200 ? preview.slice(0, 200) + "..." : preview;
    die(
      `Refusing to remove "${jsonPath}" without --force.\n` +
        `Current value:\n${truncated}\n\n` +
        `All config removals require --force to prevent accidental data loss.\n` +
        `If you're sure, re-run with: node safe-config-edit.mjs remove "${jsonPath}" --force`,
    );
  }

  if (dryRun) {
    info(`Dry run — would remove "${jsonPath}"`);
    return;
  }

  const removed = deleteAtPath(config, jsonPath);
  if (!removed) {
    die(`Failed to remove "${jsonPath}" — path not found`);
  }

  safeWriteConfig(configPath, config);
  success(`Removed ${jsonPath} from ${configPath}`);
}

function cmdValidate(configPath) {
  if (!existsSync(configPath)) {
    die(`Config file not found: ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf8");
  try {
    const config = JSON.parse(raw);

    // Basic structural checks
    const issues = [];
    const channels = config.channels || {};
    for (const [chName, chCfg] of Object.entries(channels)) {
      for (const [acctId, acctCfg] of Object.entries(chCfg.accounts || {})) {
        // Check for invalid pairedUsers in config (pairing state lives in the
        // pairing-store, NOT in openclaw.json — adding it here breaks config reloads)
        if (acctCfg.pairedUsers) {
          issues.push(
            `${chName}.accounts.${acctId}: has "pairedUsers" key — this is NOT a valid config field. ` +
              `Pairing state is managed internally by the pairing-store. Remove this key or config ` +
              `reloads will be rejected with "Unrecognized key: pairedUsers"`,
          );
        }
        // Check for missing bot token
        if (chName === "telegram" && !acctCfg.botToken) {
          issues.push(`${chName}.accounts.${acctId}: missing botToken`);
        }
        if (chName === "discord" && !acctCfg.token) {
          issues.push(`${chName}.accounts.${acctId}: missing token`);
        }
      }
    }

    // Check agents have workspaces
    for (const agent of config.agents?.list || []) {
      if (agent.id !== "main" && !agent.workspace) {
        issues.push(`agents.list[${agent.id}]: missing workspace path`);
      }
    }

    if (issues.length > 0) {
      warn(`Config is valid JSON but has ${issues.length} structural issue(s):`);
      for (const issue of issues) {
        console.log(`  ${YELLOW}⚠ ${issue}${RESET}`);
      }
    } else {
      success("Config is valid JSON with no structural issues detected");
    }
  } catch (err) {
    die(`Config is not valid JSON: ${err.message}`);
  }
}

function cmdDiff(configPath) {
  if (!existsSync(configPath)) {
    die(`Config file not found: ${configPath}`);
  }
  const bakPath = configPath + ".bak";
  if (!existsSync(bakPath)) {
    die(`No backup found at ${bakPath} — nothing to compare`);
  }

  let current, backup;
  try {
    current = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    die(`Current config is not valid JSON: ${err.message}`);
  }
  try {
    backup = JSON.parse(readFileSync(bakPath, "utf8"));
  } catch (err) {
    die(`Backup is not valid JSON: ${err.message}`);
  }

  const changes = diffObjects(backup, current);
  if (changes.length === 0) {
    info("No differences between current config and last backup");
  } else {
    console.log(`\n${changes.length} change(s) since last backup:\n`);
    console.log(formatDiff(changes));
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

const configIdx = args.indexOf("--config");
const configPath =
  configIdx >= 0 && args[configIdx + 1]
    ? args[configIdx + 1]
    : process.env.OPENCLAW_CONFIG_PATH || "/home/node/data/openclaw.json";

const dryRun = flags.has("--dry-run");
const force = flags.has("--force");
const command = positional[0];

switch (command) {
  case "get":
    if (!positional[1]) {
      die("Usage: safe-config-edit.mjs get <json-path>");
    }
    cmdGet(configPath, positional[1]);
    break;
  case "set":
    if (!positional[1] || !positional[2]) {
      die("Usage: safe-config-edit.mjs set <json-path> <json-value>");
    }
    cmdSet(configPath, positional[1], positional[2], dryRun);
    break;
  case "remove":
    if (!positional[1]) {
      die("Usage: safe-config-edit.mjs remove <json-path> [--force]");
    }
    cmdRemove(configPath, positional[1], force, dryRun);
    break;
  case "validate":
    cmdValidate(configPath);
    break;
  case "diff":
    cmdDiff(configPath);
    break;
  default:
    console.log(`safe-config-edit.mjs — Safe config editor for openclaw.json

Usage:
  node safe-config-edit.mjs get <json-path>
  node safe-config-edit.mjs set <json-path> <json-value>
  node safe-config-edit.mjs remove <json-path> [--force]
  node safe-config-edit.mjs validate
  node safe-config-edit.mjs diff

Options:
  --config <path>   Config file path (default: /home/node/data/openclaw.json)
  --dry-run         Show what would change without writing
  --force           Required for remove operations

Examples:
  node safe-config-edit.mjs get "channels.telegram.accounts.jael"
  node safe-config-edit.mjs set "channels.telegram.accounts.jael.streaming" '"partial"'
  node safe-config-edit.mjs remove "channels.telegram.accounts.jael.oldField" --force
  node safe-config-edit.mjs validate`);
    if (command) {
      die(`Unknown command: ${command}`);
    }
    break;
}
