// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func opts(labels ...string) []baseds.AgentAskOption {
	out := make([]baseds.AgentAskOption, len(labels))
	for i, l := range labels {
		out[i] = baseds.AgentAskOption{Label: l}
	}
	return out
}

// runAsk judges an ask with the model replying reply, capturing what reaches delivery, and returns the
// delivered answers (nil when nothing was delivered) and the last channel message.
func runAsk(t *testing.T, questions []baseds.AgentAskQuestion, reply string) ([]baseds.AgentAnswerItem, *struct{ Kind, Text, Data string }) {
	t.Helper()
	ctx := context.Background()
	origDeliver := deliverFn
	t.Cleanup(func() { deliverFn = origDeliver })
	ch, workerORef := seedGatekeeperChannel(t, ctx, "task")
	stubClassifierReply(t, reply)
	var delivered []baseds.AgentAnswerItem
	deliverFn = func(_, _ string, answers []baseds.AgentAnswerItem) (bool, error) {
		delivered = answers
		return true, nil
	}
	handleAsk(ctx, baseds.AgentAskData{ORef: workerORef, AskId: uuid.NewString(), Questions: questions})
	msgs := channelMessages(t, ctx, ch.OID)
	if len(msgs) == 0 {
		t.Fatalf("gatekeeper posted nothing")
	}
	last := msgs[len(msgs)-1]
	return delivered, &struct{ Kind, Text, Data string }{last.Kind, last.Text, last.Data}
}

func twoQuestions() []baseds.AgentAskQuestion {
	return []baseds.AgentAskQuestion{
		{Question: "Which db?", Options: opts("postgres", "sqlite")},
		{Question: "Which regions?", MultiSelect: true, Options: opts("eu", "us", "ap")},
	}
}

func TestHandleAskAnswersEveryQuestionOfABatch(t *testing.T) {
	reply := `{"action":"answer","answers":[{"selectedindexes":[1]},{"selectedindexes":[0,2]}],"reason":"routine"}`
	got, msg := runAsk(t, twoQuestions(), reply)
	want := []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}, {SelectedIndexes: []int{0, 2}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("delivered %+v, want %+v", got, want)
	}
	if msg.Kind != "jarvis-answered" {
		t.Fatalf("want an answered card, got %s: %s", msg.Kind, msg.Text)
	}
	var card JarvisCardData
	if err := json.Unmarshal([]byte(msg.Data), &card); err != nil {
		t.Fatal(err)
	}
	if len(card.Questions) != 2 || len(card.Answers) != 2 || card.Question != "Which db?" || card.Choice == nil || *card.Choice != 1 {
		t.Fatalf("card does not carry the whole ask: %+v", card)
	}
	if !strings.Contains(msg.Text, `"sqlite"`) || !strings.Contains(msg.Text, `"eu", "ap"`) {
		t.Fatalf("summary should name every pick: %q", msg.Text)
	}
}

func TestHandleAskAnswersAMultiSelectWithSeveralPicks(t *testing.T) {
	qs := []baseds.AgentAskQuestion{{Question: "Which regions?", MultiSelect: true, Options: opts("eu", "us", "ap")}}
	got, msg := runAsk(t, qs, `{"action":"answer","answers":[{"selectedindexes":[0,1,2]}],"reason":"all"}`)
	if want := []baseds.AgentAnswerItem{{SelectedIndexes: []int{0, 1, 2}}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("delivered %+v, want %+v", got, want)
	}
	if msg.Kind != "jarvis-answered" {
		t.Fatalf("want an answered card, got %s", msg.Kind)
	}
}

func TestHandleAskDeliversAFreeTextAnswer(t *testing.T) {
	qs := []baseds.AgentAskQuestion{{Question: "Which db?", Options: opts("postgres", "sqlite")}}
	got, msg := runAsk(t, qs, `{"action":"answer","answers":[{"text":"use duckdb"}],"reason":"none fit"}`)
	if want := []baseds.AgentAnswerItem{{Text: "use duckdb"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("delivered %+v, want %+v", got, want)
	}
	if msg.Kind != "jarvis-answered" || !strings.Contains(msg.Text, `"use duckdb"`) {
		t.Fatalf("want an answered card naming the text, got %s: %s", msg.Kind, msg.Text)
	}
}

// all or nothing: one question needing the human escalates the whole ask, and nothing is delivered
func TestHandleAskEscalatesTheWholeBatchWhenOneQuestionNeedsTheHuman(t *testing.T) {
	got, msg := runAsk(t, twoQuestions(), `{"action":"escalate","reason":"question 2 is a real fork"}`)
	if got != nil {
		t.Fatalf("nothing may be delivered, got %+v", got)
	}
	if msg.Kind != "jarvis-escalation" || !strings.Contains(msg.Text, "question 2 is a real fork") {
		t.Fatalf("want an escalation with the reason, got %s: %s", msg.Kind, msg.Text)
	}
	var card JarvisCardData
	if err := json.Unmarshal([]byte(msg.Data), &card); err != nil {
		t.Fatal(err)
	}
	if len(card.Questions) != 2 || len(card.Answers) != 0 || card.Choice != nil {
		t.Fatalf("escalation card should hold both questions and no answer: %+v", card)
	}
}

func TestHandleAskEscalatesAnInvalidAnswerWithoutDelivery(t *testing.T) {
	cases := []struct {
		name  string
		reply string
	}{
		{"too few answers", `{"action":"answer","answers":[{"selectedindexes":[0]}]}`},
		{"too many answers", `{"action":"answer","answers":[{"selectedindexes":[0]},{"selectedindexes":[0]},{"selectedindexes":[0]}]}`},
		{"index past the end", `{"action":"answer","answers":[{"selectedindexes":[0]},{"selectedindexes":[3]}]}`},
		{"negative index", `{"action":"answer","answers":[{"selectedindexes":[-1]},{"selectedindexes":[0]}]}`},
		{"picks and text together", `{"action":"answer","answers":[{"selectedindexes":[0],"text":"x"},{"selectedindexes":[0]}]}`},
		{"several picks on a single-select", `{"action":"answer","answers":[{"selectedindexes":[0,1]},{"selectedindexes":[0]}]}`},
		{"no pick and no text", `{"action":"answer","answers":[{},{"selectedindexes":[0]}]}`},
		{"multi-line text", `{"action":"answer","answers":[{"selectedindexes":[0]},{"text":"a\nb"}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, msg := runAsk(t, twoQuestions(), tc.reply)
			if got != nil {
				t.Fatalf("an invalid answer must never reach delivery, got %+v", got)
			}
			if msg.Kind != "jarvis-escalation" || !strings.Contains(msg.Text, "invalid classifier answer") {
				t.Fatalf("want an escalation naming the invalid answer, got %s: %s", msg.Kind, msg.Text)
			}
		})
	}
}
