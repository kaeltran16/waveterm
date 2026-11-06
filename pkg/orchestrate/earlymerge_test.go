// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const sharedLines = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"

// earlyLanes is a project on main holding shared.txt, lane a's branch from main with one commit, and lane b's
// branch from a's tip, as an early start creates it. It returns the project, a's tree and a's tip (b's
// EarlyBaseCommit).
func earlyLanes(t *testing.T, aShared, bShared string) (dir, wtA, tipA string) {
	t.Helper()
	ctx := context.Background()
	dir = newGitRepo(t)
	writeFile(t, filepath.Join(dir, "shared.txt"), sharedLines)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "shared")
	wtA, err := CreateRunWorktree(ctx, dir, "lane-a", gitCmd(t, dir, "rev-parse", "HEAD"))
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(wtA, "a.txt"), "a\n")
	writeFile(t, filepath.Join(wtA, "shared.txt"), aShared)
	gitCmd(t, wtA, "add", ".")
	gitCmd(t, wtA, "commit", "-m", "feat(a): add a")
	tipA = gitCmd(t, wtA, "rev-parse", "HEAD")
	wtB, err := CreateRunWorktree(ctx, dir, "lane-b", tipA)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(wtB, "b.txt"), "b\n")
	writeFile(t, filepath.Join(wtB, "shared.txt"), bShared)
	gitCmd(t, wtB, "add", ".")
	gitCmd(t, wtB, "commit", "-m", "feat(b): add b")
	return dir, wtA, tipA
}

func TestEarlyDependentSquashMergesCleanAfterPredecessor(t *testing.T) {
	ctx := context.Background()
	aShared := strings.Replace(sharedLines, "two", "TWO", 1)
	bShared := strings.Replace(aShared, "nine", "NINE", 1)
	dir, _, tipA := earlyLanes(t, aShared, bShared)

	if _, err := MergeRunWorktree(ctx, dir, "lane-a", MergeLane{Title: "a", TaskIDs: []string{"t-1"}}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := MergeRunWorktree(ctx, dir, "lane-b", MergeLane{Title: "b", TaskIDs: []string{"t-2"}, Base: tipA}, nil); err != nil {
		t.Fatalf("a's changes are on both sides and merge cleanly, got %v", err)
	}
	for _, f := range []string{"a.txt", "b.txt"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Fatalf("%s missing after both squashes: %v", f, err)
		}
	}
	// core.autocrlf may check it out with CRLF
	if got := strings.ReplaceAll(readFile(t, filepath.Join(dir, "shared.txt")), "\r\n", "\n"); got != bShared {
		t.Fatalf("shared.txt = %q, want both lanes' edits", got)
	}
	if got := gitCmd(t, dir, "log", "-1", "--format=%B"); got != "feat(b): add b" {
		t.Fatalf("b's squash message = %q, want only b's commits", got)
	}
}

func TestEarlyDependentRealDifferenceConflicts(t *testing.T) {
	ctx := context.Background()
	aShared := strings.Replace(sharedLines, "two", "TWO", 1)
	bShared := strings.Replace(sharedLines, "two", "b-two", 1)
	dir, wtA, tipA := earlyLanes(t, aShared, bShared)
	// a's fix round after b branched: a line b also changed
	writeFile(t, filepath.Join(wtA, "shared.txt"), strings.Replace(sharedLines, "two", "a-fixed", 1))
	gitCmd(t, wtA, "commit", "-am", "fix(a): fix a")

	if _, err := MergeRunWorktree(ctx, dir, "lane-a", MergeLane{Title: "a", TaskIDs: []string{"t-1"}}, nil); err != nil {
		t.Fatal(err)
	}
	_, err := MergeRunWorktree(ctx, dir, "lane-b", MergeLane{Title: "b", TaskIDs: []string{"t-2"}, Base: tipA}, nil)
	if !errors.Is(err, ErrMergeConflict) {
		t.Fatalf("a real difference goes to the conflict path, got %v", err)
	}
}

// earlyMergeFixture is a merge fixture whose tasks in done are finished, each in base starting early on its value,
// with every squash stubbed to land and recorded by task id in merge order.
func earlyMergeFixture(t *testing.T, tasks []waveobj.TaskNode, done []string, base map[string]string) (*mergeFixture, *[]string) {
	t.Helper()
	f := newMergeFixture(t, tasks)
	for _, id := range done {
		f.finish(t, id)
	}
	if err := updateDagForTest(f, func(g *waveobj.TaskGroup) {
		for id, b := range base {
			taskByID(g, id).EarlyBaseTask = b
			taskByID(g, id).EarlyBaseCommit = "tip-of-" + b
		}
	}); err != nil {
		t.Fatal(err)
	}
	keys := map[string]string{}
	g := f.dag(t)
	for _, task := range tasks {
		keys[LaneWorktreeKey(g, task.ID)] = task.ID
	}
	var merged []string
	stubMerge(t, func(_ context.Context, _, runID, _ string) (string, error) {
		merged = append(merged, keys[runID])
		return "sha-" + keys[runID], nil
	})
	var spawned []string
	stubSpawn(t, &spawned)
	return f, &merged
}

