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
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/boarddrawer"
	"github.com/wavetermdev/waveterm/pkg/boardstore"
	"github.com/wavetermdev/waveterm/pkg/boardthings"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	errTypeName        = "Type a name first"
	errNeedsContext    = "pass the briefing with --context"
	boardUpdateTalk    = "talk"
	boardAnsweringMark = "answering"
)

// boardAboutKinds is what a talk can be about; empty is the project's code.
var boardAboutKinds = map[string]bool{
	"": true, boarddrawer.KindProject: true, boardSourceAgent: true, "session": true, "run": true, "effort": true,
	"record": true, boarddrawer.KindBriefing: true,
}

// boardDrawer runs every board's turns. A var so tests swap in one whose Run is stubbed.
var boardDrawer = newBoardDrawer(boarddrawer.RunModel)

func newBoardDrawer(run func(ctx context.Context, cwd string, c boarddrawer.Call) (string, error)) *boarddrawer.Drawer {
	dirOf := func(b boarddrawer.Board) (string, error) {
		_, dir, err := boardDir(context.Background(), b.ChannelId)
		return dir, err
	}
	return boarddrawer.New(boarddrawer.Deps{
		LoadTalk: func(b boarddrawer.Board) (wshrpc.BoardTalk, error) {
			dir, err := dirOf(b)
			if err != nil {
				return wshrpc.BoardTalk{}, err
			}
			talk, err := boardstore.ReadTalk(dir, b.BoardId)
			if err == nil && talk.ChannelId == "" {
				talk.ChannelId = b.ChannelId
			}
			return talk, err
		},
		UpdateTalk: func(b boarddrawer.Board, fn func(*wshrpc.BoardTalk) error) (wshrpc.BoardTalk, error) {
			dir, err := dirOf(b)
			if err != nil {
				return wshrpc.BoardTalk{}, err
			}
			return boardstore.UpdateTalk(dir, b.BoardId, func(talk *wshrpc.BoardTalk) error {
				// a board made before talks existed has no talk file, and ReadTalk fills only its id
				if talk.ChannelId == "" {
					talk.ChannelId = b.ChannelId
				}
				return fn(talk)
			})
		},
		ReadBoard: func(b boarddrawer.Board) ([]byte, error) {
			dir, err := dirOf(b)
			if err != nil {
				return nil, err
			}
			rtn, err := boardstore.Read(dir, b.ChannelId, b.BoardId)
			if err != nil {
				return nil, err
			}
			return []byte(rtn.Data), nil
		},
		ReadThing: boardthings.Read,
		Deliver: func(a wshrpc.BoardAnswer) error {
			_, dir, err := boardDir(context.Background(), a.ChannelId)
			if err != nil {
				return err
			}
			return boardstore.PutAnswer(dir, a)
		},
		Publish: publishBoardUpdate,
		Run:     run,
	})
}

func publishBoardUpdate(u wshrpc.BoardUpdateData) {
	wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_BoardUpdate, Data: u})
}

// drawerBoard resolves a board for the drawer. A board whose file won't parse still resolves, with LoadError set,
// so its talk shows; a missing one does not.
func drawerBoard(ctx context.Context, channelId, boardId string) (boarddrawer.Board, wshrpc.BoardInfo, error) {
	if !boardstore.ValidID(boardId) {
		return boarddrawer.Board{}, wshrpc.BoardInfo{}, fmt.Errorf("invalid board id %q", boardId)
	}
	ch, dir, err := boardDir(ctx, channelId)
	if err != nil {
		return boarddrawer.Board{}, wshrpc.BoardInfo{}, err
	}
	rtn, err := boardstore.Read(dir, ch.OID, boardId)
	if rtn.Info.ID == "" {
		return boarddrawer.Board{}, wshrpc.BoardInfo{}, err
	}
	b := boarddrawer.Board{ChannelId: ch.OID, BoardId: boardId, Name: rtn.Info.Name, ProjectPath: ch.ProjectPath}
	return b, rtn.Info, nil
}

func checkBoardAbout(about wshrpc.BoardSource) error {
	if !boardAboutKinds[about.Kind] {
		return fmt.Errorf("unknown board about kind %q", about.Kind)
	}
	if about.Kind != "" && about.Kind != boarddrawer.KindProject && about.Kind != boarddrawer.KindBriefing && about.Ref == "" {
		return fmt.Errorf("a board about a %s needs its ref", about.Kind)
	}
	return nil
}

