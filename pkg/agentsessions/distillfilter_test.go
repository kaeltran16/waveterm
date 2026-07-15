// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/memdistill"
)

// drift guard: the local sentinel must stay a prefix of the live batch prompt.
func TestDistillSentinelMatchesPrompt(t *testing.T) {
	if !strings.HasPrefix(memdistill.BatchDistillPromptForTest(), distillSessionSentinel) {
		t.Fatalf("distillSessionSentinel %q is no longer a prefix of the batch prompt", distillSessionSentinel)
	}
}

func TestExtractClaudeSession_DropsDistillSession(t *testing.T) {
	line := `{"type":"user","cwd":"/repo","message":{"content":"` + distillSessionSentinel + ` blah blah"}}`
	if s := extractClaudeSession("id1", []string{line}); s != nil {
		t.Fatalf("distill session should be filtered out, got %+v", s)
	}
	normal := `{"type":"user","cwd":"/repo","message":{"content":"fix the login bug"}}`
	if s := extractClaudeSession("id2", []string{normal}); s == nil {
		t.Fatal("normal session should not be filtered")
	}
}
