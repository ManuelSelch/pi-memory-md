# Intelligent Memory Review

## Problem overview

The current memory review combines deterministic candidate detection, semantic decisions, interactive prompts, and file mutation in one workflow. Tag overlap is treated as duplication even when notes are merely related, and the user must manually walk every finding through `/memory review`.

Memory review should instead be an agent-driven workflow. Deterministic code should find and explain candidates, the agent should read the relevant notes and make semantic judgments, and mutation tools should enforce safety boundaries. The user should be interrupted only when an operation is dangerous.

## Goals

- Let the agent initiate and complete memory hygiene work without a manual review wizard.
- Keep candidate discovery deterministic, bounded, and read-only.
- Let the active agent perform semantic comparison using normal `memory_read` calls.
- Expose explicit cleanup operations instead of letting review code mutate files implicitly.
- Require user approval only for dangerous operations.
- Make safe cleanup reversible and auditable.
- Preserve the rule that `reference/` is always read-only.

## Non-goals

- Embeddings, a vector database, or a second nested LLM call inside the extension.
- Reviewing or modifying `reference/`.
- Running a full review on every session start.
- Automatically deleting information based only on heuristic scores.
- Treating folder policy as frontmatter metadata.
- Replacing the existing general-purpose memory read/write/search tools.

## Definitions

- **Candidate:** A deterministic signal that one or more notes may need attention. It is not a semantic conclusion.
- **Finding:** The agent's conclusion after reading candidate notes.
- **Safe operation:** Reversible or information-preserving cleanup that does not affect system instructions.
- **Dangerous operation:** An irreversible, destructive, broad, or system-behavior-changing mutation.
- **Review scope:** The writable notes included in one scan, optionally restricted by area, project, or finding kind.

## Target architecture

### Candidate scanner: `memory_review`

`memory_review` must be a read-only model-callable tool. It must:

- scan writable memory areas except `archive/`;
- never inspect or report `reference/`;
- return structured candidate data as well as concise model-facing text;
- include the evidence that caused each candidate to be emitted;
- support bounded filtering by area, project/folder, candidate kind, and limit;
- never open interactive UI;
- never mutate, archive, merge, or delete notes.

Candidate kinds may include:

- related notes;
- possible stale content;
- time-boxed content;
- volatile facts;
- short/stub notes;
- over-fragmented project folders.

The scanner must use language such as “related notes” or “possible overlap,” not claim that tag similarity proves duplication.

### Agent orchestration

The active agent provides the intelligence. For each meaningful candidate, it must:

1. inspect the scanner's evidence;
2. read all candidate notes required for a semantic decision;
3. classify the relationship, for example duplicate, complementary, superseded, stale but useful, or false positive;
4. choose no action, dismiss, update, archive, consolidate, or delete;
5. call the cleanup tool for approved operations;
6. summarize what changed and what was intentionally left unchanged.

The extension must not make a nested model request. Normal agent tool calls provide the semantic review.

### Cleanup executor: `memory_cleanup`

Add a separate model-callable mutation tool. Each invocation must describe one explicit operation and its affected paths. Initial operations:

- `archive`: move a writable note to its equivalent path under `archive/`;
- `merge`: write consolidated content to a target and archive the source notes;
- `delete`: permanently remove a writable note;
- `update`: replace or amend a writable note with agent-provided content;
- `dismiss`: record that a candidate should not be reported again while its inputs remain unchanged.

The executor must:

- validate every path stays within the memory repository;
- reject every mutation under `reference/`;
- reject nested `archive/archive/` destinations;
- detect destination collisions;
- regenerate affected generated indexes after successful project changes;
- return a structured operation result;
- avoid partial changes when validation fails;
- record enough information to explain each applied operation.

## Approval policy

Approval rules must be enforced by the cleanup executor, not merely described in prompts.

### Safe without approval

- Archive a writable non-system note.
- Update tags or descriptions of a writable non-system note.
- Merge notes when the supplied result preserves their content and all sources are archived rather than deleted.
- Regenerate generated indexes.
- Dismiss a false-positive candidate.

### Requires explicit user approval

- Permanently delete any note.
- Modify, move, merge, or archive a note under `system/`.
- Overwrite an existing merge or update target when its current content is not preserved.
- Apply one request to more than five notes.
- Remove material information from a note.

If no interactive UI is available, a dangerous operation must fail safely and report that approval is required.

### Always prohibited

- Write, move, merge, archive, or delete anything under `reference/`.
- Escape the configured memory directory through absolute paths or traversal.

## Candidate evidence

Every candidate must have a stable identifier and include:

- candidate kind;
- involved relative paths;
- human-readable reason;
- rule-specific evidence;
- severity or confidence used only for ordering;
- a fingerprint derived from relevant paths and note state.

Rule-specific evidence should include:

