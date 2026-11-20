// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	agentsTestTabA = "aaaaaaaa-1111-4111-8111-111111111111"
	agentsTestTabB = "bbbbbbbb-2222-4222-8222-222222222222"
	agentsTestTabC = "cccccccc-3333-4333-8333-333333333333"
	agentsTestRun  = "0f9e8d7c-6b5a-4433-8221-100000000000"
)

func agentsTestRoster() []wshrpc.AgentInfo {
	return []wshrpc.AgentInfo{
		{TabId: agentsTestTabA, Name: "design lead", ProjectPath: `C:\work\arc`, Project: "arc", RunId: agentsTestRun, Harness: "claude", State: wshrpc.AgentsState_Idle},
		{TabId: agentsTestTabB, Name: "scratch", ProjectPath: `C:\work\arc\pkg`, Project: "arc", Harness: "pi", State: wshrpc.AgentsState_Working},
		{TabId: agentsTestTabC, Name: "siem", ProjectPath: `C:\work\arc-siem`, Project: "arc-siem", Harness: "claude", State: wshrpc.AgentsState_Asking},
	}
}

func agentsTabIds(rows []wshrpc.AgentInfo) []string {
	ids := []string{}
	for _, r := range rows {
		ids = append(ids, r.TabId)
	}
	return ids
}

func TestAgentsListLines(t *testing.T) {
	lines := agentsListLines(agentsTestRoster(), false, "")
	want := [][]string{
		{"aaaaaaaa", "design", "lead", "arc", "0f9e8d7c", "claude", "idle", "-"},
		{"bbbbbbbb", "scratch", "arc", "-", "pi", "working", "-"},
		{"cccccccc", "siem", "arc-siem", "-", "claude", "asking", "-"},
	}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines, want %d: %q", len(lines), len(want), lines)
	}
	for i, line := range lines {
		if got := strings.Fields(line); !reflect.DeepEqual(got, want[i]) {
			t.Errorf("line %d = %q, want fields %q", i, line, want[i])
		}
	}
}

func TestAgentsListEmptyRoster(t *testing.T) {
	if got := agentsListLines(nil, false, ""); !reflect.DeepEqual(got, []string{"no live agents"}) {
		t.Errorf("unfiltered empty roster = %q", got)
	}
	got := agentsListLines(nil, true, "")
	if len(got) != 1 || !strings.Contains(got[0], "no live agents") || !strings.Contains(got[0], "wsh agents list --all") {
		t.Errorf("filtered empty roster = %q, want one line naming --all", got)
	}
}

// two sessions of one project once read as the same row ("waveterm waveterm - claude"), and a message for a
// worktree's session went to the human's own session in the main checkout
func TestAgentsListLinesTellSessionsOfOneProjectApart(t *testing.T) {
	long := strings.Repeat("word ", 30)
	rows := []wshrpc.AgentInfo{
		{TabId: agentsTestTabA, Name: "waveterm", ProjectPath: `C:\work\arc`, Project: "arc", Harness: "claude", State: wshrpc.AgentsState_Working, Cwd: `C:\work\arc`, Title: "Explore improvement areas"},
		{TabId: agentsTestTabB, Name: "waveterm", ProjectPath: `C:\work\arc`, Project: "arc", Harness: "claude", State: wshrpc.AgentsState_Idle, Cwd: `C:\work\arc\.claude\worktrees\bench`, Title: "Benchmark\nsonnet workers"},
		{TabId: agentsTestTabC, Name: "waveterm", ProjectPath: `C:\work\arc`, Project: "arc", RunId: agentsTestRun, Harness: "claude", State: wshrpc.AgentsState_Working, Cwd: `C:\wt\0f9e8d7c-t-1`, Title: long},
	}
	lines := agentsListLines(rows, true, agentsTestTabA)
	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3: %q", len(lines), lines)
	}
	want := []string{
		"working  -  " + agentsSelfMark + " Explore improvement areas",
		"idle     .claude/worktrees/bench  Benchmark sonnet workers",
		`working  C:\wt\0f9e8d7c-t-1`,
	}
	for i, w := range want {
		if norm := strings.Join(strings.Fields(lines[i]), " "); !strings.Contains(norm, strings.Join(strings.Fields(w), " ")) {
			t.Errorf("line %d = %q, want it to hold %q", i, lines[i], w)
		}
	}
	if strings.Contains(lines[1], agentsSelfMark) || strings.Contains(lines[2], agentsSelfMark) {
		t.Errorf("only the caller's own row is marked: %q", lines)
	}
	if !strings.HasSuffix(lines[2], "…") || len([]rune(lines[2])) > 200 {
		t.Errorf("a long title is cut to one short row: %q", lines[2])
	}
}

