// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

const (
	// DistillGuardVar marks the headless distill sub-session so its own SessionEnd hook no-ops
	// instead of enqueuing itself.
	DistillGuardVar = "WAVETERM_MEMORY_DISTILL"
	// DistillSentinel is the stable leading text of the distill prompt. The Sessions scanner filters
	// any session whose first prompt starts with it, hiding the headless distill transcript.
	DistillSentinel = "You are distilling durable learnings from"

	combinedBudget = 400 * 1024 // ~150K tokens; at/above this, use the 1M-context model
	haikuModel     = "claude-haiku-4-5"
	sonnetModel    = "claude-sonnet-5"
	flushTimeout   = 110 * time.Second
)

const batchDistillPrompt = DistillSentinel + " multiple finished coding sessions from one project, " +
	"concatenated and separated by lines like '===== SESSION n ====='. Merge and dedup learnings across " +
	`them. Output ONLY a JSON object: {"candidates":[{"type","scope","body","iscorrection","supersedes"}],"references":[]}. ` +
	"type is one of: feedback | learning | project | reference. " +
	`Set iscorrection=true ONLY for an explicit correction the user gave ("no, do it this way"). ` +
	"supersedes: the slug of an existing memory this learning replaces, or omit. " +
	"references: slugs of existing memories the sessions clearly relied on. " +
	`Extract only durable, reusable learnings. If none, return {"candidates":[],"references":[]}.`

// BatchDistillPromptForTest exposes the batch prompt for cross-package drift tests.
func BatchDistillPromptForTest() string { return batchDistillPrompt }

// readTail returns the last maxBytes of path (whole file when smaller). Any error yields "".
func readTail(path string, maxBytes int64) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	start := int64(0)
	if st.Size() > maxBytes {
		start = st.Size() - maxBytes
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return ""
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return ""
	}
	return string(b)
}

// buildCorpus reads a capped tail of each session (combinedBudget split evenly) and joins them with
// labeled separators. The model is chosen on the assembled size, mirroring the single-session cutoff.
func buildCorpus(sessions []pendingSession) (string, string) {
	if len(sessions) == 0 {
		return "", haikuModel
	}
	perSession := int64(combinedBudget / len(sessions))
	var b strings.Builder
	for i, s := range sessions {
		fmt.Fprintf(&b, "\n\n===== SESSION %d (%s) =====\n\n", i+1, s.TranscriptPath)
		b.WriteString(readTail(s.TranscriptPath, perSession))
	}
	corpus := b.String()
	model := haikuModel
	if len(corpus) >= combinedBudget {
		model = sonnetModel
	}
	return corpus, model
}

type distillOutput struct {
	Candidates []struct {
		Type         string `json:"type"`
		Scope        string `json:"scope"`
		Body         string `json:"body"`
		IsCorrection bool   `json:"iscorrection"`
		Supersedes   string `json:"supersedes"`
	} `json:"candidates"`
	References []string `json:"references"`
}

// parseDistillOutput extracts the first {...} block and maps it to memvault candidates. ok is false
// on no-JSON / parse failure.
func parseDistillOutput(raw string) ([]memvault.LearnCandidate, []string, bool) {
	i := strings.IndexByte(raw, '{')
	j := strings.LastIndexByte(raw, '}')
	if i < 0 || j <= i {
		return nil, nil, false
	}
	var out distillOutput
	if json.Unmarshal([]byte(raw[i:j+1]), &out) != nil {
		return nil, nil, false
	}
	cands := make([]memvault.LearnCandidate, len(out.Candidates))
	for k, c := range out.Candidates {
		cands[k] = memvault.LearnCandidate{Type: c.Type, Scope: c.Scope, Body: c.Body, IsCorrection: c.IsCorrection, Supersedes: c.Supersedes}
	}
	return cands, out.References, true
}

// runDistill spawns the headless `claude -p` pass. claudePath falls back to "claude" on PATH.
func runDistill(claudePath, model, corpus string) (string, bool) {
	exe := claudePath
	if exe == "" {
		exe = "claude"
	}
	ctx, cancel := context.WithTimeout(context.Background(), flushTimeout)
	defer cancel()
	c := exec.CommandContext(ctx, exe, "-p", "--model", model, batchDistillPrompt)
	c.Stdin = strings.NewReader(corpus)
	c.Env = append(os.Environ(), DistillGuardVar+"=1")
	stdout, err := c.Output()
	if err != nil {
		log.Printf("[memdistill] distill exec failed (model %s): %v\n", model, err)
		return "", false
	}
	return string(stdout), true
}
