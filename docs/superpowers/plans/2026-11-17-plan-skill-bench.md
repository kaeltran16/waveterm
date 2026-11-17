# Plan-skill bench tooling

**Effort:** effort:25e5eb18-863e-4e80-b585-60124822822b
**Spec:** `docs/superpowers/specs/2026-11-16-slim-superpowers-design.md` (Decisions 8 and 9: the replay bench and its rule)
**Verify:** `node scripts/verify.mjs ./cmd/gomutate`
**Check:** `go vet ./cmd/gomutate`

Tooling for the replay bench that decides the default plan skill: three shipped specs replayed from their
pre-feature commit under both plan skills (`plan` and `writing-plans`, the values `pkg/jarvis/planskill.go`
defines) on the same installed Arc build, then scored and judged. The bench itself (launching the six runs,
scoring, judging) is run by hand after this lands; this plan builds only the tools. No Arc runtime code
changes: the arm is chosen through the existing `run:planskill` setting, which a run records at creation.

Every tool works on one bench directory passed as `--bench <dir>` (the bench is run with
`~/arc-bench/plan-skill-2026-11-17`). Its layout is shared by all tasks:

```
<bench>/runs.json                      [{pick, arm, runId, base, branch, worktree, spec, arcBuild, startedTs}]
<bench>/specs/<pick>.md                the spec text, copied from its source commit
<bench>/wt/<pick>-<arm>/               the arm's git worktree (branch bench/<pick>-<arm>)
<bench>/mutation/<pick>-<arm>-go.json  Task 2's output
<bench>/mutation/<pick>-<arm>-ts.json  Task 3's output
<bench>/blind/<pick>-X.diff, -Y.diff   Task 5's shuffled diffs
<bench>/results/blind-key.json         Task 5's sealed key
<bench>/results/blind.json             Task 5's unblinded verdicts
```

`arm` is always `plan` or `writing-plans`. The mutation JSON shape, shared by Tasks 2, 3 and 6:

```json
{ "tool": "gomutate|stryker", "base": "<sha>", "head": "<sha>",
  "killed": 0, "timedOut": 0, "survived": 0, "invalid": 0, "score": 0.0,
  "files": [{ "path": "pkg/x/y.go", "killed": 0, "timedOut": 0, "survived": 0 }],
  "survivors": [{ "path": "pkg/x/y.go", "line": 12, "op": "< to <=" }] }
```

`score` = (killed + timedOut) / (killed + timedOut + survived); `invalid` (a mutant that does not compile)
is counted but excluded. A run with no mutants writes `score: null`.

### Task 1: Run metrics module
**Depends on:** none
**Files:** `scripts/bench/runmetrics.mjs`, `scripts/bench/runmetrics.test.mjs`

**What to build:** the per-run numbers the bench and the real-run comparison read, from the packaged store
(`%LOCALAPPDATA%/dev.arc.app/data/db/waveterm.db`, read-only via `node:sqlite`, BLOB `data` decoded before
`JSON.parse`) and the `~/.claude/projects` transcripts. Port the logic of
`.superpowers/dag-measure/planskill-compare.mjs` (gitignored scratch; read it there): a run's dag is the
`db_dag` row whose `runid` is the run; its children are the `db_run` rows whose `dagoref` is that dag's
oid, classified by goal prefix (worker, task reviewer, plan reviewer, final verifier); cost is the
list-price estimate over each session's transcript and its subagents, deduplicated by message id, with that
script's price table; plan words are the dag's preamble plus every task description; Final round 1 is the
`final-step` event with `step: "final"` and round 1, `ok` deciding pass or fail. A plan passed in with
`--plan` (goal's first line contains "Implementation Plan", or the plan path exists at the run's base
commit) is marked not lead-written.

CLI: `node scripts/bench/runmetrics.mjs <runId>... [--json]` prints one row per run;
`node scripts/bench/runmetrics.mjs --since <YYYY-MM-DD>` prints the real-run comparison (lead-written,
done, dag-backed orchestrator runs, grouped by effective plan skill: medians and per-task totals as the
scratch script prints). `--db <path>` and `--transcripts <dir>` override the two sources.

