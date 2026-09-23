// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// MaxToldLen bounds the text a task-told row keeps, in runes. What the human types to a worker is usually a line
// or two; a longer paste is cut, and the worker's own transcript still holds all of it.
const MaxToldLen = 1000

// toldSince returns what the human typed into a child's own session after since (a transcript time), oldest
// first. The session's first prompt is the one the engine launched it with. An answer to the child's question
// comes through the ask path as a picker choice, not a prompt; only a pi prose answer is typed, so it reads as one,
// and the caller skips it by asking agentask whether it typed that text.
func toldSince(run *waveobj.Run, since int64) []agentsessions.HumanPrompt {
	path, runtime, _ := transcriptForRun(run)
	if path == "" {
		return nil
	}
	prompts := agentsessions.HumanPrompts(path, runtime)
	if len(prompts) <= 1 {
		return nil
	}
	var out []agentsessions.HumanPrompt
	for _, p := range prompts[1:] {
		if p.Ts > since {
			out = append(out, p)
		}
	}
	return out
}

func toldText(s string) string {
	return clipRunes(s, MaxToldLen)
}

// clipRunes bounds s to n runes, marking a cut with an ellipsis.
func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
