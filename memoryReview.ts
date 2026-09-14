import fs from "node:fs";
import path from "node:path";
import { isReadOnlyMemoryPath, listMemoryFiles, readMemoryFile } from "./memoryMdCore.js";

/**
 * Memory review: mechanical detection of cleanup candidates.
 *
 * Every rule here is deliberately non-LLM and deterministic, and every threshold
 * was calibrated against a real cleanup of this corpus:
 *
 * - Tag-set Jaccard on genuinely duplicated clusters measured 0.33-0.80, while
 *   unrelated control pairs measured 0.00-0.13, so 0.30 separates them.
 * - The time-boxed pattern was validated against a "Klausur in drei Wochen"
 *   study plan that had been sitting in always-injected core for months.
 *
 * Nothing in this module mutates the corpus; it only reports. Deletion stays a
 * separate, explicit step so a false positive can never destroy a memory.
 */

/** Areas the review never reads or proposes changes for. */
export const REVIEW_EXCLUDED_AREAS: ReadonlySet<string> = new Set(["reference"]);

export const SIMILARITY_THRESHOLD = 0.3;
/** Tags on more than this share of a folder describe the folder, not the note. */
export const UBIQUITOUS_TAG_RATIO = 0.7;
/** Below this many notes, per-folder tag frequencies are too small to mean anything. */
export const MIN_NOTES_FOR_TAG_WEIGHTING = 6;
export const FOLDER_FILE_GUIDELINE = 15;
export const STALE_DAYS = 120;
export const STALE_FOLDER_LAG_DAYS = 90;
export const STUB_BYTES = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

const TIMEBOXED_PATTERN =
  /\b(klausur|exam|sprint|deadline|midterm|endterm|in\s+(?:\d+|drei|zwei|vier)\s+(?:wochen|tagen|weeks|days))\b/i;

const VOLATILE_PATTERN =
  /\b(researched|pricing|as of|current price|\d+\s+(?:followers|connections|repos|repositories)|20\d{2}\)?\s*$)/i;

export interface ReviewNote {
  relPath: string;
  area: string;
  folder: string;
  description: string;
  title: string;
  tags: string[];
  updated?: string | undefined;
  bodyBytes: number;
}

export type FindingKind = "duplicates" | "fragmentation" | "timeboxed" | "volatile" | "stale" | "stub";

export interface Finding {
  kind: FindingKind;
  /** Higher sorts first. */
  severity: number;
  paths: string[];
  summary: string;
  detail: string;
  /** For clusters: the member most likely worth keeping (newest). Never authoritative. */
  suggestedKeep?: string;
}

function firstHeading(content: string): string {
  for (const line of content.split("\n")) {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match) return match[1]!.trim();
  }
  return "";
}

