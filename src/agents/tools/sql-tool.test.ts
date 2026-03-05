import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqlExecuteTool, createSqlQueryTool } from "./sql-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sql-tool-test-"));
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Minimal config to make memory search resolve. */
function memoryConfig(dbPath: string) {
  return {
    agents: {
      list: [{ id: "main", default: true }],
      defaults: {
        memorySearch: {
          enabled: true,
          store: { path: dbPath },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// sql_query tests
// ---------------------------------------------------------------------------

describe("sql_query", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = tmpDir();
    dbPath = path.join(dir, "memory.sqlite");
    // Seed a minimal memory-like database
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE files (path TEXT PRIMARY KEY, source TEXT, hash TEXT, mtime INTEGER, size INTEGER);
      CREATE TABLE chunks (id TEXT PRIMARY KEY, path TEXT, source TEXT, start_line INTEGER, end_line INTEGER, hash TEXT, model TEXT, text TEXT, embedding TEXT, updated_at INTEGER);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO files VALUES ('memory/diary.md', 'memory', 'abc', 1700000000, 512);
      INSERT INTO files VALUES ('memory/notes.md', 'memory', 'def', 1700000100, 1024);
      INSERT INTO chunks VALUES ('c1', 'memory/diary.md', 'memory', 1, 10, 'h1', 'test-model', 'diary content', '[]', 1700000000);
    `);
    db.close();
  });

  afterEach(() => cleanup(dir));

  it("returns rows for valid SELECT", async () => {
    const tool = createSqlQueryTool({ config: memoryConfig(dbPath) });
    expect(tool).not.toBeNull();
    const result = await tool!.execute("call1", {
      query: "SELECT path, size FROM files ORDER BY path",
    });
    expect(result.details).toEqual({
      columns: ["path", "size"],
      rows: [
        { path: "memory/diary.md", size: 512 },
        { path: "memory/notes.md", size: 1024 },
      ],
      rowCount: 2,
      backend: "builtin",
    });
  });

  it("handles COUNT aggregation", async () => {
    const tool = createSqlQueryTool({ config: memoryConfig(dbPath) });
    const result = await tool!.execute("call2", { query: "SELECT COUNT(*) as total FROM files" });
    expect((result.details as { rows: { total: number }[] }).rows[0].total).toBe(2);
  });

  it("handles empty result sets", async () => {
    const tool = createSqlQueryTool({ config: memoryConfig(dbPath) });
    const result = await tool!.execute("call3", {
      query: "SELECT * FROM files WHERE size > 99999",
    });
    const details = result.details as { columns: string[]; rows: unknown[]; rowCount: number };
    expect(details.rows).toEqual([]);
    expect(details.rowCount).toBe(0);
    expect(details.columns).toEqual([]);
  });

  it("rejects INSERT statements", async () => {
    const tool = createSqlQueryTool({ config: memoryConfig(dbPath) });
    const result = await tool!.execute("call4", {
      query: "INSERT INTO meta VALUES ('test', 'value')",
    });
    expect((result.details as { error: string }).error).toContain("Only SELECT");
  });

  it("rejects UPDATE statements", async () => {
    const tool = createSqlQueryTool({ config: memoryConfig(dbPath) });
    const result = await tool!.execute("call5", {
      query: "UPDATE files SET size = 0",
    });
    expect((result.details as { error: string }).error).toContain("Only SELECT");
  });

  it("rejects DROP statements", async () => {
    const tool = createSqlQueryTool({ config: memoryConfig(dbPath) });
    const result = await tool!.execute("call6", {
      query: "DROP TABLE files",
    });
    expect((result.details as { error: string }).error).toContain("Only SELECT");
  });

  it("rejects ATTACH statements", async () => {
    const tool = createSqlQueryTool({ config: memoryConfig(dbPath) });
    const result = await tool!.execute("call7", {
      query: "ATTACH DATABASE '/tmp/other.db' AS other",
    });
    expect((result.details as { error: string }).error).toContain("Only SELECT");
  });

  it("returns error for malformed SQL", async () => {
    const tool = createSqlQueryTool({ config: memoryConfig(dbPath) });
    const result = await tool!.execute("call8", { query: "SELECT * FROOM files" });
    expect((result.details as { error: string }).error).toBeDefined();
  });

  it("allows WITH (CTE) queries", async () => {
    const tool = createSqlQueryTool({ config: memoryConfig(dbPath) });
    const result = await tool!.execute("call9", {
      query: "WITH f AS (SELECT * FROM files) SELECT COUNT(*) as c FROM f",
    });
    expect((result.details as { rows: { c: number }[] }).rows[0].c).toBe(2);
  });

  it("returns null when memory search is disabled", () => {
    const tool = createSqlQueryTool({
      config: {
        agents: {
          list: [{ id: "main", default: true }],
          defaults: { memorySearch: { enabled: false } },
        },
      },
    });
    expect(tool).toBeNull();
  });

  it("returns error when DB does not exist", async () => {
    const tool = createSqlQueryTool({ config: memoryConfig("/tmp/nonexistent-sql-test.sqlite") });
    expect(tool).not.toBeNull();
    const result = await tool!.execute("call10", { query: "SELECT 1" });
    expect((result.details as { error: string }).error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// sql_execute tests
// ---------------------------------------------------------------------------

describe("sql_execute", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = tmpDir();
  });

  afterEach(() => cleanup(workspaceDir));

  it("creates database on first use and executes CREATE TABLE", async () => {
    const tool = createSqlExecuteTool({ workspaceDir });
    expect(tool).not.toBeNull();
    const result = await tool!.execute("call1", {
      database: "data/tracker.db",
      query: "CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0)",
    });
    const details = result.details as { ok: boolean; changes: number };
    expect(details.ok).toBe(true);
    // Verify file was created
    expect(fs.existsSync(path.join(workspaceDir, "data", "tracker.db"))).toBe(true);
  });

  it("supports full CRUD lifecycle", async () => {
    const tool = createSqlExecuteTool({ workspaceDir })!;
    // Create table
    await tool.execute("c1", {
      database: "test.db",
      query: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)",
    });
    // Insert
    const insertResult = await tool.execute("c2", {
      database: "test.db",
      query: "INSERT INTO items (name) VALUES ('alpha'), ('beta')",
    });
    expect((insertResult.details as { changes: number }).changes).toBe(2);
    // Select
    const selectResult = await tool.execute("c3", {
      database: "test.db",
      query: "SELECT * FROM items ORDER BY id",
    });
    const rows = (selectResult.details as { rows: { id: number; name: string }[] }).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("alpha");
    expect(rows[1].name).toBe("beta");
    // Update
    const updateResult = await tool.execute("c4", {
      database: "test.db",
      query: "UPDATE items SET name = 'gamma' WHERE id = 1",
    });
    expect((updateResult.details as { changes: number }).changes).toBe(1);
    // Delete
    const deleteResult = await tool.execute("c5", {
      database: "test.db",
      query: "DELETE FROM items WHERE id = 2",
    });
    expect((deleteResult.details as { changes: number }).changes).toBe(1);
    // Verify final state
    const finalResult = await tool.execute("c6", {
      database: "test.db",
      query: "SELECT * FROM items",
    });
    const finalRows = (finalResult.details as { rows: { id: number; name: string }[] }).rows;
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0].name).toBe("gamma");
  });

  it("rejects paths outside workspace (path traversal)", async () => {
    const tool = createSqlExecuteTool({ workspaceDir })!;
    const result = await tool.execute("call2", {
      database: "../../etc/evil.db",
      query: "SELECT 1",
    });
    expect((result.details as { error: string }).error).toContain("within workspace");
  });

  it("rejects non-.db paths", async () => {
    const tool = createSqlExecuteTool({ workspaceDir })!;
    const result = await tool.execute("call3", {
      database: "data/notes.txt",
      query: "SELECT 1",
    });
    expect((result.details as { error: string }).error).toContain(".db");
  });

  it("rejects absolute paths", async () => {
    const tool = createSqlExecuteTool({ workspaceDir })!;
    const result = await tool.execute("call4", {
      database: "/tmp/evil.db",
      query: "SELECT 1",
    });
    expect((result.details as { error: string }).error).toContain("within workspace");
  });

  it("rejects ATTACH statements", async () => {
    const tool = createSqlExecuteTool({ workspaceDir })!;
    // First create a valid DB
    await tool.execute("setup", {
      database: "test.db",
      query: "CREATE TABLE t (x INTEGER)",
    });
    const result = await tool.execute("call5", {
      database: "test.db",
      query: "ATTACH DATABASE '/tmp/other.db' AS other",
    });
    expect((result.details as { error: string }).error).toContain("not allowed");
  });

  it("rejects DETACH statements", async () => {
    const tool = createSqlExecuteTool({ workspaceDir })!;
    await tool.execute("setup", {
      database: "test.db",
      query: "CREATE TABLE t (x INTEGER)",
    });
    const result = await tool.execute("call6", {
      database: "test.db",
      query: "DETACH DATABASE main",
    });
    expect((result.details as { error: string }).error).toContain("not allowed");
  });

  it("allows safe PRAGMA reads (table_list)", async () => {
    const tool = createSqlExecuteTool({ workspaceDir })!;
    await tool.execute("setup", {
      database: "test.db",
      query: "CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT)",
    });
    const result = await tool.execute("call7", {
      database: "test.db",
      query: "PRAGMA table_list",
    });
    const rows = (result.details as { rows: unknown[] }).rows;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("blocks dangerous PRAGMA writes", async () => {
    const tool = createSqlExecuteTool({ workspaceDir })!;
    await tool.execute("setup", {
      database: "test.db",
      query: "CREATE TABLE t (x INTEGER)",
    });
    const result = await tool.execute("call8", {
      database: "test.db",
      query: "PRAGMA journal_mode = DELETE",
    });
    expect((result.details as { error: string }).error).toContain("not allowed");
  });

  it("still creates tool when workspace is empty (resolves to cwd)", () => {
    // resolveWorkspaceRoot always returns a valid path, even for empty input
    const tool = createSqlExecuteTool({ workspaceDir: "" });
    expect(tool).not.toBeNull();
  });

  it("includes database path in results", async () => {
    const tool = createSqlExecuteTool({ workspaceDir })!;
    await tool.execute("setup", {
      database: "my.db",
      query: "CREATE TABLE t (x INTEGER)",
    });
    const result = await tool.execute("call9", {
      database: "my.db",
      query: "SELECT * FROM t",
    });
    expect((result.details as { database: string }).database).toBe("my.db");
  });
});
