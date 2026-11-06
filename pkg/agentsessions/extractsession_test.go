package agentsessions

import (
	"os"
	"path/filepath"
	"strconv"
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

func TestExtractSessionDedupesUsageByMessageId(t *testing.T) {
	usage := func(out int) string {
		return `"usage":{"input_tokens":10,"output_tokens":` + strconv.Itoa(out) + `,"cache_read_input_tokens":100}`
	}
	path := writeTranscript(t, []string{
		`{"type":"user","cwd":"/repo","message":{"content":"count once"}}`,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"a"}],` + usage(5) + `}}`,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"b"}],` + usage(7) + `}}`,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"c"}],` + usage(5) + `}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"d"}],"usage":{"input_tokens":3}}}`,
	})
	s, err := ExtractSession(path, "claude")
	if err != nil || s == nil {
		t.Fatalf("session = %v, err = %v", s, err)
	}
	if want := 10 + 7 + 100 + 3; s.TokensTotal != want {
		t.Errorf("TokensTotal = %d, want %d", s.TokensTotal, want)
	}
}

func TestExtractSessionUnknownRuntime(t *testing.T) {
	path := writeTranscript(t, []string{`{"type":"user","message":{"content":"x"}}`})
	if _, err := ExtractSession(path, "nope"); err == nil {
		t.Fatal("want error for unknown runtime")
	}
}
