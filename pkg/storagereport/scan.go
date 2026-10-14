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
	"slices"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// the arc-final layout is scripts/cdp/final-verify.mjs's: <LOCALAPPDATA or ~/.cache>\arc-final\{target,stores}[-N]
const (
	finalBaseName    = "arc-final"
	finalSlotName    = "target"
	finalStoresName  = "stores"
	finalOutPattern  = "arc-final-out-*" // under LOCALAPPDATA
	finalTempPattern = "arc-final-*"     // under %TEMP%
)

// ErrGone is probe's answer for an item with nothing of it left on disk or in git.
var ErrGone = errors.New("nothing of it is left")

// package vars so tests keep the scan out of the real home, app data and temp dirs
var (
	userHomeDir     = os.UserHomeDir
	localAppDataDir = func() string {
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			return dir
		}
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".cache")
	}
	tempDir = os.TempDir
)

type runFacts struct {
	run   *waveobj.Run // nil = no stored run
	title string
	err   error
}

// scanner caches the runs and projects one scan or probe reads.
type scanner struct {
	ctx      context.Context
	runs     map[string]*runFacts
	projects map[string]*project // by pathKey
	order    []*project
}

func newScanner(ctx context.Context) *scanner {
	return &scanner{ctx: ctx, runs: map[string]*runFacts{}, projects: map[string]*project{}}
}

func (s *scanner) runFor(runID string) *runFacts {
	if rf, ok := s.runs[runID]; ok {
		return rf
	}
	run, err := wstore.DBGet[*waveobj.Run](s.ctx, runID)
	rf := &runFacts{run: run, err: err}
	if err != nil {
		log.Printf("storage scan: reading run %s: %v", runID, err)
	} else if run != nil {
		rf.title = runTitle(s.ctx, run)
	}
	s.runs[runID] = rf
	return rf
}

// runTitle is the run's dag title, else the first line of its goal.
func runTitle(ctx context.Context, run *waveobj.Run) string {
	if oref, err := waveobj.ParseORef(run.DagORef); err == nil {
		if obj, err := wstore.DBGetORef(ctx, oref); err == nil {
			if tg, ok := obj.(*waveobj.TaskGroup); ok && tg.Title != "" {
				return tg.Title
			}
		}
	}
	goal, _, _ := strings.Cut(strings.TrimSpace(run.Goal), "\n")
	return strings.TrimSpace(goal)
}

// project loads a project once; name "" takes the folder's base name.
func (s *scanner) project(name, path string) *project {
	k := pathKey(path)
	if p, ok := s.projects[k]; ok {
		return p
	}
	if name == "" {
		name = filepath.Base(filepath.Clean(path))
	}
	p := loadProject(s.ctx, name, path)
	s.projects[k] = p
	s.order = append(s.order, p)
	return p
}

// ownerProject is, for a folder with no run, the readable project whose git worktree list names it, else the one
// holding its wave/<key> branch.
func (s *scanner) ownerProject(path, key string) *project {
	for _, p := range s.order {
		if p.err == nil && p.isTracked(path) {
			return p
		}
	}
	if key == "" {
		return nil
	}
	for _, p := range s.order {
		if _, ok := p.branches[waveBranchPrefix+key]; ok && p.err == nil {
			return p
		}
	}
	return nil
}

// treeProject is the project a git tree folder belongs to, read from the tree itself: the parent of its common git
// dir. It finds the trees of a run this store does not have, in a project this app does not register.
func (s *scanner) treeProject(path string) (*project, error) {
	out, err := runGit(s.ctx, path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return nil, err
	}
	common := filepath.Clean(out)
	projectPath := filepath.Dir(common)
	if filepath.Base(common) != ".git" || pathKey(projectPath) == pathKey(path) {
		return nil, fmt.Errorf("%s is not a linked worktree of a project", path)
	}
	return s.project("", projectPath), nil
}

