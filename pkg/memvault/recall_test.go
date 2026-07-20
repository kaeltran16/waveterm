package memvault

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestParseRecalledSlugs(t *testing.T) {
	// Two recall blocks in one JSONL record (literal \n and \t, as on disk), plus one in another record.
	transcript := `{"type":"user","message":{"content":[{"type":"tool_result","content":"<system-reminder>This memory is 3 days old. Memories are point-in-time observations, not live state.</system-reminder>\n1\t---\n2\tname: tsc-stack-size-gotcha\n3\tdescription: \"x\"\n---\n"},{"type":"tool_result","content":"<system-reminder>This memory is 1 day old.</system-reminder>\n1\t---\n2\tname: cdp_verify_dev_app\n---\n"}]}}` + "\n" +
		`{"type":"user","message":{"content":[{"type":"tool_result","content":"<system-reminder>This memory is 12 days old.</system-reminder>\n1\t---\n2\tname: tsc-stack-size-gotcha\n---\n"}]}}`
	got := ParseRecalledSlugs(transcript)
	want := []string{"tsc-stack-size-gotcha", "cdp_verify_dev_app"} // deduped, first-seen order
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestParseRecalledSlugs_None(t *testing.T) {
	if got := ParseRecalledSlugs(`{"type":"assistant","message":{"content":"no memories here"}}`); len(got) != 0 {
		t.Fatalf("want none, got %v", got)
	}
}

func TestRecordRecallInto(t *testing.T) {
	hub := t.TempDir()
	// a hub note whose slug is recalled
	notePath := filepath.Join(hub, "tsc-stack-size-gotcha.md")
	if err := os.WriteFile(notePath, []byte("---\nname: tsc-stack-size-gotcha\nmetadata:\n  type: reference\n---\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(transcript, []byte(`{"c":"<system-reminder>This memory is 3 days old.</system-reminder>\n1\t---\n2\tname: tsc-stack-size-gotcha\n---\n"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	if n := recordRecallInto(hub, transcript, now); n != 1 {
		t.Fatalf("want 1 touched, got %d", n)
	}
	data, _ := os.ReadFile(notePath)
	if !strings.Contains(string(data), "last_referenced: \"2026-07-20T00:00:00Z\"") {
		t.Fatalf("last_referenced not written:\n%s", data)
	}
}

func TestRecordRecallInto_MissingTranscript(t *testing.T) {
	if n := recordRecallInto(t.TempDir(), filepath.Join(t.TempDir(), "nope.jsonl"), time.Now()); n != 0 {
		t.Fatalf("missing transcript should touch nothing, got %d", n)
	}
}
