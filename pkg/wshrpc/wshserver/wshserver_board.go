// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/boardstore"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// boardState is the list row's live state: "answering" while the drawer runs a turn on the board, else "" and the
// talk's last turn decides.
func boardState(channelId, boardId string) string {
	if boardDrawer.Busy(channelId, boardId) {
		return boardAnsweringMark
	}
	return ""
}

// boardDir resolves a channel to its project's board folder.
func boardDir(ctx context.Context, channelId string) (*waveobj.Channel, string, error) {
	if channelId == "" {
		return nil, "", errors.New("channelid is required")
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, channelId)
	if err != nil {
		return nil, "", fmt.Errorf("channel %s: %w", channelId, err)
	}
	return ch, boardstore.ProjectDir(ch.Name), nil
}

func publishBoardList(channelId, boardId string) {
	wps.Broker.Publish(wps.WaveEvent{
		Event: wps.Event_BoardUpdate,
		Data:  wshrpc.BoardUpdateData{ChannelId: channelId, BoardId: boardId, What: "list"},
	})
}

func (ws *WshServer) BoardListCommand(ctx context.Context, data wshrpc.CommandBoardListData) (*wshrpc.BoardListRtnData, error) {
	ch, dir, err := boardDir(ctx, data.ChannelId)
	if err != nil {
		return nil, err
	}
	boards, err := boardstore.List(dir, ch.OID, func(boardId string) string { return boardState(ch.OID, boardId) })
	if err != nil {
		return nil, err
	}
	return &wshrpc.BoardListRtnData{Project: ch.Name, Boards: boards}, nil
}

func (ws *WshServer) BoardReadCommand(ctx context.Context, data wshrpc.CommandBoardRefData) (*wshrpc.BoardReadRtnData, error) {
	if !boardstore.ValidID(data.BoardId) {
		return nil, fmt.Errorf("invalid board id %q", data.BoardId)
	}
	ch, dir, err := boardDir(ctx, data.ChannelId)
	if err != nil {
		return nil, err
	}
	rtn, err := boardstore.Read(dir, ch.OID, data.BoardId)
	if err != nil {
		return nil, err
	}
	return &rtn, nil
}

func (ws *WshServer) BoardSaveCommand(ctx context.Context, data wshrpc.CommandBoardSaveData) (*wshrpc.BoardSaveRtnData, error) {
	if !boardstore.ValidID(data.BoardId) {
		return nil, fmt.Errorf("invalid board id %q", data.BoardId)
	}
	ch, dir, err := boardDir(ctx, data.ChannelId)
	if err != nil {
		return nil, err
	}
	rtn, err := boardstore.Save(dir, data.BoardId, data.Data, data.BaseRev)
	if err != nil {
		return nil, err
	}
	if !rtn.Conflict {
		publishBoardList(ch.OID, data.BoardId)
	}
	return &rtn, nil
}
