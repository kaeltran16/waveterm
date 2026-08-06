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
	return &wshrpc.CommandGitHistoryRtnData{Commits: h.Commits, Head: h.Head, IsRepo: h.IsRepo, Failure: h.Failure}, nil
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

func (ws *WshServer) GitCommitChangesCommand(ctx context.Context, data wshrpc.CommandGitCommitChangesData) (*wshrpc.CommandGitCommitChangesRtnData, error) {
	ch, err := gitinfo.CommitChanges(ctx, data.Cwd, data.Hash)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitCommitChangesRtnData{StatusZ: ch.StatusZ, Numstat: ch.Numstat, IsRepo: ch.IsRepo}, nil
}

func (ws *WshServer) GitCommitDiffCommand(ctx context.Context, data wshrpc.CommandGitCommitDiffData) (*wshrpc.CommandGitCommitDiffRtnData, error) {
	d, err := gitinfo.CommitDiff(ctx, data.Cwd, data.Hash, data.Path)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitCommitDiffRtnData{Diff: d.Diff}, nil
}

func (ws *WshServer) GitCompareChangesCommand(ctx context.Context, data wshrpc.CommandGitCompareChangesData) (*wshrpc.CommandGitCompareChangesRtnData, error) {
	ch, err := gitinfo.CompareChanges(ctx, data.Cwd, data.Base, data.Head)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitCompareChangesRtnData{StatusZ: ch.StatusZ, Numstat: ch.Numstat, IsRepo: ch.IsRepo}, nil
}

func (ws *WshServer) GitCompareDiffCommand(ctx context.Context, data wshrpc.CommandGitCompareDiffData) (*wshrpc.CommandGitCompareDiffRtnData, error) {
	d, err := gitinfo.CompareDiff(ctx, data.Cwd, data.Base, data.Head, data.Path)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitCompareDiffRtnData{Diff: d.Diff}, nil
}

func (ws *WshServer) GitListFilesCommand(ctx context.Context, data wshrpc.CommandGitListFilesData) (*wshrpc.CommandGitListFilesRtnData, error) {
	fl, err := gitinfo.ListFiles(ctx, data.Cwd)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandGitListFilesRtnData{Files: fl.Paths, IsRepo: fl.IsRepo, Truncated: fl.Truncated}, nil
}

func (ws *WshServer) GitGrepCommand(ctx context.Context, data wshrpc.CommandGitGrepData) (*wshrpc.CommandGitGrepRtnData, error) {
	res, err := gitinfo.Grep(ctx, data.Cwd, data.Query)
	if err != nil {
		return nil, err
	}
	matches := make([]wshrpc.GitGrepMatch, 0, len(res.Matches))
	for _, m := range res.Matches {
		matches = append(matches, wshrpc.GitGrepMatch{Path: m.Path, Line: m.Line, Text: m.Text})
	}
	return &wshrpc.CommandGitGrepRtnData{Matches: matches, Truncated: res.Truncated}, nil
}
