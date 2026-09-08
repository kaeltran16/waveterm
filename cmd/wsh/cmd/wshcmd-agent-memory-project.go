// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// agentMemoryProjectCmd projects cwd's hub memory into the home-level steering files (codex /
// pi AGENTS.md). Called from the pi extension at session start so a pi
// session always runs with the current project's memory projected; the FE also triggers it at
// agent launch and from the manual sync button. Fail-safe like the memory hook: outside WaveTerm
// (no JWT) it no-ops.
var agentMemoryProjectCmd = &cobra.Command{
	Use:                   "agent-memory-project",
	Short:                 "project cwd's hub memory into the home-level steering files",
	Args:                  cobra.NoArgs,
	RunE:                  agentMemoryProjectRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
	SilenceErrors:         true,
	SilenceUsage:          true,
}

var (
	agentMemoryProjectCwd    string
	agentMemoryProjectInject bool
)

// sessionStartEvent is the subset of the SessionStart hook stdin payload we use. The pi extension
// passes --cwd instead; the Claude hook has no way to, so it supplies cwd on stdin like SessionEnd.
type sessionStartEvent struct {
	Cwd string `json:"cwd"`
}

func init() {
	agentMemoryProjectCmd.Flags().StringVar(&agentMemoryProjectCwd, "cwd", "", "")
	agentMemoryProjectCmd.Flags().BoolVar(&agentMemoryProjectInject, "inject", false, "")
	rootCmd.AddCommand(agentMemoryProjectCmd)
}

// resolveProjectCwd picks the cwd to project. The pi extension passes --cwd; the Claude SessionStart
// hook has no way to, so it supplies cwd on stdin exactly like SessionEnd does for agent-memory-hook.
// stdin is only read on the --inject path: the pi path always passes the flag, and reading a
// terminal's stdin there would hang the session start we are supposed to be speeding along.
func resolveProjectCwd(flagCwd string, inject bool, stdin io.Reader) string {
	if flagCwd != "" || !inject {
		return flagCwd
	}
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return ""
	}
	var ev sessionStartEvent
	if json.Unmarshal(raw, &ev) != nil {
		return ""
	}
	return ev.Cwd
}

// agentMemoryProjectRun always returns nil on setup failure: outside WaveTerm there is no server
// to talk to, and a failed projection must never break the agent's turn.
func agentMemoryProjectRun(cmd *cobra.Command, args []string) error {
	cwd := resolveProjectCwd(agentMemoryProjectCwd, agentMemoryProjectInject, os.Stdin)
	if cwd == "" {
		return nil
	}
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return nil
	}
	if setupRpcClient(nil, jwt) != nil {
		return nil
	}
	if !agentMemoryProjectInject {
		return wshclient.MemoryProjectCommand(RpcClient, wshrpc.CommandMemoryProjectData{Cwd: cwd}, &wshrpc.RpcOpts{Timeout: 15000})
	}
	manifest, err := wshclient.MemoryProjectManifestCommand(RpcClient, wshrpc.CommandMemoryProjectData{Cwd: cwd}, &wshrpc.RpcOpts{Timeout: 15000})
	if err != nil || strings.TrimSpace(manifest) == "" {
		return nil // fail-safe: a memory failure must never degrade session start
	}
	// claude code reads both additional_context and hookSpecificOutput without deduplication, so
	// exactly one of them may be emitted
	payload := map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":     "SessionStart",
			"additionalContext": manifest,
		},
	}
	out, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	fmt.Println(string(out))
	return nil
}
