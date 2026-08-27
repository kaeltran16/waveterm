// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"reflect"
	"strconv"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/runroute"
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
	jarvis.SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, _ string, _ jarvis.RunWorkerOptions) (string, error) {
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
	jarvis.SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, _ string, _ jarvis.RunWorkerOptions) (string, error) {
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

func TestResolveRunPlanOrchestratorIsAlwaysUngated(t *testing.T) {
	enabled := true
	disabled := false
	cases := []struct {
		name    string
		profile waveobj.JarvisProfile
		request *bool
	}{
		{name: "request enabled", request: &enabled},
		{name: "profile enabled", profile: waveobj.JarvisProfile{DefaultPlanGate: &enabled}},
		{name: "request disabled", request: &disabled},
		{name: "unset"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mode, phases := resolveRunPlan(tc.profile, jarvis.RunMode_Orchestrator, tc.request)
			if mode != jarvis.RunMode_Orchestrator || len(phases) != 1 || phases[0].Gate {
				t.Fatalf("mode=%q phases=%+v", mode, phases)
			}
		})
	}
}

// stubRunServer replaces the process boundaries (harness validation + worker spawn) so run handlers
// are deterministic without launching CLIs or tabs. Restores prior values on cleanup.
func stubRunServer(t *testing.T, validRuntime string, spawnErr error, captured ...*runroute.Capability) {
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
	jarvis.SpawnRunWorker = func(_ context.Context, cap runroute.Capability, _, _, _, _ string, _ jarvis.RunWorkerOptions) (string, error) {
		if len(captured) > 0 && captured[0] != nil {
			*captured[0] = cap
		}
		if cap.Runtime != validRuntime {
			return "", context.Canceled
		}
		if spawnErr != nil {
			return "", spawnErr
		}
		return waveobj.MakeORef(waveobj.OType_Tab, "w-"+cap.Runtime).String(), nil
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

func TestCreateRunCommand_RejectsInvalidOrUnavailableRouteBeforePersistence(t *testing.T) {
	cases := []struct {
		name, runtime, tier string
		available           bool
	}{
		{name: "missing tier", runtime: "claude"},
		{name: "unsupported pair", runtime: "codex", tier: "cheap"},
		{name: "unavailable harness", runtime: "claude", tier: "capable", available: false},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			ch, err := wstore.CreateChannel(ctx, "reject-route-"+tt.name, "/repo")
			if err != nil {
				t.Fatalf("CreateChannel: %v", err)
			}
			oldValidate := validateHarness
			validateHarness = func(string, harness.Operation) (harness.Spec, error) {
				if !tt.available {
					return harness.Spec{}, context.Canceled
				}
				t.Fatal("validateHarness called for a route rejected by runroute")
				return harness.Spec{}, nil
			}
			t.Cleanup(func() { validateHarness = oldValidate })
			var spawnCalls int
			oldSpawn := jarvis.SpawnRunWorker
			jarvis.SpawnRunWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
				spawnCalls++
				return "tab:unexpected", nil
			}
			t.Cleanup(func() { jarvis.SpawnRunWorker = oldSpawn })

			_, err = (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
				ChannelId: ch.OID, WorkspaceId: "ws-1", Goal: "do it", Runtime: tt.runtime, Tier: tt.tier,
			})
			if err == nil {
				t.Fatal("CreateRun must reject the route")
			}
			if runs, _ := wstore.GetChannelRuns(ctx, ch.OID); len(runs) != 0 {
				t.Fatalf("rejected route persisted %d runs", len(runs))
			}
			if spawnCalls != 0 {
				t.Fatalf("rejected route spawned %d workers", spawnCalls)
			}
		})
	}
}

