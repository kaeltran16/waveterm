// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

type ProjectCommands interface {
	CreateProjectCommand(ctx context.Context, data CommandCreateProjectData) error
	DeleteProjectCommand(ctx context.Context, data CommandDeleteProjectData) error
	CreateWorktreeCommand(ctx context.Context, data CommandCreateWorktreeData) (CommandCreateWorktreeRtnData, error)
	ListBranchesCommand(ctx context.Context, data CommandListBranchesData) (CommandListBranchesRtnData, error)
	GitChangesCommand(ctx context.Context, data CommandGitChangesData) (*CommandGitChangesRtnData, error)
	GitDiffCommand(ctx context.Context, data CommandGitDiffData) (*CommandGitDiffRtnData, error)
	GitRevertCommand(ctx context.Context, data CommandGitRevertData) error
}

type CommandCreateProjectData struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type CommandDeleteProjectData struct {
	Name string `json:"name"`
}

type CommandCreateWorktreeData struct {
	ProjectPath string `json:"projectpath"`
	Branch      string `json:"branch"`
}

type CommandCreateWorktreeRtnData struct {
	WorktreePath string `json:"worktreepath"`
}

type CommandListBranchesData struct {
	ProjectPath string `json:"projectpath"`
}

type CommandListBranchesRtnData struct {
	Branches []BranchInfo `json:"branches"`
	// The repo's default branch as a local name, for the compare ref picker's base field. Additive:
	// the New Agent launcher calls this command for its worktree-branch suggestions and ignores it.
	// "" when the repo publishes no origin/HEAD and has neither main nor master.
	Default string `json:"default,omitempty"`
}

type CommandGitChangesData struct {
	Cwd string `json:"cwd"`
	Ref string `json:"ref,omitempty"`
	// SessionStartTs, when set, asks the backend to resolve the base as the commit that was HEAD at
	// this unix-seconds time (an agent's session start), so the diff reflects only that session's work
	// (commits since start + uncommitted). Takes precedence over Ref; the resolved base is echoed in
	// the response's Ref. 0 = fall through to Ref / live HEAD diff.
	SessionStartTs int64 `json:"sessionstartts,omitempty"`
}

type CommandGitChangesRtnData struct {
	Branch  string `json:"branch"`
	StatusZ string `json:"statusz"`
	Numstat string `json:"numstat"`
	IsRepo  bool   `json:"isrepo"`
	// Ref is the commit the changes were diffed against ("" = live working-tree-vs-HEAD). The frontend
	// threads this into GitDiff so per-file diffs use the same base the list did.
	Ref string `json:"ref,omitempty"`
	// Head is the commit HEAD points at, "" in a repository with no commits. The Diff surface polls
	// this command while it is on screen and compares Head against the sha its commit column was
	// built from, so a commit landing under the surface costs one log re-read and a quiet tick costs
	// nothing.
	Head string `json:"head,omitempty"`
}

type CommandGitDiffData struct {
	Cwd  string `json:"cwd"`
	Path string `json:"path"`
	Ref  string `json:"ref,omitempty"`
}

type CommandGitDiffRtnData struct {
	Diff      string `json:"diff"`
	Content   string `json:"content"`
	Untracked bool   `json:"untracked"`
}

type CommandGitRevertData struct {
	Cwd    string `json:"cwd"`
	Path   string `json:"path"`
	Status string `json:"status"`          // porcelain status; used for whole-file revert
	Patch  string `json:"patch,omitempty"` // if set, reverse-apply this patch; else whole-file
}
