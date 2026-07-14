// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package tasksharpen rewrites a rough New-Agent task into a clearer, bounded instruction using a
// fast, headless, tool-less Claude call. It is deliberately isolated from Channels/Jarvis behavior:
// it reuses pkg/consult only as the generic one-shot process runner and adds pure prompt construction
// and response normalization on top. No repository access, no channel history, no session persistence.
package tasksharpen

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

const (
	// MaxSharpenTaskChars bounds both the input task and the rewritten output, in Unicode code points.
	MaxSharpenTaskChars = 4000

	// Model aliases kept in one place so a Claude alias change is a single edit. "fable" is the
	// currently-advertised small-model alias; "sonnet" is the stable mid alias.
	fastModel   = "fable"
	sonnetModel = "sonnet"
)

// resolveModel maps the request mode to a Claude model alias. Selection is internal and deterministic.
func resolveModel(mode string) (string, error) {
	switch mode {
	case "fast":
		return fastModel, nil
	case "sonnet":
		return sonnetModel, nil
	default:
		return "", fmt.Errorf("unsupported sharpen mode %q", mode)
	}
}

// supportedRuntime reports whether rt is a runtime the sharpener will accept as prompt context. The
// helper always runs Claude regardless; rt is descriptive only.
func supportedRuntime(rt string) bool {
	for _, r := range consult.SupportedRuntimes() {
		if r == rt {
			return true
		}
	}
	return false
}

// cloneClaudeSpec copies the shared Claude RuntimeSpec and appends sharpening-only arguments. It never
// mutates the shared value: consult.SpecFor returns a by-value copy whose BaseArgs slice still shares
// the map's backing array, so BaseArgs is copied before appending.
func cloneClaudeSpec(model string) (consult.RuntimeSpec, error) {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return consult.RuntimeSpec{}, errors.New("claude runtime spec unavailable")
	}
	args := append([]string{}, spec.BaseArgs...)
	// --tools "" blocks repository access and side effects; --no-session-persistence keeps helper
	// calls from appearing as resumable Sessions.
	args = append(args, "--model", model, "--tools", "", "--no-session-persistence")
	spec.BaseArgs = args
	return spec, nil
}

// claudeBaseArgsForTest exposes the shared Claude spec's args to package tests (to assert cloneClaudeSpec
// does not mutate the shared value). Not used by production code.
func claudeBaseArgsForTest() []string {
	spec, _ := consult.SpecFor("claude")
	return spec.BaseArgs
}

// buildPrompt is deterministic prompt construction. It includes only the original task, project name,
// and selected runtime — never a project path, channel history, or repository content.
func buildPrompt(task, projectname, runtime string) string {
	var b strings.Builder
	b.WriteString("You rewrite a rough coding-agent task into a clearer, bounded instruction.\n\n")
	b.WriteString("Rules:\n")
	b.WriteString("1. Preserve the original intent and every explicit constraint.\n")
	b.WriteString("2. Never invent files, technologies, deadlines, symptoms, or product requirements.\n")
	b.WriteString("3. When the input supports it, clarify the goal, the relevant boundaries, and the observable evidence that the task is complete.\n")
	b.WriteString("4. If the task is already clear, keep it mostly unchanged.\n")
	b.WriteString("5. Produce concise plain Markdown suitable for direct use as an agent task.\n")
	b.WriteString("6. Return only the rewritten task. No preamble, critique, alternatives, or code fence.\n")
	b.WriteString(fmt.Sprintf("7. Stay under %d characters.\n\n", MaxSharpenTaskChars))
	b.WriteString("Do not plan the implementation or infer repository facts.\n\n")
	if strings.TrimSpace(projectname) != "" {
		b.WriteString("Project: " + projectname + "\n")
	}
	b.WriteString("Target runtime: " + runtime + "\n\n")
	b.WriteString("Original task:\n")
	b.WriteString(task)
	b.WriteString("\n")
	return b.String()
}

// normalize trims surrounding whitespace and removes one accidental outer Markdown code fence. It does
// not rewrite, truncate, or reinterpret model text. Blank or oversized output is an error, not a
// partial task.
func normalize(raw string) (string, error) {
	out := strings.TrimSpace(unwrapFence(strings.TrimSpace(raw)))
	if out == "" {
		return "", errors.New("sharpen produced empty output")
	}
	if utf8.RuneCountInString(out) > MaxSharpenTaskChars {
		return "", fmt.Errorf("sharpen output exceeds %d characters", MaxSharpenTaskChars)
	}
	return out, nil
}

// unwrapFence removes a single outer ``` / ```lang fence wrapping the whole string, if present.
func unwrapFence(s string) string {
	if !strings.HasPrefix(s, "```") {
		return s
	}
	nl := strings.IndexByte(s, '\n')
	if nl < 0 {
		return s
	}
	rest := strings.TrimRight(s[nl+1:], " \t\r\n")
	if !strings.HasSuffix(rest, "```") {
		return s
	}
	return strings.TrimSpace(rest[:len(rest)-len("```")])
}

const (
	// SharpenTimeout bounds the CLI call.
	SharpenTimeout = 45 * time.Second
)

// Input is the sharpen request. Runtime and ProjectName are descriptive prompt context only; there is
// deliberately no project path (it is not needed for rewriting and would tempt a future repo scan).
type Input struct {
	Task        string
	ProjectName string
	Runtime     string
	Mode        string
}

// Result is the normalized rewrite plus the model alias used (for diagnostics / optional UI copy).
type Result struct {
	Task  string
	Model string
}

// runFn is the process-runner seam. Production uses consult.Run; tests override it so nothing shells
// out to claude.
var runFn = consult.Run

// Sharpen validates input, builds the prompt, clones the Claude spec with sharpening-only arguments,
// runs it with a bounded timeout and no project cwd, and normalizes the result. Validation errors and
// runner errors are returned without mutating any caller state.
func Sharpen(ctx context.Context, in Input) (Result, error) {
	task := strings.TrimSpace(in.Task)
	if task == "" {
		return Result{}, errors.New("task is blank")
	}
	if utf8.RuneCountInString(task) > MaxSharpenTaskChars {
		return Result{}, fmt.Errorf("task exceeds %d characters", MaxSharpenTaskChars)
	}
	if !supportedRuntime(in.Runtime) {
		return Result{}, fmt.Errorf("unsupported runtime %q", in.Runtime)
	}
	model, err := resolveModel(in.Mode)
	if err != nil {
		return Result{}, err
	}
	spec, err := cloneClaudeSpec(model)
	if err != nil {
		return Result{}, err
	}
	prompt := buildPrompt(task, in.ProjectName, in.Runtime)
	runCtx, cancel := context.WithTimeout(ctx, SharpenTimeout)
	defer cancel()
	// empty cwd: run without the selected project as the working directory.
	raw, err := runFn(runCtx, spec, "", prompt, func(string) {})
	if err != nil {
		return Result{}, fmt.Errorf("sharpen run: %w", err)
	}
	out, err := normalize(raw)
	if err != nil {
		return Result{}, err
	}
	return Result{Task: out, Model: model}, nil
}
