# Orchestrator speed Implementation Plan

**Verify:** `go test ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/waveobj/... && npx vitest run scripts`
**Setup:** `task worktree:prepare`
**Check:** `go build ./... && go vet ./pkg/orchestrate/... ./pkg/jarvis/... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the serialized merge-and-Verify wait of orchestrator runs (findings 23 and 27), name a base broken
before any task ran (finding 33), and check the run merged with its moved base before it lands.

**Architecture:** The engine gives every per-merge Verify an `ARC_VERIFY_CHANGED` file listing the paths the
merge changed, so a Verify that reads it can test only what those paths can break. The final stage runs Verify
once more with no scope, on the merged result, so the full suite still runs once per run. A dependency is
satisfied at merge, not at Verify pass. The merge queue lands first the lane most pending tasks wait on. The plan's
Check runs once on the base at submit. The land's re-check runs on the run merged with its base.

**Tech Stack:** Go (`pkg/orchestrate`, `pkg/waveobj`, `pkg/jarvis`), Node ESM (`scripts/verify.mjs`), vitest, git.

**Spec:** `docs/orchestrator-findings-2026-09-25.md`: findings 23, 27 and 33, and the "Handoff" section's item 1.
One deliberate change from the handoff: the handoff moves the full suite into **Check**. Check is also what every
worker runs before `complete` (`workerContract`, `pkg/orchestrate/engine.go`), so a full-suite Check would put
the suite back into each of five parallel workers, the 59% of worker time finding 27 measured. Instead, the full
suite stays in **Verify**, which runs scoped per merge and unscoped once in the final stage.

## Global Constraints

- Go is the source of truth for wire types. After changing a `waveobj` type, run `task generate` and commit the
  regenerated files. Never hand-edit `frontend/types/gotypes.d.ts` or any other generated file.
- New struct fields are `omitempty`, so stored rows keep decoding.
- Tasks run in parallel. Add fields, cases and doc lines **next to the related existing lines**, never
  appended at the end of a shared struct, switch or section, and don't reformat code you didn't change.
- Run `gofmt -w` only on the Go files you touched (HEAD is not gofmt-clean).
- Never run prettier on `scripts/*.mjs`: those files are hand-formatted with 4-space indents.
- The env var is `ARC_VERIFY_CHANGED` exactly. Its value is a path with forward slashes (Git Bash eats the
  backslashes of an unquoted Windows path), to a file with one repo-relative path per line.
- A Verify that ignores `ARC_VERIFY_CHANGED` must behave exactly as today. Every existing plan's Verify does.
- Comments explain why, not what, in lower case, matching the package's existing style.

## Review Focus

1. A plan whose Verify ignores `ARC_VERIFY_CHANGED` (every plan written so far) runs its full command at each
   merge, as today, and once more in the final stage. The final stage now costs one full Verify more. Task 1
   pins that the command string is unchanged.
2. A merge whose changed paths cannot be listed (a stubbed or missing commit, a git error) runs Verify
   **unscoped**, never skipped and never failed. Task 1 pins it.
3. A dependent that started at its dependency's merge must not merge while that dependency's Verify is
   running or failed. Task 3 pins it.
4. The land's re-check must leave the landing tree at the branch head with no merge in progress: after a
   pass, a failing check, and a conflict. Task 6 pins all three.
5. `scripts/verify.mjs` gets deleted Go files, a changed `go.mod`, docs-only merges and CRLF line endings in
   the list file. Task 2 pins each.

---

### Task 1: Scope the per-merge Verify, and run it unscoped in the final stage

**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/plancmd.go` (the `runPlanCommand` seam takes env)
- Modify: `pkg/orchestrate/verify.go` (`startVerify` scopes its run)
- Modify: `pkg/orchestrate/final.go` (`runFinalSteps` runs Verify after Check; the `FinalState_Checking` comment)
- Modify: `pkg/orchestrate/land.go`, `pkg/orchestrate/final.go`, and every other `runPlanCommand(` caller: pass `nil` env
- Modify: `pkg/orchestrate/setup_test.go` (record env in `planCall`)
- Modify: `pkg/orchestrate/final_test.go` (fixtures that pass `verifyCmd`)
- Test: `pkg/orchestrate/landing_test.go`, `pkg/orchestrate/final_test.go`
- Modify: `pkg/jarvis/plan.go` (`PlanFormat` prose), `pkg/waveobj/wtype.go` (the `Verify` field comment),
  `docs/orchestrator-guide.md` (the plan-commands bullets and "The final stage" steps)

**Interfaces:**
- Produces: `runPlanCommand func(ctx context.Context, dir, command string, env []string, timeout time.Duration, progress planProgress) (string, error)`
- Produces: `const verifyChangedEnv = "ARC_VERIFY_CHANGED"`
- Produces: `func changedFilesEnv(ctx context.Context, dir, since, to, name string) []string`. It lists
  `git diff --name-only --no-renames since [to]` in dir (`to == ""` means the working tree), writes the list to
  `<os.TempDir()>/arc-verify/<name>.txt`, and returns `[]string{"ARC_VERIFY_CHANGED=<path with forward slashes>"}`,
  or nil when it can't.
- Produces: `planCall{dir, command string; env []string}` and `func envValue(env []string, key string) string`
  in `setup_test.go`.

- [ ] **Step 1: Thread env through the seam**

In `plancmd.go`, delete `execPlanCommand` and make the seam the env-taking function:

```go
// runPlanCommand runs a plan command through a POSIX shell in dir, with env added to its environment, and
// returns the tail of its output, on a pass as well as a failure. A var so engine tests can script Setup and
// Verify without running anything; a stub calls progress itself to script mid-run output.
var runPlanCommand = execPlanCommandEnv

// RunSetup runs a plan's Setup command in dir under SetupTimeout and returns its output tail.
func RunSetup(ctx context.Context, dir, command string) (string, error) {
	return runPlanCommand(ctx, dir, command, nil, SetupTimeout, nil)
}
```

Find every caller with `grep -rn "runPlanCommand(" pkg` and pass `nil` as the new fourth argument
(`final.go` Setup and Check, `land.go` `reverifyHold`, `verify.go` `startVerify`; Step 3 replaces the last).
In `setup_test.go`:

```go
type planCall struct {
	dir, command string
	env          []string
}

// envValue is the value env gives key, or "".
func envValue(env []string, key string) string {
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key {
			return v
		}
	}
	return ""
}
```

and in `stubPlanCommandProgress`:

```go
	runPlanCommand = func(ctx context.Context, dir, command string, env []string, _ time.Duration, progress planProgress) (string, error) {
		p.mu.Lock()
		p.calls = append(p.calls, planCall{dir, command, env})
		p.mu.Unlock()
		return fn(ctx, dir, command, progress)
	}
```

Run: `go build ./pkg/orchestrate/ && go vet ./pkg/orchestrate/`
Expected: clean. Fix any `planCall{dir, command}` literal the compiler names by adding `nil`.

- [ ] **Step 2: Write the failing scope tests**

Add to `landing_test.go`, next to `TestVerifyRunsInTheLandingTree`:

```go
func TestVerifyIsScopedToWhatTheMergeChanged(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.land(t)
	f.finish(t, "t-0")
	f.laneCommit(t, "t-0", "feature.txt")
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	await := awaitVerify(t)

	if err := MergeTask(f.ctx, f.channel, f.ownerID, "t-0"); err != nil {
		t.Fatal(err)
	}
	await()
	got := calls.list()
	if len(got) != 1 || got[0].command != verifyCmd {
		t.Fatalf("want the plan's Verify command unchanged, once, got %+v", got)
	}
	path := envValue(got[0].env, verifyChangedEnv)
	if path == "" || strings.Contains(path, `\`) {
		t.Fatalf("Verify runs with %s set to a forward-slash path, env %q", verifyChangedEnv, got[0].env)
	}
	if lines := strings.Fields(readFile(t, path)); !reflect.DeepEqual(lines, []string{"feature.txt"}) {
		t.Fatalf("the list names what the merge changed, got %q", lines)
	}
}

// a merge the engine cannot diff still gets its Verify: unscoped is the safe direction
func TestVerifyRunsUnscopedWhenTheMergeCannotBeListed(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha) // "sha-1" is no commit
	calls := stubPlanCommand(t, func(context.Context, string, string) error { return nil })
	await := awaitVerify(t)

	if err := MergeTask(f.ctx, f.channel, f.ownerID, "t-0"); err != nil {
		t.Fatal(err)
	}
	await()
	got := calls.list()
	if len(got) != 1 || envValue(got[0].env, verifyChangedEnv) != "" {
		t.Fatalf("want one unscoped Verify, got %+v", got)
	}
	if f.dag(t).Tasks[0].State != TaskState_Done {
		t.Fatalf("the Verify ran and passed, got %s", f.dag(t).Tasks[0].State)
	}
}
```

Run: `go test ./pkg/orchestrate/ -run 'TestVerifyIsScoped|TestVerifyRunsUnscoped' -count=1`
Expected: `TestVerifyIsScopedToWhatTheMergeChanged` FAILS (undefined `verifyChangedEnv`, then empty env).

- [ ] **Step 3: Implement the scope**

In `verify.go`:

```go
// verifyChangedEnv names the file a scoped Verify reads: one repo-relative path per line, what the merge
// changed. A Verify that ignores it runs whole, which is what every plan did before it existed.
const verifyChangedEnv = "ARC_VERIFY_CHANGED"

// changedFilesEnv lists the paths that differ between since and to in dir (to "" is the working tree) and
// returns the env entry naming the list. nil when they cannot be listed: Verify then runs unscoped, which
// costs time and never a missed test.
func changedFilesEnv(ctx context.Context, dir, since, to, name string) []string {
	if since == "" {
		return nil
	}
	args := []string{"diff", "--name-only", "--no-renames", since}
	if to != "" {
		args = append(args, to)
	}
	out, err := git(ctx, dir, args...)
	if err != nil {
		log.Printf("listing the paths changed since %s in %s: %v", since, dir, err)
		return nil
	}
	path := filepath.Join(os.TempDir(), "arc-verify", name+".txt")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		log.Printf("writing the changed-path list %s: %v", path, err)
		return nil
	}
	if err := os.WriteFile(path, []byte(out+"\n"), 0o644); err != nil {
		log.Printf("writing the changed-path list %s: %v", path, err)
		return nil
	}
	// Git Bash eats the backslashes of an unquoted Windows path
	return []string{verifyChangedEnv + "=" + filepath.ToSlash(path)}
}

// verifyScopeEnv scopes a lane's Verify to what its squash commit, and any fix committed on top of it before a
// `--continue`, changed. The squash commit has one parent, so <commit>^ is the tree before the lane landed.
func verifyScopeEnv(ctx context.Context, channelID, dagID, taskID, tree string) []string {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return nil
	}
	task := taskByID(g, taskID)
	if task == nil || task.RunID == "" {
		return nil
	}
	child, err := wstore.GetRun(ctx, channelID, task.RunID)
	if err != nil || child.EndCommit == "" {
		return nil
	}
	return changedFilesEnv(ctx, tree, child.EndCommit+"^", "HEAD", dagID+"/"+taskID)
}
```

In `startVerify`'s goroutine, before `runPlanCommand`:

```go
		env := verifyScopeEnv(context.Background(), channelID, dagID, taskID, projectPath)
		output, verr := runPlanCommand(ctx, projectPath, command, env, VerifyTimeout, func(tail string) bool {
```

Add `"os"` to the imports.

Run: `go test ./pkg/orchestrate/ -run 'TestVerify' -count=1`
Expected: PASS, including every existing `TestVerify*`.

- [ ] **Step 4: Write the failing final-stage tests**

In `final_test.go`, add a constant and replace `verifyCmd` in the seven `finalFixture(t, verifyCmd, ...)` calls
with it. The final stage now runs Verify for real, and `task test` does not exist in the fixture repo:

```go
// passVerify is a Verify the final stage can run for real and pass.
const passVerify = "true"
```

Then add, next to `TestFinalCheckFailureFailsTheStageWithItsTailAndWakesTheLead`:

```go
func TestFinalRunsVerifyUnscopedAfterCheck(t *testing.T) {
	out := filepath.ToSlash(t.TempDir())
	verify := `test -z "$ARC_VERIFY_CHANGED" && test -f ` + out + `/check && echo verify > ` + out + `/verify`
	f := finalFixture(t, verify, "echo check > "+out+"/check", "")

	g := runFinal(t, f)

	if g.Final.Detail != "" {
		t.Fatalf("Check then an unscoped Verify pass, got %q", g.Final.Detail)
	}
	if _, err := os.Stat(filepath.Join(out, "verify")); err != nil {
		t.Fatalf("the final stage runs the plan's Verify, unscoped, after Check: %v", err)
	}
}

func TestFinalVerifyFailureFailsTheStage(t *testing.T) {
	f := finalFixture(t, "echo '--- FAIL: TestX'; exit 1", "", "")

	g := runFinal(t, f)

	if g.Final.State != FinalState_Failed || !strings.Contains(g.Final.Detail, "Verify `echo '--- FAIL: TestX'; exit 1` failed on the merged result (exit 1)") {
		t.Fatalf("a failing Verify fails the stage with its command and exit, got %s %q", g.Final.State, g.Final.Detail)
	}
	if !strings.Contains(g.Final.Detail, "--- FAIL: TestX") {
		t.Fatalf("Detail keeps the output, got %q", g.Final.Detail)
	}
}
```

Run: `go test ./pkg/orchestrate/ -run 'TestFinal' -count=1`
Expected: the two new tests FAIL (Verify never runs); every other `TestFinal*` passes.

- [ ] **Step 5: Run Verify in the final stage**

In `runFinalSteps`, directly after the Check block:

```go
	// per merge Verify tested only what each merge changed; the whole suite runs once, here, on the merged result.
	// Set empty rather than left out, so a value inherited from the server's own environment cannot scope it.
	if g.Verify != "" {
		unscoped := []string{verifyChangedEnv + "="}
		if out, err := runPlanCommand(ctx, tree, g.Verify, unscoped, VerifyTimeout, nil); err != nil {
			res.detail = fmt.Sprintf("Verify `%s` failed on the merged result (%s):\n%s", g.Verify, commandReason(err), out)
			return res
		}
	}
```

Change the state comment to `FinalState_Checking = "checking" // Check, Verify, then the Final command, are running`.

Run: `go test ./pkg/orchestrate/ -count=1`
Expected: PASS.

- [ ] **Step 6: Say it where plans are written and read**

`pkg/jarvis/plan.go`: replace the sentence "Verify runs the plan's full test suite after a task merges; Check is a
fast whole-project static check (for example typecheck plus go vet) that each worker runs itself, instead of
Verify, before it completes." with:

```go
	"Verify runs after each task merges, with " +
	"ARC_VERIFY_CHANGED naming a file that lists the paths the merge changed, one per line: a Verify that reads it " +
	"should test only what those paths can break, so the merge queue waits about a minute, not the whole suite. The " +
	"final stage runs Verify once more with ARC_VERIFY_CHANGED unset, on the merged result, where it should run " +
	"everything. Check is a fast whole-project static check (for example typecheck plus go vet) that each worker runs " +
	"itself, instead of Verify, before it completes. " +
```

(keep the surrounding lines as they are). Run `go test ./pkg/jarvis/ -run TestPlanFormat -count=1`: PASS.

`pkg/waveobj/wtype.go`, the `Verify, Setup and Check` comment: "Verify runs where lanes land after each squash
merge, scoped by ARC_VERIFY_CHANGED, and once unscoped in the final stage". No `task generate` is needed for a
comment change, but run it and commit whatever it changes.

`docs/orchestrator-guide.md`: in the plan-commands bullets (the "**Verify** runs where lanes land" bullet),
say Verify gets `ARC_VERIFY_CHANGED` at each merge and should test only what those paths can break, and that
the final stage runs it once unscoped. In "The final stage" steps, insert a step 2 "**Verify**, the plan's Verify
line with `ARC_VERIFY_CHANGED` unset, on the merged result (20-minute limit). A non-zero exit fails the stage."
and renumber Final and the verifier to 3 and 4.

- [ ] **Step 7: Close the shortcut hole**

`advanceFinal` goes straight to the verifier when `g.Check == "" && g.FinalCmd == ""`, which would now skip the
unscoped Verify. Change its condition to
`g.Check == "" && g.Verify == "" && g.FinalCmd == ""`, update the guide's sentence to "With no Check, no Verify
and no Final line, the stage goes straight to the verifier", and rerun:

Run: `go test ./pkg/orchestrate/ -run 'TestFinal' -count=1`
Expected: PASS. If `TestFinalWithNothingToRunPassesInTheTick` now fails because its fixture sets a Verify, set
that fixture's Verify to `""` so it still has nothing to run.

- [ ] **Step 8: Commit**

```bash
gofmt -l pkg/orchestrate pkg/jarvis pkg/waveobj   # only your files may appear; gofmt -w those
git add pkg/orchestrate pkg/jarvis/plan.go pkg/waveobj/wtype.go docs/orchestrator-guide.md frontend/types/gotypes.d.ts
git commit -m "perf(orchestrate): scope each merge's Verify to what it changed; run it whole in the final stage"
```

---

### Task 2: A scoped Verify script for this repo

**Depends on:** none

**Files:**
- Create: `scripts/verify.mjs`
- Test: `scripts/verify.test.mjs`
- Modify: `AGENTS.md` (the "Plans the engine runs" bullet)

**Interfaces:**
- Consumes: the `ARC_VERIFY_CHANGED` contract from the Global Constraints (Task 1 sets it; this task only reads it).
- Produces: `export function planVerify(changed, graph, universe, modulePath)` returning
  `{ goAll: boolean, goPkgs: string[], vitest: "none" | "all" | string[], tsc: boolean }`.
- Produces: `export function readChanged(text)`: the list file's lines, trimmed, `\r` stripped, blanks dropped,
  backslashes turned into slashes.
- CLI: `node scripts/verify.mjs <go package pattern>...`. The patterns are the Go packages Verify may test.
  With `ARC_VERIFY_CHANGED` unset it runs `go test <patterns>` and then `vitest run`. With it set it runs only
  what `planVerify` selects, and exits 0 with a line saying so when that is nothing.

`graph` is an array of `{ importPath, deps: string[], testImports: string[] }` for every package in the module
(`go list -e -f` over `./...`); `universe` is the set of import paths the patterns match.

- [ ] **Step 1: Write the failing tests**

`scripts/verify.test.mjs` (4-space indents, no prettier):

```js
import { describe, expect, it } from "vitest";
import { planVerify, readChanged } from "./verify.mjs";

const MOD = "github.com/wavetermdev/waveterm";
const graph = [
    { importPath: `${MOD}/pkg/util`, deps: [], testImports: [] },
    { importPath: `${MOD}/pkg/orchestrate`, deps: [`${MOD}/pkg/util`], testImports: [] },
    { importPath: `${MOD}/pkg/wshrpc`, deps: [`${MOD}/pkg/orchestrate`, `${MOD}/pkg/util`], testImports: [] },
    { importPath: `${MOD}/pkg/jarvis`, deps: [], testImports: [`${MOD}/pkg/testkit`] },
    { importPath: `${MOD}/pkg/testkit`, deps: [`${MOD}/pkg/util`], testImports: [] },
    { importPath: `${MOD}/pkg/filestore`, deps: [`${MOD}/pkg/util`], testImports: [] },
];
const universe = new Set(graph.map((p) => p.importPath).filter((p) => !p.endsWith("filestore") && !p.endsWith("testkit")));

describe("planVerify", () => {
    it("tests a changed package and every package that imports it, within the patterns", () => {
        const plan = planVerify(["pkg/util/strings.go"], graph, universe, MOD);
        expect(plan.goAll).toBe(false);
        expect(plan.goPkgs).toEqual([`${MOD}/pkg/util`, `${MOD}/pkg/orchestrate`, `${MOD}/pkg/wshrpc`, `${MOD}/pkg/jarvis`]);
    });
    it("follows a test-only import to the package whose tests use it", () => {
        expect(planVerify(["pkg/testkit/kit.go"], graph, universe, MOD).goPkgs).toEqual([`${MOD}/pkg/jarvis`]);
    });
    it("runs every pattern when go.mod or go.sum changed", () => {
        expect(planVerify(["go.sum"], graph, universe, MOD).goAll).toBe(true);
    });
    it("tolerates a deleted package", () => {
        expect(planVerify(["pkg/gone/gone.go"], graph, universe, MOD).goPkgs).toEqual([]);
    });
    it("typechecks and runs the related vitest files for a frontend change", () => {
        const plan = planVerify(["frontend/app/view/agents/runmodel.ts"], graph, universe, MOD);
        expect(plan).toMatchObject({ tsc: true, vitest: ["frontend/app/view/agents/runmodel.ts"], goPkgs: [] });
    });
    it("runs all of vitest for a config change", () => {
        expect(planVerify(["package.json"], graph, universe, MOD)).toMatchObject({ tsc: true, vitest: "all" });
    });
    it("runs vitest, not tsc, for a script change", () => {
        expect(planVerify(["scripts/cdp/final-verify.mjs"], graph, universe, MOD)).toMatchObject({ tsc: false, vitest: ["scripts/cdp/final-verify.mjs"] });
    });
    it("selects nothing for docs", () => {
        expect(planVerify(["docs/open-issues.md", "AGENTS.md"], graph, universe, MOD)).toEqual({ goAll: false, goPkgs: [], vitest: "none", tsc: false });
    });
});

describe("readChanged", () => {
    it("drops blanks and carriage returns and normalizes slashes", () => {
        expect(readChanged("pkg\\util\\a.go\r\n\r\ndocs/x.md\r\n")).toEqual(["pkg/util/a.go", "docs/x.md"]);
    });
});
```

Run: `npx vitest run scripts/verify.test.mjs`
Expected: FAIL (cannot resolve `./verify.mjs`).

- [ ] **Step 2: Implement `planVerify` and `readChanged`**

`scripts/verify.mjs`:

```js
// Verify for this repo's engine plans. At each merge the engine sets ARC_VERIFY_CHANGED to a file listing the
// paths the merge changed; this tests only what those paths can break. Unset (the final stage, or a human), it
// runs everything the patterns name.
//
// usage: node scripts/verify.mjs <go package pattern>...

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// a change to one of these can move any test's outcome
const FRONTEND_CONFIG = new Set(["package.json", "package-lock.json", "vitest.config.ts", "tsconfig.json"]);
const TS_FILE = /\.(ts|tsx)$/;
const JS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export function readChanged(text) {
    return text
        .split("\n")
        .map((l) => l.replace(/\r$/, "").trim().replace(/\\/g, "/"))
        .filter(Boolean);
}

export function planVerify(changed, graph, universe, modulePath) {
    const plan = { goAll: false, goPkgs: [], vitest: "none", tsc: false };
    const changedPkgs = new Set();
    const related = [];
    for (const path of changed) {
        if (path === "go.mod" || path === "go.sum") {
            plan.goAll = true;
        } else if (path.endsWith(".go")) {
            const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
            changedPkgs.add(dir ? `${modulePath}/${dir}` : modulePath);
        } else if (FRONTEND_CONFIG.has(path)) {
            plan.tsc = true;
            plan.vitest = "all";
        } else if (JS_FILE.test(path)) {
            plan.tsc ||= TS_FILE.test(path);
            related.push(path);
        }
    }
    if (plan.vitest !== "all" && related.length > 0) {
        plan.vitest = related;
    }
    if (!plan.goAll) {
        // deps are transitive, so one pass finds every package a change reaches; test imports are direct only,
        // so they are matched against that reached set
        const reached = new Set(graph.filter((p) => changedPkgs.has(p.importPath) || p.deps.some((d) => changedPkgs.has(d))).map((p) => p.importPath));
        plan.goPkgs = graph
            .filter((p) => universe.has(p.importPath) && (reached.has(p.importPath) || p.testImports.some((i) => reached.has(i))))
            .map((p) => p.importPath);
    }
    return plan;
}
```

Run: `npx vitest run scripts/verify.test.mjs`
Expected: PASS.

- [ ] **Step 3: Implement the CLI**

Append to `scripts/verify.mjs`:

```js
function run(cmd, args) {
    console.log(`verify: ${cmd} ${args.join(" ")}`);
    const r = spawnSync(cmd, args, { stdio: "inherit" });
    if (r.error) {
        console.error(`verify: could not run ${cmd}: ${r.error.message}`);
        process.exit(1);
    }
    if (r.status !== 0) {
        process.exit(r.status ?? 1);
    }
}

function goList(args) {
    const r = spawnSync("go", ["list", "-e", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) {
        console.error(`verify: go list ${args.join(" ")} failed:\n${r.stderr}`);
        process.exit(1);
    }
    return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

function goGraph() {
    const sep = "\t";
    const fmt = `{{.ImportPath}}${sep}{{join .Deps " "}}${sep}{{join .TestImports " "}} {{join .XTestImports " "}}`;
    return goList(["-f", fmt, "./..."]).map((line) => {
        const [importPath, deps = "", tests = ""] = line.split(sep);
        return { importPath, deps: deps.split(" ").filter(Boolean), testImports: tests.split(" ").filter(Boolean) };
    });
}

const VITEST = ["node_modules/vitest/vitest.mjs", "run"];
const TSC = ["--stack-size=4000", "node_modules/typescript/lib/tsc.js", "--noEmit"];

function main(patterns) {
    if (patterns.length === 0) {
        console.error("usage: node scripts/verify.mjs <go package pattern>...");
        process.exit(2);
    }
    const listFile = process.env.ARC_VERIFY_CHANGED;
    if (!listFile) {
        run("go", ["test", ...patterns]);
        run("node", VITEST);
        return;
    }
    const changed = readChanged(readFileSync(listFile, "utf8"));
    const modulePath = readFileSync("go.mod", "utf8").match(/^module\s+(\S+)/m)[1];
    const plan = planVerify(changed, goGraph(), new Set(goList(patterns)), modulePath);
    const goArgs = plan.goAll ? patterns : plan.goPkgs;
    if (goArgs.length === 0 && plan.vitest === "none" && !plan.tsc) {
        console.log(`verify: nothing to test for the ${changed.length} changed path(s)`);
        return;
    }
    if (goArgs.length > 0) {
        run("go", ["test", ...goArgs]);
    }
    if (plan.tsc) {
        run("node", TSC);
    }
    if (plan.vitest === "all") {
        run("node", VITEST);
    } else if (Array.isArray(plan.vitest)) {
        // vitest related takes source files and runs the tests that import them; a deleted file has none
        const present = plan.vitest.filter((p) => existsSync(p));
        if (present.length > 0) {
            run("node", ["node_modules/vitest/vitest.mjs", "related", "--run", ...present]);
        }
    }
}

// run as a script, not when the test imports it; Windows may differ in the drive letter's case
const self = fileURLToPath(import.meta.url).toLowerCase();
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self) {
    main(process.argv.slice(2));
}
```

Add `import { resolve } from "node:path";` to the imports.

- [ ] **Step 4: Try it for real**

Run each and record the wall time in your report:

```bash
printf 'docs/open-issues.md\n' > "$TEMP/changed.txt" && ARC_VERIFY_CHANGED="$TEMP/changed.txt" node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/jarvis/...
printf 'pkg/orchestrate/lane.go\n' > "$TEMP/changed.txt" && ARC_VERIFY_CHANGED="$TEMP/changed.txt" node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/...
printf 'frontend/app/view/agents/runmodel.ts\n' > "$TEMP/changed.txt" && ARC_VERIFY_CHANGED="$TEMP/changed.txt" node scripts/verify.mjs ./pkg/orchestrate/...
```

Expected: the first prints "nothing to test" and exits 0 at once. The second runs `go test` on
`pkg/orchestrate` and the packages that import it, within the patterns. The third runs tsc and the related
vitest files, with no `go test`.

- [ ] **Step 5: Tell plan writers**

In `AGENTS.md`, in the "Plans the engine runs" bullet, after the sentence about Final, add: "For this repo,
Verify is `node scripts/verify.mjs <go package patterns>`: at each merge it tests only what the merge changed
(the engine's `ARC_VERIFY_CHANGED`), and in the final stage everything the patterns name plus vitest."

- [ ] **Step 6: Commit**

```bash
git add scripts/verify.mjs scripts/verify.test.mjs AGENTS.md
git commit -m "feat(scripts): a Verify that tests only what a merge changed"
```

---

### Task 3: Satisfy a dependency when it merges, not when its Verify passes

**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/lane.go` (`laneLanded` becomes `laneMerged`)
- Modify: `pkg/orchestrate/scheduler.go` (`depSatisfied`)
- Modify: `pkg/orchestrate/digest.go` (the step 4c comment)
- Test: `pkg/orchestrate/verify_test.go` (two tests change their expectation; one new test)
- Modify: `docs/orchestrator-guide.md` (wherever it says a dependent waits for Verify; `grep -n "Verify" docs/orchestrator-guide.md`)

**Interfaces:**
- Produces: `func laneMerged(g *waveobj.TaskGroup, lane []string) bool`, replacing `laneLanded`.

- [ ] **Step 1: Change the tests to the new rule**

In `verify_test.go`, rename `TestVerifyPassAfterMergeUnblocksDependent` to
`TestADependentStartsAtItsDependencysMergeNotItsVerify` and replace its assertions from `verify.waitStarted(t)`
on with:

```go
	verify.waitStarted(t)
	g := f.dag(t)
	if g.Tasks[0].State != TaskState_Verifying || !g.Tasks[0].Merged {
		t.Fatalf("a merged task waits on Verify, got %s merged=%v", g.Tasks[0].State, g.Tasks[0].Merged)
	}
	if g.Tasks[1].State != TaskState_Running || g.Tasks[2].State != TaskState_Running || len(spawned) != 2 {
		t.Fatalf("both dependents start at the merge, while Verify runs, got %s / %s with %d spawns", g.Tasks[1].State, g.Tasks[2].State, len(spawned))
	}
	verify.open()
	await()

	g = f.dag(t)
	if g.Tasks[0].State != TaskState_Done || g.Tasks[0].VerifyError != "" {
		t.Fatalf("a passing Verify leaves the task done, got %s %q", g.Tasks[0].State, g.Tasks[0].VerifyError)
	}
	if got := calls.list(); len(got) != 1 || got[0].dir != f.projectPath(t) || got[0].command != verifyCmd {
		t.Fatalf("want Verify once in the project checkout, got %+v", got)
	}
```

In `TestVerifyFailureBlocksTheDagAndWakesTheLead`, replace the second `if` with:

```go
	if g.Status != DagStatus_Blocked || g.Tasks[1].State != TaskState_Running || len(spawned) != 2 {
		t.Fatalf("a failed Verify blocks the dag; the dependents started at the merge, got %s / %s / %d spawns", g.Status, g.Tasks[1].State, len(spawned))
	}
```

Add after it:

```go
// a dependent that started at its dependency's merge lands only once that dependency's Verify passed
func TestAFailedVerifyHoldsTheDependentsMergeNotItsStart(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "first"},
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "third", Deps: []string{"t-0"}},
	})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	merges := stubMerge(t, landedSha)
	stubPlanCommand(t, func(context.Context, string, string) error {
		return &planCommandError{exitCode: 1, output: "FAIL pkg/orchestrate"}
	})
	var spawned []string
	stubSpawn(t, &spawned)
	await := awaitVerify(t)
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()

	f.finish(t, "t-1")
	AutoMergeReady(f.ctx, f.dagID)
	if g := f.dag(t); *merges != 1 || g.Tasks[1].Merged {
		t.Fatalf("t-1 must not merge while t-0's Verify is failed, got %d merges, merged=%v", *merges, g.Tasks[1].Merged)
	}
}
```

Run: `go test ./pkg/orchestrate/ -run 'TestADependent|TestVerifyFailureBlocks|TestAFailedVerify' -count=1`
Expected: the first two FAIL (dependents still pending); the third PASSES already (the queue rule exists) and
pins it.

- [ ] **Step 2: Implement**

`lane.go`, replacing `laneLanded`:

```go
// laneMerged reports whether a lane's work is on the project branch: each task skipped, or merged and past its
// gate. Its Verify may still be running, or have failed: that holds the next merge, not a dependent's start, so
// a chain link no longer waits minutes for tests its dependent does not need to begin.
func laneMerged(g *waveobj.TaskGroup, lane []string) bool {
	for _, id := range lane {
		t := taskByID(g, id)
		if t == nil {
			return false
		}
		if t.State == TaskState_Skipped {
			continue
		}
		if !t.Merged || (t.Gate && !t.Released) {
			return false
		}
	}
	return true
}
```

`scheduler.go`: `return laneMerged(g, lane)`, and update the doc comment's last clause to "one in another lane is
satisfied once its whole lane has merged onto the project branch, before its Verify passes".

`digest.go` step 4c comment: `// 4c. a merged task's Verify is running; the next merge waits on it`.

Run: `go test ./pkg/orchestrate/ -count=1`
Expected: PASS. A digest test that expected a dependent to wait on a verifying task now fails for the right
reason: update its expectation and name it in your report.

- [ ] **Step 3: Docs**

Update each sentence in `docs/orchestrator-guide.md` that says a dependent starts after its dependency's Verify
passes, so it says a dependent starts once its dependency merged, and a failed Verify holds later merges.

- [ ] **Step 4: Commit**

```bash
git add pkg/orchestrate/lane.go pkg/orchestrate/scheduler.go pkg/orchestrate/digest.go pkg/orchestrate/verify_test.go docs/orchestrator-guide.md
git commit -m "perf(orchestrate): start a dependent when its dependency merges, not after its Verify"
```

---

### Task 4: Merge first the lane most pending tasks wait on

**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/mergetask.go` (`autoMergeable`, and a new `waitingOn`)
- Test: `pkg/orchestrate/mergetask_test.go`

**Interfaces:**
- Produces: `func waitingOn(g *waveobj.TaskGroup, tipID string) int`

- [ ] **Step 1: Write the failing test**

```go
func TestAutoMergeableLandsFirstTheLaneMostPendingTasksWaitOn(t *testing.T) {
	g := mustGroup(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "leaf"},
		{ID: "t-1", Label: "hub"},
		// two dependents keep t-1 a lane of its own; t-4 waits on it through t-2
		{ID: "t-2", Label: "a", Deps: []string{"t-1"}},
		{ID: "t-3", Label: "b", Deps: []string{"t-1"}},
		{ID: "t-4", Label: "c", Deps: []string{"t-2"}},
	})
	g.MergeRequired = true
	for _, id := range []string{"t-0", "t-1"} {
		task := taskByID(g, id)
		task.State, task.RunID = TaskState_Done, "run-"+id
	}
	if got := autoMergeable(g); !reflect.DeepEqual(got, []string{"t-1", "t-0"}) {
		t.Fatalf("want the hub first (3 tasks wait on it), then plan order, got %v", got)
	}
	if n := waitingOn(g, "t-1"); n != 3 {
		t.Fatalf("t-2, t-3 and, through t-2, t-4 wait on t-1; got %d", n)
	}
	// a started task is no longer waiting
	taskByID(g, "t-2").State = TaskState_Running
	if n := waitingOn(g, "t-1"); n != 2 {
		t.Fatalf("t-3 and t-4 still wait; got %d", n)
	}
}
```

Check `mustGroup` (`dag_test.go:19`) builds lanes as the test's comment assumes. If `jarvis.Lanes` joins t-2
and t-4 into one lane, the counts still hold, because `waitingOn` counts tasks, not lanes.

Run: `go test ./pkg/orchestrate/ -run TestAutoMergeableLandsFirst -count=1`
Expected: FAIL (undefined `waitingOn`).

- [ ] **Step 2: Implement**

```go
// autoMergeable lists the lanes that can be landed without asking anyone, by their tip: every task
// finished or skipped, nothing merged yet, every gate released. blocked-merge is excluded — a conflicted
// tree is the human's. Only one lane lands per Verify, so the lane the most pending tasks wait on goes first,
// then plan order.
func autoMergeable(g *waveobj.TaskGroup) []string {
	var out []string
	for _, lane := range jarvis.Lanes(g.Tasks) {
		if tip := laneMergeReady(g, lane); tip != nil {
			out = append(out, tip.ID)
		}
	}
	slices.SortStableFunc(out, func(a, b string) int { return waitingOn(g, b) - waitingOn(g, a) })
	return out
}

// waitingOn counts the pending tasks that depend on tipID's lane, directly or through other tasks.
func waitingOn(g *waveobj.TaskGroup, tipID string) int {
	behind := map[string]bool{}
	for _, id := range laneOf(g, tipID) {
		behind[id] = true
	}
	// to a fixed point, since nothing promises a JSON dag lists its tasks in dependency order
	for grew := true; grew; {
		grew = false
		for i := range g.Tasks {
			t := &g.Tasks[i]
			if behind[t.ID] {
				continue
			}
			if slices.ContainsFunc(t.Deps, func(d string) bool { return behind[d] }) {
				behind[t.ID], grew = true, true
			}
		}
	}
	// the lane's own tasks are done, never pending, so only the tasks behind it count
	n := 0
	for id := range behind {
		if t := taskByID(g, id); t != nil && t.State == TaskState_Pending {
			n++
		}
	}
	return n
}
```

Add `"slices"` to the imports.

Run: `go test ./pkg/orchestrate/ -count=1`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add pkg/orchestrate/mergetask.go pkg/orchestrate/mergetask_test.go
git commit -m "perf(orchestrate): land first the lane the most pending tasks wait on"
```

---

### Task 5: Run Check once on the base at submit

**Depends on:** Task 1

**Files:**
- Modify: `pkg/waveobj/wtype.go` (`BaseCheck` type and field, next to `Check`), then `task generate`
- Create: `pkg/orchestrate/basecheck.go`
- Test: `pkg/orchestrate/basecheck_test.go`
- Modify: `pkg/orchestrate/engine.go` (tick hook beside `advancePlanReview`; `workerContract`)
- Modify: `pkg/orchestrate/final.go` (`runFinalSteps`: a Check failure the base shares is unverified, not failed)
- Test: `pkg/orchestrate/final_test.go`, `pkg/orchestrate/engine_test.go`
- Modify: `docs/orchestrator-guide.md` (plan-commands bullets and the final stage's Check step)

**Interfaces:**
- Consumes: `runPlanCommand` with env (Task 1).
- Produces: `waveobj.BaseCheck{State, Commit, Detail string}`, `TaskGroup.BaseCheck *BaseCheck` (`json:"basecheck,omitempty"`).
- Produces: `BaseCheckState_Running = "running"`, `BaseCheckState_Passed = "passed"`, `BaseCheckState_Failed = "failed"`,
  `BaseCheckState_Skipped = "skipped"`; `func advanceBaseCheck(ctx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run, afterCommit *[]func())`;
  `var baseCheckFinished = func(dagID string) {}`; `func baseCheckFailed(g *waveobj.TaskGroup) bool`.

- [ ] **Step 1: The type**

In `wtype.go`, directly after the `Check  string` field of `TaskGroup`:

```go
	// BaseCheck is the plan's Check run once on the commit the lanes start from, at submit, before any task.
	// A failure there is the base's, not a task's. Nil for a dag with no Check.
	BaseCheck *BaseCheck `json:"basecheck,omitempty"`
```

and next to `FinalStage`:

```go
// BaseCheck is one dag's Check on its base commit.
type BaseCheck struct {
	State  string `json:"state"`            // running | passed | failed | skipped (it could not run; Detail says why)
	Commit string `json:"commit,omitempty"` // the commit it checked
	Detail string `json:"detail,omitempty"` // the failure's reason and first failing lines
}
```

Run `task generate`, then `go build ./...`.

- [ ] **Step 2: Write the failing tests**

`basecheck_test.go`:

```go
package orchestrate

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func awaitBaseCheck(t *testing.T) func() {
	t.Helper()
	done := make(chan struct{}, 4)
	orig := baseCheckFinished
	baseCheckFinished = func(string) { done <- struct{}{} }
	t.Cleanup(func() { baseCheckFinished = orig })
	return func() {
		t.Helper()
		select {
		case <-done:
		case <-time.After(60 * time.Second):
			t.Fatal("the base Check did not finish")
		}
	}
}

func (f *mergeFixture) setCheck(t *testing.T, check string) {
	t.Helper()
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Check = check
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBaseCheckFailureIsRecordedAndWakesTheLead(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setCheck(t, "echo 'error TS2307: three'; exit 2")
	var spawned []string
	stubSpawn(t, &spawned)
	await := awaitBaseCheck(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()

	bc := f.dag(t).BaseCheck
	if bc == nil || bc.State != BaseCheckState_Failed || bc.Commit == "" || !strings.Contains(bc.Detail, "exit 2") || !strings.Contains(bc.Detail, "TS2307") {
		t.Fatalf("want a failed base Check with its commit and cause, got %+v", bc)
	}
	if len(lead.sends) != 1 || !strings.Contains(lead.sends[0], "already fails on the base") {
		t.Fatalf("the lead is told once, got %q", lead.sends)
	}
	if _, err := os.Stat(worktreeDir(f.project, f.ownerID+"-base")); !os.IsNotExist(err) {
		t.Fatalf("the base tree is removed, stat err %v", err)
	}
}

func TestBaseCheckPassesQuietlyAndRunsOnce(t *testing.T) {
	lead := newFakeLead(t)
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	f.setCheck(t, "true")
	var spawned []string
	stubSpawn(t, &spawned)
	await := awaitBaseCheck(t)
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	if bc := f.dag(t).BaseCheck; bc == nil || bc.State != BaseCheckState_Passed {
		t.Fatalf("want passed, got %+v", bc)
	}
	if len(lead.sends) != 0 {
		t.Fatalf("a passing base Check wakes nobody, got %q", lead.sends)
	}
}

func TestNoBaseCheckWithoutCheckOrOnceATaskStarted(t *testing.T) {
	g := mustGroup(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	owner := &waveobj.Run{ProjectPath: newGitRepo(t)}
	var after []func()
	advanceBaseCheck(context.Background(), g, owner, &after)
	if g.BaseCheck != nil || len(after) != 0 {
		t.Fatalf("a dag with no Check runs nothing, got %+v", g.BaseCheck)
	}
	// a dag already under way has no base left to check: its lanes have moved the head
	g.Check = "true"
	g.Tasks[0].State = TaskState_Running
	advanceBaseCheck(context.Background(), g, owner, &after)
	if g.BaseCheck != nil || len(after) != 0 {
		t.Fatalf("no base Check once a task started, got %+v", g.BaseCheck)
	}
}
```

In `final_test.go`, next to `TestFinalCheckFailureFailsTheStageWithItsTailAndWakesTheLead`:

```go
// the base broke before any task, so the run's own Check result cannot be told apart from it
func TestFinalCheckFailureTheBaseSharesIsUnverified(t *testing.T) {
	f := finalFixture(t, passVerify, "exit 1", "")
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.BaseCheck = &waveobj.BaseCheck{State: BaseCheckState_Failed, Commit: "abc", Detail: "exit 1: error TS2307"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	g := runFinal(t, f)

	if g.Final.State == FinalState_Failed || g.Final.Detail != "" {
		t.Fatalf("a Check failure the base shares does not fail the stage, got %s %q", g.Final.State, g.Final.Detail)
	}
	if !slices.ContainsFunc(g.Final.Unverified, func(s string) bool { return strings.Contains(s, "already failed on the base") }) {
		t.Fatalf("it is an unverified reason, got %q", g.Final.Unverified)
	}
}
```

(add `"slices"` to that file's imports). In `engine_test.go`, a contract test:

```go
func TestWorkerContractNamesABrokenBase(t *testing.T) {
	g := mustGroup(t, []waveobj.TaskNode{{ID: "t-0", Label: "a"}})
	g.Check = "tsc"
	if strings.Contains(workerContract(g, &g.Tasks[0], "claude", ""), "on the base") {
		t.Fatal("no base note before the base Check failed")
	}
	g.BaseCheck = &waveobj.BaseCheck{State: BaseCheckState_Failed, Detail: "exit 2: error TS2307"}
	c := workerContract(g, &g.Tasks[0], "claude", "")
	if !strings.Contains(c, "`tsc` already fails on the base, before any task (exit 2: error TS2307)") {
		t.Fatalf("the contract names the base failure, got %q", c)
	}
}
```

Run: `go test ./pkg/orchestrate/ -run 'TestBaseCheck|TestNoBaseCheck|TestFinalCheckFailureTheBase|TestWorkerContractNamesABrokenBase' -count=1`
Expected: FAIL (undefined identifiers).

- [ ] **Step 3: Implement `basecheck.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"slices"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/ds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Base Check states (TaskGroup.BaseCheck.State).
const (
	BaseCheckState_Running = "running"
	BaseCheckState_Passed  = "passed"
	BaseCheckState_Failed  = "failed"
	BaseCheckState_Skipped = "skipped"
)

// baseCheckFinished is called once a base Check's result is recorded. A var so tests can wait for it.
var baseCheckFinished = func(dagID string) {}

// baseCheckRuns marks the dags whose base Check is running. In memory only: a restart finds the state still
// running and starts it again, on the commit recorded at the first start.
var baseCheckRuns = ds.MakeSyncMap[bool]()

func baseCheckFailed(g *waveobj.TaskGroup) bool {
	return g.BaseCheck != nil && g.BaseCheck.State == BaseCheckState_Failed
}

// advanceBaseCheck runs the plan's Check once on the commit the lanes start from, before any task: a base
// another session broke then fails that one Check, instead of every worker's, and the final stage does not
// take it for the run's. It runs beside the plan review, which usually outlasts it. The caller holds the dag
// mutation lock.
func advanceBaseCheck(ctx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run, afterCommit *[]func()) {
	if g.Check == "" || (g.BaseCheck != nil && g.BaseCheck.State != BaseCheckState_Running) {
		return
	}
	if g.BaseCheck == nil {
		// only before any task started: after that the head holds the run's own lanes, not the base
		if !IsGitRepo(owner.ProjectPath) || slices.ContainsFunc(g.Tasks, func(t waveobj.TaskNode) bool { return t.State != TaskState_Pending }) {
			return
		}
		head, err := landingHead(ctx, owner)
		if err != nil {
			g.BaseCheck = &waveobj.BaseCheck{State: BaseCheckState_Skipped, Detail: "reading the base commit: " + err.Error()}
			return
		}
		g.BaseCheck = &waveobj.BaseCheck{State: BaseCheckState_Running, Commit: head}
	}
	dagID, runID, project, commit, setup, check := g.OID, owner.ID, owner.ProjectPath, g.BaseCheck.Commit, g.Setup, g.Check
	*afterCommit = append(*afterCommit, func() { startBaseCheck(dagID, runID, project, commit, setup, check) })
}

func startBaseCheck(dagID, runID, project, commit, setup, check string) {
	if !baseCheckRuns.SetUnless(dagID, true) {
		return
	}
	go func() {
		defer baseCheckFinished(dagID)
		defer baseCheckRuns.Delete(dagID)
		ctx := context.Background()
		state, detail := runBaseCheck(ctx, runID, project, commit, setup, check)
		if err := WithDagMutation(dagID, func() error { return recordBaseCheckLocked(ctx, dagID, state, detail) }); err != nil {
			log.Printf("dag %s: recording the base Check: %v", dagID, err)
		}
	}()
}

// runBaseCheck runs Check in a detached tree at commit, never in a tree anyone works in, and removes the tree.
func runBaseCheck(ctx context.Context, runID, project, commit, setup, check string) (string, string) {
	wt := worktreeDir(project, runID+"-base")
	if _, err := os.Stat(wt); err == nil {
		if err := removeWorktreeDir(ctx, project, wt); err != nil {
			return BaseCheckState_Skipped, "removing a stale base tree: " + err.Error()
		}
	}
	if _, err := git(ctx, project, "worktree", "add", "--detach", wt, commit); err != nil {
		return BaseCheckState_Skipped, "creating the base tree: " + err.Error()
	}
	defer func() {
		if err := removeWorktreeDir(context.Background(), project, wt); err != nil {
			log.Printf("run %s: removing the base tree: %v", runID, err)
		}
	}()
	if setup != "" {
		if _, err := runPlanCommand(ctx, wt, setup, nil, SetupTimeout, nil); err != nil {
			return BaseCheckState_Skipped, "Setup failed in the base tree: " + failureDetail(err)
		}
	}
	if _, err := runPlanCommand(ctx, wt, check, nil, VerifyTimeout, nil); err != nil {
		var pe *planCommandError
		if !errors.As(err, &pe) {
			return BaseCheckState_Skipped, "running Check: " + err.Error()
		}
		return BaseCheckState_Failed, failureDetail(err)
	}
	return BaseCheckState_Passed, ""
}

func recordBaseCheckLocked(ctx context.Context, dagID, state, detail string) error {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return err
	}
	if g.Status == DagStatus_Cancelled || g.BaseCheck == nil || g.BaseCheck.State != BaseCheckState_Running {
		return nil
	}
	g.BaseCheck.State, g.BaseCheck.Detail = state, detail
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		cur.BaseCheck = g.BaseCheck
		cur.UpdatedTs = g.UpdatedTs
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, dagID))
	if state == BaseCheckState_Failed {
		PostWake(ctx, g.ChannelId, g.RunID, baseCheckFailedWake(g.Check, detail))
	}
	return nil
}

// baseCheckFailedWake carries the cause, since the digest does not show the base Check.
func baseCheckFailedWake(check, detail string) string {
	return fmt.Sprintf("wake: the plan's Check `%s` already fails on the base, before any task (%s). Workers are told those failures are not theirs, and the final stage reports a Check failure as unverified, not failed. Fix the base if it is yours to fix.", check, detail)
}
```

In `engine.go`, directly after the `advancePlanReview(...)` line of the tick:

```go
	// the plan's Check on the base, beside the plan review, so a broken base is named once before any worker
	advanceBaseCheck(ctx, g, owner, &afterCommit)
```

In `workerContract`, replace the Check sentence:

```go
	b.WriteString("Run the tests your task names")
	if g.Check != "" {
		fmt.Fprintf(&b, ", and `%s`,", g.Check)
	}
	b.WriteString(" and get them passing before you complete; if you can't, ask.")
	if baseCheckFailed(g) {
		fmt.Fprintf(&b, " `%s` already fails on the base, before any task (%s): don't fix those failures or count them as yours, and name them in your report.", g.Check, g.BaseCheck.Detail)
	}
```

In `final.go`'s `runFinalSteps`, the Check block becomes:

```go
	if g.Check != "" {
		if out, err := runPlanCommand(ctx, tree, g.Check, nil, VerifyTimeout, nil); err != nil {
			if !baseCheckFailed(g) {
				res.detail = fmt.Sprintf("Check `%s` failed (%s):\n%s", g.Check, commandReason(err), out)
				return res
			}
			// a fix round cannot fix someone else's commit, so it goes on as unverified
			res.unverified = append(res.unverified, fmt.Sprintf("Check `%s` fails on the merged result (%s), but it already failed on the base before any task (%s), so the failure is not attributed to the run", g.Check, failureDetail(err), g.BaseCheck.Detail))
		}
	}
```

Run: `go test ./pkg/orchestrate/ -count=1`
Expected: PASS. A fixture with a Check and every task still pending now also runs a base Check in its first
tick, whose goroutine can outlive the test and wake its fake lead. If one fails that way, wait for it with
`awaitBaseCheck`, or give it a `BaseCheck` already passed, and name the test in your report.

- [ ] **Step 4: Docs**

`docs/orchestrator-guide.md`: in the Check bullet, add "The engine also runs it once at submit, in a detached tree
at the commit the lanes start from; if it fails there, the lead is woken, every worker is told those failures
are not theirs, and the final stage reports a failing Check as unverified instead of failing." In the final
stage's Check step, add the same exception.

- [ ] **Step 5: Commit**

```bash
git add pkg/waveobj/wtype.go frontend/types/gotypes.d.ts pkg/orchestrate/basecheck.go pkg/orchestrate/basecheck_test.go pkg/orchestrate/engine.go pkg/orchestrate/engine_test.go pkg/orchestrate/final.go pkg/orchestrate/final_test.go docs/orchestrator-guide.md
git commit -m "feat(orchestrate): run Check once on the base so its breakage is not blamed on a task"
```

---

### Task 6: Re-check the run merged with its base before it lands

**Depends on:** Task 1

**Files:**
- Modify: `pkg/orchestrate/land.go` (`reverifyHold`, `landRun`, `movedBaseNote`)
- Test: `pkg/orchestrate/land_test.go`
- Modify: `docs/orchestrator-guide.md` (the land's "Before merging" steps and hold list)

**Interfaces:**
- Consumes: `changedFilesEnv(ctx, dir, since, to, name string) []string` and `runPlanCommand` with env (Task 1).
- Produces: `func reverifyHold(ctx context.Context, run *waveobj.Run, g *waveobj.TaskGroup) (reason, checkedBase string)`;
  `func movedBaseNote(ctx context.Context, run *waveobj.Run, pre, checkedBase string) string`.

Today the re-check runs the full Check and Verify when the branch moved past the final stage's commit, even for
a docs-only wrap-up commit. It also runs them on the branch alone, not on what lands. After this task it runs
when the branch moved **or** the base moved. It merges the base into the landing tree without committing, runs
Check and a Verify scoped to what differs from the verified commit, and aborts the merge.

- [ ] **Step 1: Write the failing tests**

Add to `land_test.go`, beside `TestLandReverifiesCommitsAfterTheFinalStage`:

```go
func (f *mergeFixture) setLandCommands(t *testing.T, check, verify string) {
	t.Helper()
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Check, cur.Verify = check, verify
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// mergeInProgress reports whether dir is stopped inside a merge.
func mergeInProgress(dir string) bool {
	return exec.Command("git", "-C", dir, "rev-parse", "-q", "--verify", "MERGE_HEAD").Run() == nil
}

func TestLandChecksTheRunMergedWithItsMovedBase(t *testing.T) {
	t.Run("the check sees the base's commits and lands with no note", func(t *testing.T) {
		f, _ := landFixture(t)
		commitOnBranch(t, f.project, "base.txt", "base\n")
		f.setLandCommands(t, "", "test -f base.txt && test -f feature.txt")
		land := f.landRun(t, false)
		if land.State != LandState_Landed || len(land.Notes) != 0 {
			t.Fatalf("land = %+v, want landed with no unverified-combination note", land)
		}
	})
	t.Run("a Verify that fails on the combination holds, and the tree is put back", func(t *testing.T) {
		f, tree := landFixture(t)
		commitOnBranch(t, f.project, "base.txt", "base\n")
		f.setLandCommands(t, "", "test ! -f base.txt")
		head := gitCmd(t, f.project, "rev-parse", "main")
		branchHead := gitCmd(t, tree, "rev-parse", "HEAD")
		f.assertHeld(t, f.landRun(t, false), head, "Verify `test ! -f base.txt` failed")
		if mergeInProgress(tree) || gitCmd(t, tree, "rev-parse", "HEAD") != branchHead {
			t.Fatal("the landing tree is left mid-merge or moved")
		}
		if _, err := os.Stat(filepath.Join(tree, "base.txt")); !os.IsNotExist(err) {
			t.Fatalf("the base's file is left in the landing tree, stat err %v", err)
		}
	})
	t.Run("a conflict with the base holds, and the tree is put back", func(t *testing.T) {
		f, tree := landFixture(t)
		commitOnBranch(t, f.project, "feature.txt", "the base's own feature\n")
		f.setLandCommands(t, "", "true")
		head := gitCmd(t, f.project, "rev-parse", "main")
		f.assertHeld(t, f.landRun(t, false), head, "feature.txt")
		if mergeInProgress(tree) {
			t.Fatal("the landing tree is left mid-merge")
		}
	})
	t.Run("Verify is scoped to what changed since the verified commit", func(t *testing.T) {
		f, tree := landFixture(t)
		commitOnBranch(t, tree, "wrapup.md", "wrap-up\n")
		commitOnBranch(t, f.project, "base.txt", "base\n")
		out := filepath.ToSlash(t.TempDir())
		f.setLandCommands(t, "", `cat "$ARC_VERIFY_CHANGED" > `+out+`/changed`)
		if land := f.landRun(t, false); land.State != LandState_Landed {
			t.Fatalf("land = %+v, want landed", land)
		}
		if got := strings.Fields(readFile(t, filepath.Join(out, "changed"))); !reflect.DeepEqual(got, []string{"base.txt", "wrapup.md"}) {
			t.Fatalf("the scope is the wrap-up plus the base's change, got %q", got)
		}
	})
	t.Run("a base commit that lands during the check is still noted", func(t *testing.T) {
		f, _ := landFixture(t)
		commitOnBranch(t, f.project, "base.txt", "base\n")
		// the check itself moves main, the way another session's commit would
		f.setLandCommands(t, "git -C '"+filepath.ToSlash(f.project)+"' commit -q --allow-empty -m late", "true")
		land := f.landRun(t, false)
		want := []string{"merged onto 1 commit that landed on main during the run; the combination was not verified"}
		if land.State != LandState_Landed || !reflect.DeepEqual(land.Notes, want) {
			t.Fatalf("land = %+v, want landed noting only the late commit", land)
		}
	})
}
```

Run: `go test ./pkg/orchestrate/ -run TestLandChecksTheRunMergedWithItsMovedBase -count=1`
Expected: FAIL. Today nothing runs when only the base moved, so the second and third subtests land, and the
first carries the note.

- [ ] **Step 2: Implement**

`land.go`:

```go
// reverifyHold checks what the final stage never saw before the run lands: the lead's wrap-up commits after it,
// and the base's commits since the run forked. It merges the base into the landing tree without committing, runs
// Check, then Verify scoped to what differs from the verified commit, and puts the tree back. checkedBase is the
// base commit the run was checked against, so the land notes only base commits that arrived after it.
func reverifyHold(ctx context.Context, run *waveobj.Run, g *waveobj.TaskGroup) (string, string) {
	if g == nil || (g.Check == "" && g.Verify == "") {
		return "", ""
	}
	head, err := WorktreeHeadCommit(ctx, run.ProjectPath, run.ID)
	if err != nil {
		return "reading the run's branch: " + err.Error(), ""
	}
	base, err := git(ctx, run.ProjectPath, "rev-parse", run.BaseBranch)
	if err != nil {
		return "reading " + run.BaseBranch + ": " + err.Error(), ""
	}
	verified := ""
	if g.Final != nil {
		verified = g.Final.Commit
	}
	_, ancestorErr := git(ctx, run.ProjectPath, "merge-base", "--is-ancestor", base, head)
	baseMoved := ancestorErr != nil
	if head == verified && !baseMoved {
		return "", base
	}
	if err := checkLandingTree(ctx, run); err != nil {
		return "the run changed after the final stage verified it, and it cannot be checked again: " + err.Error(), ""
	}
	if baseMoved {
		if _, err := git(ctx, run.LandPath, "merge", "--no-commit", "--no-ff", base); err != nil {
			return "checking the run merged with " + run.BaseBranch + " in its landing tree: " + mergeRefusal(ctx, run.LandPath, run.BaseBranch, err), ""
		}
		defer func() {
			if _, err := git(context.Background(), run.LandPath, "merge", "--abort"); err != nil {
				log.Printf("run %s: putting the landing tree back after the land's check: %v", run.ID, err)
			}
		}()
	}
	env := changedFilesEnv(ctx, run.LandPath, verified, "", run.ID+"-land")
	for _, c := range []struct {
		name, cmd string
		env       []string
	}{{"Check", g.Check, nil}, {"Verify", g.Verify, env}} {
		if c.cmd == "" {
			continue
		}
		if _, err := runPlanCommand(ctx, run.LandPath, c.cmd, c.env, VerifyTimeout, nil); err != nil {
			return fmt.Sprintf("the run changed after the final stage verified it, and %s `%s` failed on the run merged with %s (%s)", c.name, c.cmd, run.BaseBranch, failureDetail(err)), ""
		}
	}
	return "", base
}
```

`changedFilesEnv` with `verified == ""` returns nil, so a run with no final commit runs Verify unscoped.

In `landRun`:

```go
	reason, checkedBase := reverifyHold(ctx, run, g)
	if reason != "" {
		return heldLand(reason)
	}
```

and `if note := movedBaseNote(ctx, run, pre, checkedBase); note != "" {`.

`movedBaseNote` takes `checkedBase` and counts from it when set:

```go
// movedBaseNote is set when the base branch took commits the land's check did not see: all of them when nothing
// was checked, else those after the base commit the check merged. The run's own commits are excluded, should any
// reach the base.
func movedBaseNote(ctx context.Context, run *waveobj.Run, pre, checkedBase string) string {
	from := run.BaseCommit
	if checkedBase != "" {
		from = checkedBase
	}
	if from == "" {
		return ""
	}
	out, err := git(ctx, run.ProjectPath, "rev-list", "--count", pre, "^"+from, "^wave/"+run.ID)
```

(the rest unchanged). `mergeRefusal` runs `git merge --abort` on a conflict itself, so the deferred abort is
registered only after a merge that succeeded.

Run: `go test ./pkg/orchestrate/ -run 'TestLand' -count=1`
Expected: PASS, including the existing `TestLandReverifiesCommitsAfterTheFinalStage`. Its "a failing Verify
holds" subtest checks for the substring "Verify `exit 1` failed", which the new reason keeps.
`TestLandNotesCommitsThatLandedOnTheBaseDuringTheRun` has no Check or Verify, so it takes the early return and
keeps its note.

- [ ] **Step 3: Docs**

`docs/orchestrator-guide.md`, the land's "Before merging" list: replace the first bullet with "If the branch
moved past the commit the final stage verified, or the base took commits since the run forked, it merges the
base into the landing tree without committing and runs Check, then Verify with `ARC_VERIFY_CHANGED` listing what
differs from the verified commit. It then aborts that merge." Replace the note bullet with "The land notes
the base commits that arrived after that check, 'merged onto N commits…; the combination was not verified'." In
the hold list, change "the re-run Check or Verify fails" to "the land's Check or Verify fails, or the run
conflicts with the base in the landing tree".

- [ ] **Step 4: Commit**

```bash
git add pkg/orchestrate/land.go pkg/orchestrate/land_test.go docs/orchestrator-guide.md
git commit -m "fix(orchestrate): check the run merged with its moved base before it lands"
```

---

## After the last task

- Run the whole Go suite for the packages touched: `go test ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/waveobj/... -count=1`,
  and `task check:ts` (about 2 minutes).
- `docs/orchestrator-findings-2026-09-25.md`: add a "Fixes after the handoff" table like "Fixes after run
  b01cfdd6": one row each for 23/27 (scoped Verify, the final stage's Verify, deps at merge, merge order), 33 and the
  land re-check, each with its test. In the Handoff, mark item 1 done and list what stays deferred: the merge train
  with bisect, the automatic Verify retry, and targeted worker checks with incremental tsc.
- Not verifiable here: the saving per run. The next orchestrator run after an Arc rebuild shows it. Compare its
  per-merge Verify times (`task-verify-passed` `ms`) and chain-link waits with finding 27's table.
- Delete this plan once it has shipped (AGENTS.md "Design docs").
