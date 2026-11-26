// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memhygiene

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// rowsRunning holds the projects with a row apply in flight: one at a time per project.
var rowsRunning sync.Map

// rowsApplyFailed is an apply error that stops a row: it comes back on the result, never stored.
type rowsApplyFailed struct {
	title string
	err   error
}

func (f rowsApplyFailed) Error() string { return f.err.Error() }

// ApplyRow applies one waiting row of the Memory tab as one decision: a whole split, a whole cleanup,
// or one move into a repo doc. Each change applies in its own Update, so the tab sees the progress.
func ApplyRow(ctx context.Context, project, row, changeID string) (*wshrpc.MemRowResult, error) {
	if _, busy := rowsRunning.LoadOrStore(project, true); busy {
		return nil, fmt.Errorf("memory hygiene: an apply is already running in %s", project)
	}
	defer rowsRunning.Delete(project)
	var res *wshrpc.MemRowResult
	var err error
	switch row {
	case wshrpc.MemRow_Split:
		res, err = rowsSplit(ctx, project)
	case wshrpc.MemRow_Cleanup:
		res, err = rowsCleanup(ctx, project)
	case wshrpc.MemRow_Doc:
		res, err = rowsDoc(project, changeID)
	default:
		return nil, fmt.Errorf("memory hygiene: unknown row %q in %s", row, project)
	}
	var failed rowsApplyFailed
	if errors.As(err, &failed) && res != nil {
		res.Stop, res.Failed, res.Error, err = wshrpc.MemStop_Failed, failed.title, failed.Error(), nil
	}
	if err != nil {
		return nil, err
	}
	// the project as List shows it, undo blocks included
	projects, err := ListProjects()
	if err != nil {
		return nil, err
	}
	if i := slices.IndexFunc(projects, func(p wshrpc.MemHygieneProject) bool { return p.Project == project }); i >= 0 {
		res.Project = projects[i]
	}
	return res, nil
}

// rowsSplit brings over every shared move and copy not left out, then switches over. It stops before
// switching while a memory changed since the check or one is newer than it, since only a fresh check
// can sort those.
func rowsSplit(ctx context.Context, project string) (*wshrpc.MemRowResult, error) {
	st, err := Load(project)
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(st.Changes, func(c wshrpc.MemChange) bool { return c.Kind == splitKindSettings })
	if i < 0 {
		return nil, fmt.Errorf("memory hygiene: %s has no split to apply", project)
	}
	settings := st.Changes[i]
	if !Pending(settings) {
		return nil, entryRefuse(st, &settings, wshrpc.MemVerdict_Apply)
	}
	batchID, err := rowsSplitAdopt(project)
	if err != nil {
		return nil, err
	}
	var stop error
	for _, c := range st.Changes {
		if !rowsSplitMember(c) || !Pending(c) {
			continue
		}
		if ctx.Err() != nil {
			break
		}
		if _, stop = rowsApplyOne(project, c.Id, wshrpc.MemBatch_Split, batchID); stop != nil {
			break
		}
	}
	res := &wshrpc.MemRowResult{}
	if st, err = rowsSplitCount(project, res); err != nil {
		return nil, err
	}
	if stop != nil || ctx.Err() != nil {
		return res, stop
	}
	if res.Newer, err = rowsNewer(st); err != nil {
		return nil, err
	}
	if res.Changed > 0 {
		res.Stop = wshrpc.MemStop_Changed
		return res, nil
	}
	if res.Newer > 0 {
		res.Stop = wshrpc.MemStop_Newer
		return res, nil
	}
	conflict, err := rowsApplyOne(project, settings.Id, wshrpc.MemBatch_Split, batchID)
	if err == nil && conflict != "" {
		err = rowsApplyFailed{settings.Title, fmt.Errorf("memory hygiene: %s changed since the check; check %s again to switch over", conflict, project)}
	}
	return res, err
}

// rowsSplitMember: a shared move or copy, what a split brings over.
func rowsSplitMember(c wshrpc.MemChange) bool {
	return c.Group == splitGroupShared && (c.Kind == splitKindMove || c.Kind == splitKindCopy)
}

// rowsSplitAdopt returns the project's split batch, creating it, and takes in every shared change
// already applied (one at a time, or by an earlier Apply), so one Undo reverses them all.
func rowsSplitAdopt(project string) (string, error) {
	var id string
	_, err := Update(project, func(st *State) error {
		i := slices.IndexFunc(st.Batches, func(b wshrpc.MemBatch) bool { return b.Kind == wshrpc.MemBatch_Split })
		var b wshrpc.MemBatch
		if i >= 0 {
			b = st.Batches[i]
		} else {
			var err error
			if b.Id, err = applyNewID(time.Now()); err != nil {
				return err
			}
			b.Kind, b.Skipped = wshrpc.MemBatch_Split, []wshrpc.MemSkip{}
		}
		id = b.Id
		for _, c := range st.Changes {
			if rowsSplitMember(c) && c.Status == checkStatusApplied && !slices.Contains(b.ChangeIds, c.Id) {
				b.ChangeIds = append(b.ChangeIds, c.Id)
				b.At = max(b.At, c.DecidedAt)
			}
		}
		if len(b.ChangeIds) > 0 {
			recordBatch(st, b)
		}
		return nil
	})
	return id, err
}

