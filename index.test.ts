import { beforeEach, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ default: { existsSync: () => true } }));
vi.mock("./memoryMdCore.js", () => ({
  loadSettings: () => ({
    enabled: true,
    localPath: "/memory",
    repoUrl: "https://github.com/example/memory-md.git",
    autoSync: { onSessionStart: true },
  }),
  getMemoryDir: () => "/memory",
  buildMemoryContext: vi.fn(() => ""),
  syncRepository: vi.fn(),
}));
vi.mock("./tools.js", () => ({ registerAllMemoryTools: vi.fn() }));

import memoryMdExtension from "./index.js";
import { buildMemoryContext, syncRepository } from "./memoryMdCore.js";

beforeEach(() => vi.clearAllMocks());

async function startupNotifications(result: Awaited<ReturnType<typeof syncRepository>>) {
  vi.mocked(syncRepository).mockResolvedValue(result);
  const handlers = new Map<string, Function>();
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: vi.fn(),
  };
  const notify = vi.fn();
  const ctx = { cwd: "/project", ui: { notify }, sessionManager: { getBranch: () => [] } };
  memoryMdExtension(pi as any);
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  await handlers.get("before_agent_start")!({}, ctx);
  return notify;
}

it("does not show a popup when auto-sync is already latest", async () => {
  const notify = await startupNotifications({ success: true, updated: false, message: "[memory-md] is already latest" });
  expect(notify).not.toHaveBeenCalled();
});

it("still notifies when auto-sync pulls changes", async () => {
  const notify = await startupNotifications({ success: true, updated: true, message: "Pulled latest changes" });
  expect(notify).toHaveBeenCalledWith("Pulled latest changes", "info");
});

it("still notifies when auto-sync fails", async () => {
  const notify = await startupNotifications({ success: false, message: "Pull failed" });
  expect(notify).toHaveBeenCalledWith("Pull failed", "error");
});

it("injects memory into a new session", async () => {
  vi.mocked(buildMemoryContext).mockReturnValue("## system/preferences.md\n\n# Preferences");
  const handlers = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: vi.fn() };
  const ctx = { cwd: "/project", ui: { notify: vi.fn() }, sessionManager: { getBranch: () => [] } };
  memoryMdExtension(pi as any);
  await handlers.get("session_start")!({ reason: "new" }, ctx);
  const result = await handlers.get("before_agent_start")!({}, ctx);
  expect(result).toMatchObject({ message: { customType: "pi-memory-md", display: false } });
});

it("does not inject memory again when reopening a session", async () => {
  vi.mocked(syncRepository).mockResolvedValue({ success: true, updated: false, message: "Already latest" });
  vi.mocked(buildMemoryContext).mockReturnValue("## system/preferences.md\n\n# Preferences");
  const handlers = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: vi.fn() };
  const ctx = {
    cwd: "/project",
    ui: { notify: vi.fn() },
    sessionManager: { getBranch: () => [{ type: "custom_message", customType: "pi-memory-md", content: "old" }] },
  };
  memoryMdExtension(pi as any);
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  const result = await handlers.get("before_agent_start")!({}, ctx);
  expect(result).toBeUndefined();
});
