import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, jsonResult, readStringParam } from "./common.js";

const log = createSubsystemLogger("sql-tool");

/** Max rows returned per query to avoid flooding agent context. */
const MAX_RESULT_ROWS = 100;

/** Max length of serialized result text to avoid context overflow. */
const MAX_RESULT_CHARS = 50_000;

// ────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ────────────────────────────────────────────────────────────────────────────

const BLOCKED_KEYWORDS_RE = /^\s*(ATTACH|DETACH)\b/i;

const DANGEROUS_PRAGMA_RE =
  /^\s*PRAGMA\s+(?!table_info|table_list|table_xinfo|index_list|index_info|foreign_key_list|database_list|compile_options)\w+\s*=/i;

const WRITE_STATEMENT_RE = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i;

function isReadOnlyStatement(query: string): boolean {
  const trimmed = query.trim();
  return /^\s*(SELECT|WITH|EXPLAIN|PRAGMA\s+table_info|PRAGMA\s+table_list|PRAGMA\s+table_xinfo|PRAGMA\s+index_list|PRAGMA\s+index_info|PRAGMA\s+foreign_key_list|PRAGMA\s+database_list|PRAGMA\s+compile_options)\b/i.test(
    trimmed,
  );
}

function isBlockedStatement(query: string): boolean {
  const trimmed = query.trim();
  if (BLOCKED_KEYWORDS_RE.test(trimmed)) {
    return true;
  }
  if (DANGEROUS_PRAGMA_RE.test(trimmed)) {
    return true;
  }
  return false;
}

function validateDbPath(dbRelPath: string, workspaceDir: string): string {
  const cleaned = dbRelPath.trim();
  if (!cleaned) {
    throw new ToolInputError("database path required");
  }
  if (!cleaned.endsWith(".db")) {
    throw new ToolInputError("database path must end with .db");
  }
  // Resolve to absolute and verify containment
  const absPath = path.resolve(workspaceDir, cleaned);
  const relFromWorkspace = path.relative(workspaceDir, absPath);
  if (relFromWorkspace.startsWith("..") || path.isAbsolute(relFromWorkspace) || !relFromWorkspace) {
    throw new ToolInputError("database path must be within workspace directory");
  }
  // Block symlinks
  try {
    const stat = fs.lstatSync(absPath);
    if (stat.isSymbolicLink()) {
      throw new ToolInputError("symlinked database paths are not allowed");
    }
  } catch (err) {
    // File doesn't exist yet — that's fine, we'll create it
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  return absPath;
}

function truncateResult(payload: unknown): unknown {
  const text = JSON.stringify(payload, null, 2);
  if (text.length <= MAX_RESULT_CHARS) {
    return payload;
  }
  // If the payload is too large, truncate the rows array
  if (
    typeof payload === "object" &&
    payload !== null &&
    "rows" in payload &&
    Array.isArray((payload as { rows: unknown[] }).rows)
  ) {
    const obj = payload as { rows: unknown[]; truncated?: boolean; rowCount?: number };
    const fullCount = obj.rows.length;
    // Binary search for max rows that fit within budget
    let lo = 0;
    let hi = fullCount;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const trial = { ...obj, rows: obj.rows.slice(0, mid), truncated: true, rowCount: fullCount };
      if (JSON.stringify(trial, null, 2).length <= MAX_RESULT_CHARS) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return {
      ...obj,
      rows: obj.rows.slice(0, Math.max(1, lo)),
      truncated: true,
      rowCount: fullCount,
    };
  }
  return payload;
}

// ────────────────────────────────────────────────────────────────────────────
// Schema descriptions for the memory index database
// ────────────────────────────────────────────────────────────────────────────

const BUILTIN_SCHEMA_HINT = [
  "Tables in the memory index database (builtin backend):",
  "- files(path TEXT PK, source TEXT, hash TEXT, mtime INTEGER, size INTEGER)",
  "- chunks(id TEXT PK, path TEXT, source TEXT, start_line INTEGER, end_line INTEGER, hash TEXT, model TEXT, text TEXT, embedding TEXT, updated_at INTEGER)",
  "- meta(key TEXT PK, value TEXT)",
  "- embedding_cache(provider TEXT, model TEXT, provider_key TEXT, hash TEXT, embedding TEXT, dims INTEGER, updated_at INTEGER)",
  "- chunks_fts (FTS5 virtual table: text, id, path, source, model, start_line, end_line)",
].join("\n");

/**
 * Introspect a SQLite database to generate a schema description.
 * Falls back to a static hint if the DB doesn't exist yet.
 */
function introspectSchema(dbPath: string): string {
  if (!fs.existsSync(dbPath)) {
    return "Database not yet initialized. Run memory_search first, then use PRAGMA table_list to discover tables.";
  }
  try {
    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = db
        .prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string; type: string }[];
      if (tables.length === 0) {
        return "Database exists but contains no tables. It may not be initialized yet.";
      }
      const lines = [`Tables in the memory index database:`];
      for (const table of tables) {
        try {
          const cols = db.prepare(`PRAGMA table_info("${table.name}")`).all() as {
            name: string;
            type: string;
            pk: number;
          }[];
          const colDescs = cols.map((c) => `${c.name} ${c.type || "ANY"}${c.pk ? " PK" : ""}`);
          lines.push(`- ${table.name}(${colDescs.join(", ")})`);
        } catch {
          lines.push(`- ${table.name} (schema unavailable)`);
        }
      }
      return lines.join("\n");
    } finally {
      db.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.debug(`schema introspection failed for ${dbPath}: ${msg}`);
    return "Schema introspection failed. Use PRAGMA table_list to discover tables.";
  }
}

