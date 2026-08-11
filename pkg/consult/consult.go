// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Package consult runs a one-shot, headless CLI agent (claude -p / codex exec / agy -p) and returns
// its reply. It is the backend primitive behind the Channels "ask @runtime" gesture and the future
// orchestrator's review tool. This file holds the pure (process-free) parts: the per-runtime argv map
// and the capped-context prompt builder.

package consult

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	maxContextMessages = 20
	maxContextChars    = 4000
)

// apiBackend runs a model call over an HTTP API instead of a local CLI process.
type apiBackend interface {
	Run(ctx context.Context, spec RuntimeSpec, prompt string, emit func(string)) (string, error)
}

// ParsedEvent is one decoded JSONL event from a runtime's stream. Text carries reply text (empty for
// non-reply events), Complete marks a runtime's settlement/completion signal (pi agent_settled), and
// Err surfaces a runtime-reported assistant error. At most one of Text/Complete/Err is meaningful.
type ParsedEvent struct {
	Text     string
	Complete bool
	Err      error
}

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
	ParseLine      func(line []byte) ParsedEvent
	ApiBackend     apiBackend // if set, Run() calls the API instead of shelling out
	Model          string     // model id for API backends
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
	"opencode":    {Bin: "opencode", BaseArgs: []string{"run", "--format", "json"}, PromptViaStdin: false, ParseLine: opencodeParseLine},
	"pi":          {Bin: "pi", BaseArgs: []string{"--mode", "json", "--no-session", "--no-extensions"}, PromptViaStdin: false, ParseLine: piParseLine},
	"openrouter":  {ApiBackend: &openrouterBackend{}},
}

// codexParseLine extracts assistant text from a `codex exec --json` JSONL event. The reply arrives as
// item.completed events whose item.type is "agent_message"; reasoning/thread/turn events are skipped.
func codexParseLine(line []byte) ParsedEvent {
	var ev struct {
		Type string `json:"type"`
		Item struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"item"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return ParsedEvent{}
	}
	if ev.Type == "item.completed" && ev.Item.Type == "agent_message" && ev.Item.Text != "" {
		return ParsedEvent{Text: ev.Item.Text}
	}
	return ParsedEvent{}
}

// claudeParseLine extracts assistant text from a `claude -p --output-format stream-json` JSONL event.
// The reply arrives as assistant events carrying text content blocks; system/hook/init, rate-limit,
// and the redundant final result events are skipped (accumulating assistant text is the reply).
func claudeParseLine(line []byte) ParsedEvent {
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
		return ParsedEvent{}
	}
	if ev.Type != "assistant" {
		return ParsedEvent{}
	}
	var b strings.Builder
	for _, c := range ev.Message.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
		}
	}
	if b.Len() == 0 {
		return ParsedEvent{}
	}
	return ParsedEvent{Text: b.String()}
}

// opencodeParseLine extracts assistant text from an `opencode run --format json` JSONL event.
// Verified 2026-08-07: run --format json emits one event per line; assistant text arrives as a
// `text` event whose part.type is "text". step_start/step_finish/reasoning/tool events carry no
// reply text and are skipped. Streaming is incremental — each text event carries its own delta.
func opencodeParseLine(line []byte) ParsedEvent {
	var ev struct {
		Type string `json:"type"`
		Part struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"part"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return ParsedEvent{}
	}
	if ev.Type != "text" || ev.Part.Type != "text" {
		return ParsedEvent{}
	}
	if strings.TrimSpace(ev.Part.Text) == "" {
		return ParsedEvent{}
	}
	return ParsedEvent{Text: ev.Part.Text}
}

