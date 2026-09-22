# Memory utilization run report — dag 93cd75bc

**Effort:** `effort:8ebb62f7-ff00-42dd-bc6d-834b0f9fffe1`
**Spec:** `docs/superpowers/specs/2026-09-22-memory-utilization-design.md`
**Plan:** `docs/superpowers/plans/2026-09-22-memory-utilization.md`
**Run:** 8 tasks, 8 lanes, 0 failures, 35m42s elapsed / 1h36m of worker time, 7 commits.

## Landed

| Task | Chunk | Commit | What shipped |
|---|---|---|---|
| 1 | — | `151aaab` | `Note.ReferenceCount`, mtime-preserving `stampReference`, `TouchReferencedByID`, `EnsureRecallEpoch`/`RecallEpoch`, `ArchiveDir` as a var. Carries the spec and plan. |
| 2 | 10 | `15bd508` | Jarvis recall stamps the memory notes an answer was grounded in; `buildCards` stays pure behind a `stampReferences` seam. |
| 3 | 2 | `ceab843` | `classifyDecay` is epoch-aware; never-referenced machine notes are flagged, not archived, until the signal matures. `RestoreDecayArchive` boot migration. |
| 4 | 7, 6 | `a59c845` | Echo rule is scope-aware per hub; exporting upserts the note's line into the hub's `MEMORY.md` inside an `ARC-SHARED` region; manifest deleted (~1,300 tokens/session). |
| 5 | 4 | `24b4acb` | `CanonicalHubHash`, `MergeDoubledHubs`, `PruneDeadHubs`, registered as gardener pillars. |
| 6 | 5 | `2d14e0f` | `wsh memory stats`; the 12,000-byte index budget replaces the 200-line rule. |
| 7 | 8 | `70c6d4e` | Records tab deleted; records route to the Brief peek; the peek's dead "Open in Vault" button removed; copy repointed. |
| 8 | 3 | *(no repo commit — vault data only)* | Pre-merge vault root retired: `~/.waveterm/vault/memory` is now empty, the live vault holds 875 notes. 70 merge-drift variants archived. Steering doc merged. |

## Verified

- Go suites green: `memvault`, `memgarden`, `memroots`, `jarvisrecall`, `wshrpc`, `wshrpc/wshserver`, `cmd/wsh/cmd`.
- `npx vitest run`: 258 files, 3334 tests passed, 1 file / 2 tests skipped.
- `go vet` clean over the four memory packages. Working tree clean.
- Spec and plan folded into `151aaab` rather than a docs-only commit.
- Manifest symbols gone from source; `vaultrecords.tsx` deleted; `wsh memory stats` wired; boot wiring present at `main-server.go:642-643` and `gardener.go:81,377-378`.

## Questions answered (4 delivered, 1 engine-forwarded, 1 self-resolved)

- **t-7, peek copy.** Repoint now. Verified `detail.decisions` still renders in `taskdetail.tsx:123`, so only the pointer was stale. Supplied exact copy so the worker was not inventing product prose. It also checked the two out-of-scope `Records` strings and correctly left both (a Subjects group name, and the briefing's Records leg).
- **t-4, SessionStart hook.** Keep it projecting — the spec already decided this ("The hook keeps its non-inject projection behavior"). `cockpit-actions.ts:86` gates the FE path on `runtime === "codex"`, so the hook is Claude's only automatic trigger; dropping it would have left the shared index permanently stale for claude-only projects. Kept `--inject` as an ignored no-op so a stale `settings.json` cannot hard-error a session start.
- **t-8, `archived_from`.** Write the live vault path. `archived_from` is the *restore destination* (`archive.go:86-98`), not provenance. Also corrected a tilde path in the plan that `os.MkdirAll` would have taken literally.
- **t-8, steering merge.** Ask was withdrawn before the answer landed; the worker decided it itself and got the important part right (no simplify gate, From Pi 1-3, the M/A/D bullet appended). See open issue 1 for the one-line gap.

## Fixed after the run

**34 archives still pointed `archived_from` at the retired root** — the extension to the t-8 answer was not applied. 30 of those 34 are `archived_reason: decay`, i.e. 30 of the exact 67 notes `RestoreDecayArchive` gives back. Because that migration is marker-guarded it runs **once**: it would have written 30 notes into an emptied, unscanned directory and then marked itself done, spending the one-shot repair. Repointed all 34 at the live memory root; backup at `~/.waveterm/backup-archived-from-20260922T130055`. Verified 0 remain.

## Needs a live check (nothing below has actually run yet)

`dist/bin/wavesrv.x64.exe` dates from 09:21, before the run. Every runtime effect is boot- or sweep-triggered and is still pending: the epoch file (`~/.waveterm/memory-recall-epoch.txt`) is absent, the restore marker is absent, no `ARC-SHARED` region exists in `MEMORY.md`, and 212 hub dirs remain under `~/.claude/projects`. A `task build:backend` in main plus an Arc restart is required before any of it is observable.

After the restart, worth confirming by hand: the 67 notes come back and land in the live vault; `wsh memory stats` returns real numbers; the Vault surface still renders with the Records tab gone; and a Jarvis recall actually stamps `last_referenced`.

## Open issues

Filed as chunks 11-13 on the effort. 11 and 12 were closed the same day; 13 is open by choice.

1. ~~**Steering doc lost the pre-commit tests requirement.**~~ Closed in vault commit `694c033`. The
   merge brought the Git Workflow bullet across in its older phrasing, which had the file summary and
   the approval step but not the tests; `83f5967f` dropped only the simplify review, so its own
   wording was restored verbatim. The simplify gate stays gone.
2. ~~**`RestoreDecayArchive` trusts `archived_from` blindly.**~~ Closed in `0b386c9f`. Fixed in
   `Restore` rather than in the migration, so the UI Restore button
   (`wshserver_memory.go:171`) is covered by the same guard: an origin that is no longer a live scan
   root falls back to the vault. `VaultRoots` became a var as the test seam, and the new test was
   proven to fail without the guard.
3. **`MEMORY.md` is over the new 12,000-byte budget.** Partially done: 17,608 -> 13,916 bytes (-20%),
   80 -> 69 entries, 0 dead links, backup at `memory/MEMORY.md.bak-20260922`. Still 1,916 over, and
   the chunk stays open deliberately. The next lever is entry **count**, not hook length: at ~100
   bytes of link machinery per entry the budget implies roughly 60 entries, so closing it means ~9
   more pointers cut — and the remaining candidates need their bodies read, because their hooks are
   no longer enough to judge. Dropped entries were unlinked, not deleted, so recall still reaches
   them.

## Backend state

`task build:backend` re-ran after the guard landed; `dist/bin/wavesrv.x64.exe` is current as of
13:12. The restart is still pending, so every runtime effect listed under "Needs a live check"
remains unobserved.
