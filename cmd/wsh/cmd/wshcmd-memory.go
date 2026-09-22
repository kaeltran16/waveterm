// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var memoryCmd = &cobra.Command{
	Use:   "memory",
	Short: "inspect the Arc memory vault",
}

var memoryStatsCmd = &cobra.Command{
	Use:     "stats",
	Short:   "report memory utilization and what memory costs at session start",
	Args:    cobra.NoArgs,
	RunE:    memoryStatsRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	memoryCmd.AddCommand(memoryStatsCmd)
	rootCmd.AddCommand(memoryCmd)
}

func memoryStatsRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("memory-stats", rtnErr == nil)
	}()
	s, err := wshclient.MemoryStatsCommand(RpcClient, &wshrpc.RpcOpts{Timeout: 15000})
	if err != nil {
		return fmt.Errorf("reading memory stats: %w", err)
	}
	pct := 0.0
	if s.Total > 0 {
		pct = float64(s.Referenced) * 100 / float64(s.Total)
	}
	WriteStdout("Vault  %s\n", s.VaultPath)
	WriteStdout("Notes             %5d   machine %d   human %d\n", s.Total, s.Machine, s.Human)
	WriteStdout("Referenced        %5d (%.1f%%)   in window %d   total recalls %d\n",
		s.Referenced, pct, s.ReferencedRecently, s.TotalReferences)
	eligibility := fmt.Sprintf("archive-eligible %d", s.ArchiveEligible)
	if s.Epoch == "" {
		eligibility += " (no recall epoch recorded — nothing can be archived on absence)"
	} else {
		eligibility += fmt.Sprintf(" (epoch %s, matures %s)", s.Epoch, s.EpochMatures)
	}
	WriteStdout("Never referenced  %5d   %s\n", s.NeverReferenced, eligibility)
	WriteStdout("Injection/session (token counts are estimates at %d bytes/token)\n", s.BytesPerToken)
	for _, idx := range s.Indexes {
		status := "ok"
		if idx.OverBudget {
			status = fmt.Sprintf("OVER by %d", idx.OverBy)
		}
		WriteStdout("  MEMORY.md (%-24s) %8d B  ~%5d tok   budget %d B   %s\n",
			idx.Label, idx.Bytes, idx.Tokens, s.BudgetBytes, status)
	}
	WriteStdout("  total                            %8d B  ~%5d tok\n", s.TotalIndexBytes, s.TotalIndexTokens)
	return nil
}
