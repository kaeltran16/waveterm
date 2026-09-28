# Orchestrator actionable smalls Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/orchestrate/... ./pkg/jarvis/... ./pkg/wshrpc/... ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshrpc/... ./cmd/wsh/...`

**Goal:** Fix four open orchestrator rows. Background stages no longer outlive their tests. A human can end a stuck final stage. The final verifier stops re-running suites the stage already passed. Finding 49's second route is documented and tested.

**Architecture:** Tasks 1, 2 and 4 all edit `pkg/orchestrate/final.go`, `verifier.go` or their tests, so they run as a chain (1, then 2, then 4). Tasks 3 (frontend) and 5 (`pkg/jarvis`) run beside them. The human action reuses `DagActionCommand` with two new actions, so no RPC type changes and nothing to regenerate.

**Tech Stack:** Go (`pkg/orchestrate`, `pkg/jarvis`, `pkg/wshrpc/wshserver`, `cmd/wsh`), React 19 + jotai + Tailwind 4, vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-orchestrator-actionable-smalls-design.md` (read it first; this plan argues from it).

## Global Constraints

- Do not touch the worker brief (`pkg/orchestrate/engine.go` brief text), `pkg/jarvis/leadprompt.go`, `PlanFormat`, `takeLeadTold`, or the output of existing wsh commands: another run owns them.
- Never hand-edit generated files (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`, …). This plan changes no RPC type, so none should change.
- Colors come from existing `@theme` tokens only; no raw hex/rgba and no new tokens (`DESIGN.md`).
- Comments explain why, never what; lower case; only when needed. Match the surrounding code's idiom.
- Run only focused tests with `-run '<names>'` (Go) or a single vitest file. Per-merge Verify and the final stage run the packages, and a whole-package run can hit the 600 s tool cap. **The one exception is Task 1's measurement step**, which needs one full run of `./pkg/orchestrate/` and redirects its output to a file.
- Commit messages carry no `Co-Authored-By`, `Claude-Session` or other trailer.

## Review Focus

- A human ends the stage while its Final command is mid-run: the command's goroutine returns later and must record nothing over the human's outcome. Pinned by `TestAHumanEndsARunningFinalCommand` (Task 2).
- The verifier sends its verdict after a human has ended the stage: the verdict must be refused and must not change the recorded outcome. Pinned in `TestAHumanEndsAVerifyingStage` (Task 2).
- `end-final` on a run whose stage has not started or has already finished: a clear refusal that names the state, not a silent success. Pinned by `TestRefusedFinalStageEnds` (Task 2).
- A reason that is only whitespace, from the CLI or the run sheet: refused by the engine. The run sheet also keeps both outcome buttons disabled. Pinned by `TestRefusedFinalStageEnds` (Task 2).
- A plan with no Check, Verify or Final: the verifier brief must not claim that commands ran. Pinned by `TestTheVerifierBriefNamesNoCommandsWhenThePlanHasNone` (Task 4).

---

### Task 1: Background stages cannot outlive their tests

**Depends on:** none

