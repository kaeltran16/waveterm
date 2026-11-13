// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// BoardCommands is the boards: named Excalidraw files per project, each a talk with a read-only drawer. wavesrv
// owns the talk and the drawer; the frontend owns the scene and saves with the rev it read.
type BoardCommands interface {
	BoardListCommand(ctx context.Context, data CommandBoardListData) (*BoardListRtnData, error)
	BoardReadCommand(ctx context.Context, data CommandBoardRefData) (*BoardReadRtnData, error)
	BoardSaveCommand(ctx context.Context, data CommandBoardSaveData) (*BoardSaveRtnData, error)
	BoardAgentDrawCommand(ctx context.Context, data CommandBoardAgentDrawData) (*BoardAgentDrawRtnData, error)
	BoardStartCommand(ctx context.Context, data CommandBoardStartData) (*BoardInfo, error)
	BoardTalkCommand(ctx context.Context, data CommandBoardRefData) (*BoardTalk, error)
	BoardAskCommand(ctx context.Context, data CommandBoardAskData) error
	BoardAskStopCommand(ctx context.Context, data CommandBoardRefData) error
	BoardAskRetryCommand(ctx context.Context, data CommandBoardTurnData) error
	BoardAskChoiceCommand(ctx context.Context, data CommandBoardChoiceData) error
	BoardAnswerInboxCommand(ctx context.Context, data CommandBoardInboxData) ([]BoardAnswer, error)
	BoardAnswerAckCommand(ctx context.Context, data CommandBoardAnswerAckData) error
}

type CommandBoardListData struct {
	ChannelId string `json:"channelid"`
}

type BoardListRtnData struct {
	Project string      `json:"project"` // the channel's name
	Boards  []BoardInfo `json:"boards"`  // most recently active first
}

type BoardInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ChannelId  string `json:"channelid"`
	Path       string `json:"path"` // the .excalidraw file, absolute
	CreatedTs  int64  `json:"createdts"`
	State      string `json:"state,omitempty"` // "answering" | "asks" | "failed"
	LoadError  string `json:"loaderror,omitempty"`
	Questions  int    `json:"questions,omitempty"`
	About      string `json:"about,omitempty"` // the talk's about title; empty = the project's code
	AnsweredTs int64  `json:"answeredts,omitempty"`
	ActiveTs   int64  `json:"activets,omitempty"` // last turn or answer, else created
}

type CommandBoardRefData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid"`
}

type BoardReadRtnData struct {
	Info BoardInfo      `json:"info"`
	Data string         `json:"data"` // the file's JSON text
	Rev  string         `json:"rev"`
	Arc  BoardArcRecord `json:"arc"`
}

type CommandBoardSaveData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid"`
	Data      string `json:"data"`
	BaseRev   string `json:"baserev"`
}

type BoardSaveRtnData struct {
	Rev      string `json:"rev,omitempty"`
	Conflict bool   `json:"conflict,omitempty"` // the file changed since BaseRev; nothing was written
}

// BoardSource is the thing a talk is about. Kind: agent | session | run | effort | record | project | briefing.
type BoardSource struct {
	Kind      string `json:"kind"`
	Ref       string `json:"ref"`
	ChannelId string `json:"channelid,omitempty"` // a run's channel
	Path      string `json:"path,omitempty"`      // a session's transcript
	Runtime   string `json:"runtime,omitempty"`   // a session's runtime
	Title     string `json:"title"`               // as rows and toasts name it: "claude · waveterm", "run 690cc20a"
	Text      string `json:"text,omitempty"`      // a briefing's text
}

type CommandBoardAgentDrawData struct {
	BlockId string `json:"blockid"`
	Board   string `json:"board"`
	Ask     string `json:"ask,omitempty"`
	Context string `json:"context,omitempty"`
}

type BoardAgentDrawRtnData struct {
	BoardId   string `json:"boardid"`
	BoardName string `json:"boardname"`
	Project   string `json:"project"`
	Created   bool   `json:"created,omitempty"`
}

type CommandBoardInboxData struct { // both empty: every board's waiting answers
	ChannelId string `json:"channelid,omitempty"`
	BoardId   string `json:"boardid,omitempty"`
}

