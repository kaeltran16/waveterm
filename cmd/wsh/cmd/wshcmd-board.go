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
	Short: "Arc's boards: named drawings per project, each a talk with a separate read-only drawer",
	Args:  cobra.NoArgs,
	RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var boardDrawCmd = &cobra.Command{
	Use:   "draw --board <name> --context \"<briefing>\" [--ask \"<question>\"]",
	Short: "brief the drawer of the named board in your project, created if none has that name",
	Args:  cobra.NoArgs,
	// cobra checks required flags only after PreRunE, so a missing --board or --context is caught before the rpc setup
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
	boardDrawCmd.Flags().String("context", "", "the briefing: what the user asked, the facts, and the files involved")
	boardDrawCmd.Flags().String("ask", "", "the question the drawer answers on the board")
	boardDrawCmd.MarkFlagRequired("board")
	boardDrawCmd.MarkFlagRequired("context")
	boardCmd.AddCommand(boardDrawCmd)
	rootCmd.AddCommand(boardCmd)
}

func boardDrawRun(cmd *cobra.Command, args []string) error {
	board, _ := cmd.Flags().GetString("board")
	brief, _ := cmd.Flags().GetString("context")
	ask, _ := cmd.Flags().GetString("ask")
	oref, err := resolveBlockArg()
	if err != nil {
		return err
	}
	send := func(data wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error) {
		return wshclient.BoardAgentDrawCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	}
	line, err := boardDrawStart(oref.OID, board, brief, ask, send)
	if err != nil {
		return err
	}
	fmt.Println(line)
	return nil
}

// boardDrawStart hands the briefing to the board's drawer and returns the line to print; it returns as soon as the
// turn is asked or queued.
func boardDrawStart(blockId, board, brief, ask string, send func(wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error)) (string, error) {
	board = strings.TrimSpace(board)
	if board == "" {
		return "", errors.New("pass the board's name with --board")
	}
	brief = strings.TrimSpace(brief)
	if brief == "" {
		return "", errors.New("pass the briefing with --context")
	}
	rtn, err := send(wshrpc.CommandBoardAgentDrawData{BlockId: blockId, Board: board, Context: brief, Ask: strings.TrimSpace(ask)})
	if err != nil {
		return "", err
	}
	line := fmt.Sprintf("the drawer has your briefing on %s in %s", rtn.BoardName, rtn.Project)
	if rtn.Created {
		line += ", a new board"
	}
	return line, nil
}