**Files:**
- Create: `pkg/orchestrate/stages.go`
- Modify: `pkg/orchestrate/final.go` (`startFinalCommands`, the `go func()` at about line 154)
- Modify: `pkg/orchestrate/verify.go` (`startVerify`, the `go func()` at about line 297)
- Modify: `pkg/orchestrate/basecheck.go` (`startBaseCheck`, the `go func()` at about line 68)
- Modify: `pkg/orchestrate/verifier.go` (`releaseFinalTree`'s retry `go func()` at about line 187)
- Modify: `pkg/orchestrate/maintest_test.go` (add `waitStages`, `restoreAfterStages`, `stageLeakTimeout`)
- Modify: the shared fixtures that swap a hook a stage calls: `newFakeLead` (`wake_test.go`), `awaitVerify` (`verify_test.go`), `stubPlanCommandProgress` (`setup_test.go`), `awaitFinal` (`final_test.go`), the base-check waiter (`basecheck_test.go:~21`), `captureSpawns` and `useVerifier` (`verifier_test.go` and wherever `captureSpawns` lives). Find any others with `grep -n "t.Cleanup(func() {" pkg/orchestrate/*_test.go`: a restore of a package var that a stage goroutine reaches, directly or through `Schedule`, moves to `restoreAfterStages`.
- Modify: whichever tests the measurement shows leaking.

**Interfaces:**
- Produces: `goStage(name string, fn func())` and `runningStages() []string` (package-internal), plus the test helpers `waitStages(t)` and `restoreAfterStages(t, restore func())`.

- [ ] **Step 1: Add the tracker.** `pkg/orchestrate/stages.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"sort"
	"sync"
)

// stages counts the background stages the engine runs off a tick, by name. Tests wait until none is running
// before they restore the hooks a stage calls, so no stage lands in the next test's fakes. A named count, not
// a sync.WaitGroup: a wait that times out can say what is still running, and never races a stage's Add.
var stages = struct {
	sync.Mutex
	running map[string]int
}{running: make(map[string]int)}

// goStage runs fn on its own goroutine as the named background stage.
func goStage(name string, fn func()) {
	stages.Lock()
	stages.running[name]++
	stages.Unlock()
	go func() {
		defer func() {
			stages.Lock()
			stages.running[name]--
			if stages.running[name] == 0 {
				delete(stages.running, name)
			}
			stages.Unlock()
		}()
		fn()
	}()
}

// runningStages names the stages still running, sorted.
func runningStages() []string {
	stages.Lock()
	defer stages.Unlock()
	names := make([]string, 0, len(stages.running))
	for name := range stages.running {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
```

- [ ] **Step 2: Join the four goroutines.** Replace each `go func() { … }()` with `goStage(<name>, func() { … })`, body unchanged:
  - `final.go` `startFinalCommands`: `goStage("final "+dagID, func() { … })`
  - `verify.go` `startVerify`: `goStage("verify "+dagID, func() { … })`
  - `basecheck.go` `startBaseCheck`: `goStage("basecheck "+dagID, func() { … })`
  - `verifier.go` `releaseFinalTree`: `goStage("final-tree "+dagID, func() { … })`

- [ ] **Step 3: Add the test helpers** to `maintest_test.go`:

```go
// stageLeakTimeout bounds how long a test's cleanup waits for the background stages it started.
const stageLeakTimeout = 10 * time.Second

// waitStages waits until no background stage is running, and fails the test, naming them, if some still are
// after stageLeakTimeout: a stage that outlives its test lands in the next test's fakes.
func waitStages(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(stageLeakTimeout)
	for len(runningStages()) > 0 {
		if time.Now().After(deadline) {
			t.Errorf("background stages outlived the test: %s", strings.Join(runningStages(), ", "))
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// restoreAfterStages restores a swapped hook once the test's background stages have finished with it.
func restoreAfterStages(t *testing.T, restore func()) {
	t.Helper()
	t.Cleanup(func() {
		waitStages(t)
		restore()
	})
}
```

- [ ] **Step 4: Route the shared fixtures through it.** For example, in `awaitVerify`, `t.Cleanup(func() { verifyFinished = orig })` becomes `restoreAfterStages(t, func() { verifyFinished = orig })`. Do the same for `newFakeLead`, `stubPlanCommandProgress`, `awaitFinal`, the base-check waiter, `captureSpawns` and `useVerifier`, plus any other restore that the grep in this task's Files list finds a stage reaching. `maintest_test.go` needs the `strings` and `time` imports for the helpers.

- [ ] **Step 5: Measure.** Run the package once, to a file (about 100 s; the file keeps the result if the tool call is cut off):

```bash
go test ./pkg/orchestrate/ -count=1 > /tmp/orch-leaks.txt 2>&1; grep -E "^--- FAIL|outlived the test" /tmp/orch-leaks.txt
```

Record in the task's report the number of tests that failed on a leak, their names, and the stages each leaked.

- [ ] **Step 6: Fix each leak in its test, not in the tracker.** Per test, one of:
  - wait for the stage it started (`awaitVerify()`, `awaitFinal()`, or the base-check waiter), as `8b88821e` did for the mid-batch conflict test;
  - release what it blocked (`blockingVerify.open()`), or cancel the dag (`Cancel(f.ctx, f.dagID)`) when it deliberately leaves a stage blocked;
  - for a `final-tree` retry, shorten `finalTreeRemoveInterval` in that test the way `land_test.go:154` shortens `landTreeRetryEvery`.

  If a leak comes from a goroutine outside the four (only `land.go:150` `retryLandTreeRemoval` is a candidate), join it with `goStage("land-tree "+runID, …)` and name it in the report.

- [ ] **Step 7: Re-run the tests you changed**, by name: `go test ./pkg/orchestrate/ -count=1 -run '^(TestA|TestB)$'`. They pass with no "outlived the test" line. Leave the full-package run to Verify.

- [ ] **Step 8: Commit.** `git add pkg/orchestrate && git commit -m "fix(orchestrate): background stages join a tracker the test fixtures wait on, so none outlives its test"`, with the leak count from Step 5 in the body.

### Task 2: A human ends a stuck final stage (engine, RPC, `wsh runs end-final`)

**Depends on:** Task 1

**Files:**
- Modify: `pkg/orchestrate/final.go` (add `EndFinalStage`, `finalEndedByHuman`, `settleFinalLocked`)
- Modify: `pkg/orchestrate/verifier.go` (`RecordFinalVerdict` uses `settleFinalLocked`; nothing else in this file)
- Create: `pkg/orchestrate/finalend_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`DagActionCommand`: new case)
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (the `Action` and `Notes` comments only)
- Modify: `cmd/wsh/cmd/wshcmd-runs.go`, `cmd/wsh/cmd/wshcmd-runs_test.go`
- Modify: `docs/orchestrator-guide.md` ("The final stage" section, after the verifier's step, about line 592)

**Interfaces:**
- Produces: `orchestrate.EndFinalStage(ctx context.Context, dagID, outcome, reason string) error`, where outcome is `FinalState_Unverified` or `FinalState_Failed`. It also produces the dag actions `final-end-unverified` and `final-end-failed` (the reason goes in `Notes`, `RunId` is the orchestrator run), which Task 3 calls.

- [ ] **Step 1: Write the failing tests** in `pkg/orchestrate/finalend_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestAHumanEndsAVerifyingStage(t *testing.T) {
	cases := []struct{ outcome, wantStatus string }{
		{FinalState_Unverified, DagStatus_Done},
		{FinalState_Failed, DagStatus_Blocked},
	}
	for _, c := range cases {
		t.Run(c.outcome, func(t *testing.T) {
			f, lead, verifierID := verifyingFixture(t)
			tree := f.dag(t).Final.Tree

			if err := EndFinalStage(f.ctx, f.dagID, c.outcome, "  the verifier's tools were rejected  "); err != nil {
				t.Fatal(err)
			}

			g := f.dag(t)
			want := "ended by the human: the verifier's tools were rejected"
			if g.Final.State != c.outcome || g.Status != c.wantStatus {
				t.Fatalf("want %s / %s, got %s / %s", c.outcome, c.wantStatus, g.Final.State, g.Status)
			}
			if c.outcome == FinalState_Failed {
				if g.Final.Detail != want || len(lead.sends) != 1 || !strings.Contains(lead.sends[0], want) {
					t.Fatalf("a failed end is the stage's Detail and wakes the lead with it, got %q / %q", g.Final.Detail, lead.sends)
				}
			} else if !slices.Contains(g.Final.Unverified, want) || g.Final.Detail != "" {
				t.Fatalf("an unverified end records the reason, got %+v", g.Final)
			}
			if g.Final.VerifierRunID != verifierID {
				t.Fatalf("the verifier stays on the stage for the usage totals, got %q", g.Final.VerifierRunID)
			}
			verifier, err := wstore.GetRun(f.ctx, f.channel, verifierID)
			if err != nil || verifier.Status != jarvis.RunStatus_Cancelled {
				t.Fatalf("the verifier's run is cancelled, got %+v / %v", verifier, err)
			}
			if err := RecordFinalVerdict(f.ctx, f.dagID, verifierID, ReviewVerdict_Pass, "late", ""); err == nil {
				t.Fatal("a verdict after the human ended the stage must be refused")
			}
			if got := f.dag(t).Final.State; got != c.outcome {
				t.Fatalf("the refused verdict changes nothing, got %s", got)
			}
			if _, err := os.Stat(tree); !os.IsNotExist(err) {
				t.Fatalf("the detached final tree is removed, stat err %v", err)
			}
		})
	}
}

func TestAHumanEndsARunningFinalCommand(t *testing.T) {
	f := finalFixture(t, passVerify, "", "sleep 30")
	await := awaitFinal(t)
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for f.dag(t).Final.State != FinalState_Final {
		if time.Now().After(deadline) {
			t.Fatal("the Final command did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}

	if err := EndFinalStage(f.ctx, f.dagID, FinalState_Unverified, "the dev app hangs on boot"); err != nil {
		t.Fatal(err)
	}
	await() // returns well before the sleep only if the end stopped the command

	g := f.dag(t)
	if g.Final.State != FinalState_Unverified || g.Status != DagStatus_Done || !slices.Contains(g.Final.Unverified, "ended by the human: the dev app hangs on boot") {
		t.Fatalf("the command's late result must not overwrite the human's end, got %s / %+v", g.Status, g.Final)
	}
}

func TestRefusedFinalStageEnds(t *testing.T) {
	f := finalFixture(t, passVerify, "", "")
	cases := []struct{ name, outcome, reason, want string }{
		{"not started", FinalState_Unverified, "r", "not started"},
		{"bad outcome", FinalState_Passed, "r", "must be unverified or failed"},
		{"blank reason", FinalState_Failed, "   ", "needs the human's reason"},
		{"long reason", FinalState_Failed, strings.Repeat("r", MaxReviewNoteLen+1), "the limit is 2000"},
	}
	for _, c := range cases {
		if err := EndFinalStage(f.ctx, f.dagID, c.outcome, c.reason); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: want an error with %q, got %v", c.name, c.want, err)
		}
	}
	g := runFinal(t, f) // TestMain's skipVerifier ends it passed
	if g.Final.State != FinalState_Passed {
		t.Fatalf("setup: want a passed stage, got %s", g.Final.State)
	}
	if err := EndFinalStage(f.ctx, f.dagID, FinalState_Failed, "r"); err == nil || !strings.Contains(err.Error(), "is passed") {
		t.Fatalf("a finished stage cannot be ended, got %v", err)
	}
}
```

- [ ] **Step 2: Run them to see them fail.** `go test ./pkg/orchestrate/ -count=1 -run '^(TestAHumanEndsAVerifyingStage|TestAHumanEndsARunningFinalCommand|TestRefusedFinalStageEnds)$'`. Expected: a build failure, `undefined: EndFinalStage`.

- [ ] **Step 3: Share the finish tail.** In `final.go`, add the helper and move `RecordFinalVerdict`'s tail onto it:

```go
// settleFinalLocked ends a stage whose outcome is decided and persists the dag: the verifier's verdict and a
// human's end both finish through it. The caller holds the dag mutation lock and runs afterCommit after it.
func settleFinalLocked(ctx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run, afterCommit *[]func()) error {
	finishFinal(g, afterCommit)
	releaseFinalTree(g, owner, afterCommit)
	RecomputeDagStatus(g)
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	return nil
}
```

In `RecordFinalVerdict` (`verifier.go`), replace everything from `finishFinal(g, &afterCommit)` through `wcore.SendWaveObjUpdate(...)` and its `return nil` with `return settleFinalLocked(ctx, g, owner, &afterCommit)`. The `dagID` it used is `g.OID`.

- [ ] **Step 4: Add `EndFinalStage`** in `final.go` (add `strings` and `unicode/utf8` to its imports):

```go
// finalEndedByHuman opens the reason a human gave for ending a running final stage.
const finalEndedByHuman = "ended by the human: "

// EndFinalStage ends a running final stage on the human's word, as unverified or failed, with reason recorded
// where every final outcome is: failed is the stage's Detail and wakes the lead as a verifier's fail does. It
// stops what is running: the stage's commands, or its verifier. The caller schedules the dag afterwards.
func EndFinalStage(ctx context.Context, dagID, outcome, reason string) error {
	reason = strings.TrimSpace(reason)
	switch {
	case outcome != FinalState_Unverified && outcome != FinalState_Failed:
		return fmt.Errorf("the outcome must be %s or %s, got %q", FinalState_Unverified, FinalState_Failed, outcome)
	case reason == "":
		return fmt.Errorf("ending the final stage needs the human's reason")
	}
	if count := utf8.RuneCountInString(reason); count > MaxReviewNoteLen {
		return fmt.Errorf("the reason is %d characters; the limit is %d", count, MaxReviewNoteLen)
	}
	var afterCommit []func()
	err := withDagMutation(dagID, func() error {
		g, err := wstore.GetDag(ctx, dagID)
		if err != nil {
			return fmt.Errorf("loading dag: %w", err)
		}
		f := g.Final
		switch {
		case g.Status == DagStatus_Cancelled:
			return fmt.Errorf("run %s is cancelled; its final stage is not running", g.RunID)
		case f == nil || f.State == "":
			return fmt.Errorf("run %s's final stage has not started; only a running one can be ended", g.RunID)
		case finalTerminal(f.State):
			return fmt.Errorf("run %s's final stage is %s; only a running one can be ended", g.RunID, f.State)
		}
		owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
		if err != nil {
			return fmt.Errorf("loading the dag's run: %w", err)
		}
		switch f.State {
		case FinalState_Checking, FinalState_Final:
			// the commands' goroutine finds the stage ended when it comes back, and records nothing
			afterCommit = append(afterCommit, func() { stopDagFinal(dagID) })
		case FinalState_Verifying:
			if f.VerifierRunID != "" {
				stopReviewer(ctx, g, f.VerifierRunID, &afterCommit)
			}
		}
		if outcome == FinalState_Failed {
			f.Detail = finalEndedByHuman + reason
		} else {
			f.Unverified = append(f.Unverified, finalEndedByHuman+reason)
			channelID, runID := g.ChannelId, g.RunID
			afterCommit = append(afterCommit, func() {
				PostQuiet(ctx, channelID, runID, "the human ended the final stage unverified: "+flatLine(reason))
			})
		}
		return settleFinalLocked(ctx, g, owner, &afterCommit)
	})
	if err != nil {
		return err
	}
	for _, fn := range afterCommit {
		fn()
	}
	return nil
}
```

The refusal for a finished stage reads "run X's final stage is passed", which is what `TestRefusedFinalStageEnds` matches.

- [ ] **Step 5: Run the Step 1 tests, plus the verdict tests the refactor touches.** `go test ./pkg/orchestrate/ -count=1 -run '^(TestAHumanEndsAVerifyingStage|TestAHumanEndsARunningFinalCommand|TestRefusedFinalStageEnds|TestFinalVerdicts|TestRefusedFinalVerdicts|TestAVerifierLostTwiceLeavesTheResultUnverified)$'`. Expected: PASS.

- [ ] **Step 6: The RPC case.** In `DagActionCommand` (`wshserver_dag.go`), after the `"final-pass", "final-fail"` case:

```go
	case "final-end-unverified", "final-end-failed":
		// the human's end: RunId is the orchestrator run, so no verifier run id is needed, and no tab is marked complete
		outcome := orchestrate.FinalState_Unverified
		if data.Action == "final-end-failed" {
			outcome = orchestrate.FinalState_Failed
		}
		if err := orchestrate.EndFinalStage(ctx, run.DagORef, outcome, data.Notes); err != nil {
			return err
		}
		// the tick announces the dag done, or hands a failed stage to the lead
		dagID := run.DagORef
		go func() {
			if err := orchestrate.Schedule(context.Background(), dagID); err != nil {
				log.Printf("dag schedule after ending the final stage: %v", err)
			}
		}()
		return nil
```

In `wshrpctypes_dag.go`, append `| final-end-unverified | final-end-failed` to the `Action` comment, and add `final-end-*: the human's reason;` to the `Notes` comment.

- [ ] **Step 7: The failing CLI test.** In `wshcmd-runs_test.go`:

```go
func TestRunsEndFinalSendsTheDagAction(t *testing.T) {
	req := fakeRunsRpc(t, func() error { return runsEndFinal("ch-1", "r-1", "final-end-failed", "the verifier is stuck") }, nil)
	var data wshrpc.CommandDagActionData
	b, _ := json.Marshal(req.Data)
	json.Unmarshal(b, &data)
	want := wshrpc.CommandDagActionData{ChannelId: "ch-1", RunId: "r-1", Action: "final-end-failed", Notes: "the verifier is stuck"}
	if req.Command != "dagaction" || !reflect.DeepEqual(data, want) {
		t.Fatalf("request = %s %+v, want dagaction %+v", req.Command, data, want)
	}
}

func TestRunsEndFinalAction(t *testing.T) {
	for word, want := range map[string]string{"unverified": "final-end-unverified", "failed": "final-end-failed"} {
		if got, err := runsEndFinalAction(word); err != nil || got != want {
			t.Errorf("%s: got %q, %v; want %q", word, got, err, want)
		}
	}
	if _, err := runsEndFinalAction("passed"); err == nil || !strings.Contains(err.Error(), "unverified or failed") {
		t.Fatalf("passed is not an outcome a human ends a stage with, got %v", err)
	}
}
```

Check the RPC command name with `grep -n "func DagActionCommand" -A3 pkg/wshrpc/wshclient/wshclient.go` and use the string it sends. Add `reflect` and `strings` to the test imports if they are missing. Run `go test ./cmd/wsh/cmd/ -count=1 -run '^TestRunsEndFinal'`. Expected: a build failure, `undefined: runsEndFinal`.

- [ ] **Step 8: The command** in `wshcmd-runs.go`:

```go
var runsEndFinalCmd = &cobra.Command{
	Use:   "end-final <run-id> unverified|failed <reason>",
	Short: "end a run's stuck final stage as unverified or failed, with the reason recorded",
	Long: fmt.Sprintf(`End an orchestrator run's final stage while it is still running (Check, Verify, the Final command,
or the verifier), when it is stuck and waiting it out is not worth it: the verifier has %s, the Final
command %s. unverified finishes the run done but unverified. failed fails the stage as a verifier's fail
does: the lead gets the reason and plans a fix round from it (cancel the run for none). The reason is
recorded on the run's final stage.`, orchestrate.ReviewTimeout, orchestrate.FinalTimeout),
	Args:    cobra.ExactArgs(3),
	PreRunE: preRunSetupRpcClient,
	RunE:    runsEndFinalRun,
}

// runsEndFinalAction is the dag action for end-final's outcome word.
func runsEndFinalAction(word string) (string, error) {
	switch word {
	case "unverified", "failed":
		return "final-end-" + word, nil
	}
	return "", fmt.Errorf("the outcome must be unverified or failed, got %q", word)
}

func runsEndFinalRun(cmd *cobra.Command, args []string) error {
	action, err := runsEndFinalAction(args[1])
	if err != nil {
		return err
	}
	ch, run, err := runsFind(cmd, args[0])
	if err != nil {
		return err
	}
	if err := runsEndFinal(ch.OID, run.ID, action, args[2]); err != nil {
		return err
	}
	fmt.Printf("ended run %s's final stage: %s\n", run.ID, args[1])
	return nil
}

// runsEndFinal waits as long as a cancel does: stopping the verifier stops its worker
func runsEndFinal(channelId, runId, action, reason string) error {
	return wshclient.DagActionCommand(RpcClient, wshrpc.CommandDagActionData{ChannelId: channelId, RunId: runId, Action: action, Notes: reason}, &wshrpc.RpcOpts{Timeout: runsCancelTimeoutMs})
}
```

In `init()`, add `runsEndFinalCmd` to the `--project`/`--channel` loop's slice and to `runsCmd.AddCommand(...)`. Run the Step 7 tests. Expected: PASS.

- [ ] **Step 9: Docs.** In `docs/orchestrator-guide.md`, "The final stage", after the verifier's step, add one paragraph: a human can end a stage that is stuck in any running step, from the run sheet's **End final stage** or with `wsh runs end-final <run-id> unverified|failed "<reason>"`. It stops the running commands or the verifier. The reason is recorded on the stage as `ended by the human: …`. Failed is a verifier's fail, and the lead plans a fix round from the reason, so cancel the run when no fix round is wanted.

- [ ] **Step 10: Commit.** `git add pkg/orchestrate pkg/wshrpc cmd/wsh docs/orchestrator-guide.md && git commit -m "feat(orchestrate): a human ends a stuck final stage as unverified or failed, from wsh runs end-final"`

### Task 3: End final stage from the run sheet

**Depends on:** none

**Files:**
- Modify: `frontend/app/view/jarvis/runsheetmodel.ts` (add `finalStageEndable`)
- Modify: `frontend/app/view/jarvis/runsheetmodel.test.ts`
- Modify: `frontend/app/view/agents/runactions.ts` (add `endFinalStage`, `FinalEndOutcome`)
- Modify: `frontend/app/view/jarvis/runsheet.tsx` (`Dock` and a new `EndFinalForm` beside it)

**Interfaces:**
- Consumes: the dag actions `final-end-unverified` and `final-end-failed` (Task 2) through the existing `RpcApi.DagActionCommand`. It is safe to land before Task 2: the server refuses an unknown action with an error, which the form shows.
- Produces: `finalStageEndable(group: TaskGroup | null): boolean`.

- [ ] **Step 1: The failing model test.** Add to `runsheetmodel.test.ts`, importing `finalStageEndable`:

```ts
describe("finalStageEndable", () => {
    const group = (status: string, state?: string) =>
        ({ status, final: state == null ? undefined : { state, round: 1 } }) as unknown as TaskGroup;
    it("is true while the stage's commands or its verifier run", () => {
        for (const state of ["checking", "final", "verifying"]) {
            expect(finalStageEndable(group("finalizing", state))).toBe(true);
        }
    });
    it("is false with no stage, a stage not started, or one that ended", () => {
        expect(finalStageEndable(null)).toBe(false);
        expect(finalStageEndable(group("running"))).toBe(false);
        expect(finalStageEndable(group("finalizing", ""))).toBe(false);
        for (const state of ["passed", "unverified", "failed"]) {
            expect(finalStageEndable(group("done", state))).toBe(false);
        }
    });
    it("is false on a cancelled dag, whatever the stage last recorded", () => {
        expect(finalStageEndable(group("cancelled", "final"))).toBe(false);
    });
});
```

Run `npx vitest run frontend/app/view/jarvis/runsheetmodel.test.ts`. Expected: FAIL, `finalStageEndable` is not exported.

- [ ] **Step 2: The model.** In `runsheetmodel.ts`:

```ts
// the final stage's running states: its commands, then its verifier. A human can end any of them.
const RUNNING_FINAL_STATES = new Set(["checking", "final", "verifying"]);

export function finalStageEndable(group: TaskGroup | null): boolean {
    return group != null && group.status !== "cancelled" && RUNNING_FINAL_STATES.has(group.final?.state ?? "");
}
```

Run the Step 1 test. Expected: PASS.

- [ ] **Step 3: The action.** In `runactions.ts`:

```ts
export type FinalEndOutcome = "unverified" | "failed";

// as long as `wsh runs` waits on a cancel (runsCancelTimeoutMs): stopping the verifier stops its worker
const END_FINAL_TIMEOUT_MS = 60_000;

// endFinalStage ends a run's running final stage on the human's word; the engine records the reason on the
// stage.
export function endFinalStage(channelId: string, runId: string, outcome: FinalEndOutcome, reason: string): Promise<void> {
    return RpcApi.DagActionCommand(
        TabRpcClient,
        { channelid: channelId, runid: runId, taskid: "", action: `final-end-${outcome}`, notes: reason },
        { timeout: END_FINAL_TIMEOUT_MS }
    );
}
```

If `CommandDagActionData` in `frontend/types/gotypes.d.ts` does not mark `taskid` required, drop `taskid: ""`. Check the `RpcOpts` shape the other `RpcApi` calls in the file pass.

- [ ] **Step 4: The dock.** In `runsheet.tsx`, import `finalStageEndable` from `./runsheetmodel`, and `endFinalStage` and `FinalEndOutcome` from `@/app/view/agents/runactions`. In `Dock`, add `const [ending, setEnding] = useState(false);` and `const endable = finalStageEndable(group);`. After the Open DAG button, add:

```tsx
                {endable && !ending ? (
                    <button type="button" onClick={() => setEnding(true)} className={DOCK_BTN}>
                        End final stage
                    </button>
                ) : null}
```

Below the button row (before the `result` line), add:

```tsx
            {endable && ending ? (
                <EndFinalForm
                    ctx={ctx}
                    onClose={(text) => {
                        setEnding(false);
                        setResult(text != null ? { failed: false, text } : null);
                    }}
                    onError={(text) => setResult({ failed: true, text })}
                />
            ) : null}
```

And the form component, after `Dock`:

```tsx
// Ends a stuck final stage on the human's word. The reason is required: it is what the run records, and for
// a fail what the lead plans the fix round from.
function EndFinalForm({
    ctx,
    onClose,
    onError,
}: {
    ctx: SheetCtx;
    onClose: (done: string | null) => void;
    onError: (text: string) => void;
}) {
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const blank = reason.trim() === "";
    const end = (outcome: FinalEndOutcome) => {
        setBusy(true);
        fireAndForget(async () => {
            try {
                await endFinalStage(ctx.channel.oid, ctx.run.id, outcome, reason.trim());
                onClose(outcome === "failed" ? "Final stage failed; the lead has the reason." : "Final stage ended unverified.");
            } catch (e) {
                onError(`Ending the final stage failed: ${e instanceof Error ? e.message : String(e)}`);
                setBusy(false);
            }
        });
    };
    return (
        <div data-run-sheet-end-final className="flex flex-col gap-1.5">
            <textarea
                autoFocus
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why end it? Recorded on the run; a fail's reason goes to the lead."
                aria-label="Reason for ending the final stage"
                className="resize-none rounded-[6px] border border-edge-mid bg-transparent px-2 py-1.5 text-[12px] leading-[1.5] text-primary outline-none placeholder:text-muted focus-visible:border-accent"
            />
            <div className="flex items-center gap-2">
                <button type="button" disabled={blank || busy} onClick={() => end("unverified")} className={cn(DOCK_BTN, "disabled:opacity-60")}>
                    Pass unverified
                </button>
                <button
                    type="button"
                    disabled={blank || busy}
                    onClick={() => end("failed")}
                    className={cn(DOCK_BTN, "border-edge-mid text-muted hover:border-error hover:text-error disabled:opacity-60")}
                >
                    Fail
                </button>
                <span className="flex-1" />
                <button type="button" disabled={busy} onClick={() => onClose(null)} className={DOCK_BTN}>
                    Keep running
                </button>
            </div>
        </div>
    );
}
```

Every class name above uses existing tokens (`edge-mid`, `accent`, `error`, `primary`, `muted`), which appear elsewhere in this file or in `runcards.tsx`. Check each against `frontend/tailwindsetup.css` and swap any that is not defined for the nearest one in use.

- [ ] **Step 5: Check.** Run `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; give the call a longer timeout), then `npx prettier --check` and `npx eslint` on the four files. Expected: clean.

