import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertWritable, isReadOnlyMemoryPath, writeMemoryFile } from "./memoryMdCore.js";
import {
  collectReviewNotes,
  findDuplicateClusters,
  findStale,
  findStubs,
  findTimeboxed,
  findVolatile,
  formatReviewReport,
  reviewMemories,
  SIMILARITY_THRESHOLD,
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

  it("allows core/, projects/ and archive/", () => {
    expect(assertWritable(memoryDir, path.join(memoryDir, "core/user/prefer.md"))).toBeNull();
    expect(assertWritable(memoryDir, path.join(memoryDir, "projects/x/plan.md"))).toBeNull();
    expect(assertWritable(memoryDir, path.join(memoryDir, "archive/projects/x/old.md"))).toBeNull();
  });
});

describe("collectReviewNotes", () => {
  it("skips reference/ and generated indexes", () => {
    write("core/user/prefer.md", { description: "Prefs", tags: ["user"] });
    write("projects/a/plan.md", { description: "Plan", tags: ["a"] });
    write("projects/INDEX.md", { description: "Generated index", tags: ["index"] });
    write("reference/vault/note.md", { description: "Vault note", tags: ["vault"] });

    const paths = collectReviewNotes(memoryDir).map((note) => note.relPath);
    expect(paths).toEqual(["core/user/prefer.md", "projects/a/plan.md"]);
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

describe("findDuplicateClusters", () => {
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
    });

    const findings = findDuplicateClusters(collectReviewNotes(memoryDir));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.paths).toHaveLength(3);
    expect(findings[0]!.suggestedKeep).toBe("projects/bcx/current-boundary-600-25.md");
  });

  it("does not cluster unrelated notes that merely share a folder", () => {
    write("projects/bcx/teach-importer.md", { description: "Importer", tags: ["importer", "recordings"] });
    write("projects/bcx/audit-timeline.md", { description: "Timeline", tags: ["audit-trail", "schema"] });

    expect(findDuplicateClusters(collectReviewNotes(memoryDir))).toHaveLength(0);
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

    const findings = findDuplicateClusters(notes);
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
    expect(findDuplicateClusters(collectReviewNotes(memoryDir))).toHaveLength(0);
  });

  it("does not cluster similar notes across different project folders", () => {
    const tags = ["architecture", "visualization", "focus-mode", "blueflow"];
    write("projects/one/graph.md", { description: "Graph focus", tags });
    write("projects/two/graph.md", { description: "Graph focus", tags });

    expect(findDuplicateClusters(collectReviewNotes(memoryDir))).toHaveLength(0);
  });
});

describe("content rules", () => {
  it("flags time-boxed notes and raises severity inside core", () => {
    write("core/user/klausurplan.md", { description: "Lernplan, Klausur in drei Wochen", tags: ["study"] });
    write("projects/a/sprint.md", { description: "Sprint planning for the next sprint", tags: ["plan"] });
    write("projects/a/durable.md", { description: "Stable architecture decision", tags: ["arch"] });

    const findings = findTimeboxed(collectReviewNotes(memoryDir));
    const paths = findings.map((finding) => finding.paths[0]);
    expect(paths).toContain("core/user/klausurplan.md");
    expect(paths).not.toContain("projects/a/durable.md");

    const core = findings.find((finding) => finding.paths[0] === "core/user/klausurplan.md")!;
    const project = findings.find((finding) => finding.paths[0] === "projects/a/sprint.md")!;
    expect(core.severity).toBeGreaterThan(project.severity);
    expect(core.detail).toContain("always-injected core");
  });

  it("flags volatile facts", () => {
    write("core/tech/pricing.md", { description: "Verified LLM subscription pricing (researched 2026-09)", tags: ["llm"] });
    write("core/user/profile.md", { description: "Profile with 40 followers and 54 repos", tags: ["user"] });
    write("projects/a/stable.md", { description: "How the parser handles nested loops", tags: ["parser"] });

    const paths = findVolatile(collectReviewNotes(memoryDir)).map((finding) => finding.paths[0]);
    expect(paths).toContain("core/tech/pricing.md");
    expect(paths).toContain("core/user/profile.md");
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

describe("reviewMemories", () => {
  it("never reports a reference/ path and respects the limit", () => {
    for (let i = 0; i < 25; i++) {
      write(`reference/vault/note-${i}.md`, { description: `Klausur in drei Wochen ${i}`, tags: ["vault"] });
    }
    write("core/user/klausurplan.md", { description: "Klausur in drei Wochen", tags: ["study"] });

    const result = reviewMemories(memoryDir, { limit: 5 });
    expect(result.findings.length).toBeLessThanOrEqual(5);
    expect(result.findings.every((finding) => finding.paths.every((p) => !p.startsWith("reference/")))).toBe(true);
    expect(result.noteCount).toBe(1);
  });

  it("reports a clean corpus without findings", () => {
    write("core/user/prefer.md", { description: "Stable preferences", tags: ["user"] });
    const result = reviewMemories(memoryDir);
    expect(result.findings).toHaveLength(0);
    expect(formatReviewReport(result)).toContain("No cleanup candidates");
  });

  it("ranks duplicate clusters above lower-severity findings", () => {
    write("projects/a/one.md", { description: "Boundary A", tags: ["x", "y", "z"], updated: "2026-08-27" });
    write("projects/a/two.md", { description: "Boundary B", tags: ["x", "y", "z"], updated: "2026-08-28" });
    write("projects/a/tiny.md", { description: "Tiny", tags: ["q"], body: "# t" });

    const result = reviewMemories(memoryDir);
    expect(result.findings[0]!.kind).toBe("duplicates");
    expect(formatReviewReport(result)).toContain("Duplicate clusters");
  });
});
