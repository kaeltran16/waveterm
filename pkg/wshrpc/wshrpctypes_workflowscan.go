// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// WorkflowScanCommands is the Usage surface's Workflow lens: a quick Opus run reads the recent run
// records, a Sonnet pass names recurring problems, code recounts them, and the owner applies or drops
// the drafted fixes. The scan's state lives on the scan run's own record (waveobj.WorkflowScan).
type WorkflowScanCommands interface {
	WorkflowScanStartCommand(ctx context.Context, data CommandWorkflowScanStartData) (*CommandWorkflowScanStartRtnData, error)
	// run by the scan agent: reads the corpus, has Sonnet name patterns, recounts, and returns the survivors
	WorkflowScanCommand(ctx context.Context, data CommandWorkflowScanData) (*waveobj.WorkflowScan, error)
	// run by the scan agent: stores its verdicts, one per survivor
	WorkflowScanResultCommand(ctx context.Context, data CommandWorkflowScanResultData) error
	// run by the lens: stores the owner's picks and tells the agent
	WorkflowScanPicksCommand(ctx context.Context, data CommandWorkflowScanPicksData) error
	GetWorkflowScanCommand(ctx context.Context, data CommandGetWorkflowScanData) (*CommandGetWorkflowScanRtnData, error)
}

type CommandWorkflowScanStartData struct {
	ChannelId   string `json:"channelid"`
	WorkspaceId string `json:"workspaceid"`
	WindowDays  int    `json:"windowdays,omitempty"` // 0 = the 14-day default
}

type CommandWorkflowScanStartRtnData struct {
	Run *waveobj.Run `json:"run"`
}

type CommandWorkflowScanData struct {
	ORef       string `json:"oref"` // the calling agent's tab:<id>
	WindowDays int    `json:"windowdays,omitempty"`
}

type CommandWorkflowScanResultData struct {
	ORef     string                        `json:"oref"` // the calling agent's tab:<id>
	Verdicts []waveobj.WorkflowScanVerdict `json:"verdicts"`
}

type CommandWorkflowScanPicksData struct {
	ChannelId string                     `json:"channelid"`
	RunId     string                     `json:"runid"`
	Picks     []waveobj.WorkflowScanPick `json:"picks"`
}

type CommandGetWorkflowScanData struct {
	ORef string `json:"oref,omitempty"` // a tab:<id>: the scan run that tab works; empty = the newest scan run
}

type CommandGetWorkflowScanRtnData struct {
	ChannelId string                `json:"channelid"`
	RunId     string                `json:"runid"`
	Scan      *waveobj.WorkflowScan `json:"scan"` // nil when no scan run exists
}
