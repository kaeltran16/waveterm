package memvault

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestListPendingEnrichedFields(t *testing.T) {
	dir := t.TempDir()
	if _, err := WritePending(dir, LearnCandidate{
		Type:  "feedback",
		Scope: "payments-api",
		Body:  "Never auto-commit without approval\nThe global CLAUDE.md forbids it.",
	}, "/home/dk/code/auth-refactor"); err != nil {
		t.Fatalf("WritePending: %v", err)
	}
	pns := ListPending(dir)
	if len(pns) != 1 {
		t.Fatalf("len = %d, want 1", len(pns))
	}
	p := pns[0]
	if p.Title != "Never auto-commit without approval" {
		t.Fatalf("Title = %q", p.Title)
	}
	if p.Source != "auth-refactor" {
		t.Fatalf("Source = %q, want auth-refactor", p.Source)
	}
	if p.CapturedAt == "" {
		t.Fatalf("CapturedAt is empty, want an RFC3339 stamp")
	}
	if _, err := time.Parse(time.RFC3339, p.CapturedAt); err != nil {
		t.Fatalf("CapturedAt %q not RFC3339: %v", p.CapturedAt, err)
	}
}

func TestPendingCapturedAt(t *testing.T) {
	got := pendingCapturedAt("20260712T101500.000-slug.md")
	if got != "2026-07-12T10:15:00Z" {
		t.Fatalf("pendingCapturedAt = %q, want 2026-07-12T10:15:00Z", got)
	}
	if s := pendingCapturedAt("no-stamp.md"); s != "" {
		t.Fatalf("stampless = %q, want empty", s)
	}
}

func TestPendingSourceFallback(t *testing.T) {
	if s := pendingSource(""); s != "agent" {
		t.Fatalf("pendingSource(\"\") = %q, want agent", s)
	}
	if s := pendingSource("/a/b/web-dashboard"); s != "web-dashboard" {
		t.Fatalf("pendingSource = %q, want web-dashboard", s)
	}
}