- [ ] **Step 6: Commit.** `git add frontend/app/view/jarvis/runsheetmodel.ts frontend/app/view/jarvis/runsheetmodel.test.ts frontend/app/view/agents/runactions.ts frontend/app/view/jarvis/runsheet.tsx && git commit -m "feat(runsheet): end a stuck final stage from the dock, with the reason recorded"`

### Task 4: The final verifier is told what already passed, and its time budget

**Depends on:** Task 2

**Files:**
- Modify: `pkg/orchestrate/verifier.go` (`verifierPrompt` only)
- Modify: `pkg/orchestrate/verifier_test.go`

**Interfaces:**
- Produces: nothing other tasks use.

- [ ] **Step 1: The failing tests.** `verifierPrompt` is pure, so test it directly. Add to `verifier_test.go`:

```go
func TestTheVerifierBriefNamesWhatPassedAndItsBudget(t *testing.T) {
	g := &waveobj.TaskGroup{
		RunID: "run-1", Check: "go vet ./...", Verify: "node scripts/verify.mjs ./pkg/...", FinalCmd: "node scripts/cdp/final-verify.mjs",
		Final: &waveobj.FinalStage{Round: 1, Tree: "/tree", Commit: "0123456789abcdef", OutDir: "/out"},
	}
	prompt := verifierPrompt(g, &waveobj.Run{BaseCommit: "base"})
	for _, want := range []string{
		"Before you started, the engine ran Check `go vet ./...`, Verify `node scripts/verify.mjs ./pkg/...` and Final `node scripts/cdp/final-verify.mjs` on 0123456",
		"Do not run Check, Verify or the Final command again, or any whole package or test suite",
		"run one named test with `-run '^TestName$'`",
		fmt.Sprintf("You have %s from your start to give a verdict", ReviewTimeout),
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("the brief must contain %q:\n%s", want, prompt)
		}
	}
}

func TestTheVerifierBriefNamesNoCommandsWhenThePlanHasNone(t *testing.T) {
	g := &waveobj.TaskGroup{RunID: "run-1", Final: &waveobj.FinalStage{Round: 1, Tree: "/tree", Commit: "0123456789abcdef"}}
	prompt := verifierPrompt(g, &waveobj.Run{})
	if strings.Contains(prompt, "the engine ran") {
		t.Fatalf("a plan with no commands ran none:\n%s", prompt)
	}
	if !strings.Contains(prompt, fmt.Sprintf("You have %s", ReviewTimeout)) {
		t.Fatalf("the budget is stated whatever ran:\n%s", prompt)
	}
}

func TestTheVerifierBriefNamesOnlyThePlansCommands(t *testing.T) {
	g := &waveobj.TaskGroup{RunID: "run-1", Verify: "task test", Final: &waveobj.FinalStage{Round: 1, Tree: "/tree", Commit: "0123456789abcdef"}}
	prompt := verifierPrompt(g, &waveobj.Run{})
	if !strings.Contains(prompt, "the engine ran Verify `task test` on 0123456") || strings.Contains(prompt, "Check `") {
		t.Fatalf("only the plan's own commands are named:\n%s", prompt)
	}
}
```

Add `fmt` to the imports. Run `go test ./pkg/orchestrate/ -count=1 -run '^TestTheVerifierBrief'`. Expected: FAIL (the lines are missing).

- [ ] **Step 2: The prompt.** In `verifierPrompt`, after the `git diff` line and before the Final-command line, add:

```go
	var ran []string
	for _, c := range []struct{ name, cmd string }{{"Check", g.Check}, {"Verify", g.Verify}, {"Final", g.FinalCmd}} {
		if c.cmd != "" {
			ran = append(ran, fmt.Sprintf("%s `%s`", c.name, c.cmd))
		}
	}
	if len(ran) > 0 {
		fmt.Fprintf(&b, "Before you started, the engine ran %s on %s, and they passed, apart from anything listed below as not verified.\n", joinAnd(ran), shortSha(head))
		b.WriteString("Do not run Check, Verify or the Final command again, or any whole package or test suite. Read the diff. To settle a specific doubt about behavior, run one named test with `-run '^TestName$'` (or its vitest equivalent).\n")
	}
	fmt.Fprintf(&b, "You have %s from your start to give a verdict. A session that gives none is stopped and replaced %s, and then the result is left unverified.\n", ReviewTimeout, timesWord(MaxReviewRespawns))
