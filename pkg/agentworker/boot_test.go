// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentmsg"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

func TestResumeWorkersAtBoot(t *testing.T) {
	// the worker went idle at its transcript's last write, long before this boot
	idleAt := time.Now().Add(-72 * time.Hour).Truncate(time.Millisecond)
	// every transcript holds an earlier turn's answer, then the parent's message that opened the owed turn
	earlierAt, openedAt := idleAt.Add(-2*time.Minute), idleAt.Add(-time.Minute)
	cases := []struct {
		name       string
		notWorker  bool
		armed      bool
		owed       bool
		gateRefuse bool
		parentGone bool
		answer     string // the owed turn's answer, "" for none
		wantStart  bool
		wantArmed  bool
		wantStatus string // "" when nothing is published
		wantMark   bool
		wantAnswer string
	}{
		{name: "mid-task worker resumes with the nudge", armed: true, owed: true, wantStart: true, wantArmed: true, wantStatus: baseds.AgentState_Working},
		{name: "armed worker with no notice owed is disarmed", armed: true, wantStatus: baseds.AgentState_Idle},
		{name: "stopped worker stays stopped", owed: true, wantStatus: baseds.AgentState_Idle},
		{name: "refused resume leaves it disarmed", armed: true, owed: true, gateRefuse: true, answer: "Fixed the refresh", wantStatus: baseds.AgentState_Idle},
		{name: "a tab no agent started is left alone", notWorker: true, armed: true, owed: true, wantArmed: true},
		{name: "refused resume with its parent gone raises its answer", armed: true, owed: true, gateRefuse: true, parentGone: true,
			answer: "Fixed  the refresh\nDetails follow.", wantStatus: baseds.AgentState_Idle, wantMark: true, wantAnswer: "Fixed the refresh"},
		{name: "stopped worker with its parent gone raises no earlier turn's answer", owed: true, parentGone: true,
			wantStatus: baseds.AgentState_Idle, wantMark: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			setFree := isolateGate(t)
			if c.gateRefuse {
				// an empty book always admits, so another claim holds the memory
				held, ok := memgate.TryAdmit(memgate.Request{Tag: memgate.Tag{RunId: "run-1", TaskId: "t-2", Role: memgate.RoleWorker}})
				if !ok {
					t.Fatal("an empty book must admit")
				}
				t.Cleanup(held.Release)
				setFree(1 << 30)
			}
			starts := stubStart(t, nil)
			cwd := t.TempDir()
			transcript := filepath.Join(cwd, "sess-1.jsonl")
			appendAnswerText(t, transcript, earlierAt, "An earlier turn's answer")
			appendLine(t, transcript, fmt.Sprintf(`{"type":"user","timestamp":%q,"message":{"role":"user","content":%q}}`,
				openedAt.UTC().Format(time.RFC3339Nano), agentmsg.Envelope("lead", "parent-tab", "fix the refresh")))
			if c.answer != "" {
				appendAnswerText(t, transcript, idleAt, c.answer)
			}
			if err := os.Chtimes(transcript, idleAt, idleAt); err != nil {
				t.Fatal(err)
			}
			tabMeta := waveobj.MetaMapType{"session:agent": "claude"}
			if !c.notWorker {
				parentTab := uuid.NewString()
				if !c.parentGone {
					parentTab, _ = seedWorker(t, waveobj.MetaMapType{}, waveobj.MetaMapType{})
				}
				tabMeta[MetaParentTab] = parentTab
			}
			controller := ""
			if c.armed {
				controller = blockcontroller.BlockController_Cmd
			}
			tabId, blockId := seedWorker(t, tabMeta, waveobj.MetaMapType{
				waveobj.MetaKey_Controller:          controller,
				waveobj.MetaKey_CmdCwd:              cwd,
				waveobj.MetaKey_AgentTranscriptPath: transcript,
				waveobj.MetaKey_CmdArgs:             []string{"--session-id", "sess-1", "--model", "opus", "the task"},
				MetaSessionId:                       "sess-1",
				"agent:baseargs":                    []string{"--model", "opus"},
				MetaNoticeOwed:                      c.owed,
			})
			// the pass also resumes workers other tests left armed in the shared store; release every claim it bound
			t.Cleanup(func() {
				for _, s := range *starts {
					memgate.ReleaseOwner(jobobject.Owner{Kind: jobobject.OwnerKind_Block, Id: s.blockId})
				}
			})

			ResumeWorkersAtBoot(context.Background())

			var mine []startCall
			for _, s := range *starts {
				if s.tabId == tabId {
					mine = append(mine, s)
				}
			}
			if started := len(mine) == 1; started != c.wantStart || len(mine) > 1 {
				t.Fatalf("starts of this worker = %+v, want started %v", mine, c.wantStart)
			}
			meta := blockMeta(t, blockId)
			if got := meta.GetString(waveobj.MetaKey_Controller, "") != ""; got != c.wantArmed {
				t.Errorf("armed = %v, want %v", got, c.wantArmed)
			}
			if c.wantStart {
				wantArgs := []string{"--resume", "sess-1", "--model", "opus", jarvis.ResumeNudge}
				if got := meta.GetStringList(waveobj.MetaKey_CmdArgs); !slices.Equal(got, wantArgs) {
					t.Errorf("args = %q, want %q", got, wantArgs)
				}
			}
			if got, want := meta.GetBool(MetaNoticeOwed, false), c.owed && !c.wantMark; got != want {
				t.Errorf("notice owed = %v, want %v", got, want)
			}
			if _, answer, marked := orphanMark(t, tabId); marked != c.wantMark || answer != c.wantAnswer {
				t.Errorf("orphan mark %v answer %q, want %v answer %q", marked, answer, c.wantMark, c.wantAnswer)
			}
			oref := waveobj.MakeORef(waveobj.OType_Block, blockId).String()
			events := wps.Broker.ReadEventHistory(wps.Event_AgentStatus, oref, 1)
			if c.wantStatus == "" {
				if len(events) != 0 {
					t.Errorf("published %+v, want nothing", events)
				}
				return
			}
			if len(events) != 1 {
				t.Fatalf("retained statuses = %+v, want one %s", events, c.wantStatus)
			}
			data := events[0].Data.(baseds.AgentStatusData)
			if data.State != c.wantStatus || data.Cwd != cwd || data.TranscriptPath != transcript {
				t.Errorf("status = %s cwd %q transcript %q, want %s cwd %q transcript %q", data.State, data.Cwd, data.TranscriptPath, c.wantStatus, cwd, transcript)
			}
			if c.wantStatus == baseds.AgentState_Idle && data.Ts != idleAt.UnixMilli() {
				t.Errorf("stopped worker published as of %v, want its transcript's last write %v", time.UnixMilli(data.Ts), idleAt)
			}
		})
	}
}
