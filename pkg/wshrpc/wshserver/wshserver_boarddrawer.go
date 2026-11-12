// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

var errBoardDrawerNotWired = errors.New("boards: the drawer is not wired yet")

func (ws *WshServer) BoardStartCommand(ctx context.Context, data wshrpc.CommandBoardStartData) (*wshrpc.BoardInfo, error) {
	return nil, errBoardDrawerNotWired
}

func (ws *WshServer) BoardTalkCommand(ctx context.Context, data wshrpc.CommandBoardRefData) (*wshrpc.BoardTalk, error) {
	return nil, errBoardDrawerNotWired
}

func (ws *WshServer) BoardAskCommand(ctx context.Context, data wshrpc.CommandBoardAskData) error {
	return errBoardDrawerNotWired
}

func (ws *WshServer) BoardAskStopCommand(ctx context.Context, data wshrpc.CommandBoardRefData) error {
	return errBoardDrawerNotWired
}

func (ws *WshServer) BoardAskRetryCommand(ctx context.Context, data wshrpc.CommandBoardTurnData) error {
	return errBoardDrawerNotWired
}

func (ws *WshServer) BoardAskChoiceCommand(ctx context.Context, data wshrpc.CommandBoardChoiceData) error {
	return errBoardDrawerNotWired
}

func (ws *WshServer) BoardAnswerInboxCommand(ctx context.Context, data wshrpc.CommandBoardInboxData) ([]wshrpc.BoardAnswer, error) {
	return nil, errBoardDrawerNotWired
}

func (ws *WshServer) BoardAnswerAckCommand(ctx context.Context, data wshrpc.CommandBoardAnswerAckData) error {
	return errBoardDrawerNotWired
}