```

Look for existing helpers before writing them: `grep -rn "func shortSha\|func short\b\|func joinAnd\|func englishList" pkg/orchestrate pkg/jarvis`. Reuse whatever exists. Otherwise add these small ones to `verifier.go`:
- `joinAnd`: `"A"`, `"A and B"`, `"A, B and C"`.
- `shortSha`: the first 7 characters, or the whole string when shorter.
- `timesWord`: `1` → `"once"`, `2` → `"twice"`, else `"%d times"`.

`head` is already `f.Commit` or `"HEAD"`.

- [ ] **Step 3: Run the verifier tests.** `go test ./pkg/orchestrate/ -count=1 -run '^(TestTheVerifierBrief.*|TestTheVerifierJudgesTheMergedResultOnceTheStepsPass|TestAFixRoundVerifierIsToldTheFixTasks)$'`. Expected: PASS.

- [ ] **Step 4: Commit.** `git add pkg/orchestrate/verifier.go pkg/orchestrate/verifier_test.go && git commit -m "fix(orchestrate): the final verifier is told which commands passed on which commit, not to re-run suites, and its time budget"`

### Task 5: Finding 49's "second route" is log noise: drop the log, pin the behavior, correct the record

**Depends on:** none

**Files:**
- Modify: `pkg/jarvis/onexit.go` (`OnWorkerExit`, the `ch == nil` branch at about line 92)
- Modify: `pkg/jarvis/outcome.go` (`resolveDispatchChannelForWorker`, about line 110)
- Modify: `pkg/jarvis/onexit_test.go`
- Modify: `docs/orchestrator-findings-2026-09-25.md` (row 49's detail row, about line 1472)

**Interfaces:** none.

Background (spec section 4): `PostOutcome` posts only for a worker with a `dispatch` message, and engine workers have none. `resolveDispatchChannelForWorker` falls back to scanning every channel for a dispatch message, so a nil channel means nothing was there to post. The "outcome not posted" line is noise; a swallowed `GetChannels` error is the one real failure behind a nil, and it gets its own log line.

- [ ] **Step 1: The tests.** Add to `onexit_test.go`, next to `TestOnWorkerExitPostsTheOutcomeWhenTheHookOutlivesTheDeadline`:

```go
// reapOnOutcome makes the outcome hook delete the worker's tab, as a merge's reap does while the hook runs.
func reapOnOutcome(t *testing.T, tabOID string) {
	t.Helper()
	oldHook := ChildOutcomeHook
	t.Cleanup(func() { ChildOutcomeHook = oldHook })
	ChildOutcomeHook = func(context.Context, string, OutcomeData) error {
		return wstore.DBDelete(context.Background(), waveobj.OType_Tab, tabOID)
	}
}

