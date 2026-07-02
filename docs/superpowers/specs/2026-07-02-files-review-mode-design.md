# Files Review mode — staged Accept/Reject of agent changes

> Design spec. Captured 2026-07-02. Implements `Wave-diff-review.dc.html` (claude.ai/design
> project "wave"), adapted to real data. Supersedes the earlier "revert-only + inline two-step
> confirm" brainstorm — the staged Apply gate replaces the confirm, and Accept/Reject replaces
> revert-only.

## Problem

AI agents (Claude Code, Codex) run in git worktrees and leave uncommitted changes. The cockpit's
Files surface lets a user browse those changes **read-only** — there is no way to act on them
without dropping to a terminal. Review is observation; there is no way to keep some changes and
discard others from the cockpit.

## Goal

Let a user triage an agent's (or project's) uncommitted changes in place: mark each change
**Accept** (keep) or **Reject** (discard), then **Apply** the decisions in one batch. Nothing
touches the working tree until Apply, so undo is free until then.

## Scope

**In:** one worktree at a time (agent or registered project); file-grouped diff; hunk- and
file-level staged Accept/Reject; undo; a batch Apply gate; local wavesrv host only; any provider
(pure git, no transcript needed).

**Out (v1):** task grouping / walkthrough narrative (v2 — needs transcript→file attribution, which
git and TodoWrite do not provide); per-line accept/reject (the design is hunk/file only); cross-agent
review queue; remote (SSH/WSL) worktrees (git runs on the local host — same limit as the read path);
partial-line staging.

## Placement

A **mode of the existing Files surface**, not a new NavRail surface. The Files header gains a
**Browse ⇄ Review** toggle:
- **Browse** = today's read-only file list + diff (unchanged).
- **Review** = the staged Accept/Reject layout below.

