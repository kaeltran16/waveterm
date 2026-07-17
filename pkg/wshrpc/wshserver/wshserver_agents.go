// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/tasksharpen"
	"github.com/wavetermdev/waveterm/pkg/usagestats"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

func (ws *WshServer) GetSessionGroupCommand(ctx context.Context, data wshrpc.CommandGetSessionGroupData) (*wshrpc.CommandGetSessionGroupRtnData, error) {
	if data.Cwd == "" {
		return nil, fmt.Errorf("cwd is required")
	}
	return resolveSessionGroup(data.Cwd), nil
}

func (ws *WshServer) GetAgentTranscriptCommand(ctx context.Context, data wshrpc.CommandGetAgentTranscriptData) (*wshrpc.CommandGetAgentTranscriptRtnData, error) {
	read := readTranscriptTail
	if data.FromStart {
		read = readTranscriptHead
	}
	lines, err := read(data.Path, data.MaxLines)
	if err != nil {
		return nil, fmt.Errorf("reading agent transcript: %w", err)
	}
	return &wshrpc.CommandGetAgentTranscriptRtnData{Lines: lines}, nil
}

func (ws *WshServer) GetSubagentsCommand(ctx context.Context, data wshrpc.CommandGetSubagentsData) (*wshrpc.CommandGetSubagentsRtnData, error) {
	infos, err := listSubagents(data.Path)
	if err != nil {
		return nil, fmt.Errorf("listing subagents: %w", err)
	}
	return &wshrpc.CommandGetSubagentsRtnData{Subagents: infos}, nil
}

func (ws *WshServer) GetUsageStatsCommand(ctx context.Context, data wshrpc.CommandGetUsageStatsData) (*wshrpc.CommandGetUsageStatsRtnData, error) {
	buckets, err := usagestats.ScanUsage(data.WindowDays)
	if err != nil {
		return nil, fmt.Errorf("scanning usage: %w", err)
	}
	out := make([]wshrpc.UsageBucket, len(buckets))
	for i, b := range buckets {
		out[i] = wshrpc.UsageBucket{
			Provider: b.Provider, Model: b.Model, Day: b.Day,
			Input: b.Input, Output: b.Output, CacheRead: b.CacheRead,
			CacheCreate: b.CacheCreate, CacheCreate1h: b.CacheCreate1h, Msgs: b.Msgs,
		}
	}
	return &wshrpc.CommandGetUsageStatsRtnData{Buckets: out}, nil
}

func (ws *WshServer) GetRecentSessionsCommand(ctx context.Context, data wshrpc.CommandGetRecentSessionsData) (*wshrpc.CommandGetRecentSessionsRtnData, error) {
	sessions, err := agentsessions.ScanSessions(data.WindowDays, data.Limit)
	if err != nil {
		return nil, fmt.Errorf("scanning sessions: %w", err)
	}
	out := make([]wshrpc.SessionInfo, len(sessions))
	for i, s := range sessions {
		out[i] = wshrpc.SessionInfo{
			ID: s.ID, Runtime: s.Runtime, ProjectPath: s.ProjectPath, ProjectName: s.ProjectName,
			Branch: s.Branch, Task: s.Task, Model: s.Model, TokensTotal: s.TokensTotal,
			LastActiveTs: s.LastActiveTs, ResumeCommand: s.ResumeCommand,
		}
	}
	return &wshrpc.CommandGetRecentSessionsRtnData{Sessions: out}, nil
}

func (ws *WshServer) GetSessionsActivityCommand(ctx context.Context, data wshrpc.CommandGetSessionsActivityData) (*wshrpc.CommandGetSessionsActivityRtnData, error) {
	sessions, err := agentsessions.ScanSessions(data.WindowDays, data.Limit)
	if err != nil {
		return nil, fmt.Errorf("scanning sessions: %w", err)
	}
	out := make([]wshrpc.SessionActivity, len(sessions))
	for i, s := range sessions {
		evs := make([]wshrpc.SessionEvent, len(s.Events))
		for j, e := range s.Events {
			evs[j] = wshrpc.SessionEvent{Type: e.Type, Ts: e.Ts, Text: e.Text}
		}
		out[i] = wshrpc.SessionActivity{
			ID: s.ID, Runtime: s.Runtime, ProjectPath: s.ProjectPath, ProjectName: s.ProjectName,
			Branch: s.Branch, Task: s.Task, Model: s.Model, TokensTotal: s.TokensTotal,
			LastActiveTs: s.LastActiveTs, ResumeCommand: s.ResumeCommand, TranscriptPath: s.TranscriptPath,
			Status: s.Status, StartedTs: s.StartedTs, DurationMs: s.DurationMs, Events: evs,
		}
	}
	return &wshrpc.CommandGetSessionsActivityRtnData{Sessions: out}, nil
}

