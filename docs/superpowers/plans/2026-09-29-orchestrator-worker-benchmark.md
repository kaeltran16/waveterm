# Lane rewind, flaky Verify reporting, and a Gatekeeper that judges multi-question asks

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/agentask/... ./pkg/wshrpc/... ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/agentask/... ./pkg/wshrpc/... ./cmd/wsh/... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./cmd/wsh/...`

**Goal:** Close three open orchestrator items from `docs/open-issues.md` §2. Each task states the outcome and
how it is proven, not the implementation: choosing the design is part of the task. Read the source entry each
task names before designing, and read the code it touches, its callers and the shared helpers before editing.

This plan is also a worker-model benchmark: the same plan runs twice from the same base, once with Claude
Sonnet 5.5 workers and once with Claude Opus 5.5 workers. Nothing in a task changes because of that.

## Global Constraints

- The three tasks run in parallel and must not edit the same files. Do not edit `docs/open-issues.md` or
  `docs/deferred.md`: their rows are updated after the runs land. Task 1 alone may edit
  `docs/orchestrator-guide.md`.
- Never hand-edit generated files (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`,
  `pkg/wshrpc/wshclient/wshclient.go`, the `metaconsts.go` files). No task should need a wire-type change;
  if one truly does, edit the Go type and run `task generate`, and say why in the report.
- Run only the focused tests that prove your change: `go test ./pkg/x -run '<names>'`. Never a whole package
  or the full suite; Verify runs those at each merge. Go tests touching sqlite need
  `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"`.
- Do not pipe a test into `tail`, `head` or `grep` without `set -o pipefail`.
- `gofmt -l` and `npx prettier --check` only the files you touched; never `--write` the tree, and never run
  prettier on `scripts/*.mjs` (they are hand-formatted at 4 spaces; `.editorconfig` omits `.mjs`).
- Tests assert behavior, and each must fail if the behavior it names is removed.
- Commit messages: `type(scope): description`, with no attribution trailers.

### Task 1: A Verify that passed only on a rerun reaches the human as a flaky test
**Depends on:** none

Source: `docs/open-issues.md` §2, the "`pkg/orchestrate` tests flake…" row, fix (2), whose note says the
engine-side half is not done.

Today `scripts/verify.mjs` reruns a failing Go test alone, and when it passes it exits 0 and prints a
`verify: flaky, …` line naming the tests. The engine treats that Verify as a plain pass, so the only record is
a line inside a passed Verify's kept output. Nobody reads that output, so a real race that passes on a rerun
gets through with no trace.

Outcome:

- When a merge Verify or the final stage's Verify passes but reports flaky tests, the run's human-facing
  result names each flaky test: the same place the human already reads what a run did not verify (the
  unverified items that `wsh runs show` and the run's attention row show). If the run has a lead, its wake
  says so too.
- A Verify that passes with no flaky report reads exactly as today. A failed Verify is unchanged.
- The engine stays language-agnostic. It must not know `verify.mjs`, Go or test names. Define the contract a
  Verify command uses to report flaky tests, make `scripts/verify.mjs` follow it, and document it in the plan
  format text the lead and plan reviewer see and in `docs/orchestrator-guide.md`.
- No new fields on wire types.

Proven by tests that a flaky report from a merge Verify and from the final stage each reach the unverified
items, that a clean pass adds nothing, and that `scripts/verify.mjs` emits the contract (`scripts/verify.test.mjs`).

### Task 2: Skipping or retrying a task never lands or hides a failed attempt's commits
**Depends on:** none

Source: `docs/deferred.md`, "Lanes: a skipped task's commits land with its lane, and a retry's evidence
starts at the branch head (2026-09-15)". Read its "Where to pick it up" as a starting point, not a spec. The
entry predates one part of the fix: skipping a *review-failed* task already takes its lane branch back. The
failed and stalled cases do not.

Outcome:

- Skipping a failed or stalled task whose attempt committed on its lane branch removes those commits from the
  lane, so the lane's squash merge carries none of them. Commits of the lane's earlier, done tasks stay.
- The skipped attempt's work is still recoverable afterwards, as it is today.
- The rollback never deletes or rewrites anything outside the lane's own worktree. A lane tree's
  `node_modules`, `src-tauri/target` and `dist/bin` are junctions into the main checkout (see
  `task worktree:prepare`), and a reset or clean that follows one wipes the main checkout. Prove it with a
  test whose lane tree holds a junction or symlink to a directory outside it, checking that directory is
  intact afterwards.
- A retried task's evidence covers everything the task changed since it first started, including commits its
  failed attempt left, not only what the retry added.
- Out of scope: a lane's first task retried after a Setup failure keeping its old base (the entry's third
  bullet).

Proven by tests for: a skipped failed task with commits (lane lands without them), a skipped stalled task, a
skip that finds nothing to roll back, the junction safety above, and a retry's evidence after a failed attempt
that committed.

### Task 3: The Gatekeeper judges multi-question and multi-select asks instead of escalating them unread
**Depends on:** none

Source: `docs/deferred.md`, "Jarvis Gatekeeper — every multi-question or multi-select ask escalates unjudged
(2026-09-14)". Its fix shape is approved: follow its six points. The design choices inside them are yours.

Outcome:

- Every ask reaches the judge; none is escalated only because it has several questions or a multi-select
  question.
- The judge can answer each question: one pick, several picks, or a one-line text answer when no option fits.
- All or nothing: if any question needs the human, the whole ask escalates and nothing is delivered.
- An answer is validated before delivery, by the same rules the answer encoder enforces, through one shared
  validator rather than a second copy. An invalid judge answer escalates and never reaches delivery.
- Cards and messages written before this change still read correctly: existing readers of a card's single
  question and options keep working.

Proven by tests for: a two-question ask answered in full, a multi-select ask answered with several picks, a
free-text answer, an ask where one question needs the human (whole ask escalates, nothing delivered), and each
class of invalid judge answer (wrong answer count, out-of-range index, picks and text together, several picks
on a single-select question) escalating without delivery.
