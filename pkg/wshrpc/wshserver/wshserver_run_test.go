// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strconv"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func bptr(b bool) *bool { return &b }

// captureClient records every event the broker sends, for asserting waveobj broadcasts in tests.
type captureClient struct {
	mu     sync.Mutex
	events []wps.WaveEvent
}

func (c *captureClient) SendEvent(_ string, event wps.WaveEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, event)
}

func (c *captureClient) sawScope(scope string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.events {
		for _, s := range e.Scopes {
			if s == scope {
				return true
			}
		}
	}
	return false
}

// A completing run must broadcast a run: waveobj update, not just channel:. The focused-run view subscribes
// to the per-run run:<id> object (channel-scaling Phase 2); a channel-only bump left it frozen at its
// last-focused state ("executing") with no completion card. Regression guard for that publish.
func TestCompleteBroadcastsRunUpdate(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "bcast-run", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("finish it", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	cc := &captureClient{}
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(cc)
	defer wps.Broker.SetClient(prevClient)
	routeId := "test-capture-route"
	wps.Broker.Subscribe(routeId, wps.SubscriptionRequest{Event: wps.Event_WaveObjUpdate, AllScopes: true})
	defer wps.Broker.Unsubscribe(routeId, wps.Event_WaveObjUpdate)

	origAsync := sealAsync
	sealAsync = func(func()) {} // drop the deferred seal; we only assert the transition broadcast
	defer func() { sealAsync = origAsync }()

	if err := (&WshServer{}).AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: ch.OID, RunId: run.ID, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}

	runScope := waveobj.MakeORef(waveobj.OType_Run, run.ID).String()
	if !cc.sawScope(runScope) {
		t.Fatalf("completion did not broadcast %s; focused run would stay stale", runScope)
	}
}

// A run reaching done must persist the phase transition synchronously (the ack `wsh jarvis complete`
// waits on) while the slow evidence seal (a git diff) is dispatched off the RPC budget. Sealing inline
// blocked the handler past the 5s client budget, surfacing as EC-TIME even though the completion had
// already registered. We prove the decoupling deterministically via the sealAsync seam: capture the seal
// instead of running it, then confirm the run is already done with evidence still unsealed.
func TestCompleteDefersEvidenceSeal(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "defer-seal", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("finish it", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	var captured func()
	origAsync := sealAsync
	sealAsync = func(fn func()) { captured = fn }
	defer func() { sealAsync = origAsync }()

	// a done quick run spawns no next worker; guard against a real subprocess if that assumption breaks
	origSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, _, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnRunWorker = origSpawn }()

	ws := &WshServer{}
	if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: ch.OID, RunId: run.ID, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}

	done, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if done.Status != jarvis.RunStatus_Done {
		t.Fatalf("run status = %q, want done (the transition must persist synchronously)", done.Status)
	}
	if done.Evidence != nil {
		t.Fatal("evidence sealed inline; the slow seal must be deferred off the RPC budget")
	}
	if captured == nil {
		t.Fatal("seal was not dispatched to sealAsync")
	}

	captured() // running the deferred seal then persists the snapshot (idempotent; backfilled otherwise)
	sealed, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if sealed.Evidence == nil {
		t.Fatal("deferred seal did not persist evidence")
	}
}

// A run entering a rest state must dispatch the continuity boundary summary off the RPC budget (it is a
// model call). We prove the decoupling via the captureAsync seam: capture the dispatched func instead of
// running it, and confirm a ->done transition dispatched exactly one capture.
func TestAdvanceRunDispatchesContinuityCapture(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "continuity-dispatch", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("finish it", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	var capturedContinuity func()
	origCap := captureAsync
	captureAsync = func(fn func()) { capturedContinuity = fn }
	defer func() { captureAsync = origCap }()

	// keep the evidence seal off a real goroutine / git diff for this test
	origSeal := sealAsync
	sealAsync = func(fn func()) {}
	defer func() { sealAsync = origSeal }()

	origSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, _, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnRunWorker = origSpawn }()

	ws := &WshServer{}
	if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: ch.OID, RunId: run.ID, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}

	if capturedContinuity == nil {
		t.Fatal("continuity capture was not dispatched on the ->done rest transition")
	}
}

