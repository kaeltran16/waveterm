// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestJarvisAskSubcommandRetired(t *testing.T) {
	for _, c := range jarvisCmd.Commands() {
		if c.Name() == "ask" {
			t.Fatal("wsh jarvis ask is retired but still registered")
		}
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
	empty := renderCaptureStatus(wshrpc.CaptureStatus{NoteCounts: map[string]int{}})
	if !strings.Contains(empty, "unavailable") {
		t.Fatalf("empty render:\n%s\nwant unavailable notes", empty)
	}
	full := renderCaptureStatus(wshrpc.CaptureStatus{
		NoteCounts: map[string]int{"tasks": 14, "decisions": 4},
		Efforts:    wshrpc.CaptureEffortsStatus{Active: 2, ChunksDone: 3, ChunksTotal: 7},
	})
	for _, want := range []string{"tasks", "14", "2 active", "3 of 7 chunks"} {
		if !strings.Contains(full, want) {
			t.Fatalf("full render missing %q:\n%s", want, full)
		}
	}
	if strings.Contains(full, "embedding index") {
		t.Fatalf("status still reports the retired embedding index:\n%s", full)
	}
}
