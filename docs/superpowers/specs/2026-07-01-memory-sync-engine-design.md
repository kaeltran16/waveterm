# Memory sync engine — design

Date: 2026-07-01
Status: design (approved in brainstorming; pending spec review)
Builds on: `2026-06-30-memory-tab-design.md` (goal 2), `2026-06-30-memory-sync-spike.md` (feasibility), `2026-07-01-memory-tab-viewer.md` (shipped viewer)

## Summary

The **sync engine** turns the shipped Memory viewer (a read/write vault surface) into a
live **one shared brain** across the cockpit's agent runtimes. Claude Code's per-project
memory is the single source of truth (the *hub*); Codex and antigravity (`agy`) are
downstream *lackeys* that receive Claude's brain and feed their own learnings back into it.

Two flows, both automatic:

- **Projection (hub → lackeys):** Claude's active-project memory is rendered into a
  delimited region inside each lackey's global steering file, regenerated on vault change.
- **Harvest (lackeys → hub):** each lackey's native memory is parsed, deduped by content
  hash, and written back into Claude's memory as source-tagged notes.

## Topology

```
                 projection (auto, on vault change)
   Claude memory ────────────────────────────────▶  ~/.codex/AGENTS.md   (Codex)
   (HUB / SoT)   ────────────────────────────────▶  ~/.gemini/GEMINI.md  (agy)
        ▲
        │ harvest (auto, cadence + agent exit; content-hash ingest-once)
        └──────────────── Codex native md  /  agy protobuf store
```

- **Hub** = Claude Code's per-project memory. Terminal has no memory → out of scope.
- **Lackeys** = Codex, agy. Pure receivers of the shared brain; contributors via harvest.
- The hub is authoritative. Projections are generated artifacts (never hand-edited);
  harvested notes are tagged and bulk-reversible.

## Decisions (locked in brainstorming)

| Decision | Choice |
|---|---|
| Hub identity | **Claude Code's own per-project memory** is the SoT. No separate dedicated vault. |
| v1 scope | **Full loop, all runtimes** — projection + harvest for Claude/Codex/agy, phased. |
| Projection trigger | **Automatic** on hub change (fsnotify). |
| Projection scope | **Active project only**, into the **home-level global** steering files (never repo files). |
| Harvest trigger | **Automatic** (cadence + agent exit), plus a manual "Pull now" button. |
| Harvest safety | Content-hash **ingest-once**; provenance frontmatter; **bulk-reversible** by source. |
| agy harvest | **Spike-gated (Phase C)** — protobuf decode; agy is receive-only until proven. |
| Display | Readable project label everywhere; the encoded hash is backend-internal. |

## Hub location & the encoded-hash problem

Claude stores per-project memory at `~/.claude/projects/<hash>/memory/`, where `<hash>` is
the project cwd with path separators replaced by `-`
(e.g. `C:\Users\kael02\IdeaProjects\waveterm` → `C--Users-kael02-IdeaProjects-waveterm`).

- **Backend:** the engine derives `<hash>` deterministically from the active project's cwd
  to locate the hub dir. The hash is an internal filesystem key only.
- **Display:** the hash never reaches the UI. A helper `projectLabel(cwd)` returns the
  Projects-registry display name if the project is registered, else the cwd's **leaf folder
  name** (`waveterm`), with the full path as secondary/tooltip text. Used in the viewer,
  the sync strip, and the harvest preview.

## Viewer reconciliation

The shipped viewer writes new notes to a dedicated `~/.waveterm/memory` vault. Since the hub
is now Claude's memory:

- The Memory surface's **write target becomes the active project's Claude memory dir**
  (`~/.claude/projects/<hash>/memory/`). New notes, edits, and creates land there.
- Codex's native dir stays scanned **read-only as a source** (unchanged).
- `memory:vaultpath` remains only as an optional override for users who want an explicit
  vault path; the default write target is the Claude hub.

## Projection (hub → lackeys) — automatic

**Trigger.** An fsnotify watcher on the active project's hub dir (the pattern already used by
the live transcript). On any change, regenerate the projection for each lackey. Also
regenerate on cockpit project-focus change (so the global steering file reflects the project
the user — and therefore the launched lackeys — is working in).

**Target.** The home-level global steering files, never repo-tracked files:

- Codex → `~/.codex/AGENTS.md`
- agy → `~/.gemini/GEMINI.md`