// an engine worker has no dispatch message, so it never gets a channel outcome; its reaped exit is normal, not
// a lost outcome, and must not log as one (run 6c7652be's t-2 and t-3)
func TestAReapedEngineWorkersExitPostsNothingAndLogsNothing(t *testing.T) {
	ctx := context.Background()
	tpath := filepath.Join(t.TempDir(), "session.jsonl")
	transcript := `{"type":"user","cwd":"/repo","message":{"content":"do the thing"}}` + "\n" +
		`{"type":"assistant","message":{"model":"claude-opus","content":[{"type":"text","text":"done."}]}}` + "\n"
	if err := os.WriteFile(tpath, []byte(transcript), 0o644); err != nil {
		t.Fatal(err)
	}
	tabOID, blockOID := uuid.NewString(), uuid.NewString()
	worker := waveobj.MakeORef(waveobj.OType_Tab, tabOID).String()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabOID, BlockIds: []string{blockOID}, Meta: waveobj.MetaMapType{"session:agent": "claude"}}); err != nil {
		t.Fatal(err)
	}
	if err := wstore.DBInsert(ctx, &waveobj.Block{OID: blockOID, ParentORef: worker, Meta: waveobj.MetaMapType{waveobj.MetaKey_AgentTranscriptPath: tpath}}); err != nil {
		t.Fatal(err)
	}
	ch, err := wstore.CreateChannel(ctx, "onexit-engine-worker", "/p")
	if err != nil {
		t.Fatal(err)
	}
	runORef := waveobj.MakeORef(waveobj.OType_Run, uuid.NewString()).String()
	if err := wstore.StampWorkerOwner(ctx, worker, runORef, waveobj.MakeORef(waveobj.OType_Channel, ch.OID).String()); err != nil {
		t.Fatal(err)
	}
	reapOnOutcome(t, tabOID)
	var buf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(oldOut)

	OnWorkerExit(blockOID, 0)

	if channelHasOutcome(t, ch.OID) {
		t.Fatal("an engine worker never gets a channel outcome")
	}
	if strings.Contains(buf.String(), "jarvis onexit") {
		t.Fatalf("a reaped engine worker's exit is normal and must not log: %q", buf.String())
	}
}

