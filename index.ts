import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  buildMemoryContext,
  buildMemoryContextPreview,
  createDefaultFiles,
  ensureDirectoryStructure,
  getMemoryDir,
  gitExec,
  loadSettings,
  type MemoryMdSettings,
  syncRepository,
} from "./memoryMdCore.js";
import { registerAllMemoryTools, runInteractiveReview } from "./tools.js";

/**
 * Main extension initialization.
 */

export default function memoryMdExtension(pi: ExtensionAPI): void {
  const settings: MemoryMdSettings = loadSettings();
  const repoInitialized = { value: false };
  let syncPromise: ReturnType<typeof syncRepository> | null = null;
  let cachedMemoryContext: string | null = null;
  let memoryInjected = false;

  /** Count core index entries only; the context also lists external areas. */
  function countCoreEntries(context: string): number {
    return context.split("\n").filter((line) => line.startsWith("- core/")).length;
  }

  function withMemoryTitle(context: string): string {
    return context.trimStart().startsWith("# Project Memory") ? context : `# Project Memory\n\n${context}`;
  }

  function countMarkdownFiles(dir: string): number {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) count += countMarkdownFiles(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) count++;
    }
    return count;
  }

  function initMemoryContext(
    ctx: ExtensionContext,
    options: { showNotification: boolean; autoSync: boolean },
  ): boolean {
    Object.assign(settings, loadSettings());

    if (!settings.enabled) return false;

    const memoryDir = getMemoryDir(settings, ctx.cwd);
    const coreDir = path.join(memoryDir, "core");

    if (!fs.existsSync(coreDir)) {
      if (options.showNotification) {
        ctx.ui.notify("Memory-md not initialized. Use /memory-init to set up project memory.", "info");
      }
      return false;
    }

    if (options.autoSync && settings.autoSync?.onSessionStart && settings.localPath) {
      syncPromise = syncRepository(pi, settings, repoInitialized).then((syncResult) => {
        if (settings.repoUrl) {
          ctx.ui.notify(syncResult.message, syncResult.success ? "info" : "error");
        }
        return syncResult;
      });
    }

    cachedMemoryContext = buildMemoryContext(settings, ctx.cwd);
    memoryInjected = false;
    return true;
  }

  pi.on("session_start", async (event, ctx) => {
    Object.assign(settings, loadSettings());

    if (event.reason === "new" || event.reason === "fork") {
      syncPromise = null;
      initMemoryContext(ctx, { showNotification: true, autoSync: false });
    } else {
      initMemoryContext(ctx, { showNotification: true, autoSync: true });
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (syncPromise) {
      await syncPromise;
      syncPromise = null;
    }

    const mode = settings.injection || "message-append";

    if (cachedMemoryContext && !memoryInjected) {
      memoryInjected = true;
      const fileCount = countCoreEntries(cachedMemoryContext);
      ctx.ui.notify(`Memory injected: ${fileCount} files (${mode})`, "info");

      if (mode === "message-append") {
        return {
          message: {
            customType: "pi-memory-md",
            content: withMemoryTitle(cachedMemoryContext),
            display: false,
          },
        };
      }
      return { systemPrompt: `${event.systemPrompt}\n\n${withMemoryTitle(cachedMemoryContext)}` };
    }

    return undefined;
  });

  registerAllMemoryTools(pi, settings, repoInitialized);

  pi.registerCommand("memory-status", {
    description: "Show memory repository status",
    handler: async (_args, ctx) => {
      const projectName = path.basename(ctx.cwd);
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const coreUserDir = path.join(memoryDir, "core", "user");

      if (!fs.existsSync(coreUserDir)) {
        ctx.ui.notify(`Memory: ${projectName} | Not initialized | Use /memory-init to set up`, "info");
        return;
      }

      const result = await gitExec(pi, settings.localPath!, ["status", "--porcelain"]);
      const isDirty = result.stdout.trim().length > 0;

      ctx.ui.notify(
        `Memory: ${projectName} | Repo: ${isDirty ? "Uncommitted changes" : "Clean"} | Path: ${memoryDir}`,
        isDirty ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("memory-init", {
    description: "Initialize memory repository",
    handler: async (_args, ctx) => {
      const memoryDir = getMemoryDir(settings, ctx.cwd);
      const alreadyInitialized = fs.existsSync(path.join(memoryDir, "core", "user"));

      const result = await syncRepository(pi, settings, repoInitialized);

      if (!result.success) {
        ctx.ui.notify(`Initialization failed: ${result.message}`, "error");
        return;
      }

      ensureDirectoryStructure(memoryDir);
      createDefaultFiles(memoryDir);

      if (alreadyInitialized) {
        ctx.ui.notify(`Memory already exists: ${result.message}`, "info");
      } else {
        ctx.ui.notify(
          `Memory initialized: ${result.message}\n\nCreated:\n  - core/user\n  - core/project\n  - reference`,
          "info",
        );
      }
    },
  });

  pi.registerCommand("memory-review", {
    description: "Review memory for cleanup candidates and decide what to keep, archive, merge, or delete",
    handler: async (args, ctx) => {
      const parsed = Number.parseInt(args.trim(), 10);
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      const text = await runInteractiveReview(settings, ctx, limit === undefined ? {} : { limit });
      pi.sendMessage({ customType: "pi-memory-md-review", content: text, display: true });
    },
  });

  pi.registerCommand("memory-context", {
    description: "Preview the memory context injected for the agent",
    handler: async (args, ctx) => {
      const mode = args.trim().toLocaleLowerCase() === "exact" ? "exact" : "summary";
      pi.sendMessage({
        customType: "pi-memory-md-context-preview",
        content: buildMemoryContextPreview(settings, ctx.cwd, mode),
        display: true,
      });
    },
  });

  pi.registerCommand("memory-refresh", {
    description: "Refresh memory context from files",
    handler: async (_args, ctx) => {
      const memoryContext = buildMemoryContext(settings, ctx.cwd);

      if (!memoryContext) {
        ctx.ui.notify("No memory files found to refresh", "warning");
        return;
      }

      cachedMemoryContext = memoryContext;
      memoryInjected = false;

      const mode = settings.injection || "message-append";
      const fileCount = countCoreEntries(memoryContext);

      if (mode === "message-append") {
        pi.sendMessage({
          customType: "pi-memory-md-refresh",
          content: withMemoryTitle(memoryContext),
          display: false,
        });
        ctx.ui.notify(`Memory refreshed: ${fileCount} files injected (${mode})`, "info");
      } else {
        ctx.ui.notify(`Memory cache refreshed: ${fileCount} files (will be injected on next prompt)`, "info");
      }
    },
  });

  pi.registerCommand("memory-check", {
    description: "Show compact memory folder summary",
    handler: async (_args, ctx) => {
      const memoryDir = getMemoryDir(settings, ctx.cwd);

      if (!fs.existsSync(memoryDir)) {
        ctx.ui.notify(`Memory directory not found: ${memoryDir}`, "error");
        return;
      }

      const topLevelDirs = fs
        .readdirSync(memoryDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => {
          const dirPath = path.join(memoryDir, entry.name);
          const count = fs.existsSync(dirPath) ? countMarkdownFiles(dirPath) : 0;
          return `- **${entry.name}/** — ${count} markdown files`;
        });

      pi.sendMessage({
        customType: "pi-memory-md-check",
        content: [
          "# Memory Check",
          "",
          `Path: \`${memoryDir}\``,
          "",
          "## Top-level areas",
          "",
          ...topLevelDirs,
          "",
          "Use `/memory-context` to see what is injected into the agent context.",
        ].join("\n"),
        display: true,
      });
    },
  });
}
