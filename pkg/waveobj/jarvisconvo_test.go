// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package waveobj

import (
	"reflect"
	"testing"
)

func TestJarvisConvoOType(t *testing.T) {
	if got := (&JarvisConvo{}).GetOType(); got != OType_JarvisConversation {
		t.Fatalf("GetOType() = %q, want %q", got, OType_JarvisConversation)
	}
	if !ValidOTypes[OType_JarvisConversation] {
		t.Fatalf("OType_JarvisConversation not in ValidOTypes")
	}
}

func TestJarvisConvoRoundTrip(t *testing.T) {
	RegisterType(reflect.TypeOf(&JarvisConvo{}))
	convo := &JarvisConvo{
		OID:           "11111111-1111-1111-1111-111111111111",
		Title:         "why did we drop worktrees",
		ScopeMode:     "all",
		AttachedORefs: []string{"run:r1"},
		Turns: []JarvisConvoTurn{
			{Role: "user", Text: "why did we drop worktrees?", Attachments: []JarvisConvoSourceRef{{ORef: "run:r1", SourceType: "run", Title: "the run"}}},
			{Role: "jarvis", Prose: "We dropped them [1].", Terminal: "answered", Grounding: []JarvisConvoGroundingCard{
				{N: 1, SourceType: "run", Title: "the run", Project: "waveterm", AgeMs: 1000, Freshness: "fresh", NavTarget: "run:r1"},
			}},
		},
		CreatedTs: 5, UpdatedTs: 6,
		Meta: make(MetaMapType),
	}
	data, err := ToJson(convo)
	if err != nil {
		t.Fatalf("ToJson: %v", err)
	}
	back, err := FromJson(data)
	if err != nil {
		t.Fatalf("FromJson: %v", err)
	}
	got, ok := back.(*JarvisConvo)
	if !ok {
		t.Fatalf("FromJson returned %T, want *JarvisConvo", back)
	}
	if got.Title != "why did we drop worktrees" || len(got.Turns) != 2 {
		t.Fatalf("round-trip header/turns mismatch: %+v", got)
	}
	if got.Turns[0].Role != "user" || got.Turns[0].Text != "why did we drop worktrees?" || len(got.Turns[0].Attachments) != 1 {
		t.Fatalf("user turn mismatch: %+v", got.Turns[0])
	}
	if got.Turns[1].Role != "jarvis" || got.Turns[1].Prose != "We dropped them [1]." || got.Turns[1].Terminal != "answered" || len(got.Turns[1].Grounding) != 1 {
		t.Fatalf("jarvis turn mismatch: %+v", got.Turns[1])
	}
	if got.Turns[1].Grounding[0].NavTarget != "run:r1" {
		t.Fatalf("grounding mismatch: %+v", got.Turns[1].Grounding[0])
	}
}