// New Run creation persists the explicit runtime on the Run before the worker is spawned.
func TestCreateRunCommand_PersistsExplicitRuntime(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "create-open", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	var spawnedCap runroute.Capability
	stubRunServer(t, "opencode", nil, &spawnedCap)

	ws := &WshServer{}
	rtn, err := ws.CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws-1", Goal: "do it", Runtime: "opencode", Tier: "capable",
	})
	if err != nil {
		t.Fatalf("CreateRunCommand: %v", err)
	}
	if rtn.Run.Runtime != "opencode" || rtn.Run.Tier != "capable" {
		t.Fatalf("persisted route = %s/%s, want opencode/capable", rtn.Run.Runtime, rtn.Run.Tier)
	}
	if spawnedCap.Runtime != "opencode" || spawnedCap.Tier != "capable" || spawnedCap.ResolvedModel != "operator default" || len(spawnedCap.ModelArgs) != 0 {
		t.Fatalf("spawned capability = %+v, want opencode/capable operator default", spawnedCap)
	}
	if got := mustSeq(t, ch.OID, rtn.Run.ID); !reflect.DeepEqual(got, []string{
		waveobj.RunEventKindCreated, waveobj.RunEventKindPhaseStarted + "@0",
	}) {
		t.Fatalf("non-deferred lifecycle events = %v, want created then phase-started@0", got)
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
	run.Runtime = "claude"
	run.Tier = "cheap"
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}

	var spawnedWith runroute.Capability
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
	jarvis.SpawnRunWorker = func(_ context.Context, cap runroute.Capability, _, _, _, _ string, _ jarvis.RunWorkerOptions) (string, error) {
		spawnedWith = cap
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
	if spawnedWith.Runtime != "claude" || spawnedWith.Tier != "cheap" || !reflect.DeepEqual(spawnedWith.ModelArgs, []string{"--model", consult.CheapModel}) {
		t.Fatalf("next worker spawned with capability %+v, want claude/cheap with haiku model args", spawnedWith)
	}
}