/**
 * Resolve the memory index database path based on the active backend.
 * - builtin: uses the configured store.path from memorySearch config
 * - qmd: uses the QMD index at $stateDir/agents/$agentId/qmd/xdg-cache/qmd/index.sqlite
 */
function resolveMemoryDbPath(
  cfg: OpenClawConfig,
  agentId: string,
): { path: string; backend: string } | null {
  const backendConfig = resolveMemoryBackendConfig({ cfg, agentId });

  if (backendConfig.backend === "qmd") {
    // QMD stores its index at $stateDir/agents/$agentId/qmd/xdg-cache/qmd/index.sqlite
    const stateDir = resolveStateDir(process.env, os.homedir);
    const qmdIndexPath = path.join(
      stateDir,
      "agents",
      agentId,
      "qmd",
      "xdg-cache",
      "qmd",
      "index.sqlite",
    );
    return { path: qmdIndexPath, backend: "qmd" };
  }

  // Builtin backend — resolve from memorySearch config
  const settings = resolveMemorySearchConfig(cfg, agentId);
  if (!settings) {
    return null;
  }
  return { path: settings.store.path, backend: "builtin" };
}

// ────────────────────────────────────────────────────────────────────────────
// sql_query — read-only access to the memory index database
// ────────────────────────────────────────────────────────────────────────────

const SqlQuerySchema = Type.Object({
  query: Type.String({
    description: "SQL SELECT query to run against the memory index database.",
  }),
});

export function createSqlQueryTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  const dbInfo = resolveMemoryDbPath(cfg, agentId);
  if (!dbInfo) {
    return null;
  }
  const { path: dbPath, backend } = dbInfo;

  // Generate schema hint: use dynamic introspection for QMD (unknown schema),
  // static hint for builtin (known schema). Fallback to introspection for both
  // if the DB exists.
  const schemaHint = backend === "builtin" ? BUILTIN_SCHEMA_HINT : introspectSchema(dbPath);

  return {
    label: "SQL Query",
    name: "sql_query",
    description: [
      "Execute a read-only SQL query against the agent's memory index database.",
      `Backend: ${backend}${backend === "qmd" ? " (QMD-managed index)" : " (builtin index)"}`,
      "Use this for precise filtering, aggregation, or structured queries that memory_search cannot handle",
      "(e.g., counting files, listing by source, filtering by date).",
      "Only SELECT / WITH / safe PRAGMA queries are allowed.",
      "Use PRAGMA table_list and PRAGMA table_info(tablename) to discover the current schema.",
      "",
      schemaHint,
    ].join("\n"),
    parameters: SqlQuerySchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });

      if (!isReadOnlyStatement(query)) {
        return jsonResult({
          error:
            "Only SELECT, WITH, and safe PRAGMA queries are allowed. Use sql_execute for write operations on custom databases.",
        });
      }
      if (isBlockedStatement(query)) {
        return jsonResult({ error: "ATTACH, DETACH, and PRAGMA writes are not allowed." });
      }

      // Verify DB exists
      if (!fs.existsSync(dbPath)) {
        return jsonResult({
          error: `Memory index database not found at ${backend} backend path. Run memory_search first to initialize the index.`,
          backend,
        });
      }

      try {
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          const rows = db.prepare(query).all() as Record<string, unknown>[];
          const capped = rows.slice(0, MAX_RESULT_ROWS);
          const columns = capped.length > 0 ? Object.keys(capped[0]) : [];
          const result = {
            columns,
            rows: capped,
            rowCount: rows.length,
            backend,
            ...(rows.length > MAX_RESULT_ROWS ? { truncated: true, limit: MAX_RESULT_ROWS } : {}),
          };
          return jsonResult(truncateResult(result));
        } finally {
          db.close();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`sql_query error (${backend}): ${message}`);
        return jsonResult({ error: message, backend });
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// sql_execute — read-write access to custom workspace databases
// ────────────────────────────────────────────────────────────────────────────

