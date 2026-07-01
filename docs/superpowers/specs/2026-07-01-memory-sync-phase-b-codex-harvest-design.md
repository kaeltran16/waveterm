# Memory sync — Phase B (Codex harvest) — design

Date: 2026-07-01
Status: design (approved in brainstorming; pending spec review)
Builds on: `2026-07-01-memory-sync-engine-design.md` (parent design, all phases)
Supersedes: the parent design's **Phase B** section and its Codex-harvest assumptions (the parent's
"Codex — easy markdown parse" claim is corrected below).

## Summary

Phase B closes the sync loop **upward**: Codex's learnings flow back into Claude's per-project
memory (the hub). Phase A delivered projection (hub → lackey steering files) and repointed note
authoring to the hub. Phase B adds **harvest** (Codex → hub) for the two markdown runtimes, so a
fact Codex learns becomes a hub note and — via Phase A projection — reaches the other lackeys.

Harvest is **passive**: it runs on agent launch and on a low-frequency background timer while the
cockpit is open. No user action is required. A manual button exists only as an optional refresh +
status readout.

## Reality correction (the spike was optimistic)

The parent design leaned on a feasibility spike that called Codex memory "easy markdown, cwd-scoped,
parseable." Inspecting the live files contradicts the "easy" framing:

- `~/.codex/memories/MEMORY.md` is **~170 KB**; `raw_memories.md` is **~274 KB**. Both are richly
  structured, not flat note files.
- `MEMORY.md` is organized as `# Task Group:` blocks, each with an `applies_to: cwd=<path>;` line,
  then `## Task N`, `## User preferences`, `## Reusable knowledge`, and `## Failures` sub-sections.
- **Every memory is cwd-tagged and spans many projects** (SIEM, ManagementPanel, waveterm, …). The
  hub is *per-project*, so harvest cannot dump the file — it must filter by cwd and extract at
  fact-granularity, or it floods the wrong project's hub.
- There is also a live `memories_1.sqlite` alongside the markdown, but the `.md` files are current
  (written same-day), so the markdown path the parent chose remains valid. SQLite is out of scope.

The parse is therefore the core of Phase B, not an afterthought.

