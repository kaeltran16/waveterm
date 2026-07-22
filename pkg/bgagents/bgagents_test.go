package bgagents

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParse_BothShapes(t *testing.T) {
	data := []byte(`[
		{"id":"7802f291","sessionId":"7802f291-33c2-4c24-94d7-b7a029a3a526","cwd":"C:\\a","kind":"background","startedAt":1782441963164,"name":"bg one","state":"blocked"},
		{"pid":28732,"sessionId":"c32f3bda-8ea6-47e1-a2fc-3f38ce03f18a","cwd":"C:\\a","kind":"interactive","startedAt":1784691487376,"name":"int one","status":"busy"}
	]`)
	got, err := Parse(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 agents, got %d", len(got))
	}
	if got[0].State != "blocked" || got[0].Kind != "background" || got[0].SessionId != "7802f291-33c2-4c24-94d7-b7a029a3a526" {
		t.Errorf("background mapping wrong: %+v", got[0])
	}
	// interactive uses `status`, which must populate State
	if got[1].State != "busy" || got[1].Kind != "interactive" {
		t.Errorf("interactive status->state wrong: %+v", got[1])
	}
	if got[0].StartedTs != 1782441963164 {
		t.Errorf("startedAt->StartedTs wrong: %d", got[0].StartedTs)
	}
}

func TestParse_SkipsEntryMissingSessionId(t *testing.T) {
	data := []byte(`[{"name":"no id","state":"blocked"},{"sessionId":"abc","kind":"background","state":"working"}]`)
	got, err := Parse(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].SessionId != "abc" {
		t.Fatalf("want only the valid entry, got %+v", got)
	}
}

func TestParse_EmptyArray(t *testing.T) {
	got, err := Parse([]byte(`[]`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("want empty, got %d", len(got))
	}
}

func TestParse_NonJSON(t *testing.T) {
	if _, err := Parse([]byte(`not json`)); err == nil {
		t.Fatal("want error on non-JSON, got nil")
	}
}

func writeJob(t *testing.T, jobsDir, dir, sessionId string) {
	t.Helper()
	jd := filepath.Join(jobsDir, dir)
	if err := os.MkdirAll(jd, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"sessionId":"` + sessionId + `","state":"blocked"}`
	if err := os.WriteFile(filepath.Join(jd, "state.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveJobBySessionId(t *testing.T) {
	jobs := t.TempDir()
	writeJob(t, jobs, "aaaa1111", "aaaa1111-1111-1111-1111-111111111111")
	writeJob(t, jobs, "bbbb2222", "bbbb2222-2222-2222-2222-222222222222")

	if err := removeJobBySessionId(jobs, "aaaa1111-1111-1111-1111-111111111111"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, err := os.Stat(filepath.Join(jobs, "aaaa1111")); !os.IsNotExist(err) {
		t.Fatalf("expected aaaa1111 removed, stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(jobs, "bbbb2222")); err != nil {
		t.Fatalf("expected sibling bbbb2222 kept, stat err=%v", err)
	}
}

func TestRemoveJobBySessionId_Unknown(t *testing.T) {
	jobs := t.TempDir()
	writeJob(t, jobs, "bbbb2222", "bbbb2222-2222-2222-2222-222222222222")

	if err := removeJobBySessionId(jobs, "does-not-exist"); err != nil {
		t.Fatalf("expected nil for unknown id, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(jobs, "bbbb2222")); err != nil {
		t.Fatalf("expected sibling kept after no-op, stat err=%v", err)
	}
}

func TestRemoveJobBySessionId_MissingJobsDir(t *testing.T) {
	if err := removeJobBySessionId(filepath.Join(t.TempDir(), "nope"), "x-y"); err != nil {
		t.Fatalf("expected nil for missing jobs dir, got %v", err)
	}
}

func TestRemove_EmptySessionId(t *testing.T) {
	if err := Remove(""); err == nil {
		t.Fatal("expected error for empty sessionId")
	}
}
