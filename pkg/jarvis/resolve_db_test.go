// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// TestResolveRunWorkerFromMeta_UsesMetaNotScan proves the meta lookup is the source, not the scan: the
// run exists ONLY as a db_run row (never appended to the channel blob), so the GetChannels scan cannot
// find it. Resolution therefore succeeds only via the runoref/channeloref stamp. UUID ids are required
// because ParseORef validates the oid as a UUID.
func TestResolveRunWorkerFromMeta_UsesMetaNotScan(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "rw-meta", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	workerTabOID := uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: workerTabOID, Name: "w", Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker tab: %v", err)
	}
	workerTab := waveobj.MakeORef(waveobj.OType_Tab, workerTabOID).String()
	runID := uuid.NewString()
	// row-only run (DBInsert, not AppendRun) → the channel blob stays empty, so the scan can't see it.
	row := &waveobj.Run{OID: runID, ID: runID, ChannelOID: ch.OID, Goal: "g", Status: "executing", CreatedTs: 1,
		Phases: []waveobj.RunPhase{{Kind: PhaseKind_Plan}, {Kind: PhaseKind_Execute, WorkerOrefs: []string{workerTab}}}}
	if err := wstore.DBInsert(ctx, row); err != nil {
		t.Fatalf("insert run row: %v", err)
	}
	// sanity: the scan genuinely cannot resolve this worker (blob has no runs)
	if channels, _ := wstore.GetChannels(ctx); ResolveRunWorker(channels, workerTab) != nil {
		t.Fatalf("precondition failed: scan resolved a row-only run")
	}
	if err := wstore.StampWorkerOwner(ctx, workerTab,
		waveobj.MakeORef(waveobj.OType_Run, runID).String(),
		waveobj.MakeORef(waveobj.OType_Channel, ch.OID).String()); err != nil {
		t.Fatalf("stamp: %v", err)
	}
	m := ResolveRunWorkerFromMeta(ctx, workerTab)
	if m == nil || m.Channel.OID != ch.OID || m.Run.ID != runID || m.PhaseIdx != 1 {
		t.Fatalf("meta resolve wrong (should have found via meta, scan returns nil): %+v", m)
	}
}

// TestResolveRunWorkerFromMeta_FallsBackToScan proves an unstamped worker still resolves via the
// GetChannels scan fallback, so a missing best-effort stamp never regresses resolution.
func TestResolveRunWorkerFromMeta_FallsBackToScan(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "rw-fallback", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	unstamped := waveobj.MakeORef(waveobj.OType_Tab, uuid.NewString()).String()
	runID := uuid.NewString()
	run := waveobj.Run{ID: runID, Goal: "g2", Status: "executing", CreatedTs: 2,
		Phases: []waveobj.RunPhase{{Kind: PhaseKind_Execute, WorkerOrefs: []string{unstamped}}}}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("append run: %v", err)
	}
	m := ResolveRunWorkerFromMeta(ctx, unstamped) // no stamp -> fallback scan
	if m == nil || m.Run.ID != runID || m.PhaseIdx != 0 || m.Channel.OID != ch.OID {
		t.Fatalf("fallback resolve wrong: %+v", m)
	}
}

// seedWorkerTab inserts a worker tab so StampWorkerOwner (and the B3 dispatch-stamp) can land its meta.
func seedWorkerTab(t *testing.T, ctx context.Context) string {
	t.Helper()
	oid := uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: oid, Name: "w", Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker tab: %v", err)
	}
	return waveobj.MakeORef(waveobj.OType_Tab, oid).String()
}

// A concierge worker dispatched by a gatekeeper-enabled channel resolves to that channel + its task.
func TestResolveAskOwner_Concierge(t *testing.T) {
	ctx := context.Background()
	gk, err := wstore.CreateChannel(ctx, "gk", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Channel, gk.OID),
		waveobj.MetaMapType{MetaKey_GatekeeperEnabled: true}, false); err != nil {
		t.Fatalf("enable gatekeeper: %v", err)
	}
	worker := seedWorkerTab(t, ctx)
	dm := wstore.NewChannelMessage("dispatch", "claude", "concierge task", worker, 10)
	if _, err := wstore.PostChannelMessage(ctx, gk.OID, dm); err != nil { // also stamps channeloref (Task B3)
		t.Fatalf("post dispatch: %v", err)
	}
	ch, task := resolveAskOwner(ctx, worker)
	if ch == nil || ch.OID != gk.OID || task != "concierge task" {
		t.Fatalf("concierge resolve wrong: ch=%+v task=%q", ch, task)
	}
}

