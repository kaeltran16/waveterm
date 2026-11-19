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
		if _, err := boardDrawStart(boardTestBlock, board, "the briefing", "the steps", send); err == nil {
			t.Errorf("board %q: no error", board)
		}
	}
	for _, blank := range []string{"", "  "} {
		_, err := boardDrawStart(boardTestBlock, "Auth flow", blank, blank, send)
		if err == nil || !strings.Contains(err.Error(), "--ask") || !strings.Contains(err.Error(), "--context") {
			t.Errorf("blank %q: err = %v", blank, err)
		}
	}
	if sent != 0 {
		t.Errorf("sent %d requests with no board name, or neither --context nor --ask", sent)
	}
}

func TestBoardDrawAskAloneIsSent(t *testing.T) {
	var got []wshrpc.CommandBoardAgentDrawData
	send := func(d wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error) {
		got = append(got, d)
		return &wshrpc.BoardAgentDrawRtnData{BoardName: "Auth flow", Project: "waveterm"}, nil
	}
	if _, err := boardDrawStart(boardTestBlock, "Auth flow", " ", " add the retry path ", send); err != nil {
		t.Fatal(err)
	}
	want := wshrpc.CommandBoardAgentDrawData{BlockId: boardTestBlock, Board: "Auth flow", Ask: "add the retry path"}
	if len(got) != 1 || got[0] != want {
		t.Errorf("sent %+v, want %+v", got, want)
	}
}

func TestBoardDrawCmdMissingBoardFailsBeforeRpcSetup(t *testing.T) {
	err := boardDrawCmd.PreRunE(boardDrawCmd, nil)
	if err == nil || !strings.Contains(err.Error(), `"board"`) {
		t.Errorf("err = %v, want the missing --board error", err)
	}
}

func TestBoardDrawCmdNeitherContextNorAskFailsBeforeRpcSetup(t *testing.T) {
	flag := boardDrawCmd.Flags().Lookup("board")
	t.Cleanup(func() { flag.Value.Set(""); flag.Changed = false })
	if err := boardDrawCmd.Flags().Set("board", "Auth flow"); err != nil {
		t.Fatal(err)
	}
	err := boardDrawCmd.PreRunE(boardDrawCmd, nil)
	if err == nil || !strings.Contains(err.Error(), "--context") || !strings.Contains(err.Error(), "--ask") {
		t.Errorf("err = %v, want the neither --context nor --ask error", err)
	}
}

func TestBoardDrawPrintsTheLine(t *testing.T) {
	cases := []struct {
		rtn  wshrpc.BoardAgentDrawRtnData
		want string
	}{
		{wshrpc.BoardAgentDrawRtnData{BoardId: "0123abcd", BoardName: "Auth flow", Project: "waveterm", Created: true}, "the drawer has your briefing on Auth flow in waveterm, a new board"},
		{wshrpc.BoardAgentDrawRtnData{BoardId: "0123abcd", BoardName: "Auth flow", Project: "waveterm"}, "the drawer has your briefing on Auth flow in waveterm"},
	}
	for _, c := range cases {
		var got []wshrpc.CommandBoardAgentDrawData
		send := func(d wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error) {
			got = append(got, d)
			rtn := c.rtn
			return &rtn, nil
		}
		line, err := boardDrawStart(boardTestBlock, " auth flow ", " the briefing ", "the steps", send)
		if err != nil {
			t.Fatal(err)
		}
		if line != c.want {
			t.Errorf("line = %q, want %q", line, c.want)
		}
		want := wshrpc.CommandBoardAgentDrawData{BlockId: boardTestBlock, Board: "auth flow", Context: "the briefing", Ask: "the steps"}
		if len(got) != 1 || got[0] != want {
			t.Errorf("sent %+v, want %+v", got, want)
		}
	}
}