func TestAgentsListProjectFilter(t *testing.T) {
	roster := agentsTestRoster()
	cases := []struct {
		name    string
		project string
		want    []string
	}{
		// the registry and git spell the same path differently; arc-siem shares a name prefix and is outside
		{"inside the caller's project", "C:/work/arc", []string{agentsTestTabA, agentsTestTabB}},
		{"no agent in the caller's project", `C:\work\other`, []string{}},
		{"caller in no project", "", []string{agentsTestTabA, agentsTestTabB, agentsTestTabC}},
	}
	for _, tc := range cases {
		if got := agentsTabIds(agentsInProject(roster, tc.project)); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: kept %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestAgentsWithout(t *testing.T) {
	roster := agentsTestRoster()
	if got, want := agentsTabIds(agentsWithout(roster, agentsTestTabB)), []string{agentsTestTabA, agentsTestTabC}; !reflect.DeepEqual(got, want) {
		t.Errorf("without the caller's tab kept %q, want %q", got, want)
	}
	// no known self tab drops nothing
	if got, want := agentsTabIds(agentsWithout(roster, "")), []string{agentsTestTabA, agentsTestTabB, agentsTestTabC}; !reflect.DeepEqual(got, want) {
		t.Errorf("without no tab kept %q, want %q", got, want)
	}
	none := agentsWithout(nil, agentsTestTabA)
	if none == nil || len(none) != 0 {
		t.Errorf("no rows = %#v, want a non-nil empty slice so --json prints []", none)
	}
}

func TestAgentsListJSON(t *testing.T) {
	empty, err := json.Marshal(agentsInProject(nil, "C:/work/arc"))
	if err != nil || string(empty) != "[]" {
		t.Fatalf("no rows marshals to %s (%v), want []", empty, err)
	}
	b, err := json.Marshal(agentsInProject(agentsTestRoster(), "C:/work/arc"))
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(b, &rows); err != nil {
		t.Fatalf("not a JSON array: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	want := map[string]any{
		"tabid": agentsTestTabA, "name": "design lead", "projectpath": `C:\work\arc`, "project": "arc",
		"runid": agentsTestRun, "harness": "claude", "state": "idle",
	}
	if !reflect.DeepEqual(rows[0], want) {
		t.Errorf("row = %v, want %v", rows[0], want)
	}
}

func TestAgentsSendText(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	filled, blank := write("msg.md", "from the file\n"), write("blank.md", " \n\t\n")
	cases := []struct {
		name    string
		args    []string
		file    string
		want    string
		wantErr string
	}{
		{name: "argument only", args: []string{"do the thing"}, want: "do the thing"},
		{name: "file only", file: filled, want: "from the file\n"},
		{name: "both", args: []string{"do the thing"}, file: filled, wantErr: "one of them"},
		{name: "neither", wantErr: "one of them"},
		{name: "blank argument", args: []string{"  "}, wantErr: "empty"},
		{name: "blank file", file: blank, wantErr: "empty"},
		{name: "missing file", file: filepath.Join(dir, "nope.md"), wantErr: "reading --file"},
	}
	for _, tc := range cases {
		got, err := agentsSendText(tc.args, tc.file)
		if tc.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("%s: err = %v, want one containing %q", tc.name, err, tc.wantErr)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%s: got %q, %v; want %q", tc.name, got, err, tc.want)
		}
	}
}

func TestAgentsSendTextLines(t *testing.T) {
	started := agentsSendLines(&wshrpc.CommandAgentsSendRtnData{TabId: agentsTestTabA})
	joined := agentsSendLines(&wshrpc.CommandAgentsSendRtnData{TabId: agentsTestTabA, MidTurn: true})
	if !strings.Contains(started[0], "aaaaaaaa") || !strings.Contains(started[0], "started a turn") {
		t.Errorf("idle target: %q", started)
	}
	if !strings.Contains(joined[0], "joined") {
		t.Errorf("mid-turn target: %q", joined)
	}
	if started[len(started)-1] != "read the answer with: wsh agents read aaaaaaaa" {
		t.Errorf("read line: %q", started)
	}
}

func TestAgentsSendFlagsErr(t *testing.T) {
	err := agentsSendFlagsErr(true, true)
	if err == nil || !strings.Contains(err.Error(), "--json") || !strings.Contains(err.Error(), "--wait") {
		t.Errorf("--json with --wait: err = %v, want one naming both flags", err)
	}
	for _, tc := range [][2]bool{{true, false}, {false, true}, {false, false}} {
		if err := agentsSendFlagsErr(tc[0], tc[1]); err != nil {
			t.Errorf("json=%v wait=%v: err = %v, want nil", tc[0], tc[1], err)
		}
	}
}

func TestAgentsSendOutput(t *testing.T) {
	sent := &wshrpc.CommandAgentsSendRtnData{TabId: agentsTestTabA, SentTs: 1, MidTurn: true}
	lines, err := agentsSendOutput(sent, true)
	if err != nil || len(lines) != 1 {
		t.Fatalf("--json: %q, %v; want one line", lines, err)
	}
	var got wshrpc.CommandAgentsSendRtnData
	if err := json.Unmarshal([]byte(lines[0]), &got); err != nil || got != *sent {
		t.Errorf("--json line %q decodes to %+v, %v; want %+v", lines[0], got, err, *sent)
	}
	plain, err := agentsSendOutput(sent, false)
	if err != nil || !reflect.DeepEqual(plain, agentsSendLines(sent)) {
		t.Errorf("plain: %q, %v; want agentsSendLines", plain, err)
	}
}

// a parent captures the worker's tab id from stdout, so plain output is the id and nothing else
func TestAgentsStartOutput(t *testing.T) {
	rtn := &wshrpc.CommandAgentsStartRtnData{TabId: agentsTestTabA, Harness: "claude", Cwd: `C:\work\arc`}
	plain, err := agentsStartOutput(rtn, false)
	if err != nil || plain != agentsTestTabA {
		t.Errorf("plain: %q, %v; want the tab id alone", plain, err)
	}
	line, err := agentsStartOutput(rtn, true)
	var got wshrpc.CommandAgentsStartRtnData
	if err != nil || strings.Contains(line, "\n") || json.Unmarshal([]byte(line), &got) != nil || got != *rtn {
		t.Errorf("--json: %q, %v; want one line decoding to %+v", line, err, *rtn)
	}
}

const agentsTestSentTs = int64(1_000_000)

// agentsWaitScript runs agentsWait over scripted reads (the last one repeats) with a clock that only
// sleeping moves, and reports how many reads it took
func agentsWaitScript(t *testing.T, timeout time.Duration, reads ...wshrpc.CommandAgentsReadRtnData) (*wshrpc.CommandAgentsReadRtnData, int, error) {
	t.Helper()
	return agentsWaitScriptSent(t, &wshrpc.CommandAgentsSendRtnData{TabId: agentsTestTabA, SentTs: agentsTestSentTs}, timeout, reads...)
}

func agentsWaitScriptSent(t *testing.T, sent *wshrpc.CommandAgentsSendRtnData, timeout time.Duration, reads ...wshrpc.CommandAgentsReadRtnData) (*wshrpc.CommandAgentsReadRtnData, int, error) {
	t.Helper()
	clock := time.UnixMilli(agentsTestSentTs)
	n := 0
	read := func() (*wshrpc.CommandAgentsReadRtnData, error) {
		r := reads[min(n, len(reads)-1)]
		r.TabId = agentsTestTabA
		n++
		return &r, nil
	}
	sleep := func(d time.Duration) {
		if d != agentsWaitPoll {
			t.Fatalf("slept %s, want the poll interval %s", d, agentsWaitPoll)
		}
		clock = clock.Add(d)
	}
	r, err := agentsWait(read, sleep, func() time.Time { return clock }, sent, timeout)
	return r, n, err
}

func TestAgentsWaitReturnsTheNewAnswer(t *testing.T) {
	r, n, err := agentsWaitScript(t, time.Minute,
		wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Working, Answer: "old", AnswerTs: agentsTestSentTs - 5},
		wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Working, Answer: "partial", AnswerTs: agentsTestSentTs + 5},
		wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Idle, Answer: "done", AnswerTs: agentsTestSentTs + 9},
	)
	if err != nil || n != 3 {
		t.Fatalf("reads = %d, err = %v; want 3 reads and no error", n, err)
	}
	if got := agentsWaitLines(r); !reflect.DeepEqual(got, []string{"done"}) {
		t.Errorf("printed %q, want the answer", got)
	}
}

