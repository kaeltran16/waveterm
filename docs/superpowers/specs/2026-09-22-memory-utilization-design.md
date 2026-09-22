# Memory system: make utilization measurable, stop the leaks

**Effort:** `effort:8ebb62f7-ff00-42dd-bc6d-834b0f9fffe1`
**Date:** 2026-09-22

The memory system has never been able to tell whether a note was used. Decay archives notes on a
signal nothing can fire, the export path strands facts where no session reads them, and the only
measurement of what memory costs per session is a line count that does not track bytes. This spec
covers the eight open chunks of the effort; chunk 9 (demote the memory graph) is declined.

## The measured problem

Ground truth as of 2026-09-22, read from the live vault
(`~/IdeaProjects/obsidian_vault/memory`, a clean git repo at `5e5105e`) and
`~/.waveterm/memory-archive`:

| Fact | Number |
|---|---|
| Notes in the vault | 873 |
| Notes carrying `last_referenced` | 23 (2.6%) |
| Machine-sourced (`claude` 264 / `codex` 86 / `agent` 17) | 367 |
| Notes carrying `captured_at` | 17 |
| Archived notes | 139 |
| …of those, `archived_reason: decay` | 67 (40 in 2026-08, 27 in 2026-09) |
| …of those 67, carrying a `last_referenced` stamp | **0** |

The effort tracker recorded the decay leak as "latent so far: the memory archive is empty." It is
not latent. Every one of the 67 decay archives fired on the never-referenced branch of the
predicate — the branch that can only be true because nothing stamps vault-only notes. The archive
is a record of a bug, not of a decision.

`memgarden/decay.go:50` sets `neverReferenced` from `LastReferenced == ""`, and the only writer of
that field is `RecordRecall`, which parses Claude memory-tool recall reminders out of a finished
transcript. Those reminders name hub notes. A note that lives only in the vault — which is 850 of
873 — can never be named by one, so it reads as never-referenced forever and, once older than
`staleDays`, becomes archive-eligible if it is machine-sourced.

The second measured problem is reach. `exportToHub` skips every note whose `Source` is `claude`
(the echo rule), so a fact harvested from project A's hub is withheld from project B's session even
though B has never seen it. The `shared/` dir those exports land in is not read by Claude's memory
tool, which is sandboxed to `memory/`; the only pointers into it are the hub's `MEMORY.md` links (3
of 18 shared notes, from the 2026-09-08 repair) and the injected manifest, whose "Read the full body
of any fact from…" retrieval path **0 of 440 transcripts ever used**. 16 of the manifest's 18 lines
are truncated at a 200-character cap, discarding 3,833 bytes the unused path was meant to recover.

The third is cost. Session-start injection runs ~5,600–6,400 tokens. `MEMORY.md` is 17,556 bytes of
it (78%) and the manifest 5,010. The governing rule is "keep MEMORY.md under ~200 lines"; at 95
lines and ~185 bytes per line, a line budget does not constrain the real cost.

## Principles

- **Absence of a measurement is not evidence of disuse.** No predicate may archive on a signal that
  could not have fired.
- **One source of truth.** Utilization lives in the note's own frontmatter, where the gardener
  already reads it, Obsidian already shows it, and a copied note carries its own history. No second
  store to reconcile.
- **Reversibility over caution.** The vault is git-backed and the archive is a move, not a delete.
  Every data operation here is revertable; that is what licenses doing them automatically.
- **Durable rule over one-off cleanup** where the condition recurs. Throwaway-worktree hubs will
  keep appearing, so the fix is a gardener pillar, not a script run once.

## Slice 1 — The signal

*Chunk 10. No dependencies.*

`memvault.Note` gains `ReferenceCount int` bound from `metadata.reference_count`.

`TouchReferenced` (`learn.go:86`) increments that count alongside the `last_referenced` timestamp,
and **restores the file's original mtime after writing**. Without that, every recall bumps
`UpdatedTs`, which is the Memory list's sort key and decay's fallback age basis — a note would
appear to have been *edited* every time it was *read*. Preserving mtime keeps `UpdatedTs` meaning
"content last changed." The frontmatter change is still a real content change and still shows up in
the vault's git history; only the mtime is held.

Jarvis recall becomes the second writer. `pkg/jarvisrecall` builds grounding cards whose
`NavTarget` is `memnote:<id>` for memory-sourced candidates (`cards.go:146`). At the two points
where cards become an answer — `Ask` (`ask.go:165`) and the conversation path's emit in
`recall.go` — every memory card's note is stamped through a new
`memvault.TouchReferencedByID(ids []string, ts string)`.

Utilization is defined as **surfaced as grounding**, not as cited in prose. Grounding membership is
deterministic and already computed; parsing `[n]` citations out of model prose would make the
measurement depend on the model's formatting.

**The epoch.** `<wavedata>/memory-recall-epoch.txt` records, once, the first boot that ran with
instrumentation — the same pattern as `memroots.lastRootFile()`. It is written by the memory sweep
at boot, not by the first stamp, so it exists even if nothing is ever recalled. Absent, empty or
unparseable is read as *now*, which makes the epoch fail safe: an unreadable epoch can never
authorize an archive.

