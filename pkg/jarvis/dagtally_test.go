// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func tallyEvent(t *testing.T, kind string, ts int64, detail map[string]any) waveobj.RunEvent {
	t.Helper()
	raw, err := json.Marshal(detail)
	if err != nil {
		t.Fatal(err)
	}
	return waveobj.RunEvent{Kind: kind, Ts: ts, Detail: raw}
}

// events arrive newest first from the store; told reads oldest first, and a told row with no text is not a message
func TestTallyDagEventsCountsAndOrdersTold(t *testing.T) {
	evs := []waveobj.RunEvent{
		tallyEvent(t, waveobj.RunEventKindTaskTold, 30, map[string]any{"taskid": "t-2", "text": "use the new helper"}),
		tallyEvent(t, waveobj.RunEventKindChildAnswered, 25, nil),
		tallyEvent(t, waveobj.RunEventKindTaskForwarded, 20, map[string]any{"taskid": "t-1"}),
		tallyEvent(t, waveobj.RunEventKindTaskTold, 15, map[string]any{"taskid": "t-1", "text": ""}),
		tallyEvent(t, waveobj.RunEventKindTaskTold, 10, map[string]any{"taskid": "t-1", "text": "stop and commit"}),
		tallyEvent(t, waveobj.RunEventKindChildAnswered, 5, nil),
		tallyEvent(t, waveobj.RunEventKindTaskReviewPassed, 4, map[string]any{"taskid": "t-1"}),
	}
	got := TallyDagEvents(evs)
	want := DagTally{Answered: 2, Forwarded: 1, Told: []wshrpc.DagTold{
		{TaskId: "t-1", Ts: 10, Text: "stop and commit"},
		{TaskId: "t-2", Ts: 30, Text: "use the new helper"},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestTallyDagEventsOfNoEventsIsZero(t *testing.T) {
	if got := TallyDagEvents(nil); !reflect.DeepEqual(got, DagTally{}) {
		t.Fatalf("got %+v", got)
	}
}
