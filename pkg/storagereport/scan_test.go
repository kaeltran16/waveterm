// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

type scanEnv struct {
	root, appData, temp, home string
}

// useScanEnv points the worktree root, config home, LOCALAPPDATA, %TEMP% and the home folder at temp dirs.
func useScanEnv(t *testing.T) scanEnv {
	t.Helper()
	base := t.TempDir()
	env := scanEnv{root: filepath.Join(base, "arc-wt"), appData: filepath.Join(base, "appdata"), temp: filepath.Join(base, "temp"), home: filepath.Join(base, "home")}
	for _, dir := range []string{env.appData, env.temp, env.home} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(orchestrate.UseWorktreeRootForTest(env.root))
	prevConfig := wavebase.ConfigHome_VarCache
	wavebase.ConfigHome_VarCache = filepath.Join(base, "config")
	if err := os.MkdirAll(wavebase.ConfigHome_VarCache, 0o755); err != nil {
		t.Fatal(err)
	}
	prevHome, prevAppData, prevTemp := userHomeDir, localAppDataDir, tempDir
	userHomeDir = func() (string, error) { return env.home, nil }
	localAppDataDir = func() string { return env.appData }
	tempDir = func() string { return env.temp }
	t.Cleanup(func() {
		wavebase.ConfigHome_VarCache = prevConfig
		userHomeDir, localAppDataDir, tempDir = prevHome, prevAppData, prevTemp
	})
	return env
}

func registerProject(t *testing.T, name, path string) {
	t.Helper()
	if err := wconfig.SetProjectConfigValue(name, waveobj.MetaMapType{"path": path}); err != nil {
		t.Fatal(err)
	}
}

