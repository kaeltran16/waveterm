// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/effortstore"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func seenTicket(key string) wshrpc.JiraTicket {
	return wshrpc.JiraTicket{
		Key: key, Summary: "Refund flow", Type: "Story", Status: "In Progress", StatusCategory: "indeterminate",
		Description: "Let support refund.", Acceptance: []string{"refund posts"}, URL: "https://acme.atlassian.net/browse/" + key,
	}
}

func seedEffort(t *testing.T, e *waveobj.Effort) string {
	t.Helper()
	if err := effortstore.Create(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	return e.OID
}

func useEffortRoot(t *testing.T) {
	t.Helper()
	t.Cleanup(effortstore.UseRootForTest(t.TempDir()))
}

func TestCopyOf(t *testing.T) {
	prev := &waveobj.EffortJira{Summary: "old", LastPost: &waveobj.EffortJiraPost{Ts: 5, CommentURL: "u", From: "To Do"}}
	got := CopyOf(seenTicket("PAY-1"), "refresh", 100, prev)
	want := &waveobj.EffortJira{
		Summary: "Refund flow", Type: "Story", Status: "In Progress", StatusCategory: "indeterminate",
		Description: "Let support refund.", Acceptance: []string{"refund posts"}, SeenTs: 100, SeenVia: "refresh",
		LastPost: &waveobj.EffortJiraPost{Ts: 5, CommentURL: "u", From: "To Do"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("CopyOf = %+v, want %+v", got, want)
	}
	if got.LastPost == prev.LastPost {
		t.Error("CopyOf shares LastPost with prev")
	}
	if CopyOf(seenTicket("PAY-1"), "check", 1, nil).LastPost != nil {
		t.Error("CopyOf with no prev has a LastPost")
	}
}

func TestRecordSeenKeepsLastPost(t *testing.T) {
	useEffortRoot(t)
	ctx := context.Background()
	post := &waveobj.EffortJiraPost{Ts: 7, CommentURL: "https://acme.atlassian.net/browse/PAY-1?focusedCommentId=1", From: "To Do"}
	oid := seedEffort(t, &waveobj.Effort{Title: "x", Ticket: "PAY-1", Jira: &waveobj.EffortJira{Summary: "old", LastPost: post}})
	if err := RecordSeen(ctx, seenTicket("PAY-1"), "check", 200); err != nil {
		t.Fatal(err)
	}
	e, err := effortstore.Get(ctx, oid)
	if err != nil {
		t.Fatal(err)
	}
	if e.Jira.Summary != "Refund flow" || e.Jira.SeenTs != 200 || e.Jira.SeenVia != "check" {
		t.Errorf("copy not written: %+v", e.Jira)
	}
	if !reflect.DeepEqual(e.Jira.LastPost, post) {
		t.Errorf("LastPost = %+v, want %+v", e.Jira.LastPost, post)
	}
}

func TestRecordSeenMatchesKeyCaseInsensitively(t *testing.T) {
	useEffortRoot(t)
	ctx := context.Background()
	lower := seedEffort(t, &waveobj.Effort{Title: "a", Ticket: " pay-1 "})
	archived := seedEffort(t, &waveobj.Effort{Title: "b", Ticket: "PAY-1", Status: "archived"})
	other := seedEffort(t, &waveobj.Effort{Title: "c", Ticket: "PAY-11"})
	if err := RecordSeen(ctx, seenTicket("PAY-1"), "show", 300); err != nil {
		t.Fatal(err)
	}
	for _, oid := range []string{lower, archived} {
		e, _ := effortstore.Get(ctx, oid)
		if e.Jira == nil || e.Jira.SeenTs != 300 {
			t.Errorf("effort %s (ticket %q) has no copy: %+v", oid, e.Ticket, e.Jira)
		}
	}
	if e, _ := effortstore.Get(ctx, other); e.Jira != nil {
		t.Errorf("PAY-11 got PAY-1's copy: %+v", e.Jira)
	}
}

func TestRecordSeenCaches(t *testing.T) {
	useEffortRoot(t)
	if err := RecordSeen(context.Background(), seenTicket("CACHE-9"), "show", 400); err != nil {
		t.Fatal(err)
	}
	got, ts, ok := Cached(" cache-9")
	if !ok || ts != 400 || got.Summary != "Refund flow" {
		t.Fatalf("Cached = %+v, %d, %v", got, ts, ok)
	}
	if _, _, ok := Cached("CACHE-10"); ok {
		t.Error("an unseen key is cached")
	}
}

func TestNoteConnectionKeepsLastOk(t *testing.T) {
	prev := LastConnection()
	t.Cleanup(func() { setConnection(prev) })
	setConnection(wshrpc.JiraConnection{})

	NoteConnection("Fixture User", nil, 100)
	got := LastConnection()
	if !got.Ok || got.DisplayName != "Fixture User" || got.CheckedTs != 100 || got.LastOkTs != 100 || got.Error != "" {
		t.Fatalf("after success: %+v", got)
	}
	NoteConnection("", nil, 150)
	if got := LastConnection(); got.DisplayName != "Fixture User" || got.LastOkTs != 150 {
		t.Fatalf("a success with no name dropped the name: %+v", got)
	}
	NoteConnection("", &HTTPError{Status: 401, Message: "Unauthorized"}, 200)
	got = LastConnection()
	if got.Ok || got.DisplayName != "Fixture User" || got.LastOkTs != 150 || got.CheckedTs != 200 {
		t.Fatalf("after failure: %+v", got)
	}
	if got.Error != "EC-JIRA-HTTP 401: Unauthorized" {
		t.Errorf("Error = %q", got.Error)
	}
	NoteConnection("", Unreachable(errors.New("dial tcp: refused")), 250)
	if got := LastConnection(); got.CheckedTs != 250 || got.Error != "EC-JIRA-UNREACHABLE: dial tcp: refused" {
		t.Fatalf("after unreachable: %+v", got)
	}
}
