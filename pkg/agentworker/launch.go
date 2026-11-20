// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentworker runs the workers an agent starts with `wsh agents start`: ordinary claude or pi agents
// in their own tabs, nested under the agent that started them.
package agentworker

import (
	"fmt"
	"slices"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// SessionOptions are Arc's own worker flags. There is deliberately no raw-argument pass-through: a flag like
// claude's --bare or pi's --no-extensions would drop the hooks and extensions that keep a worker visible.
type SessionOptions struct {
	Harness, Model, Reasoning, SystemPrompt, AppendSystemPrompt, Tools, PermissionMode string
}

// Parent holds the facts read from the parent's latest agent status.
type Parent struct {
	Harness, Model, PermissionMode string
}

// Launch is a worker's executable and its launch flags. BaseArgs holds no session id and no prompt, so a
// resume can recompose `<bin> --resume <id> <BaseArgs> <prompt>`.
type Launch struct {
	Harness, Bin string
	BaseArgs     []string
}

// maxSystemPromptBytes mirrors jarvis's inline prompt cap: system prompts ride the command line on every
// start and resume, and half the Windows command-line limit always fits.
const maxSystemPromptBytes = 16 * 1024

// the option names as `wsh agents start` spells them, used in refusals
const (
	optReasoning          = "--reasoning"
	optSystemPrompt       = "--system-prompt"
	optAppendSystemPrompt = "--append-system-prompt"
	optTools              = "--tools"
	optPermissionMode     = "--permission-mode"
)

// harnessFlags maps each option to the harness's own flag, as its --help prints it. An option missing for a
// harness is refused rather than dropped.
var harnessFlags = map[string]map[string]string{
	"claude": {
		optReasoning:          "--effort",
		optSystemPrompt:       "--system-prompt",
		optAppendSystemPrompt: "--append-system-prompt",
		optTools:              "--tools",
		optPermissionMode:     "--permission-mode",
	},
	"pi": {
		optReasoning:          "--thinking",
		optSystemPrompt:       "--system-prompt",
		optAppendSystemPrompt: "--append-system-prompt",
		optTools:              "--tools",
	},
}

const (
	defaultPermissionMode = "default"
	// pi asks no permission, so a pi parent may hand a worker any mode
	piParentPermissionMode = "bypassPermissions"
)

// permissionRung orders claude's permission modes from strictest to loosest. manual is the name newer claude
// versions give the default mode.
var permissionRung = map[string]int{
	"plan":              0,
	"dontAsk":           1,
	"default":           2,
	"manual":            2,
	"acceptEdits":       3,
	"auto":              4,
	"bypassPermissions": 5,
}

// ComposeLaunch builds a worker's launch from its options, defaulting the harness, model and permission mode
// to the parent's.
func ComposeLaunch(opts SessionOptions, parent Parent) (Launch, error) {
	runtime := opts.Harness
	if runtime == "" {
		runtime = parent.Harness
	}
	if runtime == "" {
		return Launch{}, fmt.Errorf("no harness given and the parent reports none: pass --harness claude or pi")
	}
	spec, ok := harness.Lookup(runtime)
	if !ok || !spec.RunWorkerCapable || harnessFlags[runtime] == nil {
		return Launch{}, fmt.Errorf("harness %q cannot run a worker: use claude or pi", runtime)
	}
	if size := len(opts.SystemPrompt) + len(opts.AppendSystemPrompt); size > maxSystemPromptBytes {
		return Launch{}, fmt.Errorf("the system prompt and appended system prompt are %d bytes together, over the %d-byte cap", size, maxSystemPromptBytes)
	}
	modelArgs, err := resolveModel(runtime, opts.Model, parent)
	if err != nil {
		return Launch{}, err
	}
	permissionMode, err := resolvePermissionMode(runtime, opts.PermissionMode, parent)
	if err != nil {
		return Launch{}, err
	}

	var args []string
	add := func(option, value string) error {
		if value == "" {
			return nil
		}
		flag, ok := harnessFlags[runtime][option]
		if !ok {
			return fmt.Errorf("%s has no flag for %s", runtime, option)
		}
		args = append(args, flag, value)
		return nil
	}
	// --tools goes first: claude reads it variadically, so a flag must follow it, never the prompt. A claude
	// worker always carries --permission-mode, which goes last.
	if err := add(optTools, opts.Tools); err != nil {
		return Launch{}, err
	}
	args = append(args, modelArgs...)
	for _, o := range [][2]string{
		{optReasoning, opts.Reasoning},
		{optSystemPrompt, opts.SystemPrompt},
		{optAppendSystemPrompt, opts.AppendSystemPrompt},
		{optPermissionMode, permissionMode},
	} {
		if err := add(o[0], o[1]); err != nil {
			return Launch{}, err
		}
	}
	return Launch{Harness: runtime, Bin: spec.Bin, BaseArgs: args}, nil
}

// resolveModel is the model flags: an explicit model must resolve; otherwise a worker on its parent's harness
// takes the parent's model when it resolves, and the harness default when not.
func resolveModel(runtime, model string, parent Parent) ([]string, error) {
	if model != "" {
		cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: runtime, Model: model})
		if err != nil {
			return nil, err
		}
		return cap.ModelArgs, nil
	}
	if runtime == parent.Harness && parent.Model != "" {
		if cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: runtime, Model: parent.Model}); err == nil {
			return cap.ModelArgs, nil
		}
	}
	return nil, nil
}

// resolvePermissionMode is the mode a worker starts in: the parent's rung unless a stricter one is named.
// A pi worker takes none, since pi has no permission modes; one named is refused by the flag lookup.
func resolvePermissionMode(runtime, mode string, parent Parent) (string, error) {
	if mode != "" {
		if _, ok := permissionRung[mode]; !ok {
			return "", fmt.Errorf("unknown permission mode %q: use one of %s", mode, permissionModeNames())
		}
	}
	if runtime != "claude" {
		return mode, nil
	}
	parentMode := parent.PermissionMode
	if parent.Harness == "pi" {
		parentMode = piParentPermissionMode
	} else if parentMode == "" {
		parentMode = defaultPermissionMode
	}
	parentRung, ok := permissionRung[parentMode]
	if !ok {
		return "", fmt.Errorf("the parent reports an unknown permission mode %q", parentMode)
	}
	if mode == "" {
		return parentMode, nil
	}
	if permissionRung[mode] > parentRung {
		return "", fmt.Errorf("permission mode %q is looser than the parent's %q: a worker may only be as strict or stricter", mode, parentMode)
	}
	return mode, nil
}

func permissionModeNames() string {
	names := make([]string, 0, len(permissionRung))
	for name := range permissionRung {
		names = append(names, name)
	}
	slices.SortFunc(names, func(a, b string) int {
		if d := permissionRung[a] - permissionRung[b]; d != 0 {
			return d
		}
		return strings.Compare(a, b)
	})
	return strings.Join(names, ", ")
}

// FirstStartArgs is the first start's command line: the launch flags, the session id, then the prompt.
func FirstStartArgs(l Launch, sessionId, prompt string) []string {
	args := append([]string{}, l.BaseArgs...)
	if sessionId != "" {
		args = append(args, "--session-id", sessionId)
	}
	return append(args, prompt)
}