## Decisions (locked in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Harvest unit | **Each `- ` bullet under `## Reusable knowledge`** → one hub note. | These are already atomic, durable, fact-shaped — they match the hub's "one fact per file" schema. |
| Source file | **`MEMORY.md` only** (not `raw_memories.md`). | `MEMORY.md` is Codex's *curated* layer; `raw_memories.md` is the pre-distillation dump. Using the curated file gives higher signal, pre-reduced dups, and avoids double-ingest. |
| Sections harvested | **`Reusable knowledge` only**; skip `User preferences` and `Failures`. | Those are behavioral/directive-shaped; the parent's "facts, not directives" rule excludes them. |
| Project scoping | **Per-focused-project.** Harvest keeps only bullets whose Task-Group `cwd` maps to the focused agent's project; writes into that project's hub via `HubDirForCwd(cwd)`. | Symmetric with projection (active-project only); reuses Phase A infra; predictable (facts land where you're working). |
| Triggers | **On-launch (harvest → project) + low-frequency frontend cadence (~3 min) on the focused project.** Manual button demoted to optional refresh + status. | Fully passive — no reliance on a button. Frontend-driven cadence respects per-focused-project scoping (backend has no "focus"). |
| Dedup | **Content-hash ingest-once.** `sha256` of the normalized bullet; skip if that hash already exists among the hub's notes. | Makes re-running free/idempotent, so frequent triggering is safe. |
| RPC surface | **Single `MemoryHarvestCommand(cwd) → {ingested, skipped}`.** No separate scan/preview RPC. | The parent killed the review queue ("auto + reversible replaces gatekeeping"); without a review step a scan-only RPC has no consumer (YAGNI). |
| agy harvest | **Out of scope — Phase C.** agy stays receive-only. | Protobuf decode is spike-gated; no loss to Claude ↔ Codex loop. |

## Parser design

`MEMORY.md` structure the parser targets:

```
# Task Group: <title>
scope: <when-to-use prose>
applies_to: cwd=<PROJECT PATH>; reuse_rule=<...>

## Task 1: <...>, outcome success
### rollout_summary_files
### keywords

## User preferences          <- skipped
- ...

## Reusable knowledge        <- HARVESTED
- <fact bullet> [Task 1][Task 2]
- <fact bullet>

## Failures and how to do differently   <- skipped
```

Algorithm (pure, unit-tested):

1. Split the file into `# Task Group:` blocks (top-level `#` headings).
2. For each block, read the `applies_to:` line and extract `cwd=<path>` (value between `cwd=` and
   the next `;`). A block with no parseable cwd is skipped (can't be routed).
3. **cwd match:** normalize both the block's cwd and the target project's cwd, then compare equal.
   Normalization: strip a leading `\\?\` Windows long-path prefix, unify `\`→`/`, drop a trailing
   separator, case-fold. (Codex records some cwds as `\\?\C:\Users\...`.)
4. In matching blocks, find the `## Reusable knowledge` section and collect its `- ` bullets up to
   the next `##` heading.
5. **Clean each bullet:** trim, and strip trailing `[Task N]…` back-reference markers (meaningless
   outside Codex).
6. Emit each cleaned bullet as a candidate fact.

The parser reads `MEMORY.md`; scoping is applied by the cwd filter. Only matching-cwd blocks yield
candidates, so a harvest for project X never pulls project Y's facts.

## Project scoping & routing

The harvest target is `HubDirForCwd(focusedCwd)` (the Phase A helper). The candidate cwd filter uses
the *focused project's* cwd — the same `focusedCwd` the Memory surface already resolves (Phase A,
Task 9). Backend `MemoryHarvestCommit` receives that cwd and does: parse `MEMORY.md` → filter to
cwd → extract bullets → dedup → write to `HubDirForCwd(cwd)`.

Global fan-out (route every distinct cwd's bullets to its own hub in one sweep) is a clean future
enhancement — the same per-project function in a loop — and is intentionally **not** built now.

## Triggers (passive)

**On launch (primary).** Extend Phase A's launch hook. Ordering becomes **harvest → project**:

```
launchAgent(codex|antigravity):
  await MemoryHarvestCommand({cwd})   // pull Codex's latest facts into the hub
  await MemoryProjectCommand({cwd})  // then project the (now-updated) hub outward
```

Harvesting before projecting means freshly-harvested Codex facts also flow *outward* to the other
lackeys in the same launch — the loop refreshes both directions at the one moment it matters (right
before an agent boots and reads its steering). The two calls are **chained** (harvest must finish
before projection so the projection reflects the just-harvested facts), but the whole chain runs
inside **one fire-and-forget wrapper** so it never blocks the launch; a harvest failure must not
prevent projection or the launch (each step is independently `.catch`-guarded).

**Background cadence (~3 min).** While the cockpit is open with an agent focused, a frontend timer
calls `MemoryHarvestCommit({cwd: focusedCwd})` every ~3 minutes. This catches learnings from a
long-running Codex agent without any user action.

- **mtime guard:** the backend stats `MEMORY.md` and skips the parse entirely when its mtime is
  unchanged since the last harvest for that project. Codex rewrites the file rarely (on session
  summarization), so most ticks short-circuit at the stat. This is what makes a frequent timer cheap.
- The timer lives frontend-side (it needs `focusedCwd`, a frontend concept), consistent with the
  sync-strip refresh pattern. Interval is a single tunable constant.

**Manual button (optional).** "Pull from agents" on the Memory surface runs the same RPC for the
focused project and displays the returned `{ingested, skipped}`. Nothing depends on it.

## Dedup, provenance & the parseNote source fix

**Note shape** written into the hub per harvested bullet:

```yaml
---
name: <slug of the bullet's first ~8 words>-<short hash>   # readable + collision-proof filename
description: <the bullet text, first line>
metadata:
  type: reference          # harvested facts default to reference
  source: codex            # provenance — drives echo rule + bulk-reversibility
  source_hash: <sha256 of the normalized bullet>   # dedup key
  harvested_at: <iso8601>
---

<the bullet text as the note body>
```

**Dedup (ingest-once).** Before writing, the harvester scans the hub dir and collects existing
notes' `source_hash` values. A candidate whose `sha256` is already present is skipped (counted in
`skipped`). New candidates are written (counted in `ingested`). Duplicates are structurally
impossible, not merely unlikely.

**Must-fix seam — `parseNote` source/hash override.** Phase A's echo rule (`renderFacts` excludes
notes where `Note.Source == targetRuntime`) cannot currently fire, and the dedup above cannot read
existing hashes, because `parseNote` sets `Source` from the *root tag* ("claude" for everything in
the hub) and never reads frontmatter. Phase B must:

