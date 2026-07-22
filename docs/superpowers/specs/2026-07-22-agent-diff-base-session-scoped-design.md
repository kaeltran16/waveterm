# Agent diff base: session-scoped, not branch-vs-default

Date: 2026-07-22
Status: design (approved, pending written-spec review)

## Problem

The cockpit's live git stat (the card `+adds/−dels` pill, the agent details rail, and the
Files/Diff tab) diffs an agent's checkout against the **merge-base with the repo's default
branch** (`gitinfo.WorktreeBase`, wired through `GitChangesCommand{worktreebase:true}`). On a
long-lived shared branch this is the wrong base: it sums the branch's entire divergence, plus every
generated/vendored/recorded file in it.

Observed on the `MP-Frontend` card: `+455970 / −153814`, which is `DEV` (295 commits ahead of
`origin/BD-v2.6.1`) diffed against that fork point, scoped to `src/main/webapp`. ~48% of the churn
is recorded e2e fixtures (`tests/e2e/fixtures/*.json|*.har`), plus lockfiles, a committed
`yarn-error.log`, and `*.less~HEAD` backup files. The number is real `git` output but meaningless as
"what this agent did."

The base is the root cause. Excluding generated files (a pathspec filter) would only shave the
noise; it would still report the whole branch history. The right fix is to change **what the diff is
anchored to**.

## Goal

A card / rail / Diff-tab `+/-` reflects **this agent session's work** — commits it made since the
session started, plus its uncommitted working-tree edits — not the branch's whole life.

Concretely: anchor the diff on **the commit that was `HEAD` when the agent's session began**, and
diff `anchor..working tree` (committed + uncommitted). This mirrors what jarvis runs already do with
`Run.BaseCommit`; we extend the same idea to transcript-only external agents (Claude Code / Codex
cards) that have no `Run` object.

### Non-goals

- Not touching sealed evidence (`pkg/jarvis/evidence.go`) — it already scopes to
  `BaseCommit..EndCommit` and is correct.
- Not adding generated-file pathspec exclusions. Once the base is the session start, the fixture/
  lockfile churn from *earlier* branch history stops counting on its own. Excluding files a session
  legitimately touched would then hide real work. (Revisit only if a single session's own generated
  churn proves noisy — evidence-gated, not now.)
- Not solving multi-agent-on-one-branch attribution beyond time-boxing (see Known limitations).

## Approach

### Base resolution (backend, stateless)

Add `gitinfo.CommitBefore(ctx, cwd string, beforeUnixSec int64) (string, error)`:

```
git rev-list -1 --first-parent --before=<RFC3339(beforeUnixSec)> HEAD
```

Returns the most recent first-parent commit on `HEAD`'s history with commit-date ≤ the timestamp —
i.e. the branch tip at session start. Degradation contract matches `WorktreeBase`: returns `("", nil)`
when cwd is not a repo, `HEAD` is unborn, or no commit precedes the timestamp (fresh session). `""`
means "no anchor → fall back to the live working-tree-vs-`HEAD` diff."

Timestamp is passed as unix **seconds** and formatted as RFC3339 in Go before handing to git, so date
parsing is unambiguous across locales.

Recomputed every call (no persistence), so it self-heals across app restarts and rebases — the same
property that makes `WorktreeBase` stateless.

### RPC surface

`CommandGitChangesData` gains one field:

```go
SessionStartTs int64 `json:"sessionstartts,omitempty"` // resolve base = commit that was HEAD at this
                                                        // unix-seconds session-start time; echoes ref back
```

`GitChangesCommand` base precedence becomes:

1. `SessionStartTs != 0` → `ref = gitinfo.CommitBefore(cwd, SessionStartTs)`
2. else `Ref` (explicit; jarvis runs pass `Run.BaseCommit`)
3. else live working-tree-vs-`HEAD` (`ref == ""`)

The resolved `ref` is echoed back in the response (as it already is), and the frontend threads it into
the follow-up per-file `GitDiff` so the file list, the header total, and each per-file diff all use one
base.

**Remove `WorktreeBase`.** After this change nothing calls it (see Surfaces), so the field, the server
branch, the `gitinfo.WorktreeBase` function, and its tests are deleted. The design's thesis is that
merge-base-vs-default is the wrong base; leaving the mechanism in place invites regression. Removing a
wshrpc field hits the codegen-bootstrap ordering gotcha — pre-remove the generated client references,
then `task generate` — so this is a deliberate, sequenced step, not a drive-by.

### Session-start timestamp (frontend)

Pure helper `agentsessionstart.ts` — `sessionStartTs(lines: string[]): number | null` — mirrors
`agentcwd.ts`. Scans transcript **head** lines (read with `fromstart: true`, the read `resolveCwd`
already performs) and returns the first parseable timestamp as unix seconds:

- Claude records: top-level `timestamp` (ISO 8601).
- Codex: `session_meta.payload` / record `timestamp` on the first line.
- No timestamp found → `null`.

Shared cache store `agentsessionstore.ts` — mirrors `agentbranchstore.ts` (separate from
`cardgitstore`, so it survives surface unmount and is a single source of truth per agent id):