func TestAgentsWaitKeepsWaitingOnAnOlderAnswer(t *testing.T) {
	// the target reads idle until it picks the message up, and its last answer is from before the send
	stale := wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Idle, Answer: "old", AnswerTs: agentsTestSentTs}
	r, n, err := agentsWaitScript(t, time.Minute, stale, stale,
		wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Idle, Answer: "new", AnswerTs: agentsTestSentTs + 1})
	if err != nil || n != 3 || r.Answer != "new" {
		t.Fatalf("reads = %d, answer = %+v, err = %v; want the third read's answer", n, r, err)
	}
}

func TestAgentsWaitEndsOnAsking(t *testing.T) {
	r, n, err := agentsWaitScript(t, time.Minute,
		wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Working},
		wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Asking, Answer: "old", AnswerTs: agentsTestSentTs - 5},
	)
	if err != nil || n != 2 {
		t.Fatalf("reads = %d, err = %v; want the wait to end on the second read", n, err)
	}
	lines := agentsWaitLines(r)
	if len(lines) != 1 || !strings.Contains(lines[0], "waiting on the user") || strings.Contains(lines[0], "old") {
		t.Errorf("printed %q, want one line saying the target waits on the user", lines)
	}
}

func TestAgentsWaitTimesOut(t *testing.T) {
	timeout := 3 * agentsWaitPoll
	r, n, err := agentsWaitScript(t, timeout, wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Working})
	if r != nil || err == nil {
		t.Fatalf("got %+v, %v; want a timeout error", r, err)
	}
	if !strings.Contains(err.Error(), "still working") || !strings.Contains(err.Error(), "wsh agents wait aaaaaaaa") {
		t.Errorf("err = %v, want it to say the target is still working and how to keep waiting", err)
	}
	if n != 4 {
		t.Errorf("reads = %d, want 4 (one at the start, one per poll until the timeout)", n)
	}
}

