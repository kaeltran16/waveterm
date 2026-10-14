// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func scanItems(t *testing.T) []wshrpc.StorageItem {
	t.Helper()
	items, _, err := scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return items
}

func mustFind(t *testing.T, items []wshrpc.StorageItem, kind, path string) wshrpc.StorageItem {
	t.Helper()
	item := findItem(items, kind, path)
	if item == nil {
		t.Fatalf("no %s row for %s in %v", kind, path, items)
	}
	return *item
}

func branchRow(t *testing.T, items []wshrpc.StorageItem, branch string) wshrpc.StorageItem {
	t.Helper()
	for _, item := range items {
		if item.Kind == wshrpc.StorageKind_Branch && item.Branch == branch {
			return item
		}
	}
	t.Fatalf("no branch row for %s in %v", branch, items)
	return wshrpc.StorageItem{}
}

func wantClearError(t *testing.T, err error, skipped, held bool, msg string) {
	t.Helper()
	var ce *ClearError
	if !errors.As(err, &ce) {
		t.Fatalf("clear = %v, want a ClearError", err)
	}
	if ce.Skipped != skipped || ce.Held != held || !strings.Contains(ce.Msg, msg) {
		t.Fatalf("clear = %+v, want skipped %v held %v msg %q", ce, skipped, held, msg)
	}
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func hasBranch(repo, branch string) bool {
	return exec.Command("git", "-C", repo, "show-ref", "--verify", "-q", "refs/heads/"+branch).Run() == nil
}

// writeMarker claims runID's short prefix under root, as the engine does.
func writeMarker(t *testing.T, root, runID string) string {
	t.Helper()
	mkdirs(t, root)
	marker := filepath.Join(root, runID[:8]+".run")
	if err := os.WriteFile(marker, []byte(runID), 0o644); err != nil {
		t.Fatal(err)
	}
	return marker
}

func wantMarkers(t *testing.T, root string, n int) {
	t.Helper()
	markers, _ := filepath.Glob(filepath.Join(root, "*.run"))
	if len(markers) != n {
		t.Fatalf("%d .run markers under %s, want %d", len(markers), root, n)
	}
}

func TestClearFolderWithAJunctionKeepsTheTarget(t *testing.T) {
	env := useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	checkout := filepath.Join(t.TempDir(), "main-checkout")
	mkdirs(t, filepath.Join(checkout, "node_modules", "pkg"))
	if err := os.WriteFile(filepath.Join(checkout, "node_modules", "pkg", "index.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main"})
	writeMarker(t, env.root, run.OID)
	runDir := filepath.Join(env.root, run.OID[:8]+"-t-1")
	scratch := filepath.Join(env.root, "scratch")
	for _, dir := range []string{runDir, scratch} {
		mkdirs(t, filepath.Join(dir, "src"))
		if err := os.WriteFile(filepath.Join(dir, "src", "a.txt"), []byte("left"), 0o644); err != nil {
			t.Fatal(err)
		}
		linkDir(t, filepath.Join(dir, "node_modules"), filepath.Join(checkout, "node_modules"))
	}

	items := scanItems(t)
	for _, dir := range []string{runDir, scratch} {
		item := mustFind(t, items, wshrpc.StorageKind_RunTree, dir)
		if !item.Clearable || item.Tracked {
			t.Fatalf("%s = %+v, want an untracked clearable folder", dir, item)
		}
		freed, err := clearItem(ctx, item, false, "")
		if err != nil {
			t.Fatalf("clearing %s: %v", dir, err)
		}
		if freed != item.Size || freed == 0 {
			t.Fatalf("freed %d, want the folder's size %d", freed, item.Size)
		}
		if exists(dir) {
			t.Fatalf("%s is still on disk", dir)
		}
	}
	if !exists(filepath.Join(checkout, "node_modules", "pkg", "index.js")) {
		t.Fatal("clearing a folder deleted the junction target's files")
	}
	wantMarkers(t, env.root, 1)
}

func TestClearTrackedTreeOfADoneRun(t *testing.T) {
	env := useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main"})
	key := run.OID + "-t-1"
	wt, err := orchestrate.CreateRunWorktree(ctx, repo, key, "")
	if err != nil {
		t.Fatal(err)
	}

	item := mustFind(t, scanItems(t), wshrpc.StorageKind_RunTree, wt)
	if !item.Clearable || !item.Tracked {
		t.Fatalf("tree = %+v, want tracked and clearable", item)
	}
	if _, err := clearItem(ctx, item, false, ""); err != nil {
		t.Fatal(err)
	}
	if exists(wt) {
		t.Fatal("the tree is still on disk")
	}
	if list := gitT(t, repo, "worktree", "list", "--porcelain"); strings.Contains(strings.ToLower(list), strings.ToLower(filepath.ToSlash(filepath.Base(wt)))) {
		t.Fatalf("git still lists the tree:\n%s", list)
	}
	if hasBranch(repo, "wave/"+key) {
		t.Fatal("the tree's branch is still there")
	}
	wantMarkers(t, env.root, 1)
}

func TestClearSkipsARunThatResumed(t *testing.T) {
	useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main"})
	wt, err := orchestrate.CreateRunWorktree(ctx, repo, run.OID, "")
	if err != nil {
		t.Fatal(err)
	}
	item := mustFind(t, scanItems(t), wshrpc.StorageKind_RunTree, wt)
	if !item.Clearable {
		t.Fatalf("tree = %+v, want clearable", item)
	}

	run.Status = "executing"
	if err := wstore.DBUpdate(ctx, run); err != nil {
		t.Fatal(err)
	}
	_, err = clearItem(ctx, item, false, "")
	wantClearError(t, err, true, false, "its run is executing again")
	if !exists(wt) || !hasBranch(repo, "wave/"+run.OID) {
		t.Fatal("a resumed run's tree or branch was removed")
	}
}

func TestClearBranchWithAUniqueCommit(t *testing.T) {
	useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main"})
	branch := "wave/" + run.OID
	gitT(t, repo, "checkout", "-q", "-b", branch)
	commitFile(t, repo, "a.txt", "a\n", "work only here")
	gitT(t, repo, "checkout", "-q", "main")
	row := branchRow(t, scanItems(t), branch)
	if row.Skip != wshrpc.StorageSkip_Commits {
		t.Fatalf("branch row = %+v, want skipped for its commits", row)
	}

	_, err := clearItem(ctx, row, false, "")
	wantClearError(t, err, true, false, "commits on no other branch")
	if !hasBranch(repo, branch) {
		t.Fatal("Clear deleted a branch with a unique commit")
	}
	_, err = clearItem(ctx, row, true, "0000000000000000000000000000000000000000")
	wantClearError(t, err, true, false, "the branch moved since you looked")
	if !hasBranch(repo, branch) {
		t.Fatal("Delete anyway with a stale tip deleted the branch")
	}
	if _, err := clearItem(ctx, row, true, row.BranchTip); err != nil {
		t.Fatal(err)
	}
	if hasBranch(repo, branch) {
		t.Fatal("Delete anyway with the shown tip kept the branch")
	}
}

func TestClearBranchOnlyRowOnAnotherBranch(t *testing.T) {
	useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main"})
	branch := "wave/" + run.OID
	gitT(t, repo, "checkout", "-q", "-b", branch)
	tip := commitFile(t, repo, "a.txt", "a\n", "work")
	gitT(t, repo, "branch", "backup")
	gitT(t, repo, "checkout", "-q", "main")
	row := branchRow(t, scanItems(t), branch)
	if !row.Clearable || row.Path != "" {
		t.Fatalf("branch row = %+v, want a clearable branch-only row", row)
	}
	if _, err := clearItem(ctx, row, false, ""); err != nil {
		t.Fatal(err)
	}
	if hasBranch(repo, branch) {
		t.Fatal("the branch is still there")
	}
	if got := gitT(t, repo, "rev-parse", "backup"); got != tip {
		t.Fatalf("backup = %s, want %s", got, tip)
	}
}

// each one's commit is on the other, so the scan shows both as losing nothing
func TestClearTwoBranchesSharingACommitKeepsTheCommit(t *testing.T) {
	useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	runA := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main"})
	runB := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main"})
	a, b := "wave/"+runA.OID, "wave/"+runB.OID
	gitT(t, repo, "checkout", "-q", "-b", a)
	shared := commitFile(t, repo, "a.txt", "a\n", "shared work")
	gitT(t, repo, "branch", b)
	gitT(t, repo, "checkout", "-q", "main")
	items := scanItems(t)
	rows := []wshrpc.StorageItem{branchRow(t, items, a), branchRow(t, items, b)}
	for _, row := range rows {
		if !row.Clearable {
			t.Fatalf("%s = %+v, want clearable at scan time", row.Branch, row)
		}
	}

	if _, err := clearItem(ctx, rows[0], false, ""); err != nil {
		t.Fatal(err)
	}
	_, err := clearItem(ctx, rows[1], false, "")
	wantClearError(t, err, true, false, "commits on no other branch")
	if !hasBranch(repo, b) {
		t.Fatal("the second branch, now the commit's only home, was deleted")
	}
	gitT(t, repo, "cat-file", "-e", shared+"^{commit}")
}

func TestClearLegacyTreeWithAMergedBranch(t *testing.T) {
	useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main"})
	dir := filepath.Join(orchestrate.LegacyWorktreesDir(repo), run.OID)
	mkdirs(t, filepath.Join(dir, "leftover"))
	gitT(t, repo, "branch", "wave/"+run.OID)
	item := mustFind(t, scanItems(t), wshrpc.StorageKind_LegacyTree, dir)
	if !item.Clearable || item.Branch == "" {
		t.Fatalf("legacy tree = %+v, want clearable with its branch", item)
	}
	if _, err := clearItem(ctx, item, false, ""); err != nil {
		t.Fatal(err)
	}
	if exists(dir) || hasBranch(repo, "wave/"+run.OID) {
		t.Fatal("the legacy folder or its branch is still there")
	}
}

func TestClearNoKeyTree(t *testing.T) {
	env := useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	clean, err := orchestrate.CreateRunWorktree(ctx, repo, "handmade", "")
	if err != nil {
		t.Fatal(err)
	}
	ahead, err := orchestrate.CreateRunWorktree(ctx, repo, "ahead", "")
	if err != nil {
		t.Fatal(err)
	}
	commitFile(t, ahead, "b.txt", "b\n", "only on wave/ahead")
	items := scanItems(t)

	item := mustFind(t, items, wshrpc.StorageKind_RunTree, clean)
	if !item.Clearable {
		t.Fatalf("handmade = %+v, want clearable", item)
	}
	if _, err := clearItem(ctx, item, false, ""); err != nil {
		t.Fatal(err)
	}
	if exists(clean) || hasBranch(repo, "wave/handmade") {
		t.Fatal("the no-key tree or its branch is still there")
	}

	// removing the tree takes its wave/<name> branch, which the tree row does not show
	item = mustFind(t, items, wshrpc.StorageKind_RunTree, ahead)
	if !item.Clearable {
		t.Fatalf("ahead = %+v, want clearable at scan time", item)
	}
	_, err = clearItem(ctx, item, false, "")
	wantClearError(t, err, true, false, "wave/ahead has commits on no other branch")
	if !exists(ahead) || !hasBranch(repo, "wave/ahead") {
		t.Fatal("a no-key tree whose branch holds a unique commit was removed")
	}
	wantMarkers(t, env.root, 0)
}

func TestClearWhileTheEngineRemovesIt(t *testing.T) {
	useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main"})
	wt, err := orchestrate.CreateRunWorktree(ctx, repo, run.OID, "")
	if err != nil {
		t.Fatal(err)
	}
	item := mustFind(t, scanItems(t), wshrpc.StorageKind_RunTree, wt)
	unlock := orchestrate.LockTreeForTest(item.Path)
	_, err = clearItem(ctx, item, false, "")
	unlock()
	wantClearError(t, err, false, false, "the engine is removing it")
	if !exists(wt) {
		t.Fatal("the tree went while the engine held it")
	}
}

func TestClearHeldFile(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("a file held open blocks its delete only on Windows")
	}
	env := useScanEnv(t)
	ctx := context.Background()
	dir := filepath.Join(env.root, "scratch")
	mkdirs(t, dir)
	held := filepath.Join(dir, "held.txt")
	if err := os.WriteFile(held, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// os.Open shares read and write, never delete
	f, err := os.Open(held)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	item := mustFind(t, scanItems(t), wshrpc.StorageKind_RunTree, dir)
	_, err = clearItem(ctx, item, false, "")
	wantClearError(t, err, false, true, "a process has it open")
	if !exists(held) {
		t.Fatal("the held file is gone")
	}

	// one held member fails a group row
	for _, name := range []string{"arc-final-out-1", "arc-final-out-2"} {
		mkdirs(t, filepath.Join(env.appData, name))
	}
	member := filepath.Join(env.appData, "arc-final-out-2", "held.log")
	if err := os.WriteFile(member, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	g, err := os.Open(member)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	group := mustFind(t, scanItems(t), wshrpc.StorageKind_FinalOut, env.appData)
	_, err = clearItem(ctx, group, false, "")
	wantClearError(t, err, false, true, "1 of 2 couldn't be cleared")
	if exists(filepath.Join(env.appData, "arc-final-out-1")) || !exists(member) {
		t.Fatal("want the free member cleared and the held one kept")
	}
}

func TestClearGroups(t *testing.T) {
	env := useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	legacy := orchestrate.LegacyWorktreesDir(repo)
	for range 2 {
		run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done"})
		mkdirs(t, filepath.Join(legacy, run.OID+"-t-1", "leftover"))
	}
	mkdirs(t, filepath.Join(env.temp, "arc-final-attn"))
	logFile := filepath.Join(env.temp, "arc-final-run.log")
	if err := os.WriteFile(logFile, []byte("log"), 0o644); err != nil {
		t.Fatal(err)
	}
	items := scanItems(t)
	for _, row := range []wshrpc.StorageItem{mustFind(t, items, wshrpc.StorageKind_LegacyGroup, legacy), mustFind(t, items, wshrpc.StorageKind_FinalOut, env.temp)} {
		if _, err := clearItem(ctx, row, false, ""); err != nil {
			t.Fatalf("clearing %s: %v", row.Id, err)
		}
		for _, p := range row.Paths {
			if exists(p) {
				t.Fatalf("%s is still on disk", p)
			}
		}
	}
	if !exists(legacy) || !exists(env.temp) {
		t.Fatal("a group's parent folder was removed")
	}
}

func TestClearRefusesKeptItems(t *testing.T) {
	env := useScanEnv(t)
	shots := filepath.Join(env.home, ".claude", "projects")
	mkdirs(t, filepath.Join(shots, "C--x"))
	item := mustFind(t, scanItems(t), wshrpc.StorageKind_Transcripts, shots)
	_, err := clearItem(context.Background(), item, true, "")
	var ce *ClearError
	if err == nil || errors.As(err, &ce) {
		t.Fatalf("clearing a kept item = %v, want a plain error", err)
	}
	if !exists(shots) {
		t.Fatal("a kept item was removed")
	}
}
