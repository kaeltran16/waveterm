// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"testing"

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