func scan(ctx context.Context) ([]wshrpc.StorageItem, []wshrpc.StorageScanError, error) {
	s := newScanner(ctx)
	var scanErrs []wshrpc.StorageScanError
	registered, err := registeredProjects()
	if err != nil {
		scanErrs = append(scanErrs, wshrpc.StorageScanError{ProjectName: wconfig.ProjectsFile, ProjectPath: filepath.Join(wavebase.GetWaveConfigDir(), wconfig.ProjectsFile), Error: err.Error()})
	}
	for _, rp := range registered {
		s.project(rp[0], rp[1])
	}

	root := orchestrate.WorktreeRoot()
	rootDirs, err := listDirs(root)
	if err != nil {
		return nil, nil, err
	}
	type rootTree struct {
		path, key string
		proj      *project
	}
	var trees []rootTree
	for _, name := range rootDirs {
		t := rootTree{path: filepath.Join(root, name)}
		t.key, _ = orchestrate.RunKeyForTreeDir(root, name)
		if runID, _, ok := orchestrate.SplitRunKey(t.key); ok {
			if rf := s.runFor(runID); rf.run != nil && rf.run.ProjectPath != "" {
				t.proj = s.project("", rf.run.ProjectPath)
			}
		}
		trees = append(trees, t)
	}

	var items []wshrpc.StorageItem
	for _, t := range trees {
		if t.proj == nil {
			t.proj = s.ownerProject(t.path, t.key)
		}
		// a project that could not be read leaves its folders out, never listed as owned by no one
		if t.proj != nil && t.proj.err != nil {
			continue
		}
		item := wshrpc.StorageItem{Id: wshrpc.StorageKind_RunTree + ":" + t.path, Kind: wshrpc.StorageKind_RunTree, Path: t.path}
		s.fillTree(&item, t.key, t.proj)
		items = append(items, item)
	}

	for _, p := range s.order {
		if p.err != nil {
			scanErrs = append(scanErrs, wshrpc.StorageScanError{ProjectName: p.name, ProjectPath: p.path, Error: p.err.Error()})
			continue
		}
		legacy, err := s.legacyItems(p)
		if err != nil {
			scanErrs = append(scanErrs, wshrpc.StorageScanError{ProjectName: p.name, ProjectPath: p.path, Error: err.Error()})
		}
		items = append(items, legacy...)
		items = append(items, s.branchItems(p)...)
	}

	kept, err := s.finalAndTranscriptItems()
	if err != nil {
		return nil, nil, err
	}
	items = append(items, kept...)
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	for i := range items {
		classify(&items[i])
	}
	return items, scanErrs, nil
}

// registeredProjects is projects.json's [name, path] pairs, by name.
func registeredProjects() ([][2]string, error) {
	cfg := wconfig.ReadFullConfig()
	var rtn [][2]string
	for name, pk := range cfg.Projects {
		if pk.Path != "" {
			rtn = append(rtn, [2]string{name, wavebase.ExpandHomeDirSafe(pk.Path)})
		}
	}
	slices.SortFunc(rtn, func(a, b [2]string) int { return strings.Compare(a[0], b[0]) })
	for _, cerr := range cfg.ConfigErrors {
		if strings.HasSuffix(filepath.ToSlash(cerr.File), wconfig.ProjectsFile) {
			return rtn, errors.New(cerr.Err)
		}
	}
	return rtn, nil
}

// listDirs is the folder names in dir; a missing dir has none.
func listDirs(dir string) ([]string, error) {
	if dir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("listing %s: %w", dir, err)
	}
	var names []string
	for _, e := range entries {
		// a junction or symlink at the top is not a folder Arc made
		if e.IsDir() && e.Type()&linkModes == 0 {
			names = append(names, e.Name())
		}
	}
	return names, nil
}

// listMatches is the names in dir, folders and files, matching pattern.
func listMatches(dir, pattern string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("listing %s: %w", dir, err)
	}
	var paths []string
	for _, e := range entries {
		if ok, _ := filepath.Match(pattern, e.Name()); ok {
			paths = append(paths, filepath.Join(dir, e.Name()))
		}
	}
	return paths, nil
}

// fillRun sets the run fields from runID's stored run. A run that could not be read keeps only RunId, which
// classify reads as unreadable.
func (s *scanner) fillRun(item *wshrpc.StorageItem, runID string) *waveobj.Run {
	rf := s.runFor(runID)
	if rf.err != nil {
		item.RunId = runID
		return nil
	}
	run := rf.run
	if run == nil {
		// nothing deletes run rows, so a run id this store never had is another app's (the dev and packaged apps
		// share the worktree root), and may be live
		item.Skip = wshrpc.StorageSkip_Unreadable
		return nil
	}
	item.RunId, item.RunChannelId, item.RunTitle, item.RunStatus = run.OID, run.ChannelOID, rf.title, run.Status
	item.RunTs = run.CreatedTs
	if run.CompletedTs != 0 {
		item.RunTs = run.CompletedTs
	}
	if run.Land != nil {
		item.RunLandState, item.RunLandDismissed = run.Land.State, run.Land.Dismissed
	}
	return run
}

