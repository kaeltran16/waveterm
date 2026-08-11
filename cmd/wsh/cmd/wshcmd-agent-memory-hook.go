// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"io"
	"os"

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

// agentMemoryHookFlags carry the session info when invoked by a non-Claude harness (the pi
// extension), which has no stdin contract. Empty when the Claude SessionEnd hook payload is used.
var (
	agentMemoryHookTranscript string
	agentMemoryHookCwd        string
)

var agentMemoryHookCmd = &cobra.Command{
	Use:                   "agent-memory-hook",
	Short:                 "enqueue a finished session for batch memory distillation",
	Args:                  cobra.NoArgs,
	RunE:                  agentMemoryHookRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
	SilenceErrors:         true,
	SilenceUsage:          true,
}

func init() {
	agentMemoryHookCmd.Flags().StringVar(&agentMemoryHookTranscript, "transcript", "", "")
	agentMemoryHookCmd.Flags().StringVar(&agentMemoryHookCwd, "cwd", "", "")
	rootCmd.AddCommand(agentMemoryHookCmd)
}

// agentMemoryHookRun always returns nil: a hook must never break the agent's turn.
func agentMemoryHookRun(cmd *cobra.Command, args []string) error {
	if os.Getenv(memdistill.DistillGuardVar) != "" {
		return nil // we are the headless distillation sub-session; don't enqueue ourselves
	}
	transcriptPath, cwd := agentMemoryHookTranscript, agentMemoryHookCwd
	if transcriptPath == "" {
		// stdin contract (Claude Code SessionEnd hook): read the JSON payload from stdin.
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			return nil
		}
		var ev sessionEndEvent
		if json.Unmarshal(raw, &ev) != nil || ev.TranscriptPath == "" {
			return nil
		}
		transcriptPath, cwd = ev.TranscriptPath, ev.Cwd
	}
	if transcriptPath == "" {
		return nil
	}

	jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
	if jwt == "" {
		return nil
	}
	if setupRpcClient(nil, jwt) != nil {
		return nil
	}
	_ = wshclient.MemoryEnqueueSessionCommand(RpcClient, wshrpc.CommandMemoryEnqueueSessionData{
		Cwd:            cwd,
		TranscriptPath: transcriptPath,
	}, &wshrpc.RpcOpts{Timeout: 5000})
	return nil
}
