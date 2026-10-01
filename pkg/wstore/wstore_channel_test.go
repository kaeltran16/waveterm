// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
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

func TestAppendChannelMessageAppendsInOrder(t *testing.T) {
	ch := &waveobj.Channel{OID: "c1"}
	appendChannelMessage(ch, NewChannelMessage("human", "you", "first", "", 1))
	appendChannelMessage(ch, NewChannelMessage("human", "you", "second", "", 2))
	if len(ch.Messages) != 2 {
		t.Fatalf("want 2 messages, got %d", len(ch.Messages))
	}
	if ch.Messages[0].Text != "first" || ch.Messages[1].Text != "second" {
		t.Errorf("wrong order: %+v", ch.Messages)
	}
}

func TestAppendRunInAppends(t *testing.T) {
	ch := &waveobj.Channel{OID: "c1"}
	appendRunIn(ch, waveobj.Run{ID: "r1", Goal: "a"})
	appendRunIn(ch, waveobj.Run{ID: "r2", Goal: "b"})
	if len(ch.Runs) != 2 || ch.Runs[0].ID != "r1" || ch.Runs[1].ID != "r2" {
		t.Fatalf("unexpected runs: %+v", ch.Runs)
	}
}

func TestUpdateRunInMutatesMatch(t *testing.T) {
	ch := &waveobj.Channel{OID: "c1", Runs: []waveobj.Run{{ID: "r1"}, {ID: "r2"}}}
	err := updateRunIn(ch, "r2", func(r *waveobj.Run) error {
		r.Status = "done"
		return nil
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ch.Runs[1].Status != "done" || ch.Runs[0].Status != "" {
		t.Errorf("wrong run mutated: %+v", ch.Runs)
	}
}

func TestUpdateRunInErrorsWhenMissing(t *testing.T) {
	ch := &waveobj.Channel{OID: "c1", Runs: []waveobj.Run{{ID: "r1"}}}
	if err := updateRunIn(ch, "nope", func(*waveobj.Run) error { return nil }); err == nil {
		t.Fatalf("expected error for missing run id")
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
