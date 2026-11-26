// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentmsg"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

type delivery struct{ blockId, text string }

// lifeFakes stands in for the processes: a block's shell runs while the test says so and its block is armed, so a
// stop the code makes reads as a stopped process.
type lifeFakes struct {
	running   map[string]bool
	delivered []delivery
	now       time.Time
}

func fakeLife(t *testing.T) *lifeFakes {
	t.Helper()
	f := &lifeFakes{running: map[string]bool{}, now: time.Now()}
	prevRunning, prevDeliver, prevNow, prevSleep, prevGo := shellRunning, deliverNotice, now, sleep, goSettle
	shellRunning = func(blockId string) bool { return f.running[blockId] && armed(t, blockId) }
	deliverNotice = func(blockId, text string) { f.delivered = append(f.delivered, delivery{blockId, text}) }
	now = func() time.Time { return f.now }
	sleep = func(d time.Duration) { f.now = f.now.Add(d) }
	goSettle = func(settle func()) { settle() }
	t.Cleanup(func() {
		shellRunning, deliverNotice, now, sleep, goSettle = prevRunning, prevDeliver, prevNow, prevSleep, prevGo
	})
	return f
}

func armed(t *testing.T, blockId string) bool {
	t.Helper()
	return blockMeta(t, blockId).GetString(waveobj.MetaKey_Controller, "") != ""
}

func blockMeta(t *testing.T, blockId string) waveobj.MetaMapType {
	t.Helper()
	b, err := wstore.DBMustGet[*waveobj.Block](context.Background(), blockId)
	if err != nil {
		t.Fatal(err)
	}
	return b.Meta
}

// agent seeds a running agent tab: a worker of parentTab, or a top-level agent when parentTab is "".
func (f *lifeFakes) agent(t *testing.T, parentTab string, owed bool) (tabId, blockId string) {
	t.Helper()
	tabMeta := waveobj.MetaMapType{metaTabHarness: "claude"}
	if parentTab != "" {
		tabMeta[MetaParentTab] = parentTab
	}
	tabId, blockId = seedWorker(t, tabMeta, waveobj.MetaMapType{
		waveobj.MetaKey_Controller: blockcontroller.BlockController_Cmd,
		MetaNoticeOwed:             owed,
	})
	f.running[blockId] = true
	return tabId, blockId
}

// report publishes a status and hands it to NoteStatus, as publishEvent does.
func (f *lifeFakes) report(t *testing.T, blockId, state, hook string) {
	t.Helper()
	f.reportAt(t, blockId, state, hook, f.now)
}

func (f *lifeFakes) reportAt(t *testing.T, blockId, state, hook string, at time.Time) {
	t.Helper()
	ev := blockcontroller.AgentStatusEvent(blockId, state, "claude", at.UnixMilli())
	data := ev.Data.(baseds.AgentStatusData)
	data.Hook = hook
	ev.Data = data
	wps.Broker.Publish(ev)
	NoteStatus(context.Background(), &data)
}

func (f *lifeFakes) deliveredTo(blockId string) []string {
	var out []string
	for _, d := range f.delivered {
		if d.blockId == blockId {
			out = append(out, d.text)
		}
	}
	return out
}

func tabExists(t *testing.T, tabId string) bool {
	t.Helper()
	tab, err := wstore.DBGet[*waveobj.Tab](context.Background(), tabId)
	if err != nil {
		t.Fatal(err)
	}
	return tab != nil
}

func TestIdleWorkerNotifiesItsRunningParentOnceThenStops(t *testing.T) {
	f := fakeLife(t)
	updates := recordBlockUpdates(t)
	parentTab, parentBlock := f.agent(t, "", false)
	workerTab, workerBlock := f.agent(t, parentTab, true)

	f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)

	got := f.deliveredTo(parentBlock)
	if len(got) != 1 || len(f.delivered) != 1 {
		t.Fatalf("delivered %+v, want exactly one notice to the parent's block", f.delivered)
	}
	if !agentmsg.IsAgentMessage(got[0]) || !strings.Contains(got[0], workerTab) {
		t.Errorf("notice %q is not an agent message naming the worker's tab", got[0])
	}
	if armed(t, workerBlock) {
		t.Error("the notified worker is still armed")
	}
	if c, heard := updates.controller(workerBlock); !heard || c != "" {
		t.Errorf("the frontend last heard controller %q (heard %v), want the stop broadcast", c, heard)
	}
	if !tabExists(t, workerTab) {
		t.Error("the stopped worker's tab is gone")
	}
	if blockMeta(t, workerBlock).GetBool(MetaNoticeOwed, false) {
		t.Error("the delivered notice is still owed")
	}
}

