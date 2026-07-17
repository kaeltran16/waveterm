// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type BlockCommands interface {
	ControllerInputCommand(ctx context.Context, data CommandBlockInputData) error
	ControllerDestroyCommand(ctx context.Context, blockId string) error
	ControllerResyncCommand(ctx context.Context, data CommandControllerResyncData) error
	ControllerAppendOutputCommand(ctx context.Context, data CommandControllerAppendOutputData) error
	CreateBlockCommand(ctx context.Context, data CommandCreateBlockData) (waveobj.ORef, error)
	CreateSubBlockCommand(ctx context.Context, data CommandCreateSubBlockData) (waveobj.ORef, error)
	DeleteBlockCommand(ctx context.Context, data CommandDeleteBlockData) error
	DeleteSubBlockCommand(ctx context.Context, data CommandDeleteBlockData) error
	BlockInfoCommand(ctx context.Context, blockId string) (*BlockInfoData, error)
	DebugTermCommand(ctx context.Context, data CommandDebugTermData) (*CommandDebugTermRtnData, error)
	BlocksListCommand(ctx context.Context, data BlocksListRequest) ([]BlocksListEntry, error)
	WorkspaceListCommand(ctx context.Context) ([]WorkspaceInfoData, error)
	// screenshot
	CaptureBlockScreenshotCommand(ctx context.Context, data CommandCaptureBlockScreenshotData) (string, error)
	// block focus
	SetBlockFocusCommand(ctx context.Context, blockId string) error
	// terminal
	TermGetScrollbackLinesCommand(ctx context.Context, data CommandTermGetScrollbackLinesData) (*CommandTermGetScrollbackLinesRtnData, error)
}

type CommandCreateBlockData struct {
	TabId         string               `json:"tabid"`
	BlockDef      *waveobj.BlockDef    `json:"blockdef"`
	RtOpts        *waveobj.RuntimeOpts `json:"rtopts,omitempty"`
	Magnified     bool                 `json:"magnified,omitempty"`
	Ephemeral     bool                 `json:"ephemeral,omitempty"`
	Focused       bool                 `json:"focused,omitempty"`
	TargetBlockId string               `json:"targetblockid,omitempty"`
	TargetAction  string               `json:"targetaction,omitempty"` // "replace", "splitright", "splitdown", "splitleft", "splitup"
}

type CommandCreateSubBlockData struct {
	ParentBlockId string            `json:"parentblockid"`
	BlockDef      *waveobj.BlockDef `json:"blockdef"`
}

type CommandControllerResyncData struct {
	ForceRestart bool                 `json:"forcerestart,omitempty"`
	TabId        string               `json:"tabid"`
	BlockId      string               `json:"blockid"`
	RtOpts       *waveobj.RuntimeOpts `json:"rtopts,omitempty"`
}

type CommandControllerAppendOutputData struct {
	BlockId string `json:"blockid"`
	Data64  string `json:"data64"`
}

type CommandBlockInputData struct {
	BlockId     string            `json:"blockid"`
	InputData64 string            `json:"inputdata64,omitempty"`
	SigName     string            `json:"signame,omitempty"`
	TermSize    *waveobj.TermSize `json:"termsize,omitempty"`
}

type CommandDeleteBlockData struct {
	BlockId string `json:"blockid"`
}

type BlockInfoData struct {
	BlockId     string          `json:"blockid"`
	TabId       string          `json:"tabid"`
	WorkspaceId string          `json:"workspaceid"`
	Block       *waveobj.Block  `json:"block"`
	Files       []*WaveFileInfo `json:"files"`
}

type WorkspaceInfoData struct {
	WindowId      string             `json:"windowid"`
	WorkspaceData *waveobj.Workspace `json:"workspacedata"`
}

type BlocksListRequest struct {
	WindowId    string `json:"windowid,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
}

type BlocksListEntry struct {
	WindowId    string              `json:"windowid"`
	WorkspaceId string              `json:"workspaceid"`
	TabId       string              `json:"tabid"`
	BlockId     string              `json:"blockid"`
	Meta        waveobj.MetaMapType `json:"meta"`
}

type CommandCaptureBlockScreenshotData struct {
	BlockId string `json:"blockid"`
}

type CommandDebugTermData struct {
	BlockId string `json:"blockid"`
	Size    int64  `json:"size"`
}

type CommandDebugTermRtnData struct {
	Offset int64  `json:"offset"`
	Data64 string `json:"data64"`
}

type CommandTermGetScrollbackLinesData struct {
	LineStart   int  `json:"linestart"`
	LineEnd     int  `json:"lineend"`
	LastCommand bool `json:"lastcommand"`
}

type CommandTermGetScrollbackLinesRtnData struct {
	TotalLines  int      `json:"totallines"`
	LineStart   int      `json:"linestart"`
	Lines       []string `json:"lines"`
	LastUpdated int64    `json:"lastupdated"`
}