/** Load every reviewable note, skipping read-only areas and generated indexes. */
export function collectReviewNotes(memoryDir: string): ReviewNote[] {
  if (!fs.existsSync(memoryDir)) return [];

  const notes: ReviewNote[] = [];
  for (const fullPath of listMemoryFiles(memoryDir)) {
    if (isReadOnlyMemoryPath(memoryDir, fullPath)) continue;

    const relPath = path.relative(memoryDir, fullPath);
    const segments = relPath.split(path.sep);
    const area = segments[0] ?? "";
    if (REVIEW_EXCLUDED_AREAS.has(area)) continue;
    if (path.basename(relPath).toLocaleLowerCase() === "index.md") continue;

    const memory = readMemoryFile(fullPath);
    if (!memory) continue;

    notes.push({
      relPath,
      area,
      folder: segments.length > 1 ? segments.slice(0, -1).join("/") : area,
      description: memory.frontmatter.description ?? "",
      title: firstHeading(memory.content),
      tags: (memory.frontmatter.tags ?? []).map((tag) => tag.toLocaleLowerCase().trim()).filter(Boolean),
      updated: memory.frontmatter.updated ?? memory.frontmatter.created,
      bodyBytes: memory.content.length,
    });
  }
  return notes.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export function tagSimilarity(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const tag of left) if (right.has(tag)) shared++;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function newestFirst(notes: readonly ReviewNote[]): ReviewNote[] {
  return [...notes].sort((a, b) => (parseDate(b.updated) ?? 0) - (parseDate(a.updated) ?? 0));
}

/** Tags that actually distinguish notes inside a folder.

Tags carried by nearly every note in a folder name the folder, not the note:
in a BCX folder `bluecatbio`, `bcx` and `vibration` are on everything, so leaving
them in makes every pair look similar. They are dropped once the folder is big
enough for the frequencies to mean something. */
function discriminativeTags(members: readonly ReviewNote[]): Map<string, string[]> {
  const counts = new Map<string, number>();
  for (const note of members) {
    for (const tag of new Set(note.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  const weighted = members.length >= MIN_NOTES_FOR_TAG_WEIGHTING;
  const result = new Map<string, string[]>();
  for (const note of members) {
    const tags = weighted
      ? note.tags.filter((tag) => (counts.get(tag) ?? 0) / members.length <= UBIQUITOUS_TAG_RATIO)
      : [...note.tags];
    result.set(note.relPath, tags);
  }
  return result;
}

/**
 * Cluster same-folder notes whose distinguishing tags overlap past the threshold.
 *
 * Two deliberate restrictions, both learned from running this on a real corpus:
 *
 * - Folder-scoped, because two notes in different projects sharing a generic tag
 *   such as `architecture` are not duplicates.
 * - Clusters must be cliques. Transitive merging (A~B, B~C therefore ABC) turned a
 *   whole 13-note project folder into one "duplicate cluster", since neighbouring
 *   notes in an active project always share some vocabulary. Requiring every member
 *   to be similar to every other member keeps clusters to things that really are
 *   about the same subject.
 */
export function findDuplicateClusters(notes: readonly ReviewNote[]): Finding[] {
  const byFolder = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    byFolder.set(note.folder, [...(byFolder.get(note.folder) ?? []), note]);
  }

  const findings: Finding[] = [];
  for (const [folder, members] of byFolder) {
    if (members.length < 2) continue;

    const tagsFor = discriminativeTags(members);
    const similarity = (a: ReviewNote, b: ReviewNote): number =>
      tagSimilarity(tagsFor.get(a.relPath) ?? [], tagsFor.get(b.relPath) ?? []);

    const pairs: Array<{ a: ReviewNote; b: ReviewNote; score: number }> = [];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const score = similarity(members[i]!, members[j]!);
        if (score >= SIMILARITY_THRESHOLD) pairs.push({ a: members[i]!, b: members[j]!, score });
      }
    }
    pairs.sort((left, right) => right.score - left.score);

    // Grow each cluster from its strongest pair, admitting a note only when it is
    // similar to every current member.
    const claimed = new Set<string>();
    for (const seed of pairs) {
      if (claimed.has(seed.a.relPath) || claimed.has(seed.b.relPath)) continue;
      const cluster = [seed.a, seed.b];
      for (const candidate of members) {
        if (claimed.has(candidate.relPath)) continue;
        if (cluster.some((member) => member.relPath === candidate.relPath)) continue;
        if (cluster.every((member) => similarity(member, candidate) >= SIMILARITY_THRESHOLD)) {
          cluster.push(candidate);
        }
      }
      for (const note of cluster) claimed.add(note.relPath);

      const scores: number[] = [];
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) scores.push(similarity(cluster[i]!, cluster[j]!));
      }
      const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
      const ranked = newestFirst(cluster);

      findings.push({
        kind: "duplicates",
        severity: 100 + cluster.length,
        paths: ranked.map((note) => note.relPath),
        suggestedKeep: ranked[0]!.relPath,
        summary: `${folder}: ${cluster.length} notes with overlapping tags (avg similarity ${average.toFixed(2)})`,
        detail: ranked
          .map((note) => `${note.relPath} — updated ${note.updated ?? "unknown"} — ${note.description || note.title}`)
          .join("\n"),
      });
    }
  }
  return findings;
}

export function findFragmentation(notes: readonly ReviewNote[]): Finding[] {
  const byFolder = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    byFolder.set(note.folder, [...(byFolder.get(note.folder) ?? []), note]);
  }

  const findings: Finding[] = [];
  for (const [folder, members] of byFolder) {
    if (members.length <= FOLDER_FILE_GUIDELINE) continue;
    findings.push({
      kind: "fragmentation",
      severity: 60 + members.length,
      paths: members.map((note) => note.relPath),
      summary: `${folder}: ${members.length} notes (guideline is ${FOLDER_FILE_GUIDELINE})`,
      detail:
        `A folder past ${FOLDER_FILE_GUIDELINE} notes has usually become a log rather than memory.\n` +
        "Consider consolidating into one living note per work stream and archiving finished experiments.",
    });
  }
  return findings;
}

function matchRule(notes: readonly ReviewNote[], pattern: RegExp, kind: FindingKind, severity: number, advice: string): Finding[] {
  return notes
    .filter((note) => pattern.test(note.description) || pattern.test(note.title))
    .map((note) => ({
      kind,
      severity: note.area === "core" ? severity + 20 : severity,
      paths: [note.relPath],
      summary: `${note.relPath} — ${note.description || note.title}`,
      detail: advice + (note.area === "core" ? "\nThis note sits in always-injected core, so the cost is paid every session." : ""),
    }));
}

