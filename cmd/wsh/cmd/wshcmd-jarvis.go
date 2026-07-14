// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var jarvisCmd = &cobra.Command{
	Use:   "jarvis",
	Short: "report run progress to Jarvis (used by an orchestrator lead)",
}

var jarvisHoldCmd = &cobra.Command{
	Use:   "hold [plan-file-path]",
	Short: "pause the current run at its plan gate for review",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		var artifacts []string
		if len(args) > 0 && args[0] != "" {
			artifacts = []string{args[0]} // the plan path the reviewer previews
		}
		return reportRunPhase(wshrpc.CommandReportRunPhaseData{Action: "hold", Artifacts: artifacts})
	},
	PreRunE: preRunSetupRpcClient,
}

var jarvisCompleteCmd = &cobra.Command{
	Use:   "complete [deliverable-path]",
	Short: "mark the current run's phase complete (optionally recording its deliverable)",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		var artifacts []string
		if len(args) > 0 && args[0] != "" {
			artifacts = []string{args[0]} // the deliverable path the next phase builds on / the gate previews
		}
		return reportRunPhase(wshrpc.CommandReportRunPhaseData{Action: "complete", Artifacts: artifacts})
	},
	PreRunE: preRunSetupRpcClient,
}

var jarvisTriageCmd = &cobra.Command{
	Use:     "triage <quick|plan> [reason]",
	Short:   "announce the adaptive lead's quick-vs-plan call for this run (non-blocking)",
	Args:    cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		note := ""
		if len(args) > 1 {
			note = args[1]
		}
		return reportRunPhase(wshrpc.CommandReportRunPhaseData{Action: "triage", Verdict: args[0], Note: note})
	},
	PreRunE: preRunSetupRpcClient,
}

func init() {
	jarvisCmd.AddCommand(jarvisHoldCmd)
	jarvisCmd.AddCommand(jarvisCompleteCmd)
	jarvisCmd.AddCommand(jarvisTriageCmd)
	rootCmd.AddCommand(jarvisCmd)
}

func reportRunPhase(data wshrpc.CommandReportRunPhaseData) error {
	tabId := getTabIdFromEnv()
	if tabId == "" {
		return fmt.Errorf("no WAVETERM_TABID env var set")
	}
	data.ORef = waveobj.MakeORef(waveobj.OType_Tab, tabId).String()
	return wshclient.ReportRunPhaseCommand(RpcClient, data, nil)
}