func TestAdvanceRun_LegacyRouteNormalizesOnlyForSpawn(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "advance-legacy-route", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	run := jarvis.NewRun("do it", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Pipeline, jarvis.DefaultPlaybook(), 1)
	run.Runtime = "claude"
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("AppendRun: %v", err)
	}
	var spawnedWith runroute.Capability
	oldValidate := validateHarness
	validateHarness = func(runtime string, op harness.Operation) (harness.Spec, error) {
		if runtime != "claude" || op != harness.OperationRunWorker {
			t.Fatalf("validateHarness(%q, %q)", runtime, op)
		}
		return harness.Spec{}, nil
	}
	t.Cleanup(func() { validateHarness = oldValidate })
	oldSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(_ context.Context, cap runroute.Capability, _, _, _, _ string, _ jarvis.RunWorkerOptions) (string, error) {
		spawnedWith = cap
		return waveobj.MakeORef(waveobj.OType_Tab, "legacy-worker").String(), nil
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
	if spawnedWith.Runtime != "claude" || spawnedWith.Tier != "capable" || len(spawnedWith.ModelArgs) != 0 {
		t.Fatalf("legacy worker capability = %+v, want claude/capable operator default", spawnedWith)
	}
	persisted, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if persisted.Runtime != "claude" || persisted.Tier != "" {
		t.Fatalf("legacy run was rewritten while spawning: %s/%s", persisted.Runtime, persisted.Tier)
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
	jarvis.SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, _ string, _ jarvis.RunWorkerOptions) (string, error) {
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
	jarvis.SpawnRunWorker = func(_ context.Context, _ runroute.Capability, _, _, _, _ string, _ jarvis.RunWorkerOptions) (string, error) {
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
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "test", Runtime: "pi", Tier: "capable",
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
	if got := mustSeq(t, ch.OID, rtn.Run.ID); !reflect.DeepEqual(got, []string{
		waveobj.RunEventKindCreated,
	}) {
		t.Fatalf("deferred lifecycle events = %v, want only run-created", got)
	}
}

func TestCancelOwningRunCascadesThroughDag(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "cancel-owner-dag", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	child := jarvis.NewRun("child", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.QuickPlaybook(), 1)
	dag, err := orchestrate.NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{ID: "t", Label: "task"}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	owner.DagORef = dag.OID
	child.DagORef = dag.OID
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatal(err)
	}
	dag.Tasks[0].State = orchestrate.TaskState_Running
	dag.Tasks[0].RunID = child.ID
	if err := wstore.AppendDag(ctx, &dag); err != nil {
		t.Fatal(err)
	}

	if err := (&WshServer{}).CancelRunCommand(ctx, wshrpc.CommandCancelRunData{ChannelId: ch.OID, RunId: owner.ID}); err != nil {
		t.Fatal(err)
	}
	gotOwner, _ := wstore.GetRun(ctx, ch.OID, owner.ID)
	gotChild, _ := wstore.GetRun(ctx, ch.OID, child.ID)
	gotDag, _ := wstore.GetDag(ctx, dag.OID)
	if gotOwner.Status != jarvis.RunStatus_Cancelled || gotChild.Status != jarvis.RunStatus_Cancelled || gotDag.Status != orchestrate.DagStatus_Cancelled {
		t.Fatalf("owner cancellation did not cascade: owner=%q child=%q dag=%q", gotOwner.Status, gotChild.Status, gotDag.Status)
	}
}

func TestCancelRunDoesNotBypassMissingLinkedDag(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "cancel-missing-dag", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	run.DagORef = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatal(err)
	}

	if err := (&WshServer{}).CancelRunCommand(ctx, wshrpc.CommandCancelRunData{ChannelId: ch.OID, RunId: run.ID}); err == nil {
		t.Fatal("want linked DAG load failure")
	}
	got, err := wstore.GetRun(ctx, ch.OID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status == jarvis.RunStatus_Cancelled {
		t.Fatal("owner was partially cancelled despite unresolved DAG")
	}
}

func TestCreateRunCommand_PersistsModelRoute(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "create-model", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	var spawnedCap runroute.Capability
	stubRunServer(t, "claude", nil, &spawnedCap)

	ws := &WshServer{}
	rtn, err := ws.CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws-1", Goal: "do it", Runtime: "claude", Model: "sonnet",
	})
	if err != nil {
		t.Fatalf("CreateRunCommand: %v", err)
	}
	if rtn.Run.Model != "sonnet" || rtn.Run.Runtime != "claude" {
		t.Fatalf("persisted route = %s model=%q, want claude/sonnet", rtn.Run.Runtime, rtn.Run.Model)
	}
	if spawnedCap.Model != "sonnet" || !reflect.DeepEqual(spawnedCap.ModelArgs, []string{"--model", "sonnet"}) {
		t.Fatalf("spawned capability = %+v, want claude sonnet --model args", spawnedCap)
	}
}

func TestCreateRunCommand_RejectsCrossNamespaceModelBeforePersistence(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "create-badmodel", "/repo")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	oldValidate := validateHarness
	validateHarness = func(string, harness.Operation) (harness.Spec, error) {
		t.Fatal("validateHarness called for a route rejected by runroute")
		return harness.Spec{}, nil
	}
	t.Cleanup(func() { validateHarness = oldValidate })
	var spawnCalls int
	oldSpawn := jarvis.SpawnRunWorker
	jarvis.SpawnRunWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		spawnCalls++
		return "tab:unexpected", nil
	}
	t.Cleanup(func() { jarvis.SpawnRunWorker = oldSpawn })

	_, err = (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws-1", Goal: "do it", Runtime: "claude", Model: "gpt-5.4",
	})
	if err == nil {
		t.Fatal("cross-namespace model must be rejected")
	}
	if runs, _ := wstore.GetChannelRuns(ctx, ch.OID); len(runs) != 0 {
		t.Fatalf("rejected route persisted %d runs", len(runs))
	}
	if spawnCalls != 0 {
		t.Fatalf("rejected route spawned %d workers", spawnCalls)
	}
}
