package jarvisstate

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const now = 1_700_000_000_000

func mkEffort() *waveobj.Effort {
	return &waveobj.Effort{
		Title: "t", Status: "active",
		Chunks: []waveobj.EffortChunk{
			{Label: "Phase 1", Status: "done", UpdatedTs: now},
			{Label: "Phase 2", Status: "active", UpdatedTs: now},
			{Label: "Phase 3", Status: "pending", UpdatedTs: now},
		},
	}
}

func expectErrCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), code) {
		t.Fatalf("want error containing %q, got %v", code, err)
	}
}

func TestApplyOpsRename(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "rename", Title: "new title"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if e.Title != "new title" {
		t.Fatalf("title: %q", e.Title)
	}
}

func TestApplyOpsAddChunkInsertAt(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "addChunk", Label: "Phase 0", At: intPtr(1)}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Chunks) != 4 || e.Chunks[0].Label != "Phase 0" {
		t.Fatalf("chunks: %+v", e.Chunks)
	}
}

func TestApplyOpsAddChunkDuplicateLabel(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "addChunk", Label: "Phase 2"}}, "", now)
	expectErrCode(t, err, "EC-DUPLICATE-LABEL")
}

func TestApplyOpsRemoveLastChunkGuard(t *testing.T) {
	e := mkEffort()
	e.Chunks = []waveobj.EffortChunk{{Label: "only", Status: "pending"}}
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "removeChunk", Chunk: "only"}}, "", now)
	expectErrCode(t, err, "EC-LAST-CHUNK")
}

func TestApplyOpsResolveChunkRefs(t *testing.T) {
	e := mkEffort()
	// label ref
	idx, err := ResolveChunkIndex(e, "Phase 3")
	if err != nil || idx != 2 {
		t.Fatalf("label ref: idx=%d err=%v", idx, err)
	}
	// 1-based index ref
	idx, err = ResolveChunkIndex(e, "2")
	if err != nil || idx != 1 {
		t.Fatalf("index ref: idx=%d err=%v", idx, err)
	}
	// ambiguous: "Phase" matches nothing exactly; "Phase 1" is exact — try a substring that is not a label
	_, err = ResolveChunkIndex(e, "nope")
	expectErrCode(t, err, "EC-UNKNOWN-CHUNK")
}

func TestApplyOpsSetChunkStatusEmitsEvents(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "setChunkStatus", Chunk: "Phase 3", Status: "blocked", Note: "waiting on substrate"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if e.Chunks[2].Status != "blocked" {
		t.Fatalf("status: %s", e.Chunks[2].Status)
	}
	if len(e.Chunks[2].Notes) != 1 || !strings.Contains(e.Chunks[2].Notes[0].Text, "blocked") {
		t.Fatalf("auto-stamp missing: %+v", e.Chunks[2].Notes)
	}
	if len(e.Events) != 1 || e.Events[0].Kind != "chunk-status" || e.Events[0].Label != "Phase 3" {
		t.Fatalf("events: %+v", e.Events)
	}
}

func TestApplyOpsAdvanceSemantics(t *testing.T) {
	e := mkEffort()
	// Phase 2 active -> done, Phase 3 becomes active
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "advance"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if e.Chunks[1].Status != "done" || e.Chunks[2].Status != "active" {
		t.Fatalf("advance: %+v", e.Chunks)
	}
	// no active chunk: advance just activates the first non-done
	e2 := mkEffort()
	e2.Chunks[1].Status = "pending"
	err = ApplyEffortOps(e2, []wshrpc.EffortOp{{Op: "advance"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if e2.Chunks[1].Status != "active" {
		t.Fatalf("advance-no-active: %+v", e2.Chunks)
	}
}

func TestApplyOpsReopenUndoesAdvance(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "reopen", Chunk: "Phase 1"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if e.Chunks[0].Status != "active" || e.Chunks[1].Status != "pending" {
		t.Fatalf("reopen: %+v", e.Chunks)
	}
}

func TestApplyOpsReopenNonDoneRejected(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "reopen", Chunk: "Phase 3"}}, "", now)
	expectErrCode(t, err, "EC-INVALID-STATUS")
}

