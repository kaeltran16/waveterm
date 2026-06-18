// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func mkPending(askId, blockId string) PendingAsk {
	return PendingAsk{
		AskId:     askId,
		BlockId:   blockId,
		Questions: []baseds.AgentAskQuestion{{Question: "pick"}},
	}
}

func TestSetThenGet(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:b1", mkPending("ask-1", "b1"))
	got, ok := r.Get("block:b1")
	if !ok {
		t.Fatalf("Get returned ok=false for a Set oref")
	}
	if got.AskId != "ask-1" || got.BlockId != "b1" {
		t.Fatalf("got %+v, want askId=ask-1 blockId=b1", got)
	}
}

func TestGetUnknownIsNotOk(t *testing.T) {
	r := MakeRegistry()
	if _, ok := r.Get("block:none"); ok {
		t.Fatalf("Get returned ok=true for an unknown oref")
	}
}

func TestDropRemoves(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:b2", mkPending("ask-2", "b2"))
	r.Drop("block:b2")
	if _, ok := r.Get("block:b2"); ok {
		t.Fatalf("Get returned ok=true after Drop")
	}
}

func TestSetOverwritesSameOref(t *testing.T) {
	r := MakeRegistry()
	r.Set("block:b3", mkPending("ask-old", "b3"))
	r.Set("block:b3", mkPending("ask-new", "b3"))
	got, _ := r.Get("block:b3")
	if got.AskId != "ask-new" {
		t.Fatalf("got askId %q, want ask-new", got.AskId)
	}
}
