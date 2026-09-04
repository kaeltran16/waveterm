// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// askTargetFixture wires a channel, an owner run carrying a dag, and one child run bound to task
// t-0 — the shape ResolveAskTarget walks from a child's ask back to the lead's timeline.
func askTargetFixture(t *testing.T) (*waveobj.TaskGroup, *waveobj.Run, *waveobj.Run) {
	t.Helper()
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "askevents-"+uuid.NewString(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 1, false, []waveobj.TaskNode{{ID: "t-0", Label: "a"}}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}
	child := jarvis.NewRun("child", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Quick, jarvis.DefaultOrchestratorPlaybook(false), 1)
	child.DagORef = g.OID
	if err := wstore.AppendRun(ctx, ch.OID, child); err != nil {
		t.Fatal(err)
	}
	if err := wstore.UpdateDag(ctx, g.OID, func(d *waveobj.TaskGroup) error {
		d.Tasks[0].RunID = child.ID
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	fresh, err := wstore.GetDag(ctx, g.OID)
	if err != nil {
		t.Fatal(err)
	}
	return fresh, &owner, &child
}

func TestResolveAskTargetFindsOwningTask(t *testing.T) {
	g, owner, child := askTargetFixture(t)
	group, target, ok := ResolveAskTarget(context.Background(), g.ChannelId, child, "ask-1")
	if !ok {
		t.Fatal("a dag child's run must resolve to its task")
	}
	if group == nil || group.OID != g.OID {
		t.Fatalf("group not returned: %+v", group)
	}
	if target.RunID != owner.ID {
		t.Fatalf("lifecycle rows belong on the owning run, got %q want %q", target.RunID, owner.ID)
	}
	if target.TaskId != "t-0" || target.AskId != "ask-1" || target.ChannelId != g.ChannelId {
		t.Fatalf("target = %+v", target)
	}
}

func TestResolveAskTargetRejectsNonDagRun(t *testing.T) {
	g, _, child := askTargetFixture(t)
	plain := *child
	plain.DagORef = ""
	if _, _, ok := ResolveAskTarget(context.Background(), g.ChannelId, &plain, "ask-1"); ok {
		t.Fatal("a run outside a dag has no ask lifecycle target")
	}
}

func TestRecordAskLifecycleTruncatesQuestion(t *testing.T) {
	g, owner, _ := askTargetFixture(t)
	ctx := context.Background()
	long := strings.Repeat("q", MaxAskSummaryLen+50)
	RecordAskLifecycle(ctx, AskTarget{ChannelId: g.ChannelId, RunID: owner.ID, TaskId: "t-0", AskId: "ask-1"}, waveobj.RunEventKindChildAsk, long)
	detail := eventDetail(t, lifecycleEvents(t, g.ChannelId, owner.ID), waveobj.RunEventKindChildAsk)
	if detail == nil {
		t.Fatal("child-ask not appended")
	}
	q, _ := detail["question"].(string)
	if len(q) != MaxAskSummaryLen {
		t.Fatalf("question len = %d, want the cap %d", len(q), MaxAskSummaryLen)
	}
	if detail["askid"] != "ask-1" || detail["taskid"] != "t-0" {
		t.Fatalf("detail = %+v", detail)
	}
}

func TestRecordAskLifecyclePreservesAskId(t *testing.T) {
	g, owner, _ := askTargetFixture(t)
	ctx := context.Background()
	target := AskTarget{ChannelId: g.ChannelId, RunID: owner.ID, TaskId: "t-0", AskId: "ask-42"}
	RecordAskLifecycle(ctx, target, waveobj.RunEventKindChildAsk, "pick one")
	RecordAskLifecycle(ctx, target, waveobj.RunEventKindChildAnswered, "")
	detail := eventDetail(t, lifecycleEvents(t, g.ChannelId, owner.ID), waveobj.RunEventKindChildAnswered)
	if detail == nil {
		t.Fatal("child-answered not appended")
	}
	if detail["askid"] != "ask-42" {
		t.Fatalf("answered row must carry the raised ask id, got %+v", detail)
	}
}

func TestRecordAskLifecycleClearCarriesReason(t *testing.T) {
	g, owner, _ := askTargetFixture(t)
	RecordAskLifecycle(context.Background(), AskTarget{ChannelId: g.ChannelId, RunID: owner.ID, TaskId: "t-0", AskId: "ask-9"},
		waveobj.RunEventKindChildAskCleared, AskClearReasonWaiterEnded)
	detail := eventDetail(t, lifecycleEvents(t, g.ChannelId, owner.ID), waveobj.RunEventKindChildAskCleared)
	if detail == nil {
		t.Fatal("child-ask-cleared not appended")
	}
	if detail["reason"] != AskClearReasonWaiterEnded || detail["askid"] != "ask-9" {
		t.Fatalf("detail = %+v", detail)
	}
}

func TestRecordAskLifecycleSkipsIncompleteTarget(t *testing.T) {
	g, owner, _ := askTargetFixture(t)
	RecordAskLifecycle(context.Background(), AskTarget{ChannelId: g.ChannelId, RunID: owner.ID}, waveobj.RunEventKindChildAnswered, "")
	if detail := eventDetail(t, lifecycleEvents(t, g.ChannelId, owner.ID), waveobj.RunEventKindChildAnswered); detail != nil {
		t.Fatalf("a target with no task must append nothing, got %+v", detail)
	}
}