func TestApplyRunActionTriage(t *testing.T) {
	r := jarvis.NewRun("do X", "ws", "/p", nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	next, err := applyRunAction(r, wshrpc.CommandAdvanceRunData{Action: jarvis.RunAction_Triage, PhaseIdx: 0, Verdict: "quick", Note: "tiny fix"}, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if next.Phases[0].Triage == nil || next.Phases[0].Triage.Verdict != "quick" || next.Phases[0].Triage.Note != "tiny fix" {
		t.Errorf("triage not recorded: %+v", next.Phases[0].Triage)
	}
	if next.Status != jarvis.RunStatus_Executing {
		t.Errorf("triage must leave the run executing, got %q", next.Status)
	}
}

func TestApplyRunActionCompleteStoresEndCommit(t *testing.T) {
	r := jarvis.NewRun("do X", "ws", "/p", nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	// complete with a reported commit -> stored on the run as EndCommit (scopes the sealed evidence diff)
	next, err := applyRunAction(r, wshrpc.CommandAdvanceRunData{Action: jarvis.RunAction_Complete, PhaseIdx: 0, Commit: "abc123"}, 2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if next.EndCommit != "abc123" {
		t.Errorf("EndCommit = %q, want abc123", next.EndCommit)
	}
	// a non-complete action must never set EndCommit even if a commit is (spuriously) supplied
	r2 := jarvis.NewRun("do Y", "ws", "/p", nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	next2, err := applyRunAction(r2, wshrpc.CommandAdvanceRunData{Action: jarvis.RunAction_Triage, PhaseIdx: 0, Verdict: "quick", Commit: "deadbeef"}, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if next2.EndCommit != "" {
		t.Errorf("triage must not set EndCommit, got %q", next2.EndCommit)
	}
}

func TestApplyRunActionUnknown(t *testing.T) {
	r := jarvis.NewRun("g", "ws", "/p", nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if _, err := applyRunAction(r, wshrpc.CommandAdvanceRunData{Action: "bogus"}, 0); err == nil {
		t.Error("expected error for unknown action")
	}
}

func TestResolveRunPlan(t *testing.T) {
	pipe := jarvis.DefaultPlaybook()
	resolved := waveobj.JarvisProfile{Playbook: pipe, DefaultMode: jarvis.RunMode_Pipeline}

	// explicit orchestrator + gate on -> single gated orchestrate phase
	mode, pb := resolveRunPlan(resolved, jarvis.RunMode_Orchestrator, bptr(true))
	if mode != jarvis.RunMode_Orchestrator || len(pb) != 1 || pb[0].Kind != jarvis.PhaseKind_Orchestrate || !pb[0].Gate {
		t.Fatalf("orchestrator: mode=%q pb=%+v", mode, pb)
	}

	// empty request falls to the profile default (pipeline) with the profile playbook
	mode, pb = resolveRunPlan(resolved, "", nil)
	if mode != jarvis.RunMode_Pipeline || len(pb) != len(pipe) {
		t.Fatalf("default: mode=%q len=%d", mode, len(pb))
	}

	// orchestrator with no explicit gate + no profile default -> gate ON (safe default)
	_, pb = resolveRunPlan(waveobj.JarvisProfile{DefaultMode: jarvis.RunMode_Orchestrator}, "", nil)
	if len(pb) != 1 || !pb[0].Gate {
		t.Fatalf("gate default should be on: %+v", pb)
	}
}

// stubRunServer replaces the process boundaries (harness validation + worker spawn) so run handlers
// are deterministic without launching CLIs or tabs. Restores prior values on cleanup.
func stubRunServer(t *testing.T, validRuntime string, spawnErr error) {
	t.Helper()
	oldValidate := validateHarness
	validateHarness = func(runtime string, op harness.Operation) (harness.Spec, error) {
		if op != harness.OperationRunWorker {
			t.Fatalf("CreateRun validated with operation %q, want run-worker", op)
		}
		spec, ok := harness.Lookup(runtime)
		if !ok || runtime != validRuntime {
			return harness.ValidateInstalled(runtime, op)
		}
		return spec, nil
	}
	t.Cleanup(func() { validateHarness = oldValidate })

	oldSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, runtime, _, _, _, _ string) (string, error) {
		if runtime != validRuntime {
			return "", context.Canceled
		}
		if spawnErr != nil {
			return "", spawnErr
		}
		return waveobj.MakeORef(waveobj.OType_Tab, "w-"+runtime).String(), nil
	}
	t.Cleanup(func() { jarvis.SpawnRunWorker = oldSpawn })

	oldSeal := sealAsync
	sealAsync = func(func()) {}
	t.Cleanup(func() { sealAsync = oldSeal })
}

// New Run creation requires an explicit, validated runtime: an empty runtime is rejected before the
// run is appended or a worker spawned.
func TestCreateRunCommand_EmptyRuntimeRejected(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "create-empty-rt", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	stubRunServer(t, "opencode", nil)

	ws := &WshServer{}
	_, err = ws.CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws-1", Goal: "do it", Runtime: "",
	})
	if err == nil {
		t.Fatal("CreateRun must reject an empty runtime")
	}
	existing, _ := wstore.GetChannelRuns(ctx, ch.OID)
	if len(existing) != 0 {
		t.Fatalf("no run should be persisted on rejection, got %d", len(existing))
	}
}

// New Run creation persists the explicit runtime on the Run before the worker is spawned.
func TestCreateRunCommand_PersistsExplicitRuntime(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "create-open", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	stubRunServer(t, "opencode", nil)

	ws := &WshServer{}
	rtn, err := ws.CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws-1", Goal: "do it", Runtime: "opencode",
	})
	if err != nil {
		t.Fatalf("CreateRunCommand: %v", err)
	}
	if rtn.Run.Runtime != "opencode" {
		t.Fatalf("persisted run runtime = %q, want opencode", rtn.Run.Runtime)
	}
}

// An unknown runtime is rejected before any run is persisted.
func TestCreateRunCommand_UnknownRuntimeRejected(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "create-unknown-rt", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	oldValidate := validateHarness
	validateHarness = func(runtime string, op harness.Operation) (harness.Spec, error) {
		return harness.ValidateInstalled(runtime, op)
	}
	t.Cleanup(func() { validateHarness = oldValidate })

	_, err = (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws-1", Goal: "do it", Runtime: "mystery",
	})
	if err == nil {
		t.Fatal("CreateRun must reject an unknown runtime")
	}
	existing, _ := wstore.GetChannelRuns(ctx, ch.OID)
	if len(existing) != 0 {
		t.Fatalf("no run should be persisted on rejection, got %d", len(existing))
	}
}

// AdvanceRun must spawn the next phase with the run's persisted runtime, never a request-side value.
func TestAdvanceRun_SpawnsPersistedRuntime(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "advance-rt", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("do it", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Pipeline, jarvis.DefaultPlaybook(), 1)
	run.Runtime = "opencode"
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	var spawnedWith string
	oldValidate := validateHarness
	validateHarness = func(runtime string, op harness.Operation) (harness.Spec, error) {
		spec, ok := harness.Lookup(runtime)
		if !ok {
			return harness.ValidateInstalled(runtime, op)
		}
		return spec, nil
	}
	t.Cleanup(func() { validateHarness = oldValidate })
	oldSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, runtime, _, _, _, _ string) (string, error) {
		spawnedWith = runtime
		return waveobj.MakeORef(waveobj.OType_Tab, "w").String(), nil
	}
	t.Cleanup(func() { jarvis.SpawnRunWorker = oldSpawn })
	oldSeal := sealAsync
	sealAsync = func(func()) {}
	t.Cleanup(func() { sealAsync = oldSeal })

	if err := (&WshServer{}).AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: ch.OID, RunId: run.ID, PhaseIdx: 0, Action: jarvis.RunAction_Complete,
	}); err != nil {
		t.Fatalf("AdvanceRunCommand: %v", err)
	}
	if spawnedWith != "opencode" {
		t.Fatalf("next worker spawned with runtime %q, want persisted opencode", spawnedWith)
	}
}

