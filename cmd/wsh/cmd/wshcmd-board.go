// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var boardCmd = &cobra.Command{
	Use:   "board",
	Short: "Arc's boards: named drawings per project that a separate read-only scribe draws",
	Args:  cobra.NoArgs,
	RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var boardDrawCmd = &cobra.Command{
	Use:   "draw --board <name> [--ask \"<what to draw>\"]",
	Short: "have the scribe draw your latest turn on the named board in your project, created if none has that name",
	Args:  cobra.NoArgs,
	// cobra checks required flags only after PreRunE, so a missing --board is caught before the rpc setup
	PreRunE: func(cmd *cobra.Command, args []string) error {
		if err := cmd.ValidateRequiredFlags(); err != nil {
			return err
		}
		return preRunSetupRpcClient(cmd, args)
	},
	RunE: boardDrawRun,
}

func init() {
	boardDrawCmd.Flags().String("board", "", "the board's name (any case); a new board when none has it")
	boardDrawCmd.Flags().String("ask", "", "what to draw, in a few words")
	boardDrawCmd.MarkFlagRequired("board")
	boardCmd.AddCommand(boardDrawCmd)
	rootCmd.AddCommand(boardCmd)
}

func boardDrawRun(cmd *cobra.Command, args []string) error {
	board, _ := cmd.Flags().GetString("board")
	ask, _ := cmd.Flags().GetString("ask")
	oref, err := resolveBlockArg()
	if err != nil {
		return err
	}
	send := func(data wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error) {
		return wshclient.BoardAgentDrawCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	}
	line, err := boardDrawStart(oref.OID, board, ask, send)
	if err != nil {
		return err
	}
	fmt.Println(line)
	return nil
}

// boardDrawStart queues the draw and returns the line to print; it returns as soon as the pass is queued.
func boardDrawStart(blockId, board, ask string, send func(wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error)) (string, error) {
	board = strings.TrimSpace(board)
	if board == "" {
		return "", errors.New("pass the board's name with --board")
	}
	rtn, err := send(wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: board, Ask: ask})
	if err != nil {
		return "", err
	}
	line := fmt.Sprintf("drawing on %s in %s", rtn.BoardName, rtn.Project)
	if rtn.Created {
		line += ", a new board"
	}
	return line, nil
}
