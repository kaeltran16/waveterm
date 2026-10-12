# Cleanup Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/jarvis ./pkg/wshrpc/wshserver ./cmd/wsh/cmd`

**Goal:** A finished orchestrator run fixes its own in-goal leftovers with one more round of reviewed workers, and parks the rest as chunks on the effort the run belongs to instead of creating a new effort each time.

**Architecture:** Reuse the fix-round path (`wsh jarvis dag submit --round`, `orchestrate.AppendRound`). `CheckFixRound` today only accepts a failed final stage; it will accept any finished one (passed, unverified, failed) while `MaxFinalRounds` has a round left. The engine, not the lead, says whether a round is left: the run-finished wake gets one line saying so. The dag inherits the run's composer effort link when the plan names none, and the lead's rules name that effort, so open issues land on it.

**Tech Stack:** Go (`pkg/orchestrate`, `pkg/jarvis`, `pkg/wshrpc/wshserver`, `cmd/wsh/cmd`).

**Spec:** none; the design is the conversation of 2026-10-12, restated here.

## Why

- The lead's run-finished rule (`pkg/jarvis/leadprompt.go:72-73`) forbids fixing code at wrap-up ("A code defect found now is not a wrap-up commit") and ends "Don't add tasks." `CheckFixRound` (`pkg/orchestrate/round.go:28`) refuses `--round` unless the final stage failed. So every leftover can only become an effort chunk, and nothing runs chunks.
- Neither lead prompt carries the run's effort. `CreateRun` stores the composer pick on `run.EffortRef` (`pkg/wshrpc/wshserver/wshserver_runs.go:380`), but the dag only takes `plan.EffortOID` (`wshserver_dag.go:328`) and `OrchestrationRules` takes no effort. With no `**Effort:**` line the lead hits "create one if none does" every run.

## Global Constraints

- One cleanup round at most, and it shares `MaxFinalRounds = 2` with the failure path: a run whose round 1 passed has exactly one round left; whatever round 2 leaves is chunks. No new constant.
- A round's work is only defects inside the run's goal that a worker can fix. Failures already on the base, work outside the goal, checks that need the human or an environment, and anything a round left are chunks.
- The run-finished wake's first line stays exactly `wake: run finished. wsh jarvis dag status`: `onlyRunFinished` (`pkg/orchestrate/wake.go:413`) keys lead-free completion on it.
- The lead submits a round without asking the human; the only round-related ask is the existing failed-final one after the last round. So the rules and guide drop "you propose a fix round" from the reasons to ask (Task 3).
- The plan's own `**Effort:**` line wins over the run's composer link.
- Never hand-edit generated files. No wshrpc type changes are needed here, so `task generate` is not part of this plan.
- Run Go tests per package as AGENTS.md says (`go test ./pkg/x -run '^TestName$'`, or `scripts/verify.mjs`); `gofmt -l` only the files you touch.

## Trade-offs (accepted)

- A cleanup round costs a worker, a review, the merge Verify and a second final stage (a cold dev-app build in this repo).
- If round 2 fails, it is the last round: the existing last-round wake puts the land to the human (`Land anyway` / `Keep the land held`). A cleanup round can therefore turn a passing land into a held one; the human's `Land anyway` recovers it.

## Out of scope

- A lead-free run (`wsh runs start --plan`, no live lead at finish) still completes by itself through `MaybeCompleteLeadFreeRun` with no cleanup round. Launching a lead for leftovers is a separate decision.

## Review Focus

- A lead-free run whose final stage passes with a round left must still close by itself: the wake's extra line must not make `onlyRunFinished` false (Task 1 test).
- Round 2 after a passed round 1: the wake says no round is left and `CheckFixRound` refuses with chunk guidance, not "forward to the human" (Task 1 tests).
- A passed dag that takes a round must run again: new tasks pending, `Final` reset to round 2 not started, the passed round kept in `PastFinals` (Task 1 test).
- A plan with its own `**Effort:**` line keeps it even when the run has a composer link (Task 2 test).
- A run with no effort link and a plan with none: the dag's `EffortOID` stays empty and the rules carry no `Effort:` sentence (Task 2 and Task 3 tests).

---

### Task 1: A round after any finished final stage

