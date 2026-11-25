# Clear run-tree transcripts, keep Usage history

## Intent

Claude Code's transcript folder holds 6.4 GB, and 3.5 GB of it is orchestrator run-tree transcripts: about
3 MB a run tree, roughly 1,150 folders. Claude Code deletes transcripts after 30 days, so the folder holds
steady, but it is not small. Storage should offer an old, finished run's transcript folders as left over, so
the user can clear them.

The blocker is Usage: it reads token counts straight from transcripts on every load, so clearing them drops
those runs from Usage history. Usage therefore has to keep its own record of usage first. Kept for every
session, that record also lifts the 30-day cap Claude Code's purge puts on Usage's All time today.

## Goals

- Storage lists a finished run's transcript folders as left over once the run is 14 days old, and clears
  them with the rest of what is left over.
- Usage keeps every session's tokens after its transcript is gone, whether Arc cleared it or Claude Code
  purged it.
- All time on Usage covers everything from the day this ships, with no 30-day cap.

## Non-goals

- Shrinking transcripts in other ways: smaller screenshots for the copies workers read, removing another
  app's agent hooks, or lowering Claude Code's cleanup period. Each is a separate change.
- Recovering usage Claude Code already purged before this ships: it is gone.
- Changing the Usage surface's look.

## Anti-goals

- A clear that loses tokens from Usage, or counts a session twice.
- Usage loading slower than it does today.
- Deleting a transcript folder whose run tree is still on disk.

## Decisions

### Which sessions keep usage

Every session Usage shows keeps its usage once seen: Claude, Codex, OpenCode and Pi, interactive sessions and
run agents alike. Why: one rule (Usage never depends on a transcript still being on disk) instead of a special
case for run trees, at little extra cost since the scan already produces the same buckets for both.

### Where kept usage lives

A table in wavesrv's SQLite store holding exactly the buckets Usage already uses: one row per harness,
session, provider, model and local day, with the token classes, any reported cost and the message count;
plus each session's cwd and title, which today come only from the transcript. Why: the usage scan already
returns these buckets deduped per session-day, and the store already has plain, non-object tables with
upsert. A per-message ledger was weighed and dropped: it guards against cross-file duplicates measured at 15
of 115,772 Claude messages, at the cost of about 116k rows and a special rule for Codex.

### When usage gets stored

- Every Usage scan upserts the session-days it read.
- A Storage clear stores a folder's sessions before deleting it, so a clear can never lose usage.
- wavesrv runs one all-time scan into the table at start, in the background, so sessions are kept even
  when Usage is not opened before Claude Code's 30-day purge.

Why: storing only on Usage scans leaves a gap for anything purged while Usage stays closed.

### What Usage shows

Usage looks the same. Its numbers come from the stored buckets plus the live scan, so a cleared or purged
session still counts, still links to its run, project and initiative (those links come from the store, as
today), and keeps its title. All time covers everything from the first scan after this ships back to the
oldest transcript on disk then, with no cap from Claude Code's purge. Stored rows are kept indefinitely: a
row is a few numbers per session-day, about 4k rows a month at today's activity.

Load time: the 7-day view and All time load no slower than today (measured today, scan only: 7 days 1.8 s
cold, 0.4 s warm; All time 2.1 s cold, 0.6 s warm). As All time grows past 30 days, its rows and the run
linking per session grow with it, so All time must stay within today's time as history accumulates. Run
links are not stored with the usage: they stay live, so a link that changes later (an initiative tag added
afterwards) shows.

### What clearing gives up

