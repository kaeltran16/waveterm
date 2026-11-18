# Agent's edits: a Diff range of exactly what one agent changed

## Problem

The Agent scope's "Since session start" range is `git diff <commit at session start>` against the working tree
(`filesstore.ts` `resolveRangeOpts`, `gitinfo.CommitBefore`). In the shared checkout, where several interactive
sessions edit side by side, that diff also holds the user's edits, other sessions' edits and generated output. Git
does not record who wrote a change, so the range cannot be narrowed after the fact by git alone.

## Decision

Rebuild the agent's own changes from records Claude Code already writes, at the moment the Diff surface asks, and
hand them to the surface as an ordinary bounded git range. No hook, no capture during the session, no refs.

- Pre-image: Claude Code backs up a file before the agent's first edit of it and records the backup in the
  transcript.
- Edits: every Edit/Write call is in the transcript with its input.
- Post-image: the pre-image with the agent's edits applied in order.

Scope: Claude agents only. Run scopes are unchanged: a run worker is the only writer in its worktree, so the
run's `base..tip` already is its work, engine writes (Setup, upstream merges) included, which a review of what
lands wants. Pi agents write no backups and keep the session range only.

Measured cost of the alternative (a PostToolUse hook committing each edit to a private ref): ~210 ms wall,
~110 ms CPU, ~13 MB transient per edit; rejected because the lazy build costs nothing while agents work.

## Sources (verified on this machine, Claude Code transcripts of 2026-11)

- `file-history-delta` records: `{"trackingPath": "<path, repo-relative or absolute, backslashes>",
  "backup": {"backupFileName": "<hash>@v<n>" | null, "version": n, ...}}`. The lowest version per path is the
  pre-image; `backupFileName: null` means the file did not exist. The backup lives at
  `~/.claude/file-history/<sessionId>/<backupFileName>`, `<sessionId>` being the transcript's file name.
- Older transcripts carry the same data as `file-history-snapshot` records:
  `snapshot.trackedFileBackups[<path>] = {backupFileName, version, ...}`. Read both shapes.
- Edit/Write calls: the assistant `tool_use` block's `input` (`file_path`, `old_string`, `new_string`,
  `replace_all` for Edit; `file_path`, `content` for Write; MultiEdit's `edits[]` if present). Count a call only
  when its `tool_result` is not an error.
- Subagent transcripts (`<session>/subagents/*.jsonl`) hold their own Edit/Write calls but no file-history
  records. Include their calls; their pre-images come from the parent's records when the path is there,
  otherwise from the fallback below.
- `toolUseResult.originalFile` is not a usable source: null in 229 of 302 results sampled.

## Reconstruction

For one transcript (the agent's current one, the same transcript the session range reads):

1. Collect Edit/Write/MultiEdit calls from the transcript and its subagent transcripts, in timestamp order.
   Drop paths outside the agent's repository.
2. Pre-image per path: the earliest file-history backup; `null` = absent. No record: the file at the
   session-start commit (`gitinfo.CommitBefore`), and the file is marked **approximate**.
3. Apply the calls in order. Write replaces the content. Edit replaces `old_string` with `new_string` (all
   occurrences when `replace_all`, else exactly one occurrence required).
4. An Edit whose `old_string` is missing, or not unique without `replace_all`, means something else changed the
   file between the agent's edits. Stop reconstructing that file, use its current working-tree content as the
   post-image, and mark it **changed outside this agent**.
5. Count the transcript's Bash calls (subagents included). They may have changed files this view cannot see.

Build two commits with a temporary `GIT_INDEX_FILE` (deleted afterwards): `read-tree <session start or HEAD>`,
write the pre-images (remove absent paths) → `write-tree` → commit **B** (parent: the session-start commit);
write the post-images → `write-tree` → commit **H** (parent: B). Batch blob writes and index updates
(`hash-object -w --stdin-paths` or `--stdin`, `update-index --index-info`) rather than a process per file.
Nothing references B or H, so nothing needs cleaning up; git's gc may prune them after its expiry, and the next
request rebuilds them.

Cache the result in wavesrv keyed by transcript path plus the size and mtime of the transcript and its subagent
files, so the surface's 10 s poll rebuilds only when the transcript has grown.

## Backend

A new wshrpc command in `wshrpctypes_git.go`, e.g. `GitAgentEditsCommand`:

- In: `cwd`, `transcriptpath`.
- Out: `base` (B), `end` (H), `files` (path plus flag: `approximate` | `outside`), `bashcalls`.
- Empty `base` with a `reason` when there is nothing to show (not a repository, no edits yet).

Reconstruction is pure Go over transcript lines and file contents, unit-tested without git; only the commit
build touches git (`pkg/gitinfo` style `run`). Run `task generate` after adding the types. Mind the 5 s default
RPC budget: the frontend calls it with the history timeout the other Diff reads use.

## Frontend

- `diffscope.ts`: a new `DiffRange` kind `{ kind: "edits"; agentId }`, key `edits:<agentId>`, labelled
  "Agent's edits". It is the **default range for a Claude agent's scope**; "Since session start" stays as an
  option. For a pi agent the range is absent (a range that can never apply is not listed). Every exhaustive
  switch over range kinds gets its case (`rangeKey`, `historyOptsFor`, `summaryLine`, `pollAnchor`,
  `historyrows.ts`, `filesstore.ts` `resolveRangeOpts`, and any others tsc names).
- `filesstore.ts`: the edits range resolves through the new command to `{ ref: base, end }`, the same bounded
  read a landed run uses, so the file list, per-file diffs, review marks and comments work through the existing
  path. The poll re-calls the command (the cache makes an unchanged transcript free).
- The file list marks **approximate** and **changed outside this agent** files. The summary caption gives the
  count and, when `bashcalls > 0`, says that N Bash calls may have changed files not shown. Wording and
  placement follow `DESIGN.md`; no new tokens.
- History pane for the edits range: no commit list (B and H are synthetic); the scope's own row only.

Pure logic stays in model files with tests beside them (`foomodel.ts` + `foomodel.test.ts`).

## Verification

- Go unit tests for reconstruction: create, edit chain, `replace_all`, missing backup (approximate), foreign edit
  between two edits (outside), subagent edit, path outside the repository dropped, both file-history record
  shapes.
- A Go test that builds B and H in a temporary repository and checks `git diff B H` lists exactly the agent's
  files.
- Frontend unit tests for the range options, keys and caption.
- A CDP scenario that opens a Claude agent's Diff scope on "Agent's edits" and shows the list with a flagged
  file and the Bash caption (fixture transcript), run through `scripts/cdp/final-verify.mjs`.

## Out of scope

- Run scopes and run workers.
- Files changed through Bash, NotebookEdit or other tools: counted, not shown.
- Pi agents.
- Sessions before a `/clear` or `/resume` (the range follows the current transcript, like the session range).
