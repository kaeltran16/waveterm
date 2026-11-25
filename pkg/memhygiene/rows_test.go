// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memhygiene

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// rowsTestSplit registers ca and det on one repo's shared memory: a.md and c.md apply to ca (moves),
// b.md to both (a copy), d.md to det. It runs ca's check and returns the folders and ca's settings path.
func rowsTestSplit(t *testing.T, env *checkTestEnv) (shared, own, settings string) {
	t.Helper()
	repo := initRepo(t)
	commit(t, repo, "subprojects", map[string]string{"ca/README.md": "ca\n", "det/README.md": "det\n"})
	shared = env.project(t, "ca", filepath.Join(repo, "ca"))
	env.project(t, "det", filepath.Join(repo, "det"))
	writeFile(t, filepath.Join(shared, "MEMORY.md"), "- [A](a.md) — alpha\n- [B](b.md) — beta\n- [C](c.md) — gamma\n- [D](d.md) — delta\n")
	for _, n := range []string{"a", "b", "c", "d"} {
		writeFile(t, filepath.Join(shared, n+".md"), n+" rule\n")
	}
	env.setReply(func(p string) (string, error) {
		if strings.HasPrefix(p, checkTestSortPrefix) {
			return `{"sort": {"a.md": ["ca"], "b.md": ["ca", "det"], "c.md": ["ca"], "d.md": ["det"]}}`, nil
		}
		return checkTestNoChanges, nil
	})
	checkTestRun(t, env, "ca")
	return shared, OwnFolderFor(filepath.Join(repo, "ca"), env.claudeHome), filepath.Join(repo, "ca", ".claude", "settings.local.json")
}

func rowsTestApply(t *testing.T, project, row, changeID string) *wshrpc.MemRowResult {
	t.Helper()
	res, err := ApplyRow(context.Background(), project, row, changeID)
	if err != nil {
		t.Fatalf("%s row of %s: %v", row, project, err)
	}
	return res
}

func rowsTestExists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Stat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return err == nil
}

func rowsTestBatches(st *State, kind string) []wshrpc.MemBatch {
	var out []wshrpc.MemBatch
	for _, b := range st.Batches {
		if b.Kind == kind {
			out = append(out, b)
		}
	}
	return out
}

// rowsTestChange finds the change whose op names memory, of kind.
func rowsTestChange(t *testing.T, st *State, kind, memory string) wshrpc.MemChange {
	t.Helper()
	for _, c := range st.Changes {
		if c.Kind == kind && slices.Contains(c.Op.Memories, memory) {
			return c
		}
	}
	t.Fatalf("no %s of %s in %+v", kind, memory, st.Changes)
	return wshrpc.MemChange{}
}

func TestApplyRowSplitBringsEverythingOverThenSwitches(t *testing.T) {
	env := checkTestSetup(t)
	shared, own, settings := rowsTestSplit(t, env)

	res := rowsTestApply(t, "ca", wshrpc.MemRow_Split, "")

	if res.Stop != "" || res.Here != 3 || res.Total != 3 || res.Project.Project != "ca" {
		t.Fatalf("stop/here/total/project = %q/%d/%d/%q, want done with 3 of 3", res.Stop, res.Here, res.Total, res.Project.Project)
	}
	if data, err := os.ReadFile(settings); err != nil || !strings.Contains(string(data), "autoMemoryDirectory") {
		t.Fatalf("settings = %q, %v", data, err)
	}
	for name, where := range map[string][2]bool{"a.md": {false, true}, "b.md": {true, true}, "c.md": {false, true}, "d.md": {true, false}} {
		if rowsTestExists(t, filepath.Join(shared, name)) != where[0] || rowsTestExists(t, filepath.Join(own, name)) != where[1] {
			t.Errorf("%s in shared/own: want %v", name, where)
		}
	}
	st := checkTestLoad(t, "ca")
	var split []string
	for _, c := range st.Changes {
		if c.Group == "shared" || c.Kind == "settings" {
			if c.Status != "applied" {
				t.Errorf("%s %q is %q", c.Kind, c.Title, c.Status)
			}
			split = append(split, c.Id)
		}
	}
	batches := rowsTestBatches(st, wshrpc.MemBatch_Split)
	if len(batches) != 1 || len(batches[0].ChangeIds) != 4 || batches[0].ChangeIds[3] != checkTestFind(t, st, "settings").Id {
		t.Fatalf("split batches = %+v, want one holding the 3 moves/copies then the switch", batches)
	}
	for _, id := range split {
		if !slices.Contains(batches[0].ChangeIds, id) {
			t.Fatalf("the split batch lacks %s", id)
		}
	}
}

