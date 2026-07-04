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
	Use:     "hold",
	Short:   "pause the current run at its plan gate for review",
	RunE:    func(cmd *cobra.Command, args []string) error { return reportRunPhase("hold") },
	PreRunE: preRunSetupRpcClient,
}

var jarvisCompleteCmd = &cobra.Command{
	Use:     "complete",
	Short:   "mark the current run's phase complete",
	RunE:    func(cmd *cobra.Command, args []string) error { return reportRunPhase("complete") },
	PreRunE: preRunSetupRpcClient,
}

func init() {
	jarvisCmd.AddCommand(jarvisHoldCmd)
	jarvisCmd.AddCommand(jarvisCompleteCmd)
	rootCmd.AddCommand(jarvisCmd)
}

func reportRunPhase(action string) error {
	tabId := getTabIdFromEnv()
	if tabId == "" {
		return fmt.Errorf("no WAVETERM_TABID env var set")
	}
	oref := waveobj.MakeORef(waveobj.OType_Tab, tabId).String()
	return wshclient.ReportRunPhaseCommand(RpcClient, wshrpc.CommandReportRunPhaseData{ORef: oref, Action: action}, nil)
}
