// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memhygiene

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const autoTestTrimOld = " Verified 2026-07-24."

// autoTestProject registers name on its own repo with a, b and c linked, each with a date a trim can
// drop, and replies reply to every judge call.
func autoTestProject(t *testing.T, env *checkTestEnv, name, reply string) string {
	t.Helper()
	folder := env.project(t, name, initRepo(t))
	writeFile(t, filepath.Join(folder, "MEMORY.md"), "- [A](a.md) — alpha\n- [B](b.md) — beta\n- [C](c.md) — gamma\n")
	for _, n := range []string{"a", "b", "c"} {
		writeFile(t, filepath.Join(folder, n+".md"), n+" rule."+autoTestTrimOld+"\n")
	}
	env.setReply(func(string) (string, error) { return reply, nil })
	return folder
}

func autoTestTrim(name string) string {
	return fmt.Sprintf(`{"kind": "trim", "title": "date in %s", "files": [%q], "old": %q, "new": ""}`, name, name, autoTestTrimOld)
}

func autoTestDel(name string) string {
	return fmt.Sprintf(`{"kind": "delete", "title": "stale %s", "files": [%q]}`, name, name)
}

func autoTestReply(changes ...string) string {
	return `{"changes": [` + strings.Join(changes, ",") + `]}`
}

// autoTestCheck runs a check the way the sweep and Check now do, auto-apply included.
func autoTestCheck(t *testing.T, project string) *State {
	t.Helper()
	if err := entryBegin(project); err != nil {
		t.Fatal(err)
	}
	entryRun(project)
	return checkTestLoad(t, project)
}

func autoTestStatus(t *testing.T, st *State, title string) wshrpc.MemChange {
	t.Helper()
	i := slices.IndexFunc(st.Changes, func(c wshrpc.MemChange) bool { return c.Title == title })
	if i < 0 {
		t.Fatalf("no change %q in %+v", title, st.Changes)
	}
	return st.Changes[i]
}

