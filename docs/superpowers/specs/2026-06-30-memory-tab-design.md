# Memory tab — design

Date: 2026-06-30
Status: design (UI layout intentionally deferred to a frontend-design pass)

## Summary

A new cockpit surface — **Memory** — that renders a single, canonical **markdown
memory vault** as an Obsidian-style knowledge base: a graph derived from `[[wikilinks]]`,
a grouped list, and a note view/editor. The NavRail slot already exists (`navrail.tsx`,
falls through to `PlaceholderSurface` today); this builds the surface behind it.

The vault is plain `.md` files on disk that **every agent runtime is pointed at**, so it
is one shared brain across heterogeneous agents rather than per-agent silos.

## Why this shape

The cockpit is runtime-agnostic — it launches and tracks `claude | codex | antigravity |
terminal`. Only Claude has rich structured memory natively; the others differ. The unifier
is therefore a **file format**, not an agent API:

- **markdown + `[[wikilinks]]` is the contract.** It is exactly what Claude's memory files
  already are, and any runtime can be configured (via its steering file) to read and append
  to the same vault.
- **No new storage.** The vault is the filesystem; frontmatter is the schema; edges are
  derived from links. This reuses the established cockpit pattern (Files / Activity / Usage
  all scan the filesystem via a wshrpc command and render).

Rejected alternatives:
- **Net-new Wave memory DB** — duplicates what agents already do on disk; forces every agent
  to learn a second memory system. (YAGNI.)
- **Read-only viewer of each agent's native memory (federation)** — a read-only patchwork
  with per-runtime format normalization and no single place to write. Loses the "one brain"
  property.

## Decisions (locked)

| Decision | Choice |
|---|---|
| What the tab is | In-cockpit Obsidian-style view over a markdown vault |
| Data model | Markdown vault. *Originally* one canonical folder; **revised to multi-root** after research (see Integration) — pending confirmation |
| Vault location | Dedicated vault for human/Claude + read-in-place Codex/agy native dirs (path TBD) |
| Editing | **Full editing day one**: view, edit, create, delete — all in-cockpit |
| Cross-agent strategy | **Goal 2: one shared brain** via a hub-and-spoke sync engine (harvest + project). Viewer is phase 1. Engine gated on a feasibility spike — see `2026-06-30-memory-sync-spike.md` |
| UI layout | **Deferred** to a frontend-design pass |

## Data model

A vault is a folder of markdown notes. Reuse the proven Claude memory note schema:

```markdown
---
name: <kebab-case-slug>          # stable id; also the wikilink target
description: <one-line summary>   # used for relevance / list subtitle
metadata:
  type: user | feedback | project | reference
---

<body markdown>
Links to related notes via [[other-note-name]].
```

- **Node** = one note (`name` is its id).
- **Edge** = a `[[name]]` reference in any note body (directed; backlinks are the reverse).
- **Type** = `metadata.type` — drives node color / list pills.
- **Grouping/clusters** = by project/scope. Source of the grouping signal is an open
  question (subfolder per project, or a frontmatter `project`/`scope` field). A
  `MEMORY.md`-style index file, if present, is optional sugar — the graph is derived from
  the files themselves, not the index.

## Views (layout deferred, content fixed)

The specific arrangement is for the design pass. The content the surface must provide:

- **Graph** — force-directed, nodes = notes, color = type, clustered by project/scope,
  edges from `[[wikilinks]]`, legend, zoom/pan. (This is the expensive half.)
- **List** — grouped by project/scope, type pills, per-group counts, search/filter.
- **Note view + editor** — rendered markdown (reuse existing markdown rendering) and a
  markdown editor (reuse `codeeditor`/monaco), with **backlinks**.
- **Header** — search, type/project filters, New note, Graph/List toggle.

## Backend (wshrpc, follows the scan pattern)

New commands (regenerate bindings via `task generate` after editing `wshrpctypes.go`):

- **List/scan vault** — enumerate notes, parse frontmatter, extract `[[links]]` → nodes +
  edges + metadata. (Analogous to the Files/Activity scans.)
- **Read note** — full body for the note view.
- **Write note / Create / Delete** — the editing path.
- **Watch vault** — `fsnotify` stream so externally-written notes (an agent appending mid-
  session) appear live. Same fsnotify pattern the live transcript already uses.

### Edit/agent write conflict handling

Agents and the human can both write the same files. Strategy:
- File-watch the vault; reload a note in the UI when it changes on disk.
- On save, **mtime check**: if the file changed since the editor opened it, surface a
  conflict warning rather than silently clobbering. (Last-write-with-mtime-guard, kept
  simple — a dedicated vault makes real conflicts rare.)

## Integration: how each runtime's memory is reached (verified 2026-06-30)

Ground truth, **spike-verified 2026-06-30** (`2026-06-30-memory-sync-spike.md`) — this
corrects the earlier desk-research assumption that all three expose markdown memory. They do
not: agy's native store is protobuf/inactive. Memory is reached **two different ways** —
projection via the steering file (hub → agent), harvest from the native store (agent → hub):

