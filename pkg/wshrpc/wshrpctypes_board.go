// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// BoardCommands is the boards: named Excalidraw files per project that a read-only scribe agent draws
// on. wavesrv owns the files and the scribe; the frontend owns the scene and saves with the rev it read.
type BoardCommands interface {
	BoardListCommand(ctx context.Context, data CommandBoardListData) (*BoardListRtnData, error)
	BoardCreateCommand(ctx context.Context, data CommandBoardCreateData) (*BoardInfo, error)
	BoardReadCommand(ctx context.Context, data CommandBoardRefData) (*BoardReadRtnData, error)
	BoardSaveCommand(ctx context.Context, data CommandBoardSaveData) (*BoardSaveRtnData, error)
	BoardDrawCommand(ctx context.Context, data CommandBoardDrawData) error
	BoardAgentDrawCommand(ctx context.Context, data CommandBoardAgentDrawData) (*BoardAgentDrawRtnData, error)
	BoardRetryCommand(ctx context.Context, data CommandBoardSourceData) error
	BoardFollowStopCommand(ctx context.Context, data CommandBoardFollowStopData) error
	BoardStatusCommand(ctx context.Context, data CommandBoardRefData) (*BoardStatusData, error)
	BoardInboxCommand(ctx context.Context, data CommandBoardInboxData) ([]BoardDraw, error)
	BoardInboxAckCommand(ctx context.Context, data CommandBoardInboxAckData) error
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
	Boards  []BoardInfo `json:"boards"`  // most recently drawn first, never-drawn by created time
}

type BoardInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ChannelId   string `json:"channelid"`
	Path        string `json:"path"` // the .excalidraw file, absolute
	Groups      int    `json:"groups"`
	LastDrawnTs int64  `json:"lastdrawnts,omitempty"`
	CreatedTs   int64  `json:"createdts"`
	NewCount    int    `json:"newcount,omitempty"` // sources drawn after the record's seents
	State       string `json:"state,omitempty"`    // "answering" | "asks" | "failed"
	LoadError   string `json:"loaderror,omitempty"`
	Questions   int    `json:"questions,omitempty"`
	About       string `json:"about,omitempty"` // the talk's about title; empty = the project's code
	AnsweredTs  int64  `json:"answeredts,omitempty"`
	ActiveTs    int64  `json:"activets,omitempty"` // last turn or answer, else created
}

type CommandBoardCreateData struct {
	ChannelId string `json:"channelid"`
	Name      string `json:"name"`
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

// BoardSource is the thing a draw reads. Kind: agent | session | run | effort | record | project | briefing.
type BoardSource struct {
	Kind      string `json:"kind"`
	Ref       string `json:"ref"`
	ChannelId string `json:"channelid,omitempty"` // a run's channel
	Path      string `json:"path,omitempty"`      // a session's transcript
	Runtime   string `json:"runtime,omitempty"`   // a session's runtime
	Title     string `json:"title"`               // as rows and toasts name it: "claude · waveterm", "run 690cc20a"
	Text      string `json:"text,omitempty"`      // a briefing's text
}

type CommandBoardDrawData struct {
	ChannelId string      `json:"channelid"`
	BoardId   string      `json:"boardid"`
	Source    BoardSource `json:"source"`
	Ask       string      `json:"ask,omitempty"`
	Follow    bool        `json:"follow,omitempty"` // agent sources only
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

type CommandBoardSourceData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid"`
	SourceKey string `json:"sourcekey"`
}

type CommandBoardFollowStopData struct {
	TabId string `json:"tabid"`
}

type BoardSourceStatus struct {
	SourceKey string      `json:"sourcekey"`
	Source    BoardSource `json:"source"`
	Ask       string      `json:"ask,omitempty"`
	State     string      `json:"state"`             // "drawing" | "failed"
	Reading   string      `json:"reading,omitempty"` // "the 16:09 turn end", "the run, read whole"
	Queued    int         `json:"queued,omitempty"`  // wakes that came in during this pass
	Reason    string      `json:"reason,omitempty"`
	Ts        int64       `json:"ts"` // when the pass started or failed
}

type BoardStatusData struct {
	ChannelId string              `json:"channelid"`
	BoardId   string              `json:"boardid"`
	Sources   []BoardSourceStatus `json:"sources"`
}

// BoardDraw is one scribe result waiting in a board's inbox.
type BoardDraw struct {
	ID        string      `json:"id"`
	ChannelId string      `json:"channelid"`
	BoardId   string      `json:"boardid"`
	SourceKey string      `json:"sourcekey"`
	Source    BoardSource `json:"source"`
	Ask       string      `json:"ask,omitempty"`
	Skeleton  string      `json:"skeleton"` // JSON array text of Excalidraw element skeletons
	Shapes    int         `json:"shapes"`
	CursorTs  int64       `json:"cursorts,omitempty"`
	Follow    bool        `json:"follow,omitempty"`
	Ts        int64       `json:"ts"`
}

type CommandBoardInboxData struct { // both empty: every board's waiting draws
	ChannelId string `json:"channelid,omitempty"`
	BoardId   string `json:"boardid,omitempty"`
}

type CommandBoardInboxAckData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid"`
	DrawId    string `json:"drawid"`
}

// BoardArcRecord is the board file's "arc" key (its first key). Go reads it; the frontend writes it.
type BoardArcRecord struct {
	Name      string           `json:"name"`
	CreatedTs int64            `json:"createdts"`
	SeenTs    int64            `json:"seents,omitempty"`
	Sources   []BoardArcSource `json:"sources,omitempty"`
}

type BoardArcSource struct {
	Key         string           `json:"key"`
	Source      BoardSource      `json:"source"`
	Ask         string           `json:"ask,omitempty"`
	GroupId     string           `json:"groupid"`
	DrawnTs     int64            `json:"drawnts"`
	Shapes      int              `json:"shapes"`
	ContentHash string           `json:"contenthash"`
	EditedTs    int64            `json:"editedts,omitempty"`
	Box         *BoardBox        `json:"box,omitempty"` // the group's bbox as drawn
	Skeleton    string           `json:"skeleton"`      // the scribe's last skeleton for this group
	CursorTs    int64            `json:"cursorts,omitempty"`
	Pending     *BoardArcPending `json:"pending,omitempty"`
}

type BoardBox struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type BoardArcPending struct {
	DrawId   string `json:"drawid"`
	DrawnTs  int64  `json:"drawnts"`
	FrameId  string `json:"frameid"`
	Shapes   int    `json:"shapes"`
	Skeleton string `json:"skeleton"`
	CursorTs int64  `json:"cursorts,omitempty"`
}

// BoardUpdateData is board:update's payload. What: list | status | draw | failed | talk | answer.
type BoardUpdateData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid,omitempty"`
	What      string `json:"what"`
	SourceKey string `json:"sourcekey,omitempty"`
	Reason    string `json:"reason,omitempty"`
	TurnId    string `json:"turnid,omitempty"`
	State     string `json:"state,omitempty"`
	From      string `json:"from,omitempty"` // a briefing's sender
}

// BoardTalk is a board's conversation with its drawer, kept in the <id>.talk.json sidecar that only wavesrv writes.
type BoardTalk struct {
	ChannelId string        `json:"channelid"`
	BoardId   string        `json:"boardid"`
	About     BoardSource   `json:"about"`
	SessionId string        `json:"sessionid,omitempty"`
	Handoff   *BoardHandoff `json:"handoff,omitempty"`
	Turns     []BoardTurn   `json:"turns"`
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