Rationale: Review and Browse operate on the same object (one worktree's git diff) and the Files
surface already owns everything Review needs — the source picker (agent/project), cwd resolution
(`agentcwdresolve`), git loading (`filesstore` → `GitChanges`/`GitDiff`), and the diff render
pipeline (`gitdiff.ts`, `DiffRow`). A separate surface would duplicate that plumbing and crowd an
already-8-item rail. The design's standalone "Review changes" titlebar is a `.dc.html` full-window
convention; inside the cockpit the review body sits under the NavRail. This also retires the
stopgap "Read-only" label. A second entry point (a "Review changes" action on the agent card) is a
later follow-on, not a v1 driver.

## Decision model

Each **hunk** carries one decision: `pending | accept | reject`. All other state derives from the
hunk decisions:
- **File decision** = `accept` (all hunks accepted), `reject` (all rejected), `partial` (mixed
  decided), or `pending` (none decided).
- **Progress** = counts of accepted / rejected / pending across all hunks.

Decisions are **pure frontend state** (`decisions: Record<hunkKey, 'accept'|'reject'>` +
`history: hunkKey[]` for undo-last). Nothing is written to the working tree until Apply, so:
- **Undo is free**: per-hunk undo, per-file undo (clears its hunks), undo-last (`U`), and Reset.
- **Semantics**: Accept = "leave this change in the tree"; Reject = "discard it on Apply".

Untracked (new) files have no hunks — they get a single whole-file decision only.

## Apply

The **Apply** action is gated: enabled only when nothing is `pending` (an **Accept all remaining**
button decides the rest as accept in one click). On Apply, the frontend groups rejected changes
**per file** and reverts them via the backend, leaving accepted changes untouched:
- **Tracked file, all hunks rejected** → `git checkout -- <path>` (exact restore).
- **Tracked file, partial (some hunks rejected)** → build one reverse patch containing that file's
  rejected hunks and `git apply --reverse` it once (a single multi-hunk patch avoids line-offset
  drift between hunks).
- **Untracked file rejected** → `git clean -f <path>` (remove it).
- **Fully-accepted file** → no backend call.

After Apply: reload the diff, show the **Review applied — kept N · discarded M** summary with a
**Reopen review** action. A per-file revert that fails (e.g. the working tree changed under a stale
diff) is reported inline and non-blocking; the batch continues and the summary notes failures, then
the diff reloads to reflect reality. Errors are never silently swallowed.

## Architecture

### Backend — one new write command (`pkg/`)

- `pkg/gitinfo/gitinfo.go`:
  - `RevertFile(ctx, cwd, path, status)` — status-aware: tracked ⇒ `git checkout -- <path>`;
    untracked ⇒ `git clean -f <path>`.
  - `RevertHunk(ctx, cwd, path, patch)` — `git apply --reverse` with `patch` on stdin (patch may
    contain one or more hunks for a single file).
- `pkg/wshrpc/wshrpctypes.go`: `GitRevertCommand(ctx, CommandGitRevertData) error`, data
  `{ Cwd, Path, Status, Patch string }` — empty `Patch` ⇒ whole-file (`RevertFile`), else
  `RevertHunk`. Declared beside `GitChangesCommand`/`GitDiffCommand`.
- `pkg/wshrpc/wshserver/wshserver.go`: implement, dispatching on `Patch != ""`.
- `task generate` regenerates `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts` (never hand-edited).

The command runs `git` on the wavesrv host — same trust boundary and remote-worktree limitation as
the existing read commands. Batch atomicity across files is not guaranteed (git apply/checkout are
per-invocation); failures are reported, not rolled back.

### Frontend (`frontend/app/view/agents/`)

- `gitdiff.ts` (extend): `parseUnifiedDiff` also returns `hunks: { id, header, adds, dels, patch }[]`.
  `patch` is reconstructed from the **raw** diff — the retained file header (`diff`/`---`/`+++`) plus
  that single `@@` block — because the existing `DiffLine[]` model is lossy (drops the header, strips
  `+`/`-` prefixes, renders `−` as a Unicode minus) and cannot rebuild a valid patch. Per-file
  combined patch = header + the selected hunks' blocks. The existing line render is untouched; hunks
  ride alongside.
- `reviewstore.ts` (new): the staged-decision state and derivations — `decisions`, `history`,
  `selectedPath`; actions `decide(key, val)`, `decideMany(keys, val)`, `undoKey`, `undoFile`,
  `undoLast`, `reset`, `apply`; derived selectors `fileDecision(file)`, progress counts, `hasPending`.
  `apply` groups rejected hunks per file and calls `GitRevertCommand`, collecting failures, then
  triggers a Files reload. Pure logic is unit-tested independent of React.
- `reviewsurface.tsx` (new): the Review-mode layout — left file list (path, status glyph, +/−,
  per-file review ring + n/m progress), right selected-file pane (file-level Accept/Reject, hunks
  with per-hunk Accept/Reject/Undo + the line diff), footer (progress bar + Accept-all-remaining +
  Apply gate), and the applied-summary state. Keyboard: `A` accept, `R` reject, `U` undo-last,
  `↑/↓`/`j`/`k` move file selection, `Enter` apply when nothing pending.
- `filessurface.tsx` (extend): add the Browse ⇄ Review mode toggle in the header; in Review mode
  render `<ReviewSurface>` instead of the read-only `CenterPane`. Reuses the existing source picker
  and git loading.

### Left column adaptation (design → real data)

The design's task-grouped left column collapses to a file list (task grouping is v2):
- Agent identity (name, model), branch, `+adds/−dels` totals — real (roster + git).
- `runTitle` — the agent's ai-title if present, else omitted. `walkthrough` narrative — **omitted in
  v1** (no honest source without task attribution).
- The task list → the **file list** with per-file review progress and the accept/reject progress bar.

## Theme

Tailwind v4 `@theme` tokens only — no hardcoded hex/rgba. Map the design palette to existing tokens:
accept/adds `#54c79a` → `success`; reject/dels `#e0726c` → `error`; partial `#e6b450` → `warning`;
greys → `ink-*` / `surface` / `border` / `edge-*`. Add a token in `tailwindsetup.css` only if no
existing one fits.

## Testing

- **Go** (`pkg/gitinfo/gitinfo_test.go`): temp-repo tests — revert modified file (change gone),
  revert one of two hunks via a reverse patch (the other remains), revert untracked (file removed),
  stale/no-longer-applying patch fails cleanly.
- **TS** (`gitdiff.test.ts`): hunk-patch reconstruction — given a real multi-hunk `git diff`, each
  `hunks[i].patch` is a valid single-hunk patch (header preserved, prefixes intact); a combined
  per-file patch applies. This is the correctness-critical unit.
- **TS** (`reviewstore.test.ts`): the decision model — accept/reject/undo/reset, file-decision
  derivation (accept/reject/partial/pending), progress counts, Apply gate (blocked while pending),
  and the per-file grouping of rejected hunks that `apply` feeds to the backend.

## Files touched

New: `reviewstore.ts`, `reviewsurface.tsx`, `reviewstore.test.ts` (frontend).
Extend: `gitdiff.ts`, `filessurface.tsx` (frontend); `pkg/gitinfo/gitinfo.go` + `_test.go`,
`pkg/wshrpc/wshrpctypes.go`, `pkg/wshrpc/wshserver/wshserver.go` (backend).
Generated: `wshclientapi.ts`, `wshclient.go`, `gotypes.d.ts`.
