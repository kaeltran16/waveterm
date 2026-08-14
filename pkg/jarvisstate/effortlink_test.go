package jarvisstate

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
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

func TestAttachRunToChunk(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "t", Status: "active",
		Chunks: []waveobj.EffortChunk{{Label: "Phase 1", Status: "active"}}}
	if err := wstore.CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, e.OID)

	if err := AttachRunToChunk(ctx, e.OID, "Phase 1", "run:r1"); err != nil {
		t.Fatal(err)
	}
	got, err := wstore.GetEffort(ctx, e.OID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Chunks[0].WorkRefs) != 1 || got.Chunks[0].WorkRefs[0].ORef != "run:r1" {
		t.Fatalf("workref: %+v", got.Chunks[0].WorkRefs)
	}
}

func TestAttachRunToChunkIdempotent(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "t", Status: "active",
		Chunks: []waveobj.EffortChunk{{Label: "Phase 1", Status: "active"}}}
	if err := wstore.CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, e.OID)
	for i := 0; i < 2; i++ {
		if err := AttachRunToChunk(ctx, e.OID, "Phase 1", "run:r1"); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := wstore.GetEffort(ctx, e.OID)
	if len(got.Chunks[0].WorkRefs) != 1 {
		t.Fatalf("not idempotent: %+v", got.Chunks[0].WorkRefs)
	}
}

func TestAttachRunToChunkUnknownEffort(t *testing.T) {
	err := AttachRunToChunk(context.Background(), "00000000-0000-0000-0000-000000000000", "Phase 1", "run:r1")
	if err == nil {
		t.Fatal("want error")
	}
}

func TestAttachRunToChunkUnknownChunk(t *testing.T) {
	ctx := context.Background()
	e := &waveobj.Effort{Title: "t", Status: "active",
		Chunks: []waveobj.EffortChunk{{Label: "Phase 1", Status: "active"}}}
	if err := wstore.CreateEffort(ctx, e); err != nil {
		t.Fatal(err)
	}
	cleanupEffort(t, e.OID)
	err := AttachRunToChunk(ctx, e.OID, "nope", "run:r1")
	if err == nil || !strings.Contains(err.Error(), "EC-UNKNOWN-CHUNK") {
		t.Fatalf("want EC-UNKNOWN-CHUNK, got %v", err)
	}
}