**Tests:** `TouchReferenced` increments from absent and from a present count, and leaves mtime
unchanged; `TouchReferencedByID` no-ops on an unknown id; the epoch file writes once and is not
overwritten on a later boot; a malformed epoch parses as zero.

## Slice 2 — Decay, and the 67

*Chunk 2. Depends on slice 1 (the epoch).*

`classifyDecay` takes the epoch and replaces the unfirable branch:

```go
signalMature := !epoch.IsZero() && epoch.Before(cutoff)
stamped := n.LastReferenced != ""
unusedByRecall := (stamped && beforeCutoff(n.LastReferenced, cutoff)) ||
                  (!stamped && signalMature)
```

A machine note that is never-referenced under an immature signal no longer archives — it takes the
`stale` flag into the cleanup queue, the same treatment human notes get, so the gardener stays
useful today without removing anything. Once the epoch is older than `now - staleDays`, a note that
has been observable for a full window and was still never surfaced is genuinely unused, and
never-referenced becomes firable evidence again. Human notes are unchanged: flagged, never archived.

On today's data the immediate effect is that archive-eligibility drops to zero and stays there until
2026-10-22.

**The 67 restore.** A one-shot, idempotent migration guarded by a marker in the wave data dir:
`ListArchived()` filtered to `Reason == "decay"`, each passed to the existing `Restore(path)`, which
already strips `archived_at` / `archived_reason` / `archived_from` and removes the archive file. Slug
collisions skip rather than overwrite. Restoring also removes those bodies from `archivedHashes()`,
which is correct — the harvest dedup should no longer treat them as deliberately removed.

**Tests:** table cases across the epoch boundary (no epoch, epoch newer than cutoff, epoch older
than cutoff) crossed with stamped/unstamped and machine/human, asserting archive vs flag vs nothing;
the restore is idempotent and skips a slug that already exists in the vault.

## Slice 3 — Reach

*Chunks 7 and 6. No dependencies.*

**The echo rule becomes scope-aware.** A harvested claude note already records its origin project in
`Scope` (`HarvestClaudeHubs` sets it from the hub dir when frontmatter carries none), so no new field
is needed. `exportToHub` takes the project's scope aliases — `vaultNotesForProject` already computes
`label`, `leaf` and `hubLabel` — and skips a claude-sourced note only when its scope is one of them.
A claude fact scoped to another project, or to `shared`, now exports.

**The index carries the pointer.** Exporting a note into `shared/` also upserts its line into the
hub's `MEMORY.md`, inside a delimited `<!-- ARC-SHARED:BEGIN -->` / `<!-- ARC-SHARED:END -->` region
so the memory tool's hand-maintained entries outside it are never touched. This is the same
machinery `repointIndexLinks` (`migrate_hub.go:64`) already uses to keep that file honest across a
move, and it is what makes the manifest redundant: `MEMORY.md` is injected every session, so a link
in it reaches the session that the `shared/` file alone never did.

**The manifest is deleted.** `RenderManifest` and `renderManifestFrom` (`projection.go:69-99`),
`MemoryProjectManifestCommand` (RPC type + server impl + generated client), and the `--inject` branch
of `wsh agent-memory-project` all go, along with `descriptionMaxLen` if nothing else uses it and the
`sessionStartPayload` helper. The hook keeps its non-inject projection behavior. `task generate` runs
after the RPC removal. Saves ~1,300 tokens per session.

**Tests:** a claude note scoped to another project exports while one scoped to this project does not;
the `MEMORY.md` region upsert is idempotent across two runs, preserves content outside the markers,
and creates the region when absent; `agent-memory-project --inject` emits nothing.

## Slice 4 — De-fragmentation

*Chunk 4. No dependencies.*

**Double-dash hubs.** Seven hubs exist under a doubled-separator encoding
(`C---Users--kael02--IdeaProjects--waveterm`), produced when a cwd reached Claude Code with escaped
separators. They hold only `memory/` — no transcripts — and Claude's recall sees whichever encoding
the session's own cwd produces, so the notes in the other one are invisible to it. The
`cyber_assistant` project is split 53 / 9 across the two forms.

Canonicalization halves each run of dashes in the dir name (a run of *k* becomes *ceil(k/2)*, so
`---` → `--` and `--` → `-`, while a single dash from a real folder name is preserved) and **merges
only when the halved sibling already exists on disk**. Existence is the proof; nothing is inferred
from the string alone. The merge folds notes by body hash into the canonical hub, folds the
doubled hub's `MEMORY.md` entries into the canonical index, and removes the emptied hub.

**Dead hubs.** A new gardener pillar `pruneDeadHubs` folds and removes any hub where both hold: the
hub's repo path no longer exists on disk, and every note body in it is vault-backed (reusing
`vaultBackedHashes`, which counts the archive as backing). Both conditions are required. This clears
the 8 single-note `C--tmp-mp-reg-*` hubs left by throwaway worktrees today and handles every future
one without another cleanup pass. Only the `memory/` subtree is removed; anything else under the
project dir is left alone.