export function findTimeboxed(notes: readonly ReviewNote[]): Finding[] {
  return matchRule(
    notes,
    TIMEBOXED_PATTERN,
    "timeboxed",
    80,
    "Mentions a deadline or fixed period, so it likely expired without anyone noticing.",
  );
}

export function findVolatile(notes: readonly ReviewNote[]): Finding[] {
  return matchRule(
    notes,
    VOLATILE_PATTERN,
    "volatile",
    50,
    "Contains facts that decay (prices, counts, point-in-time research). Re-verify before trusting.",
  );
}

export function findStale(notes: readonly ReviewNote[], now: number = Date.now()): Finding[] {
  const byFolder = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    byFolder.set(note.folder, [...(byFolder.get(note.folder) ?? []), note]);
  }

  const findings: Finding[] = [];
  for (const members of byFolder.values()) {
    const times = members.map((note) => parseDate(note.updated)).filter((time): time is number => time !== undefined);
    if (times.length === 0) continue;
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;

    for (const note of members) {
      const time = parseDate(note.updated);
      if (time === undefined) continue;
      const ageDays = (now - time) / DAY_MS;
      const lagDays = (median - time) / DAY_MS;
      if (ageDays < STALE_DAYS || lagDays < STALE_FOLDER_LAG_DAYS) continue;
      findings.push({
        kind: "stale",
        severity: 40,
        paths: [note.relPath],
        summary: `${note.relPath} — updated ${note.updated}, ${Math.round(ageDays)} days old`,
        detail: `Roughly ${Math.round(lagDays)} days behind the rest of its folder, which suggests abandoned work.`,
      });
    }
  }
  return findings;
}

export function findStubs(notes: readonly ReviewNote[]): Finding[] {
  return notes
    .filter((note) => note.bodyBytes < STUB_BYTES)
    .map((note) => ({
      kind: "stub" as const,
      severity: 30,
      paths: [note.relPath],
      summary: `${note.relPath} — ${note.bodyBytes} bytes of content`,
      detail: "Very short note; consider folding it into a related note.",
    }));
}

export interface ReviewOptions {
  now?: number;
  limit?: number;
}

export interface ReviewResult {
  findings: Finding[];
  noteCount: number;
  totalFindings: number;
}

export function reviewMemories(memoryDir: string, options: ReviewOptions = {}): ReviewResult {
  const notes = collectReviewNotes(memoryDir);
  const now = options.now ?? Date.now();

  const all = [
    ...findDuplicateClusters(notes),
    ...findTimeboxed(notes),
    ...findFragmentation(notes),
    ...findVolatile(notes),
    ...findStale(notes, now),
    ...findStubs(notes),
  ].sort((a, b) => b.severity - a.severity || a.paths[0]!.localeCompare(b.paths[0]!));

  const limit = options.limit ?? 20;
  return { findings: all.slice(0, limit), noteCount: notes.length, totalFindings: all.length };
}

const KIND_TITLES: Record<FindingKind, string> = {
  duplicates: "Duplicate clusters",
  fragmentation: "Over-fragmented folders",
  timeboxed: "Time-boxed content",
  volatile: "Volatile facts",
  stale: "Stale notes",
  stub: "Stubs",
};

export function formatReviewReport(result: ReviewResult): string {
  const excluded = [...REVIEW_EXCLUDED_AREAS].map((area) => `${area}/`).join(", ");
  if (result.findings.length === 0) {
    return `# Memory Review\n\nNo cleanup candidates across ${result.noteCount} notes. ${excluded} excluded (read-only).`;
  }

  const lines = [
    "# Memory Review",
    "",
    `${result.totalFindings} finding(s) across ${result.noteCount} notes` +
      (result.totalFindings > result.findings.length ? `, showing ${result.findings.length}` : "") +
      `. ${excluded} excluded (read-only).`,
    "",
  ];

  for (const kind of Object.keys(KIND_TITLES) as FindingKind[]) {
    const group = result.findings.filter((finding) => finding.kind === kind);
    if (group.length === 0) continue;
    lines.push(`## ${KIND_TITLES[kind]} (${group.length})`, "");
    for (const finding of group) {
      lines.push(`- **${finding.summary}**`);
      for (const line of finding.detail.split("\n")) lines.push(`  ${line}`);
      if (finding.suggestedKeep) lines.push(`  Newest, likely the keeper: \`${finding.suggestedKeep}\``);
      lines.push("");
    }
  }

  lines.push("_Nothing was modified._");
  return lines.join("\n");
}
