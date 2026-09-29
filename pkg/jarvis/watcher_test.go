// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func singleSelect(nOptions int) []baseds.AgentAskQuestion {
	opts := make([]baseds.AgentAskOption, nOptions)
	for i := range opts {
		opts[i] = baseds.AgentAskOption{Label: "opt"}
	}
	return []baseds.AgentAskQuestion{{Question: "q", Options: opts}}
}

// seedGatekeeperChannel creates a gatekeeper-enabled channel with a dispatched concierge worker tab
// (dispatch post stamps the worker's channeloref), so ResolveAskOwner resolves handleAsk's ask.
func seedGatekeeperChannel(t *testing.T, ctx context.Context, task string) (*waveobj.Channel, string) {
	t.Helper()
	ch, err := wstore.CreateChannel(ctx, "gk-delivery", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if _, err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Channel, ch.OID),
		waveobj.MetaMapType{MetaKey_GatekeeperEnabled: true}, false); err != nil {
		t.Fatalf("enable gatekeeper: %v", err)
	}
	workerTabOID := uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: workerTabOID, Name: "w", Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker tab: %v", err)
	}
	worker := waveobj.MakeORef(waveobj.OType_Tab, workerTabOID).String()
	dm := wstore.NewChannelMessage("dispatch", "claude", task, worker, 10)
	if _, err := wstore.PostChannelMessage(ctx, ch.OID, dm); err != nil {
		t.Fatalf("post dispatch: %v", err)
	}
	return ch, worker
}

func channelMessages(t *testing.T, ctx context.Context, channelId string) []*waveobj.ChannelMessage {
	t.Helper()
	msgs, err := wstore.GetChannelMessages(ctx, channelId, 0, 0)
	if err != nil {
		t.Fatalf("get messages: %v", err)
	}
	return msgs
}

const routineReply = `{"action":"answer","answers":[{"selectedindexes":[0]}],"reason":"routine"}`

// stubClassifierReply pins the classifier seam to a fixed model reply.
func stubClassifierReply(t *testing.T, reply string) {
	t.Helper()
	oldRun := runFn
	runFn = func(_ context.Context, _ consult.RuntimeSpec, _ string, _ string, _ func(string)) (string, error) {
		return reply, nil
	}
	t.Cleanup(func() { runFn = oldRun })
}

// stubClassifier pins the classifier seam to a routine auto-answer so delivery behavior is the only
// variable under test.
func stubClassifier(t *testing.T) {
	t.Helper()
	stubClassifierReply(t, routineReply)
}

// Guards J1: when the classifier answers but DeliverAnswer fails or reports not-delivered, the ask
// must escalate into the channel trail — never vanish silently.
func TestHandleAsk_DeliveryFailureEscalates(t *testing.T) {
	ctx := context.Background()
	origDeliver := deliverFn
	defer func() { deliverFn = origDeliver }()

	cases := []struct {
		name      string
		delivered bool
		derr      error
	}{
		{"delivery error", false, fmt.Errorf("actuator gone")},
		{"not delivered (raced clear)", false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ch, workerORef := seedGatekeeperChannel(t, ctx, "task")
			stubClassifier(t)
			deliverFn = func(string, string, []baseds.AgentAnswerItem) (bool, error) {
				return tc.delivered, tc.derr
			}
			data := baseds.AgentAskData{
				ORef:  workerORef,
				AskId: uuid.NewString(),
				Questions: []baseds.AgentAskQuestion{
					{Question: "ship?", Options: []baseds.AgentAskOption{{Label: "yes"}, {Label: "no"}}},
				},
			}
			handleAsk(ctx, data)
			msgs := channelMessages(t, ctx, ch.OID)
			if len(msgs) == 0 || msgs[len(msgs)-1].Kind != "jarvis-escalation" {
				t.Fatalf("want escalation posted, got %+v", msgs)
			}
			if !strings.Contains(msgs[len(msgs)-1].Text, "answer delivery failed") {
				t.Fatalf("escalation should name the failure: %q", msgs[len(msgs)-1].Text)
			}
		})
	}
}

// The success path still posts the answered card.
func TestHandleAsk_DeliverySuccessPostsAnswered(t *testing.T) {
	ctx := context.Background()
	origDeliver := deliverFn
	defer func() { deliverFn = origDeliver }()
	ch, workerORef := seedGatekeeperChannel(t, ctx, "task")
	stubClassifier(t)
	deliverFn = func(string, string, []baseds.AgentAnswerItem) (bool, error) {
		return true, nil
	}
	handleAsk(ctx, baseds.AgentAskData{
		ORef:  workerORef,
		AskId: uuid.NewString(),
		Questions: []baseds.AgentAskQuestion{
			{Question: "ship?", Options: []baseds.AgentAskOption{{Label: "yes"}, {Label: "no"}}},
		},
	})
	msgs := channelMessages(t, ctx, ch.OID)
	if len(msgs) == 0 || msgs[len(msgs)-1].Kind != "jarvis-answered" {
		t.Fatalf("want answered card, got %+v", msgs)
	}
}

