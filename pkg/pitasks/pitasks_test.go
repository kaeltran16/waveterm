// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package pitasks

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseSkipsMalformedRecords(t *testing.T) {
	data := []byte(`{"nextId": 3, "tasks": [
  {"id": "1", "subject": "ok", "status": "pending"},
  {"id": "", "subject": "no id", "status": "pending"},
  {"id": "2", "subject": "bad status", "status": "shipped"},
  {"id": "3", "subject": "no status", "status": ""}
 ]}`)
	got, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	want := []Task{{ID: "1", Subject: "ok", Status: "pending"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseMalformedFile(t *testing.T) {
	if _, err := Parse([]byte("{not json")); err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

func TestReadMissingDir(t *testing.T) {
	got, err := Read(t.TempDir())
	if err != nil {
		t.Fatalf("Read returned error: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %+v", got)
	}
}

func TestReadEmptyCwd(t *testing.T) {
	got, err := Read("")
	if err != nil {
		t.Fatalf("Read returned error: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %+v", got)
	}
}

func TestReadAggregatesDedupesSorts(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".pi", "tasks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// project scope: two records, id "1" old
	writeFile(t, filepath.Join(dir, "tasks.json"), `{"nextId": 3, "tasks": [
  {"id": "1", "subject": "old", "status": "pending", "updatedAt": 100},
  {"id": "2", "subject": "done", "status": "completed", "updatedAt": 200}
 ]}`)
	// session scope: id "1" collides with a newer updatedAt; id "3" in_progress
	writeFile(t, filepath.Join(dir, "tasks-sess.json"), `{"nextId": 2, "tasks": [
  {"id": "1", "subject": "new", "status": "pending", "updatedAt": 300},
  {"id": "3", "subject": "active", "status": "in_progress", "updatedAt": 150}
 ]}`)
	// malformed file is skipped, not fatal
	writeFile(t, filepath.Join(dir, "broken.json"), "not json")

	got, err := Read(root)
	if err != nil {
		t.Fatalf("Read returned error: %v", err)
	}
	want := []Task{
		{ID: "3", Subject: "active", Status: "in_progress", UpdatedAt: 150},
		{ID: "1", Subject: "new", Status: "pending", UpdatedAt: 300},
		{ID: "2", Subject: "done", Status: "completed", UpdatedAt: 200},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func writeFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}
