import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertWritable, isReadOnlyMemoryPath, writeMemoryFile } from "./memoryMdCore.js";
import { registerMemoryCleanup, registerMemoryDelete, registerMemoryReview, registerMemoryWrite } from "./tools.js";
import {
  collectReviewNotes,
  dismissReviewCandidate,
  findRelatedCandidates,
  findStale,
  findStubs,
  findTimeboxed,
  findVolatile,
  formatReviewReport,
  reviewMemories,
  SIMILARITY_THRESHOLD,
  suggestKeeper,
  tagSimilarity,
} from "./memoryReview.js";

let memoryDir: string;

function write(relPath: string, options: { description: string; tags?: string[]; updated?: string; body?: string }): void {
  writeMemoryFile(path.join(memoryDir, relPath), options.body ?? "# Note\n\n".padEnd(600, "x"), {
    description: options.description,
    ...(options.tags ? { tags: options.tags } : {}),
    created: "2026-08-27",
    ...(options.updated ? { updated: options.updated } : {}),
  });
}

beforeEach(() => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-review-"));
});

afterEach(() => {
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

describe("read-only areas", () => {
  it("refuses writes anywhere under reference/", () => {
    expect(assertWritable(memoryDir, path.join(memoryDir, "reference/vault/PKM/note.md"))).toContain("read-only");
    expect(assertWritable(memoryDir, path.join(memoryDir, "reference/index.md"))).toContain("read-only");
    expect(isReadOnlyMemoryPath(memoryDir, path.join(memoryDir, "reference/a/b.md"))).toBe(true);
  });

  it("allows system/, projects/ and archive/", () => {
    expect(assertWritable(memoryDir, path.join(memoryDir, "system/preferences.md"))).toBeNull();
    expect(assertWritable(memoryDir, path.join(memoryDir, "projects/x/plan.md"))).toBeNull();
    expect(assertWritable(memoryDir, path.join(memoryDir, "archive/projects/x/old.md"))).toBeNull();
  });
});

describe("collectReviewNotes", () => {
  it("skips reference/ and generated indexes", () => {
    write("system/preferences.md", { description: "Prefs", tags: ["user"] });
    write("projects/a/plan.md", { description: "Plan", tags: ["a"] });
    write("projects/INDEX.md", { description: "Generated index", tags: ["index"] });
    write("reference/vault/note.md", { description: "Vault note", tags: ["vault"] });

    const paths = collectReviewNotes(memoryDir).map((note) => note.relPath);
    expect(paths).toEqual(["projects/a/plan.md", "system/preferences.md"]);
  });

  // Regression: archived notes were re-reported, and the only offered action was
  // to archive them again, producing archive/archive/...
  it("skips archive/ so archived notes are never re-reported", () => {
    write("system/preferences.md", { description: "Prefs", tags: ["user"] });
    write("archive/long-term/tech/pricing.md", { description: "Pricing researched 2026-09", tags: ["llm"] });

    const paths = collectReviewNotes(memoryDir).map((note) => note.relPath);
    expect(paths).toEqual(["system/preferences.md"]);

    const result = reviewMemories(memoryDir);
    expect(result.findings.every((finding) => finding.paths.every((p) => !p.startsWith("archive/")))).toBe(true);
  });
});

describe("tagSimilarity", () => {
  // Calibrated against the real cleanup: true clusters scored 0.33-0.80,
  // unrelated controls 0.00-0.13.
  it("separates real duplicate clusters from unrelated notes", () => {
    const boundaryA = ["bluecatbio", "bcx", "vibration", "allowed-unbalance", "thresholds"];
    const boundaryB = ["bluecatbio", "bcx", "vibration", "allowed-unbalance", "thresholds", "boundary"];
    const unrelated = ["blueflow", "winforms", "integration-tests"];

    expect(tagSimilarity(boundaryA, boundaryB)).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
    expect(tagSimilarity(boundaryA, unrelated)).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it("returns 0 when either side has no tags", () => {
    expect(tagSimilarity([], ["a"])).toBe(0);
  });
});

describe("findRelatedCandidates", () => {
  it("clusters the allowed-unbalance chain and suggests the newest as keeper", () => {
    write("projects/bcx/allowed-unbalance-12-7.md", {
      description: "Allowed-unbalance high-speed limits",
      tags: ["bluecatbio", "bcx", "vibration", "allowed-unbalance", "thresholds"],
      updated: "2026-08-27",
    });
    write("projects/bcx/allowed-boundary-gradual.md", {
      description: "Corrected interpolation 450@500 to 25@2100",
      tags: ["bluecatbio", "bcx", "vibration", "allowed-unbalance", "thresholds", "boundary"],
      updated: "2026-08-27",
    });
    write("projects/bcx/current-boundary-600-25.md", {
      description: "Impact of current 600/25 boundary",
      tags: ["bluecatbio", "bcx", "vibration", "allowed-unbalance", "fingerprint"],
      updated: "2026-08-28",
      // Both newest and most substantial, so the suggestion is unambiguous.
      body: "# Current boundary\n\n".padEnd(2000, "x"),
    });

    const findings = findRelatedCandidates(collectReviewNotes(memoryDir));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.paths).toHaveLength(3);
    expect(findings[0]!.suggestedKeep).toBe("projects/bcx/current-boundary-600-25.md");
    expect(findings[0]!.keeperReason).toBe("most substantial and newest");
  });

  it("does not cluster unrelated notes that merely share a folder", () => {
    write("projects/bcx/teach-importer.md", { description: "Importer", tags: ["importer", "recordings"] });
    write("projects/bcx/audit-timeline.md", { description: "Timeline", tags: ["audit-trail", "schema"] });

    expect(findRelatedCandidates(collectReviewNotes(memoryDir))).toHaveLength(0);
  });

  // Regression: union-find chained A~B~C and turned a whole 13-note project
  // folder into one "duplicate cluster".
  it("does not chain transitively through a shared middle note", () => {
    // left and right share nothing; only the middle note bridges them.
    write("projects/a/left.md", { description: "Left", tags: ["a1", "a2", "a3"] });
    write("projects/a/middle.md", { description: "Middle", tags: ["a1", "a2", "a3", "b1", "b2", "b3"] });
    write("projects/a/right.md", { description: "Right", tags: ["b1", "b2", "b3"] });

    const notes = collectReviewNotes(memoryDir);
    expect(tagSimilarity(notes[0]!.tags, notes[2]!.tags)).toBeLessThan(SIMILARITY_THRESHOLD);

    const findings = findRelatedCandidates(notes);
    for (const finding of findings) {
      const paths = finding.paths;
      expect(paths.includes("projects/a/left.md") && paths.includes("projects/a/right.md")).toBe(false);
    }
  });

  // Regression: in a big folder every note carries the project's own tags, which
  // made unrelated notes look similar.
  it("ignores tags carried by nearly every note in a large folder", () => {
    const project = ["bluecatbio", "bcx", "vibration"];
    const distinct = ["importer", "charts", "thresholds", "simulator", "baseline", "naming", "audit"];
    distinct.forEach((tag, index) => {
      write(`projects/big/note-${index}.md`, { description: `Note ${tag}`, tags: [...project, tag] });
    });

    expect(collectReviewNotes(memoryDir)).toHaveLength(distinct.length);
    expect(findRelatedCandidates(collectReviewNotes(memoryDir))).toHaveLength(0);
  });

  it("does not cluster similar notes across different project folders", () => {
    const tags = ["architecture", "visualization", "focus-mode", "blueflow"];
    write("projects/one/graph.md", { description: "Graph focus", tags });
    write("projects/two/graph.md", { description: "Graph focus", tags });

    expect(findRelatedCandidates(collectReviewNotes(memoryDir))).toHaveLength(0);
  });
});

describe("content rules", () => {
  it("flags time-boxed notes and raises severity inside system", () => {
    write("system/klausurplan.md", { description: "Lernplan, Klausur in drei Wochen", tags: ["study"] });
    write("projects/a/sprint.md", { description: "Sprint planning for the next sprint", tags: ["plan"] });
    write("projects/a/durable.md", { description: "Stable architecture decision", tags: ["arch"] });

    const findings = findTimeboxed(collectReviewNotes(memoryDir));
    const paths = findings.map((finding) => finding.paths[0]);
    expect(paths).toContain("system/klausurplan.md");
    expect(paths).not.toContain("projects/a/durable.md");

    const system = findings.find((finding) => finding.paths[0] === "system/klausurplan.md")!;
    const project = findings.find((finding) => finding.paths[0] === "projects/a/sprint.md")!;
    expect(system.severity).toBeGreaterThan(project.severity);
    expect(system.detail).toContain("always-loaded system memory");
  });

  it("flags volatile facts", () => {
    write("long-term/tech/pricing.md", { description: "Verified LLM subscription pricing (researched 2026-09)", tags: ["llm"] });
    write("long-term/user/profile.md", { description: "Profile with 40 followers and 54 repos", tags: ["user"] });
    write("projects/a/stable.md", { description: "How the parser handles nested loops", tags: ["parser"] });

    const paths = findVolatile(collectReviewNotes(memoryDir)).map((finding) => finding.paths[0]);
    expect(paths).toContain("long-term/tech/pricing.md");
    expect(paths).toContain("long-term/user/profile.md");
    expect(paths).not.toContain("projects/a/stable.md");
  });

  it("flags stubs below the byte threshold", () => {
    write("projects/a/stub.md", { description: "Tiny", tags: ["x"], body: "# Tiny\n\nnot much here" });
    write("projects/a/full.md", { description: "Full", tags: ["x"], body: "# Full\n\n".padEnd(900, "y") });

    const paths = findStubs(collectReviewNotes(memoryDir)).map((finding) => finding.paths[0]);
    expect(paths).toEqual(["projects/a/stub.md"]);
  });

  it("flags a note far behind its folder, but not a uniformly old folder", () => {
    const now = Date.parse("2026-09-14");
    write("projects/live/old-plan.md", { description: "Abandoned plan", tags: ["p"], updated: "2026-05-03" });
    write("projects/live/a.md", { description: "Recent", tags: ["a"], updated: "2026-09-11" });
    write("projects/live/b.md", { description: "Recent", tags: ["b"], updated: "2026-09-12" });
    write("projects/dormant/x.md", { description: "Old", tags: ["x"], updated: "2026-01-02" });
    write("projects/dormant/y.md", { description: "Old", tags: ["y"], updated: "2026-01-03" });

    const paths = findStale(collectReviewNotes(memoryDir), now).map((finding) => finding.paths[0]);
    expect(paths).toEqual(["projects/live/old-plan.md"]);
  });
});

describe("memory_review tool", () => {
  it("returns structured evidence without changing the filesystem", async () => {
    write("projects/a/one.md", { description: "One", tags: ["x", "y"] });
    write("projects/a/two.md", { description: "Two", tags: ["x", "y"] });
    let tool: any;
    registerMemoryReview({ registerTool: (definition: any) => { tool = definition; } } as any, { localPath: memoryDir });
    const before = fs.readdirSync(memoryDir, { recursive: true }).map(String).sort();
    const result = await tool.execute("call", { kind: "related" }, undefined, undefined, { cwd: memoryDir });
    expect(result.details.readOnly).toBe(true);
    expect(result.details.findings[0].evidence.averageTagSimilarity).toBe(1);
    expect(fs.readdirSync(memoryDir, { recursive: true }).map(String).sort()).toEqual(before);
  });
});

describe("memory_cleanup", () => {
  function cleanupTool() {
    let tool: any;
    registerMemoryCleanup({ registerTool: (definition: any) => { tool = definition; } } as any, { localPath: memoryDir });
    return tool;
  }

  function execute(tool: any, params: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    const ctx = { cwd: memoryDir, hasUI: false, ui: { confirm: async () => false }, ...overrides };
    return tool.execute("call", params, undefined, undefined, ctx);
  }

  it("archives a non-system note without approval", async () => {
    write("projects/a/old.md", { description: "Old", tags: ["old"] });
    const original = fs.readFileSync(path.join(memoryDir, "projects/a/old.md"), "utf8");
    const result = await execute(cleanupTool(), { action: "archive", paths: ["projects/a/old.md"] });
    expect(result.details.success).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "projects/a/old.md"))).toBe(false);
    expect(fs.readFileSync(path.join(memoryDir, "archive/projects/a/old.md"), "utf8")).toBe(original);
  });

  it("rejects reference paths and existing archive destinations without partial changes", async () => {
    write("projects/a/one.md", { description: "One" });
    write("projects/a/two.md", { description: "Two" });
    write("archive/projects/a/two.md", { description: "Existing" });
    const tool = cleanupTool();

    const reference = await execute(tool, { action: "archive", paths: ["reference/a.md"] });
    expect(reference.details.success).toBe(false);

    const collision = await execute(tool, { action: "archive", paths: ["projects/a/one.md", "projects/a/two.md"] });
    expect(collision.details.success).toBe(false);
    expect(fs.existsSync(path.join(memoryDir, "projects/a/one.md"))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "projects/a/two.md"))).toBe(true);
  });

  it("requires approval for bulk archives", async () => {
    const paths = Array.from({ length: 6 }, (_, index) => `projects/a/note-${index}.md`);
    paths.forEach((relPath, index) => write(relPath, { description: `Note ${index}` }));
    const denied = await execute(cleanupTool(), { action: "archive", paths });
    expect(denied.details.success).toBe(false);
    expect(paths.every((relPath) => fs.existsSync(path.join(memoryDir, relPath)))).toBe(true);
  });

  it("requires approval for system archives", async () => {
    write("system/preferences.md", { description: "Preferences" });
    const tool = cleanupTool();
    const denied = await execute(tool, { action: "archive", paths: ["system/preferences.md"] });
    expect(denied.details.success).toBe(false);
    expect(fs.existsSync(path.join(memoryDir, "system/preferences.md"))).toBe(true);

    const approved = await execute(tool, { action: "archive", paths: ["system/preferences.md"] }, {
      hasUI: true,
      ui: { confirm: async () => true },
    });
    expect(approved.details.success).toBe(true);
  });

  it("merges notes while preserving source copies in archive", async () => {
    write("projects/a/one.md", { description: "One", tags: ["one"], body: "# One\n\nFirst" });
    write("projects/a/two.md", { description: "Two", tags: ["two"], body: "# Two\n\nSecond" });
    const result = await execute(cleanupTool(), {
      action: "merge", paths: ["projects/a/one.md", "projects/a/two.md"], targetPath: "projects/a/merged.md",
      content: "# Merged\n\nFirst and second", description: "Merged notes", tags: ["merged"],
    });
    expect(result.details.success).toBe(true);
    expect(fs.readFileSync(path.join(memoryDir, "projects/a/merged.md"), "utf8")).toContain("First and second");
    expect(fs.existsSync(path.join(memoryDir, "archive/projects/a/one.md"))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "archive/projects/a/two.md"))).toBe(true);
  });

  it("rolls back a merge when archiving a later source fails", async () => {
    write("projects/a/one.md", { description: "One", body: "# One" });
    write("projects/a/two.md", { description: "Two", body: "# Two" });
    const originalRename = fs.renameSync;
    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      renameCalls++;
      if (renameCalls === 2) throw new Error("forced archive failure");
      return originalRename(from, to);
    }) as typeof fs.renameSync);

    try {
      const result = await execute(cleanupTool(), {
        action: "merge", paths: ["projects/a/one.md", "projects/a/two.md"], targetPath: "projects/a/merged.md",
        content: "# Merged", description: "Merged notes",
      });
      expect(result.details.success).toBe(false);
      expect(result.details.message).toContain("without partial changes");
      expect(fs.existsSync(path.join(memoryDir, "projects/a/one.md"))).toBe(true);
      expect(fs.existsSync(path.join(memoryDir, "projects/a/two.md"))).toBe(true);
      expect(fs.existsSync(path.join(memoryDir, "projects/a/merged.md"))).toBe(false);
      expect(fs.existsSync(path.join(memoryDir, "archive/projects/a/one.md"))).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("requires approval for an update that overwrites content", async () => {
    write("projects/a/note.md", { description: "Note", body: "# Original" });
    const denied = await execute(cleanupTool(), { action: "update", targetPath: "projects/a/note.md", content: "# Changed" });
    expect(denied.details.success).toBe(false);
    expect(fs.readFileSync(path.join(memoryDir, "projects/a/note.md"), "utf8")).toContain("Original");
    const approved = await execute(cleanupTool(), { action: "update", targetPath: "projects/a/note.md", content: "# Changed" }, {
      hasUI: true, ui: { confirm: async () => true },
    });
    expect(approved.details.success).toBe(true);
    expect(fs.readFileSync(path.join(memoryDir, "projects/a/note.md"), "utf8")).toContain("Changed");
  });

  it("requires approval before delete", async () => {
    write("projects/a/note.md", { description: "Note" });
    const result = await execute(cleanupTool(), { action: "delete", paths: ["projects/a/note.md"] });
    expect(result.details.success).toBe(false);
    expect(fs.existsSync(path.join(memoryDir, "projects/a/note.md"))).toBe(true);
  });

  it("dismisses a candidate without changing notes", async () => {
    write("projects/a/one.md", { description: "One", tags: ["x", "y"] });
    write("projects/a/two.md", { description: "Two", tags: ["x", "y"] });
    const candidate = reviewMemories(memoryDir, { kind: "related" }).findings[0]!;
    const result = await execute(cleanupTool(), {
      action: "dismiss", candidateId: candidate.id, fingerprint: candidate.fingerprint,
    });
    expect(result.details.success).toBe(true);
    expect(reviewMemories(memoryDir, { kind: "related" }).findings).toHaveLength(0);
  });
});

