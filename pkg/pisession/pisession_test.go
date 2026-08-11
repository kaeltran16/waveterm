// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package pisession

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseUsesVersionThreeHeader(t *testing.T) {
	data := []byte(`{"type":"session","version":3,"id":"session-1","timestamp":"2026-08-11T03:00:00Z","cwd":"C:\\repo"}` + "\n" +
		`{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-11T03:00:01Z","message":{"role":"user","content":"ship it"}}` + "\n")
	file, err := Parse(`C:\tmp\session.jsonl`, data)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if file.Header.ID != "session-1" {
		t.Errorf("Header.ID = %q, want session-1", file.Header.ID)
	}
	if file.Header.Cwd != `C:\repo` {
		t.Errorf("Header.Cwd = %q, want C:\\repo", file.Header.Cwd)
	}
	if len(file.Entries) != 1 {
		t.Errorf("len(Entries) = %d, want 1", len(file.Entries))
	}
}

func TestParseRejectsUnsupportedVersion(t *testing.T) {
	_, err := Parse("future.jsonl", []byte(`{"type":"session","version":4,"id":"s","cwd":"/repo"}`+"\n"))
	if err == nil {
		t.Fatal("Parse error: want error for unsupported version")
	}
	if !strings.Contains(err.Error(), "future.jsonl") {
		t.Errorf("error %q does not mention the path future.jsonl", err.Error())
	}
	if !strings.Contains(err.Error(), "unsupported Pi session version 4") {
		t.Errorf("error %q does not mention 'unsupported Pi session version 4'", err.Error())
	}
}

func TestParseIgnoresOnlyIncompleteFinalRecord(t *testing.T) {
	data := []byte(`{"type":"session","version":3,"id":"s","cwd":"/repo"}` + "\n" +
		`{"type":"message","id":"u","parentId":null,"message":{"role":"user","content":"keep"}}` + "\n" +
		`{"type":"message","id":"half"`)
	file, err := Parse("partial.jsonl", data)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if len(file.Entries) != 1 {
		t.Errorf("len(Entries) = %d, want 1", len(file.Entries))
	}

	_, err = Parse("complete-bad.jsonl", append(data, '\n'))
	if err == nil {
		t.Fatal("Parse error: want error for malformed complete record")
	}
	if !strings.Contains(err.Error(), "complete-bad.jsonl:3") {
		t.Errorf("error %q does not mention complete-bad.jsonl:3", err.Error())
	}
}

func TestActiveBranch_ExcludesAbandonedSibling(t *testing.T) {
	data := []byte(`{"type":"session","version":3,"id":"s","cwd":"/repo"}` + "\n" +
		`{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":"implement it"}}` + "\n" +
		`{"type":"message","id":"abandoned","parentId":"root","message":{"role":"assistant","content":"approach A failed"}}` + "\n" +
		`{"type":"message","id":"active","parentId":"root","message":{"role":"assistant","content":"approach B"}}` + "\n" +
		`{"type":"message","id":"leaf","parentId":"active","message":{"role":"assistant","content":"done"}}` + "\n")
	file, err := Parse("branch.jsonl", data)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	branch, err := file.ActiveBranch()
	if err != nil {
		t.Fatalf("ActiveBranch error: %v", err)
	}
	wantIDs := []string{"root", "active", "leaf"}
	if len(branch) != len(wantIDs) {
		t.Fatalf("branch length = %d, want %d (branch %v)", len(branch), len(wantIDs), branchIDs(branch))
	}
	for i, id := range wantIDs {
		if branch[i].ID != id {
			t.Errorf("branch[%d].ID = %q, want %q (branch %v)", i, branch[i].ID, id, branchIDs(branch))
		}
	}
}

func TestActiveBranch_MissingParentError(t *testing.T) {
	data := []byte(`{"type":"session","version":3,"id":"s","cwd":"/repo"}` + "\n" +
		`{"type":"message","id":"orphan","parentId":"ghost","message":{"role":"user","content":"hi"}}` + "\n")
	file, err := Parse("missing-parent.jsonl", data)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	_, err = file.ActiveBranch()
	if err == nil {
		t.Fatal("ActiveBranch error: want error for missing parent")
	}
	if !strings.Contains(err.Error(), "missing-parent.jsonl") {
		t.Errorf("error %q does not mention the path missing-parent.jsonl", err.Error())
	}
	if !strings.Contains(err.Error(), "ghost") {
		t.Errorf("error %q does not mention the missing parent id ghost", err.Error())
	}
}

func TestActiveBranch_CycleError(t *testing.T) {
	data := []byte(`{"type":"session","version":3,"id":"s","cwd":"/repo"}` + "\n" +
		`{"type":"message","id":"a","parentId":"b","message":{"role":"user","content":"hi"}}` + "\n" +
		`{"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":"hi"}}` + "\n")
	file, err := Parse("cycle.jsonl", data)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	_, err = file.ActiveBranch()
	if err == nil {
		t.Fatal("ActiveBranch error: want error for parent cycle")
	}
	if !strings.Contains(err.Error(), "cycle.jsonl") {
		t.Errorf("error %q does not mention the path cycle.jsonl", err.Error())
	}
}

func TestRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	content := []byte(`{"type":"session","version":3,"id":"s","cwd":"/repo"}` + "\n" +
		`{"type":"message","id":"u","parentId":null,"message":{"role":"user","content":"hi"}}` + "\n")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("WriteFile error: %v", err)
	}
	file, err := Read(path)
	if err != nil {
		t.Fatalf("Read error: %v", err)
	}
	if file.Path != path {
		t.Errorf("File.Path = %q, want %q", file.Path, path)
	}
	if len(file.Entries) != 1 {
		t.Errorf("len(Entries) = %d, want 1", len(file.Entries))
	}
}

func branchIDs(branch []Entry) []string {
	ids := make([]string, len(branch))
	for i, e := range branch {
		ids[i] = e.ID
	}
	return ids
}
