import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import matter from "gray-matter";
import type { GitResult, MemoryFile, MemoryFrontmatter, MemoryMdSettings, ParsedFrontmatter } from "./types.js";

export * from "./types.js";

/**
 * Constants
 */

const DEFAULT_LOCAL_PATH = path.join(os.homedir(), ".pi", "memory-md");
const TIMEOUT_MS = 10000;
const TIMEOUT_MESSAGE =
  "Unable to connect to GitHub repository, connection timeout (10s). Please check your network connection or try again later.";

/**
 * Settings
 */

let localPath = DEFAULT_LOCAL_PATH;

export function getLocalPath(): string {
  return localPath;
}

export function getCurrentDate(): string {
  return new Date().toISOString().split("T")[0];
}

function expandPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function getMemoryDir(settings: MemoryMdSettings, cwd: string): string {
  localPath = expandPath(settings.localPath || DEFAULT_LOCAL_PATH);
  return path.join(localPath);
}

function getRepoName(settings: MemoryMdSettings): string {
  if (!settings.repoUrl) return "memory-md";
  const match = settings.repoUrl.match(/\/([^/]+?)(\.git)?$/);
  return match ? match[1] : "memory-md";
}

export function loadSettings(): MemoryMdSettings {
  const DEFAULT_SETTINGS: MemoryMdSettings = {
    enabled: true,
    repoUrl: "",
    localPath: DEFAULT_LOCAL_PATH,
    autoSync: { onSessionStart: true },
    injection: "message-append",
    systemPrompt: {
      maxTokens: 10000,
      includeProjects: ["current"],
    }
  };

  const globalSettings = path.join(os.homedir(), ".pi", "agent", "settings.json");
  if (!fs.existsSync(globalSettings)) {
    return DEFAULT_SETTINGS;
  }

  try {
    const content = fs.readFileSync(globalSettings, "utf-8");
    const parsed = JSON.parse(content);
    const loadedSettings = { ...DEFAULT_SETTINGS, ...(parsed["pi-memory-md"] as MemoryMdSettings) };

    if (loadedSettings.localPath) {
      loadedSettings.localPath = expandPath(loadedSettings.localPath);
    }

    return loadedSettings;
  } catch (error) {
    console.warn("Failed to load memory settings:", error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Git operations
 */

export async function gitExec(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  timeoutMs = TIMEOUT_MS,
): Promise<GitResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await pi.exec("git", args, { cwd, signal: controller.signal });
    clearTimeout(timeoutId);
    return { stdout: result.stdout || "", success: true };
  } catch (error) {
    clearTimeout(timeoutId);
    const err = error as { name?: string; code?: string; message?: string };
    const isTimeout = err?.name === "AbortError" || err?.code === "ABORT_ERR";
    if (isTimeout) return { stdout: "", success: false, timeout: true };
    return { stdout: err?.message || String(error), success: false };
  }
}

export async function syncRepository(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
): Promise<{ success: boolean; message: string; updated?: boolean }> {
  const { localPath, repoUrl } = settings;

  if (!repoUrl || !localPath) {
    return { success: false, message: "GitHub repo URL or local path not configured" };
  }

  const repoName = getRepoName(settings);

  if (fs.existsSync(localPath)) {
    const gitDir = path.join(localPath, ".git");
    if (!fs.existsSync(gitDir)) {
      return { success: false, message: `Directory exists but is not a git repo: ${localPath}` };
    }

    const pullResult = await gitExec(pi, localPath, ["pull", "--rebase", "--autostash"]);
    if (pullResult.timeout) return { success: false, message: TIMEOUT_MESSAGE };
    if (!pullResult.success) return { success: false, message: pullResult.stdout || "Pull failed" };

    isRepoInitialized.value = true;
    const updated = pullResult.stdout.includes("Updating") || pullResult.stdout.includes("Fast-forward");

    return {
      success: true,
      message: updated ? `Pulled latest changes from [${repoName}]` : `[${repoName}] is already latest`,
      updated,
    };
  }

  fs.mkdirSync(localPath, { recursive: true });

  const memoryDirName = path.basename(localPath);
  const parentDir = path.dirname(localPath);
  const cloneResult = await gitExec(pi, parentDir, ["clone", repoUrl, memoryDirName]);

  if (cloneResult.timeout) return { success: false, message: TIMEOUT_MESSAGE };
  if (cloneResult.success) {
    isRepoInitialized.value = true;
    return { success: true, message: `Cloned [${repoName}] successfully`, updated: true };
  }

  return { success: false, message: cloneResult.stdout || "Clone failed" };
}

/**
 * Read-only areas
 *
 * `reference/` mirrors an externally managed vault (Obsidian). The agent may
 * search and read it, but must never write, edit, or delete inside it, and
 * cleanup tooling must never propose changes there. Generated indexes therefore
 * live outside these areas rather than carving out an exception.
 */

export const READONLY_AREAS: ReadonlySet<string> = new Set(["reference"]);

/** The top-level area a memory path belongs to, or "" for the root itself. */
export function memoryArea(memoryDir: string, fullPath: string): string {
  const rel = path.relative(path.resolve(memoryDir), path.resolve(fullPath));
  if (!rel || rel.startsWith("..")) return "";
  return rel.split(path.sep)[0] ?? "";
}

export function isReadOnlyMemoryPath(memoryDir: string, fullPath: string): boolean {
  return READONLY_AREAS.has(memoryArea(memoryDir, fullPath));
}

/** Returns an error message when the path may not be modified, else null. */
export function assertWritable(memoryDir: string, fullPath: string): string | null {
  const area = memoryArea(memoryDir, fullPath);
  if (!READONLY_AREAS.has(area)) return null;
  const rel = path.relative(path.resolve(memoryDir), path.resolve(fullPath));
  return `${area}/ is read-only and externally managed; refusing to modify ${rel}. Read and search it instead.`;
}

/**
 * File operations
 */

function validateFrontmatter(data: ParsedFrontmatter): { valid: boolean; error?: string } {
  if (!data) {
    return { valid: false, error: "No frontmatter found (requires --- delimiters)" };
  }

  const frontmatter = data as MemoryFrontmatter;

  if (frontmatter.description !== undefined && typeof frontmatter.description !== "string") {
    return { valid: false, error: "'description' must be a string if provided" };
  }

  if (frontmatter.limit !== undefined && (typeof frontmatter.limit !== "number" || frontmatter.limit <= 0)) {
    return { valid: false, error: "'limit' must be a positive number" };
  }

  if (frontmatter.tags !== undefined && !Array.isArray(frontmatter.tags)) {
    return { valid: false, error: "'tags' must be an array of strings" };
  }

  return { valid: true };
}

export function readMemoryFile(filePath: string): MemoryFile | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = matter(content);
    if (!parsed.data || Object.keys(parsed.data).length === 0 || !validateFrontmatter(parsed.data).valid) {
      return {
        path: filePath,
        frontmatter: { description: "No description" },
        content,
      };
    }

    return {
      path: filePath,
      frontmatter: parsed.data as MemoryFrontmatter,
      content: parsed.content,
    };
  } catch (error) {
    console.error(`Failed to read memory file ${filePath}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export function listMemoryFiles(memoryDir: string): string[] {
  const files: string[] = [];

  function walkDir(dir: string) {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  walkDir(memoryDir);
  return files;
}

export function writeMemoryFile(filePath: string, content: string, frontmatter: MemoryFrontmatter): void {
  const fileDir = path.dirname(filePath);
  fs.mkdirSync(fileDir, { recursive: true });
  const frontmatterStr = matter.stringify(content, frontmatter);
  fs.writeFileSync(filePath, frontmatterStr);
}

/**
 * Memory context
 */

function ensureDirectoryStructure(memoryDir: string): void {
  const dirs = [
    path.join(memoryDir, "core", "user"),
    path.join(memoryDir, "core", "project"),
    path.join(memoryDir, "reference"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createDefaultFiles(memoryDir: string): void {
  const identityFile = path.join(memoryDir, "core", "user", "identity.md");
  if (!fs.existsSync(identityFile)) {
    writeMemoryFile(identityFile, "# User Identity\n\nCustomize this file with your information.", {
      description: "User identity and background",
      tags: ["user", "identity"],
      created: getCurrentDate(),
    });
  }

  const preferFile = path.join(memoryDir, "core", "user", "prefer.md");
  if (!fs.existsSync(preferFile)) {
    writeMemoryFile(
      preferFile,
      "# User Preferences\n\n## Communication Style\n- Be concise\n- Show code examples\n\n## Code Style\n- 2 space indentation\n- Prefer const over var\n- Functional programming preferred",
      {
        description: "User habits and code style preferences",
        tags: ["user", "preferences"],
        created: getCurrentDate(),
      },
    );
  }
}

export { createDefaultFiles, ensureDirectoryStructure };

const DEFAULT_MAX_TOKENS = 10000;
const CHARS_PER_TOKEN = 4;

/** Collapse a description onto a single line so every entry costs one row. */
function singleLine(text: string, maxChars = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

/** Count .md files per top-level directory outside of core/. */
function summarizeExternalAreas(memoryDir: string): string[] {
  if (!fs.existsSync(memoryDir)) return [];

  return fs
    .readdirSync(memoryDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "core" && !entry.name.startsWith("."))
    .map((entry) => {
      const count = listMemoryFiles(path.join(memoryDir, entry.name)).length;
      return `- ${entry.name}/ (${count} files)`;
    })
    .filter((line) => !line.endsWith("(0 files)"));
}

/**
 * Build the always-injected core context.
 *
 * This is an *index* only: path, description and tags per core file. Bodies stay
 * on disk and are pulled in on demand with memory_read, so core can grow without
 * the per-session cost growing with it.
 */
export function buildMemoryContext(settings: MemoryMdSettings, cwd: string): string {
  return buildMemoryContextParts(settings, cwd).context;
}

function buildMemoryContextParts(settings: MemoryMdSettings, cwd: string): {
  context: string;
  memoryDir: string;
  coreFileCount: number;
  injectedCoreEntries: number;
  omittedCoreEntries: number;
  externalAreas: string[];
  budgetTokens: number;
  estimatedTokens: number;
} {
  const memoryDir = getMemoryDir(settings, cwd);
  const coreDir = path.join(memoryDir, "core");
  const budgetTokens = settings.systemPrompt?.maxTokens ?? DEFAULT_MAX_TOKENS;

  if (!fs.existsSync(coreDir)) {
    return {
      context: "",
      memoryDir,
      coreFileCount: 0,
      injectedCoreEntries: 0,
      omittedCoreEntries: 0,
      externalAreas: [],
      budgetTokens,
      estimatedTokens: 0,
    };
  }

  const files = listMemoryFiles(coreDir);
  if (files.length === 0) {
    return {
      context: "",
      memoryDir,
      coreFileCount: 0,
      injectedCoreEntries: 0,
      omittedCoreEntries: 0,
      externalAreas: [],
      budgetTokens,
      estimatedTokens: 0,
    };
  }

  const budget = budgetTokens * CHARS_PER_TOKEN;
  const header: string[] = [
    "# Project Memory",
    "",
    "Core memory index. Read a file with memory_read before relying on its details.",
    "",
  ];

  const entries: string[] = [];
  let used = header.join("\n").length;
  let omitted = 0;

  for (const filePath of files) {
    const memory = readMemoryFile(filePath);
    if (!memory) continue;

    const relPath = path.relative(memoryDir, filePath);
    const { description, tags } = memory.frontmatter;
    const tagStr = tags?.length ? ` [${tags.join(", ")}]` : "";
    const entry = `- ${relPath} — ${singleLine(description || "No description")}${tagStr}`;

    if (used + entry.length + 1 > budget) {
      omitted++;
      continue;
    }

    entries.push(entry);
    used += entry.length + 1;
  }

  const lines = [...header, ...entries];

  if (omitted > 0) {
    lines.push(`- … ${omitted} further core file(s) omitted for space; use memory_list to see them.`);
  }

  const external = summarizeExternalAreas(memoryDir);
  if (external.length > 0) {
    lines.push("", "External memory (not loaded; find it with memory_search, then memory_read):", "", ...external);
  }

  const context = lines.join("\n");
  return {
    context,
    memoryDir,
    coreFileCount: files.length,
    injectedCoreEntries: entries.length,
    omittedCoreEntries: omitted,
    externalAreas: external,
    budgetTokens,
    estimatedTokens: Math.ceil(context.length / CHARS_PER_TOKEN),
  };
}

export function buildMemoryContextPreview(
  settings: MemoryMdSettings,
  cwd: string,
  mode: "summary" | "exact" = "summary",
): string {
  const parts = buildMemoryContextParts(settings, cwd);
  if (!parts.context) {
    return `# Memory Context Preview\n\nMemory context is empty.\n\nPath: \`${parts.memoryDir}\``;
  }

  if (mode === "exact") {
    return [
      "# Memory Context Preview",
      "",
      `Path: \`${parts.memoryDir}\``,
      `Estimated size: **${parts.estimatedTokens} tokens** / budget **${parts.budgetTokens} tokens**`,
      "",
      "## Exact injected context",
      "",
      parts.context,
    ].join("\n");
  }

  return [
    "# Memory Context Preview",
    "",
    `Path: \`${parts.memoryDir}\``,
    `Estimated size: **${parts.estimatedTokens} tokens** / budget **${parts.budgetTokens} tokens**`,
    "",
    "## Injected core index",
    "",
    `- Core markdown files: **${parts.coreFileCount}**`,
    `- Injected index entries: **${parts.injectedCoreEntries}**`,
    `- Omitted by budget: **${parts.omittedCoreEntries}**`,
    "- Full file bodies are **not** injected; use `memory_read` for details.",
    "",
    "## External memory shown in context",
    "",
    ...(parts.externalAreas.length > 0 ? parts.externalAreas : ["- none"]),
    "",
    "## Exact context",
    "",
    "Use `memory_context({ mode: \"exact\" })` or `/memory-context exact` to view the exact injected text.",
  ].join("\n");
}
