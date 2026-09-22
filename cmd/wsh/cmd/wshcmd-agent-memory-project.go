// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// agentMemoryProjectCmd projects cwd's hub memory into the home-level steering files (codex /
// pi AGENTS.md) and the shared export + its index line in the hub's MEMORY.md. Called from the pi
// extension at session start so a pi session always runs with the current project's memory
// projected, and from Claude's SessionStart hook, which is the only automatic trigger claude has.
// Fail-safe like the memory hook: outside WaveTerm (no JWT) it no-ops.
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
	agentMemoryProjectCwd string
	// --inject used to emit a session-start manifest, which is gone: the shared export is reached
	// through the hub index instead. The flag stays registered and ignored because a settings.json
	// written by an older build still names it, and that file is only rewritten the next time
	// install-agent-hooks runs — rejecting the flag would hard-error every session start until then.
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
// The flag short-circuits the read: pi always passes it, and reading a terminal's stdin there would
// hang the session start we are supposed to be speeding along.
func resolveProjectCwd(flagCwd string, stdin io.Reader) string {
	if flagCwd != "" {
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
	cwd := resolveProjectCwd(agentMemoryProjectCwd, os.Stdin)
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
	return wshclient.MemoryProjectCommand(RpcClient, wshrpc.CommandMemoryProjectData{Cwd: cwd}, &wshrpc.RpcOpts{Timeout: 15000})
}
