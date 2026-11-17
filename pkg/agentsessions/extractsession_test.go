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

// Usage bills a session's subagent transcripts to it, so Sessions must count them too
func TestExtractSessionCountsSubagentTranscripts(t *testing.T) {
	path := writeTranscript(t, []string{
		`{"type":"user","cwd":"/repo","message":{"content":"delegate"}}`,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":10,"output_tokens":5}}}`,
	})
	sub := filepath.Join(filepath.Dir(path), "session", "subagents")
	nested := filepath.Join(sub, "agent-1")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	child := `{"type":"assistant","isSidechain":true,"message":{"id":"s1","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":100,"output_tokens":20}}}`
	for _, p := range []string{filepath.Join(sub, "agent-1.jsonl"), filepath.Join(nested, "agent-2.jsonl")} {
		// the repeated record is one message written per content block: counted once
		if err := os.WriteFile(p, []byte(child+"\n"+child+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(sub, "notes.txt"), []byte(child+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := ExtractSession(path, "claude")
	if err != nil || s == nil {
		t.Fatalf("session = %v, err = %v", s, err)
	}
	if want := 15 + 120 + 120; s.TokensTotal != want {
		t.Errorf("TokensTotal = %d, want %d", s.TokensTotal, want)
	}
}

func TestExtractSessionUnknownRuntime(t *testing.T) {
	path := writeTranscript(t, []string{`{"type":"user","message":{"content":"x"}}`})
	if _, err := ExtractSession(path, "nope"); err == nil {
		t.Fatal("want error for unknown runtime")
	}
}

func TestExtractSessionTitlesFromBlockPrompt(t *testing.T) {
	// a prompt sent with a pasted image is recorded as content blocks, not a string
	path := writeTranscript(t, []string{
		`{"type":"user","cwd":"/repo","message":{"content":[{"type":"text","text":"fix this layout"},{"type":"image","source":{"type":"base64","data":"x"}}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"fixed"}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`,
	})
	s, err := ExtractSession(path, "claude")
	if err != nil || s == nil {
		t.Fatalf("session = %v, err = %v", s, err)
	}
	if s.Task != "fix this layout" {
		t.Errorf("task = %q, want %q", s.Task, "fix this layout")
	}
}