// rowsSplitCount fills the result's memory counts from the stored state, and returns that state.
func rowsSplitCount(project string, res *wshrpc.MemRowResult) (*State, error) {
	st, err := Load(project)
	if err != nil {
		return nil, err
	}
	for _, c := range st.Changes {
		if !rowsSplitMember(c) || c.Status == checkStatusKept {
			continue
		}
		n := len(c.Op.Memories)
		res.Total += n
		switch c.Status {
		case checkStatusApplied:
			res.Here += n
		case splitStatusConflict:
			res.Changed += n
		}
	}
	return st, nil
}

// rowsNewer counts the memories in a sharing project's shared folder written since its last sort.
// Switching over would leave them out of the project's sessions unsorted.
func rowsNewer(st *State) (int, error) {
	if len(st.SharedWith) == 0 || !discoverIsDir(st.Folder) {
		return 0, nil
	}
	inv, err := ReadInventory(st.Folder)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, m := range inv.Memories {
		if _, ok := st.Sort[m.Name]; !ok {
			n++
		}
	}
	return n, nil
}

// rowsCleanup removes each open memory of the shared folder no project loads, into one batch. One a
// project left out of its split is kept instead: an older proposal can predate the leave-out.
func rowsCleanup(ctx context.Context, project string) (*wshrpc.MemRowResult, error) {
	st, err := Load(project)
	if err != nil {
		return nil, err
	}
	removals := slices.DeleteFunc(slices.Clone(st.Changes), func(c wshrpc.MemChange) bool {
		return c.Kind != splitKindRemove || !rowsOpen(c)
	})
	if len(removals) == 0 {
		return nil, fmt.Errorf("memory hygiene: %s has no shared memories to clear", project)
	}
	leftOut, err := rowsLeftOut(registryFn())
	if err != nil {
		return nil, err
	}
	batchID, err := applyNewID(time.Now())
	if err != nil {
		return nil, err
	}
	res := &wshrpc.MemRowResult{}
	for _, c := range removals {
		if ctx.Err() != nil {
			return res, nil
		}
		if rowsAnyIn(checkMemoryPaths(c), leftOut) {
			if err := rowsKeep(project, c.Id); err != nil {
				return nil, err
			}
			continue
		}
		if _, err := rowsApplyOne(project, c.Id, wshrpc.MemBatch_Cleanup, batchID); err != nil {
			return res, err
		}
	}
	return res, nil
}

// rowsKeep keeps an open change: the user already kept what it acts on.
func rowsKeep(project, changeID string) error {
	_, err := Update(project, func(st *State) error {
		if c := undoFind(st, changeID); c != nil && rowsOpen(*c) {
			c.Status, c.DecidedAt = checkStatusKept, time.Now().UnixMilli()
		}
		return nil
	})
	return err
}

// rowsDoc applies one move into a repo doc as its own batch.
func rowsDoc(project, changeID string) (*wshrpc.MemRowResult, error) {
	st, err := Load(project)
	if err != nil {
		return nil, err
	}
	c := undoFind(st, changeID)
	if c == nil || c.Kind != judgeKindMoveToDoc {
		return nil, fmt.Errorf("memory hygiene: %s has no move into a repo doc %s", project, changeID)
	}
	if !Pending(*c) {
		return nil, entryRefuse(st, c, wshrpc.MemVerdict_Apply)
	}
	batchID, err := applyNewID(time.Now())
	if err != nil {
		return nil, err
	}
	res := &wshrpc.MemRowResult{}
	conflict, err := rowsApplyOne(project, changeID, wshrpc.MemBatch_Doc, batchID)
	if err == nil && conflict != "" {
		res.Stop, res.Changed = wshrpc.MemStop_Changed, len(c.Op.Memories)
	}
	return res, err
}

// rowsApplyOne applies one pending change in its own Update and records it in the batch. A change no
// longer pending (decided while the row ran, or gone after a check) is passed over. It returns the
// conflict file when the change's files changed since the check; an apply error is rowsApplyFailed
// and stores nothing.
func rowsApplyOne(project, changeID, kind, batchID string) (string, error) {
	var conflict string
	_, err := Update(project, func(st *State) error {
		c := undoFind(st, changeID)
		if c == nil || !Pending(*c) {
			return nil
		}
		now := time.Now()
		if err := entryApply(st, c, now); err != nil {
			return rowsApplyFailed{c.Title, err}
		}
		if c.Status == splitStatusConflict {
			conflict = c.ConflictFile
		} else {
			rowsRecord(st, kind, batchID, c.Id, now)
		}
		return checkRemeasure(st)
	})
	return conflict, err
}