// seedDagRunWorker files a worker tab under a run of a dag and returns the channel and the worker's
// block oref. A child worker belongs to a run the dag's lead spawned; otherwise it is the lead's own.
func seedDagRunWorker(t *testing.T, ctx context.Context, child bool) (*waveobj.Channel, string) {
	t.Helper()
	ch, err := wstore.CreateChannel(ctx, "gk-dag", t.TempDir())
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	tabId, blockId := uuid.NewString(), uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker tab: %v", err)
	}
	if err := wstore.DBInsert(ctx, &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker block: %v", err)
	}
	dagId := uuid.NewString()
	lead := NewRun("lead", "ws-1", ch.ProjectPath, nil, RunMode_Orchestrator, DefaultOrchestratorPlaybook(), 1)
	lead.ID, lead.DagORef = uuid.NewString(), dagId
	if err := wstore.AppendDag(ctx, &waveobj.TaskGroup{OID: dagId, ID: dagId, RunID: lead.ID, ChannelId: ch.OID, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed dag: %v", err)
	}
	runs := []waveobj.Run{lead}
	if child {
		task := NewRun("task", "ws-1", ch.ProjectPath, nil, RunMode_Quick, QuickPlaybook(), 1)
		task.ID, task.DagORef = uuid.NewString(), dagId
		runs = append(runs, task)
	}
	worker := &runs[len(runs)-1]
	worker.Phases[0].WorkerOrefs = []string{waveobj.MakeORef(waveobj.OType_Tab, tabId).String()}
	for _, r := range runs {
		if err := wstore.AppendRun(ctx, ch.OID, r); err != nil {
			t.Fatalf("append run: %v", err)
		}
	}
	return ch, waveobj.MakeORef(waveobj.OType_Block, blockId).String()
}

// A dag child's question waits in its lead's queue, so the Gatekeeper neither answers nor escalates it.
// The lead's own questions are still the Gatekeeper's to judge.
func TestHandleAskSkipsDagChildren(t *testing.T) {
	ctx := context.Background()
	origDeliver := deliverFn
	defer func() { deliverFn = origDeliver }()
	stubClassifier(t)
	cases := []struct {
		name        string
		child       bool
		wantHandled bool
	}{
		{"dag child", true, false},
		{"dag lead", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ch, blockORef := seedDagRunWorker(t, ctx, tc.child)
			delivered := 0
			deliverFn = func(string, string, []baseds.AgentAnswerItem) (bool, error) {
				delivered++
				return true, nil
			}
			handleAsk(ctx, baseds.AgentAskData{ORef: blockORef, AskId: uuid.NewString(), Questions: singleSelect(2)})
			// an answer posts an answered card and an escalation posts its own, so either leaves a message
			handled := delivered > 0 || len(channelMessages(t, ctx, ch.OID)) > 0
			if handled != tc.wantHandled {
				t.Fatalf("gatekeeper handled = %v, want %v", handled, tc.wantHandled)
			}
		})
	}
}

// seedQuickRunWorker files a quick run's worker under a channel with the given gatekeeper meta (nil
// leaves the flag unset) and returns the channel and the worker's block oref.
func seedQuickRunWorker(t *testing.T, ctx context.Context, meta waveobj.MetaMapType) (*waveobj.Channel, string) {
	t.Helper()
	ch, err := wstore.CreateChannel(ctx, "gk-tier", t.TempDir())
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if meta != nil {
		if _, err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Channel, ch.OID), meta, false); err != nil {
			t.Fatalf("set tier: %v", err)
		}
	}
	tabId, blockId := uuid.NewString(), uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Tab{OID: tabId, BlockIds: []string{blockId}, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker tab: %v", err)
	}
	if err := wstore.DBInsert(ctx, &waveobj.Block{OID: blockId, ParentORef: "tab:" + tabId, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed worker block: %v", err)
	}
	run := NewRun("quick", "ws-1", ch.ProjectPath, nil, RunMode_Quick, QuickPlaybook(), 1)
	run.ID = uuid.NewString()
	run.Phases[0].WorkerOrefs = []string{waveobj.MakeORef(waveobj.OType_Tab, tabId).String()}
	if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
		t.Fatalf("append run: %v", err)
	}
	return ch, waveobj.MakeORef(waveobj.OType_Block, blockId).String()
}

// The tier governs run workers too: a project set to concierge leaves a quick run's routine question
// for you (no classifier, no answer, no card), and a gatekeeper or never-configured project judges it.
func TestHandleAskHonoursTheTierForRunWorkers(t *testing.T) {
	ctx := context.Background()
	origDeliver := deliverFn
	defer func() { deliverFn = origDeliver }()
	cases := []struct {
		name        string
		meta        waveobj.MetaMapType
		wantHandled bool
	}{
		{"concierge", waveobj.MetaMapType{MetaKey_GatekeeperEnabled: false}, false},
		{"gatekeeper", waveobj.MetaMapType{MetaKey_GatekeeperEnabled: true}, true},
		{"never configured", nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			classified := 0
			oldRun := runFn
			runFn = func(_ context.Context, _ consult.RuntimeSpec, _ string, _ string, _ func(string)) (string, error) {
				classified++
				return routineReply, nil
			}
			t.Cleanup(func() { runFn = oldRun })
			delivered := 0
			deliverFn = func(string, string, []baseds.AgentAnswerItem) (bool, error) {
				delivered++
				return true, nil
			}
			ch, blockORef := seedQuickRunWorker(t, ctx, tc.meta)
			handleAsk(ctx, baseds.AgentAskData{ORef: blockORef, AskId: uuid.NewString(), Questions: singleSelect(2)})
			handled := classified > 0 || delivered > 0 || len(channelMessages(t, ctx, ch.OID)) > 0
			if handled != tc.wantHandled {
				t.Fatalf("gatekeeper handled = %v (classified %d, delivered %d), want %v", handled, classified, delivered, tc.wantHandled)
			}
		})
	}
}
