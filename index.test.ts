import { beforeEach, expect, it, vi } from "vitest";
import { CombinedAutocompleteProvider } from "@mariozechner/pi-tui";

vi.mock("node:fs", () => ({ default: { existsSync: () => true } }));
vi.mock("./memoryMdCore.js", () => ({
  loadSettings: () => ({
    enabled: true,
    localPath: "/memory",
    repoUrl: "https://github.com/example/memory-md.git",
  }),
  getMemoryDir: () => "/memory",
  buildMemoryContext: vi.fn(() => ""),
  syncRepository: vi.fn(),
}));
vi.mock("./tools.js", () => ({ registerAllMemoryTools: vi.fn() }));

import memoryMdExtension from "./index.js";
import { buildMemoryContext, syncRepository } from "./memoryMdCore.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildMemoryContext).mockReturnValue("");
});

function memoryCommand() {
  const registerCommand = vi.fn();
  const sendUserMessage = vi.fn();
  memoryMdExtension({ on: vi.fn(), registerCommand, sendMessage: vi.fn(), sendUserMessage } as any);
  expect(registerCommand).toHaveBeenCalledTimes(1);
  expect(registerCommand.mock.calls[0][0]).toBe("memory");
  return registerCommand.mock.calls[0][1];
}

it("starts an agent-driven review from the memory command", async () => {
  const sendUserMessage = vi.fn();
  const registerCommand = vi.fn();
  memoryMdExtension({ on: vi.fn(), registerCommand, sendMessage: vi.fn(), sendUserMessage } as any);
  await registerCommand.mock.calls[0][1].handler("review 10", { ui: { notify: vi.fn() } });
  expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("memory_review"));
  expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Requested scope or limit: 10"));
});

it("completes memory subcommands and context modes", () => {
  const command = memoryCommand();
  expect(command.getArgumentCompletions("").map((item: any) => item.value).sort())
    .toEqual(["check", "context", "init", "refresh", "review", "status"]);
  expect(command.getArgumentCompletions("re").map((item: any) => item.value))
    .toEqual(["review", "refresh"]);
  expect(command.getArgumentCompletions("context e")).toEqual([{ value: "context exact", label: "exact" }]);
  expect(command.getArgumentCompletions("context ").map((item: any) => item.value))
    .toEqual(["context summary", "context exact"]);
  expect(command.getArgumentCompletions("invalid")).toBeNull();
});

it.each([
  ["/memory context e", "exact", "/memory context exact"],
  ["/memory context ", "summary", "/memory context summary"],
  ["/memory re", "review", "/memory review"],
])("applies native Pi completion to %s", async (input, label, expected) => {
  const command = memoryCommand();
  const provider = new CombinedAutocompleteProvider([{ name: "memory", ...command }]);
  const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
  expect(suggestions).not.toBeNull();
  const item = suggestions!.items.find((candidate) => candidate.label === label)!;
  expect(item).toBeDefined();
  const result = provider.applyCompletion([input + " suffix"], 0, input.length, item, suggestions!.prefix);
  expect(result.lines).toEqual([expected + " suffix"]);
  expect(result.cursorCol).toBe(expected.length);
});

it.each(["", "invalid", "toString"])("shows usage for %j without dispatching", async (args) => {
  const command = memoryCommand();
  const notify = vi.fn();
  await command.handler(args, { ui: { notify } });
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /memory <subcommand>"), args ? "warning" : "info");
});

it("dispatches refresh through the unified command", async () => {
  vi.mocked(buildMemoryContext).mockReturnValue("# Project Memory\n\nPreferences");
  const sendMessage = vi.fn();
  const registerCommand = vi.fn();
  memoryMdExtension({ on: vi.fn(), registerCommand, sendMessage } as any);
  await registerCommand.mock.calls[0][1].handler("refresh", { cwd: "/project", ui: { notify: vi.fn() } });
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "pi-memory-md-refresh", display: false }));
});

it("does not synchronize when opening a session", async () => {
  const handlers = new Map<string, Function>();
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: vi.fn(),
  };
  const ctx = { cwd: "/project", ui: { notify: vi.fn() }, sessionManager: { getBranch: () => [] } };
  memoryMdExtension(pi as any);
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  await handlers.get("before_agent_start")!({}, ctx);
  expect(syncRepository).not.toHaveBeenCalled();
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
