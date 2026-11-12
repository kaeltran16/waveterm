// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardscribe

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

// PassTimeout bounds one scribe session.
const PassTimeout = 10 * time.Minute

// scribeTools is everything the scribe may load: read and search, no edits and no shell.
var scribeTools = []string{"Read", "Grep", "Glob"}

// RunModel runs one headless, read-only claude session in cwd and returns its reply; tests replace it.
var RunModel = func(ctx context.Context, cwd, prompt string) (string, error) {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return "", errors.New("the scribe needs the claude runtime, which has no spec")
	}
	ctx, cancel := context.WithTimeout(ctx, PassTimeout)
	defer cancel()
	spec, guard := readOnly(spec, cancel)
	reply, runErr := consult.Run(ctx, spec, cwd, prompt, func(string) {})
	if guard.failure != nil {
		return "", guard.failure
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "", fmt.Errorf("the scribe ran past its %s limit", PassTimeout)
	}
	if runErr != nil {
		return "", fmt.Errorf("the scribe session failed: %w", runErr)
	}
	if !guard.sawInit {
		// fail closed: with no init event the tool list was never checked
		return "", errors.New("the scribe session sent no init event, so its tools could not be checked")
	}
	return reply, nil
}

// toolGuard watches the session's stream for the init event and stops the session when it loaded any tool
// beyond scribeTools.
type toolGuard struct {
	cancel  context.CancelFunc
	sawInit bool
	failure error
}

func readOnly(spec consult.RuntimeSpec, cancel context.CancelFunc) (consult.RuntimeSpec, *toolGuard) {
	g := &toolGuard{cancel: cancel}
	// --strict-mcp-config: without it the account's connector tools load despite --tools
	spec.BaseArgs = append(append([]string{}, spec.BaseArgs...),
		"--model", "sonnet", "--tools", strings.Join(scribeTools, ","), "--strict-mcp-config")
	parse := spec.ParseLine
	spec.ParseLine = func(line []byte) consult.ParsedEvent {
		if err := g.check(line); err != nil {
			return consult.ParsedEvent{Err: err}
		}
		return parse(line)
	}
	return spec, g
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
		if !slices.Contains(scribeTools, t) {
			extra = append(extra, t)
		}
	}
	if len(extra) > 0 && g.failure == nil {
		g.failure = fmt.Errorf("the scribe session loaded tools beyond read and search (%s)", strings.Join(extra, ", "))
		// stop at once: a session that can write must not keep running
		g.cancel()
	}
	return g.failure
}