// piParseLine extracts Pi's stream from a `pi --mode json --no-session --no-extensions` session.
// Assistant text arrives in message_end events with text content blocks; the final agent_settled
// event marks completion, and a message_end with stopReason "error" carries the failure message.
func piParseLine(line []byte) ParsedEvent {
	var ev struct {
		Type    string `json:"type"`
		Message struct {
			Role         string `json:"role"`
			StopReason   string `json:"stopReason"`
			ErrorMessage string `json:"errorMessage"`
			Content      []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &ev); err != nil {
		return ParsedEvent{}
	}
	if ev.Type == "agent_settled" {
		return ParsedEvent{Complete: true}
	}
	if ev.Type != "message_end" || ev.Message.Role != "assistant" {
		return ParsedEvent{}
	}
	if ev.Message.StopReason == "error" {
		return ParsedEvent{Err: fmt.Errorf("Pi assistant error: %s", ev.Message.ErrorMessage)}
	}
	var text strings.Builder
	for _, block := range ev.Message.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	return ParsedEvent{Text: text.String()}
}

// SpecFor resolves a one-shot runtime spec, falling back to the shared harness catalog for the
// executable name. The OpenRouter entry is API-only and stays out of the catalog.
func SpecFor(runtime string) (RuntimeSpec, bool) {
	spec, ok := runtimeSpecs[runtime]
	if !ok {
		return RuntimeSpec{}, false
	}
	if h, found := harness.Lookup(runtime); found {
		spec.Bin = h.Bin
	}
	return spec, true
}

// Tier is the model class for a one-shot call, ordered by task difficulty: cheap for mechanical
// grunt work, mid for bounded work whose prose a human reads, capable for open-ended synthesis.
// TierCapable deliberately adds no --model flag — it keeps whatever default the operator configured
// for the CLI, which is exactly what every call did before tiering existed, so selecting it
// explicitly is a no-op rather than a downgrade.
type Tier string

const (
	TierCapable Tier = "capable"
	TierMid     Tier = "mid"
	TierCheap   Tier = "cheap"
)

// The claude aliases each tier selects. Exported so callers that need the alias itself rather than a
// tiered spec (reporadar builds its own --model args) share these definitions instead of re-hardcoding
// the strings.
const (
	// CheapModel is the cheap tier's alias. Haiku 4.5 is the cheapest current alias (~1/5 of Opus
	// per input token). Note "fable" is not a small model despite the naming — Claude Fable 5 prices
	// above Opus — so it is the wrong alias for a cost-driven tier.
	CheapModel = "haiku"
	// MidModel is the mid tier's alias: bounded, grounded work where a cheap model's mistakes would
	// be visible to the human reading the output, but the operator's default (Opus-class) is more
	// than the task needs.
	MidModel = "sonnet"
)

// modelForTier maps a tier to its claude --model alias. TierCapable maps to "" on purpose: passing
// no flag is what keeps the operator's configured default (see Tier).
func modelForTier(tier Tier) string {
	switch tier {
	case TierCheap:
		return CheapModel
	case TierMid:
		return MidModel
	default:
		return ""
	}
}

// SpecForTier resolves a runtime spec with the tier's model selection applied.
// For claude, it appends --model flags to BaseArgs.
// For openrouter, it sets spec.Model from the configured tier models.
// Other runtimes are returned unchanged.
func SpecForTier(runtime string, tier Tier) (RuntimeSpec, bool) {
	spec, ok := SpecFor(runtime)
	if !ok {
		return spec, false
	}
	if runtime == "openrouter" {
		switch tier {
		case TierCheap:
			spec.Model = OpenrouterCheapModel()
		case TierMid, TierCapable:
			spec.Model = OpenrouterMidModel()
		}
		return spec, true
	}
	model := modelForTier(tier)
	if model == "" || runtime != "claude" {
		return spec, ok
	}
	spec.BaseArgs = append(append([]string{}, spec.BaseArgs...), "--model", model)
	return spec, true
}

// Corpus-size model selection is a DIFFERENT AXIS from Tier: it picks a model for how much text has
// to fit in one prompt, not for how hard the task is. Callers that pipe a whole corpus over stdin
// (memory distillation, memory gardening) select with ModelForCorpus; every other caller picks a Tier.
// Keeping the two separate is the point — routing a window problem through the difficulty tiers would
// read as "big corpus means hard task", which is not what the escalation means.
//
// These pin dated model IDs rather than the floating haiku/sonnet aliases precisely because the
// choice encodes a context-window fact: Haiku 4.5 caps at a 200K-token window while Sonnet 5 holds
// 1M. An alias that later moved to a model with a different window would silently invalidate
// CorpusEscalationBytes, so the guarantee has to name the models it was measured against.
const (
	CorpusCheapModel = "claude-haiku-4-5"
	CorpusLongModel  = "claude-sonnet-5"
	// CorpusEscalationBytes is ~150K tokens: close enough to Haiku's 200K window that the prompt
	// plus the reply stop reliably fitting, so the long-context model takes over at or above it.
	CorpusEscalationBytes = 400 * 1024
)

// ModelForCorpus picks the model that can hold corpus. Escalation buys context window, not
// intelligence — see the constants above.
func ModelForCorpus(corpus string) string {
	if len(corpus) >= CorpusEscalationBytes {
		return CorpusLongModel
	}
	return CorpusCheapModel
}

// CorpusModel picks cheapModel or longModel based on whether corpus exceeds the escalation threshold.
// Callers using openrouter pass the configured model IDs; callers using claude pass CorpusCheapModel/
// CorpusLongModel. The threshold is the same for both.
func CorpusModel(cheapModel, longModel, corpus string) string {
	if len(corpus) >= CorpusEscalationBytes {
		return longModel
	}
	return cheapModel
}

// OperatorPrinciples returns the operator's global ~/.claude/CLAUDE.md, or "" if there is none. A
// missing file is normal (not every operator keeps global principles); only a real read error propagates.
func OperatorPrinciples() (string, error) {
	path := filepath.Join(wavebase.GetHomeDir(), ".claude", "CLAUDE.md")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// BuildPrompt folds a capped tail of channel history into the user's prompt as context, and — when
// principles is non-empty — prepends the operator's global principles verbatim (not capped: truncating
// a principles document mid-sentence would mislead the consulted agent).
func BuildPrompt(history []waveobj.ChannelMessage, userPrompt, principles string) string {
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
	var body string
	if strings.TrimSpace(ctxStr) == "" {
		body = userPrompt
	} else {
		body = "Recent channel conversation for context:\n" + ctxStr + "\nRequest:\n" + userPrompt
	}
	if strings.TrimSpace(principles) != "" {
		return "Operator principles (follow these):\n" + principles + "\n\n" + body
	}
	return body
}