**Depends on:** none

**Files:** `pkg/orchestrate/round.go`, `pkg/orchestrate/queue.go`, `cmd/wsh/cmd/wshcmd-jarvisdag.go`, `pkg/orchestrate/round_test.go`, `pkg/orchestrate/final_test.go`, `pkg/wshrpc/wshserver/wshserver_dagplan_test.go`, `pkg/wshrpc/wshserver/wshserver_landing_test.go`
- Modify: `pkg/orchestrate/round.go` (`CheckFixRound` and its doc comment; `AppendRound` doc comment)
- Modify: `pkg/orchestrate/queue.go` (`RunFinishedWake`)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go:46-47` (`dag submit` help text)
- Test: `pkg/orchestrate/round_test.go`, `pkg/orchestrate/final_test.go`, `pkg/wshrpc/wshserver/wshserver_dagplan_test.go:247`, `pkg/wshrpc/wshserver/wshserver_landing_test.go:396` (the refusal substring only)

**Interfaces:**
- Produces: `CheckFixRound(g *waveobj.TaskGroup) error` accepts `FinalState_Passed`, `FinalState_Unverified` and `FinalState_Failed` while `g.Final.Round < MaxFinalRounds`.
- Produces: the unexported consts `roundLeftLine` and `noRoundLeftLine` in `queue.go`. Task 3's rules refer to the wake "saying a round is left", which is `roundLeftLine`'s opening words.

- [ ] **Step 1: Update the refusal table and add the new cases**

In `TestCheckFixRoundRefuses` (`round_test.go:120`), replace the cases with:

```go
		{"no final stage yet", nil, "", "the final stage has not finished"},
		{"a round not started", &waveobj.FinalStage{Round: 2}, "", "the final stage has not finished"},
		{"running its commands", &waveobj.FinalStage{State: FinalState_Checking, Round: 1}, "", "the final stage has not finished"},
		{"its verifier judging", &waveobj.FinalStage{State: FinalState_Verifying, Round: 1}, "", "the final stage has not finished"},
		{"failed the last round", &waveobj.FinalStage{State: FinalState_Failed, Round: MaxFinalRounds}, "", "no fix rounds left; forward to the human"},
		{"passed the last round", &waveobj.FinalStage{State: FinalState_Passed, Round: MaxFinalRounds}, "", "no rounds left"},
		{"unverified in the last round", &waveobj.FinalStage{State: FinalState_Unverified, Round: MaxFinalRounds}, "", "effort chunks"},
		{"cancelled", &waveobj.FinalStage{State: FinalState_Passed, Round: 1}, DagStatus_Cancelled, "cancelled"},
		{"failed with a round left", &waveobj.FinalStage{State: FinalState_Failed, Round: 1}, "", ""},
		{"passed with a round left", &waveobj.FinalStage{State: FinalState_Passed, Round: 1}, "", ""},
		{"unverified with a round left", &waveobj.FinalStage{State: FinalState_Unverified, Round: 1}, "", ""},
```

Update the comment above the test to: `// a round is refused unless the final stage finished with a round left (Review Focus)`.

- [ ] **Step 2: Add the passed-dag round test**

Append to `round_test.go`:

```go
// a run that passed takes one cleanup round: it runs again, and the passed round is kept beside the new one
func TestAppendRoundAfterAPassedFinalStage(t *testing.T) {
	f, _ := failedFinalFixture(t, 1)
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Final = &waveobj.FinalStage{State: FinalState_Passed, Round: 1}
		RecomputeDagStatus(cur)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	g, err := AppendRound(f.ctx, f.dagID, "docs/fix.md", fixPlanTasks(t))
	if err != nil {
		t.Fatalf("a passed stage with a round left takes a round: %v", err)
	}
	if len(g.Tasks) != 9 || g.Tasks[7].State != TaskState_Pending || g.Status != DagStatus_Running {
		t.Fatalf("the round's tasks are pending and the dag runs again, got %d tasks, t-8 %s, dag %s", len(g.Tasks), g.Tasks[7].State, g.Status)
	}
	if !reflect.DeepEqual(g.Final, &waveobj.FinalStage{Round: 2}) {
		t.Fatalf("round 2 is set up but not started, got %+v", g.Final)
	}
	if len(g.PastFinals) != 1 || g.PastFinals[0].State != FinalState_Passed {
		t.Fatalf("the passed round is kept in pastfinals, got %+v", g.PastFinals)
	}
}
```

