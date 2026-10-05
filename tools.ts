import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  assertWritable,
  buildMemoryContextPreview,
  createDefaultFiles,
  ensureDirectoryStructure,
  getCurrentDate,
  getMemoryDir,
  gitExec,
  listMemoryFiles,
  readMemoryFile,
  syncRepository,
  writeMemoryFile,
} from "./memoryMdCore.js";
import {
  ARCHIVE_AREA,
  dismissReviewCandidate,
  formatReviewReport,
  type FindingKind,
  reviewMemories,
} from "./memoryReview.js";
import type { MemoryFrontmatter, MemoryMdSettings } from "./types.js";

// Re-export types for convenience
export type { ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
export type { MemoryFrontmatter, MemoryMdSettings } from "./types.js";

// ============================================================================
// Render Utilities - Inline for simplicity
// ============================================================================

function renderText(text: string): Text {
  return new Text(text, 0, 0);
}

function resolvePathWithin(baseDir: string, relPath: string): string | null {
  const normalizedBaseDir = path.resolve(baseDir);
  const resolvedPath = path.resolve(normalizedBaseDir, relPath);

  if (resolvedPath === normalizedBaseDir || resolvedPath.startsWith(`${normalizedBaseDir}${path.sep}`)) {
    return resolvedPath;
  }

  return null;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value.includes(" ") ? `"${value}"` : value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (typeof value === "object" && value !== null) return "{...}";
  return String(value);
}

function oneLine(text: string, maxLength = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

function firstMarkdownHeading(content: string): string | undefined {
  return content
    .split("\n")
    .map((line) => line.match(/^#{1,3}\s+(.+)$/)?.[1]?.trim())
    .find(Boolean);
}

function generateProjectsIndex(memoryDir: string): { path: string; count: number; groups: number } {
  const projectsDir = path.join(memoryDir, "projects");
  const indexPath = path.join(projectsDir, "INDEX.md");
  fs.mkdirSync(projectsDir, { recursive: true });

  const files = listMemoryFiles(projectsDir)
    .filter((filePath) => path.basename(filePath).toLocaleLowerCase() !== "index.md")
    .sort((a, b) => path.relative(projectsDir, a).localeCompare(path.relative(projectsDir, b)));

  const groups = new Map<string, string[]>();
  for (const filePath of files) {
    const relToProjects = path.relative(projectsDir, filePath);
    const group = relToProjects.includes(path.sep) ? relToProjects.split(path.sep)[0] : "root";
    const memory = readMemoryFile(filePath);
    const relPath = path.relative(memoryDir, filePath);
    const description = memory?.frontmatter.description || firstMarkdownHeading(memory?.content ?? "") || "No description";
    const tags = memory?.frontmatter.tags?.length ? ` — tags: ${memory.frontmatter.tags.join(", ")}` : "";
    const updated = memory?.frontmatter.updated ? ` — updated: ${memory.frontmatter.updated}` : "";
    const entry = `- \`${relPath}\` — ${oneLine(description)}${tags}${updated}`;

    const existing = groups.get(group) ?? [];
    existing.push(entry);
    groups.set(group, existing);
  }

  const lines = [
    "# Projects Memory Index",
    "",
    "Generated from markdown frontmatter and paths. Do not edit manually.",
    "Use memory_read with a listed path to view the full note.",
    "",
  ];

  for (const [group, entries] of Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${group}`, "", ...entries, "");
  }

  writeMemoryFile(indexPath, lines.join("\n").trimEnd() + "\n", {
    description: "Generated index of project memory files",
    tags: ["index", "projects", "generated"],
    created: fs.existsSync(indexPath) ? readMemoryFile(indexPath)?.frontmatter.created || getCurrentDate() : getCurrentDate(),
    updated: getCurrentDate(),
    generated: true,
    generator: "pi-memory-md",
  });

  return { path: indexPath, count: files.length, groups: groups.size };
}

function buildToolCallText(name: string, args: Record<string, unknown>, theme: Theme): string {
  const text = theme.fg("toolTitle", theme.bold(name));
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return text;
  const [_key, value] = entries[0];
  return `${text} ${theme.fg("accent", formatValue(value))}`;
}

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

function buildExpandHint(totalLines: number, theme: Theme): string {
  const remaining = totalLines - 1;
  if (remaining <= 0) return "";
  return (
    "\n" +
    theme.fg("muted", `... (${remaining} more lines,`) +
    " " +
    keyHint("app.tools.expand", "to expand") +
    theme.fg("muted", ")")
  );
}

function renderCollapsed(summary: string, fullText: string, options: { expanded: boolean }, theme: Theme): Text {
  if (options.expanded) return renderText(theme.fg("toolOutput", fullText));
  return renderText(theme.fg("success", summary) + buildExpandHint(fullText.split("\n").length, theme));
}

function renderMemoryResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  defaults?: { description?: string; tags?: string[] },
): Text {
  if (options.isPartial) return renderText(theme.fg("warning", "Reading..."));
  const details = result.details as
    | { error?: boolean; frontmatter?: { description?: string; tags?: string[] } }
    | undefined;
  if (details?.error) return renderText(theme.fg("error", getResultText(result) || "Error"));

  const description = defaults?.description || details?.frontmatter?.description || "Memory file";
  const tags = defaults?.tags || details?.frontmatter?.tags || [];
  const text = getResultText(result);

  if (!options.expanded) {
    const summary = `${theme.fg("success", description)}\n${theme.fg("muted", `Tags: ${tags.join(", ") || "none"}`)}`;
    return renderText(summary + buildExpandHint(text.split("\n").length + 2, theme));
  }

  return renderText(
    theme.fg("success", description) +
      `\n${theme.fg("muted", `Tags: ${tags.join(", ") || "none"}`)}\n${theme.fg("toolOutput", text)}`,
  );
}

function renderSyncResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Text {
  if (options.isPartial) return renderText(theme.fg("warning", "Syncing..."));
  const details = result.details as { success?: boolean; initialized?: boolean; timeout?: boolean } | undefined;
  if (details?.initialized === false) return renderText(theme.fg("muted", "Not initialized"));
  if (details?.timeout) return renderText(theme.fg("error", getResultText(result)));

  const text = getResultText(result);
  if (!options.expanded) {
    const lines = text.split("\n");

    if (details?.success === false) {
      return renderText(theme.fg("error", lines[0] || "Operation failed") + buildExpandHint(lines.length, theme));
    }

    const summary = details?.success
      ? theme.fg("success", lines[0] || "Success")
      : theme.fg("success", lines[0] || "Status");
    return renderText(summary + buildExpandHint(lines.length, theme));
  }

  return renderText(theme.fg("toolOutput", text));
}

function renderCountResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  label: string,
): Text {
  if (options.isPartial) return renderText(theme.fg("warning", "Loading..."));
  const details = result.details as { count?: number } | undefined;
  const text = getResultText(result);
  if (!options.expanded)
    return renderText(
      theme.fg("success", `${details?.count ?? 0} ${label}`) + buildExpandHint(text.split("\n").length, theme),
    );
  return renderText(theme.fg("toolOutput", text));
}

export function registerMemorySync(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
): void {
  pi.registerTool({
    name: "memory_sync",
    label: "Memory Sync",
    description: "Synchronize memory repository with git (pull/push/status)",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("pull"), Type.Literal("push"), Type.Literal("status")], {
        description: "Action to perform",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { action } = params as { action: "pull" | "push" | "status" };
      const localPath = settings.localPath!;
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      if (action === "status") {
        const initialized = fs.existsSync(memoryDir) && fs.existsSync(path.join(localPath, ".git"));
        if (!initialized) {
          return {
            content: [{ type: "text", text: "Memory repository not initialized. Use memory_init to set up." }],
            details: { initialized: false },
          };
        }
        const result = await gitExec(pi, localPath, ["status", "--porcelain"]);
        if (!result.success) {
          return {
            content: [{ type: "text", text: `Git status failed: ${result.stdout || "Unknown error"}` }],
            details: { success: false, error: result.stdout },
          };
        }
        const dirty = result.stdout.trim().length > 0;
        return {
          content: [{ type: "text", text: dirty ? `Changes detected:\n${result.stdout}` : "No uncommitted changes" }],
          details: { initialized: true, dirty },
        };
      }

      if (action === "pull") {
        const result = await syncRepository(pi, settings, isRepoInitialized);
        return {
          content: [{ type: "text", text: result.message }],
          details: { success: result.success },
        };
      }

      if (action === "push") {
        if (fs.existsSync(path.join(memoryDir, "projects"))) {
          generateProjectsIndex(memoryDir);
        }

        const statusResult = await gitExec(pi, localPath, ["status", "--porcelain"]);
        const hasChanges = statusResult.stdout.trim().length > 0;

        if (hasChanges) {
          await gitExec(pi, localPath, ["add", "."]);
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const commitResult = await gitExec(pi, localPath, ["commit", "-m", `Update memory - ${timestamp}`]);
          if (!commitResult.success) {
            return {
              content: [{ type: "text", text: commitResult.stdout || "Commit failed" }],
              details: { success: false },
            };
          }
        }

        const result = await gitExec(pi, localPath, ["push"]);
        if (result.timeout) {
          return {
            content: [
              {
                type: "text",
                text: "Unable to connect to GitHub repository, connection timeout (10s). Please check your network connection or try again later.",
              },
            ],
            details: { success: false, timeout: true },
          };
        }

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: hasChanges
                  ? "Committed and pushed changes to repository"
                  : "No changes to commit, repository up to date",
              },
            ],
            details: { success: true, committed: hasChanges },
          };
        }
        return {
          content: [{ type: "text", text: result.stdout || "Push failed" }],
          details: { success: false },
        };
      }

      return {
        content: [{ type: "text", text: "Unknown action" }],
        details: {},
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_sync", args, theme), 0, 0),
    renderResult: (result, options, theme) => renderSyncResult(result, options, theme),
  });
}

// ============================================================================
// Agent-driven review
// ============================================================================

/** Build the same read-only report used by the model-callable scanner. */
export async function runMemoryReviewReport(
  settings: MemoryMdSettings,
  ctx: ExtensionContext,
  options: { limit?: number } = {},
): Promise<string> {
  const memoryDir = getMemoryDir(settings, ctx.cwd);
  return formatReviewReport(reviewMemories(memoryDir, options.limit === undefined ? {} : { limit: options.limit }));
}

export function registerMemoryReview(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_review",
    label: "Memory Review",
    description:
      "Read-only scan for memory cleanup candidates. Returns evidence for the agent to inspect semantically before using memory_cleanup. Never reads reference/ or mutates files.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Maximum candidates to return (default 20)" })),
      area: Type.Optional(Type.String({ description: "Restrict to a top-level area such as projects or system" })),
      folder: Type.Optional(Type.String({ description: "Restrict to a folder such as projects/blueflow" })),
      kind: Type.Optional(Type.Union([
        Type.Literal("related"), Type.Literal("fragmentation"), Type.Literal("timeboxed"),
        Type.Literal("volatile"), Type.Literal("stale"), Type.Literal("stub"),
      ])),
      includeDismissed: Type.Optional(Type.Boolean({ description: "Include previously dismissed unchanged candidates" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { limit, area, folder, kind, includeDismissed } = params as {
        limit?: number; area?: string; folder?: string; kind?: FindingKind; includeDismissed?: boolean;
      };
      const memoryDir = getMemoryDir(settings, ctx.cwd);

      if (!fs.existsSync(memoryDir)) {
        return {
          content: [{ type: "text", text: `Memory directory not found: ${memoryDir}` }],
          details: { error: true },
        };
      }

      const result = reviewMemories(memoryDir, { limit, area, folder, kind, includeDismissed });
      const structuredContent = {
        noteCount: result.noteCount,
        totalFindings: result.totalFindings,
        findings: result.findings.map(({ id, fingerprint, dismissed, kind, severity, paths, summary, detail, evidence }) =>
          ({ id, fingerprint, dismissed, kind, severity, paths, summary, detail, evidence })),
      };
      return {
        content: [{ type: "text", text: `${formatReviewReport(result)}\n\n## Structured candidates\n\n\`\`\`json\n${JSON.stringify(structuredContent, null, 2)}\n\`\`\`` }],
        details: { ...structuredContent, readOnly: true },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_review", args, theme), 0, 0),
    renderResult: (result, options, theme) =>
      renderCollapsed("Memory review", getResultText(result), options, theme),
  });
}

export function registerMemoryCleanup(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_cleanup",
    label: "Memory Cleanup",
    description: "Apply an explicit reviewed cleanup operation. Supports reversible archives, information-preserving merges, updates, deletion, and dismissals. System changes, collisions, and deletion require approval; reference/ is always prohibited.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("archive"), Type.Literal("merge"), Type.Literal("update"),
        Type.Literal("delete"), Type.Literal("dismiss"),
      ]),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Source or target relative note paths" })),
      targetPath: Type.Optional(Type.String({ description: "Destination path for merge or update" })),
      content: Type.Optional(Type.String({ description: "Complete Markdown body for merge or update" })),
      description: Type.Optional(Type.String({ description: "Description for merge or update frontmatter" })),
      tags: Type.Optional(Type.Array(Type.String())),
      candidateId: Type.Optional(Type.String({ description: "Candidate ID to dismiss" })),
      fingerprint: Type.Optional(Type.String({ description: "Candidate fingerprint to dismiss" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as {
        action: "archive" | "merge" | "update" | "delete" | "dismiss";
        paths?: string[]; targetPath?: string; content?: string; description?: string; tags?: string[];
        candidateId?: string; fingerprint?: string;
      };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const result = (success: boolean, changedPaths: string[], message: string) => ({
        content: [{ type: "text" as const, text: message }],
        details: { success, action: input.action, changedPaths, message },
        ...(success ? {} : { isError: true }),
      });

      const confirm = async (title: string, message: string): Promise<boolean> => {
        if (!ctx.hasUI) return false;
        return ctx.ui.confirm(title, message);
      };
      const validateMarkdownPath = (relPath: string, mustExist: boolean): string | null => {
        const fullPath = resolvePathWithin(memoryDir, relPath);
        if (!fullPath) return `Path escapes memory directory: ${relPath}`;
        const guard = assertWritable(memoryDir, fullPath);
        if (guard) return guard;
        if (!fullPath.endsWith(".md")) return `Only Markdown files may be changed: ${relPath}`;
        if (mustExist && (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile())) return `Memory file not found: ${relPath}`;
        return null;
      };
      const notePath = input.targetPath ?? input.paths?.[0];

      if (input.action === "dismiss") {
        if (!input.candidateId || !input.fingerprint) return result(false, [], "candidateId and fingerprint are required");
        const candidate = reviewMemories(memoryDir, { includeDismissed: true, limit: Number.MAX_SAFE_INTEGER }).findings
          .find((item) => item.id === input.candidateId && item.fingerprint === input.fingerprint);
        if (!candidate) return result(false, [], "Candidate is missing or changed; run memory_review again");
        dismissReviewCandidate(memoryDir, input.candidateId, input.fingerprint);
        return result(true, [], `Dismissed ${input.candidateId} until its notes change`);
      }

      if (input.action === "update") {
        if (!notePath || input.content === undefined) return result(false, [], "update requires targetPath and content");
        const guard = validateMarkdownPath(notePath, true);
        if (guard) return result(false, [], guard);
        const current = readMemoryFile(path.join(memoryDir, notePath));
        const systemChange = notePath.split(/[\\/]/)[0] === "system";
        if (systemChange || current?.content !== input.content) {
          const approved = await confirm("Approve memory update", `Overwrite ${notePath}?`);
          if (!approved) return result(false, [], "Memory update was not approved");
        }
        const frontmatter = {
          ...current?.frontmatter,
          description: input.description ?? current?.frontmatter.description ?? "Updated memory",
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          created: current?.frontmatter.created ?? getCurrentDate(),
          updated: getCurrentDate(),
        };
        writeMemoryFile(path.join(memoryDir, notePath), input.content, frontmatter);
        if (notePath.startsWith("projects/") && path.basename(notePath).toLocaleLowerCase() !== "index.md") generateProjectsIndex(memoryDir);
        return result(true, [notePath], `Updated ${notePath}`);
      }

      if (input.action === "delete") {
        const paths = [...new Set(input.paths ?? (notePath ? [notePath] : []))];
        if (paths.length === 0) return result(false, [], "delete requires paths");
        for (const relPath of paths) {
          const guard = validateMarkdownPath(relPath, true);
          if (guard) return result(false, [], guard);
        }
        const approved = await confirm("Permanently delete memory?", paths.join("\\n"));
        if (!approved) return result(false, [], "Deletion requires explicit approval");
        const backups = paths.map((relPath) => ({ relPath, content: fs.readFileSync(path.join(memoryDir, relPath)) }));
        try {
          for (const item of backups) fs.unlinkSync(path.join(memoryDir, item.relPath));
        } catch (error) {
          for (const item of backups) if (!fs.existsSync(path.join(memoryDir, item.relPath))) fs.writeFileSync(path.join(memoryDir, item.relPath), item.content);
          return result(false, [], `Delete failed without partial changes: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (paths.some((relPath) => relPath.startsWith("projects/"))) generateProjectsIndex(memoryDir);
        return result(true, paths, `Deleted ${paths.length} note(s)`);
      }

      if (input.action === "merge") {
        const paths = [...new Set(input.paths ?? [])];
        if (paths.length < 2 || !notePath || input.content === undefined || input.description === undefined) {
          return result(false, [], "merge requires at least two source paths, targetPath, content, and description");
        }
        for (const relPath of paths) {
          const guard = validateMarkdownPath(relPath, true);
          if (guard) return result(false, [], guard);
        }
        if (paths.includes(notePath)) return result(false, [], "merge target must be a new path; source notes are archived for recovery");
        const targetGuard = validateMarkdownPath(notePath, false);
        if (targetGuard) return result(false, [], targetGuard);
        if (fs.existsSync(path.join(memoryDir, notePath))) return result(false, [], `Merge target already exists: ${notePath}`);
        const dangerous = paths.length > 5 || paths.some((relPath) => relPath.split(/[\\/]/)[0] === "system") || notePath.split(/[\\/]/)[0] === "system";
        if (dangerous && !(await confirm("Approve dangerous memory merge", `Merge and archive ${paths.length} notes?\n${paths.join("\\n")}`))) {
          return result(false, [], "Merge was not approved");
        }
        const targetFull = path.join(memoryDir, notePath);
        const moved: Array<{ from: string; to: string }> = [];
        try {
          writeMemoryFile(targetFull, input.content, { description: input.description, tags: input.tags ?? [], created: getCurrentDate(), updated: getCurrentDate() });
          for (const relPath of paths) {
            const from = path.join(memoryDir, relPath);
            const to = path.join(memoryDir, ARCHIVE_AREA, relPath);
            if (fs.existsSync(to)) throw new Error(`Archive destination already exists: ${path.relative(memoryDir, to)}`);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.renameSync(from, to);
            moved.push({ from, to });
          }
        } catch (error) {
          for (const move of moved.reverse()) fs.renameSync(move.to, move.from);
          if (fs.existsSync(targetFull)) fs.unlinkSync(targetFull);
          return result(false, [], `Merge failed without partial changes: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (paths.some((relPath) => relPath.startsWith("projects/")) || notePath.startsWith("projects/")) generateProjectsIndex(memoryDir);
        return result(true, [notePath, ...paths.flatMap((relPath) => [relPath, path.join(ARCHIVE_AREA, relPath)])], `Merged ${paths.length} notes into ${notePath}; sources archived`);
      }

      const paths = [...new Set(input.paths ?? [])];
      if (paths.length === 0) return result(false, [], "At least one path is required");

      const destinations: string[] = [];
      for (const relPath of paths) {
        const fullPath = resolvePathWithin(memoryDir, relPath);
        if (!fullPath) return result(false, [], `Path escapes memory directory: ${relPath}`);
        const guard = assertWritable(memoryDir, fullPath);
        if (guard) return result(false, [], guard);
        if (relPath.split(/[\\/]/)[0] === ARCHIVE_AREA) return result(false, [], `${relPath} is already archived`);
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile() || !fullPath.endsWith(".md")) {
          return result(false, [], `Memory markdown file not found: ${relPath}`);
        }
        const destination = path.join(memoryDir, ARCHIVE_AREA, relPath);
        if (fs.existsSync(destination)) return result(false, [], `Archive destination already exists: ${path.relative(memoryDir, destination)}`);
        destinations.push(destination);
      }

      const dangerous = paths.length > 5 || paths.some((relPath) => relPath.split(/[\\/]/)[0] === "system");
      if (dangerous) {
        if (!ctx.hasUI) return result(false, [], "Approval required for system or bulk archive, but no interactive UI is available");
        const approved = await ctx.ui.confirm("Approve dangerous memory cleanup", `Archive ${paths.length} note(s)?\n${paths.join("\n")}`);
        if (!approved) return result(false, [], "Cleanup was not approved");
      }

      const moved: Array<{ from: string; to: string }> = [];
      try {
        paths.forEach((relPath, index) => {
          const from = path.join(memoryDir, relPath);
          const to = destinations[index]!;
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.renameSync(from, to);
          moved.push({ from, to });
        });
      } catch (error) {
        for (const move of moved.reverse()) fs.renameSync(move.to, move.from);
        return result(false, [], `Archive failed without partial changes: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (paths.some((relPath) => relPath.split(/[\\/]/)[0] === "projects")) generateProjectsIndex(memoryDir);
      const changedPaths = paths.flatMap((relPath) => [relPath, path.join(ARCHIVE_AREA, relPath)]);
      return result(true, changedPaths, `Archived ${paths.length} note(s)`);
    },
  });
}

export function registerMemoryContext(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_context",
    label: "Memory Context",
    description: "Preview what memory index/context is currently injected for the agent",
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union([Type.Literal("summary"), Type.Literal("exact")], {
          description: "summary shows counts and areas; exact shows the exact injected memory text",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { mode = "summary" } = params as { mode?: "summary" | "exact" };
      const text = buildMemoryContextPreview(settings, ctx.cwd, mode);
      return {
        content: [{ type: "text", text }],
        details: { mode },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_context", args, theme), 0, 0),
    renderResult: (result, options, theme) => renderCollapsed("Memory context preview", getResultText(result), options, theme),
  });
}

export function registerMemoryRead(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: "Read a memory file by path",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to memory file (e.g., 'long-term/user/identity.md')" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path: relPath } = params as { path: string };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const fullPath = resolvePathWithin(memoryDir, relPath);

      if (!fullPath) {
        return {
          content: [{ type: "text", text: `Invalid memory path: ${relPath}` }],
          details: { error: true },
        };
      }

      const memory = readMemoryFile(fullPath);
      if (!memory) {
        return {
          content: [{ type: "text", text: `Failed to read memory file: ${relPath}` }],
          details: { error: true },
        };
      }

      const { description = "No description", tags = [] } = memory.frontmatter;
      return {
        content: [
          { type: "text", text: `# ${description}\n\nTags: ${tags.join(", ") || "none"}\n\n${memory.content}` },
        ],
        details: { frontmatter: memory.frontmatter },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_read", args, theme), 0, 0),
    renderResult: (result, options, theme) => renderMemoryResult(result, options, theme),
  });
}

export function registerMemoryWrite(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description: "Create, update, or append to a memory file with YAML frontmatter",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to memory file (e.g., 'long-term/user/identity.md')" }),
      content: Type.String({ description: "Markdown content" }),
      description: Type.String({ description: "Description for frontmatter" }),
      tags: Type.Optional(Type.Array(Type.String())),
      mode: Type.Optional(
        Type.Union([Type.Literal("overwrite"), Type.Literal("append")], {
          description: "Write mode. Defaults to overwrite; use append to add to an existing memory file.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const {
        path: relPath,
        content,
        description,
        tags,
        mode = "overwrite",
      } = params as { path: string; content: string; description: string; tags?: string[]; mode?: "overwrite" | "append" };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const fullPath = resolvePathWithin(memoryDir, relPath);

      if (!fullPath) {
        return {
          content: [{ type: "text", text: `Invalid memory path: ${relPath}` }],
          details: { error: true },
        };
      }

      const readOnly = assertWritable(memoryDir, fullPath);
      if (readOnly) {
        return {
          content: [{ type: "text", text: readOnly }],
          details: { error: true, readOnly: true },
        };
      }

      const existing = readMemoryFile(fullPath);
      if (relPath.split(/[\\/]/)[0] === "system") {
        if (!ctx.hasUI) {
          return { content: [{ type: "text", text: "Approval required to modify system memory" }], details: { error: true, approvalRequired: true } };
        }
        const approved = await ctx.ui.confirm("Approve system memory change", `${mode} ${relPath}?`);
        if (!approved) return { content: [{ type: "text", text: "System memory change was not approved" }], details: { error: true, approvalRequired: true } };
      }

      const frontmatter: MemoryFrontmatter = {
        ...existing?.frontmatter,
        description,
        created: existing?.frontmatter.created || getCurrentDate(),
        updated: getCurrentDate(),
        ...(tags && { tags }),
      };

      const nextContent = mode === "append" && existing ? `${existing.content.trimEnd()}\n\n${content.trimStart()}` : content;
      writeMemoryFile(fullPath, nextContent, frontmatter);
      const indexResult = relPath.startsWith("projects/") && path.basename(relPath).toLocaleLowerCase() !== "index.md"
        ? generateProjectsIndex(memoryDir)
        : undefined;
      return {
        content: [
          {
            type: "text",
            text: `Memory file ${mode === "append" ? "appended" : "written"}: ${relPath}${indexResult ? `\nUpdated projects index: ${path.relative(memoryDir, indexResult.path)}` : ""}`,
          },
        ],
        details: { path: fullPath, frontmatter, index: indexResult },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_write", args, theme), 0, 0),
    renderResult: (result, options, theme) => {
      const details = result.details as { frontmatter?: { description?: string; tags?: string[] } };
      return renderMemoryResult(result, options, theme, {
        description: details?.frontmatter?.description,
        tags: details?.frontmatter?.tags,
      });
    },
  });
}

export function registerMemoryDelete(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_delete",
    label: "Memory Delete",
    description: "Permanently delete a memory file by path. Always requires user approval.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path to memory file to delete" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path: relPath } = params as { path: string };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const fullPath = resolvePathWithin(memoryDir, relPath);

      if (!fullPath) {
        return {
          content: [{ type: "text", text: `Invalid memory path: ${relPath}` }],
          details: { error: true },
        };
      }

      const readOnly = assertWritable(memoryDir, fullPath);
      if (readOnly) {
        return {
          content: [{ type: "text", text: readOnly }],
          details: { error: true, readOnly: true },
        };
      }

      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        return {
          content: [{ type: "text", text: `Memory file not found: ${relPath}` }],
          details: { error: true },
        };
      }

      if (!fullPath.endsWith(".md")) {
        return {
          content: [{ type: "text", text: `Refusing to delete non-markdown file: ${relPath}` }],
          details: { error: true },
        };
      }

      if (!ctx.hasUI) {
        return { content: [{ type: "text", text: "Approval required to permanently delete memory" }], details: { error: true, approvalRequired: true } };
      }
      const approved = await ctx.ui.confirm("Permanently delete memory?", relPath);
      if (!approved) return { content: [{ type: "text", text: "Memory deletion was not approved" }], details: { error: true, approvalRequired: true } };

      fs.unlinkSync(fullPath);
      const indexResult = relPath.startsWith("projects/") && path.basename(relPath).toLocaleLowerCase() !== "index.md"
        ? generateProjectsIndex(memoryDir)
        : undefined;
      return {
        content: [
          {
            type: "text",
            text: `Memory file deleted: ${relPath}${indexResult ? `\nUpdated projects index: ${path.relative(memoryDir, indexResult.path)}` : ""}`,
          },
        ],
        details: { path: fullPath, index: indexResult },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_delete", args, theme), 0, 0),
    renderResult: (result, options, theme) => {
      if (options.isPartial) return renderText(theme.fg("warning", "Deleting..."));
      const details = result.details as { error?: boolean } | undefined;
      const text = getResultText(result);
      return renderText(theme.fg(details?.error ? "error" : "success", text));
    },
  });
}

export function registerMemoryList(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description: "List all memory files in the repository",
    parameters: Type.Object({
      directory: Type.Optional(Type.String({ description: "Filter by directory (e.g., 'long-term/user')" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { directory } = params as { directory?: string };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const listDir = directory ? resolvePathWithin(memoryDir, directory) : memoryDir;

      if (!listDir) {
        return {
          content: [{ type: "text", text: `Invalid memory directory: ${directory}` }],
          details: { files: [], count: 0, error: true },
        };
      }

      const files = listMemoryFiles(listDir);
      const relPaths = files.map((f) => path.relative(memoryDir, f));
      return {
        content: [
          { type: "text", text: `Memory files (${relPaths.length}):\n\n${relPaths.map((p) => `  - ${p}`).join("\n")}` },
        ],
        details: { files: relPaths, count: relPaths.length },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_list", args, theme), 0, 0),
    renderResult: (result, options, theme) => renderCountResult(result, options, theme, "memory files"),
  });
}

function normalizeSearchText(text: string): string {
  return text.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function getSearchTerms(query: string): string[] {
  return Array.from(
    new Set(
      normalizeSearchText(query)
        .split(/[^\p{L}\p{N}_+-]+/u)
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  );
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = text.indexOf(term);
  while (index !== -1) {
    count++;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function buildSnippet(content: string, terms: string[]): string {
  const normalizedContent = normalizeSearchText(content);
  let bestIndex = -1;
  for (const term of terms) {
    const index = normalizedContent.indexOf(term);
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) bestIndex = index;
  }

  if (bestIndex === -1) return content.replace(/\s+/g, " ").trim().slice(0, 180);

  const start = Math.max(0, bestIndex - 70);
  const end = Math.min(content.length, bestIndex + 170);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

export function registerMemorySearch(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Ranked search over memory file paths, tags, descriptions, and content",
    parameters: Type.Object({
      grep: Type.String({ description: "Search query; multiple words are ranked across path, tags, description, and content" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { grep } = params as { grep?: string };
      const query = grep?.trim() ?? "";
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const terms = getSearchTerms(query);

      if (!query || terms.length === 0) {
        return {
          content: [{ type: "text", text: "Provide grep to search memory files." }],
          details: { files: [], count: 0 },
        };
      }

      const scored = listMemoryFiles(memoryDir)
        .map((filePath) => {
          const memory = readMemoryFile(filePath);
          if (!memory) return null;

          const relPath = path.relative(memoryDir, filePath);
          const tagText = memory.frontmatter.tags?.join(" ") ?? "";
          const description = memory.frontmatter.description ?? "";
          const fields = {
            path: normalizeSearchText(relPath),
            tags: normalizeSearchText(tagText),
            description: normalizeSearchText(description),
            content: normalizeSearchText(memory.content),
          };

          let score = 0;
          const reasons: string[] = [];
          let matchedTerms = 0;

          for (const term of terms) {
            let termScore = 0;
            if (fields.path.includes(term)) termScore += 40;
            if (fields.tags.includes(term)) termScore += 30;
            if (fields.description.includes(term)) termScore += 20;
            const bodyHits = countOccurrences(fields.content, term);
            if (bodyHits > 0) termScore += Math.min(10, bodyHits) * 2;

            if (termScore > 0) matchedTerms++;
            score += termScore;
          }

          if (matchedTerms === terms.length) score += 25;
          else if (terms.length > 1 && matchedTerms === 0) return null;

          if (score === 0) return null;

          if (terms.some((term) => fields.path.includes(term))) reasons.push("path");
          if (terms.some((term) => fields.tags.includes(term))) reasons.push("tags");
          if (terms.some((term) => fields.description.includes(term))) reasons.push("description");
          if (terms.some((term) => fields.content.includes(term))) reasons.push("content");

          return {
            relPath,
            score,
            description,
            tags: memory.frontmatter.tags ?? [],
            reasons,
            snippet: buildSnippet(memory.content, terms),
          };
        })
        .filter((result): result is NonNullable<typeof result> => result !== null)
        .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));

      if (scored.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${query}".` }],
          details: { files: [], count: 0 },
        };
      }

      const top = scored.slice(0, 15);
      const lines = [
        `Found ${scored.length} file(s) matching "${query}". Showing top ${top.length}.`,
        "",
        ...top.flatMap((result, index) => [
          `${index + 1}. ${result.relPath} (score ${result.score}; ${result.reasons.join(", ")})`,
          `   Description: ${result.description || "No description"}`,
          `   Tags: ${result.tags.join(", ") || "none"}`,
          result.snippet ? `   Snippet: ${result.snippet}` : "",
          "",
        ]),
        "Use memory_read to view full content.",
      ];

      return {
        content: [{ type: "text", text: lines.filter((line) => line !== "").join("\n") }],
        details: { files: top.map((result) => result.relPath), count: scored.length },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_search", args, theme), 0, 0),
    renderResult: (result, options, theme) => {
      const details = result.details as { count?: number; files?: string[] };
      const summary = details?.count ? `${details.count} result(s)` : "Search complete";
      return renderCollapsed(summary, getResultText(result), options, theme);
    },
  });
}

export function registerMemoryIndex(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_index",
    label: "Memory Index",
    description: "Regenerate generated memory index files",
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union([Type.Literal("all"), Type.Literal("projects")], {
          description: "Index scope. Currently 'all' and 'projects' both regenerate projects/INDEX.md.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { scope = "all" } = params as { scope?: "all" | "projects" };
      const memoryDir = getMemoryDir(settings, ctx.cwd);

      if (!fs.existsSync(memoryDir)) {
        return {
          content: [{ type: "text", text: `Memory directory not found: ${memoryDir}` }],
          details: { error: true },
        };
      }

      const result = generateProjectsIndex(memoryDir);
      return {
        content: [
          {
            type: "text",
            text: `Regenerated memory index (${scope}):\n- ${path.relative(memoryDir, result.path)} (${result.count} files across ${result.groups} group(s))`,
          },
        ],
        details: { scope, projects: result },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_index", args, theme), 0, 0),
    renderResult: (result, options, theme) => {
      if (options.isPartial) return renderText(theme.fg("warning", "Indexing..."));
      const details = result.details as { error?: boolean } | undefined;
      const text = getResultText(result);
      return renderText(theme.fg(details?.error ? "error" : "success", text));
    },
  });
}

export function registerMemoryInit(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
): void {
  pi.registerTool({
    name: "memory_init",
    label: "Memory Init",
    description: "Initialize memory repository (clone or create initial structure)",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Reinitialize even if already set up" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { force = false } = params as { force?: boolean };
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const alreadyInitialized = fs.existsSync(path.join(memoryDir, "system")) || fs.existsSync(path.join(memoryDir, "projects")) || fs.existsSync(path.join(memoryDir, "long-term"));

      if (alreadyInitialized && !force) {
        return {
          content: [{ type: "text", text: "Memory repository already initialized. Use force: true to reinitialize." }],
          details: { initialized: true },
        };
      }

      const result = await syncRepository(pi, settings, isRepoInitialized);
      if (!result.success) {
        return {
          content: [{ type: "text", text: `Initialization failed: ${result.message}` }],
          details: { success: false },
        };
      }

      ensureDirectoryStructure(memoryDir);
      createDefaultFiles(memoryDir);

      return {
        content: [
          {
            type: "text",
            text: `Memory repository initialized:\n${result.message}\n\nCreated directory structure:\n${["system", "projects", "long-term/user", "long-term/tech", "reference"].map((d) => `  - ${d}`).join("\n")}`,
          },
        ],
        details: { success: true },
      };
    },

    renderCall: (args, theme) => new Text(buildToolCallText("memory_init", args, theme), 0, 0),
    renderResult: (result, options, theme) => {
      if (options.isPartial) return renderText(theme.fg("warning", "Initializing..."));
      const details = result.details as { initialized?: boolean; success?: boolean };
      if (details?.initialized) return renderText(theme.fg("muted", "Already initialized"));
      const summary = details?.success ? "Initialized" : "Initialization failed";
      return renderCollapsed(summary, getResultText(result), options, theme);
    },
  });
}

export function registerMemoryCheck(pi: ExtensionAPI, settings: MemoryMdSettings): void {
  pi.registerTool({
    name: "memory_check",
    label: "Memory Check",
    description: "Check current project memory folder structure",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      if (!fs.existsSync(memoryDir)) {
        return {
          content: [
            {
              type: "text",
              text: `Memory directory not found: ${memoryDir}\n\nProject memory may not be initialized yet.`,
            },
          ],
          details: { exists: false },
        };
      }

      const files = listMemoryFiles(memoryDir);
      const topLevelDirs = fs
        .readdirSync(memoryDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => {
          const dirPath = path.join(memoryDir, entry.name);
          const count = listMemoryFiles(dirPath).length;
          return { name: entry.name, count };
        });

      const lines = [
        `Memory summary for project: ${path.basename(ctx.cwd)}`,
        `Path: ${memoryDir}`,
        `Total markdown files: ${files.length}`,
        "",
        "Top-level areas:",
        ...topLevelDirs.map((dir) => `  - ${dir.name}/ (${dir.count} files)`),
      ];

      lines.push("", "Use memory_list with a directory argument for detailed file names.");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { path: memoryDir, fileCount: files.length, areas: topLevelDirs },
      };
    },

    renderCall: (_args, theme) => new Text(buildToolCallText("memory_check", {}, theme), 0, 0),
    renderResult: (result, options, theme) => {
      if (options.isPartial) return renderText(theme.fg("warning", "Checking..."));
      const details = result.details as { exists?: boolean; fileCount?: number };

      if (details?.exists === false) {
        return renderCollapsed("Not initialized", getResultText(result), options, theme);
      }

      return renderCollapsed(`Structure: ${details?.fileCount ?? 0} files`, getResultText(result), options, theme);
    },
  });
}

export function registerAllMemoryTools(
  pi: ExtensionAPI,
  settings: MemoryMdSettings,
  isRepoInitialized: { value: boolean },
): void {
  registerMemorySync(pi, settings, isRepoInitialized);
  registerMemoryContext(pi, settings);
  registerMemoryRead(pi, settings);
  registerMemoryWrite(pi, settings);
  registerMemoryDelete(pi, settings);
  registerMemoryList(pi, settings);
  registerMemorySearch(pi, settings);
  registerMemoryReview(pi, settings);
  registerMemoryCleanup(pi, settings);
  registerMemoryIndex(pi, settings);
  registerMemoryInit(pi, settings, isRepoInitialized);
  registerMemoryCheck(pi, settings);
}
