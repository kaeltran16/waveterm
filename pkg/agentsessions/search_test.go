// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestParseQuery(t *testing.T) {
	cases := map[string][]string{
		`Hook  Timeout`:          {"hook", "timeout"},
		`"dial timeout" warm`:    {"dial timeout", "warm"},
		`warm "Dial   Timeout" `: {"warm", "dial timeout"},
	}
	for in, want := range cases {
		if got := ParseQuery(in).Terms; !reflect.DeepEqual(got, want) {
			t.Errorf("ParseQuery(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseQueryEdgeCases(t *testing.T) {
	for _, in := range []string{``, `   `, `"`, `""`, `" "`} {
		if got := ParseQuery(in).Terms; len(got) != 0 {
			t.Errorf("ParseQuery(%q) = %q, want no terms", in, got)
		}
	}
	if got := ParseQuery(`"open`).Terms; !reflect.DeepEqual(got, []string{"open"}) {
		t.Errorf(`ParseQuery("\"open") = %q, want [open]`, got)
	}
}

func indexedSession(title string, turns ...Turn) IndexedSession {
	return IndexedSession{Info: SessionInfo{Task: title}, Turns: turns}
}

func userTurn(text string) Turn  { return Turn{Speaker: "user", Text: text} }
func agentTurn(text string) Turn { return Turn{Speaker: "agent", Text: text} }

func TestMatchAllTermsAnyOrder(t *testing.T) {
	s := indexedSession("a title", userTurn("the hook fires"), agentTurn("then a timeout"))
	if ok, _, _, _ := ParseQuery("timeout hook").Match(s, 20); !ok {
		t.Error("timeout hook: want a match across two turns, in any order")
	}
	if ok, _, _, _ := ParseQuery("timeout zebra").Match(s, 20); ok {
		t.Error("timeout zebra: every term must occur")
	}
}

func TestMatchPhrase(t *testing.T) {
	q := ParseQuery(`"dial timeout"`)
	if ok, _, _, _ := q.Match(indexedSession("t", agentTurn("a dial timeout here")), 20); !ok {
		t.Error("phrase must match its words in order")
	}
	if ok, _, _, _ := q.Match(indexedSession("t", agentTurn("a timeout dial here")), 20); ok {
		t.Error("phrase must not match the words in another order")
	}
}

func TestMatchCaseInsensitive(t *testing.T) {
	ok, hits, _, _ := ParseQuery("TimeOut").Match(indexedSession("t", agentTurn("a TIMEOUT here")), 20)
	if !ok || len(hits) != 1 {
		t.Fatalf("ok = %v, hits = %+v", ok, hits)
	}
	if got := markText(hits[0], 0); got != "TIMEOUT" {
		t.Errorf("mark = %q, want the original casing TIMEOUT", got)
	}
}

func TestMatchTitleCountsButYieldsNoHit(t *testing.T) {
	ok, hits, turnHits, eventHits := ParseQuery("zebra").Match(indexedSession("Zebra crossing", userTurn("nothing here")), 20)
	if !ok {
		t.Fatal("a term in the title counts toward matching")
	}
	if len(hits) != 0 || turnHits != 0 || eventHits != 0 {
		t.Errorf("the title yields no hit, got %+v %d %d", hits, turnHits, eventHits)
	}
}

func TestMatchEventHits(t *testing.T) {
	s := indexedSession("t")
	s.Info.Events = []SessionEvent{
		{Type: "started", Text: "started on zebra and lion"},
		{Type: "committed", Text: "fix zebra stripes"},
		{Type: "finished", Text: "zebra lion done"},
	}
	ok, hits, turnHits, eventHits := ParseQuery("zebra").Match(s, 20)
	if !ok || turnHits != 0 || eventHits != 1 || len(hits) != 1 {
		t.Fatalf("ok = %v, turnHits = %d, eventHits = %d, hits = %+v", ok, turnHits, eventHits, hits)
	}
	h := hits[0]
	if h.Kind != "event" || h.Speaker != "committed" || h.Ord != 1 || markText(h, 0) != "zebra" {
		t.Errorf("hit = %+v", h)
	}
	if ok, _, _, _ := ParseQuery("lion").Match(s, 20); ok {
		t.Error("started and finished events are not searchable")
	}
}

func TestMatchHitOrderAndOrd(t *testing.T) {
	s := indexedSession("t", userTurn("alpha one"), agentTurn("beta alpha then alpha"))
	s.Info.Events = []SessionEvent{
		{Type: "started", Text: "started"},
		{Type: "errored", Text: "failed: alpha"},
	}
	q := ParseQuery("alpha")
	_, hits, turnHits, eventHits := q.Match(s, 2)
	if turnHits != 3 || eventHits != 1 {
		t.Fatalf("turnHits = %d, eventHits = %d, want 3 and 1 counted beyond maxHits", turnHits, eventHits)
	}
	if len(hits) != 2 || hits[0].Ord != 0 || hits[0].Speaker != "user" || hits[1].Ord != 1 || hits[1].Speaker != "agent" {
		t.Fatalf("hits = %+v", hits)
	}
	_, hits, _, _ = q.Match(s, 20)
	var got []string
	for _, h := range hits {
		got = append(got, h.Kind+":"+h.Speaker+":"+string(rune('0'+h.Ord)))
	}
	want := []string{"turn:user:0", "turn:agent:1", "turn:agent:2", "event:errored:1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("hits = %v, want %v", got, want)
	}
}

func TestMatchMergesOverlappingTerms(t *testing.T) {
	_, hits, turnHits, _ := ParseQuery("time timeout").Match(indexedSession("t", agentTurn("a timeout here")), 20)
	if turnHits != 1 || len(hits) != 1 {
		t.Fatalf("turnHits = %d, hits = %+v, want one merged hit", turnHits, hits)
	}
	if got := markText(hits[0], 0); got != "timeout" {
		t.Errorf("mark = %q, want timeout", got)
	}
}

func TestMatchSnippetWindow(t *testing.T) {
	text := strings.Repeat("x", 50) + " needle " + strings.Repeat("y", 50)
	_, hits, _, _ := ParseQuery("needle").Match(indexedSession("t", agentTurn(text)), 20)
	if len(hits) != 1 {
		t.Fatalf("hits = %+v", hits)
	}
	want := "…" + strings.Repeat("x", 39) + " needle " + strings.Repeat("y", 39) + "…"
	if hits[0].Text != want {
		t.Errorf("snippet = %q\nwant %q", hits[0].Text, want)
	}
	if got := markText(hits[0], 0); got != "needle" {
		t.Errorf("mark = %q", got)
	}

	_, hits, _, _ = ParseQuery("needle").Match(indexedSession("t", agentTurn("  fix   the\n\nneedle now ")), 20)
	if len(hits) != 1 || hits[0].Text != "fix the needle now" || !reflect.DeepEqual(hits[0].Marks, [][2]int{{8, 14}}) {
		t.Errorf("collapsed snippet = %+v", hits)
	}
}

func TestMatchNonASCIIMarks(t *testing.T) {
	ok, hits, turnHits, _ := ParseQuery("lỗi").Match(indexedSession("t", agentTurn("🙂 Lỗi kết nối, lỗi")), 20)
	if !ok || turnHits != 2 || len(hits) != 2 {
		t.Fatalf("ok = %v, turnHits = %d, hits = %+v", ok, turnHits, hits)
	}
	if len(hits[0].Marks) != 2 || markText(hits[0], 0) != "Lỗi" || markText(hits[0], 1) != "lỗi" {
		t.Fatalf("marks = %v (%q, %q)", hits[0].Marks, markText(hits[0], 0), markText(hits[0], 1))
	}
}

// markText is the text a hit's i-th mark covers, read as the frontend reads it: UTF-16 offsets into Text.
func markText(h Hit, i int) string {
	if i >= len(h.Marks) {
		return ""
	}
	u := utf16.Encode([]rune(h.Text))
	m := h.Marks[i]
	if m[0] < 0 || m[1] > len(u) || m[0] > m[1] {
		return ""
	}
	return string(utf16.Decode(u[m[0]:m[1]]))
}
