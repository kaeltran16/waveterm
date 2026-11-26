// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// closeTab closes a tab as the user or an agent's /exit does: its blocks' processes end and the tab leaves its
// workspace and the store.
func (f *lifeFakes) closeTab(t *testing.T, tabId string) {
	t.Helper()
	ctx := context.Background()
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		t.Fatal(err)
	}
	for _, blockId := range tab.BlockIds {
		f.running[blockId] = false
	}
	ws := &waveobj.Workspace{OID: uuid.NewString(), TabIds: []string{tabId}}
	if err := wstore.DBInsert(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if _, err := wcore.DeleteTab(ctx, ws.OID, tabId, false); err != nil {
		t.Fatal(err)
	}
}

// orphanMark is the raise time and answer a worker's tab carries, and whether it carries the mark at all.
func orphanMark(t *testing.T, tabId string) (raised int64, answer string, marked bool) {
	t.Helper()
	tab, err := wstore.DBMustGet[*waveobj.Tab](context.Background(), tabId)
	if err != nil {
		t.Fatal(err)
	}
	return int64(tab.Meta.GetFloat(jarvis.MetaWorkerOrphaned, 0)), tab.Meta.GetString(jarvis.MetaWorkerOrphanAnswer, ""),
		tab.Meta.HasKey(jarvis.MetaWorkerOrphaned)
}

func TestOrphanFinishesItsTurnThenRaisesItsAnswerAndStops(t *testing.T) {
	tests := []struct {
		name, answer, want string
		// earlier is an answer an earlier turn wrote, "" for none
		earlier string
	}{
		{"the answer's first line, whitespace collapsed", "Fixed  the\ttoken refresh\nDetails follow.", "Fixed the token refresh", ""},
		{"a long line cut to the ask row's bound", strings.Repeat("é", 150), strings.Repeat("é", 140) + "…", ""},
		{"a turn that wrote no answer", "", "", ""},
		{"a turn that wrote no answer after one that did", "", "", "Earlier turn's answer"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := fakeLife(t)
			parentTab, _ := f.agent(t, "", false)
			workerTab, workerBlock := f.agent(t, parentTab, true)
			transcript := workerTranscript(t, workerBlock)
			if tt.earlier != "" {
				appendAnswerText(t, transcript, f.now.Add(-time.Minute), tt.earlier)
			}

			f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
			f.closeTab(t, parentTab)
			if _, _, marked := orphanMark(t, workerTab); marked || !armed(t, workerBlock) {
				t.Fatalf("marked %v, armed %v mid-turn: want the turn left to finish", marked, armed(t, workerBlock))
			}

			if tt.answer != "" {
				appendAnswerText(t, transcript, f.now, tt.answer)
			}
			f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)

			raised, answer, marked := orphanMark(t, workerTab)
			if !marked || raised != f.now.UnixMilli() || answer != tt.want {
				t.Errorf("mark %v at %d answer %q, want raised at %d with %q", marked, raised, answer, f.now.UnixMilli(), tt.want)
			}
			if len(f.delivered) != 0 {
				t.Errorf("delivered %+v for a parent whose tab is gone", f.delivered)
			}
			if armed(t, workerBlock) {
				t.Error("the orphan is still armed after its turn")
			}
		})
	}
}

func TestParentGoneRaisesAnIdleWorkerItOwesAtOnce(t *testing.T) {
	tests := []struct {
		name string
		// idle readies the worker's state before its parent goes
		idle      func(t *testing.T, f *lifeFakes, parentBlock, workerBlock string)
		wantArmed bool
	}{
		{"idle with its notice owed", func(t *testing.T, f *lifeFakes, _, workerBlock string) {
			f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
		}, false},
		{"idle with its notice held", func(t *testing.T, f *lifeFakes, parentBlock, workerBlock string) {
			f.running[parentBlock] = false
			f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
			f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
		}, false},
		{"held, running a turn the user typed", func(t *testing.T, f *lifeFakes, parentBlock, workerBlock string) {
			f.running[parentBlock] = false
			f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
			f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
			f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
		}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := fakeLife(t)
			parentTab, parentBlock := f.agent(t, "", false)
			workerTab, workerBlock := f.agent(t, parentTab, true)
			tt.idle(t, f, parentBlock, workerBlock)
			f.now = f.now.Add(time.Minute)

			f.closeTab(t, parentTab)

			if raised, _, marked := orphanMark(t, workerTab); !marked || raised != f.now.UnixMilli() {
				t.Errorf("mark %v at %d, want raised at %d", marked, raised, f.now.UnixMilli())
			}
			if blockMeta(t, workerBlock).GetBool(MetaNoticeHeld, false) {
				t.Error("the raised notice is still held")
			}
			if armed(t, workerBlock) != tt.wantArmed {
				t.Errorf("armed %v, want %v", armed(t, workerBlock), tt.wantArmed)
			}
			if len(f.delivered) != 0 {
				t.Errorf("delivered %+v", f.delivered)
			}
		})
	}
}

// a held notice raises at the close, after its turn settled, so the raise reads the answer bound from that turn
func TestHeldNoticeRaisedAtTheCloseShowsOnlyItsTurnsAnswer(t *testing.T) {
	tests := []struct{ name, answer, want string }{
		{"its turn's answer", "Migrated the schema", "Migrated the schema"},
		{"its turn wrote none after one that did", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := fakeLife(t)
			parentTab, parentBlock := f.agent(t, "", false)
			workerTab, workerBlock := f.agent(t, parentTab, true)
			transcript := workerTranscript(t, workerBlock)
			appendAnswerText(t, transcript, f.now.Add(-time.Minute), "Earlier turn's answer")
			f.running[parentBlock] = false
			f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
			if tt.answer != "" {
				appendAnswerText(t, transcript, f.now, tt.answer)
			}
			f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
			f.now = f.now.Add(time.Minute)

			f.closeTab(t, parentTab)

			if _, answer, marked := orphanMark(t, workerTab); !marked || answer != tt.want {
				t.Errorf("mark %v answer %q, want raised with %q", marked, answer, tt.want)
			}
		})
	}
}

