// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memhygiene

import (
	"fmt"
	"slices"
	"sort"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// routineKind: Arc applies these after each check without asking. The judge only runs on a folder the
// project owns, so they never touch a shared memory or a checked-in file.
func routineKind(kind string) bool {
	switch kind {
	case judgeKindTrim, judgeKindDelete, judgeKindMerge, judgeKindAddToIndex:
		return true
	}
	return false
}

// autoApply applies every open routine change in the project, not only the last check's, and records
// what it applied as one routine batch.
func autoApply(project string) error {
	_, err := Update(project, func(st *State) error {
		if err := autoApplyState(st, time.Now()); err != nil {
			return err
		}
		return checkRemeasure(st)
	})
	return err
}

func autoApplyState(st *State, now time.Time) error {
	folder := autoIndexFolder(st)
	before, err := checkMeasureIndex(folder)
	if err != nil {
		return err
	}
	b := wshrpc.MemBatch{Kind: wshrpc.MemBatch_Routine, At: now.UnixMilli(), Skipped: []wshrpc.MemSkip{}, IndexBefore: before}
	written := map[string]bool{}
	for i := range st.Changes {
		c := &st.Changes[i]
		if !routineKind(c.Kind) || (c.Status != "" && c.Status != splitStatusOpen) {
			continue
		}
		skip := wshrpc.MemSkip{ChangeId: c.Id, Kind: c.Kind, Title: c.Title}
		paths := checkMemoryPaths(*c)
		if hit := slices.IndexFunc(paths, func(p string) bool { return written[p] }); hit >= 0 {
			// it can't apply over the earlier change, and blaming the user's edit would be false
			c.Status, c.ConflictFile, c.DecidedAt = splitStatusConflict, paths[hit], now.UnixMilli()
			skip.Reason = wshrpc.MemSkip_Overlap
			b.Skipped = append(b.Skipped, skip)
			continue
		}
		if err := entryApply(st, c, now); err != nil {
			skip.Reason, skip.Error = wshrpc.MemSkip_Failed, err.Error()
			b.Skipped = append(b.Skipped, skip)
			continue
		}
		if c.Status == splitStatusConflict {
			skip.Reason = wshrpc.MemSkip_Changed
			b.Skipped = append(b.Skipped, skip)
			continue
		}
		b.ChangeIds = append(b.ChangeIds, c.Id)
		for _, p := range paths {
			written[p] = true
		}
	}
	if len(b.ChangeIds) == 0 {
		return nil
	}
	if b.IndexAfter, err = checkMeasureIndex(folder); err != nil {
		return err
	}
	if b.Id, err = applyNewID(now); err != nil {
		return err
	}
	recordBatch(st, b)
	return nil
}

// autoIndexFolder is the index routine changes edit: the own folder's during a split that hasn't
// switched over, else the project's folder.
func autoIndexFolder(st *State) string {
	if len(st.SharedWith) > 0 && st.OwnFolder != "" {
		return st.OwnFolder
	}
	return st.Folder
}

// recordBatch adds b, or replaces the batch with its id, keeping the newest first.
func recordBatch(st *State, b wshrpc.MemBatch) {
	st.Batches = slices.DeleteFunc(st.Batches, func(x wshrpc.MemBatch) bool { return x.Id == b.Id })
	st.Batches = append(st.Batches, b)
	sort.SliceStable(st.Batches, func(i, j int) bool { return st.Batches[i].At > st.Batches[j].At })
}

// pruneBatches drops every batch none of whose changes is still applied.
func pruneBatches(st *State) {
	applied := map[string]bool{}
	for _, c := range st.Changes {
		if c.Status == checkStatusApplied {
			applied[c.Id] = true
		}
	}
	st.Batches = slices.DeleteFunc(st.Batches, func(b wshrpc.MemBatch) bool {
		return !slices.ContainsFunc(b.ChangeIds, func(id string) bool { return applied[id] })
	})
}

// UndoBatch undoes one change of a batch, or the whole batch in reverse apply order. A whole-batch
// undo stops at the first change it can't undo, keeps every undo before it, and says how far it got.
func UndoBatch(project, batchID, changeID string) (*wshrpc.MemHygieneProject, error) {
	// loaded before the project's lock: loading another project under it could deadlock
	var others []wshrpc.MemHygieneProject
	if changeID == "" {
		var err error
		if others, err = undoOthers(project); err != nil {
			return nil, err
		}
	}
	var stopped error
	st, err := Update(project, func(st *State) error {
		i := slices.IndexFunc(st.Batches, func(b wshrpc.MemBatch) bool { return b.Id == batchID })
		if i < 0 {
			return fmt.Errorf("memory hygiene: %s has no batch %s", project, batchID)
		}
		b := st.Batches[i]
		now := time.Now()
		if b.Kind == wshrpc.MemBatch_Split && changeID == "" {
			if blk := rowsUndoBlock(st.Changes, b, append(others, st.MemHygieneProject)); blk != nil {
				return rowsUndoRefusal(project, blk)
			}
		}
		if changeID != "" {
			if err := undoOne(st, b, changeID, now); err != nil {
				return err
			}
		} else {
			stopped = undoWhole(st, b, now)
		}
		pruneBatches(st)
		if err := undoRestoreShared(st); err != nil {
			return err
		}
		return checkRemeasure(st)
	})
	if err != nil {
		return nil, err
	}
	return &st.MemHygieneProject, stopped
}

func undoOne(st *State, b wshrpc.MemBatch, changeID string, now time.Time) error {
	if b.Kind == wshrpc.MemBatch_Split {
		// one move undone after the switch would put that memory back where the project no longer loads
		return fmt.Errorf("memory hygiene: a split in %s undoes only as a whole", st.Project)
	}
	if !slices.Contains(b.ChangeIds, changeID) {
		return fmt.Errorf("memory hygiene: batch %s of %s has no change %s", b.Id, st.Project, changeID)
	}
	c := undoFind(st, changeID)
	if c == nil {
		return fmt.Errorf("memory hygiene: %s has no change %s", st.Project, changeID)
	}
	return entryUndo(st, c, now)
}

// undoWhole skips a change already undone on its own, or dropped once its backup expired.
func undoWhole(st *State, b wshrpc.MemBatch, now time.Time) error {
	undone := 0
	for _, id := range slices.Backward(b.ChangeIds) {
		c := undoFind(st, id)
		if c == nil || c.Status != checkStatusApplied {
			continue
		}
		if err := entryUndo(st, c, now); err != nil {
			return fmt.Errorf("%w (undid %d of the batch's %d changes before it)", err, undone, len(b.ChangeIds))
		}
		undone++
	}
	return nil
}

// undoRestoreShared puts back the shared folder a split waits on. A check after the switch measured
// the own folder as unshared, and the tab shows a split only for a project sharing its folder, so an
// undone switch would otherwise hide the split that waits again until the next check.
func undoRestoreShared(st *State) error {
	i := slices.IndexFunc(st.Changes, func(c wshrpc.MemChange) bool { return c.Kind == splitKindSettings })
	if i < 0 || !Pending(st.Changes[i]) || len(st.SharedWith) > 0 {
		return nil
	}
	resolved := Discover(registryFn(), claudeHomeFn())
	j := slices.IndexFunc(resolved, func(r Resolved) bool { return r.Project == st.Project })
	if j < 0 || resolved[j].Skip != "" || len(resolved[j].SharedWith) == 0 {
		return nil
	}
	r := resolved[j]
	inv, err := ReadInventory(r.Folder)
	if err != nil {
		return fmt.Errorf("memory hygiene: re-reading %s's shared memory after the undo: %w", st.Project, err)
	}
	st.Folder, st.SharedWith, st.OwnFolder, st.Memories = r.Folder, r.SharedWith, r.OwnFolder, len(inv.Memories)
	return nil
}

// undoOthers is every other registered project's state, for a split undo's block.
func undoOthers(project string) ([]wshrpc.MemHygieneProject, error) {
	var out []wshrpc.MemHygieneProject
	for name := range registryFn() {
		if name == project {
			continue
		}
		st, err := Load(name)
		if err != nil {
			return nil, err
		}
		out = append(out, st.MemHygieneProject)
	}
	return out, nil
}

func undoFind(st *State, id string) *wshrpc.MemChange {
	if i := slices.IndexFunc(st.Changes, func(c wshrpc.MemChange) bool { return c.Id == id }); i >= 0 {
		return &st.Changes[i]
	}
	return nil
}
