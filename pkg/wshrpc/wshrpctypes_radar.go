// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type RadarCommands interface {
	StartRadarScanCommand(ctx context.Context, data CommandStartRadarScanData) (*CommandStartRadarScanRtnData, error) // validate scope + start a manual repo scan
	CancelRadarScanCommand(ctx context.Context, data CommandCancelRadarScanData) error                                // cancel an in-flight scan
	ListRadarReportsCommand(ctx context.Context, data CommandListRadarReportsData) (*CommandListRadarReportsRtnData, error)
	SetRadarFindingDispositionCommand(ctx context.Context, data CommandSetRadarFindingDispositionData) error // dismiss/suppress/reopen/unsuppress a finding
	RetryRadarClusteringCommand(ctx context.Context, data CommandRetryRadarClusteringData) error             // re-run synthesis from retained candidates
}

type CommandStartRadarScanData struct {
	ProjectPath string `json:"projectpath"`
}

type CommandStartRadarScanRtnData struct {
	Report *waveobj.RadarReport `json:"report"`
}

type CommandCancelRadarScanData struct {
	ReportId string `json:"reportid"`
}

type CommandListRadarReportsData struct {
	ProjectPath string `json:"projectpath,omitempty"`
}

type CommandListRadarReportsRtnData struct {
	Reports []*waveobj.RadarReport `json:"reports"`
}

type CommandSetRadarFindingDispositionData struct {
	ReportId  string `json:"reportid"`
	FindingId string `json:"findingid"`
	Action    string `json:"action"` // dismiss|suppress|reopen|unsuppress
	Reason    string `json:"reason,omitempty"`
	Note      string `json:"note,omitempty"`
}

type CommandRetryRadarClusteringData struct {
	ReportId string `json:"reportid"`
}