describe("dangerous memory mutations", () => {
  function registeredTool(register: (pi: any, settings: any) => void) {
    let tool: any;
    register({ registerTool: (definition: any) => { tool = definition; } }, { localPath: memoryDir });
    return tool;
  }

  it("requires approval before modifying system memory", async () => {
    write("system/preferences.md", { description: "Preferences" });
    const tool = registeredTool(registerMemoryWrite);
    const result = await tool.execute("call", {
      path: "system/preferences.md", content: "# Changed", description: "Changed",
    }, undefined, undefined, { cwd: memoryDir, hasUI: false });
    expect(result.details.approvalRequired).toBe(true);
    expect(fs.readFileSync(path.join(memoryDir, "system/preferences.md"), "utf8")).not.toContain("# Changed");
  });

  it("requires approval before permanent deletion", async () => {
    write("projects/a/note.md", { description: "Note" });
    const tool = registeredTool(registerMemoryDelete);
    const result = await tool.execute("call", { path: "projects/a/note.md" }, undefined, undefined, {
      cwd: memoryDir, hasUI: false,
    });
    expect(result.details.approvalRequired).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "projects/a/note.md"))).toBe(true);
  });
});

describe("suggestKeeper", () => {
  function note(relPath: string, updated: string, bodyBytes: number, description = "d"): Parameters<typeof suggestKeeper>[0][number] {
    return { relPath, area: "projects", folder: "projects/a", description, title: "", tags: ["x"], updated, bodyBytes, contentHash: relPath };
  }

  // The real miss: a narrow one-incident report five days newer beat the broad
  // operational note it did not supersede.
  it("prefers a much broader note over a slightly newer thin one", () => {
    const suggestion = suggestKeeper([
      note("projects/a/incident.md", "2026-09-01", 1874),
      note("projects/a/operational.md", "2026-08-27", 5349),
    ]);
    expect(suggestion.note.relPath).toBe("projects/a/operational.md");
  });

  it("prefers the newer note when substance is comparable", () => {
    const suggestion = suggestKeeper([
      note("projects/a/old.md", "2026-08-27", 2000),
      note("projects/a/new.md", "2026-09-01", 2000),
    ]);
    expect(suggestion.note.relPath).toBe("projects/a/new.md");
  });

  it("reports when one note is both newest and most substantial", () => {
    const suggestion = suggestKeeper([
      note("projects/a/small-old.md", "2026-08-01", 500),
      note("projects/a/big-new.md", "2026-09-01", 9000),
    ]);
    expect(suggestion.note.relPath).toBe("projects/a/big-new.md");
    expect(suggestion.reason).toContain("newest");
    expect(suggestion.reason).toContain("most substantial");
  });
});