```
agentSessionStartAtom: Record<agentId, number>   // unix seconds
ensureSessionStart(id, transcriptPath): Promise<number | null>  // resolved once per transcript-source key
```

### Surfaces (all three current `worktreebase` callers move)

| Surface | Path | Before | After |
|---|---|---|---|
| Grid card pill | `cardgitstore.refreshCardGit` | `worktreebase:true` | `sessionstartts: ensureSessionStart(...)` |
| Focused-agent rail | `railstore` load | `worktreebase:true` | `sessionstartts: ensureSessionStart(...)` |
| Diff tab — agent | `filesstore.loadFilesForAgent` | `worktreebase:true` | `sessionstartts: ensureSessionStart(...)` |
| Diff tab — project | `filesstore.loadFilesForProject` | `worktreebase:true` | live vs-`HEAD` (no base opt) |
| Diff tab — run | `filesstore.loadFilesForRun` | `ref: baseCommit` | unchanged |

The card pill and the agent Diff tab read the **same** `agentSessionStartAtom` keyed by agent id, so
they always resolve the identical anchor — the pill and the tab can never disagree.

**Project Diff (session-less):** opened from the project switcher, no transcript, so no session start
exists. Anchor to live working-tree-vs-`HEAD` (uncommitted changes) — the literal "open this repo in a
git client" view. Never balloons; the trade is it omits committed-but-unmerged work for the project
view. (This is the one assumption not explicitly chosen by the user; flip to keeping merge-base if the
project view should show branch contribution.)

## Data flow (agent card)

```
transcript head ──▶ sessionStartTs() ──▶ ensureSessionStart (cached per id)
                                              │  unix seconds
resolveCwd ──▶ cwd                            ▼
   └────────────▶ GitChangesCommand{cwd, sessionstartts}
                        │  server: CommitBefore(cwd, ts) ──▶ anchor sha (or "")
                        ▼
                  GetChanges(cwd, anchor)  =  git diff anchor..worktree (committed+uncommitted) + untracked
                        │  numstat + statusz + echoed ref
                        ▼
          parseGitChanges ─▶ {files, adds, dels}  ─▶ pill / rail / Diff list
          echoed ref ─▶ GitDiffCommand{ref} ─▶ per-file diff (same base)
```

## Edge cases / degradation

- **No transcript / unparseable timestamp** → `sessionStartTs` null → `sessionstartts` omitted →
  live vs-`HEAD`. Safe, non-ballooning (GitHub-Desktop Changes behavior).
- **Agent has not committed this session** → anchor == current `HEAD` → diff == uncommitted only.
  Correct.
- **Fresh repo / no commit before session start** → `CommitBefore` returns `""` → live vs-`HEAD`.
- **Non-repo / unresolvable cwd** → unchanged existing behavior (card drops its diff pill).
- **Rebased history since session start** → commit dates shift; `--before` still yields a sensible
  tip-at-time; self-heals next call.

## Known limitations

- **Shared-branch time-boxing.** If another actor (human or a second agent) commits to the same
  branch after this session started, those commits fall in `anchor..worktree` and are attributed
  here. Acceptable for the one-agent-per-project case (MP-Frontend); the multi-agent delegator
  fan-out case is already handled independently by jarvis `EndCommit` on the sealed path. Not solved
  here.
- **Anchor accuracy depends on transcript timestamps** being present and monotonic; both Claude and
  Codex transcripts carry them today.

## Testing

- **`gitinfo` (Go):** `TestCommitBefore` — table-driven over a repo with commits at t1<t2<t3: before
  t1 → `""`; between t2,t3 → c2; after t3 → head (HEAD sha); non-repo → `""`. Mirrors existing
  `gitinfo_test.go` harness (`gitCmd` helper).
- **FE pure:** `agentsessionstart.test.ts` — parses Claude top-level `timestamp`; parses Codex
  `session_meta` timestamp; skips non-JSON lines; returns `null` when absent; returns unix seconds.
- **FE stores:** update `filesstore.test.ts` and `cardgitstore.test.ts` — the `worktreebase:true`
  expectation becomes `sessionstartts` passed and the echoed `ref` threaded into `GitDiff`; add a
  null-timestamp case asserting fallback to a live (no-base) request.
- No new render tests (per the surface-render-tests-declined decision — CDP smoke covers "does it
  render"); the risky wiring is the pure resolver + store, which are unit-tested above.

## Rollout / codegen

- Go type + gitinfo change → `task generate` (regenerates `frontend/types/gotypes.d.ts` +
  `wshclientapi.ts`). No DB migration (no new waveobj).
- `WorktreeBase` removal is sequenced per the codegen-bootstrap gotcha: remove generated client refs
  first, then regenerate.
- Backend rebuild (`task build:backend`) required for `CommitBefore` to activate.

## Decisions

- **Session-start base, derived (not captured).** Chosen over capturing `HEAD` on first observe: no
  persisted state, self-healing, and accurate to true session start rather than "first time the
  cockpit saw the agent."
- **Remove `WorktreeBase` rather than leave it dead.** Its last callers are gone; keeping it invites
  the wrong base to creep back.
- **Project Diff → live vs-`HEAD`** (assumption, easily flipped): no session context exists for a
  project-scoped view, so the working-state view is the sane default.
