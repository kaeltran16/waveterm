// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var notifyMessage string
var notifyLevel string

var notifyCmd = &cobra.Command{
	Use:     "notify [title]",
	Short:   "send a Wave notification (title required)",
	Args:    cobra.ExactArgs(1),
	RunE:    notifyRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	notifyCmd.Flags().StringVar(&notifyMessage, "message", "", "notification message body")
	notifyCmd.Flags().StringVar(&notifyLevel, "level", "", "notification level (info, warn, error)")
	rootCmd.AddCommand(notifyCmd)
}

func notifyDataFromArgs(title, message, level string) wshrpc.NotifyCommandData {
	return wshrpc.NotifyCommandData{Title: title, Message: message, Level: level}
}

func notifyRun(cmd *cobra.Command, args []string) error {
	err := wshclient.NotifyCommand(RpcClient, notifyDataFromArgs(args[0], notifyMessage, notifyLevel), &wshrpc.RpcOpts{Timeout: 5000})
	if err != nil {
		return fmt.Errorf("sending notification: %w", err)
	}
	WriteStdout("notification sent\n")
	return nil
}
