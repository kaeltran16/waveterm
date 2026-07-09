// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestReadTranscriptTail(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.jsonl")
	// blank line in the middle must be skipped
	if err := os.WriteFile(path, []byte("a\n\nb\nc\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	all, err := readTranscriptTail(path, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("want 3 non-empty lines, got %d (%v)", len(all), all)
	}

	tail, err := readTranscriptTail(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 2 || tail[0] != "b" || tail[1] != "c" {
		t.Fatalf("want [b c], got %v", tail)
	}

	if _, err := readTranscriptTail(filepath.Join(dir, "nope.jsonl"), 0); err == nil {
		t.Fatal("expected error for missing file")
	}
	if _, err := readTranscriptTail("", 0); err == nil {
		t.Fatal("expected error for empty path")
	}
	if _, err := readTranscriptTail(dir, 0); err == nil {
		t.Fatal("expected error when path is a directory")
	}
}

func TestReadTranscriptHead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.jsonl")
	// blank line in the middle must be skipped
	if err := os.WriteFile(path, []byte("a\n\nb\nc\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	all, err := readTranscriptHead(path, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("want 3 non-empty lines, got %d (%v)", len(all), all)
	}

	head, err := readTranscriptHead(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(head) != 2 || head[0] != "a" || head[1] != "b" {
		t.Fatalf("want [a b], got %v", head)
	}

	if _, err := readTranscriptHead(filepath.Join(dir, "nope.jsonl"), 0); err == nil {
		t.Fatal("expected error for missing file")
	}
	if _, err := readTranscriptHead("", 0); err == nil {
		t.Fatal("expected error for empty path")
	}
	if _, err := readTranscriptHead(dir, 0); err == nil {
		t.Fatal("expected error when path is a directory")
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func appendFile(t *testing.T, path, content string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatalf("open append: %v", err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatalf("append: %v", err)
	}
}

func TestTranscriptTailer(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.jsonl")
	writeFile(t, path, "a\nb\n")
	tl := &transcriptTailer{}

	got, err := tl.readNew(path)
	if err != nil {
		t.Fatalf("readNew: %v", err)
	}
	if !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("initial: got %v", got)
	}

	// no change -> no lines
	got, _ = tl.readNew(path)
	if len(got) != 0 {
		t.Fatalf("no-change: got %v", got)
	}

	// partial line buffered until its newline arrives, then joined
	appendFile(t, path, "c")
	got, _ = tl.readNew(path)
	if len(got) != 0 {
		t.Fatalf("partial: expected none, got %v", got)
	}
	appendFile(t, path, "d\n")
	got, _ = tl.readNew(path)
	if !reflect.DeepEqual(got, []string{"cd"}) {
		t.Fatalf("join: got %v", got)
	}

	// truncation resets the offset
	writeFile(t, path, "x\n")
	got, _ = tl.readNew(path)
	if !reflect.DeepEqual(got, []string{"x"}) {
		t.Fatalf("truncate: got %v", got)
	}
}

func TestStreamTranscript(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, `{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}`+"\n")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := make(chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate], 16)
	done := make(chan struct{})
	go func() {
		_ = streamTranscript(ctx, path, 100, ch)
		close(done)
	}()

	// backlog chunk
	select {
	case msg := <-ch:
		if msg.Error != nil || len(msg.Response.Lines) != 1 {
			t.Fatalf("backlog: %+v", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for backlog")
	}

	// append -> incremental chunk
	appendFile(t, path, `{"type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}`+"\n")
	select {
	case msg := <-ch:
		if msg.Error != nil || len(msg.Response.Lines) != 1 {
			t.Fatalf("increment: %+v", msg)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for increment")
	}

	// cancel -> loop returns
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("streamTranscript did not return after cancel")
	}
}

func TestListSubagents(t *testing.T) {
	dir := t.TempDir()
	parent := filepath.Join(dir, "sess.jsonl")
	if err := os.WriteFile(parent, []byte(`{"type":"user"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	subdir := filepath.Join(dir, "sess", "subagents")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(id, prompt string) {
		rec := `{"agentId":"` + id + `","type":"user","message":{"content":"` + prompt + `"}}` + "\n"
		if err := os.WriteFile(filepath.Join(subdir, "agent-"+id+".jsonl"), []byte(rec), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("aaa", "Explore the repo")
	write("bbb", "Plan the work")

	infos, err := listSubagents(parent)
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 2 {
		t.Fatalf("want 2 infos, got %d", len(infos))
	}
	byId := map[string]wshrpc.SubagentFileInfo{}
	for _, in := range infos {
		byId[in.AgentId] = in
	}
	if byId["aaa"].FirstPrompt != "Explore the repo" {
		t.Errorf("firstPrompt aaa = %q", byId["aaa"].FirstPrompt)
	}
	if byId["bbb"].TranscriptPath != filepath.Join(subdir, "agent-bbb.jsonl") {
		t.Errorf("transcriptPath bbb = %q", byId["bbb"].TranscriptPath)
	}
}

func TestListSubagentsMissingDir(t *testing.T) {
	dir := t.TempDir()
	parent := filepath.Join(dir, "none.jsonl")
	if err := os.WriteFile(parent, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	infos, err := listSubagents(parent)
	if err != nil {
		t.Fatalf("missing subagents dir must not error: %v", err)
	}
	if len(infos) != 0 {
		t.Fatalf("want 0 infos, got %d", len(infos))
	}
}
