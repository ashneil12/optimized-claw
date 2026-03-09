import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createSkillManageTool } from "./skill-manage-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeToolOptions(workspaceDir: string) {
  return {
    config: {} as OpenClawConfig,
    workspaceDir,
  };
}

function callTool(
  tool: ReturnType<typeof createSkillManageTool>,
  params: Record<string, unknown>,
): Promise<unknown> {
  return tool!.execute("test-call", params);
}

function parseResult(raw: unknown): Record<string, unknown> {
  // The tool returns jsonResult which wraps in { content: [{text}] } format
  const result = raw as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skill-manage-tool", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-manage-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it("returns null when no config provided", () => {
    const tool = createSkillManageTool({});
    expect(tool).toBeNull();
  });

  describe("list action", () => {
    it("returns empty list when no skills exist", async () => {
      const tool = createSkillManageTool(makeToolOptions(tmpDir));
      const result = parseResult(await callTool(tool, { action: "list" }));
      expect(result.count).toBe(0);
      expect(result.skills).toEqual([]);
    });

    it("lists existing skills with descriptions", async () => {
      // Create a skill manually
      const skillDir = path.join(tmpDir, "skills", "my-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: my-skill\ndescription: A test skill\ncreated_by: agent\n---\n\nSome instructions.",
        "utf-8",
      );

      const tool = createSkillManageTool(makeToolOptions(tmpDir));
      const result = parseResult(await callTool(tool, { action: "list" }));
      expect(result.count).toBe(1);

      const skills = result.skills as Array<{ name: string; description: string }>;
      expect(skills[0].name).toBe("my-skill");
      expect(skills[0].description).toBe("A test skill");
    });
  });

  describe("create action", () => {
    it("creates a skill with valid name and content", async () => {
      const tool = createSkillManageTool(makeToolOptions(tmpDir));
      const result = parseResult(
        await callTool(tool, {
          action: "create",
          name: "docker-deploy",
          description: "How to deploy with Docker",
          content: "# Docker Deploy\n\nStep 1: Build the image\nStep 2: Push to registry",
        }),
      );

      expect(result.created).toBe(true);
      expect(result.path).toBeDefined();

      // Verify the file was created
      const skillPath = path.join(tmpDir, "skills", "docker-deploy", "SKILL.md");
      expect(fs.existsSync(skillPath)).toBe(true);

      const content = fs.readFileSync(skillPath, "utf-8");
      expect(content).toContain("name: docker-deploy");
      expect(content).toContain("description: How to deploy with Docker");
      expect(content).toContain("created_by: agent");
      expect(content).toContain("# Docker Deploy");
    });

    it("rejects invalid skill names", async () => {
      const tool = createSkillManageTool(makeToolOptions(tmpDir));
      const result = parseResult(
        await callTool(tool, {
          action: "create",
          name: "../path-traversal",
          content: "Bad content",
        }),
      );
      expect(result.created).toBe(false);
      expect(result.error).toContain("Invalid skill name");
    });

    it("rejects names with spaces and special chars", async () => {
      const tool = createSkillManageTool(makeToolOptions(tmpDir));

      const result1 = parseResult(
        await callTool(tool, { action: "create", name: "a", content: "x" }),
      );
      expect(result1.created).toBe(false);

      const result2 = parseResult(
        await callTool(tool, {
          action: "create",
          name: "UPPERCASE-Name",
          content: "x",
        }),
      );
      // Should lowercase and accept
      expect(result2.created).toBe(true);
    });

    it("rejects oversized content", async () => {
      const tool = createSkillManageTool(makeToolOptions(tmpDir));
      const bigContent = "x".repeat(11_000);
      const result = parseResult(
        await callTool(tool, {
          action: "create",
          name: "big-skill",
          content: bigContent,
        }),
      );
      expect(result.created).toBe(false);
      expect(result.error).toContain("exceeds maximum size");
    });

    it("rejects creating duplicate skill", async () => {
      const tool = createSkillManageTool(makeToolOptions(tmpDir));

      // Create first
      await callTool(tool, {
        action: "create",
        name: "my-skill",
        content: "First version",
      });

      // Try to create again
      const result = parseResult(
        await callTool(tool, {
          action: "create",
          name: "my-skill",
          content: "Second version",
        }),
      );
      expect(result.created).toBe(false);
      expect(result.error).toContain("already exists");
    });

    it("requires name and content", async () => {
      const tool = createSkillManageTool(makeToolOptions(tmpDir));

      const noName = parseResult(await callTool(tool, { action: "create", content: "x" }));
      expect(noName.created).toBe(false);

      const noContent = parseResult(await callTool(tool, { action: "create", name: "test" }));
      expect(noContent.created).toBe(false);
    });
  });

  describe("update action", () => {
    it("updates an existing agent-created skill", async () => {
      const tool = createSkillManageTool(makeToolOptions(tmpDir));

      // Create first
      await callTool(tool, {
        action: "create",
        name: "my-skill",
        description: "Original description",
        content: "Original content",
      });

      // Update
      const result = parseResult(
        await callTool(tool, {
          action: "update",
          name: "my-skill",
          content: "Updated content with improvements",
        }),
      );
      expect(result.updated).toBe(true);

      // Verify content was updated but frontmatter preserved
      const content = fs.readFileSync(path.join(tmpDir, "skills", "my-skill", "SKILL.md"), "utf-8");
      expect(content).toContain("name: my-skill");
      expect(content).toContain("description: Original description");
      expect(content).toContain("Updated content with improvements");
      expect(content).not.toContain("Original content");
    });

    it("rejects updating non-existent skill", async () => {
      const tool = createSkillManageTool(makeToolOptions(tmpDir));
      const result = parseResult(
        await callTool(tool, {
          action: "update",
          name: "nonexistent",
          content: "new content",
        }),
      );
      expect(result.updated).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("rejects updating human-authored skills", async () => {
      // Create a human-authored skill
      const skillDir = path.join(tmpDir, "skills", "human-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: human-skill\ndescription: By human\ncreated_by: human\n---\n\nHuman content.",
        "utf-8",
      );

      const tool = createSkillManageTool(makeToolOptions(tmpDir));
      const result = parseResult(
        await callTool(tool, {
          action: "update",
          name: "human-skill",
          content: "Overwritten!",
        }),
      );
      expect(result.updated).toBe(false);
      expect(result.error).toContain("not created by an agent");
    });
  });

  describe("delete action", () => {
    it("deletes an agent-created skill", async () => {
      const tool = createSkillManageTool(makeToolOptions(tmpDir));

      // Create first
      await callTool(tool, {
        action: "create",
        name: "test-skill",
        content: "Temporary skill",
      });

      const skillDir = path.join(tmpDir, "skills", "test-skill");
      expect(fs.existsSync(skillDir)).toBe(true);

      // Delete
      const result = parseResult(await callTool(tool, { action: "delete", name: "test-skill" }));
      expect(result.deleted).toBe(true);
      expect(fs.existsSync(skillDir)).toBe(false);
    });

    it("rejects deleting non-existent skill", async () => {
      const tool = createSkillManageTool(makeToolOptions(tmpDir));
      const result = parseResult(await callTool(tool, { action: "delete", name: "nonexistent" }));
      expect(result.deleted).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("rejects deleting human-authored skills", async () => {
      const skillDir = path.join(tmpDir, "skills", "human-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: human-skill\ncreated_by: human\n---\n\nContent",
        "utf-8",
      );

      const tool = createSkillManageTool(makeToolOptions(tmpDir));
      const result = parseResult(await callTool(tool, { action: "delete", name: "human-skill" }));
      expect(result.deleted).toBe(false);
      expect(result.error).toContain("not created by an agent");
    });
  });
});
