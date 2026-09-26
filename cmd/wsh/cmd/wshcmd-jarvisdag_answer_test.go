// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func TestDagAnswerTimeoutCoversTheTypedText(t *testing.T) {
	if got := dagAnswerTimeoutMs([]baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}}); got != 10_000 {
		t.Fatalf("a picked option needs no typing time, got %d", got)
	}
	long := strings.Repeat("é", 800) // runes, not bytes, are typed
	if got := dagAnswerTimeoutMs([]baseds.AgentAnswerItem{{Text: long}}); got != 10_000+800*60*2 {
		t.Fatalf("800 typed characters, got %d", got)
	}
}