**Tests:** dash-run halving over the real encodings and over a folder name containing a literal
dash; a doubled hub with no canonical sibling is left untouched; the dead-hub guard refuses a hub
whose path still exists, and refuses one holding a note with no vault backing.

## Slice 5 — Measurement and budget

*Chunks 5 and 8. No dependencies.*

**`MemoryStatsCommand` RPC + `wsh memory stats`** is where "measurable" lands. It reports the
utilization numbers and the injection cost in the same place, because the point of the effort is
that those two are one question:

```
Vault  C:\Users\kael02\IdeaProjects\obsidian_vault\memory
Notes              873   machine 367   human 506
Referenced          23 (2.6%)   in last 30d 11
Never referenced   850   archive-eligible 0 (epoch 2026-09-22, matures 2026-10-22)
Injection/session
  MEMORY.md (waveterm)   17,556 B   ~4,400 tok   budget 12,000 B   OVER by 5,556
  shared manifest             0 B   (removed)
  total                  17,556 B   ~4,400 tok
```

Token estimates are bytes/4 and are labelled as estimates.

**The budget becomes bytes.** The memory note `memory-index-maintenance-keep-memory-md-under-200-lines`
is rewritten around a 12,000-byte (~3,000-token) per-hub index budget, superseding the line rule.
The budget is advisory by construction — Claude's memory tool owns `MEMORY.md` and Arc does not
rewrite its entries — so the deliverable is that the number is *visible and checkable*, which it has
never been. `wsh memory stats` is the check.

**Records tab removed.** `vaultrecords.tsx`, `vaultrecordsmodel.ts` and `vaultrecordsmodel.test.ts`
are deleted, along with every `records` branch in `vaultsurface.tsx` (the tab-label, load-trigger and
render conditionals, plus the `tab !== "records"` rail suppression) and the tab entry in the vault
tab store. Dossiers stay reachable through the Brief peek, which the file's own header already names
as the only writer.

**Tests:** stats counts are computed by a pure function over a fixture note set, covering the
stamped / unstamped and machine / human splits; the budget comparison reports over and under; the
frontend typecheck and the `surface-smoke` CDP scenario cover the tab removal (there are
deliberately no jsdom render tests).

## Slice 6 — Merge residue

*Chunk 3. No dependencies.*

The 2026-09-22 dev→prod vault consolidation (chunk 1) left three artifacts. All three are one-off
data corrections on a git-clean vault, not recurring conditions, so they are scripted operations
with a `git diff --stat` shown before the commit — not migrations that run forever.

**70 drifted notes.** 70 slugs exist in both `~/.waveterm/vault/memory` (the retired dev root, 350
notes) and the vault (873) with different bodies. Prod is authoritative by decision. Each dev
variant is moved into `~/.waveterm/memory-archive` stamped `archived_reason: merge-drift` via the
existing `Archive` path, so every one stays diffable and restorable; nothing is deleted and no note
body is judged.

**Steering divergence.** The retired root's `steering/AGENTS.md` (5,835 B) is a superset of the
vault's (4,779 B): it carries a "From Claude Code" tail line and a "From Pi" block the vault copy
lacks, and orders one bullet differently. The two extra sections are merged into the vault copy; the
ordering difference is ignored. This is a single file and is reviewed by hand before writing.

**Decisions nesting.** `<vault>/decisions/decisions/` holds 4 files from a `cp -r` into an existing
target. `wavevault` resolves `CollDecisions` under the vault root, so the nesting is a copy artifact
and not a code bug — the four files move up one level and the empty dir is removed.

**Verification:** note counts before and after, `git status` clean at the start, and the resulting
`git diff --stat` reviewed against the expected file counts (70 removals from the retired root, 4
moves, 1 edit) before the vault commit.

## Chunk 9 — declined

The memory graph (`memgraph.tsx`, `memgraphlayout.ts`, `react-force-graph-2d`) stays as it is. The
chunk is marked declined on the tracker rather than left pending.

## Out of scope

- Any second store for utilization (a `db_memref` event table was considered and rejected: two
  writers on one fact, and a note copied out of the vault would lose its history).
- Citation-level attribution of which grounding card the model actually used.
- Rewriting the memory tool's own `MEMORY.md` entries. Arc writes only inside its delimited region.
- The dev-vs-prod vault split (chunk 1, done 2026-09-22) and the graph (chunk 9, declined).

## Risks

| Risk | Mitigation |
|---|---|
| Stamping rewrites note files on every recall, churning the vault's git history | mtime preserved; one frontmatter line changes; the vault is a personal git repo where that history is the audit trail |
| Arc's `MEMORY.md` region conflicts with the memory tool's own edits | Delimited region, upsert-only, content outside untouched — the same contract `repointIndexLinks` already honors |
| `pruneDeadHubs` removes a hub whose notes are not really backed | Two independent guards (path gone **and** every body vault-backed); only `memory/` is removed; the vault copy is the surviving record |
| The 70-note drift resolution picks the wrong copy | Prod authoritative by decision; every dev variant is archived as `merge-drift`, not deleted, and the vault is git-clean before the operation |
