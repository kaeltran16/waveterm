// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentobserve"
	"github.com/wavetermdev/waveterm/pkg/memdistill"
	"github.com/wavetermdev/waveterm/pkg/memgarden"
	"github.com/wavetermdev/waveterm/pkg/reporadar"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// liveHeadlessPrompts is every prompt the backend sends to `claude -p` itself, keyed by owner. The
// gardener and radar entries are the owning package's exported sentinel rather than its whole prompt:
// those prompts are concatenated from the sentinel, so the sentinel staying a prefix of the prompt is
// a compile-time fact and only the copy in headlessPromptSentinels can drift.
func liveHeadlessPrompts() map[string]string {
	return map[string]string{
		"memdistill batch distill": memdistill.BatchDistillPromptForTest(),
		"memgarden drift check":    memgarden.DriftSentinel,
		"memgarden dedup check":    memgarden.DedupSentinel,
		"reporadar synthesis":      reporadar.SynthSentinel,
	}
}

// Reword a prompt without updating its sentinel and the filter silently stops working — which is how
// the gardener's transcripts came to fill the Sessions list.
func TestHeadlessSentinelsMatchPrompts(t *testing.T) {
	for owner, prompt := range liveHeadlessPrompts() {
		if !isHeadlessPrompt(prompt) {
			t.Errorf("%s prompt matches no sentinel: %.60q", owner, prompt)
		}
	}
}

// The reverse direction: a sentinel left behind after its prompt is retired is dead weight that can
// silently start hiding a real session whose text happens to begin the same way.
func TestNoOrphanSentinels(t *testing.T) {
	for _, sentinel := range headlessPromptSentinels {
		matched := false
		for _, prompt := range liveHeadlessPrompts() {
			if strings.HasPrefix(prompt, sentinel) {
				matched = true
				break
			}
		}
		if !matched {
			t.Errorf("sentinel %q matches no live prompt", sentinel)
		}
	}
}

// The directory prune is the primary defense for runs written from now on; the sentinel list only
// covers the transcripts already on disk. The transcript planted in the headless dir here carries a
// human-looking prompt on purpose, so nothing but the directory skip can keep it out of the list.
func TestScanProvider_SkipsHeadlessDir(t *testing.T) {
	saved := wavebase.DataHome_VarCache
	wavebase.DataHome_VarCache = filepath.Join(t.TempDir(), "data")
	t.Cleanup(func() { wavebase.DataHome_VarCache = saved })

	slug := agentobserve.HeadlessAgentSlug()
	if slug == "" {
		t.Fatal("HeadlessAgentSlug is empty with a data home set")
	}
	root := t.TempDir()
	write := func(dir, task string) {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
		line := `{"type":"user","cwd":"/repo","message":{"content":"` + task + `"}}`
		if err := os.WriteFile(filepath.Join(root, dir, "s.jsonl"), []byte(line), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(slug, "fix the login bug")
	write("C--Users-x-repo", "add a retry")

	got := scanProvider(claudeProvider(root), 0, 0)
	if len(got) != 1 {
		t.Fatalf("expected only the real project's session, got %d: %+v", len(got), got)
	}
	if got[0].Task != "add a retry" {
		t.Errorf("wrong session survived: %q", got[0].Task)
	}
}

func TestExtractClaudeSession_DropsHeadlessSessions(t *testing.T) {
	for _, sentinel := range headlessPromptSentinels {
		line := `{"type":"user","cwd":"/repo","message":{"content":"` + sentinel + ` and the rest"}}`
		if s := extractClaudeSession("id1", []string{line}); s != nil {
			t.Errorf("headless session %.40q should be filtered out, got %+v", sentinel, s)
		}
	}
	normal := `{"type":"user","cwd":"/repo","message":{"content":"fix the login bug"}}`
	if s := extractClaudeSession("id2", []string{normal}); s == nil {
		t.Fatal("normal session should not be filtered")
	}
}