**Interfaces:** `export function runRow(db, runId, transcriptIndex)` returns
`{ runId, planSkill, leadWrotePlan, tasks, width, planWords, planReviewRounds, asks, reviewFails, verifyFails, finalRound1: "passed"|"failed"|null, finalRounds, minutes, cost: { lead, worker, taskReviewer, planReviewer, verifier }, totalCost }`;
`width` is the most tasks running at once (overlapping `task-spawned`..`task-done` spans of the run's events),
`planReviewRounds` the dag's `planreview.round`;
`export function openStore(path)` and `export function indexTranscripts(dir)` build the two arguments.
`planSkill` is `EffectivePlanSkill`'s reading: an empty stored value is `writing-plans`.

**Acceptance:**
- given a fixture store and transcript dir, `runRow` returns the counts, width, Final outcome and per-role
  cost the fixture's events and usage lines imply, with a duplicated message id counted once
- a run with no dag row returns `null`; a run with no `final-step` event has `finalRound1: null`
- `--since` excludes runs started from a plan file and groups an empty stored plan skill as `writing-plans`

### Task 2: Go mutator
**Depends on:** none
**Files:** `cmd/gomutate/main.go`, `cmd/gomutate/mutate.go`, `cmd/gomutate/mutate_test.go`

**What to build:** `go run ./cmd/gomutate --dir <tree> --base <sha> [--max 200] [--seed 1] [--timeout 120s]`
scores how well a tree's tests catch changes to the Go lines it added since `base`. It mutates only lines
added or changed in `git diff base..HEAD` of non-test `.go` files, skipping files with a `Code generated`
header. Operators, stdlib `go/ast` only: relational (`<`↔`<=`, `>`↔`>=`), equality (`==`↔`!=`), logical
(`&&`↔`||`), arithmetic (`+`↔`-`, `*`↔`/`), boolean literal flip, and negating an `if` condition. Each
mutant is written to a temp copy and tested with `go test -overlay <json> <the file's package>`, so the tree
is never edited; a non-zero test exit kills it, the timeout counts as timedOut, a build failure counts as
invalid. Above `--max` mutants it tests a seeded random sample. Prints the shared mutation JSON on stdout.

**Acceptance:**
- on a fixture module, a mutant on a line a test asserts is killed and one on an unasserted line survives
- lines outside the diff, `_test.go` files and generated files produce no mutants
- a mutant that fails to compile is counted invalid and left out of `score`
- the tree's files are byte-identical after a run; the same `--seed` picks the same sample

### Task 3: TS mutation wrapper
**Depends on:** none
**Files:** `scripts/bench/tsmutate.mjs`, `scripts/bench/tsmutate.test.mjs`

**What to build:** `node scripts/bench/tsmutate.mjs --dir <tree> --base <sha> --out <file>` runs Stryker with
the vitest runner on the `.ts`/`.tsx` lines added or changed in `git diff base..HEAD`, excluding test files
and the generated files AGENTS.md lists (`frontend/app/store/wshclientapi.ts`,
`frontend/app/store/services.ts`, `frontend/types/gotypes.d.ts`, `frontend/types/waveevent.d.ts`). Stryker
runs through `npx -y -p @stryker-mutator/core@<pinned> -p @stryker-mutator/vitest-runner@<pinned>`, with
versions pinned to the latest at build time and a config generated into a temp dir, so `package.json` and the
lockfile do not change. Each changed range becomes a `mutate` entry (`path:start-end`). Stryker's JSON report
is converted to the shared mutation JSON shape (Killed and Timeout as killed/timedOut, Survived and
NoCoverage as survived, CompileError and RuntimeError as invalid).

**Acceptance:**
- a diff turns into the `mutate` ranges of exactly its changed non-test, non-generated TS lines
- a Stryker JSON report fixture converts to the shared shape with the counts and `score` above
- a diff with no TS lines writes `score: null` without starting Stryker

### Task 4: Replay harness
**Depends on:** none
**Files:** `scripts/bench/replay.mjs`, `scripts/bench/replay.test.mjs`, `scripts/bench/plan-skill-picks.json`

**What to build:** `node scripts/bench/replay.mjs start --bench <dir> --pick <id>` launches one pair: for each
arm (`plan`, then `writing-plans`) it creates `<bench>/wt/<pick>-<arm>` as a git worktree of the main checkout
on a new branch `bench/<pick>-<arm>` at the pick's base, links it with
`node scripts/worktree-junctions.mjs prepare`, copies the spec from `<specCommit>:<specPath>` to
`<bench>/specs/<pick>.md`, sets `run:planskill` to the arm, starts the run, and restores the setting. The
setting is set only for the seconds between the flip and the run's creation; it lives in the packaged app's local `settings.json` (`%LOCALAPPDATA%/dev.arc.app/config`), which
overrides the vault layer: the harness adds the key and afterwards restores the file's prior state (the key
removed if it was absent), in a `finally`, parsing and rewriting JSON so every other key is kept. The run
starts as `wsh runs start "Build <spec H1>." --mode orchestrator --project <worktree> --spec <abs spec>
[--prototype <abs canvas>] --runtime claude --model opus --worker-runtime claude --worker-model opus
--reviewer-runtime claude --reviewer-model opus --autonomous --parallelism 3 --json`, run with the worktree
as its working directory (so the run works in that worktree and lands on its branch, never on main), with no
`--effort`.
After start it reads `wsh runs show <id> --json`: a recorded plan skill other than the arm cancels the run
and exits non-zero. It appends the row to `runs.json`, with `arcBuild` read from the installed
`%LOCALAPPDATA%/Arc/bin/wavesrv.x64.exe` (its BuildTime string); `start` refuses when an earlier row's
`arcBuild` differs. `status --bench <dir>` prints each row's run status; `cleanup --bench <dir>` removes the
worktrees with `task worktree:cleanup -- <path>`.

`plan-skill-picks.json` pins the three picks (the prototype path is relative to the main checkout):

