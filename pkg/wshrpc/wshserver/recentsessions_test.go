// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func recentIds(sessions []wshrpc.SessionInfo) string {
	ids := make([]string, len(sessions))
	for i, s := range sessions {
		ids[i] = s.ID
	}
	return strings.Join(ids, ",")
}

// statGone fails for any path under C:/gone, as a landed run's cleaned-up tree does.
func statGone(path string) error {
	if strings.HasPrefix(path, "C:/gone") {
		return errors.New("not found")
	}
	return nil
}

func TestRecentSessionsKeepsOnlyResumableUserSessions(t *testing.T) {
	session := func(id, dir string) agentsessions.SessionInfo {
		return agentsessions.SessionInfo{ID: id, ProjectPath: dir, ResumeCommand: "claude --resume " + id}
	}
	// ids name the run role linkByRole gives them; "unlinked" is the user's own session
	sessions := []agentsessions.SessionInfo{
		session("worker", "C:/repo"),
		session("final-verifier", "C:/repo"),
		session("unlinked", "C:/gone/ba858902"),
		session("lead", "C:/repo"),
		session("unlinked", "C:/repo"),
		session("unlinked", ""),
	}
	check := agentsessions.NewDirCheck(statGone)
	got := recentIds(recentSessions(sessions, 5, check, linkByRole))
	if got != "lead,unlinked" {
		t.Fatalf("recent keeps the user's sessions that can resume, got %s", got)
	}
}

func TestRecentSessionsFillsTheLimitPastSkippedOnes(t *testing.T) {
	var sessions []agentsessions.SessionInfo
	for range 20 {
		sessions = append(sessions, agentsessions.SessionInfo{ID: "worker", ProjectPath: "C:/repo"})
	}
	for _, id := range []string{"lead", "unlinked", "lead"} {
		sessions = append(sessions, agentsessions.SessionInfo{ID: id, ProjectPath: "C:/repo"})
	}
	check := agentsessions.NewDirCheck(statGone)
	if got := recentIds(recentSessions(sessions, 2, check, linkByRole)); got != "lead,unlinked" {
		t.Fatalf("recent takes the newest 2 past the run's workers, got %s", got)
	}
}
