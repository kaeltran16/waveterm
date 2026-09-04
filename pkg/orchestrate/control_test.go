package orchestrate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestControlMessageShape(t *testing.T) {
	env := ControlEnvelope{EventID: "ev-1", ChannelID: "ch-1", RunID: "run-1", TaskID: "t-0", SessionID: "sess-1"}
	msg := controlMessage(DagEventGateOpen, "t-0", env)
	var parsed map[string]any
	if err := json.Unmarshal([]byte(msg), &parsed); err != nil {
		t.Fatalf("unparseable message %q: %v", msg, err)
	}
	if parsed["cmd"] != "gate_open" {
		t.Fatalf("bad cmd in message: %s", msg)
	}
	if parsed["content"] != "t-0" {
		t.Fatalf("bad content in message: %s", msg)
	}
	if parsed["ts"] == nil {
		t.Fatalf("message carries no ts: %s", msg)
	}
	for field, want := range map[string]string{
		"eventid":   "ev-1",
		"channelid": "ch-1",
		"runid":     "run-1",
		"taskid":    "t-0",
		"sessionid": "sess-1",
	} {
		if parsed[field] != want {
			t.Fatalf("envelope %s = %v, want %q (%s)", field, parsed[field], want, msg)
		}
	}
	for kind, want := range map[string]string{DagEventChildAsk: "child_ask", DagEventTaskStalled: "child_stalled"} {
		m := controlMessage(kind, "t-3", env)
		var p map[string]any
		if err := json.Unmarshal([]byte(m), &p); err != nil {
			t.Fatalf("unparseable %s message: %v", kind, err)
		}
		if p["cmd"] != want {
			t.Fatalf("%s maps to %q, want %q", kind, p["cmd"], want)
		}
	}
}

func TestControlMessageOmitsAbsentTask(t *testing.T) {
	msg := controlMessage(DagEventComplete, "all tasks done", ControlEnvelope{EventID: "ev-2"})
	var parsed map[string]any
	if err := json.Unmarshal([]byte(msg), &parsed); err != nil {
		t.Fatal(err)
	}
	if _, present := parsed["taskid"]; present {
		t.Fatalf("a dag-level control must not carry an empty taskid: %s", msg)
	}
}

// captureControlEvents swaps the append seam for a recorder, returning the captured rows.
func captureControlEvents(t *testing.T) *[]map[string]any {
	t.Helper()
	rows := &[]map[string]any{}
	old := appendRunEvent
	appendRunEvent = func(_ context.Context, _, _, kind string, _ *int, detail any) {
		row := map[string]any{"eventkind": kind}
		if d, ok := detail.(map[string]any); ok {
			for k, v := range d {
				row[k] = v
			}
		}
		*rows = append(*rows, row)
	}
	t.Cleanup(func() { appendRunEvent = old })
	return rows
}