// BoardArcRecord is the board file's "arc" key (its first key). Go reads it; the frontend writes it.
type BoardArcRecord struct {
	Name      string `json:"name"`
	CreatedTs int64  `json:"createdts"`
}

// BoardUpdateData is board:update's payload. What: list | talk | answer.
type BoardUpdateData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid,omitempty"`
	What      string `json:"what"`
	Reason    string `json:"reason,omitempty"`
	TurnId    string `json:"turnid,omitempty"`
	State     string `json:"state,omitempty"`
	From      string `json:"from,omitempty"` // a briefing's sender
}

// BoardTalk is a board's conversation with its drawer, kept in the <id>.talk.json sidecar that only wavesrv writes.
type BoardTalk struct {
	ChannelId string      `json:"channelid"`
	BoardId   string      `json:"boardid"`
	About     BoardSource `json:"about"`
	SessionId string      `json:"sessionid,omitempty"`
	// ContextTokens is SessionId's context after its last turn: past a threshold the next turn starts a new
	// session from a summary
	ContextTokens int           `json:"contexttokens,omitempty"`
	Handoff       *BoardHandoff `json:"handoff,omitempty"`
	Turns         []BoardTurn   `json:"turns"`
}

type BoardHandoff struct {
	FromBoardId string `json:"fromboardid"`
	FromName    string `json:"fromname"`
	Summary     string `json:"summary"`
	Shapes      int    `json:"shapes"`
}

type BoardBriefing struct {
	From string `json:"from"`
	Text string `json:"text"`
	Ask  string `json:"ask"`
}

// BoardTurn is one question and its answer. State: waiting | answering | answered | asks | failed | stopped.
// Choice, on an asks turn: keep | new.
type BoardTurn struct {
	ID          string         `json:"id"`
	Ts          int64          `json:"ts"`
	Question    string         `json:"question,omitempty"`
	On          string         `json:"on,omitempty"`
	SelectedIds []string       `json:"selectedids,omitempty"`
	Briefing    *BoardBriefing `json:"briefing,omitempty"`
	Kept        bool           `json:"kept,omitempty"`
	State       string         `json:"state"`
	Reply       string         `json:"reply,omitempty"`
	Title       string         `json:"title,omitempty"`
	Added       int            `json:"added,omitempty"`
	Changed     int            `json:"changed,omitempty"`
	Removed     int            `json:"removed,omitempty"`
	ShapeIds    []string       `json:"shapeids,omitempty"`
	AnsweredTs  int64          `json:"answeredts,omitempty"`
	Reason      string         `json:"reason,omitempty"`
	Choice      string         `json:"choice,omitempty"`
}

type CommandBoardStartData struct {
	ChannelId   string      `json:"channelid"`
	Name        string      `json:"name"`
	Question    string      `json:"question,omitempty"`
	About       BoardSource `json:"about"`
	FromBoardId string      `json:"fromboardid,omitempty"`
	Elements    string      `json:"elements,omitempty"` // a JSON array of Excalidraw elements: the copied drawing
}

type CommandBoardAskData struct {
	ChannelId   string   `json:"channelid"`
	BoardId     string   `json:"boardid"`
	Question    string   `json:"question"`
	On          string   `json:"on,omitempty"`
	SelectedIds []string `json:"selectedids,omitempty"`
}

type CommandBoardTurnData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid"`
	TurnId    string `json:"turnid"`
}

type CommandBoardChoiceData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid"`
	TurnId    string `json:"turnid"`
	Choice    string `json:"choice"`
}

// BoardAnswer is one drawer answer waiting in a board's answers inbox until the frontend applies it.
type BoardAnswer struct {
	ID        string   `json:"id"`
	ChannelId string   `json:"channelid"`
	BoardId   string   `json:"boardid"`
	TurnId    string   `json:"turnid"`
	Add       string   `json:"add,omitempty"`    // JSON array text of Excalidraw element skeletons
	Update    string   `json:"update,omitempty"` // JSON array text of element patches
	Remove    []string `json:"remove,omitempty"`
	Ts        int64    `json:"ts"`
}

type CommandBoardAnswerAckData struct {
	ChannelId string   `json:"channelid"`
	BoardId   string   `json:"boardid"`
	AnswerId  string   `json:"answerid"`
	TurnId    string   `json:"turnid"`
	ShapeIds  []string `json:"shapeids,omitempty"`
}