// fillTree reads a tree folder's facts: its run, git state, branch and size. proj nil = no project owns it.
func (s *scanner) fillTree(item *wshrpc.StorageItem, key string, proj *project) {
	var run *waveobj.Run
	if runID, suffix, ok := orchestrate.SplitRunKey(key); ok {
		item.Suffix = suffix
		run = s.fillRun(item, runID)
	}
	_, statErr := os.Lstat(item.Path)
	if statErr == nil {
		_, gitErr := os.Lstat(filepath.Join(item.Path, ".git"))
		item.HasGit = gitErr == nil
		size, modTs, err := pathSize(s.ctx, item.Path)
		item.Size, item.ModTs = size, modTs
		if err != nil {
			log.Printf("storage scan: sizing %s: %v", item.Path, err)
			item.Skip = wshrpc.StorageSkip_Unreadable
		}
	}
	if proj == nil && item.HasGit {
		var err error
		if proj, err = s.treeProject(item.Path); err != nil {
			log.Printf("storage scan: finding the project of %s: %v", item.Path, err)
			item.Skip = wshrpc.StorageSkip_Unreadable
			return
		}
	}
	if proj == nil {
		return
	}
	item.ProjectName, item.ProjectPath = proj.name, proj.path
	if proj.err != nil {
		item.Skip = wshrpc.StorageSkip_Unreadable
		return
	}
	item.Tracked = proj.isTracked(item.Path)
	// a .git its project does not list: git state that cannot be read through the project
	if item.HasGit && !item.Tracked {
		item.Skip = wshrpc.StorageSkip_Unreadable
	}
	// only with its own .git: without one, git in a legacy folder reads the project's status
	if item.Tracked && item.HasGit {
		out, err := runGit(s.ctx, item.Path, "status", "--porcelain")
		if err != nil {
			log.Printf("storage scan: git status in %s: %v", item.Path, err)
			item.Skip = wshrpc.StorageSkip_Unreadable
		}
		item.Dirty = len(lines(out))
	}
	if key == "" {
		return
	}
	if ref, ok := proj.branches[waveBranchPrefix+key]; ok {
		item.Branch, item.BranchTip = waveBranchPrefix+key, ref.tip
		proj.claimed[item.Branch] = true
		s.fillBranchFacts(item, proj, run)
	}
}

func (s *scanner) fillBranchFacts(item *wshrpc.StorageItem, proj *project, run *waveobj.Run) {
	base := ""
	if run != nil {
		base = run.BaseBranch
	}
	f, err := branchGitFacts(s.ctx, proj.path, item.Branch, item.BranchTip, base)
	if err != nil {
		log.Printf("storage scan: reading %s in %s: %v", item.Branch, proj.path, err)
		item.Skip = wshrpc.StorageSkip_Unreadable
		return
	}
	item.OnlyCount, item.OnlyCommits, item.AlsoOn = f.OnlyCount, f.OnlyCommits, f.AlsoOn
}

// groupable: an emptied, untracked, branchless legacy folder of a finished run
func groupable(item *wshrpc.StorageItem) bool {
	return !item.HasGit && !item.Tracked && item.Branch == "" && item.Skip == "" && runFinished(item.RunStatus)
}

func (s *scanner) legacyTree(p *project, path string) wshrpc.StorageItem {
	item := wshrpc.StorageItem{Id: wshrpc.StorageKind_LegacyTree + ":" + path, Kind: wshrpc.StorageKind_LegacyTree, Path: path}
	s.fillTree(&item, filepath.Base(path), p)
	return item
}

// legacyItems is a project's in-project trees: the groupable ones as one legacygroup row, every other its own row.
func (s *scanner) legacyItems(p *project) ([]wshrpc.StorageItem, error) {
	dir := orchestrate.LegacyWorktreesDir(p.path)
	names, err := listDirs(dir)
	if err != nil {
		return nil, err
	}
	var items, members []wshrpc.StorageItem
	for _, name := range names {
		item := s.legacyTree(p, filepath.Join(dir, name))
		if groupable(&item) {
			members = append(members, item)
		} else {
			items = append(items, item)
		}
	}
	if len(members) > 0 {
		items = append(items, legacyGroup(p, dir, members))
	}
	return items, nil
}

