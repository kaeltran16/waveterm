// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

var errBoardsNotImplemented = errors.New("boards: not implemented yet")

func (ws *WshServer) BoardListCommand(ctx context.Context, data wshrpc.CommandBoardListData) (*wshrpc.BoardListRtnData, error) {
	return nil, errBoardsNotImplemented
}

func (ws *WshServer) BoardCreateCommand(ctx context.Context, data wshrpc.CommandBoardCreateData) (*wshrpc.BoardInfo, error) {
	return nil, errBoardsNotImplemented
}

func (ws *WshServer) BoardReadCommand(ctx context.Context, data wshrpc.CommandBoardRefData) (*wshrpc.BoardReadRtnData, error) {
	return nil, errBoardsNotImplemented
}

func (ws *WshServer) BoardSaveCommand(ctx context.Context, data wshrpc.CommandBoardSaveData) (*wshrpc.BoardSaveRtnData, error) {
	return nil, errBoardsNotImplemented
}

func (ws *WshServer) BoardDrawCommand(ctx context.Context, data wshrpc.CommandBoardDrawData) error {
	return errBoardsNotImplemented
}

func (ws *WshServer) BoardAgentDrawCommand(ctx context.Context, data wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error) {
	return nil, errBoardsNotImplemented
}

func (ws *WshServer) BoardRetryCommand(ctx context.Context, data wshrpc.CommandBoardSourceData) error {
	return errBoardsNotImplemented
}

func (ws *WshServer) BoardFollowStopCommand(ctx context.Context, data wshrpc.CommandBoardFollowStopData) error {
	return errBoardsNotImplemented
}

func (ws *WshServer) BoardStatusCommand(ctx context.Context, data wshrpc.CommandBoardRefData) (*wshrpc.BoardStatusData, error) {
	return nil, errBoardsNotImplemented
}

func (ws *WshServer) BoardInboxCommand(ctx context.Context, data wshrpc.CommandBoardInboxData) ([]wshrpc.BoardDraw, error) {
	return nil, errBoardsNotImplemented
}

func (ws *WshServer) BoardInboxAckCommand(ctx context.Context, data wshrpc.CommandBoardInboxAckData) error {
	return errBoardsNotImplemented
}
