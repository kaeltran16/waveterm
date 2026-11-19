// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"log"

	"github.com/wavetermdev/waveterm/pkg/boarddrawer"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

var errBoardRouteNotBuilt = errors.New("sending a board turn to its agent is not built yet")

// forwardBoardTurn is what the drawer calls once a turn is saved as forwarded. A var so tests can swap it.
var forwardBoardTurn = func(b boarddrawer.Board, turnId string) {
	log.Printf("board %s: turn %s was forwarded, but forwarding is not built yet\n", b.BoardId, turnId)
}

func (ws *WshServer) BoardRerouteCommand(ctx context.Context, data wshrpc.CommandBoardTurnData) error {
	return errBoardRouteNotBuilt
}

func (ws *WshServer) BoardSetAgentCommand(ctx context.Context, data wshrpc.CommandBoardSetAgentData) error {
	return errBoardRouteNotBuilt
}
