# Memory Relevance Gardener — design

2026-07-20. User question: "how does the memory tab work — does Claude actually use it?" →
established that the Claude hub (`~/.claude/projects/<hash>/memory/`) *is* Claude's native memory and
everything landed there is loaded next session → the real failure mode at scale isn't context
overflow (the index is ~2.5K tokens at 59 notes) but **recall relevance degrading as stale entries
accumulate** → brainstormed into a background "gardener" that keeps the hub relevant.

## Problem

The applied-learning loop (`2026-07-10-memory-applied-learning-design.md`) closed capture and gave
pruning two signals — `superseded` (strong) and `stale` (weak) — but relevance still rots, for four
reasons the current design cannot reach:

- **Never-referenced notes are immortal.** `classifyPrune` deliberately leaves notes with no
  `last_referenced` alone (`prune.go:25`). The notes most likely to be irrelevant — written once,
  never used again — are exactly the ones the pruner is blind to.
- **The one usage signal is a post-hoc guess.** `last_referenced` is written in exactly one place:
  the batch distiller's `references` output (`learn.go:135`), an LLM looking at a transcript *after
  the fact* and guessing which memories the session relied on. There is no ground-truth recall data.
- **No content-drift detection.** A memory naming a deleted file, renamed symbol, or removed flag
  stays forever, even though it's now wrong (the memory schema itself warns readers to "verify it
  still exists").
- **Curation is 100% human-gated, so it doesn't keep up.** Everything routes to the cleanup queue;
  if the human doesn't work the queue, nothing improves — which is the accumulation the user is
  worried about.

The gardener is one coherent loop with three pillars — **decay**, **freshness**, **dedup** — that
act *automatically but reversibly*, so relevance is maintained without depending on the human draining
a queue.

## Non-goals (YAGNI)

- **No new scheduler.** Reuse `memdistill`'s coordinator sweep; do not build a parallel timer.
- **No hard delete.** Every removal is an *archive* (recoverable), not a `DeleteNote`.
- **No retrieval/recall-precision changes.** *Which* memories Claude Code injects is the harness's
  job, not this repo's. The gardener controls *what's in the hub*, not the injection algorithm.
- **Human-authored notes are never auto-decayed.** Disuse archives machine-written notes only;
  hand-written notes are flag-only (mirrors the existing `prune.go:25` restraint, extended to auto).
- **Claude hub only for v1 decay.** Real recall telemetry exists only for Claude sessions
  (`~/.claude` transcripts). Codex/Gemini memory has no equivalent signal — out of scope.
- **No embeddings dependency.** Dedup uses hashes + a cheap LLM cluster pass, not a vector index.

## Design

### 1. Architecture — where it lives (Approach A)

Two seams on existing infrastructure, no new scheduler:

- **Signal capture** rides the **SessionEnd path**. When `agent-memory-hook` fires
  (`MemoryEnqueueSession`, `wshcmd-agent-memory-hook.go`), a new step parses the finished transcript
  for recall events (§2) and `TouchReferenced`s each recalled slug — *real* `last_referenced`.
- **Gardener actions** ride the coordinator's existing **hourly sweep** (`coordinator.go`), per
  project, reusing its single-flight `inflight` guard.

New code: `pkg/memgarden/` (`decay.go`, `freshness.go`, `dedup.go`, `gardener.go`) +
`pkg/memvault/archive.go` (the archive primitive) + `pkg/memvault/recall.go` (transcript recall
parsing). The sweep is started next to `memdistill.Start(...)` in `main-server.go`.

### 2. Real recall telemetry — the decisive signal

Recalled memories appear in transcripts as `<system-reminder>This memory is N days old…` blocks
carrying the note's full frontmatter, including `name: <slug>`. `recall.go` parses these into the set
of slugs actually injected in a session — ground truth, not the distiller's post-hoc `references`
guess. On SessionEnd, `TouchReferenced(hub, recalledSlugs, now)` records real usage — authoritative over,
and superseding, the distiller's `references` guess as the source of `last_referenced`. This is what
makes decay trustworthy: a note in the index that never appears in any recall block over N days is
*provably* unused.

### 3. The archive primitive (the core)

Archiving = **move** the note out of the Claude hub into `~/.waveterm/memory-archive/` (a sibling of
the vault and pending dirs, **not** a scan root — same pattern as `PendingDir()`, `review.go:31`),
stamped `archived_at` + `archived_reason`, keeping `source_hash`. Three consequences fall out:

- Leaves the hub → Claude stops recalling it, `ScanVault` stops surfacing it.
- Its `source_hash` **joins the distiller's dedup set** (`existingHashes`, `harvest.go`) so the
  distiller won't re-learn what was archived. **This is the load-bearing link** — without it the
  gardener and distiller fight each other.
- **Undo** = `Restore` moves it back to the hub.

Guards: a **per-pass cap** on auto-archives (a large refactor spreads recheck across sweeps rather
than archiving hundreds at once) and a **visible action log** of every auto-action.

### 4. The three pillars

