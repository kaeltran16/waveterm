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
	GitListFilesCommand(ctx context.Context, data CommandGitListFilesData) (*CommandGitListFilesRtnData, error)
	GitGrepCommand(ctx context.Context, data CommandGitGrepData) (*CommandGitGrepRtnData, error)
	GitFileAtRefCommand(ctx context.Context, data CommandGitFileAtRefData) (*CommandGitFileAtRefRtnData, error)
	GitFetchCommand(ctx context.Context, data CommandGitFetchData) (*CommandGitFetchRtnData, error)
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
	// The patch exceeded the server-side cap and was not sent. Size says how big it was, so the pane
	// can name the number instead of rendering an empty scroll area that reads as "no changes".
	TooLarge bool  `json:"toolarge,omitempty"`
	Size     int64 `json:"size,omitempty"`
}

type CommandGitCompareChangesData struct {
	Cwd  string `json:"cwd"`
	Base string `json:"base"`
	Head string `json:"head"`
	// Tips selects the two-dot range form: the full difference between the two tips, with base's
	// own commits folded in as reverse changes. Default false is the three-dot form, which is the
	// only one whose file list matches the N-ahead commit list beside it.
	Tips bool `json:"tips,omitempty"`
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
	// Must match the Tips the file list was built with, or the pane and the list beside it read
	// different ranges and a file the list calls deleted opens as unchanged.
	Tips bool `json:"tips,omitempty"`
}

type CommandGitCompareDiffRtnData struct {
	Diff string `json:"diff"`
	// The patch exceeded the server-side cap and was not sent. Size says how big it was, so the pane
	// can name the number instead of rendering an empty scroll area that reads as "no changes".
	TooLarge bool  `json:"toolarge,omitempty"`
	Size     int64 `json:"size,omitempty"`
}

type CommandGitListFilesData struct {
	Cwd string `json:"cwd"`
}

// Files are repo-relative, forward-slashed, sorted. Truncated reports that the repo exceeded the
// server's cap and Files is a prefix, so the finder can say so instead of implying completeness.
type CommandGitListFilesRtnData struct {
	Files     []string `json:"files"`
	IsRepo    bool     `json:"isrepo"`
	Truncated bool     `json:"truncated,omitempty"`
}

type CommandGitGrepData struct {
	Cwd   string `json:"cwd"`
	Query string `json:"query"`
}

// Unlike the change-list and diff commands, which hand raw git output across the wire for one
// frontend parser to split, grep returns already-parsed matches — the mixed NUL-and-newline record
// format is the parsing Go already does for ls-files, the match cap has to be applied server-side
// regardless, and there is no second caller to share a TypeScript parser with.
type CommandGitGrepRtnData struct {
	Matches   []GitGrepMatch `json:"matches"`
	Truncated bool           `json:"truncated,omitempty"`
}

type GitGrepMatch struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

type CommandGitFileAtRefData struct {
	Cwd  string `json:"cwd"`
	Ref  string `json:"ref"`
	Path string `json:"path"`
	// MaxBytes refuses a blob larger than this without reading it. 0 = no cap.
	MaxBytes int64 `json:"maxbytes,omitempty"`
}

// Mirrors gitinfo.FileContent one field for one field: Binary, Missing and TooLarge are answers the
// caller renders, not errors, so each is a flag rather than an RPC failure.
type CommandGitFileAtRefRtnData struct {
	Content  string `json:"content"`
	Binary   bool   `json:"binary,omitempty"`
	Missing  bool   `json:"missing,omitempty"`
	TooLarge bool   `json:"toolarge,omitempty"`
	Size     int64  `json:"size,omitempty"`
	IsRepo   bool   `json:"isrepo"`
}

type CommandGitFetchData struct {
	Cwd string `json:"cwd"`
	// "" defaults to origin.
	Remote string `json:"remote,omitempty"`
}

// A fetch can take far longer than the default RPC budget, and the budget the client sends binds the
// server's context too — so a caller must raise opts.timeout past gitinfo's own fetchTimeout or the
// read is cancelled underneath it.
type CommandGitFetchRtnData struct {
	FetchedAt int64 `json:"fetchedat"`
	// A missing remote or a credential prompt is a state the surface draws, not an RPC error: the
	// shipped GitFailure panel renders git's own stderr out of this.
	Failure *gitinfo.GitFailure `json:"failure,omitempty"`
	IsRepo  bool                `json:"isrepo"`
}
