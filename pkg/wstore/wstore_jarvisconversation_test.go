// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestJarvisConversationSchemaAndRegistration(t *testing.T) {
	ctx := context.Background()
	got, err := WithReadTxRtn(ctx, func(tx *TxWrap) (string, error) {
		return tx.GetString("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'db_jarvisconversation'"), nil
	})
	if err != nil {
		t.Fatalf("query sqlite_master: %v", err)
	}
	if got != "db_jarvisconversation" {
		t.Fatalf("db_jarvisconversation table missing (got %q) - did migration 000015 run?", got)
	}
	if ot := getOTypeGen[*waveobj.JarvisConvo](); ot != waveobj.OType_JarvisConversation {
		t.Fatalf("JarvisConvo otype = %q, want %q", ot, waveobj.OType_JarvisConversation)
	}
	if tn := tableNameGen[*waveobj.JarvisConvo](); tn != "db_jarvisconversation" {
		t.Fatalf("JarvisConvo table = %q, want db_jarvisconversation", tn)
	}
}

func TestJarvisConversationCRUD(t *testing.T) {
	ctx := context.Background()
	aOID := uuid.NewString()
	bOID := uuid.NewString()
	t.Cleanup(func() {
		if err := DeleteJarvisConversation(ctx, aOID); err != nil {
			t.Errorf("cleanup a: %v", err)
		}
		if err := DeleteJarvisConversation(ctx, bOID); err != nil {
			t.Errorf("cleanup b: %v", err)
		}
	})

	a, err := CreateJarvisConversation(ctx, aOID, "first", "all", "", nil)
	if err != nil {
		t.Fatalf("create a: %v", err)
	}
	b, err := CreateJarvisConversation(ctx, bOID, "second", "project", "/repo", []string{"run:r1"})
	if err != nil {
		t.Fatalf("create b: %v", err)
	}

	got, err := GetJarvisConversation(ctx, a.OID)
	if err != nil || got.Title != "first" || got.ScopeMode != "all" {
		t.Fatalf("get a mismatch: %+v err=%v", got, err)
	}
	got, err = GetJarvisConversation(ctx, b.OID)
	if err != nil {
		t.Fatalf("get b: %v", err)
	}
	if got.ProjectPath != "/repo" {
		t.Fatalf("b project path = %q, want /repo", got.ProjectPath)
	}
	if len(got.AttachedORefs) != 1 || got.AttachedORefs[0] != "run:r1" {
		t.Fatalf("b attached orefs = %v, want [run:r1]", got.AttachedORefs)
	}

	if err := AppendJarvisTurn(ctx, a.OID, waveobj.JarvisConvoTurn{Role: "user", Text: "q1"}); err != nil {
		t.Fatalf("append turn: %v", err)
	}
	got, err = GetJarvisConversation(ctx, a.OID)
	if err != nil {
		t.Fatalf("get a after append: %v", err)
	}
	if len(got.Turns) != 1 || got.Turns[0].Text != "q1" {
		t.Fatalf("append not persisted: %+v", got.Turns)
	}

	// deterministic newest-first: set explicit UpdatedTs, a > b.
	if err := DBUpdateFn(ctx, a.OID, func(c *waveobj.JarvisConvo) { c.UpdatedTs = 2000 }); err != nil {
		t.Fatalf("set a updated timestamp: %v", err)
	}
	if err := DBUpdateFn(ctx, b.OID, func(c *waveobj.JarvisConvo) { c.UpdatedTs = 1000 }); err != nil {
		t.Fatalf("set b updated timestamp: %v", err)
	}
	list, err := GetJarvisConversations(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) < 2 || list[0].OID != a.OID {
		t.Fatalf("expected newest-first with a (%s) leading, got %v", a.OID, oidsOf(list))
	}

	if err := DeleteJarvisConversation(ctx, b.OID); err != nil {
		t.Fatalf("delete b: %v", err)
	}
	if _, err := GetJarvisConversation(ctx, b.OID); err == nil {
		t.Fatalf("expected b to be gone after delete")
	}
}

func TestJarvisConversationListBreaksTimestampTiesByOID(t *testing.T) {
	ctx := context.Background()
	lowerOID := uuid.NewString()
	higherOID := uuid.NewString()
	if lowerOID > higherOID {
		lowerOID, higherOID = higherOID, lowerOID
	}
	t.Cleanup(func() {
		if err := DeleteJarvisConversation(ctx, lowerOID); err != nil {
			t.Errorf("cleanup lower oid: %v", err)
		}
		if err := DeleteJarvisConversation(ctx, higherOID); err != nil {
			t.Errorf("cleanup higher oid: %v", err)
		}
	})

	if _, err := CreateJarvisConversation(ctx, higherOID, "higher", "all", "", nil); err != nil {
		t.Fatalf("create higher oid: %v", err)
	}
	if _, err := CreateJarvisConversation(ctx, lowerOID, "lower", "all", "", nil); err != nil {
		t.Fatalf("create lower oid: %v", err)
	}
	const tiedUpdatedTs = 3000
	if err := DBUpdateFn(ctx, lowerOID, func(c *waveobj.JarvisConvo) { c.UpdatedTs = tiedUpdatedTs }); err != nil {
		t.Fatalf("set lower oid timestamp: %v", err)
	}
	if err := DBUpdateFn(ctx, higherOID, func(c *waveobj.JarvisConvo) { c.UpdatedTs = tiedUpdatedTs }); err != nil {
		t.Fatalf("set higher oid timestamp: %v", err)
	}

	list, err := GetJarvisConversations(ctx)
	if err != nil {
		t.Fatalf("list conversations: %v", err)
	}
	lowerIndex := indexOfOID(list, lowerOID)
	higherIndex := indexOfOID(list, higherOID)
	if lowerIndex == -1 || higherIndex == -1 {
		t.Fatalf("tied conversations missing from list: %v", oidsOf(list))
	}
	if lowerIndex > higherIndex {
		t.Fatalf("expected oid ascending for tied timestamps, got %s before %s", higherOID, lowerOID)
	}
}

func oidsOf(list []*waveobj.JarvisConvo) []string {
	out := make([]string, len(list))
	for i, c := range list {
		out[i] = c.OID
	}
	return out
}

func indexOfOID(list []*waveobj.JarvisConvo, oid string) int {
	for i, c := range list {
		if c.OID == oid {
			return i
		}
	}
	return -1
}