describe("reviewMemories", () => {
  it("never reports a reference/ path and respects the limit", () => {
    for (let i = 0; i < 25; i++) {
      write(`reference/vault/note-${i}.md`, { description: `Klausur in drei Wochen ${i}`, tags: ["vault"] });
    }
    write("system/klausurplan.md", { description: "Klausur in drei Wochen", tags: ["study"] });

    const result = reviewMemories(memoryDir, { limit: 5 });
    expect(result.findings.length).toBeLessThanOrEqual(5);
    expect(result.findings.every((finding) => finding.paths.every((p) => !p.startsWith("reference/")))).toBe(true);
    expect(result.noteCount).toBe(1);
  });

  it("returns stable candidate identity, evidence, and scoped filters", () => {
    write("projects/a/one.md", { description: "Boundary A", tags: ["x", "y", "z"] });
    write("projects/a/two.md", { description: "Boundary B", tags: ["x", "y", "z"] });
    write("projects/b/stub.md", { description: "Tiny", body: "# Tiny" });

    const first = reviewMemories(memoryDir, { folder: "projects/a", kind: "related" });
    const second = reviewMemories(memoryDir, { folder: "projects/a", kind: "related" });
    expect(first.noteCount).toBe(2);
    expect(first.findings).toHaveLength(1);
    expect(first.findings[0]!.id).toBe(second.findings[0]!.id);
    expect(first.findings[0]!.fingerprint).toBe(second.findings[0]!.fingerprint);
    expect(first.findings[0]!.evidence).toMatchObject({ averageTagSimilarity: 1 });
  });

  it("hides dismissed candidates until an involved note changes", () => {
    write("projects/a/one.md", { description: "Boundary A", tags: ["x", "y", "z"] });
    write("projects/a/two.md", { description: "Boundary B", tags: ["x", "y", "z"] });
    const candidate = reviewMemories(memoryDir, { kind: "related" }).findings[0]!;

    dismissReviewCandidate(memoryDir, candidate.id, candidate.fingerprint);
    expect(reviewMemories(memoryDir, { kind: "related" }).findings).toHaveLength(0);
    expect(reviewMemories(memoryDir, { kind: "related", includeDismissed: true }).findings[0]!.dismissed).toBe(true);

    write("projects/a/two.md", { description: "Boundary B", tags: ["x", "y", "z"], body: "# Changed\n\nNew detail" });
    expect(reviewMemories(memoryDir, { kind: "related" }).findings).toHaveLength(1);
  });

  it("reports a clean corpus without findings", () => {
    write("system/preferences.md", { description: "Stable preferences", tags: ["user"] });
    const result = reviewMemories(memoryDir);
    expect(result.findings).toHaveLength(0);
    expect(formatReviewReport(result)).toContain("No cleanup candidates");
  });

  it("ranks duplicate clusters above lower-severity findings", () => {
    write("projects/a/one.md", { description: "Boundary A", tags: ["x", "y", "z"], updated: "2026-08-27" });
    write("projects/a/two.md", { description: "Boundary B", tags: ["x", "y", "z"], updated: "2026-08-28" });
    write("projects/a/tiny.md", { description: "Tiny", tags: ["q"], body: "# t" });

    const result = reviewMemories(memoryDir);
    expect(result.findings[0]!.kind).toBe("related");
    expect(formatReviewReport(result)).toContain("Related-note candidates");
  });
});