- [ ] **Step 3: Add the wake tests**

Append to `final_test.go`:

```go
// the engine says whether a round is left, so the lead never guesses; the first line stays the finished line
// a lead-free run keys on (Review Focus)
func TestRunFinishedWakeSaysWhetherARoundIsLeft(t *testing.T) {
	cases := []struct {
		name  string
		final *waveobj.FinalStage
		want  string
	}{
		{"passed with a round left", &waveobj.FinalStage{State: FinalState_Passed, Round: 1}, roundLeftLine},
		{"unverified with a round left", &waveobj.FinalStage{State: FinalState_Unverified, Round: 1, Unverified: []string{"no dev app"}}, roundLeftLine},
		{"passed the last round", &waveobj.FinalStage{State: FinalState_Passed, Round: MaxFinalRounds}, noRoundLeftLine},
	}
	for _, c := range cases {
		w := RunFinishedWake(c.final)
		if !strings.HasSuffix(w, "\n"+c.want) {
			t.Fatalf("%s: the wake should end with %q, got %q", c.name, c.want, w)
		}
		if !onlyRunFinished([]string{w}) {
			t.Fatalf("%s: a lead-free run must still close by itself on %q", c.name, w)
		}
	}
}
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `go test ./pkg/orchestrate -run '^(TestCheckFixRoundRefuses|TestAppendRoundAfterAPassedFinalStage|TestRunFinishedWakeSaysWhetherARoundIsLeft)$'`
Expected: FAIL. The new consts are undefined (compile error) and `CheckFixRound` refuses a passed stage.

- [ ] **Step 5: Implement `CheckFixRound`**

Replace the function and its doc comment in `round.go`:

```go
// CheckFixRound says why a dag cannot take a round, or nil. A round fixes what a failed final stage found, or
// the open issues inside the goal that a finished run left, and the dag gets MaxFinalRounds final stages in all,
// the first included. After a failed last round the call is the human's; after a finished one the rest is chunks.
func CheckFixRound(g *waveobj.TaskGroup) error {
	if g.Status == DagStatus_Cancelled {
		return fmt.Errorf("dag %s is cancelled", g.OID)
	}
	if g.Final == nil || !finalTerminal(g.Final.State) {
		state := "not started"
		if g.Final != nil && g.Final.State != "" {
			state = g.Final.State
		}
		return fmt.Errorf("the final stage has not finished (it is %s); a round only follows a finished final stage", state)
	}
	if g.Final.Round >= MaxFinalRounds {
		if g.Final.State == FinalState_Failed {
			return fmt.Errorf("no fix rounds left; forward to the human: the final stage failed round %d of %d", g.Final.Round, MaxFinalRounds)
		}
		return fmt.Errorf("no rounds left: the final stage %s round %d of %d; add what is left as effort chunks", g.Final.State, g.Final.Round, MaxFinalRounds)
	}
	return nil
}
```

In `AppendRound`'s doc comment, change "extends a dag whose final stage failed" to "extends a dag whose final stage finished". (`submitFixRound`'s doc comment in `wshserver_dag.go` is Task 3's.)

- [ ] **Step 6: Implement the wake line**

In `queue.go`, add beside `runFinishedWake`:

```go
// roundLeftLine and noRoundLeftLine end a passed or unverified run-finished wake: the engine counts the rounds,
// so the lead only judges which open issues are round work.
const (
	roundLeftLine   = "One round is left for the open issues inside the run's goal that a worker can fix: `wsh jarvis dag submit --round --plan <fix plan>`."
	noRoundLeftLine = "No round is left: every open issue is an effort chunk."
)
```

Rewrite `RunFinishedWake` so both outcome shapes end with the round line:

```go
func RunFinishedWake(f *waveobj.FinalStage) string {
	if f == nil {
		return runFinishedWake
	}
	if f.State != FinalState_Passed && f.State != FinalState_Unverified {
		return runFinishedWake + "\nThe final stage " + f.State + " on the merged result."
	}
	lines := []string{runFinishedWake, "The final stage passed on the merged result."}
	if f.State == FinalState_Unverified {
		lines = []string{runFinishedWake, "The final stage finished unverified. What it could not verify:"}
		for _, r := range f.Unverified {
			lines = append(lines, "- "+r)
		}
	}
	if f.Round < MaxFinalRounds {
		lines = append(lines, roundLeftLine)
	} else {
		lines = append(lines, noRoundLeftLine)
	}
	return strings.Join(lines, "\n")
}
```

- [ ] **Step 7: Update the CLI help**

In `wshcmd-jarvisdag.go:46-47`, replace "A fix round after a failed final stage\nextends the same dag instead: --round appends the fix plan's tasks." with "A round after the final stage finishes (a fix\nfor a failure, or a finished run's in-goal leftovers) extends the same dag instead: --round appends the fix plan's tasks." Keep the surrounding line wrapping style.

- [ ] **Step 8: Fix the tests that pinned the old wake text**

`TestRunFinishedWakeNamesTheConflictsTheLandWouldHoldOn` (`final_test.go:234`) builds `passed` as the exact wake; its fixture's final stage is round 1, so append the round line: `passed := runFinishedWake + "\nThe final stage passed on the merged result.\n" + roundLeftLine`. Then find any other exact match with `grep -rn "on the merged result" pkg/orchestrate/*_test.go pkg/wshrpc/wshserver/*_test.go` and update each the same way.

The refusal text changed too: `wshserver_dagplan_test.go:247` and `wshserver_landing_test.go:396` assert `strings.Contains(err.Error(), "the final stage has not failed")`; change that substring to `"the final stage has not finished"` in both. Then `grep -rn "has not failed" pkg cmd --include=*.go` prints nothing.

- [ ] **Step 9: Run the package**

Run: `git diff --name-only main > /tmp/changed.txt && ARC_VERIFY_CHANGED=/tmp/changed.txt node scripts/verify.mjs ./pkg/orchestrate ./pkg/wshrpc/wshserver ./cmd/wsh/cmd`
Expected: PASS. Then `gofmt -l pkg/orchestrate/round.go pkg/orchestrate/queue.go pkg/orchestrate/round_test.go pkg/orchestrate/final_test.go pkg/wshrpc/wshserver/wshserver_dagplan_test.go pkg/wshrpc/wshserver/wshserver_landing_test.go` prints nothing.

- [ ] **Step 10: Commit**

```bash
git add pkg/orchestrate/round.go pkg/orchestrate/queue.go pkg/orchestrate/round_test.go pkg/orchestrate/final_test.go pkg/wshrpc/wshserver/wshserver_dagplan_test.go pkg/wshrpc/wshserver/wshserver_landing_test.go cmd/wsh/cmd/wshcmd-jarvisdag.go
git commit -m "feat(orchestrate): a finished run takes one round for its in-goal leftovers"
```

### Task 2: The dag inherits the run's effort link

**Depends on:** Task 1

**Files:** `pkg/wshrpc/wshserver/wshserver_dag.go`, `pkg/wshrpc/wshserver/wshserver_dagplan_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (new `runEffortOID`; default after `proposed.EffortOID = plan.EffortOID` at line 328)
- Test: `pkg/wshrpc/wshserver/wshserver_dagplan_test.go`

**Interfaces:**
- Produces: `func runEffortOID(run *waveobj.Run) string` in package `wshserver`: `run.EffortRef.EffortOID`, or `""` when the run has no link. Task 3 calls it from `handSetupToLead`.
- Produces: `TaskGroup.EffortOID` is set for every dag whose run has a composer link and whose plan names no effort. Task 3 reads it as the lead's effort.

- [ ] **Step 1: Write the failing test**

Add a subtest inside the test function in `wshserver_dagplan_test.go` that holds `"the plan's effort and chunks are stored, and must exist"` (same `ctx`, `newRun`, `writePlan` helpers):

```go
	t.Run("a plan with no effort takes the run's, and a plan's own effort wins", func(t *testing.T) {
		linked := &waveobj.Effort{Title: "linked", Chunks: []waveobj.EffortChunk{{Label: "build it", Status: "pending"}}}
		named := &waveobj.Effort{Title: "named", Chunks: []waveobj.EffortChunk{{Label: "other", Status: "pending"}}}
		for _, e := range []*waveobj.Effort{linked, named} {
			if err := effortstore.Create(ctx, e); err != nil {
				t.Fatal(err)
			}
		}
		link := func(t *testing.T, channelId, runId string) {
			if err := wstore.UpdateRun(ctx, channelId, runId, func(r *waveobj.Run) error {
				r.EffortRef = &waveobj.RunEffortRef{EffortOID: linked.OID, ChunkLabel: "build it"}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		}
		bare := "### Task 1: a\ndo a\n"

		channelId, runId := newRun(t)
		link(t, channelId, runId)
		g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: writePlan(t, "plan.md", bare)})
		if err != nil {
			t.Fatal(err)
		}
		if g.EffortOID != linked.OID {
			t.Fatalf("a plan with no effort takes the run's link, got %q", g.EffortOID)
		}

		channelId, runId = newRun(t)
		link(t, channelId, runId)
		g, err = (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: writePlan(t, "plan.md", "**Effort:** effort:"+named.OID+"\n\n"+bare)})
		if err != nil {
			t.Fatal(err)
		}
		if g.EffortOID != named.OID {
			t.Fatalf("the plan's own effort wins over the run's link, got %q", g.EffortOID)
		}

		channelId, runId = newRun(t)
		g, err = (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: writePlan(t, "plan.md", bare)})
		if err != nil {
			t.Fatal(err)
		}
		if g.EffortOID != "" {
			t.Fatalf("no link and no plan effort leaves the dag without one, got %q", g.EffortOID)
		}
	})
```

If `wstore` is not yet imported in that test file, add `"github.com/wavetermdev/waveterm/pkg/wstore"`.

- [ ] **Step 2: Run it to see it fail**

Run: `go test ./pkg/wshrpc/wshserver -run '^TestDagSubmitFromPlanPath$' -v`
Expected: FAIL on "a plan with no effort takes the run's link, got \"\"".

- [ ] **Step 3: Implement**

In `wshserver_dag.go`, beside `checkDagEffort`:

```go
// runEffortOID is the effort the run was started from in the composer, or "" when it has none.
func runEffortOID(run *waveobj.Run) string {
	if run == nil || run.EffortRef == nil {
		return ""
	}
	return run.EffortRef.EffortOID
}
```

After `proposed.EffortOID = plan.EffortOID` (line 328):

```go
	// the lead files the run's open issues on the dag's effort; a plan that names none still belongs to the run's
	if proposed.EffortOID == "" {
		proposed.EffortOID = runEffortOID(run)
	}
```

This sits after `checkDagEffort`, which only validates the plan's own effort: a plan with no effort line has no `**Chunk:**` lines (the parser refuses that), so the run's effort needs no chunk check here.

- [ ] **Step 4: Run the package**

Run: `git diff --name-only main > /tmp/changed.txt && ARC_VERIFY_CHANGED=/tmp/changed.txt node scripts/verify.mjs ./pkg/wshrpc/wshserver`
Expected: PASS. Then `gofmt -l pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshserver/wshserver_dagplan_test.go` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshserver/wshserver_dagplan_test.go
git commit -m "feat(dag): a plan with no effort line takes the run's composer effort"
```

### Task 3: The lead runs the round and files the rest on the run's effort

**Depends on:** Task 1, Task 2

**Files:** `pkg/jarvis/leadprompt.go`, `pkg/orchestrate/wake.go`, `pkg/wshrpc/wshserver/wshserver_runs.go`, `pkg/wshrpc/wshserver/wshserver_dag.go`, `cmd/wsh/cmd/wshcmd-jarvisdag.go`, `docs/orchestrator-guide.md`, `pkg/jarvis/leadprompt_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`
- Modify: `pkg/jarvis/leadprompt.go` (`OrchestrationRules`, `PlanLeadPrompt`)
- Modify: `pkg/orchestrate/wake.go:451` (`startLead`)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go:557` (`handSetupToLead`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`submitFixRound` doc comment only)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go:1093` (`dagRulesText`)
- Modify: `docs/orchestrator-guide.md` (rows at lines ~603-604 and ~987, the fix-round paragraph at ~852-860, the command row at ~1056)
- Test: `pkg/jarvis/leadprompt_test.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

**Interfaces:**
- Consumes: `roundLeftLine` wording from Task 1 (the wake opens "One round is left"); `runEffortOID(run *waveobj.Run) string` and `TaskGroup.EffortOID` from Task 2.
- Produces: `OrchestrationRules(runId, specPath, planPath, effortOID string) string` and `PlanLeadPrompt(principles waveobj.PrincipleList, runId, specPath, planPath, effortOID, wake string) string`.

- [ ] **Step 1: Write the failing tests**

In `leadprompt_test.go`, add:

```go
// the rules name the run's effort, so open issues land on it instead of on a new effort each run
func TestOrchestrationRulesNameTheRunsEffort(t *testing.T) {
	if r := OrchestrationRules("run-1", "", "", "eff-1"); !strings.Contains(r, " Effort: effort:eff-1.") {
		t.Fatalf("rules should name the run's effort:\n%s", r)
	}
	if r := OrchestrationRules("run-1", "", "", ""); strings.Contains(r, "Effort: effort:") {
		t.Fatalf("a run with no effort names none:\n%s", r)
	}
}
```

In `TestOrchestrationRulesCompleteOnTheirOwn`, add `"wsh jarvis dag submit --round --plan <fix plan>"` and `"a round is left"` to the `want` list, and after the loop assert the old ban is gone:

```go
	if strings.Contains(r, "Don't add tasks.") {
		t.Fatalf("a finished run may add tasks through a round:\n%s", r)
	}
	if strings.Contains(r, "propose a fix round") {
		t.Fatalf("a round needs no ask; asking after the last round is the failed-final rule's:\n%s", r)
	}
```

In the same test, change the `want` entry `"only when a decision is needed: a verification failed, a deviation needs the human's call, or you propose a fix round"` to `"only when a decision is needed: a verification failed or a deviation needs the human's call"`.

In `wshcmd-jarvisdag_test.go`, change `TestDagRulesTextOnlyForTheLead`'s group to carry `EffortOID: "eff-1"` and its expected value to `jarvis.OrchestrationRules("lead-run", "C:/p/spec.md", "C:/p/plan.md", "eff-1")`. In `TestDagRulesTextNamesTheLeadsOwnDocs`, pass `""` as the new last argument.

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./pkg/jarvis -run '^TestOrchestrationRules'`
Expected: FAIL to compile (too many arguments to `OrchestrationRules`).

- [ ] **Step 3: Implement the rules**

In `leadprompt.go`:

1. Change the signature to `func OrchestrationRules(runId, specPath, planPath, effortOID string) string`, and after the `planPath` sentence add:

```go
	if effortOID != "" {
		fmt.Fprintf(&b, " Effort: effort:%s.", effortOID)
	}
```

2. Replace the run-finished `b.WriteString(...)` (line 72) with:

```go
	b.WriteString("- run finished: review what landed with `wsh jarvis dag status`; a task's full outcome is `wsh jarvis dag report <task> [section]`, and a cut text in a wake ends with that command, while `dag status` names it on each done task's report line. Fix and commit what the landed tasks left behind in docs (a stale doc line, a shipped plan). A code defect is never a wrap-up commit, since nothing reviews it. Collect the open issues from the tasks' Found not fixed and Not verified sections and anything you noticed. When the wake says a round is left and some open issues are defects inside the run's goal that a worker can fix, write a fix plan for only those in the plan format, run `wsh jarvis dag submit --round --plan <fix plan>` and stop: the round's tasks are reviewed, the final stage runs again, and you wrap up at the next run-finished wake. Failures already on the base, work outside the goal, checks that need the human or an environment, and whatever a round left are not round work. To wrap up, write the report to a file, for judgment only: one line per task on what it did; the decisions you made (answers, skips, tells, sendbacks, a round) and why; wrap-up commits; and the open issues, each with its effort chunk. Don't list landed commits, worktrees left behind, answered or forwarded counts or the unverified list: the engine records those. Add each open issue as a pending chunk on the effort named above, or the one the goal names (`wsh effort chunk add <effort> \"<issue>\"`); with neither, create one with `wsh effort create \"<title>\" --chunk \"<issue>\"`. ")
```

3. In the next `fmt.Fprintf` (line 73), replace the closing sentence `Don't add tasks.` with `Add tasks only through a round.`, and replace "a verification failed, a deviation needs the human's call, or you propose a fix round" with "a verification failed or a deviation needs the human's call": a round is submitted without an ask, and the failed-final rule already covers asking after the last round.

4. Change `PlanLeadPrompt` to `func PlanLeadPrompt(principles waveobj.PrincipleList, runId, specPath, planPath, effortOID, wake string) string` and pass `effortOID` to `OrchestrationRules`.

- [ ] **Step 4: Update the callers**

- `pkg/orchestrate/wake.go:451` (`startLead`): pass `g.EffortOID` after the plan path.
- `pkg/wshrpc/wshserver/wshserver_runs.go:557` (`handSetupToLead`): pass `runEffortOID(&run)` after `planPath`; no dag exists yet when Setup fails.
- `cmd/wsh/cmd/wshcmd-jarvisdag.go:1093` (`dagRulesText`): pass `g.EffortOID`.
- `pkg/wshrpc/wshserver/wshserver_dag.go` (`submitFixRound`'s doc comment, ~line 406): change "after its final stage failed" to "after its final stage finished".
- `pkg/jarvis/leadprompt_test.go`: add `""` as the effort argument to every existing `OrchestrationRules(...)` and `PlanLeadPrompt(...)` call (`grep -n "OrchestrationRules(\|PlanLeadPrompt(" pkg/jarvis/leadprompt_test.go`).

Run `go build ./cmd/wsh/... ./cmd/server/...` to catch any caller left (`go build -o /dev/null` fails on Windows).

- [ ] **Step 5: Update the orchestrator guide**

In `docs/orchestrator-guide.md`:
- Row "Run finished" (~line 604): replace "adds open issues to the initiative" with "runs one round for the open issues inside the goal when the wake says a round is left, and adds the rest to the run's effort"; in its last column replace "(a failed verification, a deviation, a proposed fix round)" with "(a failed verification or a deviation)".
- Row "Final stage failed" (~line 603): unchanged.
- "The fix round." paragraph (~852-860): add after its first sentence: "A run whose final stage passed or finished unverified takes the same round for the open issues inside its goal that a worker can fix, when a round is left: the run-finished wake ends with a line saying whether one is."; and change "`--round` is refused, with the reason, while the stage is still running, after it passed, or when no round is left" to "`--round` is refused, with the reason, while the stage is still running or when no round is left".
- Row "The run's report" (~987): replace "(a code defect found then is an open issue, not a wrap-up commit)" with "(a code defect is never a wrap-up commit: with a round left, the in-goal ones go to a round)", and "on the initiative (creating one if the run has none)" with "on the run's effort, the plan's `**Effort:**` line or else the one picked in the composer (creating one if the run has neither)", and "a failed verification, a deviation that needs your call, or a proposed fix round" with "a failed verification or a deviation that needs your call".
- Command row (~1056): `dag submit --round --plan <fix plan>` now reads "after the final stage finishes with a round left, append the fix plan's tasks as a round".

Read each passage before editing; line numbers are approximate.

- [ ] **Step 6: Run the packages**

Run: `git diff --name-only main > /tmp/changed.txt && ARC_VERIFY_CHANGED=/tmp/changed.txt node scripts/verify.mjs ./pkg/jarvis ./pkg/orchestrate ./pkg/wshrpc/wshserver ./cmd/wsh/cmd`
Expected: PASS. Then `gofmt -l` the touched Go files prints nothing.

- [ ] **Step 7: Commit**

```bash
git add pkg/jarvis/leadprompt.go pkg/jarvis/leadprompt_test.go pkg/orchestrate/wake.go pkg/wshrpc/wshserver/wshserver_runs.go pkg/wshrpc/wshserver/wshserver_dag.go cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-jarvisdag_test.go docs/orchestrator-guide.md
git commit -m "feat(lead): a finished run's lead runs a round for in-goal leftovers and files the rest on the run's effort"
```