// mustKinds collects a run's event kinds newest-first for a presence assertion.
func mustKinds(t *testing.T, channelId, runID string) []string {
	t.Helper()
	events, err := wstore.QueryRunEvents(context.Background(), channelId, runID, 50)
	if err != nil {
		t.Fatalf("QueryRunEvents: %v", err)
	}
	kinds := make([]string, 0, len(events))
	for _, e := range events {
		kinds = append(kinds, e.Kind)
	}
	return kinds
}

func containsKind(kinds []string, kind string) bool {
	for _, k := range kinds {
		if k == kind {
			return true
		}
	}
	return false
}

func mustSeq(t *testing.T, channelId, runID string) []string {
	t.Helper()
	events, err := wstore.QueryRunEvents(context.Background(), channelId, runID, 50)
	if err != nil {
		t.Fatalf("QueryRunEvents: %v", err)
	}
	// QueryRunEvents returns newest-first; the log is append-ordered, so reverse to read it forward.
	out := make([]string, 0, len(events))
	for i := len(events) - 1; i >= 0; i-- {
		e := events[i]
		idx := ""
		if e.PhaseIdx != nil {
			idx = "@" + strconv.Itoa(*e.PhaseIdx)
		}
		out = append(out, e.Kind+idx)
	}
	return out
}

