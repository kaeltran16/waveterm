// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Package consult runs a one-shot, headless CLI agent (claude -p / codex exec / agy -p) and returns
// its reply. It is the backend primitive behind the Channels "ask @runtime" gesture and the future
// orchestrator's review tool. This file holds the pure (process-free) parts: the per-runtime argv map
// and the capped-context prompt builder.

package consult

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	maxContextMessages = 20
	maxContextChars    = 4000
)

// RuntimeSpec is how to invoke a runtime in one-shot/print mode. PromptViaStdin true => pipe the
// prompt over stdin (preferred); false => append it as the final positional arg.
type RuntimeSpec struct {
	Bin            string
	BaseArgs       []string
	PromptViaStdin bool
}

// runtimeSpecs is keyed by the FE Runtime identifier. Note antigravity's binary is "agy", not
// "antigravity" (verified 2026-07-01; the latter does not resolve on PATH).
//
// Smoke test (2026-07-01, Task 1 Step 1): claude and codex both answer a stdin-piped prompt; agy -p
// rejects stdin (dumps help, exit 2) and requires the prompt as a positional arg, so it is the one
// runtime with PromptViaStdin=false.
var runtimeSpecs = map[string]RuntimeSpec{
	"claude":      {Bin: "claude", BaseArgs: []string{"-p"}, PromptViaStdin: true},
	"codex":       {Bin: "codex", BaseArgs: []string{"exec"}, PromptViaStdin: true},
	"antigravity": {Bin: "agy", BaseArgs: []string{"-p"}, PromptViaStdin: false},
}

func SpecFor(runtime string) (RuntimeSpec, bool) {
	s, ok := runtimeSpecs[runtime]
	return s, ok
}

func SupportedRuntimes() []string {
	return []string{"claude", "codex", "antigravity"}
}

// BuildPrompt folds a capped tail of channel history into the user's prompt as context. Returns the
// prompt verbatim when there is no usable history.
func BuildPrompt(history []waveobj.ChannelMessage, userPrompt string) string {
	start := 0
	if len(history) > maxContextMessages {
		start = len(history) - maxContextMessages
	}
	var b strings.Builder
	for _, m := range history[start:] {
		b.WriteString(m.Author)
		b.WriteString(": ")
		b.WriteString(m.Text)
		b.WriteByte('\n')
	}
	ctxStr := b.String()
	if len(ctxStr) > maxContextChars {
		ctxStr = ctxStr[len(ctxStr)-maxContextChars:]
		if i := strings.IndexByte(ctxStr, '\n'); i >= 0 {
			ctxStr = ctxStr[i+1:] // drop the partial leading line after slicing
		}
	}
	if strings.TrimSpace(ctxStr) == "" {
		return userPrompt
	}
	return "Recent channel conversation for context:\n" + ctxStr + "\nRequest:\n" + userPrompt
}
