// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// storedUsage is every stored bucket of session, by day+model, and its stored session row
func storedUsage(t *testing.T, session string) (map[string]UsageBucket, *UsageSession) {
	t.Helper()
	buckets, sessions, err := GetUsage(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]UsageBucket{}
	for _, b := range buckets {
		if b.Session == session {
			byKey[b.Day+"/"+b.Model] = b
		}
	}
	for _, s := range sessions {
		if s.Session == session {
			return byKey, &s
		}
	}
	return byKey, nil
}

func keepUsage(t *testing.T, buckets []UsageBucket, sessions []UsageSession) int {
	t.Helper()
	n, err := KeepUsage(context.Background(), buckets, sessions, nil)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// a row is replaced only by one of at least its token total, and rows a later keep does not name stay
func TestKeepUsageOnlyGrows(t *testing.T) {
	session := uuid.NewString()
	row := func(day, model string, input, output int) UsageBucket {
		return UsageBucket{Harness: "claude", Session: session, Provider: "anthropic", Model: model, Day: day, Input: input, Output: output, Msgs: 1}
	}
	keepUsage(t, []UsageBucket{row("2026-11-01", "opus", 100, 10), row("2026-11-02", "opus", 5, 5)}, nil)

	// smaller: left as stored; a new key: added
	keepUsage(t, []UsageBucket{row("2026-11-01", "opus", 50, 10), row("2026-11-03", "haiku", 1, 1)}, nil)
	got, _ := storedUsage(t, session)
	if len(got) != 3 || got["2026-11-01/opus"].Input != 100 || got["2026-11-02/opus"].Input != 5 || got["2026-11-03/haiku"].Input != 1 {
		t.Fatalf("after a smaller keep: %+v", got)
	}

	// the same total split differently replaces it, as does a larger one
	keepUsage(t, []UsageBucket{row("2026-11-01", "opus", 90, 20), row("2026-11-02", "opus", 6, 5)}, nil)
	got, _ = storedUsage(t, session)
	if got["2026-11-01/opus"].Input != 90 || got["2026-11-01/opus"].Output != 20 || got["2026-11-02/opus"].Input != 6 || len(got) != 3 {
		t.Fatalf("after an equal and a larger keep: %+v", got)
	}
}

// a repeat keep of what is stored, or of less, writes no row
func TestKeepUsageWritesNothingWhenNothingGrew(t *testing.T) {
	session := uuid.NewString()
	cost := 0.25
	buckets := []UsageBucket{
		{Harness: "pi", Session: session, Provider: "openai", Model: "gpt", Day: "2026-11-01", Input: 7, ReportedCostUsd: &cost, Msgs: 2},
		{Harness: "pi", Session: session, Provider: "openai", Model: "gpt", Day: "2026-11-02", Output: 3, Msgs: 1},
	}
	sessions := []UsageSession{{Harness: "pi", Session: session, Cwd: "/repo", Title: "Fix it"}}
	if n := keepUsage(t, buckets, sessions); n != 3 {
		t.Fatalf("first keep wrote %d rows, want 3", n)
	}
	sameCost := 0.25
	again := []UsageBucket{buckets[0], buckets[1]}
	again[0].ReportedCostUsd = &sameCost
	smaller := buckets[1]
	smaller.Output = 2
	if n := keepUsage(t, append(again, smaller), []UsageSession{sessions[0], {Harness: "pi", Session: session}}); n != 0 {
		t.Fatalf("repeat keep wrote %d rows, want 0", n)
	}
}

// a later keep with no cwd or title leaves the stored ones
func TestKeepUsageKeepsStoredSessionMeta(t *testing.T) {
	session := uuid.NewString()
	b := []UsageBucket{{Harness: "claude", Session: session, Provider: "anthropic", Model: "opus", Day: "2026-11-01", Input: 1, Msgs: 1}}
	keepUsage(t, b, []UsageSession{{Harness: "claude", Session: session, Cwd: "/repo", Title: "First"}})
	keepUsage(t, b, []UsageSession{{Harness: "claude", Session: session, Title: "Second"}})
	keepUsage(t, b, []UsageSession{{Harness: "claude", Session: session}})
	_, meta := storedUsage(t, session)
	if meta == nil || meta.Cwd != "/repo" || meta.Title != "Second" {
		t.Fatalf("stored session = %+v, want cwd /repo and title Second", meta)
	}
}