| Runtime | Native memory store | Projection channel (hub → agent) | Harvest (agent → hub) |
|---|---|---|---|
| Claude | `~/.claude/projects/<proj>/memory` — md + frontmatter + `[[links]]` | its memory instructions / vault directly (redirectable) | native (already the vault) |
| Codex | `~/.codex/memories/` — cwd-scoped md (`MEMORY.md`+`raw_memories.md`), git-baselined; `memories_1.sqlite` is just the extraction pipeline | **`~/.codex/AGENTS.md`** steering (confirm live post-quota) | **easy** — parse the markdown |
| agy | `~/.gemini/antigravity*/knowledge/` **empty/inactive**; conversations = protobuf SQLite | **`~/.gemini/GEMINI.md`** steering — **PROVEN** | **hard** — protobuf, no md output |
| terminal | — | — | — |

Why projection targets the **steering file**, not the native store: steering files are loaded
every session, human-authored so the tool's own consolidation won't clobber them, and plain
markdown. (Native-store injection was tried in the spike and rejected — agy's is inactive,
Codex's auto-consolidates.)

### Phase 1 — multi-root viewer (the read layer)

The viewer ships first and is independent of the sync engine: scan the dedicated vault +
each agent's native markdown memory (where it exists — Claude, Codex) into **one
source-tagged graph**; view and edit. agy contributes little here (empty store) but receives
shared memory via the engine below.

- **Dedicated vault** = home for human-authored notes and Claude. New cockpit notes land here.
- **Codex** = scanned read/edit in place (rich markdown). Editing writes back where the note lives.
- Caveat: `[[wikilinks]]` are a Claude convention — Codex markdown won't use them, so
  cross-source edges are sparse. The graph is still valid; it's just denser for Claude.

### Target: one shared brain across all agents (goal 2)

**Chosen direction:** true cross-agent sharing — every agent reads and writes the same
memory. The multi-root viewer is **phase 1** (the foundation), not the end state.

Architecture = **hub-and-spoke sync engine** (not peer-to-peer):

- **Hub** = the canonical vault = single source of truth.
- **Project (hub → agent): write to each agent's STEERING FILE, not its native memory
  store.** This is the spike's key correction (`2026-06-30-memory-sync-spike.md`). The hub is
  rendered into each agent's deterministically-loaded instruction file — Claude: its memory
  instructions / `CLAUDE.md`; Codex: `~/.codex/AGENTS.md`; agy: `~/.gemini/GEMINI.md`.
  Steering files win because they are loaded every session, **human-authored so the tool's
  own consolidation won't clobber them**, and plain markdown. Projections are **generated
  artifacts, never hand-edited** — regenerated on vault change + at launch — and scoped by
  cwd/project to avoid context bloat.
- **Harvest (agent → hub):** ingest each agent's auto-generated native memories into the
  vault **once**, deduped by content hash, tagged by source. Native store = an inbox.
  Feasibility is **asymmetric** (spike): Codex native memory is rich cwd-scoped markdown
  (easy to harvest); **agy's store is protobuf with no markdown output (hard)** — so agy is
  *receive-shared-memory* now, *contribute-back* deferred.

**Why it can't drift:** single source of truth (the hub) + projections are pure functions of
the hub, rebuilt from source like build output + harvest is ingest-once with content-hash
dedupe + provenance tags break echo loops (don't re-harvest what we projected).

**Feasibility — spike de-risked (2026-06-30).** The gating unknown was whether non-Claude
agents would *ingest* memory we author. **Confirmed for agy** via the `GEMINI.md` steering
channel (probe injected → agy used it in its reply). **Codex** ground-truth confirmed
(cwd-scoped markdown + `AGENTS.md`); its live-ingest test is the one open item, blocked on a
usage quota — retry via the `AGENTS.md` channel. Net: goal 2 is **feasible**; the
projection-via-native-store idea was dropped in favor of projection-via-steering-file.

- _Hard-link alternative (considered, rejected):_ hard-linking shared notes into each
  agent's native dir solves file *location* but not *ingestion* — Codex/agy loaders expect
  specific, auto-managed structures (`MEMORY.md`/`raw_memories.md`; per-KI `metadata.json`)
  and will likely ignore or overwrite injected loose markdown. Hard links are also
  files-only, same-volume-only, and hit the Windows symlink-privilege gotcha.
  **Steering-file projection is the reliable path instead** (spike-confirmed) — and it
  sidesteps the native-store clobber problem entirely.

## Open questions

1. **Vault path / config** — `~/.wave/memory`? A `wconfig` setting (`memory.vaultPath`)?
   Default + override.
2. **Grouping signal for clusters** — subfolder-per-project vs a frontmatter `project`/
   `scope` field. (Affects both the list grouping and graph clustering.)
3. **Graph rendering** — which approach/lib, given the project minimizes dependencies. The
   "costly half"; a candidate to phase if needed.
4. **Codex / Antigravity redirectability** — RESOLVED: not cleanly redirectable; scan their
   native markdown dirs in place (multi-root). See Integration.
5. **Global vs project-scoped notes** — is there a `GLOBAL`/`SHARED` cluster distinct from
   per-project, and how is it marked?

## Prior art / references

- `docs/redesign-meta-spec.md` (line ~99) — original Memory scope (Graph/List toggle, node
  types, clusters, detail rail). This design supersedes its "net-new (graph is the costly
  half)" framing by using a plain markdown vault as the store.
- NavRail slot: `frontend/app/view/agents/navrail.tsx` (`memory` item + glyph already
  present; renders `PlaceholderSurface` until this ships).
- Pattern references: `filessurface.tsx` / git RPCs (read-only scan + tree), live transcript
  `fsnotify` (live updates), `codeeditor` (markdown editor), existing markdown rendering
  (`markdownmessage.tsx`).