// a send that never started a turn left the target idle on its older answer, and --wait sat out the full
// timeout before saying anything
func TestAgentsWaitFailsFastWhenNoTurnStarts(t *testing.T) {
	stale := wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Idle, Answer: "old", AnswerTs: agentsTestSentTs}
	r, n, err := agentsWaitScript(t, 10*time.Minute, stale)
	if r != nil || err == nil || !strings.Contains(err.Error(), "did not start a turn") {
		t.Fatalf("got %+v, %v; want an error saying no turn started", r, err)
	}
	if want := int(orchestrate.WakeConfirmTimeout/agentsWaitPoll) + 1; n != want {
		t.Errorf("reads = %d, want %d (the gate is the engine's wake-confirm window, not the timeout)", n, want)
	}
}

func TestAgentsWaitStallGateOnlyBeforeATurnStarts(t *testing.T) {
	stale := wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Idle, Answer: "old", AnswerTs: agentsTestSentTs}
	// a send that joined a running turn: the target may read idle briefly between turns
	joined := &wshrpc.CommandAgentsSendRtnData{TabId: agentsTestTabA, SentTs: agentsTestSentTs, MidTurn: true}
	if _, _, err := agentsWaitScriptSent(t, joined, 2*time.Minute, stale); err == nil || !strings.Contains(err.Error(), "is idle after") ||
		strings.Contains(err.Error(), "working") {
		t.Errorf("mid-turn send: err = %v, want the plain timeout naming the idle state", err)
	}
	// a turn that started and is slow is not a stall
	working := wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Working, Answer: "old", AnswerTs: agentsTestSentTs}
	if _, _, err := agentsWaitScript(t, 2*time.Minute, stale, working); err == nil || !strings.Contains(err.Error(), "still working after") {
		t.Errorf("started turn: err = %v, want the plain timeout", err)
	}
}

