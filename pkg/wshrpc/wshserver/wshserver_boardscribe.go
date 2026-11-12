// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/boardscribe"
	"github.com/wavetermdev/waveterm/pkg/boardstore"
	"github.com/wavetermdev/waveterm/pkg/boardthings"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
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

// boardAgentCwd is the directory an agent last reported working in. A var so tests need no status events.
var boardAgentCwd = func(ctx context.Context, blockId, tabId string) string {
	if cwd := orchestrate.LatestAgentStatus(blockId, tabId).Cwd; cwd != "" {
		return cwd
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		return ""
	}
	return block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
}

// agentSourceTitle names an agent as rows and toasts do: its label, else "<runtime> · <project>".
func agentSourceTitle(tab *waveobj.Tab, project string) string {
	if label := strings.TrimSpace(tab.Meta.GetString(waveobj.MetaKey_SessionLabel, "")); label != "" {
		return label
	}
	return tab.Meta.GetString(waveobj.MetaKey_SessionAgent, "claude") + " · " + project
}

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

// BoardAgentDrawCommand is `wsh board draw`: the calling agent's own session onto a board named in its project,
// created when no board has that name. It returns once the pass is queued.
func (ws *WshServer) BoardAgentDrawCommand(ctx context.Context, data wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error) {
	name := strings.TrimSpace(data.Board)
	if data.BlockId == "" || name == "" {
		return nil, errors.New("a block id and a board name are required")
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, data.BlockId)
	if err != nil {
		return nil, fmt.Errorf("finding the tab of block %s: %w", data.BlockId, err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return nil, fmt.Errorf("loading tab %s: %w", tabId, err)
	}
	ch, err := agentChannel(ctx, tab, data.BlockId)
	if err != nil {
		return nil, err
	}
	dir := boardstore.ProjectDir(ch.Name)
	info, created, err := boardByName(dir, ch.OID, name)
	if err != nil {
		return nil, err
	}
	if info.LoadError != "" {
		return nil, fmt.Errorf("board %q won't open: %s", info.Name, info.LoadError)
	}
	if created {
		publishBoardList(ch.OID, info.ID)
	}
	boardScribe.Wake(boardscribe.Pass{
		ChannelId: ch.OID, BoardId: info.ID, BoardName: info.Name, ProjectPath: ch.ProjectPath,
		Source: wshrpc.BoardSource{Kind: boardSourceAgent, Ref: tabId, Title: agentSourceTitle(tab, ch.Name)},
		Ask:    strings.TrimSpace(data.Ask),
		FromTs: agentDrawFromTs(ctx, tab, data.BlockId),
	})
	return &wshrpc.BoardAgentDrawRtnData{BoardId: info.ID, BoardName: info.Name, Project: ch.Name, Created: created}, nil
}

// agentChannel is the channel at the agent's working checkout, else one ensured from its session project.
func agentChannel(ctx context.Context, tab *waveobj.Tab, blockId string) (*waveobj.Channel, error) {
	cwd := boardAgentCwd(ctx, blockId, tab.OID)
	if cwd == "" {
		return nil, errors.New("the agent has reported no working directory yet")
	}
	project := jarvis.MainCheckout(cwd)
	if project == "" {
		project = cwd
	}
	ch, err := wstore.ChannelAtPath(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("the project's channel: %w", err)
	}
	if ch != nil {
		return ch, nil
	}
	name := tab.Meta.GetString(waveobj.MetaKey_SessionProject, "")
	if name == "" {
		name = filepath.Base(project)
	}
	ch, err = wstore.EnsureChannelAtPath(ctx, name, project)
	if err != nil {
		return nil, fmt.Errorf("the project's channel: %w", err)
	}
	return ch, nil
}

// boardByName finds the board named name (trimmed, any case), the most recently drawn match first, or creates it.
func boardByName(dir, channelId, name string) (wshrpc.BoardInfo, bool, error) {
	boards, err := boardstore.List(dir, channelId, nil)
	if err != nil {
		return wshrpc.BoardInfo{}, false, err
	}
	// List orders most recently active first, so the first match is the newest
	for _, b := range boards {
		if strings.EqualFold(strings.TrimSpace(b.Name), name) {
			return b, false, nil
		}
	}
	info, err := boardstore.Create(dir, channelId, name, "", time.Now().UnixMilli())
	if err != nil {
		return wshrpc.BoardInfo{}, false, err
	}
	return info, true, nil
}

// agentDrawFromTs makes the first pass read from the second-to-last human prompt, so "put that on the board"
// carries the answer "that" names. 0 (the source's cursor) when the session has fewer than two prompts.
func agentDrawFromTs(ctx context.Context, tab *waveobj.Tab, blockId string) int64 {
	path, err := blockTranscriptMeta(ctx, blockId)
	if err != nil || path == "" {
		return 0
	}
	prompts := agentsessions.HumanPrompts(path, tab.Meta.GetString(waveobj.MetaKey_SessionAgent, ""))
	if len(prompts) < 2 {
		return 0
	}
	// TurnsSince reads turns after its cursor; one ms earlier keeps the prompt itself
	return prompts[len(prompts)-2].Ts - 1
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