// A pipeline run driven end-to-end through the real AdvanceRunCommand must leave a lifecycle log whose
// ORDER narrates the run the way the focused card renders it: every phase started, completing the gate
// halts the run in review, approving releases the next phase, and the cancel lands last. approve passes
// NO caller phase index (the FE's approve path never does) — the write must land at the engine-resolved
// gate, which this exact-order assert pins.
func TestRunLifecycleEventsAppended(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "events-run", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("finish it", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Pipeline, jarvis.DefaultPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	// the RPC create path writes phase-started(0); the direct handler test seeds it the same way
	phase0 := 0
	if _, err := wstore.AppendRunEvent(ctx, ch.OID, run.ID, waveobj.RunEventKindPhaseStarted, &phase0, map[string]any{}); err != nil {
		t.Fatalf("append phase-started: %v", err)
	}
	ws := &WshServer{}
	// AdvanceRunCommand spawns workers for newly-running phases at its tail; stub the spawn seam like
	// TestCompleteDefersEvidenceSeal does so the test never touches real tabs/PTYs
	origSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, _, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnRunWorker = origSpawn }()
	advance := func(idx int, action string) {
		t.Helper()
		if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{ChannelId: ch.OID, RunId: run.ID, PhaseIdx: idx, Action: action}); err != nil {
			t.Fatalf("AdvanceRunCommand(%s): %v", action, err)
		}
	}
	// DefaultPlaybook: brainstorm(0) -> plan(1, gate) -> execute(2). Completing the gate halts the run
	// in review; approving releases execute.
	advance(0, jarvis.RunAction_Complete) // phase-complete(0); plan auto-runs -> phase-started(1)
	advance(1, jarvis.RunAction_Complete) // phase-complete(1); gate completes -> run awaiting-review also writes phase-held(1)
	advance(0, jarvis.RunAction_Approve)  // the caller passes no usable index (absent ints decode 0) — approve resolves the gate itself -> gate-approved(1) + phase-started(2)
	// cancel the running execute phase so the terminal row lands without the done-transition seal
	if err := ws.CancelRunCommand(ctx, wshrpc.CommandCancelRunData{ChannelId: ch.OID, RunId: run.ID}); err != nil {
		t.Fatalf("CancelRunCommand: %v", err)
	}
	want := []string{
		"phase-started@0", "phase-complete@0", "phase-started@1",
		"phase-complete@1", "phase-held@1",
		"gate-approved@1", "phase-started@2",
		"run-cancelled",
	}
	got := mustSeq(t, ch.OID, run.ID)
	if len(got) != len(want) {
		t.Fatalf("events %v:\n want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("event[%d] = %q, want %q (events %v)", i, got[i], want[i], got)
		}
	}
}