func updateDagForTest(f *mergeFixture, fn func(g *waveobj.TaskGroup)) error {
	return wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		fn(cur)
		RecomputeDagStatus(cur)
		return nil
	})
}

func assertOffered(t *testing.T, f *mergeFixture, want ...string) {
	t.Helper()
	if got := autoMergeable(f.dag(t)); !slices.Equal(got, want) {
		t.Fatalf("autoMergeable = %v, want %v", got, want)
	}
}

func TestEarlyLaneHeldUntilBaseLaneMerged(t *testing.T) {
	// x keeps b a lane of its own; y does the same for c
	t.Run("base lane unmerged", func(t *testing.T) {
		f, merged := earlyMergeFixture(t, []waveobj.TaskNode{
			{ID: "a", Label: "a"},
			{ID: "b", Label: "b", Deps: []string{"a"}},
			{ID: "x", Label: "x", Deps: []string{"a"}},
		}, []string{"a", "b"}, map[string]string{"b": "a"})

		assertOffered(t, f, "a")
		if g := f.dag(t); mergeReadyTip(g, taskByID(g, "b")) {
			t.Fatal("the digest must not offer b's merge before a's lane merged")
		}
		err := MergeTask(f.ctx, f.channel, f.ownerID, "b")
		if !errors.Is(err, errProjectBusy) || !strings.Contains(err.Error(), "task a's lane") {
			t.Fatalf("an explicit merge of b must be refused naming a, got %v", err)
		}
		if len(*merged) != 0 {
			t.Fatalf("the refusal comes before any git work, merged %v", *merged)
		}

		if err := MergeTask(f.ctx, f.channel, f.ownerID, "a"); err != nil {
			t.Fatal(err)
		}
		assertOffered(t, f, "b")
		if err := MergeTask(f.ctx, f.channel, f.ownerID, "b"); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(*merged, []string{"a", "b"}) {
			t.Fatalf("merge order = %v, want a then b", *merged)
		}
	})

	t.Run("base review-failed until the lead approves", func(t *testing.T) {
		f, merged := earlyMergeFixture(t, []waveobj.TaskNode{
			{ID: "a", Label: "a"},
			{ID: "b", Label: "b", Deps: []string{"a"}},
			{ID: "x", Label: "x", Deps: []string{"a"}},
		}, []string{"a", "b"}, map[string]string{"b": "a"})
		if err := updateDagForTest(f, func(g *waveobj.TaskGroup) { taskByID(g, "a").State = TaskState_ReviewFailed }); err != nil {
			t.Fatal(err)
		}

		assertOffered(t, f)
		if err := MergeTask(f.ctx, f.channel, f.ownerID, "b"); !errors.Is(err, errProjectBusy) {
			t.Fatalf("b is held while a's review failed, got %v", err)
		}

		// approve schedules a tick, which lands a; the next lands b
		if err := ApplyAction(f.ctx, f.dagID, "a", "approve", waveobj.RoutePin{}); err != nil {
			t.Fatal(err)
		}
		if err := Schedule(f.ctx, f.dagID); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(*merged, []string{"a", "b"}) {
			t.Fatalf("merge order = %v, want a then b", *merged)
		}
	})

	t.Run("chain", func(t *testing.T) {
		f, merged := earlyMergeFixture(t, []waveobj.TaskNode{
			{ID: "a", Label: "a"},
			{ID: "b", Label: "b", Deps: []string{"a"}},
			{ID: "x", Label: "x", Deps: []string{"a"}},
			{ID: "c", Label: "c", Deps: []string{"b"}},
			{ID: "y", Label: "y", Deps: []string{"b"}},
		}, []string{"a", "b", "c"}, map[string]string{"b": "a", "c": "b"})

		for _, next := range []string{"a", "b", "c"} {
			assertOffered(t, f, next)
			if err := Schedule(f.ctx, f.dagID); err != nil {
				t.Fatal(err)
			}
			if !taskByID(f.dag(t), next).Merged {
				t.Fatalf("%s must land once its base merged", next)
			}
		}
		if !reflect.DeepEqual(*merged, []string{"a", "b", "c"}) {
			t.Fatalf("merge order = %v, want a, b, c", *merged)
		}
	})
}
