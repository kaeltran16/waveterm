// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/boardscribe"
	"github.com/wavetermdev/waveterm/pkg/boardstore"
	"github.com/wavetermdev/waveterm/pkg/boardthings"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const boardSourceAgent = "agent"

var boardSourceKinds = map[string]bool{boardSourceAgent: true, "session": true, "run": true, "effort": true, "record": true}

// boardScheduler is what the board handlers need from the scribe; a seam so tests record wakes instead.
type boardScheduler interface {
	Wake(p boardscribe.Pass)
	Retry(channelId, boardId, key string) error
	Status(channelId, boardId string) []wshrpc.BoardSourceStatus
	BoardState(channelId, boardId string) string
}

var boardScribe boardScheduler = boardscribe.NewScheduler(boardscribe.Deps{
	ReadThing: boardthings.Read,
	Previous: func(channelId, boardId, key string) (string, int64, error) {
		_, dir, err := boardDir(context.Background(), channelId)
		if err != nil {
			return "", 0, err
		}
		return boardstore.Previous(dir, boardId, key)
	},
	Deliver: func(d wshrpc.BoardDraw) error {
		_, dir, err := boardDir(context.Background(), d.ChannelId)
		if err != nil {
			return err
		}
		return boardstore.PutDraw(dir, d)
	},
	Publish: func(u wshrpc.BoardUpdateData) {
		wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_BoardUpdate, Data: u})
	},
	Run: boardscribe.RunModel,
})

// openBoard returns the channel and the board's info, refusing a board that won't open with its load error.
func openBoard(ctx context.Context, channelId, boardId string) (*waveobj.Channel, wshrpc.BoardInfo, error) {
	if !boardstore.ValidID(boardId) {
		return nil, wshrpc.BoardInfo{}, fmt.Errorf("invalid board id %q", boardId)
	}
	ch, dir, err := boardDir(ctx, channelId)
	if err != nil {
		return nil, wshrpc.BoardInfo{}, err
	}
	rtn, err := boardstore.Read(dir, ch.OID, boardId)
	if err != nil {
		return nil, wshrpc.BoardInfo{}, fmt.Errorf("board %s won't open: %w", boardId, err)
	}
	return ch, rtn.Info, nil
}

func checkBoardSource(src wshrpc.BoardSource, follow bool) error {
	if src.Kind == "" || src.Ref == "" {
		return errors.New("a draw needs a source: its kind and ref")
	}
	if !boardSourceKinds[src.Kind] {
		return fmt.Errorf("unknown board source kind %q", src.Kind)
	}
	if follow && src.Kind != boardSourceAgent {
		return fmt.Errorf("only an agent can be followed, not a %s", src.Kind)
	}
	return nil
}

// setBoardFollow points the agent's tab at the board, replacing any earlier follow.
func setBoardFollow(ctx context.Context, tabId, channelId string, info wshrpc.BoardInfo, ask string) error {
	oref := waveobj.MakeORef(waveobj.OType_Tab, tabId)
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_BoardFollowId:      info.ID,
		waveobj.MetaKey_BoardFollowChannel: channelId,
		waveobj.MetaKey_BoardFollowName:    info.Name,
		waveobj.MetaKey_BoardFollowAsk:     ask,
	}
	if _, err := wstore.UpdateObjectMeta(ctx, oref, meta, false); err != nil {
		return fmt.Errorf("following board %s on tab %s: %w", info.ID, tabId, err)
	}
	wcore.SendWaveObjUpdate(oref)
	return nil
}

func (ws *WshServer) BoardDrawCommand(ctx context.Context, data wshrpc.CommandBoardDrawData) error {
	if err := checkBoardSource(data.Source, data.Follow); err != nil {
		return err
	}
	ch, info, err := openBoard(ctx, data.ChannelId, data.BoardId)
	if err != nil {
		return err
	}
	ask := strings.TrimSpace(data.Ask)
	if data.Follow {
		if err := setBoardFollow(ctx, data.Source.Ref, ch.OID, info, ask); err != nil {
			return err
		}
	}
	boardScribe.Wake(boardscribe.Pass{
		ChannelId: ch.OID, BoardId: info.ID, BoardName: info.Name, ProjectPath: ch.ProjectPath,
		Source: data.Source, Ask: ask, Follow: data.Follow,
	})
	return nil
}

func (ws *WshServer) BoardRetryCommand(ctx context.Context, data wshrpc.CommandBoardSourceData) error {
	if !boardstore.ValidID(data.BoardId) {
		return fmt.Errorf("invalid board id %q", data.BoardId)
	}
	if data.ChannelId == "" || data.SourceKey == "" {
		return errors.New("channelid and sourcekey are required")
	}
	return boardScribe.Retry(data.ChannelId, data.BoardId, data.SourceKey)
}

func (ws *WshServer) BoardStatusCommand(ctx context.Context, data wshrpc.CommandBoardRefData) (*wshrpc.BoardStatusData, error) {
	if !boardstore.ValidID(data.BoardId) {
		return nil, fmt.Errorf("invalid board id %q", data.BoardId)
	}
	if data.ChannelId == "" {
		return nil, errors.New("channelid is required")
	}
	sources := boardScribe.Status(data.ChannelId, data.BoardId)
	if sources == nil {
		sources = []wshrpc.BoardSourceStatus{}
	}
	return &wshrpc.BoardStatusData{ChannelId: data.ChannelId, BoardId: data.BoardId, Sources: sources}, nil
}

// noteBoardFollowTurnEnded wakes the board an agent follows when its turn ends. A tab without a follow wakes nothing.
func noteBoardFollowTurnEnded(ctx context.Context, ev *wps.WaveEvent) {
	var data baseds.AgentStatusData
	if utilfn.ReUnmarshal(&data, ev.Data) != nil {
		return
	}
	if data.State != baseds.AgentState_Idle && data.State != baseds.AgentState_Waiting {
		return
	}
	oref, err := waveobj.ParseORef(data.ORef)
	if err != nil {
		return
	}
	tabId := oref.OID
	switch oref.OType {
	case waveobj.OType_Block:
		if tabId, err = wstore.DBFindTabForBlockId(ctx, oref.OID); err != nil || tabId == "" {
			return
		}
	case waveobj.OType_Tab:
	default:
		return
	}
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil || tab == nil {
		return
	}
	boardId := tab.Meta.GetString(waveobj.MetaKey_BoardFollowId, "")
	if boardId == "" {
		return
	}
	channelId := tab.Meta.GetString(waveobj.MetaKey_BoardFollowChannel, "")
	if !boardstore.ValidID(boardId) {
		log.Printf("board follow on tab %s: invalid board id %q", tabId, boardId)
		return
	}
	ch, err := wstore.DBGet[*waveobj.Channel](ctx, channelId)
	if err != nil || ch == nil {
		log.Printf("board follow on tab %s: channel %s: %v", tabId, channelId, err)
		return
	}
	boardScribe.Wake(boardscribe.Pass{
		ChannelId: ch.OID, BoardId: boardId, BoardName: tab.Meta.GetString(waveobj.MetaKey_BoardFollowName, ""),
		ProjectPath: ch.ProjectPath,
		Source:      wshrpc.BoardSource{Kind: boardSourceAgent, Ref: tabId, Title: agentSourceTitle(tab, ch.Name)},
		Ask:         tab.Meta.GetString(waveobj.MetaKey_BoardFollowAsk, ""),
		Follow:      true,
	})
}