func TestApplyRowSplitStopsOnAChangedMemoryThenFinishesAfterACheck(t *testing.T) {
	env := checkTestSetup(t)
	shared, own, settings := rowsTestSplit(t, env)
	writeFile(t, filepath.Join(shared, "c.md"), "c rule, edited\n")

	res := rowsTestApply(t, "ca", wshrpc.MemRow_Split, "")

	if res.Stop != wshrpc.MemStop_Changed || res.Changed != 1 || res.Here != 2 || res.Total != 3 {
		t.Fatalf("stop/changed/here/total = %q/%d/%d/%d, want changed 1 with 2 of 3 here", res.Stop, res.Changed, res.Here, res.Total)
	}
	if rowsTestExists(t, settings) || !rowsTestExists(t, filepath.Join(own, "a.md")) {
		t.Fatal("want a.md brought over and the settings untouched")
	}

	checkTestRun(t, env, "ca")
	res = rowsTestApply(t, "ca", wshrpc.MemRow_Split, "")

	if res.Stop != "" || res.Here != 3 || res.Total != 3 || !rowsTestExists(t, settings) {
		t.Fatalf("stop/here/total = %q/%d/%d, settings written %v: want done", res.Stop, res.Here, res.Total, rowsTestExists(t, settings))
	}
	if data, err := os.ReadFile(filepath.Join(own, "c.md")); err != nil || string(data) != "c rule, edited\n" {
		t.Fatalf("own c.md = %q, %v", data, err)
	}
	if b := rowsTestBatches(checkTestLoad(t, "ca"), wshrpc.MemBatch_Split); len(b) != 1 || len(b[0].ChangeIds) != 4 {
		t.Fatalf("split batches = %+v, want one holding both applies", b)
	}
}

func TestApplyRowSplitStopsOnANewerMemory(t *testing.T) {
	env := checkTestSetup(t)
	shared, _, settings := rowsTestSplit(t, env)
	writeFile(t, filepath.Join(shared, "e.md"), "written after the check\n")

	res := rowsTestApply(t, "ca", wshrpc.MemRow_Split, "")

	if res.Stop != wshrpc.MemStop_Newer || res.Newer != 1 || res.Here != 3 || rowsTestExists(t, settings) {
		t.Fatalf("stop/newer/here = %q/%d/%d, settings written %v: want newer 1, settings untouched", res.Stop, res.Newer, res.Here, rowsTestExists(t, settings))
	}
	if _, err := Decide("ca", checkTestFind(t, checkTestLoad(t, "ca"), "settings").Id, "apply"); err == nil || rowsTestExists(t, settings) {
		t.Fatalf("a direct switch-over past a newer memory: err %v", err)
	}
}

func TestApplyRowSplitStopsOnAFailedCopyAndResumes(t *testing.T) {
	env := checkTestSetup(t)
	_, own, settings := rowsTestSplit(t, env)
	// a folder where b.md's copy goes makes that copy fail
	blocker := filepath.Join(own, "b.md")
	if err := os.MkdirAll(blocker, 0o755); err != nil {
		t.Fatal(err)
	}
	copyB := rowsTestChange(t, checkTestLoad(t, "ca"), "copy-here", "b.md")

	res := rowsTestApply(t, "ca", wshrpc.MemRow_Split, "")

	if res.Stop != wshrpc.MemStop_Failed || res.Failed != copyB.Title || res.Error == "" || res.Here != 1 || rowsTestExists(t, settings) {
		t.Fatalf("result = %+v, want failed on %q after 1 here", res, copyB.Title)
	}
	st := checkTestLoad(t, "ca")
	if st.LastError != "" || rowsTestChange(t, st, "copy-here", "b.md").Status != "open" || rowsTestChange(t, st, "move-here", "a.md").Status != "applied" {
		t.Fatalf("lasterror %q, changes %+v: want a applied, b open, nothing stored for the error", st.LastError, st.Changes)
	}

	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	res = rowsTestApply(t, "ca", wshrpc.MemRow_Split, "")
	if res.Stop != "" || res.Here != 3 || !rowsTestExists(t, settings) {
		t.Fatalf("resumed apply = %+v, want done", res)
	}
}

