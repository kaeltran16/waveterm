// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"math"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func seedLeadRun(t *testing.T, prefix string) {
	t.Helper()
	ch, err := wstore.CreateChannel(context.Background(), prefix+"-ch", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := waveobj.Run{ID: uuid.NewString(), Mode: "orchestrator", SessionId: prefix + "-2", LeadSessionIds: []string{prefix + "-1", prefix + "-2"}}
	if err := wstore.AppendRun(context.Background(), ch.OID, run); err != nil {
		t.Fatal(err)
	}
}

func TestRunsBySession(t *testing.T) {
	seedLeadRun(t, "rbs")
	got, err := runsBySession(context.Background(), []string{"rbs-1", "rbs-2", "rbs-unlinked"})
	if err != nil {
		t.Fatal(err)
	}
	if got["rbs-1"] == nil || got["rbs-1"] != got["rbs-2"] {
		t.Fatalf("want the earlier and current lead session on one run, got %+v", got)
	}
	if got["rbs-unlinked"] != nil || len(got) != 2 {
		t.Fatalf("an unlinked id maps to nothing, got %+v", got)
	}
}

// manySessionIds is n ids, the first of them the given ones and the rest linked to no run
func manySessionIds(n int, linked ...string) []string {
	ids := append([]string{}, linked...)
	for len(ids) < n {
		ids = append(ids, uuid.NewString())
	}
	return ids
}

// All time names every session ever kept, past SQLite's cap on a statement's bound parameters
func TestRunsBySessionManyIds(t *testing.T) {
	seedLeadRun(t, "many")
	seedLeadRun(t, "many-b")
	linked := []string{"many-1", "many-2", "many-b-1", "many-b-2"}
	got, err := runsBySession(context.Background(), manySessionIds(12000, linked...))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(linked) {
		t.Fatalf("want only the %d linked ids mapped, got %d", len(linked), len(got))
	}
	for _, id := range linked {
		one, err := runsBySession(context.Background(), []string{id})
		if err != nil {
			t.Fatal(err)
		}
		if one[id] == nil || got[id] == nil || got[id].OID != one[id].OID {
			t.Fatalf("%s: linked with 12,000 ids to %v, alone to %v", id, got[id], one[id])
		}
	}
}

// linking reads the run table once, whatever the number of ids: a per-id or per-chunk scan grows with them
func TestRunsBySessionCostDoesNotGrowWithIds(t *testing.T) {
	for i := range 50 {
		seedLeadRun(t, fmt.Sprintf("cost-%d", i))
	}
	ctx := context.Background()
	few, many := manySessionIds(100, "cost-0-1"), manySessionIds(12000, "cost-0-1")
	best := func(fn func()) time.Duration {
		fastest := time.Duration(math.MaxInt64)
		for range 3 {
			start := time.Now()
			fn()
			fastest = min(fastest, time.Since(start))
		}
		return fastest
	}
	link := func(ids []string) func() {
		return func() {
			if _, err := runsBySession(ctx, ids); err != nil {
				t.Fatal(err)
			}
		}
	}
	read := best(func() {
		if _, err := wstore.GetAllRunsShared(ctx); err != nil {
			t.Fatal(err)
		}
	})
	dFew, dMany := best(link(few)), best(link(many))
	// the slack covers building a 12,000-entry set, well under a millisecond, and a scheduler hiccup
	const slack = 20 * time.Millisecond
	if dMany > dFew+read+slack {
		t.Fatalf("12,000 ids took %v, over 100 ids' %v plus one run read's %v", dMany, dFew, read)
	}
}

func TestLinkSessionsToRunsLeadSessionIds(t *testing.T) {
	seedLeadRun(t, "lsr")
	sessions := []wshrpc.SessionActivity{{ID: "lsr-1"}}
	if err := linkSessionsToRuns(context.Background(), sessions); err != nil {
		t.Fatal(err)
	}
	if sessions[0].RunId == "" || sessions[0].Role != "lead" {
		t.Fatalf("an earlier lead session links to its run as lead, got %+v", sessions[0])
	}
}

func TestRunLinkOf(t *testing.T) {
	dag := &waveobj.TaskGroup{RunID: "lead", ChannelId: "ch", Tasks: []waveobj.TaskNode{
		{ID: "t-1", RunID: "w1-retry"},
		{ID: "t-2", RunID: "w2", ReviewRunID: "rv2"},
	}}
	cases := []struct {
		name string
		run  waveobj.Run
		dag  *waveobj.TaskGroup
		want sessionRunLink
		ok   bool
	}{
		{"lead owns the dag", waveobj.Run{OID: "lead", ChannelOID: "ch", DagORef: "d", Mode: "orchestrator"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", Role: "lead"}, true},
		{"lead before its dag", waveobj.Run{OID: "lead", ChannelOID: "ch", Mode: "orchestrator"}, nil,
			sessionRunLink{RunId: "lead", ChannelId: "ch", Role: "lead"}, true},
		{"an earlier attempt is placed by its own task id", waveobj.Run{OID: "w1", DagORef: "d", TaskId: "t-1"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", TaskId: "t-1", Role: "worker"}, true},
		{"a finished reviewer keeps its role", waveobj.Run{OID: "rv1", DagORef: "d", TaskId: "t-1", Review: true}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", TaskId: "t-1", Role: "review"}, true},
		{"a legacy worker is placed by the task's link", waveobj.Run{OID: "w2", DagORef: "d"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", TaskId: "t-2", Role: "worker"}, true},
		{"a legacy reviewer is placed by the task's review link", waveobj.Run{OID: "rv2", DagORef: "d"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", TaskId: "t-2", Role: "review"}, true},
		{"a plan reviewer is placed by its stage", waveobj.Run{OID: "pr", DagORef: "d", StageRole: "plan-reviewer"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", Role: "plan-reviewer", StageRunId: "pr"}, true},
		{"a final verifier is placed by its stage", waveobj.Run{OID: "fv", DagORef: "d", StageRole: "verifier"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", Role: "verifier", StageRunId: "fv"}, true},
		{"an unlinked legacy child stays in its run", waveobj.Run{OID: "gone", DagORef: "d"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", Role: "worker"}, true},
		{"a child whose dag is gone", waveobj.Run{OID: "w", DagORef: "d", TaskId: "t-1"}, nil, sessionRunLink{}, false},
		{"a plain run", waveobj.Run{OID: "q", Mode: "quick"}, nil, sessionRunLink{}, false},
	}
	for _, c := range cases {
		got, ok := runLinkOf(&c.run, c.dag)
		if ok != c.ok || got != c.want {
			t.Errorf("%s: got %+v %v, want %+v %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestLinkSessionsToRunsBrainstormOneShot(t *testing.T) {
	ch, err := wstore.CreateChannel(context.Background(), "bos-ch", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := waveobj.Run{ID: uuid.NewString(), Mode: "quick", SessionId: "bos-1", StageRole: "builder-check"}
	if err := wstore.AppendRun(context.Background(), ch.OID, run); err != nil {
		t.Fatal(err)
	}
	sessions := []wshrpc.SessionActivity{{ID: "bos-1"}}
	if err := linkSessionsToRuns(context.Background(), sessions); err != nil {
		t.Fatal(err)
	}
	if sessions[0].RunId == "" || sessions[0].ChannelId != ch.OID || sessions[0].Role != "builder-check" {
		t.Fatalf("a builder check's session links to its own run by its stage role, got %+v", sessions[0])
	}
	if !isRunAgent(sessions[0].Role) {
		t.Fatalf("a builder check's session is a run agent")
	}
}
