// pkg/wshrpc/wshserver/wshserver_git.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) GitHistoryCommand(ctx context.Context, data wshrpc.CommandGitHistoryData) (*wshrpc.CommandGitHistoryRtnData, error) {
	h, err := gitinfo.HistoryLog(ctx, data.Cwd, gitinfo.HistoryOpts{
		Ref:    data.Ref,
		Skip:   data.Skip,
		Limit:  data.Limit,
		Author: data.Author,
		Grep:   data.Grep,
		Path:   data.Path,
	})
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitHistoryRtnData{Commits: h.Commits, Head: h.Head, IsRepo: h.IsRepo}, nil
}

func (ws *WshServer) GitDivergenceCommand(ctx context.Context, data wshrpc.CommandGitDivergenceData) (*wshrpc.CommandGitDivergenceRtnData, error) {
	d, err := gitinfo.GetDivergence(ctx, data.Cwd, data.Base, data.Head)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitDivergenceRtnData{
		Ahead: d.Ahead, Behind: d.Behind, MergeBase: d.MergeBase, IsRepo: d.IsRepo,
	}, nil
}