// a worker a channel dispatched keeps its outcome when the reap deletes its tab mid-hook
func TestADispatchedWorkersOutcomeSurvivesTheReap(t *testing.T) {
	blockOID, channelOID := seedDispatchedWorker(t)
	tabOID, err := wstore.DBFindTabForBlockId(context.Background(), blockOID)
	if err != nil {
		t.Fatal(err)
	}
	reapOnOutcome(t, tabOID)

	OnWorkerExit(blockOID, 0)

	if !channelHasOutcome(t, channelOID) {
		t.Fatal("the outcome was not posted to the dispatching channel")
	}
}
```

Check `StampWorkerOwner` (`pkg/wstore/wstore_channel.go:408`) and `DBDelete` (`pkg/wstore/wstore_dbops.go:163`) against these calls, and match their real signatures if they differ.

- [ ] **Step 2: Run them.** `go test ./pkg/jarvis/ -count=1 -run '^(TestAReapedEngineWorkersExitPostsNothingAndLogsNothing|TestADispatchedWorkersOutcomeSurvivesTheReap)$'`. Expected: the first FAILS on the "outcome not posted" log line; the second PASSES, since the fallback scan finds the dispatch message.

- [ ] **Step 3: Drop the log; surface the swallowed error.** In `OnWorkerExit` (`onexit.go`), the tail becomes:

```go
	// resolved before the hook, which can wait on a dag lock past this context's deadline
	ch := resolveDispatchChannelForWorker(ctx, workerORef)
	notifyChildOutcome(ctx, workerORef, data)
	// nil is a worker no channel dispatched, an engine worker's normal case: there is no channel outcome to post
	if ch == nil {
		return
	}
	PostOutcome(ch, workerORef, runtime, data)
