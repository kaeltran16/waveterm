// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentobserve"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// claudePrompt is a transcript line for a prompt typed at a claude session.
func claudePrompt(ts time.Time, text string) string {
	b, _ := json.Marshal(map[string]any{
		"type":      "user",
		"timestamp": ts.UTC().Format(time.RFC3339Nano),
		"origin":    map[string]any{"kind": "human"},
		"message":   map[string]any{"role": "user", "content": text},
	})
	return string(b)
}

func writeClaudeLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// what the human types into a worker's own terminal belongs on its lead's record: each message once, the
// launch prompt never, and without waking the lead.
func TestScheduleRecordsWhatTheHumanToldAWorkerOnce(t *testing.T) {
	allowWorkerHarnessForTest(t)
	ctx := context.Background()
	root := t.TempDir()
	prevRoot := sessionsRootFor
	sessionsRootFor = func(string) string { return root }
	t.Cleanup(func() { sessionsRootFor = prevRoot })
	wakesTyped := 0
	prevSend, prevLaunch := sendWakeFn, launchLeadFn
	sendWakeFn = func(string, string) { wakesTyped++ }
	launchLeadFn = func(context.Context, string, string, string) { wakesTyped++ }
	t.Cleanup(func() { sendWakeFn, launchLeadFn = prevSend, prevLaunch })

	ch, err := wstore.CreateChannel(ctx, "engine-told", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	old := spawnWorker
	spawnWorker = func(context.Context, runroute.Capability, string, string, string, string, jarvis.RunWorkerOptions) (string, error) {
		return "tab:worker", nil
	}
	t.Cleanup(func() { spawnWorker = old })
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	child, err := wstore.GetRun(ctx, ch.OID, g.Tasks[0].RunID)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, agentobserve.SlugifyCwd(ch.ProjectPath), child.SessionId+".jsonl")
	launched := time.Now().Add(-3 * time.Minute)
	launch := claudePrompt(launched, "You are the worker for task 0")

	writeClaudeLines(t, path, launch)
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if n := countEvents(t, ctx, ch.OID, owner.ID, waveobj.RunEventKindTaskTold); n != 0 {
		t.Fatalf("the launch prompt is the engine's, not the human's: got %d task-told rows", n)
	}

	told := launched.Add(time.Minute)
	writeClaudeLines(t, path, launch, claudePrompt(told, "keep closed-session links clickable"))
	for i := 0; i < 2; i++ {
		if err := ScheduleOnce(ctx, &g); err != nil {
			t.Fatal(err)
		}
	}
	if n := countEvents(t, ctx, ch.OID, owner.ID, waveobj.RunEventKindTaskTold); n != 1 {
		t.Fatalf("want one task-told row across two ticks, got %d", n)
	}
	d := firstEventDetail(t, ctx, ch.OID, owner.ID, waveobj.RunEventKindTaskTold)
	if d["taskid"] != "t-0" || d["text"] != "keep closed-session links clickable" {
		t.Fatalf("task-told detail = %+v", d)
	}
	if g.Tasks[0].ToldTs != told.UnixMilli() {
		t.Fatalf("toldts = %d, want %d", g.Tasks[0].ToldTs, told.UnixMilli())
	}

	writeClaudeLines(t, path, launch, claudePrompt(told, "keep closed-session links clickable"), claudePrompt(told.Add(time.Minute), "and reuse the chip"))
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if n := countEvents(t, ctx, ch.OID, owner.ID, waveobj.RunEventKindTaskTold); n != 2 {
		t.Fatalf("want a second row for the second message, got %d", n)
	}
	if wakesTyped != 0 {
		t.Fatalf("what the human told a worker must not wake the lead, got %d wakes", wakesTyped)
	}
}

func TestToldTextKeepsWholeRunesWhenCut(t *testing.T) {
	long := strings.Repeat("é", MaxToldLen+5)
	got := toldText(long)
	if r := []rune(got); len(r) != MaxToldLen || r[len(r)-1] != '…' {
		t.Fatalf("cut to %d runes ending %q, want %d ending in an ellipsis", len(r), string(r[len(r)-1]), MaxToldLen)
	}
	if got := toldText("short"); got != "short" {
		t.Fatalf("toldText(short) = %q", got)
	}
}

// the lead learns what the human typed to its workers from its status: every task-told row, oldest first, in
// whatever order the rows were loaded.
func TestDigestCarriesWhatTheHumanToldWorkers(t *testing.T) {
	g := digestGroup(t, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}, {ID: "t-1", Label: "b"}})
	told := func(taskID, text string, ts int64) waveobj.RunEvent {
		ev := retainedEvent(waveobj.RunEventKindTaskTold, taskID, ts)
		ev.Detail, _ = json.Marshal(map[string]any{"taskid": taskID, "text": text})
		return ev
	}
	d := BuildDigest(DagDigestSnapshot{
		Group: g,
		Retained: []waveobj.RunEvent{
			told("t-1", "reuse the chip", 2000),
			retainedEvent(waveobj.RunEventKindTaskDone, "t-0", 1500),
			told("t-0", "keep links clickable", 1000),
		},
		Now: time.UnixMilli(3000),
	})
	want := []wshrpc.DagTold{{TaskId: "t-0", Ts: 1000, Text: "keep links clickable"}, {TaskId: "t-1", Ts: 2000, Text: "reuse the chip"}}
	if !reflect.DeepEqual(d.Told, want) {
		t.Fatalf("digest told = %+v, want %+v", d.Told, want)
	}
}