// rowsRecord adds an applied change to the batch with id, creating it.
func rowsRecord(st *State, kind, batchID, changeID string, now time.Time) {
	b := wshrpc.MemBatch{Id: batchID, Kind: kind, Skipped: []wshrpc.MemSkip{}}
	if i := slices.IndexFunc(st.Batches, func(x wshrpc.MemBatch) bool { return x.Id == batchID }); i >= 0 {
		b = st.Batches[i]
	}
	if !slices.Contains(b.ChangeIds, changeID) {
		b.ChangeIds = append(b.ChangeIds, changeID)
	}
	b.At = now.UnixMilli()
	recordBatch(st, b)
}

func rowsOpen(c wshrpc.MemChange) bool {
	return c.Status == "" || c.Status == splitStatusOpen
}

// rowsLeftOut is every shared memory path a registered project left out of its split (a kept move or
// copy). A cleanup never proposes or removes one.
func rowsLeftOut(registry map[string]string) (map[string]bool, error) {
	out := map[string]bool{}
	for name := range registry {
		st, err := Load(name)
		if err != nil {
			return nil, err
		}
		for _, c := range st.Changes {
			if rowsSplitMember(c) && c.Status == checkStatusKept {
				for _, p := range checkMemoryPaths(c) {
					out[rowsPathKey(p)] = true
				}
			}
		}
	}
	return out, nil
}

// rowsPathKey compares paths as discovery compares folders: cleaned, and case-insensitively.
func rowsPathKey(p string) string {
	return strings.ToLower(filepath.Clean(p))
}

func rowsAnyIn(paths []string, set map[string]bool) bool {
	return slices.ContainsFunc(paths, func(p string) bool { return set[rowsPathKey(p)] })
}

// rowsUndoBlock is the cleanup batch, of any project in all, that removed a memory the split batch b
// copied; nil when none did. Undoing the split first would leave the project's sessions without it.
func rowsUndoBlock(changes []wshrpc.MemChange, b wshrpc.MemBatch, all []wshrpc.MemHygieneProject) *wshrpc.MemUndoBlock {
	copied := map[string]bool{}
	for _, c := range changes {
		if c.Kind == splitKindCopy && c.Status == checkStatusApplied && slices.Contains(b.ChangeIds, c.Id) {
			for _, p := range checkMemoryPaths(c) {
				copied[rowsPathKey(p)] = true
			}
		}
	}
	if len(copied) == 0 {
		return nil
	}
	for _, p := range all {
		for _, cb := range p.Batches {
			if cb.Kind != wshrpc.MemBatch_Cleanup {
				continue
			}
			n := 0
			for _, c := range p.Changes {
				if c.Kind != splitKindRemove || c.Status != checkStatusApplied || !slices.Contains(cb.ChangeIds, c.Id) {
					continue
				}
				for _, path := range checkMemoryPaths(c) {
					if copied[rowsPathKey(path)] {
						n++
					}
				}
			}
			if n > 0 {
				return &wshrpc.MemUndoBlock{Project: p.Project, BatchId: cb.Id, At: cb.At, Memories: n}
			}
		}
	}
	return nil
}

// rowsUndoRefusal is UndoBatch's refusal of a split batch a cleanup blocks.
func rowsUndoRefusal(project string, blk *wshrpc.MemUndoBlock) error {
	return fmt.Errorf("memory hygiene: can't undo the split of %s: clearing %s's memory on %s removed %d memories it brought over; undo that cleanup (%s) first",
		project, blk.Project, time.UnixMilli(blk.At).Format(entryDateLayout), blk.Memories, blk.BatchId)
}

// RowFailed is the waiting row of a project whose last check failed.
const RowFailed = "failed"

// WaitingRows is what waits for the user in a project, one entry per row: a pending split not kept
// sharing, open removals from a shared memory, each open move into a repo doc, a failed check.
// memorymodel.ts builds its waiting rows by the same rule.
func WaitingRows(p wshrpc.MemHygieneProject) []string {
	var split, cleanup bool
	var docs int
	for _, c := range p.Changes {
		switch {
		case c.Kind == splitKindSettings && Pending(c):
			split = true
		case c.Kind == splitKindRemove && rowsOpen(c):
			cleanup = true
		case c.Kind == judgeKindMoveToDoc && rowsOpen(c):
			docs++
		}
	}
	var out []string
	if split {
		out = append(out, wshrpc.MemRow_Split)
	}
	if cleanup {
		out = append(out, wshrpc.MemRow_Cleanup)
	}
	for range docs {
		out = append(out, wshrpc.MemRow_Doc)
	}
	if p.LastError != "" {
		out = append(out, RowFailed)
	}
	return out
}

// Waiting counts what waits for the user in a project, as the tab's count does.
func Waiting(p wshrpc.MemHygieneProject) int {
	return len(WaitingRows(p))
}