Clearing takes all of a run's transcript folders, the lead's and every task's. A cleared run keeps its task
rows, their summaries, files and line counts (all from the run's sealed record), and its Usage tokens. Open
agent on its done tasks no longer replays the session: it shows the view's existing empty state. Hand
forensics on that run's transcripts are gone too. Why: an old run is rarely replayed, and clearing every
folder frees the most.

### When a run's transcripts are left over

A run's transcript folders become left over 14 days after the run finished. Storage only lists them; nothing
is deleted until the user clears. At today's activity that is about 1.8 GB.

### Folders that can't be aged by their run

- A folder whose run tree is still on disk is never left over, whatever its age.
- A folder whose run this store does not know (the dev app and the packaged app share one worktree root and
  one Claude transcript folder, and a run can be deleted) is aged by its last write instead, with the same
  14 days. Why: its tree is gone either way, and keeping unknown folders forever would leave the dev app's
  runs uncleared.
- Pi run-tree sessions follow the same rule as Claude's.

### How Storage shows them

One left-over row per run, holding its lead and task folders, titled with the run's title the way run-tree
rows are, with its size and how long ago it finished; an unknown run's row shows its folder key. The existing
clear-left-over action clears them with the rest, and its confirm says that cleared runs lose their agent
replay but keep their Usage. The per-harness transcript rows stay kept, and no byte is counted in both a run
row and a harness row. Why: per-run rows let one run be kept or deleted on its own, as run-tree rows already
allow.

## Left to the builder

- The table's exact schema and its migration.
- How a scan's session-days replace stored ones without double counting, including a day a windowed scan
  only partly covered.
- How a transcript folder maps to its run once the run tree and its run marker are gone (the sessions'
  ids against the store's runs, or the run-id prefix in the folder name).
- The startup scan's cost and timing, and keeping All time within today's load time as history grows.
- The Storage row and confirm wording.

## Builder decisions (2026-11-25)

Taken by the run's lead for the items left to the builder, each with why.

- **Two tables.** `db_usagebucket` holds one row per (harness, session, provider, model, day) with the token
  classes, a nullable reported cost and the message count; `db_usagesession` holds one row per (harness,
  session) with its cwd and title. Why: cwd and title are per session, not per day; one migration adds both.
- **A stored row only grows.** A scan replaces a stored row with its own for the same key only when the
  scan's token total is at least the stored one; rows the scan did not produce are left as they are. Why: a
  key's true value never shrinks (a message's session, model and day are fixed, and a transcript only grows),
  so a smaller scanned value can only mean part of the session is gone (a purged subagent file) or the scan
  saw part of it. This needs no window bookkeeping and makes a partly covered day harmless.
- **Codex replaces its whole session.** A Codex session is one record, its running total, dated by its last
  token count, so its day moves as the session goes on. When a scan produces a Codex session, its stored rows
  on other days are deleted in the same write. Why: otherwise the old day's total and the new one both count.
- **Usage answers from the store.** Each Usage load scans its window as today, keeps what it read, then
  answers with the stored rows of the window (every stored row for All time) and the stored cwd and title of
  each session. A failed write is logged and that load answers from the scan alone. A repeat scan with no new
  usage writes no row, so a warm load costs a read, not a rewrite.
- **Run linking scales.** Linking sessions to runs must not depend on one SQL statement holding every session
  id (SQLite caps bound parameters), since All time now names every session ever kept.
- **When usage is kept outside Usage.** wavesrv runs an all-time keep in the background shortly after start
  and again every 24 hours. Why: the spec's start-only scan leaves a gap when wavesrv runs past Claude Code's
  30-day purge without a restart; with the parse cache warm, the daily pass rereads only changed files.
- **A folder maps to its run by its name.** A run tree's transcript folder is named from the tree's path, so
  under Claude's projects root it is `SlugifyCwd(<worktree root>)` + `-` + the tree folder name, and under
  Pi's sessions root the same path in Pi's `--<path>--` form. The tree folder name starts with the run id's
  8-character prefix. The run is the one stored run whose id has that prefix; none, or more than one, is an
  unknown run, aged by the folder's last write. Why: the run marker goes with the trees, and the prefix is
  all the folder name keeps.
- **One rule for "tree still on disk".** A run's row is listed only when no folder under the worktree root
  starts with its prefix. Why: a run with any tree left is not cleaned up; its transcripts become left over
  once Storage clears that tree.
- **Only left-over runs get a row.** A run that is not yet left over has no row of its own, and its bytes stay
  in its harness's transcripts row; each harness row's size leaves out the bytes of the run rows listed.
- **A clear keeps usage first.** Clearing a run-transcripts row scans every transcript under its folders
  all-time and keeps that usage; a failed keep fails the row and deletes nothing.
- **Legacy in-project trees are out.** Transcript folders of trees under `<project>\.waveterm\worktrees` are
  not listed: that layout predates the worktree root by more than Claude Code's 30-day purge.
- **A blocked run is not finished.** Its transcript folders are not left over until it is cancelled or done,
  the same rule Storage applies to its run trees today. Why: a blocked run waits on the human and can resume
  into its sessions; one abandoned blocked run is cancelled to free both.
- **Open agent on a cleared run needs no change.** The done-task view asks `RunTranscriptPath`, whose
  `agentsessions.TranscriptForSession` stats and globs and answers "" when the file is gone, and the view then
  shows its existing "No transcript found for this session." state.