**Region format.** A single delimited region is rewritten wholesale; everything outside it
(the user's own steering) is untouched:

```
<!-- ARC-MEMORY:BEGIN (generated — do not edit; managed by Arc) -->
## Shared project memory: <project label>

<active-project Claude memory rendered as facts-to-know>
<!-- ARC-MEMORY:END -->
```

**Content rules.**
- **Facts, not directives.** The spike showed Codex ignores behavioral steering ("always do
  X"); Claude's memory is already fact-shaped, so render note bodies as knowledge, not rules.
- **Active-project scope.** Only the active project's memory is projected → relevant, bounded
  size, no cross-project leak.
- **Echo rule.** A note tagged `source: X` (harvested from agent X) is **not** projected back
  to agent X. Claude-authored notes project to every lackey; a Codex-learned note projects to
  agy but not back to Codex.

**Reversibility.** The region is a pure function of the hub. Deleting the markers (or the
engine writing an empty region) fully removes the projection.

## Harvest (lackeys → hub) — automatic

**Trigger.** A cadence sweep plus on-agent-exit, per runtime. A manual **"Pull from agents"**
button in the Memory surface runs the same path on demand.

**Sources.**
- **Codex** — `~/.codex/memories/MEMORY.md` + `raw_memories.md`. Markdown, cwd-scoped,
  parseable (spike: "easy"). **Phase B.**
- **agy** — protobuf-encoded SQLite conversation store; native Knowledge store is
  empty/inactive. **Phase C, spike-gated.** agy is receive-only until the protobuf decodes.

**Ingest-once (dedup).** For each candidate fact, compute `sha256` of its normalized body. If
that hash already exists among the hub's notes, skip it. Duplicates are structurally
impossible, not merely unlikely.

**Provenance.** Each harvested fact is written as a new note in the Claude hub with
frontmatter:

```yaml
---
name: <derived-slug>
description: <first line / summary>
metadata:
  type: reference        # harvested facts default to reference
  source: codex | agy    # provenance — drives echo rule + bulk-reversibility
  source_hash: <sha256>  # dedup key
  harvested_at: <iso8601>
---
```

**Reversibility.** Because every machine-written note carries `source`, the entire harvested
set is bulk-reversible ("drop all `source: codex`"). The viewer already renders source tags,
so harvested notes are auditable/prunable after the fact rather than gatekept up front.

**Echo-breaking.** Structural: projection writes to *steering files*, harvest reads from
*native stores* — different locations, so the engine never harvests its own projection. The
residual path (an agent copying steering into its native store) is closed by the hash dedup
plus the projection echo rule above.

**Per-runtime auto gating by parse confidence.**
- Codex (well-structured markdown, low parse risk) → auto-harvest enabled in Phase B.
- agy (protobuf, uncertain) → not auto until the Phase C decode spike proves reliable
  extraction; manual/off until then.

## UI — Memory surface additions

A compact **Sync strip** on the Memory surface:

- **Projection status:** `Auto · last projected <relative time> · Codex ✓ agy ✓` (per-lackey
  current/stale indicator).
- **"Pull from agents"** button — manual harvest trigger. Runs the harvest path and reports
  how many new facts were ingested (and how many deduped/skipped).
- Harvested notes appear in the existing list/graph with their `source` tag (existing viewer
  capability) — no separate review queue (auto + reversible replaces gatekeeping).

## Backend

Follows the established scan-surface pattern; extends `pkg/memvault` or adds a sibling
`pkg/memsync`:

- **Projection watcher** — fsnotify on the active hub dir; renders + writes the steering-file
  regions. Idempotent wholesale rewrite of the delimited region only.
- **`MemoryHarvestScan`** (wshrpc) — reads lackey native stores, returns deduped candidate
  facts (source-tagged) without writing.
- **`MemoryHarvestCommit`** (wshrpc) — writes accepted candidates into the hub with
  provenance frontmatter.
- **Codex parser** — parse `MEMORY.md` / `raw_memories.md` into candidate facts.
- **agy decode (Phase C)** — protobuf schema decode for the conversation store.
- Regenerate TS/Go bindings via `task generate` after editing `wshrpctypes.go`.

Helpers:
- `projectHash(cwd)` — cwd → Claude's encoded dir name (backend-internal).
- `projectLabel(cwd)` — registry name ?? leaf folder name (display).
- `normalizeBody(md)` → `sha256` — the dedup key.

## Phasing (each phase ships working software)

- **Phase A — Projection + viewer repoint.** fsnotify projection to Codex + agy steering
  regions; viewer write target moved to the Claude hub; sync strip (projection status only).
  Delivers the shared brain *downward* to all lackeys. agy receive-only.
- **Phase B — Codex harvest (full loop).** Codex markdown parser + dedup + provenance +
  `MemoryHarvestScan`/`Commit` + auto-harvest + "Pull from agents" button. Closes the loop
  for the two markdown runtimes (Claude ↔ Codex).
- **Phase C — agy harvest.** Protobuf-decode spike; if it proves out, agy becomes a full
  participant (auto-harvest gated on the spike result). If not, agy stays receive-only — no
  loss to A/B.

## Out of scope

- Terminal memory (none exists).
- Orchestration / agent dispatch (the Concierge → Delegator track is a separate feature).
- Multi-machine / networked vault sync (single-machine, local filesystem only).
- Merge/conflict resolution beyond mtime-guard (inherited from the viewer) + hash dedup.

## Open items carried into planning

- Exact agy protobuf schema (Phase C spike output).
- Harvest cadence interval (default proposal: on agent exit + a low-frequency sweep;
  tune in the plan).
- Whether a stale-projection indicator needs the launch-time regenerate or fsnotify alone
  suffices (fsnotify is expected sufficient since steering files are read every session).
