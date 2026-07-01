// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Package consult runs a one-shot, headless CLI agent (claude -p / codex exec / agy -p) and returns
// its reply. It is the backend primitive behind the Channels "ask @runtime" gesture and the future
// orchestrator's review tool. This file holds the pure (process-free) parts: the per-runtime argv map
// and the capped-context prompt builder.

package consult

import (
	"encoding/json"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	maxContextMessages = 20
	maxContextChars    = 4000
)

// RuntimeSpec is how to invoke a runtime in one-shot/print mode.
//
// Output handling (see Run in exec.go):
//   - ParseLine != nil => the CLI emits JSONL events on stdout; scan line-by-line and emit the text
//     each reply event carries. This is real incremental streaming (claude stream-json, codex --json).
//   - UsePty => the CLI only renders to a terminal and drops stdout under a pipe/subprocess. Spawn it
//     under a pty and clean the TUI stream. This is the agy non-TTY workaround (antigravity-cli#76).
//   - neither => read raw stdout chunks verbatim (used by tests / plain tools).
//
// PromptViaStdin true => pipe the prompt over stdin; false => append it as the final positional arg.
// pty mode cannot easily feed stdin, so pty runtimes pass the prompt positionally.
type RuntimeSpec struct {
	Bin            string
	BaseArgs       []string
	PromptViaStdin bool
	UsePty         bool
	ParseLine      func(line []byte) (text string, isReply bool)
}

// runtimeSpecs is keyed by the FE Runtime identifier. Note antigravity's binary is "agy", not
// "antigravity" (verified 2026-07-01; the latter does not resolve on PATH).
//
// Why each streams the way it does (verified 2026-07-01 by reproducing the exact invocations):
//   - claude/codex plain modes write progress to stderr and only the final answer to stdout at the
//     very end — no incremental streaming. Their JSONL modes (--output-format stream-json / --json)
//     emit structured reply events on stdout as they go, so we parse those.
//   - agy has a known upstream bug (antigravity-cli#76): --print silently drops stdout under any
//     non-TTY. The only capture path is a pty, so agy runs under one and its prompt is positional
//     (its -p flag takes the prompt as its argument value).
var runtimeSpecs = map[string]RuntimeSpec{
	"claude":      {Bin: "claude", BaseArgs: []string{"-p", "--output-format", "stream-json", "--verbose"}, PromptViaStdin: true, ParseLine: claudeParseLine},
	"codex":       {Bin: "codex", BaseArgs: []string{"exec", "--json"}, PromptViaStdin: true, ParseLine: codexParseLine},
	"antigravity": {Bin: "agy", BaseArgs: []string{"-p"}, PromptViaStdin: false, UsePty: true},
}

// codexParseLine extracts assistant text from a `codex exec --json` JSONL event. The reply arrives as
// item.completed events whose item.type is "agent_message"; reasoning/thread/turn events are skipped.
func codexParseLine(line []byte) (string, bool) {
	var ev struct {
		Type string `json:"type"`
		Item struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"item"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return "", false
	}
	if ev.Type == "item.completed" && ev.Item.Type == "agent_message" && ev.Item.Text != "" {
		return ev.Item.Text, true
	}
	return "", false
}

// claudeParseLine extracts assistant text from a `claude -p --output-format stream-json` JSONL event.
// The reply arrives as assistant events carrying text content blocks; system/hook/init, rate-limit,
// and the redundant final result events are skipped (accumulating assistant text is the reply).
func claudeParseLine(line []byte) (string, bool) {
	var ev struct {
		Type    string `json:"type"`
		Message struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return "", false
	}
	if ev.Type != "assistant" {
		return "", false
	}
	var b strings.Builder
	for _, c := range ev.Message.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
		}
	}
	if b.Len() == 0 {
		return "", false
	}
	return b.String(), true
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
