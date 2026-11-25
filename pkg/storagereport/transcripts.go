// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentobserve"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/usagestats"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	// a tree folder's name starts with its run id's first 8 characters (orchestrate's runPrefixLen)
	runPrefixLen = 8
	// a run's transcripts are left over this long after it finished, or, for a run this store does not know,
	// after their last write
	runTranscriptsMinAge = 14 * 24 * time.Hour
)

// package var so a test makes keeping fail
var keepTranscriptDirs = usagestats.KeepTranscriptDirs

// transcriptRoot is a harness's session-folder root and how it names the folder of a session started in a tree.
type transcriptRoot struct {
	harness string
	dir     string
	head    string // a run tree's folder name: head, then the tree's name (and any subfolder), then tail
	tail    string
}

type transcriptFolder struct {
	harness, path string
}

// transcriptRoots: Claude names a session's folder SlugifyCwd(cwd); pi names it "--" + cwd with no leading
// separator and every separator and colon a dash + "--".
func transcriptRoots(home, worktreeRoot string) []transcriptRoot {
	return []transcriptRoot{
		{harness: "claude", dir: filepath.Join(home, ".claude", "projects"), head: agentobserve.SlugifyCwd(worktreeRoot) + "-"},
		{harness: "pi", dir: filepath.Join(home, ".pi", "agent", "sessions"), head: "--" + piPathName(worktreeRoot) + "-", tail: "--"},
	}
}

