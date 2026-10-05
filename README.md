# pi-memory-md

Letta-like memory management for [pi](https://github.com/badlogic/pi-mono) using Git-backed markdown files.

## Features

- **Persistent Memory**: Store context, preferences, and knowledge across sessions
- **Git-backed**: Version control with full history
- **Prompt append**: Memory index automatically appended to conversation at session start
- **On-demand access**: LLM reads full content via tools when needed
- **Multi-project**: Separate memory spaces per project

## Quick Start

```bash
# 1. Install
pi install npm:pi-memory-md
# Or for latest from GitHub:
pi install git:github.com/VandeeFeng/pi-memory-md

# 2. Create a GitHub repository (private recommended)

# 3. Configure pi
# Add to ~/.pi/agent/settings.json:
{
  "pi-memory-md": {
    "enabled": true,
    "repoUrl": "git@github.com:username/repo.git", // or HTTPS format
    "localPath": "~/.pi/memory-md"
  }
}

# 4. Start a new pi session
# type /memory init to initialize the memory files
```

## How It Works

```
Session Start
    ↓
1. Git pull (sync latest changes)
    ↓
2. Scan all .md files in memory directory
    ↓
3. Load system bodies and build project/long-term indexes
    ↓
4. Add memory as a hidden message for a new session only
    ↓
5. LLM reads full file content via tools when needed
```

## Slash Commands In Pi

Use `/memory` with a subcommand. Tab completion suggests subcommands and `context summary|exact`. Running `/memory` without arguments shows usage.

| Command | Description |
|---------|-------------|
| `/memory init` | Initialize memory repository (clone repo, create directory structure, generate default files) |
| `/memory status` | Show memory repository status (project name, git status, path) |
| `/memory refresh` | Refresh memory context from files (rebuild cache and inject into current session) |
| `/memory check` | Show memory folder summary |
| `/memory context [summary\|exact]` | Preview memory context |
| `/memory review [scope]` | Ask the agent to review memory and apply safe cleanup |

## Available Tools

The LLM can use these tools to interact with memory:

### Memory Management Tools

| Tool | Parameters | Description |
|------|------------|-------------|
| `memory_init` | `{force?: boolean}` | Initialize or reinitialize repository |
| `memory_sync` | `{action: "pull" / "push" / "status"}` | Git operations |
| `memory_read` | `{path: string}` | Read a memory file |
| `memory_write` | `{path, content, description, tags?}` | Create/update memory; system changes require approval |
| `memory_delete` | `{path}` | Permanently delete memory with explicit approval |
| `memory_review` | `{limit?, area?, folder?, kind?, includeDismissed?}` | Read-only candidate scan with structured evidence |
| `memory_cleanup` | `{action: "archive" / "dismiss", ...}` | Apply guarded archive or dismissal operations |
| `memory_list` | `{directory?: string}` | List all memory files |
| `memory_search` | `{query?, grep?, rg?}` | Search by tags/description and custom grep/ripgrep patterns |
| `memory_check` | `{}` | Check current project memory folder structure |

## Memory File Format

```markdown
---
description: "User identity and background"
tags: ["user", "identity"]
created: "2026-02-14"
updated: "2026-02-14"
---

# Your Content Here

Markdown content...
```

## Directory Structure

```
~/.pi/memory-md/
└── project-name/
    ├── system/             # Always-loaded policies and preferences
    ├── projects/           # Project-specific memory
    ├── long-term/          # Durable user and technical knowledge
    ├── reference/          # Read-only, on-demand docs
    └── archive/            # Retired memory
```

## Configuration

```json
{
  "pi-memory-md": {
    "enabled": true,
    "repoUrl": "git@github.com:username/repo.git", // Or HTTPS format
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable extension |
| `repoUrl` | Required | GitHub repository URL |
| `localPath` | `~/.pi/memory-md` | Local clone path |

### Memory Injection

Memory is loaded locally at session start. Git synchronization is explicit through the `memory_sync` tool or `/memory init`; no Git pull runs automatically when a session opens.

Memory is added as a hidden custom agent message before the first agent turn of a new session. Reopening an existing conversation does not add memory again. It is stored in the session context and is not displayed in the TUI (`display: false`). The message contains full `system/` file bodies plus indexes for project and long-term memory. Use `/memory refresh` after changing memory files during a session.
## Usage Examples

Simply talk to pi - the LLM will automatically use memory tools when appropriate:

```
You: Save my preference for 2-space indentation in TypeScript files to memory.

Pi: [Uses memory_write tool to save your preference]
```

You can also explicitly request operations:

```
You: List all memory files for this project.
You: Search memory for "typescript" preferences.
You: Read long-term/user/identity.md
You: Sync my changes to the repository.
```

The LLM automatically:
- Reads memory index at session start (appended to conversation)
- Writes new information when you ask to remember something
- Syncs changes when needed

## Reference
- [Introducing Context Repositories: Git-based Memory for Coding Agents | Letta](https://www.letta.com/blog/context-repositories)
- https://tape.systems
- https://bub.build/
- https://github.com/bubbuild/bub/tree/main/src/bub

