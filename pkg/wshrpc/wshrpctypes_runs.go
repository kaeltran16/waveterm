// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type RunCommands interface {
	CreateRunCommand(ctx context.Context, data CommandCreateRunData) (*CommandCreateRunRtnData, error) // create + start a goal Run (spawns phase 1's worker)
	AdvanceRunCommand(ctx context.Context, data CommandAdvanceRunData) error                           // complete a phase / approve or send back a gate (spawns the next worker)
	CancelRunCommand(ctx context.Context, data CommandCancelRunData) error                             // cancel a Run
	StopRunWorkerCommand(ctx context.Context, data CommandStopRunWorkerData) error                     // stop one surviving worker of a cancelled run
	SealRunEvidenceCommand(ctx context.Context, data CommandSealRunEvidenceData) error                 // derive+seal a done run's evidence if absent (idempotent backfill)
	ReportRunPhaseCommand(ctx context.Context, data CommandReportRunPhaseData) error                   // lead self-reports hold/complete; resolves run/phase from its own oref
	CreateChildRunCommand(ctx context.Context, data CommandCreateChildRunData) (*CommandCreateChildRunRtnData, error) // orchestrator lead spawns a hands-off child run for one backlog unit; parent resolved from the caller's oref
}

type CommandCreateRunData struct {
	ChannelId   string                  `json:"channelid"`
	WorkspaceId string                  `json:"workspaceid"` // where phase-worker tabs are created
	Goal        string                  `json:"goal"`
	PlaybookId  string                  `json:"playbookid,omitempty"`
	Mode        string                  `json:"mode,omitempty"`        // quick | pipeline | orchestrator (empty = resolved profile default)
	PlanGate    *bool                   `json:"plangate,omitempty"`    // orchestrator plan gate; nil = resolved profile default
	RadarOrigin *waveobj.RunRadarOrigin `json:"radarorigin,omitempty"` // set when started from a Radar finding
}

type CommandCreateRunRtnData struct {
	Run *waveobj.Run `json:"run"`
}

type CommandAdvanceRunData struct {
	ChannelId string   `json:"channelid"`
	RunId     string   `json:"runid"`
	PhaseIdx  int      `json:"phaseidx"`            // the phase being completed (ignored for approve/sendback)
	Action    string   `json:"action"`              // complete | approve | sendback | hold | triage
	Artifacts []string `json:"artifacts,omitempty"` // artifacts to record on complete
	Verdict   string   `json:"verdict,omitempty"`   // triage: quick | plan
	Note      string   `json:"note,omitempty"`      // triage: one-line reason
	Commit    string   `json:"commit,omitempty"`    // reported result commit; stored on Run.EndCommit for the complete action
}

type CommandCancelRunData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
}

type CommandStopRunWorkerData struct {
	ChannelId  string `json:"channelid"`
	RunId      string `json:"runid"`
	WorkerORef string `json:"workeroref"` // the worker tab oref ("tab:<id>") to stop
}

type CommandSealRunEvidenceData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
}

type CommandReportRunPhaseData struct {
	ORef      string   `json:"oref"`                // caller's tab oref ("tab:<id>")
	Action    string   `json:"action"`              // hold | complete | triage
	Artifacts []string `json:"artifacts,omitempty"` // recorded on complete
	Verdict   string   `json:"verdict,omitempty"`   // triage: quick | plan
	Note      string   `json:"note,omitempty"`      // triage: one-line reason
	Commit    string   `json:"commit,omitempty"`    // reported result commit; forwarded to AdvanceRun, stored on Run.EndCommit
}

type CommandCreateChildRunData struct {
	ORef string `json:"oref"`           // caller = the orchestrator lead's tab oref ("tab:<id>")
	Goal string `json:"goal"`           // the unit of work for the child run
	Mode string `json:"mode,omitempty"` // quick|pipeline|orchestrator; empty = inherit the parent run's mode
}

type CommandCreateChildRunRtnData struct {
	RunId string `json:"runid"`
}
