// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentobserve"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const day = 24 * time.Hour

func claudeProjects(env scanEnv) string { return filepath.Join(env.home, ".claude", "projects") }
func piSessions(env scanEnv) string     { return filepath.Join(env.home, ".pi", "agent", "sessions") }

// claudeRunFolder is the folder Claude Code keeps a session started in tree (a folder under the worktree root) in.
func claudeRunFolder(env scanEnv, tree string) string {
	return filepath.Join(claudeProjects(env), agentobserve.SlugifyCwd(filepath.Join(env.root, tree)))
}

// piRunFolder is pi's: "--", the cwd with no leading separator and every separator and colon a dash, "--"
// (as in --C--Users-kael02-IdeaProjects-waveterm-.waveterm-arc-worker-check--).
func piRunFolder(env scanEnv, tree string) string {
	cwd := strings.TrimLeft(filepath.Join(env.root, tree), `/\`)
	return filepath.Join(piSessions(env), "--"+strings.NewReplacer(`\`, "-", "/", "-", ":", "-").Replace(cwd)+"--")
}

// writeFile writes body to path, making its folders, and returns its length.
func writeFile(t *testing.T, path, body string) int64 {
	t.Helper()
	mkdirs(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return int64(len(body))
}

// writtenAt sets the mtime of path and everything under it.
func writtenAt(t *testing.T, path string, ts time.Time) {
	t.Helper()
	err := filepath.WalkDir(path, func(p string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Chtimes(p, ts, ts)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func runTranscriptRows(items []wshrpc.StorageItem) []wshrpc.StorageItem {
	var rows []wshrpc.StorageItem
	for _, item := range items {
		if item.Kind == wshrpc.StorageKind_RunTranscripts {
			rows = append(rows, item)
		}
	}
	return rows
}

func TestScanRunTranscripts(t *testing.T) {
	cases := []struct {
		name        string
		status      string        // "" = no stored run
		finishedAgo time.Duration // of a stored run
		writtenAgo  time.Duration
		twinRun     bool // a second stored run shares the prefix
		tree        bool // a tree of the prefix is on disk
		want        bool
	}{
		{name: "done 15 days ago", status: "done", finishedAgo: 15 * day, want: true},
		{name: "cancelled 15 days ago", status: "cancelled", finishedAgo: 15 * day, want: true},
		{name: "done 13 days ago", status: "done", finishedAgo: 13 * day, writtenAgo: 20 * day},
		{name: "done 15 days ago with a tree on disk", status: "done", finishedAgo: 15 * day, tree: true},
		{name: "running", status: "running", writtenAgo: 20 * day},
		{name: "blocked", status: "blocked", finishedAgo: 15 * day, writtenAgo: 20 * day},
		{name: "unknown run written 15 days ago", writtenAgo: 15 * day, want: true},
		{name: "unknown run written 13 days ago", writtenAgo: 13 * day},
		{name: "unknown run written 15 days ago with a tree on disk", writtenAgo: 15 * day, tree: true},
		{name: "two runs share the prefix, written 15 days ago", status: "done", finishedAgo: 2 * day, twinRun: true, writtenAgo: 15 * day, want: true},
		{name: "two runs share the prefix, written 13 days ago", status: "done", finishedAgo: 20 * day, twinRun: true, writtenAgo: 13 * day},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := useScanEnv(t)
			ctx := context.Background()
			now := time.Now()
			runID := uuid.NewString()
			prefix := runID[:8]
			var run *waveobj.Run
			if tc.status != "" {
				dag := &waveobj.TaskGroup{OID: uuid.NewString(), Title: "Clear transcripts"}
				dag.ID = dag.OID
				if err := wstore.DBInsert(ctx, dag); err != nil {
					t.Fatal(err)
				}
				run = &waveobj.Run{OID: runID, ChannelOID: uuid.NewString(), Status: tc.status, DagORef: "dag:" + dag.OID, CreatedTs: now.Add(-30 * day).UnixMilli()}
				if tc.finishedAgo != 0 {
					run.CompletedTs = now.Add(-tc.finishedAgo).UnixMilli()
				}
				storeRun(t, run)
			}
			if tc.twinRun {
				storeRun(t, &waveobj.Run{OID: prefix + uuid.NewString()[8:], Status: "done", CompletedTs: now.Add(-20 * day).UnixMilli()})
			}
			folders := []string{
				claudeRunFolder(env, prefix),
				claudeRunFolder(env, prefix+"-t-1"),
				claudeRunFolder(env, prefix+"-t-2"),
				piRunFolder(env, prefix+"-t-3"),
			}
			var size int64
			for _, f := range folders {
				size += writeFile(t, filepath.Join(f, uuid.NewString()+".jsonl"), "{\"type\":\"user\"}\n")
				writtenAt(t, f, now.Add(-tc.writtenAgo))
			}
			// another project's folder and a non-run folder under the root are no run's
			for _, other := range []string{filepath.Join(claudeProjects(env), "C--repo"), claudeRunFolder(env, "zzzzzzzz-t-1")} {
				writeFile(t, filepath.Join(other, "s.jsonl"), "x")
				writtenAt(t, other, now.Add(-20*day))
			}
			mkdirs(t, env.root)
			if tc.tree {
				mkdirs(t, filepath.Join(env.root, prefix+"-t-1"))
			}

			rows := runTranscriptRows(scanItems(t))
			if !tc.want {
				if len(rows) != 0 {
					t.Fatalf("rows %+v, want none", rows)
				}
				return
			}
			if len(rows) != 1 {
				t.Fatalf("rows %+v, want one", rows)
			}
			row := rows[0]
			want := wshrpc.StorageItem{
				Id: "runtranscripts:" + prefix, Kind: wshrpc.StorageKind_RunTranscripts, Group: wshrpc.StorageGroup_Left, Clearable: true,
				Path: claudeProjects(env), Paths: folders, Count: len(folders), Size: size, ModTs: row.ModTs,
			}
			if run != nil && !tc.twinRun {
				want.RunId, want.RunChannelId, want.RunTitle, want.RunStatus, want.RunTs = runID, run.ChannelOID, "Clear transcripts", tc.status, run.CompletedTs
			}
			if !slices.Equal(row.Paths, want.Paths) || row.Id != want.Id || row.Kind != want.Kind || row.Group != want.Group || row.Clearable != want.Clearable ||
				row.Path != want.Path || row.Count != want.Count || row.Size != want.Size || row.RunId != want.RunId || row.RunChannelId != want.RunChannelId ||
				row.RunTitle != want.RunTitle || row.RunStatus != want.RunStatus || row.RunTs != want.RunTs || row.Skip != "" {
				t.Fatalf("row %+v,\nwant %+v", row, want)
			}
			if wantMod := now.Add(-tc.writtenAgo).UnixMilli(); row.ModTs/1000 != wantMod/1000 {
				t.Fatalf("row ModTs %d, want %d", row.ModTs, wantMod)
			}
		})
	}
}

// a run row's bytes leave its harness's transcripts row, and no byte is counted in both
func TestScanTranscriptsRowsLeaveOutRunRows(t *testing.T) {
	env := useScanEnv(t)
	now := time.Now()
	mkdirs(t, env.root)
	var claudeTotal, piTotal, claudeRun, piRun int64
	claudeTotal += writeFile(t, filepath.Join(claudeProjects(env), "C--repo", "s.jsonl"), "interactive session")
	piTotal += writeFile(t, filepath.Join(env.home, ".pi", "agent", "settings.json"), "{}")
	for _, runID := range []string{uuid.NewString(), uuid.NewString()} {
		storeRun(t, &waveobj.Run{OID: runID, Status: "done", CompletedTs: now.Add(-15 * day).UnixMilli()})
		n := writeFile(t, filepath.Join(claudeRunFolder(env, runID[:8]), "lead.jsonl"), "lead "+runID)
		claudeTotal, claudeRun = claudeTotal+n, claudeRun+n
		n = writeFile(t, filepath.Join(piRunFolder(env, runID[:8]+"-t-1"), "w.jsonl"), "worker "+runID)
		piTotal, piRun = piTotal+n, piRun+n
	}
	// a run not yet left over keeps its bytes in the transcripts row
	recent := storeRun(t, &waveobj.Run{Status: "done", CompletedTs: now.Add(-day).UnixMilli()})
	claudeTotal += writeFile(t, filepath.Join(claudeRunFolder(env, recent.OID[:8]), "lead.jsonl"), "recent lead")

	items := scanItems(t)
	var runRows int64
	for _, row := range runTranscriptRows(items) {
		runRows += row.Size
	}
	if runRows != claudeRun+piRun {
		t.Fatalf("run rows hold %d bytes, want %d", runRows, claudeRun+piRun)
	}
	claude := mustFind(t, items, wshrpc.StorageKind_Transcripts, claudeProjects(env))
	if claude.Size+claudeRun != claudeTotal {
		t.Fatalf("claude transcripts %d + its run rows %d, want the root's %d", claude.Size, claudeRun, claudeTotal)
	}
	pi := mustFind(t, items, wshrpc.StorageKind_Transcripts, filepath.Join(env.home, ".pi"))
	if pi.Size+piRun != piTotal {
		t.Fatalf("pi transcripts %d + its run rows %d, want the root's %d", pi.Size, piRun, piTotal)
	}
}