// appendAnswer writes a claude answer recorded at `at` to the transcript.
func appendAnswer(t *testing.T, path string, at time.Time) {
	t.Helper()
	appendAnswerText(t, path, at, "PONG")
}

func appendAnswerText(t *testing.T, path string, at time.Time, text string) {
	t.Helper()
	appendLine(t, path, fmt.Sprintf(`{"type":"assistant","timestamp":%q,"message":{"role":"assistant","content":[{"type":"text","text":%q}]}}`,
		at.UTC().Format(time.RFC3339Nano), text))
}

// appendShellTask writes the start of a claude background shell task, and appendShellTaskEnd its finish notification.
func appendShellTask(t *testing.T, path, taskId string) {
	t.Helper()
	appendLine(t, path, fmt.Sprintf(`{"type":"user","toolUseResult":{"backgroundTaskId":%q},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu"}]}}`, taskId))
}

func appendShellTaskEnd(t *testing.T, path, taskId string) {
	t.Helper()
	appendLine(t, path, fmt.Sprintf(`{"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>%s</task-id><status>completed</status></task-notification>"}`, taskId))
}

func appendLine(t *testing.T, path, line string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(line + "\n"); err != nil {
		t.Fatal(err)
	}
}

// workerTranscript gives a worker block a transcript file, as its hooks report one.
func workerTranscript(t *testing.T, blockId string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "worker.jsonl")
	if err := setBlockMeta(context.Background(), blockId, waveobj.MetaKey_AgentTranscriptPath, path); err != nil {
		t.Fatal(err)
	}
	return path
}

// blockUpdates records the blocks the store broadcasts to the frontend.
type blockUpdates struct {
	mu     sync.Mutex
	blocks map[string]*waveobj.Block
}

func (r *blockUpdates) SendEvent(_ string, ev wps.WaveEvent) {
	u, ok := ev.Data.(waveobj.WaveObjUpdate)
	if !ok {
		return
	}
	if b, ok := u.Obj.(*waveobj.Block); ok {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.blocks[b.OID] = b
	}
}

// controller is the block controller the frontend last heard for the block, and false when it heard nothing.
func (r *blockUpdates) controller(blockId string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.blocks[blockId]
	if !ok {
		return "", false
	}
	return b.Meta.GetString(waveobj.MetaKey_Controller, ""), true
}

func recordBlockUpdates(t *testing.T) *blockUpdates {
	t.Helper()
	const route = "agentworker-test"
	rec := &blockUpdates{blocks: map[string]*waveobj.Block{}}
	prev := wps.Broker.GetClient()
	wps.Broker.SetClient(rec)
	wps.Broker.Subscribe(route, wps.SubscriptionRequest{Event: wps.Event_WaveObjUpdate, AllScopes: true})
	t.Cleanup(func() {
		wps.Broker.UnsubscribeAll(route)
		wps.Broker.SetClient(prev)
	})
	return rec
}

// a stop kills the worker's background tasks, so a worker whose turn ended waiting on one is not settled until the
// turn its finish opens ends, whether or not that turn reports working
func TestWorkerStandingByOnABackgroundTaskSettlesAfterTheTurnItsFinishOpens(t *testing.T) {
	for _, reportsWorking := range []bool{true, false} {
		t.Run(fmt.Sprintf("the finish's turn reports working: %v", reportsWorking), func(t *testing.T) {
			f := fakeLife(t)
			parentTab, parentBlock := f.agent(t, "", false)
			workerTab, workerBlock := f.agent(t, parentTab, true)
			transcript := workerTranscript(t, workerBlock)
			appendShellTask(t, transcript, "b1")
			appendAnswer(t, transcript, f.now)

			f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
			f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
			if len(f.delivered) != 0 || !armed(t, workerBlock) {
				t.Fatalf("delivered %+v, armed %v: want a worker whose background task runs left running", f.delivered, armed(t, workerBlock))
			}

			f.now = f.now.Add(time.Minute)
			appendShellTaskEnd(t, transcript, "b1")
			appendAnswer(t, transcript, f.now)
			if reportsWorking {
				f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
			}
			f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
			if got := f.deliveredTo(parentBlock); len(got) != 1 || !strings.Contains(got[0], workerTab) || armed(t, workerBlock) {
				t.Fatalf("delivered %+v, armed %v: want the notice once and the worker stopped", f.delivered, armed(t, workerBlock))
			}
		})
	}
}