func legacyGroup(p *project, dir string, members []wshrpc.StorageItem) wshrpc.StorageItem {
	g := wshrpc.StorageItem{Id: wshrpc.StorageKind_LegacyGroup + ":" + dir, Kind: wshrpc.StorageKind_LegacyGroup, Path: dir, ProjectName: p.name, ProjectPath: p.path}
	runs := map[string]bool{}
	for _, m := range members {
		g.Paths = append(g.Paths, m.Path)
		g.Size += m.Size
		g.ModTs = max(g.ModTs, m.ModTs)
		g.RunTs = max(g.RunTs, m.RunTs)
		runs[m.RunId] = true
	}
	g.Count, g.RunCount = len(members), len(runs)
	return g
}

// branchItems is a project's wave branches no tree row claimed.
func (s *scanner) branchItems(p *project) []wshrpc.StorageItem {
	names := make([]string, 0, len(p.branches))
	for name := range p.branches {
		names = append(names, name)
	}
	slices.Sort(names)
	var items []wshrpc.StorageItem
	for _, name := range names {
		if p.claimed[name] {
			continue
		}
		item := wshrpc.StorageItem{Id: branchItemId(p.path, name), Kind: wshrpc.StorageKind_Branch, ProjectName: p.name, ProjectPath: p.path}
		s.fillBranch(&item, p, name)
		items = append(items, item)
	}
	return items
}

func branchItemId(projectPath, branch string) string {
	return wshrpc.StorageKind_Branch + ":" + projectPath + ":" + branch
}

func (s *scanner) fillBranch(item *wshrpc.StorageItem, p *project, branch string) {
	ref := p.branches[branch]
	item.Branch, item.BranchTip, item.ModTs = branch, ref.tip, ref.ts
	var run *waveobj.Run
	if runID, suffix, ok := orchestrate.SplitRunKey(strings.TrimPrefix(branch, waveBranchPrefix)); ok {
		item.Suffix = suffix
		run = s.fillRun(item, runID)
	}
	s.fillBranchFacts(item, p, run)
}

// pathsItem sizes a row made of paths (one, or a group's members); the members gone from disk are dropped.
func (s *scanner) pathsItem(item wshrpc.StorageItem, paths []string) (wshrpc.StorageItem, bool) {
	item.Size, item.ModTs, item.Paths = 0, 0, nil
	var found []string
	for _, path := range paths {
		size, modTs, err := pathSize(s.ctx, path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			log.Printf("storage scan: sizing %s: %v", path, err)
			item.Skip = wshrpc.StorageSkip_Unreadable
		}
		item.Size += size
		item.ModTs = max(item.ModTs, modTs)
		found = append(found, path)
	}
	if groupKinds[item.Kind] {
		item.Paths, item.Count = found, len(found)
	}
	return item, len(found) > 0
}

// kinds whose row stands for a list of member paths
var groupKinds = map[string]bool{
	wshrpc.StorageKind_LegacyGroup: true,
	wshrpc.StorageKind_FinalStores: true,
	wshrpc.StorageKind_FinalOut:    true,
}

func (s *scanner) finalAndTranscriptItems() ([]wshrpc.StorageItem, error) {
	var items []wshrpc.StorageItem
	add := func(item wshrpc.StorageItem, paths []string) {
		if item, ok := s.pathsItem(item, paths); ok {
			items = append(items, item)
		}
	}

	base := filepath.Join(localAppDataDir(), finalBaseName)
	names, err := listDirs(base)
	if err != nil {
		return nil, err
	}
	var stores []string
	for _, name := range names {
		if slot, ok := finalSlot(name, finalSlotName); ok {
			path := filepath.Join(base, name)
			add(wshrpc.StorageItem{Id: wshrpc.StorageKind_FinalSlot + ":" + path, Kind: wshrpc.StorageKind_FinalSlot, Path: path, Slot: slot}, []string{path})
		} else if _, ok := finalSlot(name, finalStoresName); ok {
			stores = append(stores, filepath.Join(base, name))
		}
	}
	if len(stores) > 0 {
		add(wshrpc.StorageItem{Id: wshrpc.StorageKind_FinalStores + ":" + base, Kind: wshrpc.StorageKind_FinalStores, Path: base}, stores)
	}

	shots := orchestrate.FinalShotsRoot()
	dags, err := listDirs(shots)
	if err != nil {
		return nil, err
	}
	if len(dags) > 0 {
		add(wshrpc.StorageItem{Id: wshrpc.StorageKind_FinalShots + ":" + shots, Kind: wshrpc.StorageKind_FinalShots, Path: shots, Count: len(dags)}, []string{shots})
	}

	for _, loc := range [][2]string{{localAppDataDir(), finalOutPattern}, {tempDir(), finalTempPattern}} {
		paths, err := listMatches(loc[0], loc[1])
		if err != nil {
			return nil, err
		}
		if len(paths) > 0 {
			add(wshrpc.StorageItem{Id: wshrpc.StorageKind_FinalOut + ":" + filepath.Join(loc[0], loc[1]), Kind: wshrpc.StorageKind_FinalOut, Path: loc[0]}, paths)
		}
	}

	home, err := userHomeDir()
	if err != nil {
		return nil, fmt.Errorf("finding the home folder: %w", err)
	}
	for _, t := range [][2]string{{"claude", filepath.Join(home, ".claude", "projects")}, {"pi", filepath.Join(home, ".pi")}} {
		add(wshrpc.StorageItem{Id: wshrpc.StorageKind_Transcripts + ":" + t[1], Kind: wshrpc.StorageKind_Transcripts, Path: t[1], Harness: t[0]}, []string{t[1]})
	}
	return items, nil
}