| id | original run | base | specCommit | specPath | prototype |
|---|---|---|---|---|---|
| `resource` | f72341e4 | `d8266279142f6758902a117eedd2a42c8f21477a` | `9598fd5c5ba9045f5b2b9312427c5e8c637d2945` | `docs/superpowers/specs/2026-11-12-arc-resource-management-design.md` | none |
| `pwa` | 2ce13736 | `d71af8f766a5bd7e49553ff285350aeb3c93deff` | `717959cbdd5f5da84442efec100bbb6311cc207e` | `docs/superpowers/specs/2026-11-03-arc-pwa-more-design.md` | `.superpowers/design/arc-pwa-rc/project/Cockpit.dc.html` |
| `rendered` | 4842b792 | `23f9fc2e238c5f4f03fd47024b7007b6496159de` | `23f9fc2e238c5f4f03fd47024b7007b6496159de` | `docs/superpowers/specs/2026-11-10-rendered-view-better-design.md` | `.superpowers/design/rendered-view-better/project/NowLine.dc.html` |

**Acceptance:**
- setting and restoring `run:planskill` keeps every other key, and restores an absent key as absent
- the start command line for a pick carries the pinned route, `--autonomous`, `--parallelism 3`, the spec and
  the prototype when the pick has one, and never `--effort`
- a recorded plan skill that differs from the arm, or an `arcBuild` that differs from the first row's, fails
  `start` with a message naming both values
- an unknown pick id or a pick missing a field is refused before any worktree is created

### Task 5: Blind pairwise review
**Depends on:** none
**Files:** `scripts/bench/blindreview.mjs`, `scripts/bench/blindreview.test.mjs`, `scripts/bench/blindreview-prompt.md`

**What to build:** `node scripts/bench/blindreview.mjs --bench <dir> --settings <claude settings.json>` judges
each pick's two finished arms against its spec without knowing which is which. Each arm's diff is
`git diff <base>..bench/<pick>-<arm>` excluding `docs/superpowers/plans/` and `.superpowers/` (the plan's
form would reveal the skill). The two diffs go to `blind/<pick>-X.diff` and `-Y.diff` in a random order whose
key is written to `results/blind-key.json` and read only after every verdict is in. Each pick is judged twice,
X shown first and then Y shown first, by headless `claude -p --model claude-opus-5-5 --tools "" --settings
<file>` with the session env stripped (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_ENTRYPOINT` and the other `CLAUDE_CODE_*` session variables) and
`CLAUDE_CODE_PROMPT_CACHE_TTL=5m`, so it runs on the API key the settings file supplies, not a login. The
prompt (`blindreview-prompt.md`: the spec and both diffs; judge spec coverage, correctness, how well the tests
prove the behaviour, simplicity) asks for a last line of JSON `{"winner": "X"|"Y"|"tie", "why": "..."}`. An
arm wins a pick only when both orders pick it; anything else is a tie. Writes `results/blind.json`:
`{ <pick>: { first: "X"|"Y"|"tie", second: "X"|"Y"|"tie", winner: "plan"|"writing-plans"|"tie" } }`.

**Acceptance:**
- the diff for an arm leaves out paths under `docs/superpowers/plans/` and `.superpowers/`
- the last-line verdict parses from a reply with prose before it; a reply without one is an error naming the
  pick and order, not a tie
- combining two orders gives the arm when both agree and `tie` otherwise, unblinded through the key

### Task 6: Verdict
**Depends on:** Task 1 (imports `runRow`, `openStore`, `indexTranscripts`)
**Files:** `scripts/bench/verdict.mjs`, `scripts/bench/verdict.test.mjs`

**What to build:** `node scripts/bench/verdict.mjs --bench <dir>` joins `runs.json`, each run's `runRow`, the
mutation files and `results/blind.json`, prints one table (per pick and arm: cost by role, minutes, tasks,
plan words, asks, review and verify fails, Final round 1, Final rounds, Go and TS mutation score) and then the
decision, applying Decision 9 exactly (the table also shows width and plan-review rounds, which decide
nothing):
- **blind:** `plan` wins at least 2 of the 3 picks in `blind.json`
- **Final:** `plan`'s count of round-1 Final passes is at least `writing-plans`'
- **mutation:** `plan`'s pooled score (killed + timedOut over killed + timedOut + survived, summed over every
  mutation file of that arm, Go and TS together) is at least `writing-plans'`; an arm with no mutants on
  either side skips this term
- **rework:** `plan`'s sum of review fails + verify fails + (Final rounds - 1) over its runs is at most
  `writing-plans'`

All four hold: the default stays `plan`. Otherwise, a tie included: `writing-plans`. It prints each term with
both arms' values and whether it held. A missing input (a run not done, a missing mutation file, no
`blind.json`) stops it with the missing paths named.

**Acceptance:**
- the rule function returns `plan` only when all four terms hold, and `writing-plans` for 1 blind win, for a
  worse Final count, for a lower pooled mutation score, for more rework, and for a blind tie on 2 picks
- pooling sums counts across files before dividing (not an average of scores)
- a bench with a missing mutation file exits non-zero and names the file