func storeRun(t *testing.T, run *waveobj.Run) *waveobj.Run {
	t.Helper()
	if run.OID == "" {
		run.OID = uuid.NewString()
	}
	run.ID = run.OID
	if run.CreatedTs == 0 {
		run.CreatedTs = time.Now().UnixMilli()
	}
	if err := wstore.DBInsert(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	return run
}

func mkdirs(t *testing.T, paths ...string) {
	t.Helper()
	for _, p := range paths {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func findItem(items []wshrpc.StorageItem, kind, path string) *wshrpc.StorageItem {
	for i := range items {
		if items[i].Kind == kind && pathKey(items[i].Path) == pathKey(path) {
			return &items[i]
		}
	}
	return nil
}

func countKind(items []wshrpc.StorageItem, kind string) int {
	n := 0
	for _, item := range items {
		if item.Kind == kind {
			n++
		}
	}
	return n
}

func TestScanRunTreeResolvesThroughItsMarker(t *testing.T) {
	useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "payments", repo)
	dag := &waveobj.TaskGroup{OID: uuid.NewString(), Title: "Storage report"}
	dag.ID = dag.OID
	if err := wstore.DBInsert(ctx, dag); err != nil {
		t.Fatal(err)
	}
	run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main", Goal: "goal line\nmore", DagORef: "dag:" + dag.OID, CompletedTs: 1234})
	wt, err := orchestrate.CreateRunWorktree(ctx, repo, run.OID+"-t-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(wt) != run.OID[:8]+"-t-1" {
		t.Fatalf("tree %s, want the short <8> name", wt)
	}

	items, scanErrs, err := scan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(scanErrs) != 0 {
		t.Fatalf("scan errors: %v", scanErrs)
	}
	item := findItem(items, wshrpc.StorageKind_RunTree, wt)
	if item == nil {
		t.Fatalf("no runtree row for %s in %v", wt, items)
	}
	if item.RunId != run.OID || item.RunTitle != "Storage report" || item.RunStatus != "done" || item.RunTs != 1234 || item.Suffix != "-t-1" {
		t.Fatalf("run fields = %+v", item)
	}
	if item.ProjectName != "payments" || pathKey(item.ProjectPath) != pathKey(repo) {
		t.Fatalf("project = %q %q", item.ProjectName, item.ProjectPath)
	}
	if !item.Tracked || !item.HasGit || item.Dirty != 0 || item.Branch != "wave/"+run.OID+"-t-1" || item.BranchTip == "" {
		t.Fatalf("git fields = %+v", item)
	}
	if item.OnlyCount != 0 || item.AlsoOn != "main" || item.Size == 0 || item.ModTs == 0 {
		t.Fatalf("facts = %+v", item)
	}
	if item.Group != wshrpc.StorageGroup_Left || !item.Clearable {
		t.Fatalf("group %q clearable %v, want left over and clearable", item.Group, item.Clearable)
	}
	if countKind(items, wshrpc.StorageKind_Branch) != 0 {
		t.Fatalf("the tree's branch must not be a row of its own: %v", items)
	}
	for _, it := range items {
		if filepath.Ext(it.Path) == ".run" {
			t.Fatalf("a .run marker is listed: %v", it)
		}
	}

	// uncommitted files skip it
	if err := os.WriteFile(filepath.Join(wt, "new.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	fresh, err := probe(ctx, *item)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Dirty != 1 || fresh.Skip != wshrpc.StorageSkip_Dirty || fresh.Clearable {
		t.Fatalf("probe of a dirty tree = %+v", fresh)
	}

	// the run resumes between the scan and the clear
	run.Status = "executing"
	if err := wstore.DBUpdate(ctx, run); err != nil {
		t.Fatal(err)
	}
	fresh, err = probe(ctx, *item)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Group != wshrpc.StorageGroup_InUse || fresh.Clearable || fresh.RunStatus != "executing" {
		t.Fatalf("probe after the run resumed = group %q clearable %v status %q, want in use", fresh.Group, fresh.Clearable, fresh.RunStatus)
	}
}

func TestScanLegacyFoldersCollapseIntoOneGroup(t *testing.T) {
	useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	legacy := orchestrate.LegacyWorktreesDir(repo)
	var newest int64
	for r := range 4 {
		status := "done"
		if r == 3 {
			status = "cancelled"
		}
		run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: status, CompletedTs: int64(1000 + r)})
		newest = max(newest, run.CompletedTs)
		for lane := 1; lane <= 4; lane++ {
			dir := filepath.Join(legacy, run.OID+"-t-"+strconv.Itoa(lane))
			mkdirs(t, filepath.Join(dir, "leftover"))
		}
	}
	// a finished run's emptied folder whose branch still lives is its own row, carrying the branch
	branchRun := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main"})
	branchDir := filepath.Join(legacy, branchRun.OID)
	mkdirs(t, branchDir)
	gitT(t, repo, "branch", "wave/"+branchRun.OID)
	// a live run's folder is its own row too
	liveRun := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "blocked"})
	liveDir := filepath.Join(legacy, liveRun.OID)
	mkdirs(t, liveDir)

	items, scanErrs, err := scan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(scanErrs) != 0 {
		t.Fatalf("scan errors: %v", scanErrs)
	}
	if n := countKind(items, wshrpc.StorageKind_LegacyGroup); n != 1 {
		t.Fatalf("%d legacygroup rows, want 1: %v", n, items)
	}
	g := findItem(items, wshrpc.StorageKind_LegacyGroup, legacy)
	if g.Count != 16 || len(g.Paths) != 16 || g.RunCount != 4 || g.RunTs != newest || g.ProjectName != "proj" {
		t.Fatalf("group = count %d paths %d runs %d runts %d project %q", g.Count, len(g.Paths), g.RunCount, g.RunTs, g.ProjectName)
	}
	if g.Group != wshrpc.StorageGroup_Left || !g.Clearable {
		t.Fatalf("group %q clearable %v, want left over and clearable", g.Group, g.Clearable)
	}

	own := findItem(items, wshrpc.StorageKind_LegacyTree, branchDir)
	if own == nil || own.Branch != "wave/"+branchRun.OID || own.BranchTip == "" || own.RunId != branchRun.OID {
		t.Fatalf("the folder with a live branch = %+v, want its own row with the branch", own)
	}
	if own.Tracked || own.HasGit || own.AlsoOn != "main" || !own.Clearable {
		t.Fatalf("the folder with a live branch = %+v", own)
	}
	if countKind(items, wshrpc.StorageKind_Branch) != 0 {
		t.Fatal("the legacy folder's branch must not be a row of its own")
	}
	if live := findItem(items, wshrpc.StorageKind_LegacyTree, liveDir); live == nil || live.Group != wshrpc.StorageGroup_InUse {
		t.Fatalf("the live run's folder = %+v, want its own in use row", live)
	}

	// a member whose run resumed drops out of the group
	var resumed *waveobj.Run
	resumedID := filepath.Base(g.Paths[0])[:36]
	resumed, err = wstore.DBGet[*waveobj.Run](ctx, resumedID)
	if err != nil || resumed == nil {
		t.Fatalf("reading run %s: %v", resumedID, err)
	}
	resumed.Status = "executing"
	if err := wstore.DBUpdate(ctx, resumed); err != nil {
		t.Fatal(err)
	}
	fresh, err := probe(ctx, *g)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Count != 12 || fresh.RunCount != 3 || !fresh.Clearable {
		t.Fatalf("probe after a member's run resumed = count %d runs %d clearable %v, want 12 / 3", fresh.Count, fresh.RunCount, fresh.Clearable)
	}
}