// copiedShapes counts a copied drawing's shapes as the header does: bound text is part of its container.
func copiedShapes(elements string) (int, error) {
	if elements == "" {
		return 0, nil
	}
	scene, err := boarddrawer.SceneSummary([]byte(`{"elements":`+elements+`}`), nil)
	if err != nil {
		return 0, errors.New("elements must be a JSON array of Excalidraw elements")
	}
	return scene.Shapes, nil
}

func (ws *WshServer) BoardStartCommand(ctx context.Context, data wshrpc.CommandBoardStartData) (*wshrpc.BoardInfo, error) {
	name := strings.TrimSpace(data.Name)
	if name == "" {
		return nil, errors.New(errTypeName)
	}
	if err := checkBoardAbout(data.About); err != nil {
		return nil, err
	}
	ch, dir, err := boardDir(ctx, data.ChannelId)
	if err != nil {
		return nil, err
	}
	var handoff *wshrpc.BoardHandoff
	if data.FromBoardId != "" {
		if !boardstore.ValidID(data.FromBoardId) {
			return nil, fmt.Errorf("invalid board id %q", data.FromBoardId)
		}
		from, err := boardstore.Read(dir, ch.OID, data.FromBoardId)
		if from.Info.ID == "" {
			return nil, fmt.Errorf("the board to hand over is not in %s: %w", ch.Name, err)
		}
		shapes, err := copiedShapes(data.Elements)
		if err != nil {
			return nil, err
		}
		handoff = &wshrpc.BoardHandoff{FromBoardId: from.Info.ID, FromName: from.Info.Name, Shapes: shapes}
	}
	info, err := boardstore.Create(dir, ch.OID, name, data.Elements, time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	_, err = boardstore.UpdateTalk(dir, info.ID, func(talk *wshrpc.BoardTalk) error {
		talk.ChannelId, talk.About, talk.Handoff = ch.OID, data.About, handoff
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("board %s was made, but its talk could not be written: %w", info.Name, err)
	}
	publishBoardList(ch.OID, info.ID)
	if question := strings.TrimSpace(data.Question); question != "" {
		b := boarddrawer.Board{ChannelId: ch.OID, BoardId: info.ID, Name: info.Name, ProjectPath: ch.ProjectPath}
		if _, err := boardDrawer.Ask(b, wshrpc.BoardTurn{Question: question}); err != nil {
			return nil, fmt.Errorf("board %s was made, but its first question could not be asked: %w", info.Name, err)
		}
	}
	return &info, nil
}

func (ws *WshServer) BoardTalkCommand(ctx context.Context, data wshrpc.CommandBoardRefData) (*wshrpc.BoardTalk, error) {
	b, _, err := drawerBoard(ctx, data.ChannelId, data.BoardId)
	if err != nil {
		return nil, err
	}
	talk, err := boardDrawer.Talk(b)
	if err != nil {
		return nil, err
	}
	return &talk, nil
}

func (ws *WshServer) BoardAskCommand(ctx context.Context, data wshrpc.CommandBoardAskData) error {
	question := strings.TrimSpace(data.Question)
	if question == "" {
		return errors.New("type a question first")
	}
	b, info, err := drawerBoard(ctx, data.ChannelId, data.BoardId)
	if err != nil {
		return err
	}
	if info.LoadError != "" {
		return fmt.Errorf("the board's file won't open: %s", info.LoadError)
	}
	_, err = boardDrawer.Ask(b, wshrpc.BoardTurn{Question: question, On: data.On, SelectedIds: data.SelectedIds})
	return err
}

func (ws *WshServer) BoardAskStopCommand(ctx context.Context, data wshrpc.CommandBoardRefData) error {
	b, _, err := drawerBoard(ctx, data.ChannelId, data.BoardId)
	if err != nil {
		return err
	}
	return boardDrawer.Stop(b)
}

func (ws *WshServer) BoardAskRetryCommand(ctx context.Context, data wshrpc.CommandBoardTurnData) error {
	b, _, err := drawerBoard(ctx, data.ChannelId, data.BoardId)
	if err != nil {
		return err
	}
	return boardDrawer.Retry(b, data.TurnId)
}

func (ws *WshServer) BoardAskChoiceCommand(ctx context.Context, data wshrpc.CommandBoardChoiceData) error {
	b, _, err := drawerBoard(ctx, data.ChannelId, data.BoardId)
	if err != nil {
		return err
	}
	return boardDrawer.Choose(b, data.TurnId, data.Choice)
}

func (ws *WshServer) BoardAnswerInboxCommand(ctx context.Context, data wshrpc.CommandBoardInboxData) ([]wshrpc.BoardAnswer, error) {
	if data.BoardId != "" && !boardstore.ValidID(data.BoardId) {
		return nil, fmt.Errorf("invalid board id %q", data.BoardId)
	}
	if data.ChannelId != "" {
		ch, dir, err := boardDir(ctx, data.ChannelId)
		if err != nil {
			return nil, err
		}
		answers, err := boardstore.Answers(dir, data.BoardId)
		if err != nil {
			return nil, err
		}
		for i := range answers {
			answers[i].ChannelId = ch.OID
		}
		return answers, nil
	}
	if data.BoardId != "" {
		return nil, errors.New("channelid is required with a board id")
	}
	return allBoardAnswers()
}

// allBoardAnswers is every project's waiting answers, oldest first. Each answer names its own channel.
func allBoardAnswers() ([]wshrpc.BoardAnswer, error) {
	entries, err := os.ReadDir(boardstore.Root())
	if errors.Is(err, os.ErrNotExist) {
		return []wshrpc.BoardAnswer{}, nil
	}
	if err != nil {
		return nil, err
	}
	all := []wshrpc.BoardAnswer{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		answers, err := boardstore.Answers(filepath.Join(boardstore.Root(), e.Name()), "")
		if err != nil {
			return nil, err
		}
		all = append(all, answers...)
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Ts != all[j].Ts {
			return all[i].Ts < all[j].Ts
		}
		return all[i].ID < all[j].ID
	})
	return all, nil
}

func (ws *WshServer) BoardAnswerAckCommand(ctx context.Context, data wshrpc.CommandBoardAnswerAckData) error {
	if data.TurnId == "" {
		return errors.New("turnid is required")
	}
	b, _, err := drawerBoard(ctx, data.ChannelId, data.BoardId)
	if err != nil {
		return err
	}
	_, dir, err := boardDir(ctx, b.ChannelId)
	if err != nil {
		return err
	}
	if err := boardstore.AckAnswer(dir, b.BoardId, data.AnswerId); err != nil {
		return err
	}
	if err := boardDrawer.Answered(b, data.TurnId, data.ShapeIds); err != nil {
		return err
	}
	publishBoardUpdate(wshrpc.BoardUpdateData{ChannelId: b.ChannelId, BoardId: b.BoardId, What: boardUpdateTalk, TurnId: data.TurnId})
	return nil
}

// BoardAgentDrawCommand is `wsh board draw`: an agent's briefing onto a board named in its project, created when no
// board has that name. It returns once the turn is asked or queued behind the one the drawer is answering.
func (ws *WshServer) BoardAgentDrawCommand(ctx context.Context, data wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error) {
	name := strings.TrimSpace(data.Board)
	if data.BlockId == "" || name == "" {
		return nil, errors.New("a block id and a board name are required")
	}
	brief := strings.TrimSpace(data.Context)
	if brief == "" {
		return nil, errors.New(errNeedsContext)
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
	from := agentSourceTitle(tab, ch.Name)
	if created {
		about := wshrpc.BoardSource{Kind: boarddrawer.KindBriefing, Ref: tabId, Title: from, Text: brief}
		_, err := boardstore.UpdateTalk(dir, info.ID, func(talk *wshrpc.BoardTalk) error {
			talk.ChannelId, talk.About = ch.OID, about
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("board %s was made, but its talk could not be written: %w", info.Name, err)
		}
		publishBoardList(ch.OID, info.ID)
	}
	ask := strings.TrimSpace(data.Ask)
	b := boarddrawer.Board{ChannelId: ch.OID, BoardId: info.ID, Name: info.Name, ProjectPath: ch.ProjectPath}
	turn := wshrpc.BoardTurn{Question: ask, Briefing: &wshrpc.BoardBriefing{From: from, Text: brief, Ask: ask}}
	if _, err := boardDrawer.Ask(b, turn); err != nil {
		return nil, err
	}
	return &wshrpc.BoardAgentDrawRtnData{BoardId: info.ID, BoardName: info.Name, Project: ch.Name, Created: created}, nil
}

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

// boardByName finds the board named name (trimmed, any case), the most recently active match first, or creates it.
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
