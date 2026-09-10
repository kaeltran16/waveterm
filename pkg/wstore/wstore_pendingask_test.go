// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"testing"
)

func pendingAskRow(oref, askId string, ts int64) PendingAskRow {
	return PendingAskRow{
		ORef:      oref,
		AskId:     askId,
		BlockId:   "b-1",
		Ts:        ts,
		Prose:     false,
		Questions: []byte(`[{"question":"Which branch?"}]`),
	}
}

func findPendingAsk(t *testing.T, oref string) (PendingAskRow, bool) {
	t.Helper()
	rows, err := GetPendingAsks(context.Background())
	if err != nil {
		t.Fatalf("get pending asks: %v", err)
	}
	for _, r := range rows {
		if r.ORef == oref {
			return r, true
		}
	}
	return PendingAskRow{}, false
}

func TestPutAndGetPendingAskRoundTrips(t *testing.T) {
	ctx := context.Background()
	row := pendingAskRow("block:pa-round-trip", "ask-1", 1000)
	row.Prose = true
	if err := PutPendingAsk(ctx, row); err != nil {
		t.Fatalf("put: %v", err)
	}
	t.Cleanup(func() { _ = DeletePendingAsk(ctx, row.ORef) })
	got, ok := findPendingAsk(t, row.ORef)
	if !ok {
		t.Fatalf("row not returned")
	}
	if got.AskId != "ask-1" || got.BlockId != "b-1" || got.Ts != 1000 || !got.Prose {
		t.Fatalf("row did not round-trip: %+v", got)
	}
	if string(got.Questions) != string(row.Questions) {
		t.Fatalf("questions did not round-trip: %s", got.Questions)
	}
}

// the oref is the primary key because one block blocks on one question at a time; a second ask has to
// replace the first rather than accumulate beside it.
func TestPutPendingAskReplacesTheAskUnderTheSameORef(t *testing.T) {
	ctx := context.Background()
	oref := "block:pa-replace"
	if err := PutPendingAsk(ctx, pendingAskRow(oref, "ask-old", 1000)); err != nil {
		t.Fatalf("put: %v", err)
	}
	t.Cleanup(func() { _ = DeletePendingAsk(ctx, oref) })
	if err := PutPendingAsk(ctx, pendingAskRow(oref, "ask-new", 2000)); err != nil {
		t.Fatalf("put again: %v", err)
	}
	rows, err := GetPendingAsks(ctx)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	n := 0
	for _, r := range rows {
		if r.ORef == oref {
			n++
			if r.AskId != "ask-new" || r.Ts != 2000 {
				t.Fatalf("upsert did not overwrite: %+v", r)
			}
		}
	}
	if n != 1 {
		t.Fatalf("want 1 row for %s, got %d", oref, n)
	}
}

func TestDeletePendingAskRemovesTheRow(t *testing.T) {
	ctx := context.Background()
	oref := "block:pa-delete"
	if err := PutPendingAsk(ctx, pendingAskRow(oref, "ask-1", 1000)); err != nil {
		t.Fatalf("put: %v", err)
	}
	if err := DeletePendingAsk(ctx, oref); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok := findPendingAsk(t, oref); ok {
		t.Fatalf("row survived the delete")
	}
}

// every retirement path can legitimately run twice (a repeat PostToolUse clear, a prune racing a
// dismiss), so a delete with nothing to delete must not be an error.
func TestDeletePendingAskIsNotAnErrorWhenAbsent(t *testing.T) {
	if err := DeletePendingAsk(context.Background(), "block:pa-never-stored"); err != nil {
		t.Fatalf("delete of absent row: %v", err)
	}
}
