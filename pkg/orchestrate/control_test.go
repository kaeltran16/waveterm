package orchestrate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestControlMessageShape(t *testing.T) {
	msg := controlMessage(DagEventGateOpen, "t-0")
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
	for kind, want := range map[string]string{DagEventChildAsk: "child_ask", DagEventTaskStalled: "child_stalled"} {
		m := controlMessage(kind, "t-3")
		var p map[string]any
		if err := json.Unmarshal([]byte(m), &p); err != nil {
			t.Fatalf("unparseable %s message: %v", kind, err)
		}
		if p["cmd"] != want {
			t.Fatalf("%s maps to %q, want %q", kind, p["cmd"], want)
		}
	}
	// NotifyLead without the control dir is a silent no-op, not an error
	g, _ := NewTaskGroup("run-1", "g", "g", 2, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1)
	if err := NotifyLead(context.Background(), &g, DagEventGateOpen, "t-0"); err != nil {
		t.Fatalf("NotifyLead without env must be a no-op: %v", err)
	}
}

func TestNotifyLeadBestEffortLogsFailure(t *testing.T) {
	g, _ := NewTaskGroup("run-42", "ch-1", "g", 1, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1)
	g.OID = "dag-123"
	g.RunID = "run-42"
	old := notifyLeadFn
	notifyLeadFn = func(context.Context, *waveobj.TaskGroup, string, string) error {
		return errors.New("write failed")
	}
	t.Cleanup(func() { notifyLeadFn = old })
	var buf bytes.Buffer
	orig := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(orig) })
	notifyLeadBestEffort(context.Background(), &g, DagEventGateOpen, "t-0")
	out := buf.String()
	for _, want := range []string{"dag-123", "run-42", DagEventGateOpen, "write failed"} {
		if !strings.Contains(out, want) {
			t.Fatalf("log %q missing %q", out, want)
		}
	}
}