func TestParentGoneLeavesAWorkerItOwesNothing(t *testing.T) {
	tests := []struct {
		name string
		owed bool
		// after runs once the parent is gone
		after     func(t *testing.T, f *lifeFakes, workerBlock string)
		wantArmed bool
	}{
		{"on a turn the user typed", false, func(t *testing.T, f *lifeFakes, workerBlock string) {
			f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
		}, true},
		{"already notified and stopped", true, func(*testing.T, *lifeFakes, string) {}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := fakeLife(t)
			parentTab, _ := f.agent(t, "", false)
			workerTab, workerBlock := f.agent(t, parentTab, tt.owed)
			f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
			if tt.owed {
				f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
			}

			f.closeTab(t, parentTab)
			tt.after(t, f, workerBlock)

			if _, _, marked := orphanMark(t, workerTab); marked {
				t.Error("a worker that owed its parent nothing was marked orphaned")
			}
			if armed(t, workerBlock) != tt.wantArmed {
				t.Errorf("armed %v, want %v", armed(t, workerBlock), tt.wantArmed)
			}
		})
	}
}

// a worker's tab outlives its process, so its own workers wait for its next run
func TestNoticeForAStoppedWorkerParentIsHeldNotOrphaned(t *testing.T) {
	f := fakeLife(t)
	topTab, _ := f.agent(t, "", false)
	midTab, _ := f.agent(t, topTab, false)
	childTab, childBlock := f.agent(t, midTab, true)
	if err := StopWorker(context.Background(), midTab); err != nil {
		t.Fatal(err)
	}

	f.report(t, childBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, childBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)

	if !blockMeta(t, childBlock).GetBool(MetaNoticeHeld, false) {
		t.Error("the notice for a stopped worker parent is not held")
	}
	if _, _, marked := orphanMark(t, childTab); marked {
		t.Error("a worker whose parent's tab remains was marked orphaned")
	}
}

func TestOrphanWithARunningWorkerRaisesOnceNoneRuns(t *testing.T) {
	f := fakeLife(t)
	parentTab, _ := f.agent(t, "", false)
	midTab, midBlock := f.agent(t, parentTab, true)
	childTab, childBlock := f.agent(t, midTab, true)
	f.report(t, midBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, midBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)

	f.closeTab(t, parentTab)
	if _, _, marked := orphanMark(t, midTab); marked || !armed(t, midBlock) {
		t.Fatalf("marked %v, armed %v with its worker running: want it left to answer that worker", marked, armed(t, midBlock))
	}

	f.report(t, childBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, childBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
	if len(f.deliveredTo(midBlock)) != 1 || len(f.delivered) != 1 {
		t.Fatalf("delivered %+v, want the child's notice to the orphan, which is alive", f.delivered)
	}
	if _, _, marked := orphanMark(t, childTab); marked {
		t.Error("the child of a live orphan was marked orphaned")
	}

	f.report(t, midBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, midBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
	if _, _, marked := orphanMark(t, midTab); !marked || armed(t, midBlock) {
		t.Errorf("marked %v, armed %v after the notice turn: want raised and stopped", marked, armed(t, midBlock))
	}
}

func TestOrphanStandingByOnABackgroundTaskRaisesWhenItsFinishTurnSettles(t *testing.T) {
	f := fakeLife(t)
	parentTab, _ := f.agent(t, "", false)
	workerTab, workerBlock := f.agent(t, parentTab, true)
	transcript := workerTranscript(t, workerBlock)
	appendShellTask(t, transcript, "b1")
	appendAnswer(t, transcript, f.now)
	f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)
	f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)

	f.closeTab(t, parentTab)
	if _, _, marked := orphanMark(t, workerTab); marked || !armed(t, workerBlock) {
		t.Fatalf("marked %v, armed %v with its background task running", marked, armed(t, workerBlock))
	}

	f.now = f.now.Add(time.Minute)
	appendShellTaskEnd(t, transcript, "b1")
	appendAnswerText(t, transcript, f.now, "Tests pass")
	f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)
	if _, answer, marked := orphanMark(t, workerTab); !marked || answer != "Tests pass" || armed(t, workerBlock) {
		t.Errorf("marked %v answer %q armed %v, want raised with the finish turn's answer and stopped", marked, answer, armed(t, workerBlock))
	}
}

// a settle can land after the tab-close hook ran but before the tab left the store, with the parent's process
// already ended, which alone would hold the notice for a tab about to vanish
func TestSettleBetweenTheCloseHookAndTheDeleteTreatsTheParentAsGone(t *testing.T) {
	f := fakeLife(t)
	parentTab, parentBlock := f.agent(t, "", false)
	workerTab, workerBlock := f.agent(t, parentTab, true)
	f.report(t, workerBlock, baseds.AgentState_Working, baseds.AgentHook_UserPromptSubmit)

	f.running[parentBlock] = false
	wcore.AgentTabCloseHook(context.Background(), parentTab)
	f.report(t, workerBlock, baseds.AgentState_Idle, baseds.AgentHook_Stop)

	if _, _, marked := orphanMark(t, workerTab); !marked {
		t.Error("the worker of a closing parent was not marked orphaned")
	}
	if blockMeta(t, workerBlock).GetBool(MetaNoticeHeld, false) {
		t.Error("the notice was held for a parent whose tab is closing")
	}
}