func TestApplyRowLeftOutMemoryStaysThroughSplitAndCleanup(t *testing.T) {
	env := checkTestSetup(t)
	shared, own, _ := rowsTestSplit(t, env)
	st := checkTestLoad(t, "ca")
	checkTestDecide(t, "ca", rowsTestChange(t, st, "move-here", "a.md").Id, "keep")
	// a removal of a.md proposed before it was left out
	inv, err := ReadInventory(shared)
	if err != nil {
		t.Fatal(err)
	}
	older := RemoveShared("ca", inv, map[string][]string{"a.md": {"ca"}}, nil, map[string]int64{"ca": 1})

	res := rowsTestApply(t, "ca", wshrpc.MemRow_Split, "")

	if res.Stop != "" || res.Total != 2 || res.Here != 2 || !rowsTestExists(t, filepath.Join(shared, "a.md")) || rowsTestExists(t, filepath.Join(own, "a.md")) {
		t.Fatalf("result = %+v: want a.md left in the shared folder and out of the total", res)
	}

	checkTestRun(t, env, "ca")
	st = checkTestLoad(t, "ca")
	if st.FormerShared == "" || slices.ContainsFunc(st.Changes, func(c wshrpc.MemChange) bool { return c.Kind == "remove-shared" }) {
		t.Fatalf("formershared %q, changes %+v: want no removal of the left-out memory", st.FormerShared, st.Changes)
	}

	if _, err := Update("ca", func(st *State) error {
		st.Changes = append(st.Changes, older...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	res = rowsTestApply(t, "ca", wshrpc.MemRow_Cleanup, "")

	if res.Stop != "" || !rowsTestExists(t, filepath.Join(shared, "a.md")) {
		t.Fatalf("cleanup = %+v, a.md exists %v: want it kept", res, rowsTestExists(t, filepath.Join(shared, "a.md")))
	}
	st = checkTestLoad(t, "ca")
	if got := rowsTestChange(t, st, "remove-shared", "a.md").Status; got != "kept" {
		t.Fatalf("the older removal is %q, want kept", got)
	}
	if n := Waiting(st.MemHygieneProject); n != 0 {
		t.Fatalf("Waiting = %d after the cleanup, want 0", n)
	}
}

func TestApplyRowCleanupRemovesIntoOneBatch(t *testing.T) {
	env := checkTestSetup(t)
	shared, _, _ := rowsTestSplit(t, env)
	inv, err := ReadInventory(shared)
	if err != nil {
		t.Fatal(err)
	}
	removals := RemoveShared("ca", inv, map[string][]string{"a.md": {"ca"}, "c.md": {"ca"}}, nil, map[string]int64{"ca": 1})
	if _, err := Update("ca", func(st *State) error {
		st.Changes = removals
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	res := rowsTestApply(t, "ca", wshrpc.MemRow_Cleanup, "")

	st := checkTestLoad(t, "ca")
	b := rowsTestBatches(st, wshrpc.MemBatch_Cleanup)
	if res.Stop != "" || len(b) != 1 || len(b[0].ChangeIds) != 2 || rowsTestExists(t, filepath.Join(shared, "a.md")) || rowsTestExists(t, filepath.Join(shared, "c.md")) {
		t.Fatalf("result %+v, cleanup batches %+v: want both removed in one batch", res, b)
	}
}

func TestApplyRowDocMovesOneIntoADocBatch(t *testing.T) {
	env := checkTestSetup(t)
	folder := env.project(t, "p", initRepo(t))
	doc := filepath.Join(env.registry["p"], "AGENTS.md")
	writeFile(t, doc, "# Repo\n\n## Gotchas\n\n- one\n")
	writeFile(t, filepath.Join(folder, "MEMORY.md"), "- [E](e.md) — eps\n")
	writeFile(t, filepath.Join(folder, "e.md"), "eps rule\n")
	env.setReply(func(string) (string, error) {
		return `{"changes": [{"kind": "move-to-doc", "title": "e to the doc", "files": ["e.md"], "section": "## Gotchas", "passage": "- eps rule"}]}`, nil
	})
	checkTestRun(t, env, "p")
	move := checkTestFind(t, checkTestLoad(t, "p"), "move-to-doc")

	res := rowsTestApply(t, "p", wshrpc.MemRow_Doc, move.Id)

	st := checkTestLoad(t, "p")
	b := rowsTestBatches(st, wshrpc.MemBatch_Doc)
	if res.Stop != "" || checkTestFind(t, st, "move-to-doc").Status != "applied" || len(b) != 1 || !slices.Equal(b[0].ChangeIds, []string{move.Id}) {
		t.Fatalf("result %+v, doc batches %+v: want the move applied in a one-change batch", res, b)
	}
	if !strings.Contains(autoTestRead(t, doc), "- eps rule") {
		t.Fatal("the passage is not in the doc")
	}
}

func TestUndoSplitBatchRestoresAllUnlessACleanupRemovedACopy(t *testing.T) {
	env := checkTestSetup(t)
	shared, own, settings := rowsTestSplit(t, env)
	before := map[string]string{}
	for _, n := range []string{"MEMORY.md", "a.md", "b.md", "c.md", "d.md"} {
		before[n] = autoTestRead(t, filepath.Join(shared, n))
	}
	rowsTestApply(t, "ca", wshrpc.MemRow_Split, "")
	splitID := rowsTestBatches(checkTestLoad(t, "ca"), wshrpc.MemBatch_Split)[0].Id
	// det cleared b.md, which ca's split copied
	removeB := wshrpc.MemChange{Id: "rm-b", Kind: "remove-shared", Group: "shared", Status: "applied", ApplyId: "x",
		Op: wshrpc.MemOp{Folder: shared, Memories: []string{"b.md"}}}
	cleanup := wshrpc.MemBatch{Id: "clean-1", Kind: wshrpc.MemBatch_Cleanup, At: 42, ChangeIds: []string{"rm-b"}, Skipped: []wshrpc.MemSkip{}}
	if _, err := Update("det", func(st *State) error {
		st.Changes, st.Batches = []wshrpc.MemChange{removeB}, []wshrpc.MemBatch{cleanup}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	_, err := UndoBatch("ca", splitID, "")

	if err == nil || !strings.Contains(err.Error(), "det") {
		t.Fatalf("err = %v, want a refusal naming det's cleanup", err)
	}
	if !rowsTestExists(t, settings) || !rowsTestExists(t, filepath.Join(own, "a.md")) {
		t.Fatal("a refused undo changed files")
	}
	projects, err := List(env.registry)
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(projects, func(p wshrpc.MemHygieneProject) bool { return p.Project == "ca" })
	blk := projects[i].Batches[0].UndoBlock
	if blk == nil || *blk != (wshrpc.MemUndoBlock{Project: "det", BatchId: "clean-1", At: 42, Memories: 1}) {
		t.Fatalf("undoblock = %+v, want det's cleanup of 1 memory", blk)
	}
	if checkTestLoad(t, "ca").Batches[0].UndoBlock != nil {
		t.Fatal("the undo block was stored")
	}

	if _, err := Update("det", func(st *State) error {
		st.Changes, st.Batches = nil, nil
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := UndoBatch("ca", splitID, ""); err != nil {
		t.Fatal(err)
	}
	if rowsTestExists(t, settings) || rowsTestExists(t, filepath.Join(own, "a.md")) {
		t.Fatal("the undo left the switch or a moved file")
	}
	for n, want := range before {
		if got := autoTestRead(t, filepath.Join(shared, n)); got != want {
			t.Fatalf("shared %s = %q after undo, want %q", n, got, want)
		}
	}
	st := checkTestLoad(t, "ca")
	for _, c := range st.Changes {
		if (c.Group == "shared" || c.Kind == "settings") && c.Status != "open" {
			t.Errorf("%s %q is %q after undo, want open", c.Kind, c.Title, c.Status)
		}
	}
	if len(rowsTestBatches(st, wshrpc.MemBatch_Split)) != 0 {
		t.Fatal("the undone split batch is still listed")
	}
}

func TestApplyRowRefusesASecondApplyWhileOneRuns(t *testing.T) {
	env := checkTestSetup(t)
	rowsTestSplit(t, env)
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	publishUpdate = func() {
		once.Do(func() {
			close(started)
			<-release
		})
	}
	done := make(chan error, 1)
	go func() {
		_, err := ApplyRow(context.Background(), "ca", wshrpc.MemRow_Split, "")
		done <- err
	}()
	<-started

	_, err := ApplyRow(context.Background(), "ca", wshrpc.MemRow_Split, "")

	close(release)
	if err == nil {
		t.Fatal("a second apply on ca ran while the first did")
	}
	if err := <-done; err != nil {
		t.Fatalf("the first apply: %v", err)
	}
}
