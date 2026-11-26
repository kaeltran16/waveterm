// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package usagestats

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// TestMain gives the keep tests a real store in a throwaway data dir.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "usagestats-test-*")
	if err != nil {
		panic(err)
	}
	wavebase.DataHome_VarCache = dir
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		panic(err)
	}
	if err := wstore.InitWStore(); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// keptFor is what Kept(sinceDay) holds for session, buckets ordered by day then model
func keptFor(t *testing.T, sinceDay, session string) ([]Bucket, []SessionMeta) {
	t.Helper()
	buckets, metas, err := Kept(context.Background(), sinceDay)
	if err != nil {
		t.Fatal(err)
	}
	var bs []Bucket
	for _, b := range buckets {
		if b.Session == session {
			bs = append(bs, b)
		}
	}
	slices.SortFunc(bs, func(a, b Bucket) int { return strings.Compare(a.Day+a.Model, b.Day+b.Model) })
	var ms []SessionMeta
	for _, m := range metas {
		if m.Session == session {
			ms = append(ms, m)
		}
	}
	return bs, ms
}

func TestKeepThenKeptRoundTrips(t *testing.T) {
	session := uuid.NewString()
	cost := 0.125
	buckets := []Bucket{
		{Harness: "pi", Provider: "openai-codex", Model: "gpt-5.5", Day: "2026-11-01", Session: session,
			Input: 1, Output: 2, Reasoning: 3, CacheRead: 4, CacheCreate: 5, CacheCreate1h: 6, ReportedCostUsd: &cost, Msgs: 7},
		{Harness: "pi", Provider: "anthropic", Model: "opus", Day: "2026-11-02", Session: session, Input: 8, Msgs: 1},
	}
	metas := []SessionMeta{{Harness: "pi", Session: session, Cwd: "/repo/app", Title: "Fix the scan"}}
	if err := Keep(context.Background(), buckets, metas); err != nil {
		t.Fatal(err)
	}
	gotBuckets, gotMetas := keptFor(t, "", session)
	if !reflect.DeepEqual(gotBuckets, buckets) || !reflect.DeepEqual(gotMetas, metas) {
		t.Fatalf("kept %+v %+v, want %+v %+v", gotBuckets, gotMetas, buckets, metas)
	}
	if gotBuckets[1].ReportedCostUsd != nil {
		t.Fatalf("nil reported cost came back as %v", *gotBuckets[1].ReportedCostUsd)
	}
	gotBuckets, gotMetas = keptFor(t, "2026-11-02", session)
	if !reflect.DeepEqual(gotBuckets, buckets[1:]) || !reflect.DeepEqual(gotMetas, metas) {
		t.Fatalf("kept since 2026-11-02: %+v %+v, want the second bucket and the session", gotBuckets, gotMetas)
	}
}

// a codex session is one running total dated by its last token count: a later day's keep moves it
func TestKeepMovesACodexSessionToItsLaterDay(t *testing.T) {
	session := "rollout-" + uuid.NewString()
	first := Bucket{Harness: "codex", Provider: "openai", Model: "gpt-5.6", Day: "2026-11-01", Session: session, Input: 10, Output: 1, Msgs: 1}
	later := first
	later.Day, later.Input = "2026-11-03", 30
	for _, b := range []Bucket{first, later} {
		if err := Keep(context.Background(), []Bucket{b}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if got, _ := keptFor(t, "", session); !reflect.DeepEqual(got, []Bucket{later}) {
		t.Fatalf("kept %+v, want only the later day's %+v", got, later)
	}
}

// a run's transcript folder kept before it is cleared gives the session the Usage scan gives it,
// its subagent's usage included, and nothing of the folders it was not given
func TestKeepTranscriptDirsKeepsWhatTheScanGives(t *testing.T) {
	claude := filepath.Join(t.TempDir(), "claude")
	session, other := uuid.NewString(), uuid.NewString()
	day1 := time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)
	day2 := day1.AddDate(0, 0, 1)
	folder := filepath.Dir(writeScanFile(t, claudeTurnLine("a"+session, day1, 5, "/repo/tree"), claude, "C--arc-worktrees-abcd1234-t-1", session+".jsonl"))
	writeScanFile(t, claudeTurnLine("b"+session, day1, 3, "/elsewhere")+claudeTurnLine("c"+session, day2, 4, "/elsewhere"),
		folder, session, "subagents", "agent-a.jsonl")
	writeScanFile(t, claudeTurnLine("d"+other, day1, 9, "/repo"), claude, "C--repo", other+".jsonl")

	if err := KeepTranscriptDirs(context.Background(), []string{folder}); err != nil {
		t.Fatal(err)
	}
	want := []Bucket{
		{Harness: "claude", Provider: "anthropic", Model: "claude-opus-4-8", Day: "2026-10-01", Session: session, Input: 20, Output: 8, Msgs: 2},
		{Harness: "claude", Provider: "anthropic", Model: "claude-opus-4-8", Day: "2026-10-02", Session: session, Input: 10, Output: 4, Msgs: 1},
	}
	got, metas := keptFor(t, "", session)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("kept %+v, want %+v", got, want)
	}
	if want := []SessionMeta{{Harness: "claude", Session: session, Cwd: "/repo/tree"}}; !reflect.DeepEqual(metas, want) {
		t.Fatalf("kept session %+v, want %+v", metas, want)
	}
	scanned, _ := scanRoots(claude, filepath.Join(claude, "no-codex"), filepath.Join(claude, "no-opencode"), filepath.Join(claude, "no-pi"), 0)
	var scannedSession []Bucket
	for _, b := range scanned {
		if b.Session == session {
			scannedSession = append(scannedSession, b)
		}
	}
	slices.SortFunc(scannedSession, func(a, b Bucket) int { return strings.Compare(a.Day, b.Day) })
	if !reflect.DeepEqual(got, scannedSession) {
		t.Fatalf("kept %+v, the Usage scan gives %+v", got, scannedSession)
	}
	if others, _ := keptFor(t, "", other); len(others) != 0 {
		t.Fatalf("kept a session outside the folder: %+v", others)
	}
}
