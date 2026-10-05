---
name: memory-management
description: Core memory operations for pi-memory-md - create, read, update, and delete memory files
---

# Memory Management

Use this skill when working with pi-memory-md memory files. Memory is stored as Markdown files with YAML frontmatter in a Git repository.

## Design Philosophy

- **File-based memory:** Each memory is a `.md` file with YAML frontmatter.
- **Git-backed:** Full version control and cross-device synchronization.
- **Folder-based loading:** `system/` bodies are always loaded; durable areas are indexed or read on demand.
- **Organized by purpose:** Folder placement determines memory behavior.

## Directory Structure

**Base path:** configured via `settings["pi-memory-md"].localPath` (default: `~/.pi/memory-md`).

```
{localPath}/
├── system/                         # Always-loaded policies and preferences
│   ├── memory-policy.md
│   └── preferences.md
├── projects/                       # Project-specific working memory
│   └── {project-name}/
│       └── *.md
├── long-term/                      # Durable knowledge, indexed on demand
│   ├── user/
│   │   └── identity.md
│   └── tech/
│       └── *.md
├── reference/                      # Externally managed, read-only material
└── archive/                        # Retired memory, search/read only
```

## Folder Policies

- `system/`: Stable behavior rules, preferences, and memory hygiene. Keep it small because full bodies are loaded into context.
- `projects/<project>/`: Current project decisions, architecture, state, and gotchas.
- `long-term/user/`: Durable user identity and preferences that do not belong in system instructions.
- `long-term/tech/`: Reusable technical knowledge and durable troubleshooting notes.
- `reference/`: Search and read only. Never write, edit, delete, or propose cleanup there.
- `archive/`: Retired notes retained for historical lookup. Move notes here instead of adding status metadata.

Do not add `scope`, `load`, `project`, or `status` fields to new frontmatter; folder placement is the policy.

## Frontmatter Schema

Every memory file should have YAML frontmatter:

```yaml
---
description: "Human-readable description of this memory file"
tags: ["user", "identity"]
created: "2026-02-14"
updated: "2026-02-14"
---
```

**Required:**
- `description` — human-readable description.

**Optional:**
- `tags` — array of strings used for search and categorization.
- `created` — creation date, added automatically on create.
- `updated` — modification date, updated automatically on write.

Existing unknown frontmatter is preserved when a note is updated, but new notes should use only the schema above.

## Decision Tree

1. Is this a durable behavioral rule or stable preference needed in every session? Use `system/`.
2. Is it specific to one project? Use `projects/<project-name>/`.
3. Is it durable knowledge reusable across projects? Use `long-term/user/` or `long-term/tech/`.
4. Is it externally managed documentation? Use `reference/` for reading only.
5. Is it retired or superseded? Move it to the matching path under `archive/`.

Before creating a new note, search for an existing note on the same topic and update it in place.

## Examples

### User identity

```text
memory_write(
  path="long-term/user/identity.md",
  description="User identity and background",
  tags=["user", "identity"],
  content="# User Identity\n\nName: ..."
)
```

### User preferences

```text
memory_write(
  path="system/preferences.md",
  description="User habits and communication preferences",
  tags=["user", "preferences"],
  content="# User Preferences\n\n- Be concise"
)
```

### Project architecture

```text
memory_write(
  path="projects/pi-memory-md/architecture.md",
  description="Project architecture and design",
  tags=["project", "architecture"],
  content="# Architecture\n\n..."
)
```

### Technical knowledge

```text
memory_write(
  path="long-term/tech/git-worktrees.md",
  description="Git worktree troubleshooting",
  tags=["git", "worktrees"],
  content="# Git Worktrees\n\n..."
)
```

### Archived decision

```text
memory_write(
  path="archive/decisions/2024-01-15-auth-redesign.md",
  description="Auth redesign decision from January 2024",
  tags=["archive", "decision"],
  content="# Auth Redesign\n\n..."
)
```

## Reading and Listing

```text
memory_read(path="long-term/user/identity.md")
memory_list()
memory_list(directory="projects/pi-memory-md")
memory_search(grep="typescript preferences")
```

Use `memory_read` for full content. The injected context contains complete `system/` bodies and index entries for durable areas.

## Updating and Deleting

Use `memory_write` with the same path to update a note. The extension preserves the existing `created` date and updates `updated` automatically. Use append mode when adding information without replacing the note.

Never modify anything under `reference/`. To retire a writable note, move it to `archive/` with the cleanup workflow rather than adding a status field.

## Maintenance

- Keep system memory small and durable.
- Prefer one focused note per topic.
- Update an existing note when new findings replace old ones.
- Consolidate project folders that grow beyond roughly 10 durable notes.
- Regenerate the project index after project-note changes.
- Run `memory_check()` before `memory_sync(action="push")`.

## Related Skills

- `memory-init` — initialize the repository.
- `memory-sync` — pull, status, commit, and push memory changes.
- `memory-search` — find and retrieve memory.
