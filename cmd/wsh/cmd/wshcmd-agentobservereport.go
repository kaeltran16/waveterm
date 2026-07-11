// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/agentobserve"
)

// Offline analyzer for the hook-reliability pilot: folds the shadow comparison log + the hook debug
// log into the go/no-go verdict table. Reads files only; changes nothing.

var (
	reportShadow  string
	reportHookLog string
)

var agentObserveReportCmd = &cobra.Command{
	Use:                   "agent-observe-report",
	Short:                 "Pilot: analyze the shadow comparison log into the go/no-go metrics",
	Args:                  cobra.NoArgs,
	RunE:                  agentObserveReportRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
}

func init() {
	rootCmd.AddCommand(agentObserveReportCmd)
	home, _ := os.UserHomeDir()
	agentObserveReportCmd.Flags().StringVar(&reportShadow, "shadow", filepath.Join(home, ".claude", "arc-observe-shadow.log"), "path to the shadow comparison JSONL")
	agentObserveReportCmd.Flags().StringVar(&reportHookLog, "hook-log", filepath.Join(home, ".claude", "arc-hook-debug.log"), "path to the hook debug log")
}

func agentObserveReportRun(cmd *cobra.Command, args []string) error {
	shadow, err := os.ReadFile(reportShadow)
	if err != nil {
		return fmt.Errorf("reading shadow log: %w", err)
	}
	hook, _ := os.ReadFile(reportHookLog) // absent hook log is fine: every session then reads as a coverage gap
	rep := agentobserve.AnalyzeShadowLog(string(shadow), string(hook))
	fmt.Print(rep.Verdict())
	return nil
}