func TestApplyOpsAppendNoteToChunk(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "appendNote", Chunk: "Phase 1", Note: "soak accepted"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Chunks[0].Notes) != 1 || e.Chunks[0].Notes[0].Text != "soak accepted" {
		t.Fatalf("notes: %+v", e.Chunks[0].Notes)
	}
	if len(e.Events) != 1 || e.Events[0].Kind != "effort-note" {
		t.Fatalf("events: %+v", e.Events)
	}
}

func TestApplyOpsAtomicBatchRollback(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{
		{Op: "rename", Title: "half-applied"},
		{Op: "addChunk", Label: "Phase 2"}, // duplicate — must abort the batch
	}, "", now)
	expectErrCode(t, err, "EC-DUPLICATE-LABEL")
	if e.Title != "t" {
		t.Fatalf("batch not atomic: title=%q", e.Title)
	}
}

func TestApplyOpsSetChunkStatusInvalid(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "setChunkStatus", Chunk: "Phase 3", Status: "banana"}}, "", now)
	expectErrCode(t, err, "EC-INVALID-STATUS")
}

func TestApplyOpsCmdNoteAppendedToEffort(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "setTicket", Ticket: "SIEM-1662"}}, "filed from briefing", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Notes) != 1 || !strings.Contains(e.Notes[0].Text, "filed from briefing") {
		t.Fatalf("cmd note missing: %+v", e.Notes)
	}
}

func intPtr(i int) *int { return &i }

func TestApplyOpsAttachWork(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 2", Kind: "agent", ORef: "agent:tab-1"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Chunks[1].WorkRefs) != 1 || e.Chunks[1].WorkRefs[0].ORef != "agent:tab-1" || e.Chunks[1].WorkRefs[0].Kind != "agent" {
		t.Fatalf("workrefs: %+v", e.Chunks[1].WorkRefs)
	}
	if len(e.Chunks[1].Notes) != 1 {
		t.Fatalf("auto-stamp missing: %+v", e.Chunks[1].Notes)
	}
	if len(e.Events) != 0 {
		t.Fatalf("attach must not emit delta events: %+v", e.Events)
	}
}

func TestApplyOpsAttachWorkIdempotentSameChunk(t *testing.T) {
	e := mkEffort()
	for i := 0; i < 2; i++ {
		err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 2", Kind: "agent", ORef: "agent:tab-1"}}, "", now)
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(e.Chunks[1].WorkRefs) != 1 {
		t.Fatalf("duplicate refs: %+v", e.Chunks[1].WorkRefs)
	}
}

func TestApplyOpsAttachWorkConflictOtherChunk(t *testing.T) {
	e := mkEffort()
	if err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 2", Kind: "agent", ORef: "agent:tab-1"}}, "", now); err != nil {
		t.Fatal(err)
	}
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 3", Kind: "agent", ORef: "agent:tab-1"}}, "", now)
	expectErrCode(t, err, "EC-REF-ALREADY-ATTACHED")
}

func TestApplyOpsAttachWorkInvalidKind(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 2", Kind: "bogus", ORef: "run:x"}}, "", now)
	expectErrCode(t, err, "EC-INVALID-KIND")
}

func TestApplyOpsDetachWork(t *testing.T) {
	e := mkEffort()
	op := wshrpc.EffortOp{Op: "attachWork", Chunk: "Phase 2", Kind: "agent", ORef: "agent:tab-1"}
	if err := ApplyEffortOps(e, []wshrpc.EffortOp{op}, "", now); err != nil {
		t.Fatal(err)
	}
	// chunk-scoped detach
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "detachWork", Chunk: "Phase 2", ORef: "agent:tab-1"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Chunks[1].WorkRefs) != 0 {
		t.Fatalf("refs remain: %+v", e.Chunks[1].WorkRefs)
	}
}

func TestApplyOpsDetachWorkAnyChunk(t *testing.T) {
	e := mkEffort()
	if err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "attachWork", Chunk: "Phase 3", Kind: "run", ORef: "run:r1"}}, "", now); err != nil {
		t.Fatal(err)
	}
	// chunk omitted -> removed from whichever chunk holds it
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "detachWork", ORef: "run:r1"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range e.Chunks {
		if len(c.WorkRefs) != 0 {
			t.Fatalf("refs remain: %+v", c.WorkRefs)
		}
	}
}

func TestApplyOpsDetachWorkAbsentIsNoOp(t *testing.T) {
	e := mkEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "detachWork", ORef: "run:never-was"}}, "", now)
	if err != nil {
		t.Fatal(err)
	}
}
