// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func indexedSession(id string, lastActive int64, turns ...string) agentsessions.IndexedSession {
	s := agentsessions.IndexedSession{Info: agentsessions.SessionInfo{ID: id, Task: "task " + id, LastActiveTs: lastActive}}
	for i, text := range turns {
		speaker := "user"
		if i%2 == 1 {
			speaker = "agent"
		}
		s.Turns = append(s.Turns, agentsessions.Turn{Speaker: speaker, Text: text})
	}
	return s
}

// linkByRole links each session whose id names a role to a run in that role; "unlinked" stays unlinked.
func linkByRole(sessions []wshrpc.SessionActivity) error {
	for i := range sessions {
		if role := sessions[i].ID; role != "unlinked" {
			sessions[i].RunId, sessions[i].ChannelId, sessions[i].Role = "run-"+role, "ch", role
		}
	}
	return nil
}

func resultIds(results []wshrpc.SessionSearchResult) []string {
	ids := make([]string, len(results))
	for i, r := range results {
		ids[i] = r.Session.ID
	}
	return ids
}

func TestSearchSessionsEmptyQuery(t *testing.T) {
	for _, q := range []string{"", "   ", `"`, `""`} {
		rtn, err := (&WshServer{}).SearchSessionsCommand(context.Background(), wshrpc.CommandSearchSessionsData{Query: q})
		if err != nil {
			t.Fatalf("query %q: %v", q, err)
		}
		if len(rtn.Terms) != 0 || len(rtn.Results) != 0 {
			t.Fatalf("query %q gives no terms and no results, got %+v", q, rtn)
		}
	}
}

func TestSearchResultsDropsRunAgentsByDefault(t *testing.T) {
	var sessions []agentsessions.IndexedSession
	for i, id := range []string{"lead", "worker", "review", "builder-check", "brainstorm-judge", "unlinked"} {
		sessions = append(sessions, indexedSession(id, int64(100-i), "the deploy failed"))
	}
	q := agentsessions.ParseQuery("deploy")
	got := strings.Join(resultIds(searchResults(sessions, q, false, 20, linkByRole)), ",")
	if got != "lead,unlinked" {
		t.Fatalf("the default keeps the user's sessions, got %s", got)
	}
	if n := len(searchResults(sessions, q, true, 20, linkByRole)); n != 6 {
		t.Fatalf("runAgents keeps all six, got %d", n)
	}
}

func TestSearchResultsShape(t *testing.T) {
	s := indexedSession("lead", 100, "why did the deploy fail", "the deploy timed out")
	s.Info.Events = []agentsessions.SessionEvent{{Type: "started", Text: "deploy"}, {Type: "errored", Text: "deploy timeout"}}
	results := searchResults([]agentsessions.IndexedSession{s}, agentsessions.ParseQuery("deploy"), false, 20, linkByRole)
	if len(results) != 1 {
		t.Fatalf("want one result, got %d", len(results))
	}
	r := results[0]
	if r.TurnHits != 2 || r.EventHits != 1 {
		t.Fatalf("want 2 turn hits and 1 event hit, got %d and %d", r.TurnHits, r.EventHits)
	}
	if r.Session.RunId != "run-lead" || r.Session.Role != "lead" || r.Session.Task != "task lead" {
		t.Fatalf("the session carries its run link, got %+v", r.Session)
	}
	want := []wshrpc.SessionHit{
		{Kind: "turn", Speaker: "user", Ord: 0, Text: "why did the deploy fail", Marks: [][]int{{12, 18}}},
		{Kind: "turn", Speaker: "agent", Ord: 1, Text: "the deploy timed out", Marks: [][]int{{4, 10}}},
		{Kind: "event", Speaker: "errored", Ord: 1, Text: "deploy timeout", Marks: [][]int{{0, 6}}},
	}
	b, err := json.Marshal(r.Hits)
	if err != nil {
		t.Fatal(err)
	}
	wb, _ := json.Marshal(want)
	if string(b) != string(wb) {
		t.Fatalf("hits:\n got %s\nwant %s", b, wb)
	}
	if !strings.Contains(string(b), `"marks":[[12,18]]`) {
		t.Fatalf("marks serialize as [[s,e],...], got %s", b)
	}
	fb, _ := json.Marshal(r)
	if !strings.Contains(string(fb), `"turnhits":2`) || !strings.Contains(string(fb), `"eventhits":1`) {
		t.Fatalf("turnhits and eventhits are on the wire, got %s", fb)
	}
}

func TestSearchResultsNewestFirst(t *testing.T) {
	sessions := []agentsessions.IndexedSession{
		indexedSession("lead", 100, "deploy"),
		indexedSession("unlinked", 300, "deploy"),
		indexedSession("worker", 200, "deploy"),
	}
	got := strings.Join(resultIds(searchResults(sessions, agentsessions.ParseQuery("deploy"), true, 20, linkByRole)), ",")
	if got != "unlinked,worker,lead" {
		t.Fatalf("want newest first, got %s", got)
	}
}

func TestSearchResultsKeepsResultsWhenLinkFails(t *testing.T) {
	sessions := []agentsessions.IndexedSession{indexedSession("lead", 100, "deploy"), indexedSession("other", 50, "nothing")}
	fail := func([]wshrpc.SessionActivity) error { return errors.New("store down") }
	results := searchResults(sessions, agentsessions.ParseQuery("deploy"), false, 20, fail)
	if len(results) != 1 || results[0].Session.ID != "lead" {
		t.Fatalf("a link failure keeps the matched sessions, got %+v", results)
	}
}