// claude writes the answer after its Stop hooks run, so the notice and the stop wait until the transcript holds it
func TestNoticeWaitsForTheTurnsAnswerInTheTranscript(t *testing.T) {
	tests := []struct {
		name string
		// earlier: the transcript already holds an answer from before the turn
		earlier bool
		// landsAfter: the polls before the turn's answer is written, -1 for never
		landsAfter int
	}{
		{"the answer lands after the stop hook", false, 3},
		{"an earlier turn's answer is not this turn's", true, 3},
		{"no answer ever lands", false, -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := fakeLife(t)
			parentTab, parentBlock := f.agent(t, "", false)
			_, workerBlock := f.agent(t, parentTab, true)
			transcript := filepath.Join(t.TempDir(), "worker.jsonl")
			if err := setBlockMeta(context.Background(), workerBlock, waveobj.MetaKey_AgentTranscriptPath, transcript); err != nil {
				t.Fatal(err)
			}
			if tt.earlier {
				appendAnswer(t, transcript, f.now.Add(-time.Minute))
			}
			polls := 0
			sleep = func(d time.Duration) {
				if len(f.delivered) != 0 {
					t.Fatal("notified before the turn's answer was written")
				}
				f.now = f.now.Add(d)
				if polls++; polls == tt.landsAfter {
					appendAnswer(t, transcript, f.now)
				}
			}
			start := f.now

			f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
			f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)

			if len(f.deliveredTo(parentBlock)) != 1 || armed(t, workerBlock) {
				t.Fatalf("delivered %+v, armed %v: want one notice and a stopped worker", f.delivered, armed(t, workerBlock))
			}
			if tt.landsAfter > 0 && polls != tt.landsAfter {
				t.Errorf("polled %d times, want to stop polling once the answer landed after %d", polls, tt.landsAfter)
			}
			if tt.landsAfter < 0 && f.now.Sub(start) < answerWait {
				t.Errorf("notified after %v with no answer, want the full %v wait", f.now.Sub(start), answerWait)
			}
		})
	}
}

func TestTurnsThatOweNoNoticeDeliverNothing(t *testing.T) {
	type status struct{ state, hook string }
	tests := []struct {
		name     string
		owed     bool
		statuses []status
	}{
		{"a turn the user typed", false, []status{{baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit}, {baseds.AgentState_Idle, baseds.AgentHook_Stop}}},
		{"an asking worker", true, []status{{baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit}, {baseds.AgentState_Asking, ""}}},
		// claude reports its launch's SessionStart, and pi its session_start, as idle before the first turn opens
		{"the launch's idle before the first turn", true, []status{{baseds.AgentState_Idle, baseds.AgentHook_SessionStart}, {baseds.AgentState_Idle, ""}}},
		{"a mid-turn compaction's session start", true, []status{{baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit}, {baseds.AgentState_Idle, baseds.AgentHook_SessionStart}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := fakeLife(t)
			parentTab, _ := f.agent(t, "", false)
			_, workerBlock := f.agent(t, parentTab, tt.owed)
			for _, s := range tt.statuses {
				f.report(t, workerBlock, s.state, s.hook)
			}
			if len(f.delivered) != 0 {
				t.Errorf("delivered %+v, want nothing", f.delivered)
			}
			if !armed(t, workerBlock) {
				t.Error("the worker was stopped")
			}
		})
	}
}

func TestNoticeHeldForAParentWithNoProcessIsDeliveredOnceWhenItRuns(t *testing.T) {
	f := fakeLife(t)
	parentTab, parentBlock := f.agent(t, "", false)
	f.running[parentBlock] = false
	workerTab, workerBlock := f.agent(t, parentTab, true)

	f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
	if len(f.delivered) != 0 {
		t.Fatalf("delivered %+v to a parent with no process", f.delivered)
	}
	if !blockMeta(t, workerBlock).GetBool(MetaNoticeHeld, false) {
		t.Fatal("the notice is not held")
	}

	f.running[parentBlock] = true
	f.report(t, parentBlock, baseds.AgentState_Idle, baseds.AgentHook_SessionStart)
	f.report(t, parentBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)

	got := f.deliveredTo(parentBlock)
	if len(got) != 1 || !strings.Contains(got[0], workerTab) {
		t.Fatalf("delivered %+v, want the held notice once", f.delivered)
	}
	if blockMeta(t, workerBlock).GetBool(MetaNoticeHeld, false) {
		t.Error("the delivered notice is still held")
	}
	if armed(t, workerBlock) {
		t.Error("the worker is still armed after its held notice went out")
	}
}

