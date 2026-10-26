// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// indexHome points the home dir at a temp dir with an empty scan cache, and returns its claude projects dir.
func indexHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	projects := filepath.Join(home, ".claude", "projects", "C--repo")
	if err := os.MkdirAll(projects, 0o755); err != nil {
		t.Fatal(err)
	}
	clearScanCache()
	t.Cleanup(func() {
		waitWarmup(t)
		clearScanCache()
	})
	return projects
}

func clearScanCache() {
	scanCacheMu.Lock()
	clear(scanCache)
	scanCacheMu.Unlock()
}

// writeSession writes a claude transcript holding one prompt, last written ago before now.
func writeSession(t *testing.T, dir, id, prompt string, ago time.Duration) string {
	t.Helper()
	path := writeJSONL(t, dir, id+".jsonl", `{"type":"user","cwd":"/repo","message":{"role":"user","content":"`+prompt+`"}}`)
	ts := time.Now().Add(-ago)
	if err := os.Chtimes(path, ts, ts); err != nil {
		t.Fatal(err)
	}
	return path
}

// countReads counts transcript reads, from any goroutine, by path, until the test ends.
func countReads(t *testing.T) func() map[string]int {
	t.Helper()
	var mu sync.Mutex
	reads := map[string]int{}
	orig := readLines
	readLines = func(path string) []string {
		mu.Lock()
		reads[path]++
		mu.Unlock()
		return orig(path)
	}
	t.Cleanup(func() { readLines = orig })
	return func() map[string]int {
		mu.Lock()
		defer mu.Unlock()
		out := reads
		reads = map[string]int{}
		return out
	}
}

func total(reads map[string]int) int {
	n := 0
	for _, c := range reads {
		n += c
	}
	return n
}

func waitWarmup(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for warming.Load() {
		if time.Now().After(deadline) {
			t.Fatal("warm-up did not finish")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func writeSessions(t *testing.T, dir string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		writeSession(t, dir, fmt.Sprintf("s%03d", i), fmt.Sprintf("prompt %d", i), time.Duration(i)*time.Minute)
	}
}

func TestIndexedNewestFirst(t *testing.T) {
	dir := indexHome(t)
	writeSession(t, dir, "mid", "the middle one", 2*time.Hour)
	writeSession(t, dir, "new", "the newest one", time.Hour)
	writeSession(t, dir, "old", "the oldest one", 3*time.Hour)
	writeSession(t, dir, "gone", "outside the window", 40*24*time.Hour)

	got, complete := Indexed(IndexWindowDays)
	if !complete {
		t.Error("three sessions fit in one synchronous pass")
	}
	var ids []string
	for _, s := range got {
		ids = append(ids, s.Info.ID)
	}
	if fmt.Sprint(ids) != "[new mid old]" {
		t.Fatalf("ids = %v, want [new mid old]", ids)
	}
	if got[0].Info.Runtime != "claude" || got[0].Info.ResumeCommand != "claude --resume new" || got[0].Info.TranscriptPath == "" {
		t.Errorf("info = %+v", got[0].Info)
	}
	if len(got[0].Turns) != 1 || got[0].Turns[0].Text != "the newest one" {
		t.Errorf("turns = %+v", got[0].Turns)
	}
}

func TestIndexedParsesAtMost100Uncached(t *testing.T) {
	dir := indexHome(t)
	writeSessions(t, dir, 150)
	reads := countReads(t)
	// a warm-up already running keeps Indexed from starting one, so only its own reads are counted
	warming.Store(true)
	got, complete := Indexed(IndexWindowDays)
	warming.Store(false)
	if n := total(reads()); n != syncParseMax {
		t.Errorf("read %d files, want %d", n, syncParseMax)
	}
	if complete {
		t.Error("complete must be false while candidates were skipped")
	}
	if len(got) != syncParseMax || got[0].Info.ID != "s000" {
		t.Errorf("want the newest %d sessions, got %d starting %q", syncParseMax, len(got), got[0].Info.ID)
	}
}

func TestIndexedSecondPassReadsNothing(t *testing.T) {
	dir := indexHome(t)
	writeSessions(t, dir, 150)
	reads := countReads(t)
	if _, complete := Indexed(IndexWindowDays); complete {
		t.Fatal("the first pass leaves 50 candidates to the warm-up")
	}
	waitWarmup(t)
	if r := reads(); total(r) != 150 || len(r) != 150 {
		t.Fatalf("pass and warm-up read %d files (%d distinct), want each of 150 once", total(r), len(r))
	}
	got, complete := Indexed(IndexWindowDays)
	if n := total(reads()); n != 0 {
		t.Errorf("a warm second pass read %d files, want 0", n)
	}
	if !complete || len(got) != 150 {
		t.Errorf("complete = %v, sessions = %d", complete, len(got))
	}
}

func TestIndexedRereadsGrownTranscript(t *testing.T) {
	dir := indexHome(t)
	path := writeSession(t, dir, "live", "start the work", time.Hour)
	q := ParseQuery("zebraword")
	got, _ := Indexed(IndexWindowDays)
	if ok, _, _, _ := q.Match(got[0], 20); ok {
		t.Fatal("the word is not written yet")
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString("\n" + `{"type":"assistant","message":{"content":[{"type":"text","text":"found the zebraword"}]}}`)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	got, _ = Indexed(IndexWindowDays)
	if ok, hits, _, _ := q.Match(got[0], 20); !ok || len(hits) != 1 || hits[0].Speaker != "agent" {
		t.Fatalf("a grown transcript must be re-read: ok = %v, hits = %+v", ok, hits)
	}
}

func TestIndexedPrunesDeletedTranscripts(t *testing.T) {
	dir := indexHome(t)
	keep := writeSession(t, dir, "keep", "kept", time.Hour)
	gone := writeSession(t, dir, "gone", "deleted", 2*time.Hour)
	if got, _ := Indexed(IndexWindowDays); len(got) != 2 {
		t.Fatalf("got %d sessions, want 2", len(got))
	}
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	got, _ := Indexed(IndexWindowDays)
	if len(got) != 1 || got[0].Info.ID != "keep" {
		t.Fatalf("got %+v, want only keep", got)
	}
	scanCacheMu.Lock()
	_, hasGone := scanCache[gone]
	_, hasKeep := scanCache[keep]
	scanCacheMu.Unlock()
	if hasGone || !hasKeep {
		t.Errorf("cache holds gone = %v, keep = %v; want only keep", hasGone, hasKeep)
	}
}

func TestStartWarmupIsIdempotent(t *testing.T) {
	dir := indexHome(t)
	writeSessions(t, dir, 5)
	reads := countReads(t)
	counted := readLines
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	readLines = func(path string) []string {
		once.Do(func() { close(entered) })
		<-release
		return counted(path)
	}
	StartWarmup()
	<-entered
	StartWarmup()
	close(release)
	waitWarmup(t)
	r := reads()
	if len(r) != 5 {
		t.Fatalf("warm-up read %d distinct files, want 5", len(r))
	}
	for path, n := range r {
		if n != 1 {
			t.Errorf("%s read %d times, want once", filepath.Base(path), n)
		}
	}
}