```

In `resolveDispatchChannelForWorker` (`outcome.go`):

```go
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		log.Printf("jarvis: listing channels to resolve worker %s: %v", workerORef, err)
		return nil
	}
```

`outcome.go` already imports `log` (`PostOutcome` uses it).

- [ ] **Step 4: Run the onexit tests.** `go test ./pkg/jarvis/ -count=1 -run '^(TestOnWorkerExit.*|TestAReapedEngineWorkersExitPostsNothingAndLogsNothing|TestADispatchedWorkersOutcomeSurvivesTheReap)$'`. Expected: PASS.

- [ ] **Step 5: The findings doc.** Row 49's detail row (about line 1472): after the fix description, add: Run `6c7652be` logged "outcome not posted" at t-2's and t-3's merges, which read as a second route. It was not: engine workers have no dispatch message and never get a channel outcome, and those tasks had merged, so nothing was lost. The misleading log line was removed, and a failed channel listing now logs where it happens. Add `TestAReapedEngineWorkersExitPostsNothingAndLogsNothing` and `TestADispatchedWorkersOutcomeSurvivesTheReap` to its test list. Leave the summary row (about line 63) as it is.

- [ ] **Step 6: Commit.** `git add pkg/jarvis/onexit.go pkg/jarvis/outcome.go pkg/jarvis/onexit_test.go docs/orchestrator-findings-2026-09-25.md && git commit -m "fix(jarvis): a reaped engine worker's exit no longer logs a lost outcome; finding 49's record corrected"`

### Task 6: Close the rows in docs/open-issues.md

**Depends on:** Task 1, Task 2, Task 3, Task 4, Task 5

**Files:**
- Modify: `docs/open-issues.md` (rows at about lines 175, 176, 179, 181, 183)

- [ ] **Step 1: Find the commits.** `git log --oneline -12`, and pick each task's commit by its message (Tasks 1 to 5 above). Item 2 has two commits (Task 2 and Task 3); cite both.

- [ ] **Step 2: Mark each row** in the file's own style (see row 170: `~~<title>~~ **fixed \`<sha>\`**`, then the fix in a sentence at the start of the description, keeping the evidence):
  - "`pkg/orchestrate` tests flake because background engine stages outlive…": struck, **fixed `<Task 1 sha>`**. Fix (1) shipped: `goStage` and the fixtures' `restoreAfterStages`, with the leak count from the Task 1 commit body. Fix (2) was done earlier; fix (3), the worker-brief line, is the other run's.
  - "A human cannot end a stuck final stage": struck, **fixed `<Task 2 sha>`, `<Task 3 sha>`**. `wsh runs end-final <run-id> unverified|failed "<reason>"` and the run sheet's End final stage; a failed end takes the verifier-fail path.
  - "The final verifier re-runs the test suites…": struck, **fixed `<Task 4 sha>`**.
  - "Workers run whole-package test suites…": **not** struck. Add "**Verifier half fixed `<Task 4 sha>`**; the worker-brief and PlanFormat half is open (another run)" at the start of the description.
  - "Finding 49 has a second route…": struck, **fixed `<Task 5 sha>`**, noting that the premise was wrong: the lines were log noise (engine workers never get a channel outcome, and those tasks had merged), so the log line was removed and finding 49's row corrected.

- [ ] **Step 3: Commit.** `git add docs/open-issues.md && git commit -m "docs(open-issues): close the stage-leak, stuck-final-stage, verifier re-run and finding 49 rows"`
