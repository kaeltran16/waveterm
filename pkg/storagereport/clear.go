// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const heldByGit = "being used by another process"

// clearItem re-reads the item and deletes it only if it still loses nothing; force (Delete anyway) also takes one
// skipped for its commits or uncommitted files, if its branch is still at tip. It returns the bytes it freed.
// Probing here, right before the delete, sees what the items cleared before it changed: two branches sharing
// commits both lose nothing until one of them goes.
func clearItem(ctx context.Context, item wshrpc.StorageItem, force bool, tip string) (int64, error) {
	if keptKinds[item.Kind] {
		return 0, fmt.Errorf("%s is kept, never cleared", item.Id)
	}
	fresh, err := probe(ctx, item)
	if errors.Is(err, ErrGone) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if err := stillClearable(fresh, force, tip); err != nil {
		return 0, err
	}
	if err := removeItem(ctx, fresh); err != nil {
		return 0, err
	}
	return fresh.Size, nil
}

func skipped(msg string) error { return &ClearError{Skipped: true, Msg: msg} }

// stillClearable is nil when fresh may be deleted, else a Skipped ClearError saying what changed since the scan.
func stillClearable(fresh wshrpc.StorageItem, force bool, tip string) error {
	if fresh.Group == wshrpc.StorageGroup_InUse {
		return skipped(fmt.Sprintf("its run is %s again", fresh.RunStatus))
	}
	if fresh.Group != wshrpc.StorageGroup_Left {
		return fmt.Errorf("%s is %s, never cleared", fresh.Id, fresh.Group)
	}
	if force {
		if fresh.BranchTip != tip {
			return skipped("the branch moved since you looked")
		}
		if fresh.Skip == wshrpc.StorageSkip_Commits || fresh.Skip == wshrpc.StorageSkip_Dirty {
			return nil
		}
	} else if fresh.Clearable {
		return nil
	}
	switch fresh.Skip {
	case wshrpc.StorageSkip_Dirty:
		return skipped("it has uncommitted files")
	case wshrpc.StorageSkip_Commits:
		return skipped("the branch has commits on no other branch")
	case wshrpc.StorageSkip_Unreadable:
		return skipped("its run or git state can no longer be read")
	}
	return skipped("it changed since you looked")
}

func removeItem(ctx context.Context, fresh wshrpc.StorageItem) error {
	switch fresh.Kind {
	case wshrpc.StorageKind_RunTree, wshrpc.StorageKind_LegacyTree:
		return removeTree(ctx, fresh)
	case wshrpc.StorageKind_Branch:
		key := strings.TrimPrefix(fresh.Branch, waveBranchPrefix)
		return clearErr(orchestrate.RemoveRunWorktreeExclusive(ctx, fresh.ProjectPath, key, ""))
	case wshrpc.StorageKind_LegacyGroup, wshrpc.StorageKind_FinalOut:
		return removeMembers(fresh.Paths)
	}
	return fmt.Errorf("%s: clearing a %s row is not supported", fresh.Id, fresh.Kind)
}

// removeTree removes a tree folder through the engine when a project owns it, which also takes its wave/<key>
// branch; a folder no project owns is deleted on its own.
func removeTree(ctx context.Context, fresh wshrpc.StorageItem) error {
	if fresh.ProjectPath == "" {
		return clearErr(orchestrate.RemoveDirExclusive(fresh.Path))
	}
	key := treeKey(fresh)
	if key == "" {
		key = filepath.Base(fresh.Path)
	}
	if fresh.Branch == "" {
		// a no-key tree's row shows no branch, yet the engine deletes wave/<name> with it
		if err := branchLosesNothing(ctx, fresh, waveBranchPrefix+key); err != nil {
			return err
		}
	}
	want := fresh.Path
	if _, err := os.Lstat(want); errors.Is(err, fs.ErrNotExist) {
		want = "" // only the branch is left
	}
	return clearErr(orchestrate.RemoveRunWorktreeExclusive(ctx, fresh.ProjectPath, key, want))
}

func branchLosesNothing(ctx context.Context, tree wshrpc.StorageItem, branch string) error {
	b, err := probe(ctx, wshrpc.StorageItem{Id: branchItemId(tree.ProjectPath, branch), Kind: wshrpc.StorageKind_Branch, ProjectName: tree.ProjectName, ProjectPath: tree.ProjectPath, Branch: branch})
	if errors.Is(err, ErrGone) {
		return nil
	}
	if err != nil {
		return err
	}
	if !b.Clearable {
		return skipped(fmt.Sprintf("its branch %s has commits on no other branch", branch))
	}
	return nil
}

// removeMembers deletes a group row's members one by one; any member that stays fails the row.
func removeMembers(paths []string) error {
	failed, held := 0, false
	for _, path := range paths {
		err := removeMember(path)
		if err == nil {
			continue
		}
		log.Printf("storage clear %s: %v", path, err)
		failed++
		held = held || isHeld(err)
	}
	if failed == 0 {
		return nil
	}
	return &ClearError{Held: held, Msg: fmt.Sprintf("%d of %d couldn't be cleared", failed, len(paths))}
}

func removeMember(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return orchestrate.RemoveDirExclusive(path)
	}
	return os.Remove(path)
}

// clearErr maps a removal's failure onto what the row shows. No retry: a held folder stays until its holder lets go.
func clearErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, orchestrate.ErrTreeBusy):
		return &ClearError{Msg: "the engine is removing it"}
	case isHeld(err):
		log.Printf("storage clear: %v", err)
		return &ClearError{Held: true, Msg: "a process has it open"}
	}
	return err
}