func TestScanBranchRows(t *testing.T) {
	useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done", BaseBranch: "main", Land: &waveobj.RunLand{State: "held", Dismissed: true}})
	branch := "wave/" + run.OID
	gitT(t, repo, "checkout", "-q", "-b", branch)
	commitFile(t, repo, "a.txt", "a\n", "work only here")
	gitT(t, repo, "checkout", "-q", "main")

	items, _, err := scan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var row *wshrpc.StorageItem
	for i := range items {
		if items[i].Kind == wshrpc.StorageKind_Branch {
			row = &items[i]
		}
	}
	if row == nil || row.Id != branchItemId(repo, branch) || row.Path != "" || row.Branch != branch || row.RunId != run.OID {
		t.Fatalf("branch row = %+v", row)
	}
	if row.OnlyCount != 1 || row.Skip != wshrpc.StorageSkip_Commits || row.Clearable || !row.RunLandDismissed || row.RunLandState != "held" || row.ModTs == 0 {
		t.Fatalf("branch row facts = %+v", row)
	}

	gitT(t, repo, "branch", "-D", branch)
	if _, err := probe(ctx, *row); err != ErrGone {
		t.Fatalf("probe of a deleted branch = %v, want ErrGone", err)
	}
}

func TestScanUnreadableProjectIsAnErrorAndTheOthersStillList(t *testing.T) {
	env := useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "good", repo)
	missing := filepath.Join(t.TempDir(), "moved-away")
	registerProject(t, "gone", missing)
	goneRun := storeRun(t, &waveobj.Run{ProjectPath: missing, Status: "done"})
	goneTree := filepath.Join(env.root, goneRun.OID)
	mkdirs(t, goneTree)
	goodRun := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done"})
	goodTree := filepath.Join(env.root, goodRun.OID+"-t-2")
	mkdirs(t, goodTree)
	plain := t.TempDir()
	registerProject(t, "plain", plain)

	items, scanErrs, err := scan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(scanErrs) != 2 {
		t.Fatalf("scan errors = %v, want the missing and the non-git project", scanErrs)
	}
	byName := map[string]wshrpc.StorageScanError{}
	for _, e := range scanErrs {
		byName[e.ProjectName] = e
	}
	if e := byName["gone"]; e.ProjectPath != missing || e.Error == "" {
		t.Fatalf("missing project error = %+v", e)
	}
	if e := byName["plain"]; e.Error == "" {
		t.Fatalf("non-git project error = %+v", e)
	}
	if findItem(items, wshrpc.StorageKind_RunTree, goneTree) != nil {
		t.Fatal("the unreadable project's tree must be left out")
	}
	good := findItem(items, wshrpc.StorageKind_RunTree, goodTree)
	if good == nil || good.ProjectName != "good" || good.Tracked || !good.Clearable {
		t.Fatalf("the readable project's tree = %+v", good)
	}
}