func TestWorkerWithARunningWorkerNotifiesAfterTheChildsNoticeTurn(t *testing.T) {
	f := fakeLife(t)
	parentTab, parentBlock := f.agent(t, "", false)
	midTab, midBlock := f.agent(t, parentTab, true)
	_, childBlock := f.agent(t, midTab, true)

	f.report(t, midBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, midBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
	if len(f.delivered) != 0 || !armed(t, midBlock) {
		t.Fatalf("a worker with a running worker of its own notified (%+v) or stopped", f.delivered)
	}

	f.report(t, childBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, childBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
	if len(f.deliveredTo(midBlock)) != 1 || len(f.deliveredTo(parentBlock)) != 0 {
		t.Fatalf("delivered %+v, want only the child's notice, to its parent", f.delivered)
	}
	if !armed(t, midBlock) {
		t.Fatal("the worker was stopped with its child's notice still to answer")
	}

	f.report(t, midBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, midBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
	if got := f.deliveredTo(parentBlock); len(got) != 1 || !strings.Contains(got[0], midTab) {
		t.Fatalf("delivered %+v, want the worker's own notice once its child had stopped", f.delivered)
	}
	if armed(t, midBlock) {
		t.Error("the worker is still armed after its notice")
	}
}

func TestWorkerNotifiesWhenItsLastRunningWorkerStopsWithoutANotice(t *testing.T) {
	f := fakeLife(t)
	parentTab, parentBlock := f.agent(t, "", false)
	midTab, midBlock := f.agent(t, parentTab, true)
	childTab, _ := f.agent(t, midTab, false)

	f.report(t, midBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, midBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
	if err := StopWorker(context.Background(), childTab); err != nil {
		t.Fatal(err)
	}

	if got := f.deliveredTo(parentBlock); len(got) != 1 || !strings.Contains(got[0], midTab) {
		t.Fatalf("delivered %+v, want the idle worker's notice once its last worker stopped", f.delivered)
	}
	if armed(t, midBlock) {
		t.Error("the worker is still armed after its notice")
	}
}

func TestIdleSweepStopsAWorkerIdleFiveMinutes(t *testing.T) {
	f := fakeLife(t)
	parentTab, _ := f.agent(t, "", false)
	_, fiveBlock := f.agent(t, parentTab, false)
	_, fourBlock := f.agent(t, parentTab, false)
	_, taskBlock := f.agent(t, parentTab, false)
	appendShellTask(t, workerTranscript(t, taskBlock), "b1")
	f.reportAt(t, fiveBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop, f.now.Add(-5*time.Minute))
	f.reportAt(t, fourBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop, f.now.Add(-4*time.Minute))
	f.reportAt(t, taskBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop, f.now.Add(-5*time.Minute))

	sweepIdle(context.Background())

	if armed(t, fiveBlock) {
		t.Error("a worker idle 5 minutes with nothing owed is still armed")
	}
	if !armed(t, fourBlock) {
		t.Error("a worker idle 4 minutes was stopped")
	}
	if !armed(t, taskBlock) {
		t.Error("a worker idle 5 minutes with a background task running was stopped, killing the task")
	}
}

func TestWorkerExitingOnItsOwnEndsDisarmed(t *testing.T) {
	f := fakeLife(t)
	parentTab, _ := f.agent(t, "", false)
	workerTab, workerBlock := f.agent(t, parentTab, false)
	plainTab, plainBlock := f.agent(t, "", false)

	jarvis.AgentExitHook(context.Background(), workerTab, workerBlock)
	jarvis.AgentExitHook(context.Background(), plainTab, plainBlock)

	if armed(t, workerBlock) {
		t.Error("a worker whose process exited is still armed, so a remount would replay its first prompt")
	}
	if !armed(t, plainBlock) {
		t.Error("an agent tab that is not a worker was disarmed")
	}
}
