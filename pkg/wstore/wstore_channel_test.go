// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestNewChannelMessageSetsFieldsAndID(t *testing.T) {
	m := NewChannelMessage("dispatch", "codex", "build the auth refactor", "tab:abc", 1717000000000)
	if m.ID == "" {
		t.Fatalf("expected a generated ID")
	}
	if m.Kind != "dispatch" || m.Author != "codex" || m.Text != "build the auth refactor" {
		t.Errorf("unexpected message: %+v", m)
	}
	if m.RefORef != "tab:abc" || m.Ts != 1717000000000 {
		t.Errorf("unexpected ref/ts: %+v", m)
	}
}

func TestUpdateRunMutatesOnlyTheMatch(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "update-run", "/p")
	if err != nil {
		t.Fatal(err)
	}
	other, err := CreateChannel(ctx, "update-run-other", "/p")
	if err != nil {
		t.Fatal(err)
	}
	first, second, foreign := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for id, channelId := range map[string]string{first: ch.OID, second: ch.OID, foreign: other.OID} {
		if err := AppendRun(ctx, channelId, waveobj.Run{ID: id, Status: "planning"}); err != nil {
			t.Fatal(err)
		}
	}
	markDone := func(r *waveobj.Run) error {
		r.Status = "done"
		return nil
	}
	if err := UpdateRun(ctx, ch.OID, second, markDone); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for id, want := range map[string]string{first: "planning", second: "done"} {
		got, err := GetRun(ctx, ch.OID, id)
		if err != nil || got.Status != want {
			t.Errorf("run %s status = %+v (err %v), want %s", id, got, err, want)
		}
	}
	if err := UpdateRun(ctx, ch.OID, uuid.NewString(), markDone); err == nil {
		t.Errorf("expected error for missing run id")
	}
	// a run that exists under another channel is not this channel's
	if err := UpdateRun(ctx, ch.OID, foreign, markDone); err == nil {
		t.Errorf("expected error for a run in another channel")
	}
	if got, err := GetRun(ctx, other.OID, foreign); err != nil || got.Status != "planning" {
		t.Errorf("the other channel's run changed: %+v (err %v)", got, err)
	}
	if err := UpdateRun(ctx, uuid.NewString(), second, markDone); err == nil {
		t.Errorf("expected error for a missing channel")
	}
}

func TestChannelAtPath(t *testing.T) {
	ctx := context.Background()
	a, err := CreateChannel(ctx, "alpha", "/repo/alpha")
	if err != nil {
		t.Fatalf("CreateChannel alpha: %v", err)
	}
	if _, err := CreateChannel(ctx, "beta", "/repo/beta"); err != nil {
		t.Fatalf("CreateChannel beta: %v", err)
	}

	got, err := ChannelAtPath(ctx, "/repo/alpha")
	if err != nil {
		t.Fatalf("ChannelAtPath: %v", err)
	}
	if got == nil || got.OID != a.OID {
		t.Fatalf("ChannelAtPath(/repo/alpha) = %v, want %s", got, a.OID)
	}

	// a Windows spelling and a trailing slash are the same project
	got, err = ChannelAtPath(ctx, "/repo/alpha/")
	if err != nil {
		t.Fatalf("ChannelAtPath trailing slash: %v", err)
	}
	if got == nil || got.OID != a.OID {
		t.Fatalf("ChannelAtPath(/repo/alpha/) = %v, want %s", got, a.OID)
	}

	got, err = ChannelAtPath(ctx, "/repo/nothing")
	if err != nil {
		t.Fatalf("ChannelAtPath miss: %v", err)
	}
	if got != nil {
		t.Fatalf("ChannelAtPath(/repo/nothing) = %v, want nil", got)
	}

	// an empty path is not "every channel with no path" — it is no answer
	got, err = ChannelAtPath(ctx, "")
	if err != nil {
		t.Fatalf("ChannelAtPath empty: %v", err)
	}
	if got != nil {
		t.Fatalf("ChannelAtPath(\"\") = %v, want nil", got)
	}
}