func TestScanFolderWithNoRun(t *testing.T) {
	env := useScanEnv(t)
	dir := filepath.Join(env.root, "scratch")
	mkdirs(t, dir)
	if err := os.WriteFile(filepath.Join(env.root, "0d1f6a52.run"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	items, _, err := scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	item := findItem(items, wshrpc.StorageKind_RunTree, dir)
	if item == nil || item.RunId != "" || item.ProjectPath != "" || item.Group != wshrpc.StorageGroup_Left || !item.Clearable {
		t.Fatalf("no-run folder = %+v", item)
	}
	if countKind(items, wshrpc.StorageKind_RunTree) != 1 {
		t.Fatalf("only folders are rows: %v", items)
	}
}

// the dev and packaged apps share the worktree root, each with its own store and projects.json
func TestScanTreesOfAnotherStore(t *testing.T) {
	env := useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	runID := uuid.NewString()
	runTree, err := orchestrate.CreateRunWorktree(ctx, repo, runID+"-t-1", "")
	if err != nil {
		t.Fatal(err)
	}
	handmade, err := orchestrate.CreateRunWorktree(ctx, repo, "handmade", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, wt := range []string{runTree, handmade} {
		if err := os.WriteFile(filepath.Join(wt, "new.txt"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	standalone := filepath.Join(env.root, "standalone")
	mkdirs(t, standalone)
	gitT(t, standalone, "init", "-q")
	otherID := uuid.NewString()
	markerTree := filepath.Join(env.root, otherID[:8]+"-t-2")
	mkdirs(t, markerTree)
	if err := os.WriteFile(filepath.Join(env.root, otherID[:8]+".run"), []byte(otherID), 0o644); err != nil {
		t.Fatal(err)
	}

	items, _, err := scan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	item := findItem(items, wshrpc.StorageKind_RunTree, runTree)
	if item == nil || pathKey(item.ProjectPath) != pathKey(repo) || !item.Tracked || item.Dirty != 1 || item.Branch != "wave/"+runID+"-t-1" {
		t.Fatalf("a tree of an unregistered project = %+v, want its project, git state and branch read from the tree", item)
	}
	if item.RunId != "" || item.Clearable || item.Skip != wshrpc.StorageSkip_Unreadable {
		t.Fatalf("a tree whose run this store does not have = %+v, want unreadable", item)
	}
	hm := findItem(items, wshrpc.StorageKind_RunTree, handmade)
	if hm == nil || !hm.Tracked || hm.Dirty != 1 || hm.Clearable || hm.Skip != wshrpc.StorageSkip_Dirty {
		t.Fatalf("a no-run tree with uncommitted files = %+v, want skipped as dirty", hm)
	}
	if err := os.Remove(filepath.Join(handmade, "new.txt")); err != nil {
		t.Fatal(err)
	}
	if fresh, err := probe(ctx, *hm); err != nil || !fresh.Clearable {
		t.Fatalf("probe of the clean no-run tree = %+v %v, want clearable", fresh, err)
	}
	if sa := findItem(items, wshrpc.StorageKind_RunTree, standalone); sa == nil || sa.Clearable || sa.Skip != wshrpc.StorageSkip_Unreadable {
		t.Fatalf("a repository of its own = %+v, want unreadable", sa)
	}
	mt := findItem(items, wshrpc.StorageKind_RunTree, markerTree)
	if mt == nil || mt.RunId != "" || mt.Group != wshrpc.StorageGroup_Left || mt.Clearable || mt.Skip != wshrpc.StorageSkip_Unreadable {
		t.Fatalf("a marker tree whose run this store does not have = %+v, want left over and unreadable", mt)
	}
}

func TestScanBranchWithNoStoredRun(t *testing.T) {
	useScanEnv(t)
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	branch := "wave/" + uuid.NewString()
	gitT(t, repo, "branch", branch)
	items, _, err := scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if item.Kind == wshrpc.StorageKind_Branch && item.Branch == branch {
			if item.Clearable || item.Skip != wshrpc.StorageSkip_Unreadable {
				t.Fatalf("a branch whose run this store does not have = %+v, want unreadable", item)
			}
			return
		}
	}
	t.Fatalf("no row for %s in %v", branch, items)
}

func TestScanFinalAndTranscripts(t *testing.T) {
	env := useScanEnv(t)
	base := filepath.Join(env.appData, finalBaseName)
	mkdirs(t,
		filepath.Join(base, "target", "debug"), filepath.Join(base, "target-2", "debug"),
		filepath.Join(base, "stores", "a1b2c3d4"), filepath.Join(base, "stores-1", "e5f6a7b8"),
		filepath.Join(env.appData, "arc-final-out-1"), filepath.Join(env.appData, "arc-final-out-2"),
		filepath.Join(env.temp, "arc-final-attn"),
		filepath.Join(orchestrate.FinalShotsRoot(), uuid.NewString(), "1"),
		filepath.Join(env.home, ".claude", "projects", "C--x"),
	)
	if err := os.WriteFile(filepath.Join(env.temp, "arc-final-run.log"), []byte("log"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(orchestrate.FinalShotsRoot()) })

	items, _, err := scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s := findItem(items, wshrpc.StorageKind_FinalSlot, filepath.Join(base, "target-2")); s == nil || s.Slot != 2 || s.Group != wshrpc.StorageGroup_Kept {
		t.Fatalf("slot 2 = %+v", s)
	}
	if s := findItem(items, wshrpc.StorageKind_FinalSlot, filepath.Join(base, "target")); s == nil || s.Slot != 0 {
		t.Fatalf("slot 0 = %+v", s)
	}
	if n := countKind(items, wshrpc.StorageKind_FinalStores); n != 1 {
		t.Fatalf("%d finalstores rows, want 1", n)
	}
	if s := findItem(items, wshrpc.StorageKind_FinalStores, base); s.Count != 2 || s.Group != wshrpc.StorageGroup_Kept {
		t.Fatalf("stores = %+v", s)
	}
	if s := findItem(items, wshrpc.StorageKind_FinalShots, orchestrate.FinalShotsRoot()); s == nil || s.Count != 1 || s.Group != wshrpc.StorageGroup_Kept {
		t.Fatalf("shots = %+v", s)
	}
	if o := findItem(items, wshrpc.StorageKind_FinalOut, env.appData); o == nil || o.Count != 2 || !o.Clearable {
		t.Fatalf("appdata final out = %+v", o)
	}
	if o := findItem(items, wshrpc.StorageKind_FinalOut, env.temp); o == nil || o.Count != 2 || !o.Clearable {
		t.Fatalf("temp final out = %+v, want the folder and the file", o)
	}
	if tr := findItem(items, wshrpc.StorageKind_Transcripts, filepath.Join(env.home, ".claude", "projects")); tr == nil || tr.Harness != "claude" || tr.Group != wshrpc.StorageGroup_Kept {
		t.Fatalf("claude transcripts = %+v", tr)
	}
	if countKind(items, wshrpc.StorageKind_Transcripts) != 1 {
		t.Fatal("a missing ~/.pi must not be a row")
	}
}

// a run tree whose run was stored after the scan takes that run's project; with no run it has none, and once
// its folder is gone with no branch left it is gone
func TestProbeRunTreeTakesTheProjectOfARunStoredSinceTheScan(t *testing.T) {
	env := useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	runID := uuid.NewString()
	dir := filepath.Join(env.root, runID+"-t-1")
	mkdirs(t, dir)
	items, _, err := scan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	item := findItem(items, wshrpc.StorageKind_RunTree, dir)
	if item == nil || item.ProjectPath != "" {
		t.Fatalf("tree of an unstored run = %+v, want a row with no project", item)
	}
	fresh, err := probe(ctx, *item)
	if err != nil || fresh.ProjectPath != "" || fresh.RunId != "" {
		t.Fatalf("probe with the run still unstored = %+v %v, want no run and no project", fresh, err)
	}
	storeRun(t, &waveobj.Run{OID: runID, ProjectPath: repo, Status: "done"})
	fresh, err = probe(ctx, *item)
	if err != nil || pathKey(fresh.ProjectPath) != pathKey(repo) || fresh.RunId != runID {
		t.Fatalf("probe once the run is stored = %+v %v, want the run's project %s", fresh, err, repo)
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := probe(ctx, *item); err != ErrGone {
		t.Fatalf("probe of the removed branchless folder = %v, want ErrGone", err)
	}
}

// a legacy group whose project can no longer be read keeps its members and is skipped, not dropped
func TestProbeLegacyGroupOfAnUnreadableProject(t *testing.T) {
	useScanEnv(t)
	ctx := context.Background()
	repo := newRepo(t)
	registerProject(t, "proj", repo)
	legacy := orchestrate.LegacyWorktreesDir(repo)
	run := storeRun(t, &waveobj.Run{ProjectPath: repo, Status: "done"})
	for lane := 1; lane <= 2; lane++ {
		mkdirs(t, filepath.Join(legacy, run.OID+"-t-"+strconv.Itoa(lane), "leftover"))
	}
	items, _, err := scan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	g := findItem(items, wshrpc.StorageKind_LegacyGroup, legacy)
	if g == nil || g.Count != 2 {
		t.Fatalf("legacy group = %+v, want 2 members", g)
	}
	if err := os.Rename(repo, repo+"-moved"); err != nil {
		t.Fatal(err)
	}
	fresh, err := probe(ctx, *g)
	if err != nil || fresh.Skip != wshrpc.StorageSkip_Unreadable || fresh.Count != 2 || !reflect.DeepEqual(fresh.Paths, g.Paths) {
		t.Fatalf("probe of the moved project's group = %+v %v, want its 2 members kept and skipped as unreadable", fresh, err)
	}
}

// Final shots count their dags; other path rows keep the count of their member paths
func TestProbeFinalRowsCount(t *testing.T) {
	env := useScanEnv(t)
	ctx := context.Background()
	root := orchestrate.FinalShotsRoot()
	mkdirs(t,
		filepath.Join(root, uuid.NewString(), "1"), filepath.Join(root, uuid.NewString(), "1"),
		filepath.Join(env.appData, "arc-final-out-1"), filepath.Join(env.appData, "arc-final-out-2"),
		filepath.Join(env.appData, "another-app"),
	)
	t.Cleanup(func() { os.RemoveAll(root) })
	items, _, err := scan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ kind, path string }{{wshrpc.StorageKind_FinalShots, root}, {wshrpc.StorageKind_FinalOut, env.appData}} {
		item := findItem(items, c.kind, c.path)
		if item == nil {
			t.Fatalf("no %s row for %s", c.kind, c.path)
		}
		if fresh, err := probe(ctx, *item); err != nil || fresh.Count != 2 {
			t.Fatalf("probe of %s = %+v %v, want count 2", c.kind, fresh, err)
		}
	}
}