func TestAgentsWaitReturnsAReadError(t *testing.T) {
	boom := errors.New("is not a live agent session")
	read := func() (*wshrpc.CommandAgentsReadRtnData, error) { return nil, boom }
	sleep := func(time.Duration) { t.Fatal("slept after a failed read") }
	_, err := agentsWait(read, sleep, time.Now, &wshrpc.CommandAgentsSendRtnData{TabId: agentsTestTabA}, time.Minute)
	if !errors.Is(err, boom) {
		t.Errorf("err = %v, want the read's error as it came", err)
	}
}

// agentsWaitUntilScript runs agentsWaitUntil over scripted reads (the last one repeats) with a clock that only
// sleeping moves, and reports how many reads it took
func agentsWaitUntilScript(t *testing.T, until string, timeout time.Duration, reads ...wshrpc.CommandAgentsReadRtnData) (*wshrpc.CommandAgentsReadRtnData, int, error) {
	t.Helper()
	clock := time.UnixMilli(agentsTestSentTs)
	n := 0
	read := func() (*wshrpc.CommandAgentsReadRtnData, error) {
		r := reads[min(n, len(reads)-1)]
		r.TabId = agentsTestTabA
		n++
		return &r, nil
	}
	sleep := func(d time.Duration) { clock = clock.Add(d) }
	r, err := agentsWaitUntil(read, sleep, func() time.Time { return clock }, until, timeout)
	return r, n, err
}

// the only wait was attached to send, so after a timeout the caller polled wsh agents read by hand
func TestAgentsWaitUntil(t *testing.T) {
	working := wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Working}
	idle := wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Idle, Answer: "done", AnswerTs: 5}
	asking := wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Asking}
	stopped := wshrpc.CommandAgentsReadRtnData{State: wshrpc.AgentsState_Stopped, Answer: "done", AnswerTs: 5}
	cases := []struct {
		name   string
		until  string
		reads  []wshrpc.CommandAgentsReadRtnData
		want   string
		nReads int
	}{
		{"settles on idle", "", []wshrpc.CommandAgentsReadRtnData{working, working, idle}, wshrpc.AgentsState_Idle, 3},
		{"settles on asking", "", []wshrpc.CommandAgentsReadRtnData{working, asking}, wshrpc.AgentsState_Asking, 2},
		{"already idle returns at once", "", []wshrpc.CommandAgentsReadRtnData{idle}, wshrpc.AgentsState_Idle, 1},
		{"until asking passes idle by", wshrpc.AgentsState_Asking, []wshrpc.CommandAgentsReadRtnData{idle, working, asking}, wshrpc.AgentsState_Asking, 3},
		{"until idle passes asking by", wshrpc.AgentsState_Idle, []wshrpc.CommandAgentsReadRtnData{asking, working, idle}, wshrpc.AgentsState_Idle, 3},
		{"settles on a stopped worker", "", []wshrpc.CommandAgentsReadRtnData{working, stopped}, wshrpc.AgentsState_Stopped, 2},
		{"until idle is met by stopped", wshrpc.AgentsState_Idle, []wshrpc.CommandAgentsReadRtnData{asking, stopped}, wshrpc.AgentsState_Stopped, 2},
	}
	for _, c := range cases {
		r, n, err := agentsWaitUntilScript(t, c.until, time.Minute, c.reads...)
		if err != nil || r.State != c.want || n != c.nReads {
			t.Errorf("%s: got %+v after %d reads, %v; want state %s after %d", c.name, r, n, err, c.want, c.nReads)
		}
	}
	r, n, err := agentsWaitUntilScript(t, wshrpc.AgentsState_Asking, 3*agentsWaitPoll, idle)
	if r != nil || err == nil || !strings.Contains(err.Error(), "still idle") || !strings.Contains(err.Error(), "wsh agents wait aaaaaaaa") || n != 4 {
		t.Errorf("timeout: got %+v after %d reads, %v; want an error naming the state and how to wait again", r, n, err)
	}
}

