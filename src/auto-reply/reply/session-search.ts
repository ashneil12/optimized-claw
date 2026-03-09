/**
 * Session Search Index
 *
 * SQLite-backed full-text search across conversation history using FTS5.
 * Complements the existing vector-based memory search with exact keyword/phrase
 * matching across past session transcripts.
 *
 * Inspired by NousResearch/hermes-agent's hermes_state.py (SQLite + FTS5 session storage).
 *
 * DB location: <workspaceDir>/memory/sessions.db (per-agent, alongside memory index)
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";

const log = createSubsystemLogger("session-search");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionMessage = {
  sessionId: string;
  agentId: string;
  role: string;
  content: string;
  timestamp: number;
  channel?: string;
};

export type SessionSearchResult = {
  sessionId: string;
  agentId: string;
  role: string;
  content: string;
  timestamp: number;
  channel?: string;
  /** FTS5 rank score (lower = more relevant) */
  rank: number;
};

export type SessionSearchOptions = {
  /** Max results to return. Default: 10 */
  limit?: number;
  /** Filter by agent ID. undefined = search all agents. */
  agentId?: string;
  /** Filter by channel (telegram, discord, web, etc.) */
  channel?: string;
  /** Only search messages after this timestamp (ms since epoch) */
  after?: number;
  /** Only search messages before this timestamp (ms since epoch) */
  before?: number;
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SESSION_DB_FILENAME = "sessions.db";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp REAL NOT NULL,
    channel TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_session_messages_session
    ON session_messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_session_messages_agent
    ON session_messages(agent_id);
  CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp
    ON session_messages(timestamp);
`;

const FTS_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
    content,
    session_id UNINDEXED,
    agent_id UNINDEXED,
    role UNINDEXED,
    channel UNINDEXED,
    timestamp UNINDEXED,
    content=session_messages,
    content_rowid=id
  );
`;

// Triggers to keep FTS in sync with the content table
const TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS session_messages_ai AFTER INSERT ON session_messages BEGIN
    INSERT INTO session_messages_fts(rowid, content, session_id, agent_id, role, channel, timestamp)
    VALUES (new.id, new.content, new.session_id, new.agent_id, new.role, new.channel, new.timestamp);
  END;

  CREATE TRIGGER IF NOT EXISTS session_messages_ad AFTER DELETE ON session_messages BEGIN
    INSERT INTO session_messages_fts(session_messages_fts, rowid, content, session_id, agent_id, role, channel, timestamp)
    VALUES ('delete', old.id, old.content, old.session_id, old.agent_id, old.role, old.channel, old.timestamp);
  END;
`;

// ---------------------------------------------------------------------------
// Index Manager
// ---------------------------------------------------------------------------

/** Cache of open session search indexes, keyed by workspace dir */
const INDEX_CACHE = new Map<string, SessionSearchIndex>();

export class SessionSearchIndex {
  private db: DatabaseSync;
  private readonly dbPath: string;
  private ftsAvailable = false;

  private constructor(dbPath: string, db: DatabaseSync) {
    this.dbPath = dbPath;
    this.db = db;
  }

  /**
   * Get or create a session search index for a workspace.
   * Returns null if SQLite is unavailable.
   */
  static open(workspaceDir: string): SessionSearchIndex | null {
    const cached = INDEX_CACHE.get(workspaceDir);
    if (cached) {
      return cached;
    }

    const memoryDir = path.join(workspaceDir, "memory");
    try {
      fs.mkdirSync(memoryDir, { recursive: true });
    } catch {
      log.warn(`cannot create memory directory: ${memoryDir}`);
      return null;
    }

    const dbPath = path.join(memoryDir, SESSION_DB_FILENAME);

    let db: DatabaseSync;
    try {
      const { DatabaseSync: DbConstructor } = requireNodeSqlite();
      db = new DbConstructor(dbPath);
    } catch (err) {
      log.warn(`cannot open session search DB: ${String(err)}`);
      return null;
    }

    const instance = new SessionSearchIndex(dbPath, db);
    instance.initSchema();
    INDEX_CACHE.set(workspaceDir, instance);
    return instance;
  }

  private initSchema(): void {
    try {
      this.db.exec(SCHEMA_SQL);
    } catch (err) {
      log.warn(`failed to create session search schema: ${String(err)}`);
      return;
    }

    try {
      this.db.exec(FTS_SQL);
      this.db.exec(TRIGGER_SQL);
      this.ftsAvailable = true;
    } catch (err) {
      log.warn(`FTS5 not available for session search: ${String(err)}`);
      this.ftsAvailable = false;
    }
  }

  /**
   * Index messages from a transcript into the search database.
   */
  indexMessages(messages: SessionMessage[]): number {
    if (messages.length === 0) {
      return 0;
    }

    const insert = this.db.prepare(
      `INSERT INTO session_messages (session_id, agent_id, role, content, timestamp, channel)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    let count = 0;
    for (const msg of messages) {
      if (!msg.content?.trim()) {
        continue;
      }
      try {
        insert.run(
          msg.sessionId,
          msg.agentId,
          msg.role,
          msg.content,
          msg.timestamp,
          msg.channel ?? null,
        );
        count++;
      } catch (err) {
        log.warn(`failed to index message: ${String(err)}`);
      }
    }

    log.info(`indexed ${count} messages for session ${messages[0]?.sessionId}`);
    return count;
  }

  /**
   * Search past session messages using FTS5 full-text search.
   * Falls back to LIKE-based search if FTS5 is unavailable.
   */
  search(query: string, options?: SessionSearchOptions): SessionSearchResult[] {
    const limit = options?.limit ?? 10;

    if (!query.trim()) {
      return [];
    }

    if (this.ftsAvailable) {
      return this.searchFts(query, limit, options);
    }

    return this.searchLike(query, limit, options);
  }

  private searchFts(
    query: string,
    limit: number,
    options?: SessionSearchOptions,
  ): SessionSearchResult[] {
    // Clean query for FTS5: escape special characters, handle phrases
    const ftsQuery = this.buildFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }

    const conditions: string[] = [];
    const params: (string | number | null)[] = [ftsQuery];

    if (options?.agentId) {
      conditions.push("agent_id = ?");
      params.push(options.agentId);
    }
    if (options?.channel) {
      conditions.push("channel = ?");
      params.push(options.channel);
    }
    if (options?.after) {
      conditions.push("timestamp > ?");
      params.push(options.after);
    }
    if (options?.before) {
      conditions.push("timestamp < ?");
      params.push(options.before);
    }

    const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT
        session_id, agent_id, role, content, channel, timestamp,
        rank
      FROM session_messages_fts
      WHERE session_messages_fts MATCH ? ${whereClause}
      ORDER BY rank
      LIMIT ?
    `;
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        session_id: string;
        agent_id: string;
        role: string;
        content: string;
        channel: string | null;
        timestamp: number;
        rank: number;
      }>;

      return rows.map((row) => ({
        sessionId: row.session_id,
        agentId: row.agent_id,
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
        channel: row.channel ?? undefined,
        rank: row.rank,
      }));
    } catch (err) {
      log.warn(`FTS search failed: ${String(err)}`);
      return this.searchLike(query, limit, options);
    }
  }

  private searchLike(
    query: string,
    limit: number,
    options?: SessionSearchOptions,
  ): SessionSearchResult[] {
    const conditions: string[] = ["content LIKE ?"];
    const params: (string | number | null)[] = [`%${query}%`];

    if (options?.agentId) {
      conditions.push("agent_id = ?");
      params.push(options.agentId);
    }
    if (options?.channel) {
      conditions.push("channel = ?");
      params.push(options.channel);
    }
    if (options?.after) {
      conditions.push("timestamp > ?");
      params.push(options.after);
    }
    if (options?.before) {
      conditions.push("timestamp < ?");
      params.push(options.before);
    }

    const sql = `
      SELECT session_id, agent_id, role, content, channel, timestamp
      FROM session_messages
      WHERE ${conditions.join(" AND ")}
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        session_id: string;
        agent_id: string;
        role: string;
        content: string;
        channel: string | null;
        timestamp: number;
      }>;

      return rows.map((row) => ({
        sessionId: row.session_id,
        agentId: row.agent_id,
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
        channel: row.channel ?? undefined,
        rank: 0,
      }));
    } catch (err) {
      log.warn(`LIKE search failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Build an FTS5 query from a raw search string.
   * Handles phrase queries (quoted), simple terms, and escaping.
   */
  private buildFtsQuery(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    // If already quoted, use as phrase query directly
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed;
    }

    // Split into words and join with implicit AND
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return null;
    }

    // Escape special FTS5 characters
    const escaped = words.map((w) => w.replace(/[*():"^]/g, (ch) => `"${ch}"`));

    return escaped.join(" ");
  }

  /**
   * Get the total number of indexed messages.
   */
  count(agentId?: string): number {
    try {
      if (agentId) {
        const row = this.db
          .prepare("SELECT COUNT(*) as cnt FROM session_messages WHERE agent_id = ?")
          .get(agentId) as { cnt: number } | undefined;
        return row?.cnt ?? 0;
      }
      const row = this.db.prepare("SELECT COUNT(*) as cnt FROM session_messages").get() as
        | { cnt: number }
        | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Close the database connection and remove from cache.
   */
  close(): void {
    try {
      this.db.close();
    } catch {
      // Best effort
    }
    INDEX_CACHE.delete([...INDEX_CACHE.entries()].find(([, v]) => v === this)?.[0] ?? "");
  }

  /** Exposed for testing */
  get isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  /**
   * Remove the cache entry for a workspace (for testing cleanup).
   */
  static clearCache(): void {
    INDEX_CACHE.clear();
  }
}

// ---------------------------------------------------------------------------
// Transcript indexing helper
// ---------------------------------------------------------------------------

type TranscriptEntry = {
  type: string;
  timestamp?: string;
  message?: {
    role: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
};

function extractText(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("\n");
  }
  return "";
}

/**
 * Index a session transcript into the session search database.
 * Call this during session reset (alongside session context persistence).
 */
export function indexTranscriptForSearch(params: {
  transcriptPath: string;
  workspaceDir: string;
  agentId: string;
  sessionId: string;
  channel?: string;
}): void {
  const index = SessionSearchIndex.open(params.workspaceDir);
  if (!index) {
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(params.transcriptPath, "utf-8");
  } catch {
    log.warn(`cannot read transcript for indexing: ${params.transcriptPath}`);
    return;
  }

  const messages: SessionMessage[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }

    if (entry.type !== "message" || !entry.message) {
      continue;
    }

    const text = extractText(entry.message.content).trim();
    if (!text) {
      continue;
    }

    // Only index user and assistant messages (skip tool results for now)
    if (entry.message.role !== "user" && entry.message.role !== "assistant") {
      continue;
    }

    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

    messages.push({
      sessionId: params.sessionId,
      agentId: params.agentId,
      role: entry.message.role,
      content: text,
      timestamp,
      channel: params.channel,
    });
  }

  if (messages.length > 0) {
    index.indexMessages(messages);
  }
}
