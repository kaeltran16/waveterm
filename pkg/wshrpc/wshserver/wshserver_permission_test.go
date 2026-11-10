// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// capturePermissionEvents subscribes to oref's agent:permission events with a fresh registry, and returns
// what was published.
func capturePermissionEvents(t *testing.T, oref string) func() []baseds.AgentPermissionData {
	t.Helper()
	agentask.GlobalPermissions = agentask.MakePermissionRegistry()
	var lock sync.Mutex
	var got []baseds.AgentPermissionData
	originalClient := wps.Broker.GetClient()
	wps.Broker.SetClient(&askResolveClient{onEvent: func(event wps.WaveEvent) {
		if data, ok := event.Data.(baseds.AgentPermissionData); ok {
			lock.Lock()
			got = append(got, data)
			lock.Unlock()
		}
	}})
	const route = "permission-test"
	wps.Broker.Subscribe(route, wps.SubscriptionRequest{Event: wps.Event_AgentPermission, Scopes: []string{oref}})
	t.Cleanup(func() {
		wps.Broker.UnsubscribeAll(route)
		wps.Broker.SetClient(originalClient)
	})
	return func() []baseds.AgentPermissionData {
		lock.Lock()
		defer lock.Unlock()
		return slices.Clone(got)
	}
}

func raisePermission(t *testing.T, oref, toolKey string) agentask.PendingPermission {
	t.Helper()
	permid, err := (&WshServer{}).AgentPermissionCommand(context.Background(), wshrpc.CommandAgentPermissionData{
		ORef:           oref,
		ToolName:       "Edit",
		ToolInput:      `{"file_path":"a.go"}`,
		ToolKey:        toolKey,
		HasSuggestions: true,
	})
	if err != nil {
		t.Fatalf("raise: %v", err)
	}
	for _, p := range agentask.GlobalPermissions.List(oref) {
		if p.PermId == permid {
			return p
		}
	}
	t.Fatalf("raised permission %s is not in the registry", permid)
	return agentask.PendingPermission{}
}

func publishPermStatus(oref, state, hook, toolKey string, ts int64) {
	publishEvent(context.Background(), wps.WaveEvent{
		Event:   wps.Event_AgentStatus,
		Scopes:  []string{oref},
		Persist: 1,
		Data:    baseds.AgentStatusData{ORef: oref, State: state, Hook: hook, Agent: "claude", ToolKey: toolKey, Ts: ts},
	})
}

func TestAgentPermissionCommandPublishes(t *testing.T) {
	oref := waveobj.MakeORef(waveobj.OType_Block, uuid.NewString()).String()
	events := capturePermissionEvents(t, oref)
	p := raisePermission(t, oref, "k1")
	got := events()
	if len(got) != 1 {
		t.Fatalf("want one raise event, got %v", got)
	}
	ev := got[0]
	if ev.Cleared || ev.ORef != oref || ev.PermId != p.PermId || ev.ToolName != "Edit" || ev.ToolInput != `{"file_path":"a.go"}` || ev.Ts != p.Ts {
		t.Fatalf("raise event = %#v, want the registry entry %#v", ev, p)
	}
	if want := agentask.PermissionChoices("Edit", true); !slices.Equal(ev.Choices, want) {
		t.Fatalf("event choices = %q, want %q", ev.Choices, want)
	}

	ws := &WshServer{}
	for _, bad := range []wshrpc.CommandAgentPermissionData{{ORef: "", ToolName: "Edit"}, {ORef: "nope", ToolName: "Edit"}, {ORef: oref}} {
		if _, err := ws.AgentPermissionCommand(context.Background(), bad); err == nil {
			t.Fatalf("raise %#v: want a validation error", bad)
		}
	}
}

func TestAnswerAgentPermissionPublishesCleared(t *testing.T) {
	oref := waveobj.MakeORef(waveobj.OType_Block, uuid.NewString()).String()
	events := capturePermissionEvents(t, oref)
	t.Cleanup(agentask.SetSendInputForTest(func(string, []byte) error { return nil }))
	p := raisePermission(t, oref, "k1")
	err := (&WshServer{}).AnswerAgentPermissionCommand(context.Background(), wshrpc.CommandAnswerAgentPermissionData{ORef: oref, PermId: p.PermId, Choice: 0})
	if err != nil {
		t.Fatalf("answer: %v", err)
	}
	got := events()
	if last := got[len(got)-1]; !last.Cleared || last.PermId != p.PermId {
		t.Fatalf("want a cleared event for %s last, got %v", p.PermId, got)
	}
}

func TestPublishEventRetiresPermission(t *testing.T) {
	oref := waveobj.MakeORef(waveobj.OType_Block, uuid.NewString()).String()
	events := capturePermissionEvents(t, oref)
	p := raisePermission(t, oref, "k1")
	publishPermStatus(oref, baseds.AgentState_Working, baseds.AgentHook_PostToolUse, "other", p.Ts+10)
	if got := agentask.GlobalPermissions.List(oref); len(got) != 1 {
		t.Fatalf("a PostToolUse for another tool retired the request: %v", got)
	}
	publishPermStatus(oref, baseds.AgentState_Idle, baseds.AgentHook_Stop, "", p.Ts+20)
	if got := agentask.GlobalPermissions.List(oref); len(got) != 0 {
		t.Fatalf("a Stop did not retire the request: %v", got)
	}
	got := events()
	if last := got[len(got)-1]; !last.Cleared || last.PermId != p.PermId {
		t.Fatalf("want a cleared event for %s last, got %v", p.PermId, got)
	}
}

// a late async PostToolUse lands after the turn's Stop, and outOfTurnStatus drops it; it still proves its
// tool ran, so its request must not stay on the band
func TestPublishEventRetiresBeforeStaleDrop(t *testing.T) {
	oref := waveobj.MakeORef(waveobj.OType_Block, uuid.NewString()).String()
	events := capturePermissionEvents(t, oref)
	publishPermStatus(oref, baseds.AgentState_Idle, baseds.AgentHook_Stop, "", time.Now().UnixMilli()-1000)
	p := raisePermission(t, oref, "k1")
	publishPermStatus(oref, baseds.AgentState_Working, baseds.AgentHook_PostToolUse, "k1", p.Ts+10)
	if !outOfTurnStatus(&wps.WaveEvent{
		Event:  wps.Event_AgentStatus,
		Scopes: []string{oref},
		Data:   baseds.AgentStatusData{ORef: oref, State: baseds.AgentState_Working, Hook: baseds.AgentHook_PostToolUse, Ts: p.Ts + 10},
	}) {
		t.Fatal("precondition: the PostToolUse after the Stop should be out of turn")
	}
	if got := agentask.GlobalPermissions.List(oref); len(got) != 0 {
		t.Fatalf("a dropped PostToolUse with the matching key did not retire the request: %v", got)
	}
	got := events()
	if last := got[len(got)-1]; !last.Cleared || last.PermId != p.PermId {
		t.Fatalf("want a cleared event for %s last, got %v", p.PermId, got)
	}
}
