// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
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

// stubClassifier pins the classifier seam to a routine auto-answer so delivery behavior is the only
// variable under test.
func stubClassifier(t *testing.T) {
	t.Helper()
	oldRun := runFn
	runFn = func(_ context.Context, _ consult.RuntimeSpec, _ string, _ string, _ func(string)) (string, error) {
		return `{"action":"answer","answers":[{"picks":[0]}],"reason":"routine"}`, nil
	}
	t.Cleanup(func() { runFn = oldRun })
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

var (
	shipQ   = baseds.AgentAskQuestion{Question: "ship?", Options: []baseds.AgentAskOption{{Label: "yes"}, {Label: "no"}}}
	checksQ = baseds.AgentAskQuestion{Question: "which checks?", MultiSelect: true, Options: []baseds.AgentAskOption{{Label: "lint"}, {Label: "vet"}, {Label: "test"}}}
)

// judgeAsk runs handleAsk on a gatekeeper channel with the classifier replying reply, and returns what was handed to
// delivery (nil when delivery was never called) and the last message posted to the channel.
func judgeAsk(t *testing.T, questions []baseds.AgentAskQuestion, reply string) ([]baseds.AgentAnswerItem, *waveobj.ChannelMessage) {
	t.Helper()
	ctx := context.Background()
	ch, workerORef := seedGatekeeperChannel(t, ctx, "task")
	oldRun := runFn
	runFn = func(_ context.Context, _ consult.RuntimeSpec, _ string, _ string, _ func(string)) (string, error) {
		return reply, nil
	}
	t.Cleanup(func() { runFn = oldRun })
	origDeliver := deliverFn
	t.Cleanup(func() { deliverFn = origDeliver })
	var delivered []baseds.AgentAnswerItem
	deliverFn = func(_ string, _ string, answers []baseds.AgentAnswerItem) (bool, error) {
		delivered = answers
		return true, nil
	}
	handleAsk(ctx, baseds.AgentAskData{ORef: workerORef, AskId: uuid.NewString(), Questions: questions})
	msgs := channelMessages(t, ctx, ch.OID)
	if len(msgs) == 0 {
		t.Fatalf("handleAsk posted nothing")
	}
	return delivered, msgs[len(msgs)-1]
}

// Multi-question and multi-select asks reach the judge, and its answers — several picks or a line of text — are
// delivered whole and recorded on the answered card.
func TestHandleAsk_JudgesAndDeliversEveryAnswerShape(t *testing.T) {
	cases := []struct {
		name      string
		questions []baseds.AgentAskQuestion
		reply     string
		want      []baseds.AgentAnswerItem
		wantText  string
	}{
		{
			"two questions answered in full",
			[]baseds.AgentAskQuestion{shipQ, checksQ},
			`{"action":"answer","answers":[{"picks":[1]},{"picks":[2]}],"reason":"routine"}`,
			[]baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}, {SelectedIndexes: []int{2}}},
			`Answered → "no"; "test" — routine`,
		},
		{
			"multi-select with several picks",
			[]baseds.AgentAskQuestion{checksQ},
			`{"action":"answer","answers":[{"picks":[0,2]}],"reason":"routine"}`,
			[]baseds.AgentAnswerItem{{SelectedIndexes: []int{0, 2}}},
			`Answered → "lint", "test" — routine`,
		},
		{
			"free-text answer",
			[]baseds.AgentAskQuestion{shipQ},
			`{"action":"answer","answers":[{"text":"after the tests pass"}],"reason":"no option fits"}`,
			[]baseds.AgentAnswerItem{{Text: "after the tests pass"}},
			`Answered → "after the tests pass" — no option fits`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			delivered, msg := judgeAsk(t, tc.questions, tc.reply)
			if !reflect.DeepEqual(delivered, tc.want) {
				t.Fatalf("delivered %+v, want %+v", delivered, tc.want)
			}
			if msg.Kind != "jarvis-answered" || msg.Text != tc.wantText {
				t.Fatalf("want answered card %q, got %s %q", tc.wantText, msg.Kind, msg.Text)
			}
			var card JarvisCardData
			if err := json.Unmarshal([]byte(msg.Data), &card); err != nil {
				t.Fatalf("card data: %v", err)
			}
			if !reflect.DeepEqual(card.Answers, tc.want) || len(card.Questions) != len(tc.questions) {
				t.Fatalf("card should carry the whole ask and its answers, got %+v", card)
			}
			if card.Question != tc.questions[0].Question || len(card.Options) != len(tc.questions[0].Options) {
				t.Fatalf("card's legacy question/options should describe question 0, got %+v", card)
			}
		})
	}
}

// All or nothing: one question needing the human escalates the whole ask with nothing delivered, even when the judge
// answered the rest, and the escalation shows the human every question.
func TestHandleAsk_OneHumanQuestionEscalatesTheWholeAsk(t *testing.T) {
	delivered, msg := judgeAsk(t, []baseds.AgentAskQuestion{shipQ, checksQ},
		`{"action":"answer","answers":[{"picks":[0]},{"human":true}],"reason":"which checks is a scope call"}`)
	if delivered != nil {
		t.Fatalf("nothing may be delivered, got %+v", delivered)
	}
	if msg.Kind != "jarvis-escalation" || !strings.Contains(msg.Text, "which checks is a scope call") {
		t.Fatalf("want an escalation carrying the judge's reason, got %s %q", msg.Kind, msg.Text)
	}
	if !strings.Contains(msg.Text, "ship?") || !strings.Contains(msg.Text, "which checks?") {
		t.Fatalf("the escalation should show every question, got %q", msg.Text)
	}
}

// A judge answer the encoder would refuse escalates before delivery: DeliverAnswer claims the ask before encoding, so
// a bad answer reaching it would drop the ask with nothing typed.
func TestHandleAsk_InvalidAnswerEscalatesWithoutDelivery(t *testing.T) {
	cases := []struct {
		name      string
		questions []baseds.AgentAskQuestion
		reply     string
	}{
		{"wrong answer count", []baseds.AgentAskQuestion{shipQ, checksQ}, `{"action":"answer","answers":[{"picks":[0]}]}`},
		{"out-of-range index", []baseds.AgentAskQuestion{shipQ}, `{"action":"answer","answers":[{"picks":[2]}]}`},
		{"picks and text together", []baseds.AgentAskQuestion{shipQ}, `{"action":"answer","answers":[{"picks":[0],"text":"yes"}]}`},
		{"several picks on a single-select", []baseds.AgentAskQuestion{shipQ}, `{"action":"answer","answers":[{"picks":[0,1]}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			delivered, msg := judgeAsk(t, tc.questions, tc.reply)
			if delivered != nil {
				t.Fatalf("an invalid answer must never reach delivery, got %+v", delivered)
			}
			if msg.Kind != "jarvis-escalation" || !strings.Contains(msg.Text, "invalid classifier answer") {
				t.Fatalf("want an escalation naming the invalid answer, got %s %q", msg.Kind, msg.Text)
			}
		})
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
				return `{"action":"answer","answers":[{"picks":[0]}],"reason":"routine"}`, nil
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
