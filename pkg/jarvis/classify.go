// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const classifyTimeout = 120 * time.Second
const maxTimeline = 12

// Decision is the classifier's structured verdict. OptionIndex is a pointer so a missing index in
// the model's reply is distinguishable from index 0 and fails safe to escalate.
type Decision struct {
	Action      string `json:"action"` // "answer" | "escalate"
	OptionIndex *int   `json:"optionindex"`
	Reason      string `json:"reason"`
}

// BuildClassifyPrompt composes a JSON-only prompt: the single question + its indexed options, the
// worker's task, and a capped recent timeline. The model must return {action, optionindex, reason}.
func BuildClassifyPrompt(q baseds.AgentAskQuestion, task string, channel *waveobj.Channel) string {
	var opts strings.Builder
	for i, o := range q.Options {
		opts.WriteString(fmt.Sprintf("  %d: %s", i, o.Label))
		if o.Description != "" {
			opts.WriteString(" — " + o.Description)
		}
		opts.WriteString("\n")
	}
	timeline := recentTimeline(channel)
	if task == "" {
		task = "(unknown task)"
	}
	return strings.Join([]string{
		fmt.Sprintf(`You are Jarvis, gatekeeping a coding agent in the "%s" channel. A worker paused to ask a multiple-choice question. Decide whether it is ROUTINE (safe to auto-answer on the human's behalf) or a genuine FORK that needs the human.`, channel.Name),
		`Escalate (do NOT answer) if the choice is irreversible, changes product scope or user-facing behavior, is a real judgment call, or you are not confident. When in doubt, escalate.`,
		"",
		"Worker task: " + task,
		"Question: " + q.Question,
		"Options (index: label):",
		strings.TrimRight(opts.String(), "\n"),
		"",
		"Recent channel messages:",
		timeline,
		"",
		`Reply with ONLY a JSON object, no prose: {"action":"answer"|"escalate","optionindex":<int, required when action is answer>,"reason":"<one short sentence>"}`,
	}, "\n")
}

func recentTimeline(channel *waveobj.Channel) string {
	if channel == nil || len(channel.Messages) == 0 {
		return "(none)"
	}
	msgs := channel.Messages
	if len(msgs) > maxTimeline {
		msgs = msgs[len(msgs)-maxTimeline:]
	}
	var b strings.Builder
	for _, m := range msgs {
		b.WriteString(m.Author + ": " + m.Text + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// ParseDecision extracts the JSON object from the reply and validates it. ANY problem — no JSON,
// bad JSON, unknown action, or action=="answer" without a numeric optionindex — yields escalate.
// The model can never fail open into an auto-answer.
func ParseDecision(reply string) Decision {
	start := strings.Index(reply, "{")
	end := strings.LastIndex(reply, "}")
	if start < 0 || end <= start {
		return Decision{Action: "escalate", Reason: "unparseable classifier reply"}
	}
	var d Decision
	if err := json.Unmarshal([]byte(reply[start:end+1]), &d); err != nil {
		return Decision{Action: "escalate", Reason: "unparseable classifier reply"}
	}
	if d.Action != "answer" {
		return Decision{Action: "escalate", Reason: d.Reason}
	}
	if d.OptionIndex == nil {
		return Decision{Action: "escalate", Reason: "classifier gave no option index"}
	}
	return d
}

// Classify runs the headless claude classifier. It fails safe to escalate on any CLI/timeout error.
func Classify(ctx context.Context, channel *waveobj.Channel, q baseds.AgentAskQuestion, task string) Decision {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return Decision{Action: "escalate", Reason: "claude CLI unavailable"}
	}
	runCtx, cancel := context.WithTimeout(ctx, classifyTimeout)
	defer cancel()
	reply, err := consult.Run(runCtx, spec, channel.ProjectPath, BuildClassifyPrompt(q, task, channel), func(string) {})
	if err != nil {
		return Decision{Action: "escalate", Reason: "classifier error: " + err.Error()}
	}
	return ParseDecision(reply)
}
