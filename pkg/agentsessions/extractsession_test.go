package agentsessions

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTranscript(t *testing.T, lines []string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "session.jsonl")
	var b []byte
	for _, ln := range lines {
		b = append(b, []byte(ln+"\n")...)
	}
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestExtractSessionClaudeDone(t *testing.T) {
	// a minimal claude transcript: one human prompt + one assistant reply -> a resumable, done session
	path := writeTranscript(t, []string{
		`{"type":"user","cwd":"/repo","message":{"content":"harden the webhooks"}}`,
		`{"type":"assistant","message":{"model":"claude-opus","content":[{"type":"text","text":"done, hardened."}]}}`,
	})
	s, err := ExtractSession(path, "claude")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if s == nil {
		t.Fatal("want a session, got nil")
	}
	if s.Task != "harden the webhooks" {
		t.Errorf("task = %q", s.Task)
	}
	if s.Status != "done" {
		t.Errorf("status = %q, want done", s.Status)
	}
}

func TestExtractSessionUnknownRuntime(t *testing.T) {
	path := writeTranscript(t, []string{`{"type":"user","message":{"content":"x"}}`})
	if _, err := ExtractSession(path, "nope"); err == nil {
		t.Fatal("want error for unknown runtime")
	}
}
