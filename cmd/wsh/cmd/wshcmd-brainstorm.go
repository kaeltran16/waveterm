// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var brainstormCmd = &cobra.Command{
	Use:   "brainstorm",
	Short: "commands a brainstorming agent runs against its brainstorm.json",
	Args:  cobra.NoArgs,
	RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var brainstormCheckCmd = &cobra.Command{
	Use:   "check <brainstorm.json>",
	Short: "start the builder check: a one-shot reviewer reads the design and its questions come back as one line",
	Args:  cobra.ExactArgs(1),
	// runs after cobra has validated the arguments, so a missing path never reaches the RPC
	PreRunE: preRunSetupRpcClient,
	RunE:    brainstormCheckRun,
}

func init() {
	brainstormCmd.AddCommand(brainstormCheckCmd)
	rootCmd.AddCommand(brainstormCmd)
}

func brainstormCheckRun(cmd *cobra.Command, args []string) error {
	oref, err := resolveBlockArg()
	if err != nil {
		return err
	}
	send := func(data wshrpc.CommandBrainstormCheckData) error {
		return wshclient.BrainstormCheckCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	}
	if err := brainstormCheckStart(oref.OID, args[0], send); err != nil {
		return err
	}
	fmt.Println("builder check started")
	return nil
}

// brainstormCheckStart resolves the path to absolute (the server reads it from its own working directory) and
// hands it with the caller's block to send.
func brainstormCheckStart(blockId, file string, send func(wshrpc.CommandBrainstormCheckData) error) error {
	if file == "" {
		return fmt.Errorf("pass the path of the brainstorm.json")
	}
	abs, err := filepath.Abs(file)
	if err != nil {
		return fmt.Errorf("resolving %q: %w", file, err)
	}
	return send(wshrpc.CommandBrainstormCheckData{BlockId: blockId, File: abs})
}
