import { createMemoryGetTool, createMemorySearchTool } from "../../agents/tools/memory-tool.js";
import { createWorkspaceSearchTool } from "../../agents/tools/workspace-search-tool.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeTools(): PluginRuntime["tools"] {
  return {
    createMemoryGetTool,
    createMemorySearchTool,
    createWorkspaceSearchTool,
    registerMemoryCli,
  };
}