| Pillar | Signal | Auto-archive (high confidence) | Flag-only → cleanup queue |
|---|---|---|---|
| **Decay** | Real recall (§2) + age | Machine-authored (`source: agent`/`codex`), zero recalls in N days, capture age > N days | Human-authored notes, ever |
| **Freshness** | Deterministic + LLM | Names a file/path/symbol (via `[[links]]`/refs) now absent from the repo | LLM soft-drift (advice contradicts current code) → queue, never auto |
| **Dedup** | LLM cluster | — (write-time `existingHashes` already blocks exact-hash dups) | Near-dup cluster (LLM) → merge suggestion → queue |

`N` defaults to `StaleDays` (30), configurable. The deterministic halves (recall math, dead-ref
existence checks) carry every auto-archive; the LLM is only ever a *soft* signal routed to the human
queue. This closes the never-referenced-immortal leak via the age gate while respecting hand-written
notes. Dedup is flag-only because exact-content dups are already prevented at write time
(`existingHashes`, `harvest.go`) — the LLM only surfaces *semantic* near-dups written at different
times, which are too judgment-heavy to auto-merge.

### 5. Automation posture — auto with archive/undo

The gardener acts on high-confidence deterministic signals automatically, because reversibility (the
archive) is the safety net rather than a human gate. Judgment calls (soft drift, near-dup merges) stay
human-gated. Machine-authored notes can be auto-decayed; human-authored notes are flag-only for decay.
This is a deliberate departure from the fully human-gated status quo, justified by the archive being
non-destructive and per-pass-capped.

### 6. Cost guards

- **Model:** `claude-haiku-4-5` default, `claude-sonnet-5` escalation on large corpus — mirrors the
  distiller (`distill.go:28-31,85`), keeping the memory subsystem on one model convention.
- **mtime-change-gating:** the LLM pillars run only on notes whose referenced files changed since the
  last sweep (same mtime-guard idea as `Harvest`, `harvest.go:224`). Steady-state ≈ 0 tokens; a full
  rescan is a one-time ~80K tokens (≈ half one distill batch), spread by the per-pass cap.
- The deterministic pillars (decay, dead-ref) cost **0 tokens** and can run every sweep.

### 7. Error handling

Fail-safe throughout, matching the existing hooks: recall parsing and the sweep are off the agent hot
path and never break a turn. Archive is reversible by construction. LLM/parse failures retain state
and retry next sweep. Single-flight per project (reuse `coordinator.go`'s `inflight`). Every
auto-action is logged; nothing is silently destroyed.

### 8. UI — Memory surface

- **Archived view:** a filter/section in the Memory tab listing archived notes with reason + one-click
  **Restore**. This is the reversibility surface.
- **Flagged items** (soft drift, near-dup) reuse the **existing cleanup queue** (`cleanupqueue.tsx`,
  `prune.go` reasons) — the gardener just adds `drift` / `duplicate` reasons alongside
  `superseded` / `stale`. No new tray.

### 9. Data-model + RPC surface

- New frontmatter on archived notes: `archived_at` (RFC3339), `archived_reason`
  (`decay`|`drift`|`duplicate`). Parsed via the existing `setMetadataField` / frontmatter machinery.
- New RPCs (typed in `wshrpctypes_memory.go`, TS via `task generate`): `MemoryArchiveList` (archived
  notes for the view), `MemoryRestore` (archive → hub). Auto-archive and recall extraction are
  internal (server-side sweep + hook), not client-invoked.

## Seams reused (no new infrastructure)

| Need | Existing seam |
|---|---|
| Per-project periodic trigger + single-flight | `memdistill/coordinator.go` sweep + `inflight` |
| SessionEnd transcript access | `wshcmd-agent-memory-hook.go` / `MemoryEnqueueSession` |
| Record usage on a note | `TouchReferenced` (`learn.go`) |
| Re-learn suppression after archive | `existingHashes` / `source_hash` (`harvest.go`) |
| Hub dir for a cwd | `HubDirForCwd` (`projection.go`) |
| Non-scanned sibling dir pattern | `PendingDir()` (`review.go`) |
| Flagged-candidate UI | Cleanup queue (`cleanupqueue.tsx`, `prune.go`) |
| Model selection convention | `haikuModel` / `sonnetModel` (`distill.go`) |

## Open questions resolved during design

- **Better decay signal feasible?** Verified in transcripts: recall injections carry the note slug
  (`This memory is N days old…` + frontmatter), so real recall telemetry is buildable — decay rests on
  provable usage, not an LLM guess (§2).
- **Automation vs. human-gated.** Chose auto-with-archive: reversibility replaces the human gate for
  high-confidence signals, since a fully human-gated loop is the very thing that fails to keep up.
- **Freshness risk.** Split deterministic (auto) from LLM soft-drift (flag-only) so no note is
  auto-archived on a fuzzy judgment.

## Scope

One coherent spec, one implementation plan. The three pillars share the archive primitive, the sweep
trigger, and the recall-telemetry signal, so they are not separable without duplicating that
infrastructure. Recall extraction (§2) and the archive primitive (§3) are the foundation both
freshness and dedup build on, so they land first within the plan.
