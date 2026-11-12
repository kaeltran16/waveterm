// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boarddrawer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

// TurnTimeout bounds one drawer session run.
const TurnTimeout = 10 * time.Minute

// persistSessionsEnv: a wavesrv started from an agent terminal can inherit the child-session marker that stops
// claude from saving sessions, and then every --resume would fail.
const persistSessionsEnv = "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1"

// drawerTools is everything the drawer may load: read and search, no edits and no shell.
var drawerTools = []string{"Read", "Grep", "Glob"}

// Call is one run of a board's drawer session.
type Call struct {
	SessionId string
	Resume    bool // --resume SessionId, else --session-id SessionId
	Fork      bool // with Resume: --fork-session (the handoff summary leaves SessionId as it was)
	Prompt    string
}

// RunModel runs one headless, read-only claude session in cwd and returns its reply; tests replace it.
var RunModel = func(ctx context.Context, cwd string, c Call) (string, error) {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return "", errors.New("the drawer needs the claude runtime, which has no spec")
	}
	ctx, cancel := context.WithTimeout(ctx, TurnTimeout)
	defer cancel()
	spec, guard := drawerSpec(spec, c, cancel)
	reply, runErr := consult.Run(ctx, spec, cwd, c.Prompt, func(string) {})
	if guard.failure != nil {
		return "", guard.failure
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "", errors.New("the drawer ran past its 10 minutes")
	}
	if runErr != nil {
		return "", fmt.Errorf("the drawer's session exited before it replied (%v)", runErr)
	}
	if !guard.sawInit {
		// fail closed: with no init event the tool list was never checked
		return "", errors.New("the drawer session sent no init event, so its tools could not be checked")
	}
	return reply, nil
}

// drawerSpec makes spec read-only and points it at c's session.
func drawerSpec(spec consult.RuntimeSpec, c Call, cancel context.CancelFunc) (consult.RuntimeSpec, *toolGuard) {
	g := &toolGuard{cancel: cancel}
	// --strict-mcp-config: without it the account's connector tools load despite --tools
	args := append(append([]string{}, spec.BaseArgs...),
		"--model", "sonnet", "--tools", strings.Join(drawerTools, ","), "--strict-mcp-config")
	if c.Resume {
		args = append(args, "--resume", c.SessionId)
		if c.Fork {
			args = append(args, "--fork-session")
		}
	} else {
		args = append(args, "--session-id", c.SessionId)
	}
	spec.BaseArgs = args
	spec.Env = append(append([]string{}, spec.Env...), persistSessionsEnv)
	parse := spec.ParseLine
	spec.ParseLine = func(line []byte) consult.ParsedEvent {
		if err := g.check(line); err != nil {
			return consult.ParsedEvent{Err: err}
		}
		return parse(line)
	}
	return spec, g
}

// toolGuard watches the session's stream for the init event and stops the session when it loaded any tool
// beyond drawerTools.
type toolGuard struct {
	cancel  context.CancelFunc
	sawInit bool
	failure error
}

func (g *toolGuard) check(line []byte) error {
	var ev struct {
		Type    string   `json:"type"`
		Subtype string   `json:"subtype"`
		Tools   []string `json:"tools"`
	}
	if json.Unmarshal(line, &ev) != nil || ev.Type != "system" || ev.Subtype != "init" {
		return g.failure
	}
	g.sawInit = true
	var extra []string
	for _, t := range ev.Tools {
		if !slices.Contains(drawerTools, t) {
			extra = append(extra, t)
		}
	}
	if len(extra) > 0 && g.failure == nil {
		g.failure = fmt.Errorf("the drawer session loaded tools beyond read and search (%s)", strings.Join(extra, ", "))
		// stop at once: a session that can write must not keep running
		g.cancel()
	}
	return g.failure
}