func cutoffFromEpoch(sec int64) time.Time {
	if sec <= 0 {
		return time.Time{}
	}
	return time.Unix(sec, 0)
}

func (ws *WshServer) GetTranscriptTokensCommand(ctx context.Context, data wshrpc.CommandGetTranscriptTokensData) (*wshrpc.CommandGetTranscriptTokensRtnData, error) {
	total, err := usagestats.SumTranscript(data.Path)
	if err != nil {
		return nil, fmt.Errorf("summing transcript tokens: %w", err)
	}
	return &wshrpc.CommandGetTranscriptTokensRtnData{Tokens: total}, nil
}

func (ws *WshServer) GetTranscriptUsageCommand(ctx context.Context, data wshrpc.CommandGetTranscriptUsageData) (*wshrpc.CommandGetTranscriptUsageRtnData, error) {
	buckets, err := usagestats.TranscriptUsage(data.Path)
	if err != nil {
		return nil, fmt.Errorf("scanning transcript usage: %w", err)
	}
	out := make([]wshrpc.UsageBucket, len(buckets))
	for i, b := range buckets {
		out[i] = wshrpc.UsageBucket{
			Provider: b.Provider, Model: b.Model, Day: b.Day,
			Input: b.Input, Output: b.Output, CacheRead: b.CacheRead,
			CacheCreate: b.CacheCreate, CacheCreate1h: b.CacheCreate1h, Msgs: b.Msgs,
		}
	}
	return &wshrpc.CommandGetTranscriptUsageRtnData{Buckets: out}, nil
}

func (ws *WshServer) SharpenTaskCommand(ctx context.Context, data wshrpc.CommandSharpenTaskData) (*wshrpc.CommandSharpenTaskRtnData, error) {
	res, err := tasksharpen.Sharpen(ctx, tasksharpen.Input{
		Task:        data.Task,
		ProjectName: data.ProjectName,
		Runtime:     data.Runtime,
		Mode:        data.Mode,
	})
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandSharpenTaskRtnData{Task: res.Task, Model: res.Model}, nil
}

func (ws *WshServer) GetCacheStatusCommand(ctx context.Context, data wshrpc.CommandGetCacheStatusData) (*wshrpc.CommandGetCacheStatusRtnData, error) {
	cw, err := usagestats.LastCacheWrite(data.Path)
	if err != nil {
		return nil, fmt.Errorf("checking cache status: %w", err)
	}
	if cw == nil {
		return &wshrpc.CommandGetCacheStatusRtnData{}, nil
	}
	return &wshrpc.CommandGetCacheStatusRtnData{LastWriteTs: cw.TS.Unix(), OneHour: cw.OneHour}, nil
}

func (ws *WshServer) GetWindowTokensCommand(ctx context.Context, data wshrpc.CommandGetWindowTokensData) (*wshrpc.CommandGetWindowTokensRtnData, error) {
	cutoffs := []time.Time{cutoffFromEpoch(data.FiveHourCutoff), cutoffFromEpoch(data.WeekCutoff)}
	sums, err := usagestats.WindowTokens(cutoffs)
	if err != nil {
		return nil, fmt.Errorf("summing window tokens: %w", err)
	}
	return &wshrpc.CommandGetWindowTokensRtnData{FiveHourTokens: sums[0], WeekTokens: sums[1]}, nil
}

func (ws *WshServer) StreamAgentTranscriptCommand(ctx context.Context, data wshrpc.CommandStreamAgentTranscriptData) chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate] {
	ch := make(chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate], 16)
	go func() {
		defer func() {
			panichandler.PanicHandler("StreamAgentTranscriptCommand", recover())
		}()
		defer close(ch)
		if err := streamTranscript(ctx, data.Path, data.TailLines, ch); err != nil {
			ch <- wshutil.RespErr[wshrpc.AgentTranscriptUpdate](err)
		}
	}()
	return ch
}
