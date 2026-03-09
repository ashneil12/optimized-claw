/**
 * Session Search Tool
 *
 * Exposes the session FTS5 search index as an agent tool, allowing agents to
 * search across past conversation history using exact keyword/phrase matching.
 * Complements memory_search (semantic/vector) with precise text retrieval.
 */

import { Type } from "@sinclair/typebox";
import {
  SessionSearchIndex,
  type SessionSearchOptions,
} from "../../auto-reply/reply/session-search.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../workspace.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";

const SessionSearchSchema = Type.Object({
  query: Type.String({ description: "Search query — keywords or a quoted phrase." }),
  limit: Type.Optional(
    Type.Number({ description: "Max results to return. Default: 10.", minimum: 1, maximum: 50 }),
  ),
  agent_id: Type.Optional(
    Type.String({ description: "Filter by agent ID. Omit to search all agents." }),
  ),
  channel: Type.Optional(
    Type.String({ description: "Filter by channel (telegram, discord, web)." }),
  ),
});

export function createSessionSearchTool(options: {
  config?: OpenClawConfig;
  agentId?: string;
  /** Whether the requester is a sub-agent (limits search to own agent) */
  isSubagent?: boolean;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  const agentId = options.agentId;
  const workspaceDir = agentId
    ? resolveAgentWorkspaceDir(cfg, agentId)
    : DEFAULT_AGENT_WORKSPACE_DIR;

  return {
    label: "Session Search",
    name: "session_search",
    description:
      "Search past conversation history using exact keyword/phrase matching. Use this when you need to find specific things discussed in previous sessions — exact names, commands, error messages, or decisions. For semantic/conceptual search, use memory_search instead.",
    parameters: SessionSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit");
      const agentFilter = readStringParam(params, "agent_id");
      const channel = readStringParam(params, "channel");

      const index = SessionSearchIndex.open(workspaceDir);
      if (!index) {
        return jsonResult({
          results: [],
          disabled: true,
          error: "Session search unavailable (SQLite not available)",
        });
      }

      // Sub-agents can only search their own sessions
      const effectiveAgentId = options.isSubagent
        ? (agentId ?? agentFilter)
        : (agentFilter ?? undefined);

      const searchOptions: SessionSearchOptions = {
        limit: limit ?? 10,
        agentId: effectiveAgentId ?? undefined,
        channel: channel ?? undefined,
      };

      try {
        const results = index.search(query, searchOptions);
        const totalMessages = index.count(effectiveAgentId ?? undefined);

        return jsonResult({
          results: results.map((r) => ({
            sessionId: r.sessionId,
            role: r.role,
            content: r.content.slice(0, 500), // Truncate long messages
            timestamp: new Date(r.timestamp).toISOString(),
            channel: r.channel,
          })),
          totalIndexed: totalMessages,
          fts: index.isFtsAvailable,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          results: [],
          error: message,
        });
      }
    },
  };
}
