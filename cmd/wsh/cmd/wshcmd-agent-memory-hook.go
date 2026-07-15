// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/memdistill"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// SessionEnd enqueue hook. Records the finished session for wavesrv's batch memory distiller and
// returns immediately. Fail-safe: any problem returns nil so a hook never breaks the agent's turn.

// sessionEndEvent is the subset of the SessionEnd hook stdin payload we use.
type sessionEndEvent struct {
	TranscriptPath string `json:"transcript_path"`
	Cwd            string `json:"cwd"`
}

var agentMemoryHookCmd = &cobra.Command{
	Use:                   "agent-memory-hook",
	Short:                 "Claude Code SessionEnd hook: enqueue the session for batch memory distillation",
	Args:                  cobra.NoArgs,
	RunE:                  agentMemoryHookRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
	SilenceErrors:         true,
	SilenceUsage:          true,
}

func init() {
	rootCmd.AddCommand(agentMemoryHookCmd)
}

// agentMemoryHookRun always returns nil: a hook must never break the agent's turn.
func agentMemoryHookRun(cmd *cobra.Command, args []string) error {
	if os.Getenv(memdistill.DistillGuardVar) != "" {
		return nil // we are the headless distillation sub-session; don't enqueue ourselves
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return nil
	}
	var ev sessionEndEvent
	if json.Unmarshal(raw, &ev) != nil || ev.TranscriptPath == "" {
		return nil
	}
	claudePath, _ := exec.LookPath("claude") // "" is fine; wavesrv falls back to PATH

	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return nil
	}
	if setupRpcClient(nil, jwt) != nil {
		return nil
	}
	_ = wshclient.MemoryEnqueueSessionCommand(RpcClient, wshrpc.CommandMemoryEnqueueSessionData{
		Cwd:            ev.Cwd,
		TranscriptPath: ev.TranscriptPath,
		ClaudePath:     claudePath,
	}, &wshrpc.RpcOpts{Timeout: 5000})
	return nil
}
