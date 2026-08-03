// pkg/wshrpc/wshrpctypes_git.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/gitinfo"
)

// GitCommands is the repo-first read domain: commit history and ref comparison. The older
// GitChangesCommand / GitDiffCommand / GitRevertCommand live in ProjectCommands and stay there.
type GitCommands interface {
	GitHistoryCommand(ctx context.Context, data CommandGitHistoryData) (*CommandGitHistoryRtnData, error)
	GitDivergenceCommand(ctx context.Context, data CommandGitDivergenceData) (*CommandGitDivergenceRtnData, error)
	GitCommitChangesCommand(ctx context.Context, data CommandGitCommitChangesData) (*CommandGitCommitChangesRtnData, error)
	GitCommitDiffCommand(ctx context.Context, data CommandGitCommitDiffData) (*CommandGitCommitDiffRtnData, error)
	GitCompareChangesCommand(ctx context.Context, data CommandGitCompareChangesData) (*CommandGitCompareChangesRtnData, error)
	GitCompareDiffCommand(ctx context.Context, data CommandGitCompareDiffData) (*CommandGitCompareDiffRtnData, error)
}

type CommandGitHistoryData struct {
	Cwd string `json:"cwd"`
	// Ref is a revision or range; "" walks all refs. Skip/Limit paginate. Author/Grep/Path filter.
	Ref    string `json:"ref,omitempty"`
	Skip   int    `json:"skip,omitempty"`
	Limit  int    `json:"limit,omitempty"`
	Author string `json:"author,omitempty"`
	Grep   string `json:"grep,omitempty"`
	Path   string `json:"path,omitempty"`
}

type CommandGitHistoryRtnData struct {
	Commits []gitinfo.HistoryCommit `json:"commits"`
	Head    string                  `json:"head"`
	IsRepo  bool                    `json:"isrepo"`
	// Set when the directory is a work tree but the log read failed. IsRepo:false and a populated
	// Failure are different states and the surface draws a different panel for each.
	Failure *gitinfo.GitFailure `json:"failure,omitempty"`
}

type CommandGitDivergenceData struct {
	Cwd  string `json:"cwd"`
	Base string `json:"base"`
	Head string `json:"head"`
}

type CommandGitDivergenceRtnData struct {
	Ahead     []gitinfo.HistoryCommit `json:"ahead"`
	Behind    []gitinfo.HistoryCommit `json:"behind"`
	MergeBase string                  `json:"mergebase"`
	IsRepo    bool                    `json:"isrepo"`
}

type CommandGitCommitChangesData struct {
	Cwd  string `json:"cwd"`
	Hash string `json:"hash"`
}

// Mirrors CommandGitChangesRtnData minus Branch and Ref, which are properties of the working-tree
// view and meaningless for a single commit.
type CommandGitCommitChangesRtnData struct {
	StatusZ string `json:"statusz"`
	Numstat string `json:"numstat"`
	IsRepo  bool   `json:"isrepo"`
}

type CommandGitCommitDiffData struct {
	Cwd  string `json:"cwd"`
	Hash string `json:"hash"`
	Path string `json:"path"`
}

type CommandGitCommitDiffRtnData struct {
	Diff string `json:"diff"`
}

type CommandGitCompareChangesData struct {
	Cwd  string `json:"cwd"`
	Base string `json:"base"`
	Head string `json:"head"`
}

// Mirrors CommandGitCommitChangesRtnData: an aggregate is a change set like any other, so one
// frontend parser (parseGitChanges) serves the working tree, a single commit, and a two-ref range.
type CommandGitCompareChangesRtnData struct {
	StatusZ string `json:"statusz"`
	Numstat string `json:"numstat"`
	IsRepo  bool   `json:"isrepo"`
}

type CommandGitCompareDiffData struct {
	Cwd  string `json:"cwd"`
	Base string `json:"base"`
	Head string `json:"head"`
	Path string `json:"path"`
}

type CommandGitCompareDiffRtnData struct {
	Diff string `json:"diff"`
}
