// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package bgagents lists Claude Code background/interactive agents by shelling out to
// `claude agents --json`. The listing schema is undocumented and system-wide, so Parse is
// deliberately tolerant: it reads known fields, defaults the rest, and skips (never fails on)
// a malformed element.
package bgagents

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"
)

const listTimeout = 5 * time.Second

// Agent is one normalized entry. State is `state` (background) or `status` (interactive).
type Agent struct {
	SessionId string
	Cwd       string
	Kind      string // "background" | "interactive"
	Name      string
	State     string
	StartedTs int64 // epoch ms
}

// rawAgent carries every field either record shape can emit; missing fields unmarshal to zero.
type rawAgent struct {
	SessionId string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	State     string `json:"state"`  // background
	Status    string `json:"status"` // interactive
	StartedAt int64  `json:"startedAt"`
}

// Parse normalizes the `claude agents --json` array. Elements with no sessionId are skipped.
func Parse(data []byte) ([]Agent, error) {
	var raws []rawAgent
	if err := json.Unmarshal(data, &raws); err != nil {
		return nil, fmt.Errorf("parsing claude agents json: %w", err)
	}
	out := make([]Agent, 0, len(raws))
	for _, r := range raws {
		if r.SessionId == "" {
			continue
		}
		state := r.State
		if state == "" {
			state = r.Status
		}
		out = append(out, Agent{
			SessionId: r.SessionId,
			Cwd:       r.Cwd,
			Kind:      r.Kind,
			Name:      r.Name,
			State:     state,
			StartedTs: r.StartedAt,
		})
	}
	return out, nil
}

// List runs `claude agents --json`. A missing `claude` binary yields (nil, nil): the machine
// simply has no background-agent support, which must not spam errors on every 10s poll.
func List(ctx context.Context) ([]Agent, error) {
	bin, err := exec.LookPath("claude")
	if err != nil {
		return nil, nil
	}
	cctx, cancel := context.WithTimeout(ctx, listTimeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, bin, "agents", "--json").Output()
	if err != nil {
		return nil, fmt.Errorf("running claude agents --json: %w", err)
	}
	return Parse(out)
}
