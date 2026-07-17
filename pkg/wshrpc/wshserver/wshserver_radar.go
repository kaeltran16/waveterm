// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/reporadar"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) StartRadarScanCommand(ctx context.Context, data wshrpc.CommandStartRadarScanData) (*wshrpc.CommandStartRadarScanRtnData, error) {
	rpt, err := reporadar.Start(ctx, data.ProjectPath)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandStartRadarScanRtnData{Report: rpt}, nil
}

func (ws *WshServer) CancelRadarScanCommand(ctx context.Context, data wshrpc.CommandCancelRadarScanData) error {
	if data.ReportId == "" {
		return fmt.Errorf("reportid is required")
	}
	return reporadar.Cancel(data.ReportId)
}

func (ws *WshServer) ListRadarReportsCommand(ctx context.Context, data wshrpc.CommandListRadarReportsData) (*wshrpc.CommandListRadarReportsRtnData, error) {
	reports, err := reporadar.ListReports(ctx, data.ProjectPath)
	if err != nil {
		return nil, fmt.Errorf("listing radar reports: %w", err)
	}
	return &wshrpc.CommandListRadarReportsRtnData{Reports: reports}, nil
}

func (ws *WshServer) SetRadarFindingDispositionCommand(ctx context.Context, data wshrpc.CommandSetRadarFindingDispositionData) error {
	if data.ReportId == "" || data.FindingId == "" {
		return fmt.Errorf("reportid and findingid are required")
	}
	return reporadar.ApplyDisposition(ctx, data.ReportId, data.FindingId, data.Action, data.Reason, data.Note)
}

func (ws *WshServer) RetryRadarClusteringCommand(ctx context.Context, data wshrpc.CommandRetryRadarClusteringData) error {
	if data.ReportId == "" {
		return fmt.Errorf("reportid is required")
	}
	return reporadar.Retry(ctx, data.ReportId)
}
