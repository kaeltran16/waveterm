// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

var docsT0 = time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC)

// docsWriteLines is a Claude Write (or Edit) of path at n minutes after docsT0, with its successful result.
func docsWriteLines(t *testing.T, n int, id, tool, path string) []string {
	t.Helper()
	ts := docsT0.Add(time.Duration(n) * time.Minute).Format(time.RFC3339Nano)
	var out []string
	for _, rec := range []map[string]any{
		{"type": "assistant", "timestamp": ts, "message": map[string]any{"content": []any{
			map[string]any{"type": "tool_use", "id": id, "name": tool, "input": map[string]any{"file_path": path}},
		}}},
		{"type": "user", "timestamp": ts, "message": map[string]any{"content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": id},
		}}},
	} {
		b, err := json.Marshal(rec)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, string(b))
	}
	return out
}

func writeDocsFile(t *testing.T, path string, lines []string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func insertDocsBlock(t *testing.T, meta waveobj.MetaMapType) string {
	t.Helper()
	blockId := uuid.NewString()
	if err := wstore.DBInsert(context.Background(), &waveobj.Block{OID: blockId, ParentORef: "tab:" + uuid.NewString(), Meta: meta}); err != nil {
		t.Fatal(err)
	}
	return blockId
}

func TestAgentDocsJoinsRecordedAndCurrentTranscripts(t *testing.T) {
	dir := t.TempDir()
	x, y, z := filepath.Join(dir, "x.md"), filepath.Join(dir, "y.md"), filepath.Join(dir, "z.md")
	for _, p := range []string{x, y, z} {
		writeDocsFile(t, p, []string{"# doc"})
	}
	earlier, current := filepath.Join(dir, "earlier.jsonl"), filepath.Join(dir, "current.jsonl")
	writeDocsFile(t, earlier, append(docsWriteLines(t, 0, "e1", "Write", x), docsWriteLines(t, 1, "e2", "Write", y)...))
	writeDocsFile(t, current, append(docsWriteLines(t, 60, "c1", "Edit", x), docsWriteLines(t, 30, "c2", "Write", z)...))
	if err := os.Remove(y); err != nil {
		t.Fatal(err)
	}
	blockId := insertDocsBlock(t, waveobj.MetaMapType{waveobj.MetaKey_AgentTranscripts: []any{earlier}})

	rtn, err := (&WshServer{}).AgentDocsCommand(context.Background(), wshrpc.CommandAgentDocsData{BlockId: blockId, TranscriptPath: current})
	if err != nil {
		t.Fatal(err)
	}
	ms := func(n int) int64 { return docsT0.Add(time.Duration(n) * time.Minute).UnixMilli() }
	want := []wshrpc.AgentDoc{
		{Path: x, Ts: ms(60), Verb: "edited"},
		{Path: z, Ts: ms(30), Verb: "written"},
		{Path: y, Ts: ms(1), Verb: "written", Gone: true},
	}
	if !reflect.DeepEqual(rtn.Docs, want) {
		t.Fatalf("docs = %+v\nwant %+v", rtn.Docs, want)
	}
}

func lineageEvent(blockId, transcript string) *wps.WaveEvent {
	return &wps.WaveEvent{Event: wps.Event_AgentStatus, Data: baseds.AgentStatusData{
		ORef: "block:" + blockId, State: baseds.AgentState_Working, TranscriptPath: transcript, Ts: 1,
	}}
}

func readBlock(t *testing.T, blockId string) *waveobj.Block {
	t.Helper()
	b, err := wstore.DBMustGet[*waveobj.Block](context.Background(), blockId)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestTranscriptLineageAppendsNewPathsOnce(t *testing.T) {
	ctx := context.Background()
	blockId := insertDocsBlock(t, nil)
	noteTranscriptLineage(ctx, lineageEvent(blockId, "/t/one.jsonl"))
	noteTranscriptLineage(ctx, lineageEvent(blockId, "/t/two.jsonl"))
	b := readBlock(t, blockId)
	if got := b.Meta.GetStringList(waveobj.MetaKey_AgentTranscripts); !reflect.DeepEqual(got, []string{"/t/one.jsonl", "/t/two.jsonl"}) {
		t.Fatalf("transcripts = %v", got)
	}
	noteTranscriptLineage(ctx, lineageEvent(blockId, "/t/two.jsonl"))
	noteTranscriptLineage(ctx, lineageEvent(blockId, "/t/one.jsonl"))
	if again := readBlock(t, blockId); again.Version != b.Version {
		t.Fatalf("a recorded path wrote the block: version %d -> %d", b.Version, again.Version)
	}
}

func TestTranscriptLineageDropsOldestPastCap(t *testing.T) {
	var full []any
	for i := range 32 {
		full = append(full, fmt.Sprintf("/t/%02d.jsonl", i))
	}
	blockId := insertDocsBlock(t, waveobj.MetaMapType{waveobj.MetaKey_AgentTranscripts: full})
	noteTranscriptLineage(context.Background(), lineageEvent(blockId, "/t/new.jsonl"))
	got := readBlock(t, blockId).Meta.GetStringList(waveobj.MetaKey_AgentTranscripts)
	if len(got) != 32 || got[0] != "/t/01.jsonl" || got[31] != "/t/new.jsonl" {
		t.Fatalf("transcripts = %v, want 01..31 then new", got)
	}
}
