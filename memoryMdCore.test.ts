import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  buildMemoryContext,
  buildMemoryContextPreview,
  createDefaultFiles,
  ensureDirectoryStructure,
  listMemoryFiles,
  listReferenceFiles,
  readMemoryFile,
  writeMemoryFile,
} from "./memoryMdCore.js";

let memoryDir: string;

beforeEach(() => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-frontmatter-"));
});

afterEach(() => {
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

it("loads memory according to its folder", () => {
  writeMemoryFile(path.join(memoryDir, "system/policy.md"), "# Policy", { description: "Policy" });
  writeMemoryFile(path.join(memoryDir, "projects/example/note.md"), "# Project note", { description: "Project note" });
  writeMemoryFile(path.join(memoryDir, "reference/note.md"), "# Reference note", { description: "Reference note" });
  const context = buildMemoryContext({ localPath: memoryDir }, "/project");
  expect(context).toContain("## system/policy.md\n\n# Policy");
  expect(context).toContain("- projects/example/note.md — Project note");
  expect(context).not.toContain("- reference/note.md");
});

it("includes configured external roots alongside reference/", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-vault-"));
  try {
    const note = path.join(vault, "topic.md");
    fs.writeFileSync(note, "---\ndescription: External note\ntags: [vault]\n---\n# External content");
    const settings = { localPath: memoryDir, referencePaths: [vault] };
    expect(listReferenceFiles(settings, memoryDir)).toContain(note);
    expect(buildMemoryContext(settings, "/project")).not.toContain("External note [vault]");
    expect(buildMemoryContext(settings, "/project")).not.toContain(note);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

it("reports full-body files and index-only entries separately", () => {
  writeMemoryFile(path.join(memoryDir, "system/policy.md"), "# Policy", { description: "Policy" });
  writeMemoryFile(path.join(memoryDir, "projects/example/knowledge.md"), "# Knowledge", { description: "Knowledge" });
  const preview = buildMemoryContextPreview({ localPath: memoryDir }, "/project");
  expect(preview).toContain("- Full-body system files: **1**");
  expect(preview).toMatch(/- Index-only entries: \*\*\d+\*\*/);
  expect(preview).not.toContain("Injected full bodies/index entries");
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