func autoTestRead(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestRoutineKind(t *testing.T) {
	for kind, want := range map[string]bool{
		"trim": true, "delete": true, "merge": true, "add-to-index": true,
		"move-to-doc": false, "move-here": false, "copy-here": false, "remove-shared": false, "settings": false,
	} {
		if got := routineKind(kind); got != want {
			t.Errorf("routineKind(%q) = %v, want %v", kind, got, want)
		}
	}
}

func TestAutoApplyAppliesRoutineChangesAfterACheck(t *testing.T) {
	env := checkTestSetup(t)
	folder := env.project(t, "p", initRepo(t))
	writeFile(t, filepath.Join(env.registry["p"], "AGENTS.md"), "# Repo\n\n## Gotchas\n\n- one\n")
	writeFile(t, filepath.Join(folder, "MEMORY.md"), "- [A](a.md) — alpha\n- [B](b.md) — beta\n- [C](c.md) — gamma\n- [D](d.md) — delta\n- [E](e.md) — eps\n")
	writeFile(t, filepath.Join(folder, "a.md"), "alpha rule\n")
	writeFile(t, filepath.Join(folder, "b.md"), "beta rule."+autoTestTrimOld+"\n")
	writeFile(t, filepath.Join(folder, "c.md"), "gamma rule\n")
	writeFile(t, filepath.Join(folder, "d.md"), "gamma rule again\n")
	writeFile(t, filepath.Join(folder, "e.md"), "eps rule\n")
	writeFile(t, filepath.Join(folder, "f.md"), "zeta rule\n")
	env.setReply(func(string) (string, error) {
		return autoTestReply(
			autoTestDel("a.md"),
			autoTestTrim("b.md"),
			`{"kind": "merge", "title": "c and d", "files": ["c.md", "d.md"], "merge_name": "cd.md", "merge_body": "gamma rule\n", "index_line": "- [CD](cd.md) — gamma"}`,
			`{"kind": "move-to-doc", "title": "e to the doc", "files": ["e.md"], "section": "## Gotchas", "passage": "- eps rule"}`,
			`{"kind": "add-to-index", "title": "link f", "files": ["f.md"], "index_line": "- [F](f.md) — zeta"}`,
		), nil
	})

	st := autoTestCheck(t, "p")

	var applied []string
	for _, c := range st.Changes {
		want := "applied"
		if c.Kind == "move-to-doc" {
			want = "open"
		}
		if c.Status != want {
			t.Errorf("%s %q is %q, want %q", c.Kind, c.Title, c.Status, want)
		}
		if c.Status == "applied" {
			applied = append(applied, c.Id)
		}
	}
	if len(applied) != 4 || len(st.Batches) != 1 {
		t.Fatalf("applied %d, batches %+v: want 4 applied in one batch", len(applied), st.Batches)
	}
	b := st.Batches[0]
	if b.Kind != wshrpc.MemBatch_Routine || b.Id == "" || b.At == 0 || !slices.Equal(b.ChangeIds, applied) || b.Skipped == nil || len(b.Skipped) != 0 {
		t.Fatalf("batch = %+v, want a routine batch of %v with no skips", b, applied)
	}
	// 5 lines: a deleted, c+d merged into one, f linked
	if b.IndexBefore.Lines != 5 || b.IndexAfter.Lines != 4 || st.Index.Lines != 4 {
		t.Fatalf("index before/after/now = %d/%d/%d lines, want 5/4/4", b.IndexBefore.Lines, b.IndexAfter.Lines, st.Index.Lines)
	}
	if _, err := os.Stat(filepath.Join(folder, "a.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a.md should be deleted: %v", err)
	}
}

func TestAutoApplyLeavesSplitChangesAndMeasuresTheOwnIndex(t *testing.T) {
	env := checkTestSetup(t)
	_, _, own := checkTestSharing(t, env)
	writeFile(t, filepath.Join(own, "MEMORY.md"), "- [Old](old.md) — a leftover\n")

	st := autoTestCheck(t, "ca")

	for _, c := range st.Changes {
		want := "open"
		if c.Kind == "delete" {
			want = "applied"
		}
		if c.Status != want {
			t.Errorf("%s %q is %q, want %q", c.Kind, c.Title, c.Status, want)
		}
	}
	if len(st.Batches) != 1 {
		t.Fatalf("batches = %+v, want one", st.Batches)
	}
	// the shared index has 2 lines; the batch reports the own folder's, which its delete edits
	if b := st.Batches[0]; b.IndexBefore.Lines != 1 || b.IndexAfter.Lines != 0 {
		t.Fatalf("index before/after = %+v/%+v, want the own index's 1 then 0 lines", b.IndexBefore, b.IndexAfter)
	}
}

func TestAutoApplySkipsChangedAndFailedAndAppliesTheRest(t *testing.T) {
	env := checkTestSetup(t)
	folder := autoTestProject(t, env, "p", autoTestReply(autoTestDel("a.md"), autoTestTrim("b.md"), autoTestDel("c.md")))
	checkTestRun(t, env, "p")
	writeFile(t, filepath.Join(folder, "a.md"), "edited by hand\n")
	if _, err := Update("p", func(st *State) error {
		for i := range st.Changes {
			if st.Changes[i].Kind == "trim" {
				st.Changes[i].Op.Old = "a passage that isn't there"
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := autoApply("p"); err != nil {
		t.Fatal(err)
	}

	st := checkTestLoad(t, "p")
	a, b, c := autoTestStatus(t, st, "stale a.md"), autoTestStatus(t, st, "date in b.md"), autoTestStatus(t, st, "stale c.md")
	if a.Status != "conflict" || b.Status != "open" || c.Status != "applied" {
		t.Fatalf("a/b/c = %q/%q/%q, want conflict/open/applied", a.Status, b.Status, c.Status)
	}
	if len(st.Batches) != 1 || !slices.Equal(st.Batches[0].ChangeIds, []string{c.Id}) {
		t.Fatalf("batches = %+v, want one holding c", st.Batches)
	}
	sk := st.Batches[0].Skipped
	if len(sk) != 2 || sk[0].ChangeId != a.Id || sk[0].Reason != wshrpc.MemSkip_Changed || sk[0].Error != "" ||
		sk[1].ChangeId != b.Id || sk[1].Reason != wshrpc.MemSkip_Failed || sk[1].Kind != "trim" || sk[1].Title != b.Title ||
		!strings.Contains(sk[1].Error, "appears 0 times") {
		t.Fatalf("skipped = %+v, want a changed then b failed with its error", sk)
	}
	if got := autoTestRead(t, filepath.Join(folder, "a.md")); got != "edited by hand\n" {
		t.Fatalf("the edited memory was touched: %q", got)
	}
}

func TestAutoApplySkipsAChangeOverlappingAnEarlierOne(t *testing.T) {
	env := checkTestSetup(t)
	autoTestProject(t, env, "p", autoTestReply(
		autoTestTrim("a.md"),
		`{"kind": "merge", "title": "a and b", "files": ["a.md", "b.md"], "merge_name": "ab.md", "merge_body": "a and b\n", "index_line": "- [AB](ab.md) — both"}`,
	))

	st := autoTestCheck(t, "p")

	trim, merge := checkTestFind(t, st, "trim"), checkTestFind(t, st, "merge")
	if trim.Status != "applied" || merge.Status != "conflict" {
		t.Fatalf("trim/merge = %q/%q, want applied/conflict", trim.Status, merge.Status)
	}
	if len(st.Batches) != 1 {
		t.Fatalf("batches = %+v, want one", st.Batches)
	}
	b := st.Batches[0]
	if !slices.Equal(b.ChangeIds, []string{trim.Id}) || len(b.Skipped) != 1 || b.Skipped[0].ChangeId != merge.Id || b.Skipped[0].Reason != wshrpc.MemSkip_Overlap {
		t.Fatalf("batch = %+v, want the trim applied and the merge skipped as an overlap", b)
	}
}

func TestAutoApplyNothingAfterAFailedCheck(t *testing.T) {
	env := checkTestSetup(t)
	autoTestProject(t, env, "p", autoTestReply(autoTestDel("a.md")))
	checkTestRun(t, env, "p")
	env.setReply(func(string) (string, error) { return "", errors.New("model down") })

	st := autoTestCheck(t, "p")

	if st.LastError == "" || st.Changes[0].Status != "open" || len(st.Batches) != 0 {
		t.Fatalf("lasterror/status/batches = %q/%q/%+v, want the failure and nothing applied", st.LastError, st.Changes[0].Status, st.Batches)
	}
}

func TestUndoBatchOneChangeThenTheRest(t *testing.T) {
	env := checkTestSetup(t)
	folder := autoTestProject(t, env, "p", autoTestReply(autoTestDel("a.md"), autoTestTrim("b.md")))
	before := map[string]string{}
	for _, n := range []string{"MEMORY.md", "a.md", "b.md"} {
		before[n] = autoTestRead(t, filepath.Join(folder, n))
	}
	st := autoTestCheck(t, "p")
	batchID := st.Batches[0].Id
	del, trim := checkTestFind(t, st, "delete"), checkTestFind(t, st, "trim")

	p, err := UndoBatch("p", batchID, trim.Id)
	if err != nil {
		t.Fatal(err)
	}
	st = checkTestLoad(t, "p")
	if checkTestFind(t, st, "trim").Status != "kept" || checkTestFind(t, st, "delete").Status != "applied" || len(p.Batches) != 1 || len(st.Batches) != 1 {
		t.Fatalf("after undoing the trim: changes %+v, batches %+v", st.Changes, st.Batches)
	}

	if _, err := UndoBatch("p", batchID, ""); err != nil {
		t.Fatal(err)
	}
	st = checkTestLoad(t, "p")
	if checkTestFind(t, st, "delete").Status != "kept" || len(st.Batches) != 0 {
		t.Fatalf("after undoing the batch: changes %+v, batches %+v", st.Changes, st.Batches)
	}
	for n, want := range before {
		if got := autoTestRead(t, filepath.Join(folder, n)); got != want {
			t.Fatalf("%s = %q after undo, want %q", n, got, want)
		}
	}

	st = autoTestCheck(t, "p")
	if checkTestFind(t, st, "delete").Id != del.Id || checkTestFind(t, st, "delete").Status != "kept" || checkTestFind(t, st, "trim").Status != "kept" || len(st.Batches) != 0 {
		t.Fatalf("the next check re-applied undone changes: changes %+v, batches %+v", st.Changes, st.Batches)
	}
}

func TestUndoBatchStopsAtAChangeItCantUndo(t *testing.T) {
	env := checkTestSetup(t)
	folder := autoTestProject(t, env, "p", autoTestReply(autoTestDel("a.md"), autoTestDel("b.md"), autoTestDel("c.md")))
	st := autoTestCheck(t, "p")
	batchID := st.Batches[0].Id
	// b.md reappears, so its delete can't be undone without overwriting it
	writeFile(t, filepath.Join(folder, "b.md"), "written again by hand\n")

	_, err := UndoBatch("p", batchID, "")

	if err == nil || !strings.Contains(err.Error(), `"stale b.md"`) || !strings.Contains(err.Error(), "undid 1 ") {
		t.Fatalf("err = %v, want one naming stale b.md and 1 undone", err)
	}
	st = checkTestLoad(t, "p")
	a, b, c := autoTestStatus(t, st, "stale a.md"), autoTestStatus(t, st, "stale b.md"), autoTestStatus(t, st, "stale c.md")
	if c.Status != "kept" || b.Status != "applied" || a.Status != "applied" || len(st.Batches) != 1 {
		t.Fatalf("a/b/c = %q/%q/%q, batches %d: want applied/applied/kept and the batch listed", a.Status, b.Status, c.Status, len(st.Batches))
	}
	if _, err := os.Stat(filepath.Join(folder, "c.md")); err != nil {
		t.Fatalf("c.md was not restored: %v", err)
	}
}

func TestUndoBatchRefusesOneChangeOfASplit(t *testing.T) {
	storeSetup(t)
	c := wshrpc.MemChange{Id: "m1", Kind: "move-here", Title: "Move hk.md", Status: checkStatusApplied, ApplyId: "x"}
	b := wshrpc.MemBatch{Id: "b1", Kind: wshrpc.MemBatch_Split, At: 1, ChangeIds: []string{"m1"}, Skipped: []wshrpc.MemSkip{}}
	if _, err := Update("p", func(st *State) error {
		st.Changes, st.Batches = []wshrpc.MemChange{c}, []wshrpc.MemBatch{b}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := UndoBatch("p", "b1", "m1"); err == nil {
		t.Fatal("undoing one change of a split batch must be refused")
	}
	st := checkTestLoad(t, "p")
	if len(st.Batches) != 1 || st.Changes[0].Status != checkStatusApplied || st.Changes[0].ApplyId != "x" {
		t.Fatalf("a refused undo changed the state: %+v / %+v", st.Changes, st.Batches)
	}
}
