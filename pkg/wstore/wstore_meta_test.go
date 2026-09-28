// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// agent hooks re-send the same meta on every tool call; an unchanged write must not bump the
// version (and so must not be pushed to the frontend).
func TestUpdateObjectMetaSkipsUnchangedWrite(t *testing.T) {
	ctx := context.Background()
	oid := uuid.NewString()
	if err := DBInsert(ctx, &waveobj.Tab{OID: oid, Name: "t", Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("insert tab: %v", err)
	}
	oref := waveobj.MakeORef(waveobj.OType_Tab, oid)
	meta := waveobj.MetaMapType{"agent:transcriptpath": `C:\t\s.jsonl`}

	changed, err := UpdateObjectMeta(ctx, oref, meta, false)
	if err != nil || !changed {
		t.Fatalf("first write: changed=%v err=%v, want changed", changed, err)
	}
	v1 := mustTabVersion(t, ctx, oid)

	changed, err = UpdateObjectMeta(ctx, oref, meta, false)
	if err != nil || changed {
		t.Fatalf("repeat write: changed=%v err=%v, want unchanged", changed, err)
	}
	if v := mustTabVersion(t, ctx, oid); v != v1 {
		t.Fatalf("repeat write bumped version %d -> %d", v1, v)
	}

	changed, err = UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{"agent:transcriptpath": `C:\t\other.jsonl`}, false)
	if err != nil || !changed {
		t.Fatalf("new value: changed=%v err=%v, want changed", changed, err)
	}
	if v := mustTabVersion(t, ctx, oid); v <= v1 {
		t.Fatalf("changed write kept version %d", v)
	}
}

func mustTabVersion(t *testing.T, ctx context.Context, oid string) int {
	t.Helper()
	tab, err := DBMustGet[*waveobj.Tab](ctx, oid)
	if err != nil {
		t.Fatalf("get tab: %v", err)
	}
	return tab.Version
}
