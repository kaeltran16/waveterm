# Orchestrator merge train, fix round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/... ./cmd/wsh/...`
**Setup:** `task worktree:prepare`
**Check:** `go vet ./pkg/orchestrate/... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /dev/null ./cmd/wsh/`

**Goal:** Fix the two defects the final stage found on the merged result: the package split in `scripts/verify.mjs` has no test, and a lane a bisect lands as a pass keeps a failing run's output as its gate.

**Architecture:** Two independent fixes. `scripts/verify.mjs` gets an exported `partitionPackages` that `goTest` uses, tested at the threshold. `judgeBatch` in `pkg/orchestrate/verify.go` carries the output of the run that passed the landed tips in a new `batchOutcome.passedOutput`, which `recordBatchVerifyLocked` records on them. The round also adds the batch-of-one test the original plan's Task 2 listed but did not land.

**Tech Stack:** Go (`pkg/orchestrate`), Node ESM script plus vitest (`scripts/verify.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-27-orchestrator-merge-train-design.md`

## Global Constraints

- Do not edit `pkg/orchestrate/engine.go`, `wake.go`, `liveness.go`, `digest.go`, `review.go` or `scheduler.go`: run 5952d714 is changing them.
- No new task state, run-event kind, wshrpc type, waveobj field or generated file.
- `SHARD_MIN_TESTS = 100`, `SHARDS = 4`: unchanged.
- Go tests in `pkg/orchestrate` need cgo: run them with `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu"`. No `CGO_CFLAGS`.
- Never run prettier on `scripts/*.mjs`; keep their 4-space indentation.
- Comments say why, lower case, only where needed. Match the surrounding code's naming and idiom.
- Commit messages: `type(scope): description`, no attribution trailers.

## Review Focus

- A package with exactly `SHARD_MIN_TESTS` tests shards; one with one fewer runs plain. Task 1 test.
- A package `go list` could not resolve (no dir) stays plain and its tests are never counted, so `go test` reports why. Task 1 test.
- A bisect that lands tips must record the passing prefix's output on them, never the failing run's `--- FAIL` tail. Task 2 test.
- A plain pass (no bisect) still records the batch run's output on every tip. Covered by the existing batch tests; Task 2 must not break them.
- A failing batch of one runs Verify once and makes no bisect tree. Task 2 test.

---

### Task 1: Extract and test the package split in verify.mjs
**Depends on:** none

**Files:**
- Modify: `scripts/verify.mjs` (`goTest`, around line 169)
- Test: `scripts/verify.test.mjs` (the `sharding` describe block)

**Interfaces:**
- Produces: `export function partitionPackages(pkgs, countOf)` where `pkgs` is `{ importPath, dir }[]` (as `goPackages` returns) and `countOf(dir)` returns a package's top-level test count. Returns `{ sharded, plain }`, both arrays of the same package objects, in input order.

- [ ] **Step 1: Write the failing tests**

Add `partitionPackages` to the import list at the top of `scripts/verify.test.mjs`, and add these cases at the end of the `describe("sharding", ...)` block:

```js
    it("shards a package at the threshold and runs one below it plain", () => {
        const pkgs = [
            { importPath: "m/pkg/a", dir: "/a" },
            { importPath: "m/pkg/b", dir: "/b" },
        ];
        const counts = { "/a": SHARD_MIN_TESTS, "/b": SHARD_MIN_TESTS - 1 };
        const { sharded, plain } = partitionPackages(pkgs, (dir) => counts[dir]);
        expect(sharded.map((p) => p.importPath)).toEqual(["m/pkg/a"]);
        expect(plain.map((p) => p.importPath)).toEqual(["m/pkg/b"]);
    });
    it("runs a package go list could not resolve plain, without counting its tests", () => {
        const seen = [];
        const { sharded, plain } = partitionPackages([{ importPath: "m/pkg/gone", dir: "" }], (dir) => {
            seen.push(dir);
            return SHARD_MIN_TESTS;
        });
        expect(sharded).toEqual([]);
        expect(plain.map((p) => p.importPath)).toEqual(["m/pkg/gone"]);
        expect(seen).toEqual([]);
    });
```

`SHARD_MIN_TESTS` must also be in that import list if it is not already.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run scripts/verify.test.mjs`
Expected: FAIL, `partitionPackages` is not exported.

- [ ] **Step 3: Extract `partitionPackages` and use it in `goTest`**

Add after `goSummary` in `scripts/verify.mjs`:

```js
// partitionPackages splits the packages into those whose tests are dealt across SHARDS processes and those run by
// one plain go test. a package go list could not resolve has no dir; go test reports why.
export function partitionPackages(pkgs, countOf) {
    const sharded = pkgs.filter((p) => p.dir && countOf(p.dir) >= SHARD_MIN_TESTS);
    const plain = pkgs.filter((p) => !sharded.includes(p));
    return { sharded, plain };
}
```

In `goTest`, replace the comment and the two filter lines:

```js
    const pkgs = goPackages(args);
    // a package go list could not resolve has no dir; go test reports why
    const sharded = pkgs.filter((p) => p.dir && countTopLevelTests(testSource(p.dir)) >= SHARD_MIN_TESTS);
    const plain = pkgs.filter((p) => !sharded.includes(p)).map((p) => p.importPath);
    if (plain.length > 0) {
        run("go", ["test", ...plain]);
    }
```

with:

```js
    const { sharded, plain } = partitionPackages(goPackages(args), (dir) => countTopLevelTests(testSource(dir)));
    if (plain.length > 0) {
        run("go", ["test", ...plain.map((p) => p.importPath)]);
    }
```

The rest of `goTest` (the `sharded` loop) is unchanged.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run scripts/verify.test.mjs`
Expected: PASS, 20 tests.

Then check the script end to end on a sharded and a plain package:
Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/orchestrate/ ./pkg/jarvis/`
Expected: exit 0; the output shows one `go test` line for `pkg/jarvis` and an `ok` summary line for `pkg/orchestrate`. (Unscoped this also runs tsc and vitest; that is expected.)

- [ ] **Step 5: Commit**

```bash
git add scripts/verify.mjs scripts/verify.test.mjs
git commit -m "test(verify): pin the shard threshold by extracting partitionPackages"
```

### Task 2: A lane a bisect lands keeps the passing run's output
**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/verify.go` (`batchOutcome` around line 196, `judgeBatch` around line 223, `recordBatchVerifyLocked` around line 409)
- Test: `pkg/orchestrate/verifybisect_test.go`

**Interfaces:**
- Consumes: `judgeBatch`, `batchOutcome`, `recordBatchVerifyLocked`, and the test helpers `newFakeLead`, `newMergeFixture`, `threeLaneBatch`, `stubVerifyBreaksOn`, `awaitVerify`, `verifyCmd`, `worktreeDir`, all as they are on this branch.
- Produces: `batchOutcome.passedOutput string`, the output of the run that passed `passed`.

- [ ] **Step 1: Write the failing assertion and the missing batch-of-one test**

In `TestBisectFindsTheMiddleLaneAndLandsTheOneBefore`, after the existing `VerifyOutput` check (the `if !strings.Contains(g.Tasks[1].VerifyOutput, ...` block), add:

```go
	// t-0 landed on the bisect step that tested it alone, which passed with "ok"
	if g.Tasks[0].VerifyOutput != "ok" {
		t.Fatalf("a lane the bisect lands keeps the output of the run that passed it, got %q", g.Tasks[0].VerifyOutput)
	}
```

Add this test to `pkg/orchestrate/verifybisect_test.go` (the original plan's Task 2 listed it; it did not land):

```go
func TestABatchOfOneFailsWithoutBisecting(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.land(t)
	f.finish(t, "t-0")
	f.laneCommit(t, "t-0", "t-0.txt")
	calls := stubVerifyBreaksOn(t, "t-0.txt", "", nil)
	await := awaitVerify(t)

	AutoMergeReady(f.ctx, f.dagID)
	await()

	if got := f.dag(t).Tasks[0].State; got != TaskState_VerifyFailed {
		t.Fatalf("want verify-failed, got %s", got)
	}
	if n := len(calls.list()); n != 1 {
		t.Fatalf("a batch of one runs Verify once, got %d", n)
	}
	if _, err := os.Stat(worktreeDir(f.projectPath(t), f.ownerID+"-bisect")); !os.IsNotExist(err) {
		t.Fatalf("no bisect tree is made, stat err %v", err)
	}
	want := "Verify failed after merging task t-0 (exit 1)."
	if len(lead.sends) != 1 || !strings.Contains(lead.sends[0], want) {
		t.Fatalf("today's wake, got %q", lead.sends)
	}
}
```

If the wake text on this branch differs from `want` (check `verifyFailedWake` in `queue.go`), use the text `verifyFailedWake("t-0", "exit 1")` produces; do not change `queue.go`.

- [ ] **Step 2: Run the tests**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -run 'TestBisectFindsTheMiddleLane|TestABatchOfOne' -count=1`
Expected: `TestBisectFindsTheMiddleLaneAndLandsTheOneBefore` FAILs with `got "--- FAIL: TestBroken (t-1.txt)"`. `TestABatchOfOneFailsWithoutBisecting` passes already (it pins existing behavior).

- [ ] **Step 3: Carry the passing run's output**

In `pkg/orchestrate/verify.go`, change the `batchOutcome` comment and struct:

```go
// batchOutcome is a batch's verdict: passed tips go done, failed goes verify-failed ("" on a pass), and held tips stay
// verifying with the held line. output and err come from the run that judged failed, or the batch's run on a pass;
// passedOutput comes from the run that passed the passed tips. reason replaces the wake reason when it is not empty,
// and bisect counts the extra Verify runs.
type batchOutcome struct {
	batch, passed []string
	failed        string
	held          []string
	output        string
	passedOutput  string
	err           error
	reason        string
	bisect        int
	cancelled     bool // the claim was cancelled mid-judging: nothing is recorded
}
```

In `judgeBatch`, set it on a pass:

```go
	if verr == nil {
		out.passed, out.passedOutput = out.batch, output
		return out
	}
```

declare it beside `failOut`:

```go
	failOut, failErr := output, verr
	passOut := ""
```

record it where a step passes:

```go
			if err == nil {
				lo, passOut = mid, stepOut
				continue
			}
```

and set `out.passedOutput = passOut` in both places `out.passed` is set after the bisect: in the `stepErr != nil` branch and in the clean-bisect lines at the end. Both slice `out.batch[:lo]` (at the end of a clean bisect `hi-1 == lo`), so the step that last set `lo` is the one that passed them; when `lo` is 0 `passed` is empty and `passOut` is unused.

In `recordBatchVerifyLocked`, record it on the passed tips:

```go
			t.State, t.VerifyError, t.VerifyOutput = TaskState_Done, "", out.passedOutput
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -run 'Bisect|BatchOfOne|Batch|Verify|Continue' -count=1`
Expected: PASS.

Then the package, sharded:
Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/orchestrate/`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add pkg/orchestrate/verify.go pkg/orchestrate/verifybisect_test.go
git commit -m "fix(orchestrate): record the passing run's output on lanes a bisect lands"
```
