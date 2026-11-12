// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const boardTestBlock = "cccccccc-3333-4333-8333-333333333333"

func TestBoardDrawMissingBoardSendsNothing(t *testing.T) {
	sent := 0
	send := func(wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error) {
		sent++
		return &wshrpc.BoardAgentDrawRtnData{}, nil
	}
	for _, board := range []string{"", "   "} {
		if _, err := boardDrawStart(boardTestBlock, board, "the steps", send); err == nil {
			t.Errorf("board %q: no error", board)
		}
	}
	if sent != 0 {
		t.Errorf("sent %d requests with no board name", sent)
	}
}

func TestBoardDrawCmdMissingBoardFailsBeforeRpcSetup(t *testing.T) {
	err := boardDrawCmd.PreRunE(boardDrawCmd, nil)
	if err == nil || !strings.Contains(err.Error(), `"board"`) {
		t.Errorf("err = %v, want the missing --board error", err)
	}
}

func TestBoardDrawPrintsTheLine(t *testing.T) {
	cases := []struct {
		rtn  wshrpc.BoardAgentDrawRtnData
		want string
	}{
		{wshrpc.BoardAgentDrawRtnData{BoardId: "0123abcd", BoardName: "Auth flow", Project: "waveterm", Created: true}, "drawing on Auth flow in waveterm, a new board"},
		{wshrpc.BoardAgentDrawRtnData{BoardId: "0123abcd", BoardName: "Auth flow", Project: "waveterm"}, "drawing on Auth flow in waveterm"},
	}
	for _, c := range cases {
		var got []wshrpc.CommandBoardAgentDrawData
		send := func(d wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error) {
			got = append(got, d)
			rtn := c.rtn
			return &rtn, nil
		}
		line, err := boardDrawStart(boardTestBlock, " auth flow ", "the steps", send)
		if err != nil {
			t.Fatal(err)
		}
		if line != c.want {
			t.Errorf("line = %q, want %q", line, c.want)
		}
		want := wshrpc.CommandBoardAgentDrawData{BlockId: boardTestBlock, Board: "auth flow", Ask: "the steps"}
		if len(got) != 1 || got[0] != want {
			t.Errorf("sent %+v, want %+v", got, want)
		}
	}
}
