// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"

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

var agentMemoryProjectCwd string

func init() {
	agentMemoryProjectCmd.Flags().StringVar(&agentMemoryProjectCwd, "cwd", "", "")
	rootCmd.AddCommand(agentMemoryProjectCmd)
}

// agentMemoryProjectRun always returns nil on setup failure: outside WaveTerm there is no server
// to talk to, and a failed projection must never break the agent's turn.
func agentMemoryProjectRun(cmd *cobra.Command, args []string) error {
	if agentMemoryProjectCwd == "" {
		return nil
	}
	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return nil
	}
	if setupRpcClient(nil, jwt) != nil {
		return nil
	}
	return wshclient.MemoryProjectCommand(RpcClient, wshrpc.CommandMemoryProjectData{Cwd: agentMemoryProjectCwd}, &wshrpc.RpcOpts{Timeout: 15000})
}