- Extend the `frontmatter` struct with `metadata.source` and `metadata.source_hash`.
- In `parseNote`, when frontmatter carries a `source`, let it **override** the root-derived source;
  surface `source_hash` on the `Note` (a new field) so the dedup scan can read it.

This is the seam that connects Phase A and B: it makes the echo rule bite (a `source: codex` hub
note won't project back to Codex) **and** gives the dedup its existing-hash set. It is not optional.

## Reversibility

Every harvested note carries `source: codex`, so the entire harvested set is bulk-reversible
("delete all `source: codex`"). The viewer already renders source tags, so harvested notes are
auditable/prunable after the fact. Echo-breaking is structural (harvest reads Codex's native store;
projection writes steering files — different locations) plus the hash dedup and the projection echo
rule.

## UI — Memory surface

Extend the Phase A sync strip:

- **Harvest status:** last-harvest relative time + the last `{ingested, skipped}` for the focused
  project (e.g. `Codex · pulled 3 new, 12 known · 2m ago`).
- **"Pull from agents"** button — optional manual trigger (same RPC), disabled when nothing is
  focused (like Phase A's "Project now").
- Harvested notes appear in the existing list/graph with their `codex` source tag — no separate
  review queue.

## Backend

Extends `pkg/memvault` (sibling to Phase A's `projection.go`):

- **`harvest.go`** — Codex `MEMORY.md` parser (pure), cwd matcher (pure), `sha256` dedup key,
  candidate → hub-note writer, existing-hash scanner, mtime guard, `Harvest(cwd) → {ingested, skipped}`.
- **`memvault.go`** — extend `frontmatter` + `Note` + `parseNote` for `source`/`source_hash` override.
- **`wshrpctypes.go`** — `MemoryHarvestCommand(ctx, CommandMemoryHarvestData{Cwd}) (*CommandMemoryHarvestRtnData, error)`
  with `{Ingested int, Skipped int}`. Regenerate bindings via `task generate`.
- **`wshserver.go`** — implement the handler (delegates to `memvault.Harvest`).

Helpers reused from Phase A: `HubDirForCwd(cwd)`, `projectHash(cwd)`. New pure helpers:
`parseCodexReusable(md, targetCwd) []string`, `normalizeCwd(path) string`, `harvestSlug(bullet) string`.

## Out of scope

- **agy harvest** — Phase C (protobuf decode, spike-gated). agy stays receive-only.
- **`raw_memories.md` / `memories_*.sqlite`** — not parsed; `MEMORY.md` is the curated source.
- **Global multi-project fan-out** — future; v1 is focused-project only.
- **Review queue / gatekeeping** — replaced by auto + hash-dedup + bulk-reversibility.
- **`User preferences` / `Failures` harvest** — directive-shaped; excluded by "facts, not directives".

## Open items carried into planning

- Exact cadence interval constant (proposal: ~3 min; tunable).
- Slug-length / hash-suffix length for `harvestSlug` (readability vs collision) — settle in the plan.
- Where the frontend cadence timer is hosted (Memory model vs cockpit-level) — mirror the existing
  sync-strip refresh location.
- Whether the mtime guard is keyed per-project (last-harvest mtime per cwd) or a single global
  last-parse mtime — per-project is more correct; confirm during implementation.
