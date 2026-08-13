// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestJarvisAskSubcommandRegistered(t *testing.T) {
	var found bool
	for _, c := range jarvisCmd.Commands() {
		if c.Name() == "ask" {
			found = true
		}
	}
	if !found {
		t.Fatal("`jarvis ask` subcommand is not registered")
	}
}

func TestJarvisStatusSubcommandRegistered(t *testing.T) {
	var found bool
	for _, c := range jarvisCmd.Commands() {
		if c.Name() == "status" {
			found = true
		}
	}
	if !found {
		t.Fatal("`jarvis status` subcommand is not registered")
	}
}

func TestRenderCaptureStatusDegradesPerSection(t *testing.T) {
	empty := renderCaptureStatus(wshrpc.CaptureStatus{NoteCounts: map[string]int{}, DistillQueue: []wshrpc.CwdQueueWire{}})
	if !strings.Contains(empty, "unavailable") || !strings.Contains(empty, "(empty)") {
		t.Fatalf("empty render:\n%s\nwant unavailable + empty queue", empty)
	}
	full := renderCaptureStatus(wshrpc.CaptureStatus{
		NoteCounts:     map[string]int{"memory": 406, "tasks": 14, "decisions": 4},
		IndexAvailable: true,
		DistillQueue: []wshrpc.CwdQueueWire{{
			Cwd: "/p", Pending: 2,
			LastPass: &wshrpc.PassRecordWire{Ts: 1786500000000, Sessions: 3, Committed: 1, Queued: 2},
		}},
	})
	for _, want := range []string{"memory", "406", "available", "/p: 2 pending", "3 sessions, 1 committed, 2 queued"} {
		if !strings.Contains(full, want) {
			t.Fatalf("full render missing %q:\n%s", want, full)
		}
	}
}