func TestAgentsWaitUntilFlag(t *testing.T) {
	for _, ok := range []string{"", "idle", "asking"} {
		if err := agentsCheckUntil(ok); err != nil {
			t.Errorf("--until %q: %v", ok, err)
		}
	}
	if err := agentsCheckUntil("working"); err == nil || !strings.Contains(err.Error(), "idle or asking") {
		t.Errorf("--until working: err = %v", err)
	}
}

func TestAgentsExplainLines(t *testing.T) {
	now := time.UnixMilli(agentsTestSentTs + 12_000)
	live := &wshrpc.CommandAgentsExplainRtnData{
		TabId: agentsTestTabA, Name: "design lead", BlockId: "b1", ShellRunning: true, HasStream: true, OpenAsk: true, Live: true, State: wshrpc.AgentsState_Asking,
		Status: baseds.AgentStatusData{Agent: "claude", State: baseds.AgentState_Waiting, Hook: "Notification", NotificationType: "permission_prompt", Ts: agentsTestSentTs, Detail: "editing a.go", Cwd: `C:\work\arc`, TranscriptPath: `C:\t.jsonl`},
	}
	got := strings.Join(agentsExplainLines(live, now), "\n")
	for _, want := range []string{
		agentsTestTabA + " (design lead)",
		"yes, as asking",
		"claude reported waiting from Notification (permission_prompt) 12s ago: editing a.go",
		"shell     running",
		"open: a prompt runs over the mod",
		"question  open",
		`C:\work\arc`,
		`C:\t.jsonl`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("live explain lacks %q:\n%s", want, got)
		}
	}
	gone := &wshrpc.CommandAgentsExplainRtnData{TabId: agentsTestTabB, Name: "scratch", NotLive: "its terminal has no running shell"}
	got = strings.Join(agentsExplainLines(gone, now), "\n")
	for _, want := range []string{"no: its terminal has no running shell", "none reported since wavesrv started", "not running", "none: a prompt is typed", "question  none"} {
		if !strings.Contains(got, want) {
			t.Errorf("not-live explain lacks %q:\n%s", want, got)
		}
	}
}

func TestAgentsReadLines(t *testing.T) {
	answered := agentsReadLines(&wshrpc.CommandAgentsReadRtnData{TabId: agentsTestTabA, State: wshrpc.AgentsState_Idle, Answer: "line one\nline two", AnswerTs: 5})
	if !reflect.DeepEqual(answered, []string{"line one\nline two"}) {
		t.Errorf("with an answer: %q", answered)
	}
	none := agentsReadLines(&wshrpc.CommandAgentsReadRtnData{TabId: agentsTestTabA, State: wshrpc.AgentsState_Working})
	if len(none) != 1 || !strings.Contains(none[0], "has not answered yet") || !strings.Contains(none[0], "working") || !strings.Contains(none[0], "aaaaaaaa") {
		t.Errorf("without an answer: %q", none)
	}
}
