package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPendingWriteListAccept(t *testing.T) {
	pending := t.TempDir()
	hub := t.TempDir()
	p, err := WritePending(pending, LearnCandidate{Type: "project", Scope: "x", Body: "build uses zig"}, "C:/proj")
	if err != nil {
		t.Fatal(err)
	}
	list := ListPending(pending)
	if len(list) != 1 || list[0].Type != "project" || list[0].Body != "build uses zig" || list[0].Cwd != "C:/proj" {
		t.Fatalf("list = %+v", list)
	}
	// accept: writes into hub, removes pending. Override the hub target via a note whose recorded
	// cwd resolves to an empty hub -> default vault; here we test the file move by pointing accept at
	// a note we rewrite to carry hub as an absolute dir is out of scope, so assert removal + creation.
	_ = p
	created, err := acceptPendingInto(list[0], hub) // test seam (see impl note)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(created); err != nil {
		t.Fatalf("created note missing: %v", err)
	}
	if len(ListPending(pending)) != 0 {
		t.Fatalf("pending not cleared")
	}
	data, _ := os.ReadFile(created)
	if !strings.Contains(string(data), "type: project") {
		t.Fatalf("created note missing type:\n%s", string(data))
	}
	_ = filepath.Dir(created)
}
