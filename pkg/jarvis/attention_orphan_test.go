// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func seedOrphanTab(t *testing.T, name string, meta waveobj.MetaMapType) string {
	t.Helper()
	ctx := context.Background()
	tab := &waveobj.Tab{OID: uuid.NewString(), Name: name, Meta: meta}
	if err := wstore.DBInsert(ctx, tab); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { wstore.DBDelete(ctx, waveobj.OType_Tab, tab.OID) })
	return tab.OID
}

func TestGatherAttentionListsOrphanedWorkersAfterUnverifiedRuns(t *testing.T) {
	labelled := seedOrphanTab(t, "w-1", waveobj.MetaMapType{
		"session:label":        "fix-auth",
		MetaWorkerOrphaned:     int64(5000),
		MetaWorkerOrphanAnswer: "Fixed the token refresh",
	})
	silent := seedOrphanTab(t, "w-2", waveobj.MetaMapType{MetaWorkerOrphaned: int64(3000)})
	seedOrphanTab(t, "w-3", waveobj.MetaMapType{"agent:parenttab": uuid.NewString()})

	unverified := &waveobj.RunEvidence{Verification: &waveobj.RunVerification{State: "unverified", Reasons: []string{"no Verify"}}}
	items, err := GatherAttentionFromLedger(context.Background(), []*waveobj.Channel{{OID: "c-orphan", Name: "alpha"}},
		map[string][]*waveobj.Run{"c-orphan": {finishedRun("r-unverified", unverified, nil)}})
	if err != nil {
		t.Fatal(err)
	}

	want := []wshrpc.AttentionItem{
		{Kind: AttentionWorkerOrphan, Key: "worker-orphan:" + silent, ORef: "tab:" + silent, Source: "w-2",
			Text: "Parent ended · no answer", Action: "Acknowledge", WaitingSince: 3000},
		{Kind: AttentionWorkerOrphan, Key: "worker-orphan:" + labelled, ORef: "tab:" + labelled, Source: "fix-auth",
			Text: "Parent ended · Fixed the token refresh", Action: "Acknowledge", WaitingSince: 5000},
	}
	if len(items) != 3 || items[0].Kind != AttentionRunUnverified {
		t.Fatalf("items = %+v, want the unverified run then two orphans", items)
	}
	for i, w := range want {
		got := items[i+1]
		got.Why = ""
		if !reflect.DeepEqual(got, w) {
			t.Errorf("orphan item %d = %+v, want %+v", i, got, w)
		}
	}
}
