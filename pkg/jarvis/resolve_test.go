// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func ch(name string, enabled bool, msgs ...waveobj.ChannelMessage) *waveobj.Channel {
	meta := waveobj.MetaMapType{}
	if enabled {
		meta[MetaKey_GatekeeperEnabled] = true
	}
	return &waveobj.Channel{OID: name, Name: name, Meta: meta, Messages: msgs}
}
func dispatch(oref, text string) waveobj.ChannelMessage {
	return waveobj.ChannelMessage{Kind: "dispatch", Author: "claude", Text: text, RefORef: oref}
}

func TestResolve_EnabledOwner(t *testing.T) {
	c := ch("c1", true, dispatch("tab:t1", "harden webhooks"))
	got := ResolveGatekeeperChannel([]*waveobj.Channel{c}, "tab:t1")
	if got == nil || got.OID != "c1" {
		t.Fatalf("want c1, got %v", got)
	}
	if task := workerTaskFor(c, "tab:t1"); task != "harden webhooks" {
		t.Fatalf("want task, got %q", task)
	}
}

func TestResolve_NotEnabledIgnored(t *testing.T) {
	c := ch("c1", false, dispatch("tab:t1", "x"))
	if got := ResolveGatekeeperChannel([]*waveobj.Channel{c}, "tab:t1"); got != nil {
		t.Fatalf("want nil for disabled channel, got %v", got)
	}
}

func TestResolve_NoOwner(t *testing.T) {
	c := ch("c1", true, dispatch("tab:t1", "x"))
	if got := ResolveGatekeeperChannel([]*waveobj.Channel{c}, "tab:t2"); got != nil {
		t.Fatalf("want nil for unowned oref, got %v", got)
	}
}

// A tab oref (what a dispatch records) and an unparseable oref pass through channelOwnerORef
// unchanged — only a block oref triggers the DB block→tab walk (covered by the live E2E).
func TestChannelOwnerORef_Passthrough(t *testing.T) {
	if got := channelOwnerORef(context.Background(), "tab:t1"); got != "tab:t1" {
		t.Fatalf("tab oref should pass through, got %q", got)
	}
	if got := channelOwnerORef(context.Background(), "not-an-oref"); got != "not-an-oref" {
		t.Fatalf("unparseable oref should pass through, got %q", got)
	}
}
