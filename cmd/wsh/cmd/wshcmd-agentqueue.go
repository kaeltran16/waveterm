// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// a report holds a handful of typed messages; the cap only keeps a runaway stdin from filling memory
const agentQueueMaxStdinBytes = 1 << 20

// wavesrv answers a report at once; a take-back waits on this one, so it must not be held up by a slow answer
const agentQueueSetTimeoutMs = 5000

var agentQueueCmd = &cobra.Command{
	Use:    "agentqueue",
	Short:  "the messages held for the agent in this block (the arc mod)",
	Hidden: true,
}

var agentQueueSetCmd = &cobra.Command{
	Use:                   "set",
	Short:                 "read the JSON report of the messages this agent's mod holds from stdin and keep it for this block",
	Args:                  cobra.NoArgs,
	PreRunE:               preRunSetupRpcClient,
	RunE:                  agentQueueSetRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
}

func init() {
	agentQueueCmd.AddCommand(agentQueueSetCmd)
	rootCmd.AddCommand(agentQueueCmd)
}

func agentQueueSetRun(cmd *cobra.Command, args []string) error {
	return agentQueueSet(os.Stdin, RpcContext.BlockId)
}

func agentQueueSet(r io.Reader, blockId string) error {
	// the queue belongs to the agent's block; a wsh run outside a block has no agent to attach it to
	if blockId == "" {
		return fmt.Errorf("agentqueue set needs a block: run it from an Arc terminal block")
	}
	report, err := readAgentQueueReport(r)
	if err != nil {
		return fmt.Errorf("agentqueue set for block %s: %w", blockId, err)
	}
	report.BlockId = blockId
	err = wshclient.SetAgentQueueCommand(RpcClient, report, &wshrpc.RpcOpts{Timeout: agentQueueSetTimeoutMs})
	if err != nil {
		return fmt.Errorf("agentqueue set for block %s: %w", blockId, err)
	}
	return nil
}

// readAgentQueueReport reads the JSON report (held, left, takeback) from r, refusing more than
// agentQueueMaxStdinBytes. BlockId is left for the caller: the report does not name its block.
func readAgentQueueReport(r io.Reader) (wshrpc.CommandSetAgentQueueData, error) {
	var report wshrpc.CommandSetAgentQueueData
	raw, err := io.ReadAll(io.LimitReader(r, agentQueueMaxStdinBytes+1))
	if err != nil {
		return report, fmt.Errorf("reading the queue report from stdin: %w", err)
	}
	if len(raw) > agentQueueMaxStdinBytes {
		return report, fmt.Errorf("the queue report on stdin is over %d bytes", agentQueueMaxStdinBytes)
	}
	if err := json.Unmarshal(raw, &report); err != nil {
		return report, fmt.Errorf("the queue report on stdin is not a JSON queue report: %w", err)
	}
	return report, nil
}
