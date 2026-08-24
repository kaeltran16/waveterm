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

// Guards the gatekeeper pre-filter: only a single single-select question may be auto-answered;
// anything else must reach a human.
func TestAskAutoAnswerable(t *testing.T) {
	cases := []struct {
		name      string
		questions []baseds.AgentAskQuestion
		want      bool
	}{
		{"single single-select", singleSelect(2), true},
		{"single multi-select", []baseds.AgentAskQuestion{{Question: "q", MultiSelect: true, Options: []baseds.AgentAskOption{{Label: "a"}}}}, false},
		{"multiple questions", []baseds.AgentAskQuestion{{Question: "q1"}, {Question: "q2"}}, false},
		{"no questions", nil, false},
	}
	for _, tc := range cases {
		if got := askAutoAnswerable(tc.questions); got != tc.want {
			t.Errorf("%s: askAutoAnswerable = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// Guards the delivery bounds check: a classifier index outside the option list must not be delivered.
func TestOptionIndexInRange(t *testing.T) {
	q := baseds.AgentAskQuestion{Options: []baseds.AgentAskOption{{Label: "a"}, {Label: "b"}}}
	cases := []struct {
		name string
		idx  int
		q    baseds.AgentAskQuestion
		want bool
	}{
		{"first option", 0, q, true},
		{"last option", 1, q, true},
		{"one past the end", 2, q, false},
		{"negative", -1, q, false},
		{"empty options", 0, baseds.AgentAskQuestion{}, false},
	}
	for _, tc := range cases {
		if got := optionIndexInRange(tc.idx, tc.q); got != tc.want {
			t.Errorf("%s: optionIndexInRange(%d) = %v, want %v", tc.name, tc.idx, got, tc.want)
		}
	}
}

// seedGatekeeperChannel creates a gatekeeper-enabled channel with a dispatched concierge worker tab
// (dispatch post stamps the worker's channeloref), so ResolveAskOwner resolves handleAsk's ask.
func seedGatekeeperChannel(t *testing.T, ctx context.Context, task string) (*waveobj.Channel, string) {
	t.Helper()
	ch, err := wstore.CreateChannel(ctx, "gk-delivery", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Channel, ch.OID),
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
		return `{"action":"answer","optionindex":0,"reason":"routine"}`, nil
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
