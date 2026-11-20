// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
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
	prevRunning, prevDeliver, prevNow := shellRunning, deliverNotice, now
	shellRunning = func(blockId string) bool { return f.running[blockId] && armed(t, blockId) }
	deliverNotice = func(blockId, text string) { f.delivered = append(f.delivered, delivery{blockId, text}) }
	now = func() time.Time { return f.now }
	t.Cleanup(func() { shellRunning, deliverNotice, now = prevRunning, prevDeliver, prevNow })
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
	if !tabExists(t, workerTab) {
		t.Error("the stopped worker's tab is gone")
	}
	if blockMeta(t, workerBlock).GetBool(MetaNoticeOwed, false) {
		t.Error("the delivered notice is still owed")
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

func TestNoticeForAClosedParentIsDropped(t *testing.T) {
	f := fakeLife(t)
	_, workerBlock := f.agent(t, uuid.NewString(), true)

	f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)

	if len(f.delivered) != 0 {
		t.Errorf("delivered %+v for a parent whose tab is gone", f.delivered)
	}
	meta := blockMeta(t, workerBlock)
	if meta.GetBool(MetaNoticeHeld, false) || meta.GetBool(MetaNoticeOwed, false) {
		t.Errorf("a dropped notice left owed=%v held=%v", meta.GetBool(MetaNoticeOwed, false), meta.GetBool(MetaNoticeHeld, false))
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
	f.reportAt(t, fiveBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop, f.now.Add(-5*time.Minute))
	f.reportAt(t, fourBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop, f.now.Add(-4*time.Minute))

	sweepIdle(context.Background())

	if armed(t, fiveBlock) {
		t.Error("a worker idle 5 minutes with nothing owed is still armed")
	}
	if !armed(t, fourBlock) {
		t.Error("a worker idle 4 minutes was stopped")
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