const SqlExecuteSchema = Type.Object({
  database: Type.String({
    description:
      'Relative path to a .db file within the workspace (e.g., "data/tracker.db"). Created on first use.',
  }),
  query: Type.String({
    description:
      "SQL statement to execute. Supports SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, DROP TABLE, ALTER TABLE, CREATE INDEX.",
  }),
});

export function createSqlExecuteTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  workspaceDir?: string;
}): AnyAgentTool | null {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  if (!workspaceDir) {
    return null;
  }

  return {
    label: "SQL Execute",
    name: "sql_execute",
    description: [
      "Execute SQL on a custom SQLite database in the agent workspace.",
      "Use this to create and manage structured data stores for tracking, analytics, or any data that benefits from SQL queries.",
      "Supports: SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, DROP TABLE, ALTER TABLE, CREATE INDEX.",
      "Blocked: ATTACH, DETACH, PRAGMA writes.",
      "The database file is created on first use. Use PRAGMA table_list or PRAGMA table_info(tablename) to inspect schema.",
    ].join("\n"),
    parameters: SqlExecuteSchema,
    execute: async (_toolCallId, params) => {
      const dbRelPath = readStringParam(params, "database", { required: true });
      const query = readStringParam(params, "query", { required: true });

      if (isBlockedStatement(query)) {
        return jsonResult({ error: "ATTACH, DETACH, and PRAGMA writes are not allowed." });
      }

      let absDbPath: string;
      try {
        absDbPath = validateDbPath(dbRelPath, workspaceDir);
      } catch (err) {
        if (err instanceof ToolInputError) {
          return jsonResult({ error: err.message });
        }
        throw err;
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(absDbPath);
      fs.mkdirSync(parentDir, { recursive: true });

      try {
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(absDbPath);
        try {
          // Enable WAL mode for better concurrency on first access
          try {
            db.exec("PRAGMA journal_mode=WAL;");
          } catch {
            // WAL may not be supported in all environments; not critical
          }

          const isWrite = WRITE_STATEMENT_RE.test(query.trim());
          if (isWrite) {
            // DML/DDL — use exec or run
            db.exec(query);
            // Get affected rows for DML statements
            const changes = (db.prepare("SELECT changes() as c").get() as { c: number })?.c ?? 0;
            return jsonResult({
              ok: true,
              changes,
              database: dbRelPath,
            });
          } else {
            // SELECT or PRAGMA read
            const rows = db.prepare(query).all() as Record<string, unknown>[];
            const capped = rows.slice(0, MAX_RESULT_ROWS);
            const columns = capped.length > 0 ? Object.keys(capped[0]) : [];
            const result = {
              columns,
              rows: capped,
              rowCount: rows.length,
              database: dbRelPath,
              ...(rows.length > MAX_RESULT_ROWS ? { truncated: true, limit: MAX_RESULT_ROWS } : {}),
            };
            return jsonResult(truncateResult(result));
          }
        } finally {
          db.close();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`sql_execute error on ${dbRelPath}: ${message}`);
        return jsonResult({ error: message, database: dbRelPath });
      }
    },
  };
}
