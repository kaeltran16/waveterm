# Plan-skill bench

Tools for the replay bench that sets the default plan skill (`plan` vs `writing-plans`). The rule is spec
`docs/superpowers/specs/2026-11-16-slim-superpowers-design.md`, Decisions 8 and 9. The bench is run by hand,
from an Arc terminal (`wsh` needs its RPC environment), on one installed Arc build.

## Running it

Bench dir: `~/arc-bench/plan-skill-2026-11-17`. Picks are pinned in `plan-skill-picks.json`.

1. `node scripts/bench/replay.mjs start --bench <dir> --pick <id>` for each pick: two autonomous runs, one per
   arm, each in its own worktree. `replay.mjs status --bench <dir>` shows them.
2. Once every run is done, score each arm's tree against the pick's base:
   `go run ./cmd/gomutate --dir <bench>/wt/<pick>-<arm> --base <base> > <bench>/mutation/<pick>-<arm>-go.json`, and
   `node scripts/bench/tsmutate.mjs --dir <bench>/wt/<pick>-<arm> --base <base> --out <bench>/mutation/<pick>-<arm>-ts.json`.
3. `node scripts/bench/blindreview.mjs --bench <dir> --settings <claude settings.json>` (bills real model calls).
4. `node scripts/bench/verdict.mjs --bench <dir>` prints the table and the default the rule picks.
5. `node scripts/bench/replay.mjs cleanup --bench <dir>` once the results are kept.

`node scripts/bench/runmetrics.mjs --since <YYYY-MM-DD>` is the separate real-run comparison (report only).

## Bench dir layout

```
<bench>/runs.json                      [{pick, arm, runId, base, branch, worktree, spec, arcBuild, startedTs}]
<bench>/specs/<pick>.md                the spec text, copied from its source commit (the judges' copy; each run gets
                                       its own at the spec's repo path in its worktree: the engine refuses one outside)
<bench>/wt/<pick>-<arm>/               the arm's git worktree (branch bench/<pick>-<arm>)
<bench>/mutation/<pick>-<arm>-go.json  gomutate's output
<bench>/mutation/<pick>-<arm>-ts.json  tsmutate's output
<bench>/blind/<pick>-X.diff, -Y.diff   the shuffled diffs
<bench>/results/blind-key.json         the sealed key
<bench>/results/blind.json             the unblinded verdicts, {pick: {first, second, winner}}
```

`arcBuild` is the SHA-256 of the installed `wavesrv.x64.exe`; `start` refuses a different build.

## Mutation JSON

Shared by `gomutate`, `tsmutate` and `verdict`:

```json
{ "tool": "gomutate|stryker", "base": "<sha>", "head": "<sha>",
  "killed": 0, "timedOut": 0, "survived": 0, "invalid": 0, "score": 0.0,
  "files": [{ "path": "pkg/x/y.go", "killed": 0, "timedOut": 0, "survived": 0 }],
  "survivors": [{ "path": "pkg/x/y.go", "line": 12, "op": "< to <=" }] }
```

`score` = (killed + timedOut) / (killed + timedOut + survived); `invalid` (a mutant that does not compile) is
counted but left out. No mutants writes `score: null`. `verdict` pools an arm's counts across all its files, Go
and TS together, before dividing.