func piPathName(path string) string {
	path = strings.TrimPrefix(strings.TrimPrefix(path, "/"), `\`)
	return strings.NewReplacer("/", "-", `\`, "-", ":", "-").Replace(path)
}

// runPrefix is the run prefix a session folder's name holds, "" when it is no run tree's folder.
func (r transcriptRoot) runPrefix(name string) string {
	// both names come from a Windows path in practice, whose case Claude and pi keep as the cwd had it
	if len(name) < len(r.head) || !strings.EqualFold(name[:len(r.head)], r.head) {
		return ""
	}
	rest, ok := strings.CutSuffix(name[len(r.head):], r.tail)
	if !ok || len(rest) < runPrefixLen || (len(rest) > runPrefixLen && rest[runPrefixLen] != '-') {
		return ""
	}
	prefix := rest[:runPrefixLen]
	if strings.Trim(prefix, "0123456789abcdef") != "" {
		return ""
	}
	return prefix
}

// runTranscriptFolders is every run tree's transcript folder by run prefix, Claude's before pi's.
func runTranscriptFolders(home string) (map[string][]transcriptFolder, error) {
	groups := map[string][]transcriptFolder{}
	for _, root := range transcriptRoots(home, orchestrate.WorktreeRoot()) {
		names, err := listDirs(root.dir)
		if err != nil {
			return nil, err
		}
		for _, name := range names {
			if prefix := root.runPrefix(name); prefix != "" {
				groups[prefix] = append(groups[prefix], transcriptFolder{harness: root.harness, path: filepath.Join(root.dir, name)})
			}
		}
	}
	return groups, nil
}

func runsByPrefix(ctx context.Context) (map[string][]*waveobj.Run, error) {
	runs, err := wstore.GetAllRunsShared(ctx)
	if err != nil {
		return nil, fmt.Errorf("reading the stored runs: %w", err)
	}
	byPrefix := map[string][]*waveobj.Run{}
	for _, run := range runs {
		if len(run.OID) >= runPrefixLen {
			byPrefix[run.OID[:runPrefixLen]] = append(byPrefix[run.OID[:runPrefixLen]], run)
		}
	}
	return byPrefix, nil
}

// runTranscriptItems is a row per run whose transcript folders are left over, and the bytes those rows hold under
// each harness's root.
func (s *scanner) runTranscriptItems(home string, trees []string) ([]wshrpc.StorageItem, map[string]int64, error) {
	groups, err := runTranscriptFolders(home)
	if err != nil || len(groups) == 0 {
		return nil, nil, err
	}
	runs, err := runsByPrefix(s.ctx)
	if err != nil {
		return nil, nil, err
	}
	prefixes := make([]string, 0, len(groups))
	for prefix := range groups {
		prefixes = append(prefixes, prefix)
	}
	slices.Sort(prefixes)
	var items []wshrpc.StorageItem
	held := map[string]int64{}
	now := time.Now()
	for _, prefix := range prefixes {
		item, byHarness, notLeft := s.runTranscriptsRow(prefix, groups[prefix], runs[prefix], trees, now)
		if notLeft != "" {
			continue
		}
		items = append(items, item)
		for harness, n := range byHarness {
			held[harness] += n
		}
	}
	return items, held, nil
}

// runTranscriptsRow reads prefix's run and sizes its folders. notLeft says why the run is not left over, ""
// when it is; byHarness is the row's bytes under each harness's root.
func (s *scanner) runTranscriptsRow(prefix string, folders []transcriptFolder, runs []*waveobj.Run, trees []string, now time.Time) (item wshrpc.StorageItem, byHarness map[string]int64, notLeft string) {
	item = wshrpc.StorageItem{Id: wshrpc.StorageKind_RunTranscripts + ":" + prefix, Kind: wshrpc.StorageKind_RunTranscripts}
	for _, tree := range trees {
		if strings.HasPrefix(tree, prefix) {
			return item, nil, "its run has a tree on disk again"
		}
	}
	minTs := now.Add(-runTranscriptsMinAge).UnixMilli()
	// one stored run with the prefix is this run; none or several leave it unknown, aged by its folders' writes
	known := len(runs) == 1
	if known {
		run := runs[0]
		if !runFinished(run.Status) {
			return item, nil, fmt.Sprintf("its run is %s", run.Status)
		}
		finishedTs := run.CompletedTs
		if finishedTs == 0 {
			finishedTs = run.CreatedTs
		}
		if finishedTs > minTs {
			return item, nil, "its run finished less than 14 days ago"
		}
		s.fillRun(&item, run.OID)
	}
	byHarness = map[string]int64{}
	for _, f := range folders {
		size, modTs, err := pathSize(s.ctx, f.path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			log.Printf("storage scan: sizing %s: %v", f.path, err)
			item.Skip = wshrpc.StorageSkip_Unreadable
		}
		item.Paths = append(item.Paths, f.path)
		item.Size += size
		item.ModTs = max(item.ModTs, modTs)
		byHarness[f.harness] += size
	}
	item.Count = len(item.Paths)
	if item.Count == 0 {
		return item, nil, "its folders are gone"
	}
	item.Path = filepath.Dir(item.Paths[0])
	if !known && item.ModTs > minTs {
		return item, nil, "its folders were written in the last 14 days"
	}
	return item, byHarness, ""
}

// probeRunTranscripts re-reads a run-transcripts row's folders still on disk, and its run. A run that is no
// longer left over is a Skipped ClearError saying why.
func (s *scanner) probeRunTranscripts(item wshrpc.StorageItem) (wshrpc.StorageItem, error) {
	prefix := strings.TrimPrefix(item.Id, wshrpc.StorageKind_RunTranscripts+":")
	home, err := userHomeDir()
	if err != nil {
		return item, fmt.Errorf("finding the home folder: %w", err)
	}
	groups, err := runTranscriptFolders(home)
	if err != nil {
		return item, err
	}
	shown := map[string]bool{}
	for _, p := range item.Paths {
		shown[pathKey(p)] = true
	}
	var folders []transcriptFolder
	for _, f := range groups[prefix] {
		if shown[pathKey(f.path)] {
			folders = append(folders, f)
		}
	}
	if len(folders) == 0 {
		return item, ErrGone
	}
	trees, err := listDirs(orchestrate.WorktreeRoot())
	if err != nil {
		return item, err
	}
	runs, err := runsByPrefix(s.ctx)
	if err != nil {
		return item, err
	}
	fresh, _, notLeft := s.runTranscriptsRow(prefix, folders, runs[prefix], trees, time.Now())
	if notLeft != "" {
		return fresh, skipped(notLeft)
	}
	return fresh, nil
}

// removeRunTranscripts keeps the folders' usage, then deletes them; a failed keep deletes nothing.
func removeRunTranscripts(ctx context.Context, fresh wshrpc.StorageItem) error {
	if err := keepTranscriptDirs(ctx, fresh.Paths); err != nil {
		return fmt.Errorf("keeping its usage before clearing: %w", err)
	}
	return removeMembers(fresh.Paths)
}
