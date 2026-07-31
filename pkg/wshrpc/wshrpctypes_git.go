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
