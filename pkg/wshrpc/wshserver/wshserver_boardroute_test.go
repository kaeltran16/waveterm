// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestBoardAgentOf(t *testing.T) {
	cases := []struct {
		name    string
		meta    waveobj.MetaMapType
		want    wshrpc.BoardAgent
		wantOK  bool
		wantNow bool
	}{
		{
			name:   "claude tab",
			meta:   waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "claude"},
			want:   wshrpc.BoardAgent{Title: "claude · waveterm", Runtime: "claude"},
			wantOK: true,
		},
		{
			name:   "pi tab with a label",
			meta:   waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "pi", waveobj.MetaKey_SessionLabel: " Reviewer "},
			want:   wshrpc.BoardAgent{Title: "Reviewer", Runtime: "pi"},
			wantOK: true,
		},
		{
			name:   "a tab with no runtime is claude, as its title names it",
			meta:   waveobj.MetaMapType{},
			want:   wshrpc.BoardAgent{Title: "claude · waveterm", Runtime: "claude"},
			wantOK: true,
		},
		{
			name:   "codex tab is not tied",
			meta:   waveobj.MetaMapType{waveobj.MetaKey_SessionAgent: "codex"},
			wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tab := &waveobj.Tab{OID: uuid.NewString(), Meta: tc.meta}
			got, ok := boardAgentOf(tab, "waveterm")
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (got %+v)", ok, tc.wantOK, got)
			}
			if !ok {
				return
			}
			if got.ReadTs == 0 {
				t.Errorf("ReadTs must be set to now")
			}
			got.ReadTs = 0
			tc.want.TabId = tab.OID
			if got != tc.want {
				t.Errorf("agent = %+v, want %+v", got, tc.want)
			}
		})
	}
}

type boardEventClient struct {
	mu     sync.Mutex
	events []wps.WaveEvent
}

func (c *boardEventClient) SendEvent(_ string, event wps.WaveEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, event)
}

func TestPublishBoardJoin(t *testing.T) {
	client := &boardEventClient{}
	old := wps.Broker.GetClient()
	wps.Broker.SetClient(client)
	wps.Broker.Subscribe("board-join-test", wps.SubscriptionRequest{Event: wps.Event_BoardUpdate, AllScopes: true})
	t.Cleanup(func() {
		wps.Broker.UnsubscribeAll("board-join-test")
		wps.Broker.SetClient(old)
	})

	publishBoardJoin("chan-1", "board-1", "tab-1")

	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.events) != 1 {
		t.Fatalf("events: %+v", client.events)
	}
	got, ok := client.events[0].Data.(wshrpc.BoardUpdateData)
	if !ok {
		t.Fatalf("payload type %T", client.events[0].Data)
	}
	want := wshrpc.BoardUpdateData{ChannelId: "chan-1", BoardId: "board-1", What: "join", AgentTabId: "tab-1"}
	if got != want {
		t.Errorf("update = %+v, want %+v", got, want)
	}
}