// The remaining transition classes (sendback re-opening a completed gate, an explicit hold, an approve
// that resumes a held phase in place, triage) must each leave their kind on the log.
func TestRunLifecycleEventClassesPresent(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "events-run", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("finish it", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Pipeline, jarvis.DefaultPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	phase0 := 0
	if _, err := wstore.AppendRunEvent(ctx, ch.OID, run.ID, waveobj.RunEventKindPhaseStarted, &phase0, map[string]any{}); err != nil {
		t.Fatalf("append phase-started: %v", err)
	}
	ws := &WshServer{}
	origSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, _, _, _, _, _ string) (string, error) {
		return waveobj.MakeORef(waveobj.OType_Tab, "x").String(), nil
	}
	defer func() { jarvis.SpawnRunWorker = origSpawn }()
	advance := func(idx int, action string) {
		t.Helper()
		if err := ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{ChannelId: ch.OID, RunId: run.ID, PhaseIdx: idx, Action: action}); err != nil {
			t.Fatalf("AdvanceRunCommand(%s): %v", action, err)
		}
	}
	// DefaultPlaybook: brainstorm(0) -> plan(1, gate) -> execute(2). A gated phase halts awaiting
	// review when completed; sending back re-opens it; approving a HELD phase resumes it in place.
	advance(0, jarvis.RunAction_Complete) // plan auto-runs
	advance(1, jarvis.RunAction_Complete) // gate done -> awaiting-review
	advance(1, jarvis.RunAction_SendBack) // gate-sent-back(1); plan re-opens
	advance(1, jarvis.RunAction_Hold)     // phase-held(1); awaiting-review
	advance(1, jarvis.RunAction_Approve)  // gate-approved(1); plan resumes (held cleared)
	advance(1, jarvis.RunAction_Complete) // phase-complete(1); awaiting-review again
	advance(0, jarvis.RunAction_Approve)  // gate-approved(1); execute(2) runs
	advance(2, jarvis.RunAction_Triage)   // triage on the running execute phase
	advance(2, jarvis.RunAction_Complete) // run done

	kinds := mustKinds(t, ch.OID, run.ID)
	for _, want := range []string{
		waveobj.RunEventKindPhaseStarted, waveobj.RunEventKindPhaseComplete,
		waveobj.RunEventKindPhaseHeld, waveobj.RunEventKindGateSentBack,
		waveobj.RunEventKindGateApproved, waveobj.RunEventKindTriage,
	} {
		if !containsKind(kinds, want) {
			t.Fatalf("events %v missing %q", kinds, want)
		}
	}
}

// Cancelling a run must record the terminal event on its log (written after the cancelled state is
// persisted, so the row is durable).
func TestRunCancelWritesRunCancelledEvent(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "cancel-events", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("cancel me", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	if err := (&WshServer{}).CancelRunCommand(ctx, wshrpc.CommandCancelRunData{ChannelId: ch.OID, RunId: run.ID}); err != nil {
		t.Fatalf("CancelRunCommand: %v", err)
	}
	if !containsKind(mustKinds(t, ch.OID, run.ID), waveobj.RunEventKindRunCancelled) {
		t.Fatalf("expected run-cancelled event")
	}
}

func TestCreateRunDeferStart(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "create-deferred", t.TempDir())
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	stubRunServer(t, "pi", nil)

	rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "test", Runtime: "pi",
		Mode: jarvis.RunMode_Orchestrator, DeferStart: true,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if rtn.Run.Status != "planning" {
		t.Fatalf("want planning, got %s", rtn.Run.Status)
	}
	if len(rtn.Run.Phases[0].WorkerOrefs) != 0 {
		t.Fatalf("deferred run must not spawn workers")
	}
}
