// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) CreateProjectCommand(ctx context.Context, data wshrpc.CommandCreateProjectData) error {
	name := strings.TrimSpace(data.Name)
	if name == "" {
		return fmt.Errorf("project name is required")
	}
	path := strings.TrimSpace(data.Path)
	if path == "" {
		return fmt.Errorf("project path is required")
	}
	if strings.HasPrefix(path, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("cannot resolve home directory: %w", err)
		}
		path = filepath.Join(home, path[1:])
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("path does not exist: %s", path)
	}
	if !info.IsDir() {
		return fmt.Errorf("path is not a directory: %s", path)
	}
	return wconfig.SetProjectConfigValue(name, waveobj.MetaMapType{"path": path})
}

func (ws *WshServer) DeleteProjectCommand(ctx context.Context, data wshrpc.CommandDeleteProjectData) error {
	name := strings.TrimSpace(data.Name)
	if name == "" {
		return fmt.Errorf("project name is required")
	}
	return wconfig.DeleteProjectConfigValue(name)
}

func (ws *WshServer) CreateWorktreeCommand(ctx context.Context, data wshrpc.CommandCreateWorktreeData) (wshrpc.CommandCreateWorktreeRtnData, error) {
	wt, err := gitinfo.CreateWorktree(ctx, data.ProjectPath, data.Branch)
	if err != nil {
		return wshrpc.CommandCreateWorktreeRtnData{}, err
	}
	return wshrpc.CommandCreateWorktreeRtnData{WorktreePath: wt}, nil
}

func (ws *WshServer) ListBranchesCommand(ctx context.Context, data wshrpc.CommandListBranchesData) (wshrpc.CommandListBranchesRtnData, error) {
	branches, err := gitinfo.ListBranches(ctx, data.ProjectPath)
	if err != nil {
		return wshrpc.CommandListBranchesRtnData{}, err
	}
	rtn := wshrpc.CommandListBranchesRtnData{Branches: make([]wshrpc.BranchInfo, 0, len(branches))}
	for _, b := range branches {
		rtn.Branches = append(rtn.Branches, wshrpc.BranchInfo{Name: b.Name, Age: b.Age})
	}
	return rtn, nil
}

func (ws *WshServer) GitChangesCommand(ctx context.Context, data wshrpc.CommandGitChangesData) (*wshrpc.CommandGitChangesRtnData, error) {
	ch, err := gitinfo.GetChanges(ctx, data.Cwd, data.Ref)
	if err != nil {
		return nil, fmt.Errorf("git changes: %w", err)
	}
	return &wshrpc.CommandGitChangesRtnData{Branch: ch.Branch, StatusZ: ch.StatusZ, Numstat: ch.Numstat, IsRepo: ch.IsRepo}, nil
}

func (ws *WshServer) GitDiffCommand(ctx context.Context, data wshrpc.CommandGitDiffData) (*wshrpc.CommandGitDiffRtnData, error) {
	d, err := gitinfo.GetDiff(ctx, data.Cwd, data.Path, data.Ref)
	if err != nil {
		return nil, fmt.Errorf("git diff: %w", err)
	}
	return &wshrpc.CommandGitDiffRtnData{Diff: d.Diff, Content: d.Content, Untracked: d.Untracked}, nil
}

func (ws *WshServer) GitRevertCommand(ctx context.Context, data wshrpc.CommandGitRevertData) error {
	if data.Patch != "" {
		return gitinfo.RevertHunk(ctx, data.Cwd, data.Path, data.Patch)
	}
	return gitinfo.RevertFile(ctx, data.Cwd, data.Path, data.Status)
}
