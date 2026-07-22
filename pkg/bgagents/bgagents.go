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
	"os"
	"os/exec"
	"path/filepath"
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

// Remove deletes a background job's on-disk record (~/.claude/jobs/<dir>) so it stops appearing
// in `claude agents`. The Claude bg daemon can force-exit on idle without finalizing a job's
// state.json, leaving it frozen at a stale "blocked" checkpoint that re-appears forever; this is
// the user-driven cleanup for those. The session transcript under ~/.claude/projects/** is left
// intact, so resume/attach still work afterward.
func Remove(sessionId string) error {
	if sessionId == "" {
		return fmt.Errorf("sessionId is required")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolving home dir: %w", err)
	}
	return removeJobBySessionId(filepath.Join(home, ".claude", "jobs"), sessionId)
}

// removeJobBySessionId finds the job dir whose state.json sessionId matches and removes it.
// Matching by content (not by an assumed dir-naming scheme) confines deletion to real job dirs we
// enumerated ourselves — the caller's sessionId never becomes a path. Not-found is a no-op nil:
// the desired end state (no such record) already holds, so a double-dismiss won't error.
func removeJobBySessionId(jobsDir, sessionId string) error {
	entries, err := os.ReadDir(jobsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("reading jobs dir: %w", err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(jobsDir, e.Name(), "state.json"))
		if err != nil {
			continue // no/unreadable state.json => not a job dir we can match
		}
		var st struct {
			SessionId string `json:"sessionId"`
		}
		if err := json.Unmarshal(data, &st); err != nil {
			continue // malformed => skip, don't fail the whole op
		}
		if st.SessionId == sessionId {
			if err := os.RemoveAll(filepath.Join(jobsDir, e.Name())); err != nil {
				return fmt.Errorf("removing job dir %s: %w", e.Name(), err)
			}
			return nil
		}
	}
	return nil
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
