// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardthings

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func writeTranscript(t *testing.T, lines []string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadSession(t *testing.T) {
	path := writeTranscript(t, []string{
		`{"type":"user","timestamp":"2026-09-17T06:02:05.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"draw the cache"}}`,
		`{"type":"assistant","timestamp":"2026-09-17T06:02:14.000Z","message":{"content":[{"type":"text","text":"the cache has two tiers"}]}}`,
	})
	src := wshrpc.BoardSource{Kind: "session", Ref: "claude:s1", Path: path, Runtime: "claude", Title: "claude · waveterm"}
	text, reading, cursor, err := Read(context.Background(), src, 0)
	if err != nil {
		t.Fatal(err)
	}
	if want := "User: draw the cache\n\nAgent: the cache has two tiers"; text != want {
		t.Fatalf("text = %q, want %q", text, want)
	}
	const lastTs = 1789624934000
	if cursor != lastTs {
		t.Fatalf("cursor = %d, want %d", cursor, lastTs)
	}
	if want := "the " + time.UnixMilli(lastTs).Format("15:04") + " turn end"; reading != want {
		t.Fatalf("reading = %q, want %q", reading, want)
	}

	text, reading, cursor, err = Read(context.Background(), src, lastTs)
	if err != nil || text != "" || reading != "" || cursor != lastTs {
		t.Fatalf("nothing new: Read = %q, %q, %d, %v; want empty and cursor %d", text, reading, cursor, err, lastTs)
	}
}

// a long session keeps its newest end: what the scribe is asked about is the latest turn
func TestReadCapsToNewest(t *testing.T) {
	var lines []string
	for i := range 400 {
		ts := time.Date(2026, 9, 17, 6, 0, 0, 0, time.UTC).Add(time.Duration(i) * time.Second).Format(time.RFC3339Nano)
		lines = append(lines, fmt.Sprintf(`{"type":"assistant","timestamp":%q,"message":{"content":[{"type":"text","text":"answer %03d %s"}]}}`, ts, i, strings.Repeat("é", 200)))
		lines = append(lines, fmt.Sprintf(`{"type":"user","timestamp":%q,"origin":{"kind":"human"},"message":{"role":"user","content":"prompt %03d"}}`, ts, i))
	}
	src := wshrpc.BoardSource{Kind: "session", Ref: "claude:s1", Path: writeTranscript(t, lines), Runtime: "claude"}
	text, _, _, err := Read(context.Background(), src, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(text, cutMarker) {
		t.Fatalf("text does not start with the cut marker: %q", text[:80])
	}
	if !strings.HasSuffix(text, "User: prompt 399") {
		t.Fatalf("text does not end with the newest turn: %q", text[len(text)-80:])
	}
	if n := len([]rune(strings.TrimPrefix(text, cutMarker))); n > MaxThingChars {
		t.Fatalf("kept %d chars, want at most %d", n, MaxThingChars)
	}
	if strings.ContainsRune(text, '�') {
		t.Fatal("the cut split a rune")
	}
}

func TestReadUnknownKind(t *testing.T) {
	_, _, _, err := Read(context.Background(), wshrpc.BoardSource{Kind: "bogus", Ref: "r-1"}, 0)
	if err == nil || !strings.Contains(err.Error(), "bogus") || !strings.Contains(err.Error(), "r-1") {
		t.Fatalf("err = %v, want one naming the kind and ref", err)
	}
}
