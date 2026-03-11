import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const WorkspaceSearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

function resolveWorkspaceToolContext(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  // Also require the QMD backend (workspace collections are QMD-only).
  const resolved = resolveMemoryBackendConfig({ cfg, agentId });
  if (resolved.backend !== "qmd") {
    return null;
  }
  // Confirm at least one workspace-kind collection exists.
  const hasWorkspaceCollection = (resolved.qmd?.collections ?? []).some(
    (c) => c.kind === "workspace",
  );
  if (!hasWorkspaceCollection) {
    return null;
  }
  return { cfg, agentId, resolved };
}

export function createWorkspaceSearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveWorkspaceToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId, resolved } = ctx;
  return {
    label: "Workspace Search",
    name: "workspace_search",
    description:
      "Search documents and files in the workspace (business/, docs/, notes/, memory/, and any " +
      "other directories). Use this to find project notes, strategies, playbooks, frameworks, " +
      "reference documents, and any content stored in workspace files. " +
      "Complements memory_search: memory_search covers personal episodic memory (MEMORY.md, " +
      "memory/*.md); workspace_search covers all other documents and subdirectories.",
    parameters: WorkspaceSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({
          results: [],
          disabled: true,
          unavailable: true,
          error: error ?? "workspace search unavailable",
        });
      }
      try {
        const citationsMode = resolveWorkspaceCitationsMode(cfg);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });
        const allResults = await manager.search(query, {
          maxResults: (maxResults ?? 10) * 3, // over-fetch to account for filtering
          minScore,
          sessionKey: options.agentSessionKey,
        });
        // Filter to workspace sources only — exclude personal memory and sessions.
        const workspaceResults = allResults.filter((r) => r.source === "workspace");
        const budget = resolved.qmd?.limits.maxInjectedChars;
        const trimmed = clampResultsByInjectedChars(workspaceResults, budget).slice(
          0,
          maxResults ?? resolved.qmd?.limits.maxResults ?? 6,
        );
        const decorated = decorateCitations(trimmed, includeCitations);
        const status = manager.status();
        const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
        return jsonResult({
          results: decorated,
          provider: status.provider,
          model: status.model,
          fallback: status.fallback,
          citations: citationsMode,
          mode: searchMode,
          source: "workspace",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          results: [],
          disabled: true,
          error: message,
          source: "workspace",
        });
      }
    },
  };
}

function resolveWorkspaceCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const lineRange =
      entry.startLine === entry.endLine
        ? `#L${entry.startLine}`
        : `#L${entry.startLine}-L${entry.endLine}`;
    const citation = `${entry.path}${lineRange}`;
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function clampResultsByInjectedChars(
  results: MemorySearchResult[],
  budget?: number,
): MemorySearchResult[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: MemorySearchResult[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}