func TestChannelAtPathMatchesSeparatorStyles(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "wave", `C:\Users\k\wave`)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	got, err := ChannelAtPath(ctx, "C:/Users/k/wave")
	if err != nil {
		t.Fatalf("ChannelAtPath: %v", err)
	}
	if got == nil || got.OID != ch.OID {
		t.Fatalf("ChannelAtPath forward-slash = %v, want %s", got, ch.OID)
	}
}

func TestGetRunsBySessionIds(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "runs-by-session", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range []waveobj.Run{
		{ID: uuid.NewString(), Goal: "a", SessionId: "s-a"},
		{ID: uuid.NewString(), Goal: "b", SessionId: "s-b"},
		{ID: uuid.NewString(), Goal: "none"},
		{ID: uuid.NewString(), Goal: "lead", SessionId: "s-lead-2", LeadSessionIds: []string{"s-lead-1", "s-lead-2"}},
		{ID: uuid.NewString(), Goal: "scan", SessionId: "s-scan", ConsultSessions: []waveobj.ConsultSession{{SessionId: "s-consult", Role: "workflow-scan"}}},
	} {
		if err := AppendRun(ctx, ch.OID, r); err != nil {
			t.Fatal(err)
		}
	}
	got, err := GetRunsBySessionIds(ctx, []string{"s-a", "s-missing"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Goal != "a" {
		t.Fatalf("want only the run launched under s-a, got %+v", got)
	}
	got, err = GetRunsBySessionIds(ctx, []string{"s-lead-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Goal != "lead" {
		t.Fatalf("want the lead run found by an earlier lead session, got %+v", got)
	}
	got, err = GetRunsBySessionIds(ctx, []string{"s-lead-1", "s-lead-2"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("a run matching on both fields comes back once, got %+v", got)
	}
	got, err = GetRunsBySessionIds(ctx, []string{"s-consult"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Goal != "scan" {
		t.Fatalf("want the scan run found by its consult session, got %+v", got)
	}
	if none, err := GetRunsBySessionIds(ctx, nil); err != nil || len(none) != 0 {
		t.Fatalf("no ids: want nothing, got %v %v", none, err)
	}
}

func TestGetRunsByStatus(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "runs-by-status", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range []waveobj.Run{
		{ID: uuid.NewString(), Goal: "executing", Status: "executing"},
		{ID: uuid.NewString(), Goal: "planning", Status: "planning"},
		{ID: uuid.NewString(), Goal: "done", Status: "done"},
	} {
		if err := AppendRun(ctx, ch.OID, r); err != nil {
			t.Fatal(err)
		}
	}
	got, err := GetRunsByStatus(ctx, "executing", "planning")
	if err != nil {
		t.Fatal(err)
	}
	goals := map[string]bool{}
	for _, r := range got {
		if r.ChannelOID == ch.OID {
			goals[r.Goal] = true
		}
	}
	if len(goals) != 2 || !goals["executing"] || !goals["planning"] {
		t.Fatalf("want the executing and planning runs only, got %v", goals)
	}
	if none, err := GetRunsByStatus(ctx); err != nil || len(none) != 0 {
		t.Fatalf("no statuses: want nothing, got %v %v", none, err)
	}
}

func TestEnsureChannelAtPathCreatesOnceAndRefusesNoPath(t *testing.T) {
	ctx := context.Background()
	first, err := EnsureChannelAtPath(ctx, "ensure", "/repo/ensure")
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	second, err := EnsureChannelAtPath(ctx, "ensure renamed", `\repo\ensure\`)
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if second.OID != first.OID || second.Name != "ensure" {
		t.Fatalf("second ensure = %s %q, want the existing %s \"ensure\"", second.OID, second.Name, first.OID)
	}
	if _, err := EnsureChannelAtPath(ctx, "none", ""); err == nil {
		t.Fatalf("ensure with no path succeeded; a pathless channel is not a project's")
	}
}

func TestGetStageRunDurations(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "stage-run-durations", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	role := "durations-" + uuid.NewString()
	for _, r := range []waveobj.Run{
		{Goal: "finished", StageRole: role, Status: "done", CreatedTs: 1000, CompletedTs: 120_000, Report: "questions"},
		{Goal: "finished too", StageRole: role, Status: "done", CreatedTs: 5000, CompletedTs: 13_000, Report: "more"},
		{Goal: "no report", StageRole: role, Status: "done", CreatedTs: 1000, CompletedTs: 9000, Report: "  "},
		{Goal: "still reading", StageRole: role, Status: "executing", CreatedTs: 1000},
		{Goal: "lost", StageRole: role, Status: "cancelled", CreatedTs: 1000, CompletedTs: 2_000_000, Report: "x"},
		{Goal: "another role", StageRole: "verifier", Status: "done", CreatedTs: 1000, CompletedTs: 7000, Report: "x"},
	} {
		r.ID = uuid.NewString()
		if err := AppendRun(ctx, ch.OID, r); err != nil {
			t.Fatal(err)
		}
	}
	got, err := GetStageRunDurations(ctx, role)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(got)
	if !slices.Equal(got, []int64{8000, 119_000}) {
		t.Fatalf("want only the two finished, reported runs of the role, got %v", got)
	}
}

// the shared cache keys on oid and version, and a re-insert starts again at version 1, so a bulk delete
// that left the held copy would serve it for the new row
func TestDeleteChannelEvictsSharedRuns(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "evict-runs", "/p")
	if err != nil {
		t.Fatal(err)
	}
	runId := uuid.NewString()
	goalOf := func() string {
		t.Helper()
		runs, err := GetAllRunsShared(ctx)
		if err != nil {
			t.Fatalf("GetAllRunsShared: %v", err)
		}
		for _, r := range runs {
			if r.OID == runId {
				return r.Goal
			}
		}
		t.Fatalf("run %s missing", runId)
		return ""
	}
	if err := AppendRun(ctx, ch.OID, waveobj.Run{ID: runId, Goal: "first"}); err != nil {
		t.Fatal(err)
	}
	if g := goalOf(); g != "first" {
		t.Fatalf("goal = %q, want first", g)
	}
	if err := DeleteChannel(ctx, ch.OID); err != nil {
		t.Fatalf("delete channel: %v", err)
	}
	if err := DBInsert(ctx, &waveobj.Run{OID: runId, ID: runId, Goal: "second", Meta: make(waveobj.MetaMapType)}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = DBDelete(ctx, waveobj.OType_Run, runId) })
	if g := goalOf(); g != "second" {
		t.Fatalf("goal = %q after channel delete and re-insert, want second", g)
	}
}

func TestDeleteChannelEvictsSharedDags(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "evict-dags", "/p")
	if err != nil {
		t.Fatal(err)
	}
	dagId := uuid.NewString()
	insert := func(status string) {
		t.Helper()
		if err := AppendDag(ctx, &waveobj.TaskGroup{OID: dagId, ID: dagId, ChannelId: ch.OID, Status: status, Meta: make(waveobj.MetaMapType)}); err != nil {
			t.Fatal(err)
		}
	}
	insert("running")
	if d, err := GetDagShared(ctx, dagId); err != nil || d.Status != "running" {
		t.Fatalf("first read: %+v err=%v", d, err)
	}
	if err := DeleteChannel(ctx, ch.OID); err != nil {
		t.Fatalf("delete channel: %v", err)
	}
	insert("done")
	t.Cleanup(func() { _ = DBDelete(ctx, waveobj.OType_Dag, dagId) })
	d, err := GetDagShared(ctx, dagId)
	if err != nil || d.Status != "done" {
		t.Fatalf("after channel delete and re-insert: %+v err=%v, want status done", d, err)
	}
}

func TestDeleteChannelEmpty(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "evict-empty", "/p")
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteChannel(ctx, ch.OID); err != nil {
		t.Fatalf("delete empty channel: %v", err)
	}
}
