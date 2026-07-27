# Jarvis second brain — Wave Vault direction

**Date:** 2026-07-22  
**Status:** Approved storage direction; UI design follows separately.  
**Scope:** Product and architecture brief only. This is not an implementation spec or plan.

## Intent

Evolve Jarvis from a Channels-bound fleet manager into an app-wide assistant that preserves continuity across engineering tasks. Jarvis should know what the user is working on, why decisions were made, what remains, and which agents, Runs, evidence, and artifacts belong to the work.

The organizing unit is a **task dossier**: one living record per ticket or task. A dossier may span several Channels, Runs, agents, pauses, and review cycles.

## Storage decision

Wave owns a local, Obsidian-compatible **Wave Vault** and renders it through native cockpit surfaces. The vault uses plain Markdown, YAML frontmatter, `[[wikilinks]]`, and ordinary attachments. Wave does not embed or depend on the Obsidian application; Obsidian may optionally open the same folder as an external editor.

Markdown is canonical. Any search index or cache must be rebuildable from the files. Wave must not maintain a second authoritative dossier in SQLite and synchronize it back to Markdown.

Suggested logical layout:

```text
~/.waveterm/vault/
├── memory/                  # durable knowledge eligible for agent projection
├── tasks/
│   ├── active/              # operational dossiers for the user and Jarvis
│   └── archive/
├── decisions/               # durable cross-task decisions when useful
└── attachments/
```

The exact physical path remains user-selectable. The important contract is the collection boundary, not the default location. The vault is its own dedicated folder, separate from any personal notes vault.

## Versioning and location

The vault is its own git repository. Git provides the version history and audit trail for free, and a user-configured remote gives backup and cross-machine sync without Wave implementing sync (cloud sync stays a non-goal).

Commit cadence is deliberately coarse: Wave commits at task lifecycle boundaries (started / paused / completed) plus an idle/quit safety flush, not per field write, so `git log` reads as the task's narrative rather than a firehose. Machine writes are authored as `Jarvis`; the user's own edits are committed as the user. When a batched flush contains both, Wave stages them as separate commits by ownership so authorship stays unambiguous. This, with `git blame`, is the enforcement mechanism for the write-ownership contract, and it lets the dossier's activity trail lean on git history instead of a duplicated in-file log.

## Memory and task isolation

Task dossiers are not agent memory.

- `memory/**` contains durable, reusable knowledge and may be projected into agent steering context.
- `tasks/**` contains operational state and is never projected automatically.
- When dispatching a worker for a task, Jarvis selects only the relevant objective, acceptance criteria, and constraining decisions for that worker's prompt.
- At task completion, Jarvis may propose reusable learnings for promotion into `memory/**`; promotion requires human approval.

This boundary must be enforced by deterministic collection-aware code, not by a prompt asking the model to ignore task files. The current Memory scanner treats Markdown under a configured root as memory, so task dossiers cannot simply be placed under that root without changing the scanner and its consumers.

## Dossier responsibility

A dossier stores human-level work state:

- external ticket reference and a local snapshot of its objective and acceptance criteria;
- current status and concise state summary;
- decisions with rationale, actor, timestamp, and provenance;
- blockers and unresolved questions;
- references to associated Channels, Runs, agents, commits, and artifacts;
- a compact activity trail and final outcome.

The dossier should reference existing Wave records rather than copy their raw contents. Transcripts, diffs, test evidence, and Run lifecycle data remain authoritative in their existing stores. Wave resolves dossier references to enrich the in-app view; the Markdown remains readable without Wave.

The external tracker remains authoritative for official ticket state. The dossier is Jarvis's working model of how the task is being executed, not a replacement issue tracker.

## Capture and judgment boundary

Deterministic code records facts such as Run transitions, worker blockers, submitted decisions, verification results, and produced artifacts. The model may summarize those facts, match evidence against acceptance criteria, identify likely gaps, and suggest next actions.

Jarvis must not silently invent decisions, declare a task complete, or rewrite official ticket state. Human confirmation owns material decisions and completion.

Manual edits are first-class. Jarvis should update known machine-owned fields or append structured entries rather than regenerate whole files. Writes must use the existing conflict-aware pattern so an external Obsidian edit is not overwritten.

## Product shape

The vault is one storage substrate with separate product surfaces:

- **Tasks** presents active and archived dossiers.
- **Memory** remains focused on durable knowledge.
- **Jarvis** converses over the active task, current surface, and live Wave state.
- **Graph** may visualize relationships across collections without weakening projection isolation.

Jarvis should have an app-wide presence rather than remain confined to Channels. The exact UI, invocation model, task-navigation hierarchy, and relationship between Tasks, Memory, and the global Jarvis presence are the next design topic.

## Open design questions (next pass)

Storage direction is settled; these are the load-bearing problems the next design pass must resolve rather than defer:

- **Write-ownership contract.** Which regions of a dossier are machine-owned (frontmatter, fenced status blocks) versus human-owned (prose), so batched git flushes can stage them as separately authored commits. Git makes this tractable, but the region contract must be explicit.
- **Recall mechanism.** How on-demand recall, continuity, and proactive resurfacing actually query the vault. Frontmatter and full-text cover status lookups; proactive resurfacing needs semantic matching, which implies an embedding index over the vault with its own rebuild and freshness story. This is core, not UI.
- **Attribution / attach.** How a Channel, Run, agent, or commit is linked to a task — explicit active-task selection (reliable, some friction) versus inference from branch or repo (frictionless, fuzzy). A dossier is only as trustworthy as what gets attributed to it.
- **Presence and invocation.** How the app-wide Jarvis is summoned and where it lives across surfaces.

## Deliberate non-goals

- Embedding the Obsidian application or executing Obsidian plugins
- Dataview, Canvas, theme, or plugin compatibility
- Replacing Jira, Linear, or another external tracker
- Automatically projecting task history into every coding agent
- Copying full transcripts or Run evidence into Markdown
- Cloud sync or collaborative editing
- Building a general-purpose knowledge-management product

## Why this direction

The Wave Vault keeps the second brain inspectable, portable, correctable, and user-owned. The collection boundary prevents task noise from diluting agent memory. Task dossiers sit above Channels and Runs, which matches their real cardinality: one task may contain many execution attempts, while a Channel may host more than one task.

