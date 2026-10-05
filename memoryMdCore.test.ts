import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  buildMemoryContext,
  createDefaultFiles,
  ensureDirectoryStructure,
  listMemoryFiles,
  readMemoryFile,
} from "./memoryMdCore.js";
import { registerMemoryWrite } from "./tools.js";

let memoryDir: string;

beforeEach(() => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-frontmatter-"));
});

afterEach(() => {
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

function legacyNote(relPath: string): string {
  const fullPath = path.join(memoryDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, [
    "---",
    "description: Legacy note",
    "tags: [legacy]",
    "scope: obsolete-scope",
    "load: obsolete-policy",
    "project: legacy-project",
    "status: stale",
    "---",
    "# Legacy body",
  ].join("\n"));
  return fullPath;
}

it("accepts legacy metadata without validating its policy values", () => {
  const memory = readMemoryFile(legacyNote("long-term/legacy.md"));
  expect(memory?.frontmatter.description).toBe("Legacy note");
  expect(memory?.frontmatter.tags).toEqual(["legacy"]);
  expect(memory?.content.trim()).toBe("# Legacy body");
});

it("loads memory by folder regardless of legacy metadata", () => {
  legacyNote("system/policy.md");
  legacyNote("projects/example/note.md");
  legacyNote("reference/note.md");
  const context = buildMemoryContext({ localPath: memoryDir }, "/project");
  expect(context).toContain("## system/policy.md\n\n# Legacy body");
  expect(context).toContain("- projects/example/note.md — Legacy note [legacy]");
  expect(context).not.toContain("- reference/note.md —");
  expect(context.match(/# Legacy body/g)).toHaveLength(1);
});

it.each(["overwrite", "append"] as const)("preserves legacy metadata when updating via %s", async (mode) => {
  const fullPath = legacyNote("long-term/legacy.md");
  let tool: any;
  registerMemoryWrite({ registerTool: (definition: unknown) => { tool = definition; } } as any, { localPath: memoryDir });
  await tool.execute("test", {
    path: "long-term/legacy.md", content: "Updated body", description: "Updated description", mode,
  }, undefined, undefined, { cwd: "/project" });
  expect(readMemoryFile(fullPath)?.frontmatter).toMatchObject({
    description: "Updated description",
    scope: "obsolete-scope", load: "obsolete-policy", project: "legacy-project", status: "stale",
  });
  expect(readMemoryFile(fullPath)?.content).toContain("Updated body");
});

it("omits removed properties from new default notes", () => {
  ensureDirectoryStructure(memoryDir);
  createDefaultFiles(memoryDir);
  const files = listMemoryFiles(memoryDir);
  expect(files).toHaveLength(3);
  expect(fs.existsSync(path.join(memoryDir, "core"))).toBe(false);
  for (const file of files) {
    const metadata = readMemoryFile(file)?.frontmatter;
    for (const field of ["scope", "load", "project", "status"]) {
      expect(metadata).not.toHaveProperty(field);
    }
  }
});