- related notes: shared discriminative tags and pairwise scores;
- time-boxed or volatile content: the matching text and rule;
- stale notes: note age and comparison baseline;
- stubs: measured body size and threshold;
- fragmentation: folder count and guideline.

A candidate must not recommend a keeper as authoritative. It may identify the newest or broadest note as evidence.

## Dismissals

- Dismissals must be stored outside note frontmatter.
- A dismissal applies to a candidate fingerprint, not forever to a path.
- It must stop suppressing the candidate when an involved note changes materially.
- Dismissal storage must not participate in injected memory context.
- The scanner must support including dismissed candidates for diagnostics.

## Automatic use

The agent should be encouraged to call `memory_review`:

- after several related memory writes in one project;
- when a write result reports possible overlap;
- when a project folder exceeds the configured note-count guideline;
- when the user asks to clean, consolidate, or review memory.

A full review must not run automatically at session start. Lightweight checks after `memory_write` may return a `reviewSuggested` signal with candidate kinds and affected folder, allowing the agent to decide whether to run a scoped review.

## Slash-command behavior

`/memory review` remains a convenience entry point, not a separate review engine. It should start the same agent-driven workflow available through tools. It must not implement its own mutation UI.

Argument completion should eventually support:

- `/memory review project <name>`;
- `/memory review kind <kind>`;
- `/memory review system`;
- `/memory review report`.

The command and tool must share the same scanner behavior and filters.

## Reporting

A completed review should report:

- scope and number of notes scanned;
- candidates inspected;
- findings dismissed as false positives;
- safe operations applied automatically;
- dangerous operations approved, denied, or deferred;
- paths changed, archived, merged, or deleted;
- whether generated indexes were refreshed.

Repeated findings concerning the same note should be grouped so the agent can make one coherent decision.

## Reliability and safety requirements

- Candidate scanning must be deterministic for identical files, options, and time input.
- Scanner and executor behavior must have unit tests with temporary repositories.
- Mutation tests must cover rollback/no-partial-change behavior.
- Existing read-only protections for `reference/` must remain regression-tested.
- Archive operations must preserve file contents and frontmatter.
- Merge operations must archive sources and preserve their content unless the user explicitly approves information removal.
- The review workflow must remain useful in non-TUI modes.

## Incremental delivery plan

### Phase 1: Read-only structured scanner

1. Rename duplicate findings to related-note candidates.
2. Add stable candidate IDs, fingerprints, and rule evidence.
3. Return structured scanner output from `memory_review`.
4. Remove interactive behavior and mutations from `memory_review`.
5. Add scope and kind filters.

Acceptance criteria:

- Calling `memory_review` cannot change the filesystem.
- The BlueFlow backup/restore and schema notes are presented as related candidates, not asserted duplicates.
- Each candidate explains why it was emitted.
- `reference/` and `archive/` remain excluded.

### Phase 2: Safe cleanup executor

1. Add `memory_cleanup` with archive and dismiss operations.
2. Add centralized path and approval classification.
3. Add durable fingerprint-based dismissals.
4. Regenerate project indexes after project mutations.

Acceptance criteria:

- Archive and dismissal can run without approval for non-system notes.
- System changes, deletion, and bulk changes cannot bypass approval.
- `reference/` mutations are impossible.
- Failed validation leaves all files unchanged.

### Phase 3: Consolidation and destructive operations

1. Add merge with archive-preserved sources.
2. Add update and delete operations.
3. Add collision handling and explicit confirmations.
4. Add structured audit summaries.

Acceptance criteria:

- Information-preserving merge is reversible through archived sources.
- Delete always requires approval.
- Existing targets are never silently overwritten.
- Non-interactive dangerous calls fail safely.

### Phase 4: Agent-driven workflow

1. Update tool descriptions and memory-management guidance with the review protocol.
2. Make `/memory review` trigger the agent workflow rather than an interactive loop.
3. Add scoped command argument completion.
4. Add lightweight review suggestions to memory writes.

Acceptance criteria:

- The agent reads candidate notes before making semantic claims.
- Safe operations can complete without user interruption.
- Only dangerous operations trigger approval UI.
- Manual and automatic entry points use the same tools and rules.

## Assumptions

- Archiving a non-system note is considered safe because it is reversible through Git and the archive copy.
- A merge is safe only when source notes are archived and their information remains recoverable.
- Five affected notes is the initial boundary between a normal and bulk operation.
- The active agent, rather than extension-owned model calls, performs semantic analysis.

## Open questions

- Should safe content updates be limited to metadata at first, or may the agent rewrite non-system note bodies without approval?
- Where should dismissals live: a repository-local hidden file, or extension state outside the repository?
- Should approval thresholds such as the five-note bulk limit be configurable?
- Should `/memory review` immediately trigger an agent turn, or only insert a prepared review request into the editor?
