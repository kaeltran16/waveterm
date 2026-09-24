// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestRunLinkOf(t *testing.T) {
	dag := &waveobj.TaskGroup{RunID: "lead", ChannelId: "ch", Tasks: []waveobj.TaskNode{
		{ID: "t-1", RunID: "w1-retry"},
		{ID: "t-2", RunID: "w2", ReviewRunID: "rv2"},
	}}
	cases := []struct {
		name string
		run  waveobj.Run
		dag  *waveobj.TaskGroup
		want sessionRunLink
		ok   bool
	}{
		{"lead owns the dag", waveobj.Run{OID: "lead", ChannelOID: "ch", DagORef: "d", Mode: "orchestrator"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", Role: "lead"}, true},
		{"lead before its dag", waveobj.Run{OID: "lead", ChannelOID: "ch", Mode: "orchestrator"}, nil,
			sessionRunLink{RunId: "lead", ChannelId: "ch", Role: "lead"}, true},
		{"an earlier attempt is placed by its own task id", waveobj.Run{OID: "w1", DagORef: "d", TaskId: "t-1"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", TaskId: "t-1", Role: "worker"}, true},
		{"a finished reviewer keeps its role", waveobj.Run{OID: "rv1", DagORef: "d", TaskId: "t-1", Review: true}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", TaskId: "t-1", Role: "review"}, true},
		{"a legacy worker is placed by the task's link", waveobj.Run{OID: "w2", DagORef: "d"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", TaskId: "t-2", Role: "worker"}, true},
		{"a legacy reviewer is placed by the task's review link", waveobj.Run{OID: "rv2", DagORef: "d"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", TaskId: "t-2", Role: "review"}, true},
		{"an unlinked legacy child stays in its run", waveobj.Run{OID: "gone", DagORef: "d"}, dag,
			sessionRunLink{RunId: "lead", ChannelId: "ch", Role: "worker"}, true},
		{"a child whose dag is gone", waveobj.Run{OID: "w", DagORef: "d", TaskId: "t-1"}, nil, sessionRunLink{}, false},
		{"a plain run", waveobj.Run{OID: "q", Mode: "quick"}, nil, sessionRunLink{}, false},
	}
	for _, c := range cases {
		got, ok := runLinkOf(&c.run, c.dag)
		if ok != c.ok || got != c.want {
			t.Errorf("%s: got %+v %v, want %+v %v", c.name, got, ok, c.want, c.ok)
		}
	}
}
