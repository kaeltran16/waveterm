// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func dagPending(askId string) PendingAsk {
	return PendingAsk{AskId: askId, BlockId: "b1", Questions: oneQuestion(), Owner: AskOwner_Lead, RunId: "run-1", TaskId: "t-0"}
}

func stubKeys(t *testing.T) {
	t.Helper()
	orig := sendInput
	sendInput = func(string, []byte) error { return nil }
	t.Cleanup(func() { sendInput = orig })
}

func answerFirst() []baseds.AgentAnswerItem {
	return []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}}
}

func TestUpdateEditsInMemoryWithoutPersisting(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	GlobalRegistry.Set("block:b1", dagPending("a1"))
	var persisted int
	origHook := DurableHook
	DurableHook = func(string, *PendingAsk) { persisted++ }
	defer func() { DurableHook = origHook }()

	if !GlobalRegistry.Update("block:b1", "a1", func(p *PendingAsk) { p.Owner = AskOwner_User; p.Note = "yours" }) {
		t.Fatal("update of a pending ask must succeed")
	}
	got, _ := GlobalRegistry.Get("block:b1")
	if got.Owner != AskOwner_User || got.Note != "yours" {
		t.Fatalf("update not applied: %+v", got)
	}
	if persisted != 0 {
		t.Fatalf("queue fields are in memory only, DurableHook ran %d times", persisted)
	}
	if GlobalRegistry.Update("block:b1", "stale", func(p *PendingAsk) { p.Owner = AskOwner_Lead }) {
		t.Fatal("a stale ask id must not update")
	}
	if GlobalRegistry.Update("block:none", "", func(p *PendingAsk) {}) {
		t.Fatal("an absent ask must not update")
	}
}

func TestTypedDagAnswerAwaitsClear(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	stubKeys(t)
	GlobalRegistry.Set("block:b1", dagPending("a1"))

	if ok, err := DeliverAnswer("block:b1", "", answerFirst()); err != nil || !ok {
		t.Fatalf("want delivered, got (%v, %v)", ok, err)
	}
	if !GlobalRegistry.ConfirmClear("block:b1") {
		t.Fatal("a typed dag answer must wait for the agent's clear")
	}
	if GlobalRegistry.ConfirmClear("block:b1") {
		t.Fatal("a clear confirms once")
	}
}

func TestUnconfirmedAnswerReturnsToOwner(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	stubKeys(t)
	GlobalRegistry.Set("block:b1", dagPending("a1"))
	if ok, _ := DeliverAnswer("block:b1", "", answerFirst()); !ok {
		t.Fatal("want delivered")
	}

	if got := GlobalRegistry.ExpireClears(time.Now().UnixMilli(), AnswerClearTimeout); len(got) != 0 {
		t.Fatalf("nothing expires before the timeout, got %+v", got)
	}
	later := time.Now().Add(AnswerClearTimeout + time.Second).UnixMilli()
	got := GlobalRegistry.ExpireClears(later, AnswerClearTimeout)
	p, ok := got["block:b1"]
	if !ok || p.Owner != AskOwner_Lead || p.Misses != 1 || p.Note != AnswerUnconfirmedNote {
		t.Fatalf("want the ask back with its lead owner and one miss, got %+v", got)
	}
	if _, live := GlobalRegistry.Get("block:b1"); !live {
		t.Fatal("the restored ask must be pending again")
	}
}

func TestSecondUnconfirmedAnswerGoesToUser(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	stubKeys(t)
	GlobalRegistry.Set("block:b1", dagPending("a1"))
	later := time.Now().Add(AnswerClearTimeout + time.Second).UnixMilli()
	for i := 0; i < 2; i++ {
		if ok, _ := DeliverAnswer("block:b1", "", answerFirst()); !ok {
			t.Fatalf("delivery %d: want delivered", i+1)
		}
		GlobalRegistry.ExpireClears(later, AnswerClearTimeout)
	}
	got, _ := GlobalRegistry.Get("block:b1")
	if got.Owner != AskOwner_User || got.Misses != 2 {
		t.Fatalf("a second failed delivery moves the ask to the user, got %+v", got)
	}
}

func TestExpireClearsDropsWhenChildMovedOn(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	stubKeys(t)
	GlobalRegistry.Set("block:b1", dagPending("a1"))
	if ok, _ := DeliverAnswer("block:b1", "", answerFirst()); !ok {
		t.Fatal("want delivered")
	}
	GlobalRegistry.Set("block:b1", dagPending("a2"))

	later := time.Now().Add(AnswerClearTimeout + time.Second).UnixMilli()
	if got := GlobalRegistry.ExpireClears(later, AnswerClearTimeout); len(got) != 0 {
		t.Fatalf("a new ask on the block means the answer landed, got %+v", got)
	}
	if cur, _ := GlobalRegistry.Get("block:b1"); cur.AskId != "a2" {
		t.Fatalf("the child's new ask must be untouched, got %+v", cur)
	}
}

// only the waiter path (pi bridge) skips the clear: it has no picker to confirm delivery into, so the
// resolved waiter IS the delivery. Every keystroke delivery, dag child or plain session alike, awaits one
// — a session answer that never lands is otherwise indistinguishable from one that did.
func TestOnlyWaiterAnswersSkipAwaitingClear(t *testing.T) {
	GlobalRegistry = MakeRegistry()
	stubKeys(t)
	plain := dagPending("a1")
	plain.Owner = ""
	GlobalRegistry.Set("block:plain", plain)
	if ok, _ := DeliverAnswer("block:plain", "", answerFirst()); !ok {
		t.Fatal("want delivered")
	}
	if !GlobalRegistry.ConfirmClear("block:plain") {
		t.Fatal("a session answer delivered by keystrokes awaits its clear too")
	}

	GlobalRegistry.Set("block:pi", dagPending("a2"))
	GlobalRegistry.RegisterWaiter("a2")
	if ok, _ := DeliverAnswer("block:pi", "", answerFirst()); !ok {
		t.Fatal("want delivered")
	}
	if GlobalRegistry.ConfirmClear("block:pi") {
		t.Fatal("a resolved waiter is the delivery; there is no clear to wait for")
	}
}