func controlGroup(t *testing.T) *waveobj.TaskGroup {
	t.Helper()
	g, err := NewTaskGroup("run-42", "ch-1", "g", 1, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.OID = "dag-123"
	return &g
}

func TestNotifyLeadBestEffortRecordsSent(t *testing.T) {
	g := controlGroup(t)
	rows := captureControlEvents(t)
	old := notifyLeadFn
	notifyLeadFn = func(_ context.Context, _ *waveobj.TaskGroup, kind, _, taskID string) (ControlResult, error) {
		return ControlResult{
			Envelope: ControlEnvelope{EventID: "ev-7", ChannelID: g.ChannelId, RunID: g.RunID, TaskID: taskID, SessionID: "sess-9"},
			Sent:     true,
		}, nil
	}
	t.Cleanup(func() { notifyLeadFn = old })

	notifyLeadBestEffort(context.Background(), g, DagEventGateOpen, "gate t-0", "t-0")
	if len(*rows) != 1 {
		t.Fatalf("want one row, got %+v", *rows)
	}
	row := (*rows)[0]
	if row["eventkind"] != waveobj.RunEventKindLeadControlSent || row["cmd"] != "gate_open" {
		t.Fatalf("row = %+v", row)
	}
	if row["eventid"] != "ev-7" || row["sessionid"] != "sess-9" || row["taskid"] != "t-0" {
		t.Fatalf("sent row must name the attempt: %+v", row)
	}
}

func TestNotifyLeadBestEffortRecordsUnavailable(t *testing.T) {
	g := controlGroup(t)
	rows := captureControlEvents(t)
	old := notifyLeadFn
	notifyLeadFn = func(context.Context, *waveobj.TaskGroup, string, string, string) (ControlResult, error) {
		return ControlResult{Envelope: ControlEnvelope{EventID: "ev-8"}, FailureKind: ControlFailureUnavailable}, nil
	}
	t.Cleanup(func() { notifyLeadFn = old })

	notifyLeadBestEffort(context.Background(), g, DagEventComplete, "all tasks done", "")
	if len(*rows) != 1 {
		t.Fatalf("want one row, got %+v", *rows)
	}
	row := (*rows)[0]
	if row["eventkind"] != waveobj.RunEventKindLeadControlFailed || row["failure"] != ControlFailureUnavailable {
		t.Fatalf("an unresolvable control channel must record failure kind unavailable: %+v", row)
	}
	if row["eventid"] != "ev-8" {
		t.Fatalf("failed row must name the attempt: %+v", row)
	}
}

func TestNotifyLeadBestEffortBoundsWriteError(t *testing.T) {
	g := controlGroup(t)
	rows := captureControlEvents(t)
	old := notifyLeadFn
	long := errors.New(strings.Repeat("x", MaxControlErrEventLen+80))
	notifyLeadFn = func(context.Context, *waveobj.TaskGroup, string, string, string) (ControlResult, error) {
		return ControlResult{Envelope: ControlEnvelope{EventID: "ev-9", SessionID: "sess-2"}, FailureKind: ControlFailureWrite}, long
	}
	t.Cleanup(func() { notifyLeadFn = old })

	var buf bytes.Buffer
	orig := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(orig) })

	notifyLeadBestEffort(context.Background(), g, DagEventGateOpen, "gate t-0", "t-0")
	if len(*rows) != 1 {
		t.Fatalf("want one row, got %+v", *rows)
	}
	row := (*rows)[0]
	if row["eventkind"] != waveobj.RunEventKindLeadControlFailed || row["failure"] != ControlFailureWrite {
		t.Fatalf("row = %+v", row)
	}
	msg, _ := row["error"].(string)
	if len(msg) != MaxControlErrEventLen {
		t.Fatalf("error len = %d, want the cap %d", len(msg), MaxControlErrEventLen)
	}
	for _, want := range []string{"dag-123", "run-42", DagEventGateOpen} {
		if !strings.Contains(buf.String(), want) {
			t.Fatalf("log %q missing %q", buf.String(), want)
		}
	}
}

func TestNotifyLeadBestEffortSurvivesAppendFailure(t *testing.T) {
	g := controlGroup(t)
	oldAppend := appendRunEvent
	appendRunEvent = func(context.Context, string, string, string, *int, any) {
		panic("append must not be the only thing standing between the lead and a notification")
	}
	t.Cleanup(func() { appendRunEvent = oldAppend })
	defer func() {
		if recover() == nil {
			t.Fatal("expected the stub panic to prove the append ran, not to be swallowed")
		}
	}()
	old := notifyLeadFn
	notifyLeadFn = func(context.Context, *waveobj.TaskGroup, string, string, string) (ControlResult, error) {
		return ControlResult{Envelope: ControlEnvelope{EventID: "ev-10"}, Sent: true}, nil
	}
	t.Cleanup(func() { notifyLeadFn = old })
	notifyLeadBestEffort(context.Background(), g, DagEventComplete, "done", "")
}

func TestNotifyLeadWritesEnvelopeToControlFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("WAVETERM_PI_CONTROL_DIR", dir)
	oldResolve := resolveLeadSessionFn
	resolveLeadSessionFn = func(context.Context, string, string) string { return "sess-live" }
	t.Cleanup(func() { resolveLeadSessionFn = oldResolve })

	g := controlGroup(t)
	res, err := NotifyLead(context.Background(), g, DagEventChildAsk, "t-0: A or B?", "t-0")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Sent || res.Envelope.EventID == "" || res.Envelope.SessionID != "sess-live" {
		t.Fatalf("result = %+v", res)
	}
	raw, err := os.ReadFile(filepath.Join(dir, controlFileName("sess-live")))
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["eventid"] != res.Envelope.EventID || parsed["taskid"] != "t-0" || parsed["sessionid"] != "sess-live" {
		t.Fatalf("control file envelope = %v", parsed)
	}
}

func TestNotifyLeadUnavailableWithoutControlDir(t *testing.T) {
	t.Setenv("WAVETERM_PI_CONTROL_DIR", "")
	g := controlGroup(t)
	res, err := NotifyLead(context.Background(), g, DagEventGateOpen, "t-0", "t-0")
	if err != nil {
		t.Fatalf("no control dir is not an error: %v", err)
	}
	if res.Sent || res.FailureKind != ControlFailureUnavailable {
		t.Fatalf("result = %+v", res)
	}
}
