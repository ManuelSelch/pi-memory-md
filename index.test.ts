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
  buildMemoryContext: () => "",
  syncRepository: vi.fn(),
}));
vi.mock("./tools.js", () => ({ registerAllMemoryTools: vi.fn() }));

import memoryMdExtension from "./index.js";
import { syncRepository } from "./memoryMdCore.js";

beforeEach(() => vi.clearAllMocks());

async function startupNotifications(result: Awaited<ReturnType<typeof syncRepository>>) {
  vi.mocked(syncRepository).mockResolvedValue(result);
  const handlers = new Map<string, Function>();
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: vi.fn(),
  };
  const notify = vi.fn();
  const ctx = { cwd: "/project", ui: { notify } };
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
