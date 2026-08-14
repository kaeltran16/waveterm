package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func cleanupEffort(t *testing.T, oid string) {
	t.Helper()
	t.Cleanup(func() {
		if err := wstore.DBDelete(context.Background(), waveobj.OType_Effort, oid); err != nil {
			t.Errorf("cleanup effort: %v", err)
		}
	})
}

func TestEffortCreateAndMutateRoundTrip(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	rtn, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{
		Title: "Scenario gate clearance", Ticket: "SIEM-1662",
		Chunks: []wshrpc.CommandEffortChunkSeed{{Label: "Phase 1"}, {Label: "Phase 2", Owner: "soc"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, rtn.EffortOID)

	got, err := ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: rtn.EffortOID,
		Ops: []wshrpc.EffortOp{
			{Op: "setChunkStatus", Chunk: "Phase 1", Status: "done"},
			{Op: "addChunk", Label: "Phase 3"},
			{Op: "advance"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Effort.Chunks[0].Status != "done" || got.Effort.Chunks[1].Status != "active" || len(got.Effort.Chunks) != 3 {
		t.Fatalf("mutate result: %+v", got.Effort.Chunks)
	}
}

func TestEffortCreateValidation(t *testing.T) {
	ws := &WshServer{}
	_, err := ws.EffortCreateCommand(context.Background(), wshrpc.CommandEffortCreateData{
		Title:  "",
		Chunks: []wshrpc.CommandEffortChunkSeed{{Label: "x"}},
	})
	if err == nil || !strings.Contains(err.Error(), "EC-INVALID-TITLE") {
		t.Fatalf("want EC-INVALID-TITLE, got %v", err)
	}
	_, err = ws.EffortCreateCommand(context.Background(), wshrpc.CommandEffortCreateData{
		Title:  "dup",
		Chunks: []wshrpc.CommandEffortChunkSeed{{Label: "a"}, {Label: "a"}},
	})
	if err == nil || !strings.Contains(err.Error(), "EC-DUPLICATE-LABEL") {
		t.Fatalf("want EC-DUPLICATE-LABEL, got %v", err)
	}
}

func TestEffortMutateAtomicBatchRejected(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	rtn, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "atomic"})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, rtn.EffortOID)
	_, err = ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: rtn.EffortOID,
		Ops: []wshrpc.EffortOp{
			{Op: "rename", Title: "should-not-stick"},
			{Op: "setChunkStatus", Chunk: "nope", Status: "done"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "EC-UNKNOWN-CHUNK") {
		t.Fatalf("want EC-UNKNOWN-CHUNK, got %v", err)
	}
	got, gerr := wstore.GetEffort(ctx, rtn.EffortOID)
	if gerr != nil {
		t.Fatal(gerr)
	}
	if got.Title != "atomic" {
		t.Fatalf("batch not atomic: %+v", got)
	}
}

func TestEffortMutateUnknownEffort(t *testing.T) {
	ws := &WshServer{}
	_, err := ws.EffortMutateCommand(context.Background(), wshrpc.CommandEffortMutateData{
		EffortOID: "00000000-0000-0000-0000-000000000000",
		Ops:       []wshrpc.EffortOp{{Op: "rename", Title: "x"}},
	})
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("want not-found error, got %v", err)
	}
}

func TestEffortLinkParentValidation(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	parent, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "parent"})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, parent.EffortOID)
	child, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "child"})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, child.EffortOID)
	// self-link rejected
	_, err = ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: parent.EffortOID,
		Ops:       []wshrpc.EffortOp{{Op: "link", ParentOID: parent.EffortOID}},
	})
	if err == nil || !strings.Contains(err.Error(), "EC-BAD-PARENT") {
		t.Fatalf("want EC-BAD-PARENT, got %v", err)
	}
	// unknown parent rejected
	_, err = ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: child.EffortOID,
		Ops:       []wshrpc.EffortOp{{Op: "link", ParentOID: "00000000-0000-0000-0000-000000000000"}},
	})
	if err == nil || !strings.Contains(err.Error(), "EC-BAD-PARENT") {
		t.Fatalf("want EC-BAD-PARENT, got %v", err)
	}
	// valid link
	_, err = ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: child.EffortOID,
		Ops:       []wshrpc.EffortOp{{Op: "link", ParentOID: parent.EffortOID}},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestEffortListAndGet(t *testing.T) {
	ctx := context.Background()
	ws := &WshServer{}
	rtn, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "listed", Project: "proj-a"})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, rtn.EffortOID)
	archived, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "archived"})
	if err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, archived.EffortOID)
	if _, err := ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{
		EffortOID: archived.EffortOID,
		Ops:       []wshrpc.EffortOp{{Op: "setStatus", Status: "archived"}},
	}); err != nil {
		t.Fatal(err)
	}
	list, err := ws.EffortListCommand(ctx, wshrpc.CommandEffortListData{})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range list.Efforts {
		if s.ORef == "effort:"+archived.EffortOID {
			t.Fatalf("archived effort leaked into list: %+v", list.Efforts)
		}
	}
	// get works for archived
	got, err := ws.EffortGetCommand(ctx, wshrpc.CommandEffortGetData{EffortOID: archived.EffortOID})
	if err != nil {
		t.Fatal(err)
	}
	if got.Effort.Status != "archived" {
		t.Fatalf("get: %+v", got.Effort)
	}
}