// finalSlot parses "<prefix>" (slot 0) or "<prefix>-N".
func finalSlot(name, prefix string) (int, bool) {
	if name == prefix {
		return 0, true
	}
	n, ok := strings.CutPrefix(name, prefix+"-")
	if !ok {
		return 0, false
	}
	slot, err := strconv.Atoi(n)
	return slot, err == nil && slot > 0
}

// treeKey is the engine key of a tree row's folder, "" when it has none.
func treeKey(item wshrpc.StorageItem) string {
	name := filepath.Base(item.Path)
	if item.Kind == wshrpc.StorageKind_LegacyTree {
		return name
	}
	key, _ := orchestrate.RunKeyForTreeDir(filepath.Dir(item.Path), name)
	return key
}

// probe re-reads one item's facts from disk, git and the store, and classifies it. ErrGone when nothing of it is
// left; a legacy group or Final output keeps only its members still on disk (and, for a group, still groupable).
func probe(ctx context.Context, item wshrpc.StorageItem) (wshrpc.StorageItem, error) {
	s := newScanner(ctx)
	fresh := wshrpc.StorageItem{Id: item.Id, Kind: item.Kind, Path: item.Path, Slot: item.Slot, Harness: item.Harness, ProjectName: item.ProjectName, ProjectPath: item.ProjectPath}
	var proj *project
	if item.ProjectPath != "" {
		proj = s.project(item.ProjectName, item.ProjectPath)
	}
	switch item.Kind {
	case wshrpc.StorageKind_RunTree, wshrpc.StorageKind_LegacyTree:
		key := treeKey(item)
		if runID, _, ok := orchestrate.SplitRunKey(key); ok {
			// a run stored since the scan names its project
			if rf := s.runFor(runID); rf.run != nil && rf.run.ProjectPath != "" {
				proj = s.project("", rf.run.ProjectPath)
			}
		}
		s.fillTree(&fresh, key, proj)
		if _, err := os.Lstat(item.Path); errors.Is(err, fs.ErrNotExist) && fresh.Branch == "" {
			return fresh, ErrGone
		}
	case wshrpc.StorageKind_Branch:
		if proj == nil {
			return fresh, fmt.Errorf("%s has no project", item.Id)
		}
		if proj.err != nil {
			fresh.Branch, fresh.Skip = item.Branch, wshrpc.StorageSkip_Unreadable
			break
		}
		if _, ok := proj.branches[item.Branch]; !ok {
			return fresh, ErrGone
		}
		s.fillBranch(&fresh, proj, item.Branch)
	case wshrpc.StorageKind_LegacyGroup:
		if proj == nil || proj.err != nil {
			fresh.Paths, fresh.Count, fresh.Skip = item.Paths, item.Count, wshrpc.StorageSkip_Unreadable
			break
		}
		var members []wshrpc.StorageItem
		for _, path := range item.Paths {
			if _, err := os.Lstat(path); err != nil {
				continue
			}
			if m := s.legacyTree(proj, path); groupable(&m) {
				members = append(members, m)
			}
		}
		if len(members) == 0 {
			return fresh, ErrGone
		}
		fresh = legacyGroup(proj, item.Path, members)
	default:
		paths := item.Paths
		if !groupKinds[item.Kind] {
			paths = []string{item.Path}
		}
		var ok bool
		if fresh, ok = s.pathsItem(fresh, paths); !ok {
			return fresh, ErrGone
		}
		if item.Kind == wshrpc.StorageKind_FinalShots {
			dags, _ := listDirs(item.Path)
			fresh.Count = len(dags)
		}
	}
	if err := ctx.Err(); err != nil {
		return fresh, err
	}
	classify(&fresh)
	return fresh, nil
}