// A run worker (stamped run+channel) resolves via the run path FIRST — runoref precedence (Design Note 2).
func TestResolveAskOwner_RunWorker(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "run-ch", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	worker := seedWorkerTab(t, ctx)
	runID := uuid.NewString()
	run := waveobj.Run{ID: runID, Goal: "ship it", Status: "executing", CreatedTs: 1,
		Phases: []waveobj.RunPhase{{Kind: PhaseKind_Execute, Skill: "superpowers:writing-plans", WorkerOrefs: []string{worker}}}}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("append run: %v", err)
	}
	if err := wstore.StampWorkerOwner(ctx, worker,
		waveobj.MakeORef(waveobj.OType_Run, runID).String(),
		waveobj.MakeORef(waveobj.OType_Channel, ch.OID).String()); err != nil {
		t.Fatalf("stamp: %v", err)
	}
	gotCh, task := resolveAskOwner(ctx, worker)
	if gotCh == nil || gotCh.OID != ch.OID {
		t.Fatalf("run worker resolve wrong channel: %+v", gotCh)
	}
	if !contains(task, "ship it") {
		t.Fatalf("run worker task should mention the run goal, got %q", task)
	}
}

// A concierge worker dispatched by a NON-gatekeeper channel is not owned by the gatekeeper (nil), matching
// the old ResolveGatekeeperChannel skip of non-enabled channels.
func TestResolveAskOwner_NonGatekeeper(t *testing.T) {
	ctx := context.Background()
	plain, err := wstore.CreateChannel(ctx, "plain", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	worker := seedWorkerTab(t, ctx)
	dm := wstore.NewChannelMessage("dispatch", "claude", "task", worker, 10)
	if _, err := wstore.PostChannelMessage(ctx, plain.OID, dm); err != nil {
		t.Fatalf("post dispatch: %v", err)
	}
	if ch, _ := resolveAskOwner(ctx, worker); ch != nil {
		t.Fatalf("non-gatekeeper channel must not own the ask, got %+v", ch)
	}
}

func countOutcomes(ch *waveobj.Channel, workerORef string) int {
	n := 0
	for _, m := range ch.Messages {
		if m.Kind == "outcome" && m.RefORef == workerORef {
			n++
		}
	}
	return n
}

// PostOutcome must keep the dispatch-existence gate after the single-channel migration (Design Note 3): a
// worker WITH a dispatch message earns an outcome; a worker with NO dispatch message (e.g. a run worker
// that now carries channeloref) does not — even though the channel resolves.
func TestPostOutcomeOnlyForDispatchedWorker(t *testing.T) {
	ctx := context.Background()
	// dispatched worker -> gets an outcome
	ch, err := wstore.CreateChannel(ctx, "oc-dispatched", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	worker := seedWorkerTab(t, ctx)
	if _, err := wstore.PostChannelMessage(ctx, ch.OID, wstore.NewChannelMessage("dispatch", "claude", "task", worker, 10)); err != nil {
		t.Fatalf("post dispatch: %v", err)
	}
	full, _ := wstore.DBMustGet[*waveobj.Channel](ctx, ch.OID)
	PostOutcome(full, worker, "claude", OutcomeData{Status: "done", Summary: "s"})
	after, _ := wstore.DBMustGet[*waveobj.Channel](ctx, ch.OID)
	if got := countOutcomes(after, worker); got != 1 {
		t.Fatalf("dispatched worker should get exactly 1 outcome, got %d", got)
	}

	// non-dispatched worker (channel resolves, but no dispatch message) -> no outcome
	ch2, err := wstore.CreateChannel(ctx, "oc-undispatched", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	worker2 := seedWorkerTab(t, ctx)
	full2, _ := wstore.DBMustGet[*waveobj.Channel](ctx, ch2.OID)
	PostOutcome(full2, worker2, "claude", OutcomeData{Status: "done", Summary: "s"})
	after2, _ := wstore.DBMustGet[*waveobj.Channel](ctx, ch2.OID)
	if got := countOutcomes(after2, worker2); got != 0 {
		t.Fatalf("undispatched worker must get no outcome, got %d", got)
	}
}
