// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/wavetermdev/waveterm/pkg/boardstore"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// boardState is the scribe's state for a board ("drawing", "failed" or "").
var boardState = func(channelId, boardId string) string { return boardScribe.BoardState(channelId, boardId) }

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

func (ws *WshServer) BoardCreateCommand(ctx context.Context, data wshrpc.CommandBoardCreateData) (*wshrpc.BoardInfo, error) {
	ch, dir, err := boardDir(ctx, data.ChannelId)
	if err != nil {
		return nil, err
	}
	info, err := boardstore.Create(dir, ch.OID, data.Name, time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	publishBoardList(ch.OID, info.ID)
	return &info, nil
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

func (ws *WshServer) BoardFollowStopCommand(ctx context.Context, data wshrpc.CommandBoardFollowStopData) error {
	if data.TabId == "" {
		return errors.New("tabid is required")
	}
	oref := waveobj.MakeORef(waveobj.OType_Tab, data.TabId)
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_BoardFollowId:      nil,
		waveobj.MetaKey_BoardFollowChannel: nil,
		waveobj.MetaKey_BoardFollowName:    nil,
		waveobj.MetaKey_BoardFollowAsk:     nil,
	}
	if _, err := wstore.UpdateObjectMeta(ctx, oref, meta, false); err != nil {
		return fmt.Errorf("clearing the board follow on tab %s: %w", data.TabId, err)
	}
	wcore.SendWaveObjUpdate(oref)
	return nil
}

func (ws *WshServer) BoardInboxCommand(ctx context.Context, data wshrpc.CommandBoardInboxData) ([]wshrpc.BoardDraw, error) {
	if data.BoardId != "" && !boardstore.ValidID(data.BoardId) {
		return nil, fmt.Errorf("invalid board id %q", data.BoardId)
	}
	if data.ChannelId != "" {
		ch, dir, err := boardDir(ctx, data.ChannelId)
		if err != nil {
			return nil, err
		}
		draws, err := boardstore.Draws(dir, data.BoardId)
		if err != nil {
			return nil, err
		}
		for i := range draws {
			draws[i].ChannelId = ch.OID
		}
		return draws, nil
	}
	if data.BoardId != "" {
		return nil, errors.New("channelid is required with a board id")
	}
	return allBoardDraws()
}

// allBoardDraws is every project's waiting draws, oldest first. Each draw names its own channel.
func allBoardDraws() ([]wshrpc.BoardDraw, error) {
	entries, err := os.ReadDir(boardstore.Root())
	if errors.Is(err, os.ErrNotExist) {
		return []wshrpc.BoardDraw{}, nil
	}
	if err != nil {
		return nil, err
	}
	all := []wshrpc.BoardDraw{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		draws, err := boardstore.Draws(filepath.Join(boardstore.Root(), e.Name()), "")
		if err != nil {
			return nil, err
		}
		all = append(all, draws...)
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Ts != all[j].Ts {
			return all[i].Ts < all[j].Ts
		}
		return all[i].ID < all[j].ID
	})
	return all, nil
}

func (ws *WshServer) BoardInboxAckCommand(ctx context.Context, data wshrpc.CommandBoardInboxAckData) error {
	if !boardstore.ValidID(data.BoardId) {
		return fmt.Errorf("invalid board id %q", data.BoardId)
	}
	ch, dir, err := boardDir(ctx, data.ChannelId)
	if err != nil {
		return err
	}
	if err := boardstore.AckDraw(dir, data.BoardId, data.DrawId); err != nil {
		return err
	}
	publishBoardList(ch.OID, data.BoardId)
	return nil
}
