// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/workflowscan"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const workflowScanTestQuote = "the worker skipped the watch it fail first step"

type modelCall struct {
	spec   consult.RuntimeSpec
	cwd    string
	prompt string
}

// latestRow is past the newest run and scan-signal event in the store, which every test in the package shares: a
// test that places its rows after it reads only its own, whatever other tests seed
func latestRow(t *testing.T) time.Time {
	t.Helper()
	ctx := context.Background()
	runs, err := wstore.GetRunsCreatedSince(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	events, err := wstore.QueryRunEventsSince(ctx, 0, workflowscan.EventKinds)
	if err != nil {
		t.Fatal(err)
	}
	latest := time.Now().UnixMilli()
	for _, r := range runs {
		latest = max(latest, r.CreatedTs)
	}
	for _, e := range events {
		latest = max(latest, e.Ts)
	}
	return time.UnixMilli(latest + 1)
}

// scanWindowEnd is a scan clock whose default window starts after every row already in the store
func scanWindowEnd(t *testing.T) time.Time {
	t.Helper()
	return latestRow(t).Add(time.Duration(workflowScanWindowDays+1) * 24 * time.Hour)
}

func stubWorkflowScanModel(t *testing.T, now time.Time, reply func(prompt string) (string, error)) *[]modelCall {
	t.Helper()
	var calls []modelCall
	oldModel, oldNow := workflowScanModel, workflowScanNow
	workflowScanModel = func(_ context.Context, spec consult.RuntimeSpec, cwd, prompt string) (string, error) {
		calls = append(calls, modelCall{spec, cwd, prompt})
		return reply(prompt)
	}
	workflowScanNow = func() time.Time { return now }
	t.Cleanup(func() { workflowScanModel, workflowScanNow = oldModel, oldNow })
	return &calls
}

func newScanChannel(t *testing.T, name string) *waveobj.Channel {
	t.Helper()
	ch, err := wstore.CreateChannel(context.Background(), name, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return ch
}

// startTestScan starts a scan run through the real create path, with a fake worker tab. The run is cancelled when
// the test ends: one scan runs at a time across projects, so a scan left live would refuse every later start.
func startTestScan(t *testing.T, ch *waveobj.Channel) *waveobj.Run {
	t.Helper()
	stubRunServer(t, "claude", nil)
	rtn, err := (&WshServer{}).WorkflowScanStartCommand(context.Background(), wshrpc.CommandWorkflowScanStartData{
		ChannelId: ch.OID, WorkspaceId: "ws",
	})
	if err != nil {
		t.Fatalf("starting a scan: %v", err)
	}
	t.Cleanup(func() { setRunStatus(t, rtn.Run, jarvis.RunStatus_Cancelled) })
	return rtn.Run
}

func setRunStatus(t *testing.T, run *waveobj.Run, status string) {
	t.Helper()
	if err := wstore.UpdateRun(context.Background(), run.ChannelOID, run.ID, func(r *waveobj.Run) error {
		r.Status = status
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func scanWorkerORef(t *testing.T, run *waveobj.Run) string {
	t.Helper()
	if len(run.Phases) == 0 || len(run.Phases[0].WorkerOrefs) == 0 {
		t.Fatalf("scan run %s has no worker", run.ID)
	}
	return run.Phases[0].WorkerOrefs[0]
}

func readScan(t *testing.T, run *waveobj.Run) *waveobj.Run {
	t.Helper()
	got, err := wstore.GetRun(context.Background(), run.ChannelOID, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func setScan(t *testing.T, run *waveobj.Run, fn func(s *waveobj.WorkflowScan)) {
	t.Helper()
	if err := wstore.UpdateRun(context.Background(), run.ChannelOID, run.ID, func(r *waveobj.Run) error {
		fn(r.WorkflowScan)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// seedSignalRun adds a run created at ts with one land-held line
func seedSignalRun(t *testing.T, ch *waveobj.Channel, ts time.Time, reason string) string {
	t.Helper()
	ctx := context.Background()
	run := waveobj.Run{ID: uuid.NewString(), Goal: "seeded", ProjectPath: ch.ProjectPath, CreatedTs: ts.UnixMilli()}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatal(err)
	}
	if _, err := wstore.AppendRunEventAt(ctx, ts.UnixMilli()+1, ch.OID, run.ID, waveobj.RunEventKindLandHeld, nil, map[string]any{"reason": reason}); err != nil {
		t.Fatal(err)
	}
	return run.ID
}

func TestRunProjectName(t *testing.T) {
	ch := &waveobj.Channel{OID: "c1", Name: "siem", ProjectPath: `C:\src\cyber_anomaly_detector`}
	chans := map[string]*waveobj.Channel{ch.OID: ch}
	if got := runProjectName(&waveobj.Run{ChannelOID: "c1", ProjectPath: ch.ProjectPath}, chans); got != "siem" {
		t.Fatalf("want the channel's name, got %q", got)
	}
	if got := runProjectName(&waveobj.Run{ChannelOID: "gone", ProjectPath: `C:\src\cyber_anomaly_detector`}, chans); got != "cyber_anomaly_detector" {
		t.Fatalf("want the base name of the path when the channel is gone, got %q", got)
	}
	unnamed := map[string]*waveobj.Channel{"c2": {OID: "c2", ProjectPath: "/src/waveterm"}}
	if got := runProjectName(&waveobj.Run{ChannelOID: "c2", ProjectPath: "/src/waveterm/"}, unnamed); got != "waveterm" {
		t.Fatalf("want the base name of the path for an unnamed channel, got %q", got)
	}
}

func TestWorkflowScanStartMarksRun(t *testing.T) {
	ch := newScanChannel(t, "wfscan-start")
	run := startTestScan(t, ch)
	if run.Runtime != "claude" || run.Model != "opus" || run.Mode != jarvis.RunMode_Quick {
		t.Fatalf("want a quick claude/opus run, got %s %s/%s", run.Mode, run.Runtime, run.Model)
	}
	if !strings.HasPrefix(run.Goal, "Workflow scan") || !strings.Contains(run.Goal, "--window 14") {
		t.Fatalf("want the built-in goal over 14 days, got %q", run.Goal)
	}
	s := readScan(t, run).WorkflowScan
	if s == nil || s.State != waveobj.WorkflowScanState_Scanning || s.Stage != waveobj.WorkflowScanStage_Read ||
		s.Project != ch.Name || s.WindowDays != 14 {
		t.Fatalf("want the run marked scanning/read in %s over 14 days, got %+v", ch.Name, s)
	}
}

func TestWorkflowScanStartRefusesWhileActive(t *testing.T) {
	ch := newScanChannel(t, "wfscan-active")
	first := startTestScan(t, ch)
	// one scan at a time across projects: a live scan in one refuses a start in another
	other := newScanChannel(t, "wfscan-active-other")
	for _, state := range []string{waveobj.WorkflowScanState_Scanning, waveobj.WorkflowScanState_Picking, waveobj.WorkflowScanState_Applying} {
		setScan(t, first, func(s *waveobj.WorkflowScan) { s.State = state })
		for _, start := range []*waveobj.Channel{ch, other} {
			_, err := (&WshServer{}).WorkflowScanStartCommand(context.Background(), wshrpc.CommandWorkflowScanStartData{
				ChannelId: start.OID, WorkspaceId: "ws",
			})
			if err == nil || !strings.Contains(err.Error(), first.ID) || !strings.Contains(err.Error(), "in "+ch.Name+":") {
				t.Fatalf("%s, starting in %s: want a refusal naming %s's run %s, got %v", state, start.Name, ch.Name, first.ID, err)
			}
		}
	}
	// a cancelled scan blocks nothing
	setRunStatus(t, first, jarvis.RunStatus_Cancelled)
	startTestScan(t, other)
}

func TestWorkflowScanStartIgnoresFinishedRuns(t *testing.T) {
	ctx := context.Background()
	ch := newScanChannel(t, "wfscan-finished")
	for _, r := range []waveobj.Run{
		{Status: jarvis.RunStatus_Cancelled, WorkflowScan: &waveobj.WorkflowScan{State: waveobj.WorkflowScanState_Scanning}},
		{Status: jarvis.RunStatus_Done, WorkflowScan: &waveobj.WorkflowScan{State: waveobj.WorkflowScanState_Picking}},
		{Status: jarvis.RunStatus_Executing, WorkflowScan: &waveobj.WorkflowScan{State: waveobj.WorkflowScanState_Failed}},
	} {
		r.ID = uuid.NewString()
		r.CreatedTs = time.Now().UnixMilli()
		if err := wstore.AppendRun(ctx, ch.OID, r); err != nil {
			t.Fatal(err)
		}
	}
	startTestScan(t, ch)
}

func TestWorkflowScanStages(t *testing.T) {
	ctx := context.Background()
	scanCh := newScanChannel(t, "wfscan-stages")
	run := startTestScan(t, scanCh)
	now := scanWindowEnd(t)
	siem := newScanChannel(t, "wfscan-stages-siem")
	var ids []string
	for i := range 3 {
		ids = append(ids, seedSignalRun(t, siem, now.Add(-time.Duration(i+1)*24*time.Hour), workflowScanTestQuote))
	}
	// outside the 14-day window
	seedSignalRun(t, siem, now.Add(-20*24*time.Hour), workflowScanTestQuote)

	var stagesSeen []string
	calls := stubWorkflowScanModel(t, now, func(prompt string) (string, error) {
		mid := readScan(t, run)
		stagesSeen = append(stagesSeen, mid.WorkflowScan.Stage)
		var cites []string
		for _, id := range ids {
			cites = append(cites, fmt.Sprintf(`{"run":%q,"quote":%q}`, id[:8], workflowScanTestQuote))
		}
		return "```json\n" + `{"patterns":[` +
			`{"title":"skipped red step","fixtarget":"engine.go · workerContract","citations":[` + strings.Join(cites, ",") + `]},` +
			`{"title":"rare","fixtarget":"x.go · y","citations":[` + cites[0] + `]}]}` + "\n```", nil
	})

	scan, err := (&WshServer{}).WorkflowScanCommand(ctx, wshrpc.CommandWorkflowScanData{ORef: scanWorkerORef(t, run), WindowDays: 14})
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("want one model call, got %d", len(*calls))
	}
	call := (*calls)[0]
	if call.cwd != run.ProjectPath {
		t.Fatalf("want the model run in %s, got %q", run.ProjectPath, call.cwd)
	}
	i := slices.Index(call.spec.BaseArgs, "--session-id")
	if i < 0 || i+1 >= len(call.spec.BaseArgs) || !slices.Contains(call.spec.BaseArgs, "--model") {
		t.Fatalf("want a --model and a --session-id on the spec, got %v", call.spec.BaseArgs)
	}
	sessionId := call.spec.BaseArgs[i+1]
	if !strings.Contains(call.prompt, ids[0][:8]) {
		t.Fatalf("the prompt lacks the corpus")
	}
	if !slices.Equal(stagesSeen, []string{waveobj.WorkflowScanStage_Patterns}) {
		t.Fatalf("want the record at patterns during the model call, got %v", stagesSeen)
	}

	stored := readScan(t, run)
	for _, s := range []*waveobj.WorkflowScan{scan, stored.WorkflowScan} {
		if s.State != waveobj.WorkflowScanState_Scanning || s.Stage != waveobj.WorkflowScanStage_Checking {
			t.Fatalf("want scanning/checking, got %s/%s", s.State, s.Stage)
		}
		if s.Runs != 3 || s.Projects != 1 || s.Candidates != 2 || s.Kept != 1 || s.Dropped != 0 {
			t.Fatalf("counts: runs=%d projects=%d candidates=%d kept=%d dropped=%d", s.Runs, s.Projects, s.Candidates, s.Kept, s.Dropped)
		}
		if s.WindowDays != 14 || s.ToTs != now.UnixMilli() || s.FromTs != now.Add(-14*24*time.Hour).UnixMilli() {
			t.Fatalf("window: %d days, %d..%d", s.WindowDays, s.FromTs, s.ToTs)
		}
		if len(s.Survivors) != 1 || s.Survivors[0].Id != "p1" || s.Survivors[0].Runs != 3 ||
			len(s.Survivors[0].Projects) != 1 || s.Survivors[0].Projects[0].Name != siem.Name {
			t.Fatalf("survivors: %+v", s.Survivors)
		}
		if len(s.UnderFloor) != 1 || s.UnderFloor[0].Title != "rare" {
			t.Fatalf("under floor: %+v", s.UnderFloor)
		}
	}
	want := waveobj.ConsultSession{SessionId: sessionId, Role: jarvis.UsageRole_WorkflowScan}
	if !slices.Contains(stored.ConsultSessions, want) {
		t.Fatalf("want consult session %+v on the run, got %+v", want, stored.ConsultSessions)
	}
}

func TestWorkflowScanFailsOnBadReply(t *testing.T) {
	run := startTestScan(t, newScanChannel(t, "wfscan-bad"))
	stubWorkflowScanModel(t, scanWindowEnd(t), func(string) (string, error) { return "I found nothing worth a block", nil })
	_, err := (&WshServer{}).WorkflowScanCommand(context.Background(), wshrpc.CommandWorkflowScanData{ORef: scanWorkerORef(t, run)})
	if err == nil {
		t.Fatal("want the scan to fail on a reply with no json")
	}
	s := readScan(t, run).WorkflowScan
	if s.State != waveobj.WorkflowScanState_Failed || !strings.Contains(s.Error, "I found nothing") {
		t.Fatalf("want failed with the reason stored, got %s %q", s.State, s.Error)
	}

	run = startTestScan(t, newScanChannel(t, "wfscan-modelerr"))
	stubWorkflowScanModel(t, scanWindowEnd(t), func(string) (string, error) { return "", errors.New("claude exited 1") })
	if _, err := (&WshServer{}).WorkflowScanCommand(context.Background(), wshrpc.CommandWorkflowScanData{ORef: scanWorkerORef(t, run)}); err == nil {
		t.Fatal("want the scan to fail when the model call does")
	}
	if s := readScan(t, run).WorkflowScan; s.State != waveobj.WorkflowScanState_Failed || !strings.Contains(s.Error, "claude exited 1") {
		t.Fatalf("want failed with the model error stored, got %s %q", s.State, s.Error)
	}
}

func TestWorkflowScanRefusesNonScanRun(t *testing.T) {
	ctx := context.Background()
	ch := newScanChannel(t, "wfscan-notscan")
	stubRunServer(t, "claude", nil)
	rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
		ChannelId: ch.OID, WorkspaceId: "ws", Goal: "an ordinary run", Runtime: "claude",
	})
	if err != nil {
		t.Fatal(err)
	}
	calls := stubWorkflowScanModel(t, scanWindowEnd(t), func(string) (string, error) { return "", nil })
	oref := scanWorkerORef(t, rtn.Run)
	if _, err := (&WshServer{}).WorkflowScanCommand(ctx, wshrpc.CommandWorkflowScanData{ORef: oref}); err == nil || !strings.Contains(err.Error(), "not a workflow scan") {
		t.Fatalf("scan: want a refusal, got %v", err)
	}
	if err := (&WshServer{}).WorkflowScanResultCommand(ctx, wshrpc.CommandWorkflowScanResultData{ORef: oref}); err == nil || !strings.Contains(err.Error(), "not a workflow scan") {
		t.Fatalf("result: want a refusal, got %v", err)
	}
	if len(*calls) != 0 {
		t.Fatal("a refused scan called the model")
	}
	if r := readScan(t, rtn.Run); r.WorkflowScan != nil {
		t.Fatalf("a refused scan marked the run: %+v", r.WorkflowScan)
	}
}

var testSurvivor = waveobj.WorkflowScanPattern{Id: "p1", Title: "skipped red step", FixTarget: "engine.go · workerContract", Runs: 3, Days: 3}

func suggestVerdict(fixProject string) waveobj.WorkflowScanVerdict {
	return waveobj.WorkflowScanVerdict{
		Id: "p1", Verdict: waveobj.WorkflowScanVerdict_Suggest, File: "pkg/orchestrate/engine.go",
		Where: "workerContract", FixProject: fixProject, Edit: "+ file a skipped red step under Not verified",
	}
}

func TestWorkflowScanResultSetsPicking(t *testing.T) {
	ctx := context.Background()
	ch := newScanChannel(t, "wfscan-result")
	run := startTestScan(t, ch)
	setScan(t, run, func(s *waveobj.WorkflowScan) {
		s.Stage = waveobj.WorkflowScanStage_Checking
		s.Survivors = []waveobj.WorkflowScanPattern{testSurvivor}
	})
	oref := scanWorkerORef(t, run)

	err := (&WshServer{}).WorkflowScanResultCommand(ctx, wshrpc.CommandWorkflowScanResultData{ORef: oref})
	if err == nil || !strings.Contains(err.Error(), "p1") {
		t.Fatalf("want verdicts that miss p1 refused naming it, got %v", err)
	}
	if s := readScan(t, run).WorkflowScan; s.State != waveobj.WorkflowScanState_Scanning || len(s.Verdicts) != 0 {
		t.Fatalf("a refused result changed the record: %+v", s)
	}

	v := suggestVerdict(ch.Name)
	if err := (&WshServer{}).WorkflowScanResultCommand(ctx, wshrpc.CommandWorkflowScanResultData{ORef: oref, Verdicts: []waveobj.WorkflowScanVerdict{v}}); err != nil {
		t.Fatalf("result: %v", err)
	}
	s := readScan(t, run).WorkflowScan
	if s.State != waveobj.WorkflowScanState_Picking || len(s.Verdicts) != 1 || s.Verdicts[0] != v {
		t.Fatalf("want picking with the verdict stored, got %s %+v", s.State, s.Verdicts)
	}
}

// pickingScan is a started scan whose agent has sent one suggestion for the scan's own project
func pickingScan(t *testing.T, name string) (*waveobj.Channel, *waveobj.Run) {
	t.Helper()
	ch := newScanChannel(t, name)
	run := startTestScan(t, ch)
	setScan(t, run, func(s *waveobj.WorkflowScan) {
		s.State = waveobj.WorkflowScanState_Picking
		s.Survivors = []waveobj.WorkflowScanPattern{testSurvivor}
		s.Verdicts = []waveobj.WorkflowScanVerdict{suggestVerdict(ch.Name)}
	})
	return ch, run
}

type sentLineTo struct{ block, text string }

func stubScanDelivery(t *testing.T, block string) *[]sentLineTo {
	t.Helper()
	var sent []sentLineTo
	oldDeliver, oldBlock := deliverAgentMessage, tabAgentBlock
	deliverAgentMessage = func(b, text string) { sent = append(sent, sentLineTo{b, text}) }
	tabAgentBlock = func(context.Context, string) string { return block }
	t.Cleanup(func() { deliverAgentMessage, tabAgentBlock = oldDeliver, oldBlock })
	return &sent
}

func TestWorkflowScanPicksDelivers(t *testing.T) {
	ch, run := pickingScan(t, "wfscan-picks")
	sent := stubScanDelivery(t, "block-1")
	picks := []waveobj.WorkflowScanPick{{Id: "p1", Pick: waveobj.WorkflowScanPick_Apply}}

	bad := []waveobj.WorkflowScanPick{{Id: "p1", Pick: waveobj.WorkflowScanPick_Drop}}
	if err := (&WshServer{}).WorkflowScanPicksCommand(context.Background(), wshrpc.CommandWorkflowScanPicksData{ChannelId: ch.OID, RunId: run.ID, Picks: bad}); err == nil {
		t.Fatal("want a drop with no reason refused")
	}
	if len(*sent) != 0 {
		t.Fatal("refused picks were delivered")
	}

	if err := (&WshServer{}).WorkflowScanPicksCommand(context.Background(), wshrpc.CommandWorkflowScanPicksData{ChannelId: ch.OID, RunId: run.ID, Picks: picks}); err != nil {
		t.Fatalf("picks: %v", err)
	}
	s := readScan(t, run).WorkflowScan
	if s.State != waveobj.WorkflowScanState_Applying || !slices.Equal(s.Picks, picks) {
		t.Fatalf("want applying with the picks stored, got %s %+v", s.State, s.Picks)
	}
	if len(*sent) != 1 || (*sent)[0] != (sentLineTo{"block-1", workflowscan.PicksLine}) {
		t.Fatalf("want the picks line typed into the agent's block, got %+v", *sent)
	}
}

type scanResumeCall struct{ tabORef, runtime, sessionId, nudge string }

func stubScanResume(t *testing.T, err error) *[]scanResumeCall {
	t.Helper()
	var calls []scanResumeCall
	old := jarvis.ResumeRunWorker
	jarvis.ResumeRunWorker = func(_ context.Context, tabORef, runtime, sessionId, nudge string) error {
		calls = append(calls, scanResumeCall{tabORef, runtime, sessionId, nudge})
		return err
	}
	t.Cleanup(func() { jarvis.ResumeRunWorker = old })
	return &calls
}

// closeWorkerTab closes a run's worker tab the way the app does, through wcore.DeleteTab in its workspace
func closeWorkerTab(t *testing.T, workerORef string) {
	t.Helper()
	ctx := context.Background()
	oref, err := waveobj.ParseORef(workerORef)
	if err != nil {
		t.Fatal(err)
	}
	ws := &waveobj.Workspace{OID: uuid.NewString(), TabIds: []string{oref.OID}}
	if err := wstore.DBInsert(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if _, err := wcore.DeleteTab(ctx, ws.OID, oref.OID, false); err != nil {
		t.Fatalf("closing tab %s: %v", workerORef, err)
	}
}

// the scan's tab is closed while it waits on picks: the close fails the run, and the picks resume the scan's
// session in a new tab that starts on them
func TestWorkflowScanPicksResumeAnAgentWhoseTabClosed(t *testing.T) {
	ctx := context.Background()
	ch, run := pickingScan(t, "wfscan-picks-closed")
	run = readScan(t, run)
	closed := scanWorkerORef(t, run)
	sent := stubScanDelivery(t, "")
	resumed := stubScanResume(t, nil)

	closeWorkerTab(t, closed)
	if got := readScan(t, run); got.Status != jarvis.RunStatus_Blocked || got.Phases[0].State != jarvis.PhaseState_Failed {
		t.Fatalf("closing the scan's tab left status=%q phase=%q, want blocked and failed", got.Status, got.Phases[0].State)
	}

	picks := []waveobj.WorkflowScanPick{{Id: "p1", Pick: waveobj.WorkflowScanPick_Apply}}
	if err := (&WshServer{}).WorkflowScanPicksCommand(ctx, wshrpc.CommandWorkflowScanPicksData{ChannelId: ch.OID, RunId: run.ID, Picks: picks}); err != nil {
		t.Fatalf("picks with the agent's tab closed: %v", err)
	}
	got := readScan(t, run)
	worker := scanWorkerORef(t, got)
	if worker == closed || len(got.Phases[0].WorkerOrefs) != 1 || got.Phases[0].State != jarvis.PhaseState_Running {
		t.Fatalf("want the closed tab %s replaced by a running worker, got %v %s", closed, got.Phases[0].WorkerOrefs, got.Phases[0].State)
	}
	want := scanResumeCall{worker, run.Runtime, run.SessionId, workflowscan.PicksLine}
	if run.SessionId == "" || len(*resumed) != 1 || (*resumed)[0] != want {
		t.Fatalf("want the scan's session resumed in the new tab with the picks line, got %+v (want %+v)", *resumed, want)
	}
	if m := jarvis.ResolveRunWorkerFromMeta(ctx, worker); m == nil || m.Run.ID != run.ID {
		t.Fatalf("want the new tab to resolve to run %s, got %+v", run.ID, m)
	}
	if s := got.WorkflowScan; s.State != waveobj.WorkflowScanState_Applying || !slices.Equal(s.Picks, picks) {
		t.Fatalf("want applying with the picks stored, got %s %+v", s.State, s.Picks)
	}
	if len(*sent) != 0 {
		t.Fatalf("the picks line goes in as the resumed session's first turn, not typed, got %+v", *sent)
	}
}

func TestWorkflowScanPicksStoredWhenDeliveryFails(t *testing.T) {
	ch, run := pickingScan(t, "wfscan-picks-gone")
	sent := stubScanDelivery(t, "")
	picks := []waveobj.WorkflowScanPick{{Id: "p1", Pick: waveobj.WorkflowScanPick_Drop, Reason: "not worth it"}}

	err := (&WshServer{}).WorkflowScanPicksCommand(context.Background(), wshrpc.CommandWorkflowScanPicksData{ChannelId: ch.OID, RunId: run.ID, Picks: picks})
	if err == nil || !strings.Contains(err.Error(), run.ID) {
		t.Fatalf("want a delivery error naming run %s, got %v", run.ID, err)
	}
	s := readScan(t, run).WorkflowScan
	if s.State != waveobj.WorkflowScanState_Applying || !slices.Equal(s.Picks, picks) {
		t.Fatalf("want the picks stored and applying though delivery failed, got %s %+v", s.State, s.Picks)
	}
	if len(*sent) != 0 {
		t.Fatalf("nothing should be delivered with no agent block, got %+v", *sent)
	}
}

func TestGetWorkflowScanNewest(t *testing.T) {
	ctx := context.Background()
	other := newScanChannel(t, "wfscan-newest-tab")
	run := startTestScan(t, other)
	ch := newScanChannel(t, "wfscan-newest")
	// created after every run already in the store, so it is the newest whatever other tests seeded
	newest := waveobj.Run{
		ID: uuid.NewString(), ChannelOID: ch.OID, CreatedTs: latestRow(t).UnixMilli(),
		WorkflowScan: &waveobj.WorkflowScan{State: waveobj.WorkflowScanState_Picking, Project: ch.Name},
	}
	if err := wstore.AppendRun(ctx, ch.OID, newest); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { setRunStatus(t, &newest, jarvis.RunStatus_Cancelled) })
	rtn, err := (&WshServer{}).GetWorkflowScanCommand(ctx, wshrpc.CommandGetWorkflowScanData{})
	if err != nil {
		t.Fatal(err)
	}
	if rtn.RunId != newest.ID || rtn.ChannelId != ch.OID || rtn.Scan == nil || rtn.Scan.State != waveobj.WorkflowScanState_Picking {
		t.Fatalf("want the newest scan run %s, got %+v", newest.ID, rtn)
	}

	// a tab's own scan, whatever is newer
	rtn, err = (&WshServer{}).GetWorkflowScanCommand(ctx, wshrpc.CommandGetWorkflowScanData{ORef: scanWorkerORef(t, run)})
	if err != nil {
		t.Fatal(err)
	}
	if rtn.RunId != run.ID || rtn.ChannelId != other.OID || rtn.Scan == nil || rtn.Scan.State != waveobj.WorkflowScanState_Scanning {
		t.Fatalf("want the tab's scan run %s, got %+v", run.ID, rtn)
	}
}
