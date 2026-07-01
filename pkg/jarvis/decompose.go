// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	decomposeTimeout = 120 * time.Second
	maxSubtasks      = 5
)

// BuildDecomposePrompt asks for a JSON array of independent, parallelizable subtasks. If the goal is
// not safely splittable the model is told to return a single-element array (the whole goal).
func BuildDecomposePrompt(goal string, channel *waveobj.Channel) string {
	name := "this"
	if channel != nil && channel.Name != "" {
		name = channel.Name
	}
	return strings.Join([]string{
		fmt.Sprintf(`You are Jarvis, planning parallel work for coding agents in the "%s" channel.`, name),
		`Break the goal into 2 to 5 INDEPENDENT subtasks that can be implemented in parallel git worktrees without conflicting. Each subtask must be self-contained and worth its own worker. If the goal is small or not safely splittable, return a single-element array containing the whole goal.`,
		"",
		"Goal: " + goal,
		"",
		`Reply with ONLY a JSON array of short imperative subtask strings, no prose. Example: ["add the CouponInput component","wire discounts into cart totals","write coupon tests"].`,
	}, "\n")
}

// ParseDecompose extracts the JSON array from the reply, trims and drops blank entries, and caps at
// maxSubtasks. ANY problem — no array, bad JSON, or all-empty — falls back to a single dispatch of the
// whole goal, so Fan-out degrades to Manage rather than erroring.
func ParseDecompose(reply, goal string) []string {
	start := strings.Index(reply, "[")
	end := strings.LastIndex(reply, "]")
	if start < 0 || end <= start {
		return []string{goal}
	}
	var arr []string
	if err := json.Unmarshal([]byte(reply[start:end+1]), &arr); err != nil {
		return []string{goal}
	}
	var out []string
	for _, s := range arr {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
		if len(out) == maxSubtasks {
			break
		}
	}
	if len(out) == 0 {
		return []string{goal}
	}
	return out
}

// Decompose runs the headless claude planner. Fails safe to a single-element list on any CLI/timeout
// error (never blocks the dispatch).
func Decompose(ctx context.Context, projectPath, goal string, channel *waveobj.Channel) []string {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return []string{goal}
	}
	runCtx, cancel := context.WithTimeout(ctx, decomposeTimeout)
	defer cancel()
	reply, err := consult.Run(runCtx, spec, projectPath, BuildDecomposePrompt(goal, channel), func(string) {})
	if err != nil {
		return []string{goal}
	}
	return ParseDecompose(reply, goal)
}
