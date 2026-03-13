import { describe, expect, it } from "vitest";
import { isSubAgentIdentityPath } from "./qmd-manager.js";

describe("isSubAgentIdentityPath", () => {
  it("returns true for sub-agent IDENTITY.md", () => {
    expect(isSubAgentIdentityPath("agents/ocs-nehemiah/IDENTITY.md")).toBe(true);
  });

  it("returns true for sub-agent SOUL.md", () => {
    expect(isSubAgentIdentityPath("agents/mm-ezra/SOUL.md")).toBe(true);
  });

  it("returns true for sub-agent USER.md", () => {
    expect(isSubAgentIdentityPath("agents/ocs-nehemiah/USER.md")).toBe(true);
  });

  it("returns true for sub-agent MEMORY.md", () => {
    expect(isSubAgentIdentityPath("agents/mm-ezra/MEMORY.md")).toBe(true);
  });

  it("returns true for case-insensitive basename matching", () => {
    expect(isSubAgentIdentityPath("agents/ocs-nehemiah/identity.md")).toBe(true);
    expect(isSubAgentIdentityPath("agents/ocs-nehemiah/Soul.md")).toBe(true);
  });

  it("returns false for non-identity files under agents/", () => {
    expect(isSubAgentIdentityPath("agents/ocs-nehemiah/business/plan.md")).toBe(false);
    expect(isSubAgentIdentityPath("agents/mm-ezra/WORKING.md")).toBe(false);
    expect(isSubAgentIdentityPath("agents/ocs-nehemiah/AGENTS.md")).toBe(false);
    expect(isSubAgentIdentityPath("agents/ocs-nehemiah/memory/2026-03-12.md")).toBe(false);
  });

  it("returns false for identity files at workspace root", () => {
    expect(isSubAgentIdentityPath("IDENTITY.md")).toBe(false);
    expect(isSubAgentIdentityPath("SOUL.md")).toBe(false);
    expect(isSubAgentIdentityPath("USER.md")).toBe(false);
    expect(isSubAgentIdentityPath("MEMORY.md")).toBe(false);
  });

  it("returns false for files not under agents/ prefix", () => {
    expect(isSubAgentIdentityPath("memory/knowledge/recap.md")).toBe(false);
    expect(isSubAgentIdentityPath("business/overview.md")).toBe(false);
  });
});
