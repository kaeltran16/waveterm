# docs

Design records and reference material for Arc. `CLAUDE.md` at the repo root is the working
reference for build commands, architecture, and gotchas — start there.

## Directories

| Path | What's in it |
| --- | --- |
| `superpowers/specs/` | Design docs — the **why** behind each feature. Written before implementation, kept after. The durable layer. |
| `superpowers/plans/` | Implementation plans. Only kept where no spec covers the same work; spec-backed plans are deleted once shipped, since the spec plus git history supersedes them. |
| `superpowers/briefs/` | Decision and scan briefs — backlogs, ranked improvement passes, direction calls. |
| `agents/` | Integration notes for the external agent reporters and hooks that live under `~/.claude`, plus the ask-channel hook scripts themselves. |
| `handoff/` | Dated verification records. Each one is a snapshot of a live CDP pass, kept for its reproductions rather than its conclusions. |
| `reference/` | Protocol and format references cited from source comments. |
| `images/` | Screenshots referenced by the docs above. |

## Standing documents

| File | Role |
| --- | --- |
| `deferred.md` | Append-only running log of intentionally-deferred work, and why. Append at the top, then mirror a one-line row into `open-issues.md`. |
| `open-issues.md` | **The single consolidated "what's left" list** — active workstreams, actionable smalls, blocked/held/declined items across every tracker. Start here. |
| `jarvis-tab.md` | Reference for the consolidated Jarvis surface. Its "Known gaps" table is the live status. |
| `jarvis-tour.md` | Task-ordered walkthrough of Jarvis — what to *do*, where `jarvis-tab.md` says what things *are*. |
| `diff-tab.md` | Reference and walkthrough for the Diff surface, in one file: every control, the compare state, the keys, and the current limits. |
| `jarvis-consolidation-open-issues.md`, `jarvis-second-brain-open-issues.md` | Archived/closed detail records for those two sub-projects (consolidation: all fixed; second brain: J-entry evidence). Open residue lives in `open-issues.md`. |
| `keyboard-shortcuts.md` | Human-readable mirror of the keybinding registry (`frontend/app/store/keybindings/` is the source of truth). |
| `orchestrator-roadmap.md`, `redesign-brief.md`, `redesign-meta-spec.md`, `tauri-migration-meta-spec.md`, `feature-triage.md` | Direction and umbrella docs. Largely historical — they record sequencing rationale, not remaining work. |

## Conventions

- Specs and plans are named `YYYY-MM-DD-<topic>[-design].md` and commit with the feature they describe.
- Cross-references are repo-root-relative (`docs/superpowers/specs/…`), not relative paths.
