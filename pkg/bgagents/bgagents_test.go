package bgagents

import "testing"

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
