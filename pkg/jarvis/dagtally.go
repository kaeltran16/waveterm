// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"sort"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// DagTally is what a dag's events count for the record: questions answered, judgments forwarded to the human, and
// what the human typed to workers, oldest first.
type DagTally struct {
	Answered, Forwarded int
	Told                []wshrpc.DagTold
}

// TallyDagEvents is the one place the child-answered, task-forwarded and task-told rows are counted, so the lead's
// run-end digest and the sealed record cannot disagree. Rows of other kinds are ignored.
func TallyDagEvents(evs []waveobj.RunEvent) DagTally {
	var t DagTally
	for _, ev := range evs {
		switch ev.Kind {
		case waveobj.RunEventKindChildAnswered:
			t.Answered++
		case waveobj.RunEventKindTaskForwarded:
			t.Forwarded++
		case waveobj.RunEventKindTaskTold:
			var d struct {
				TaskId string `json:"taskid"`
				Text   string `json:"text"`
			}
			if json.Unmarshal(ev.Detail, &d) != nil || d.Text == "" {
				continue
			}
			t.Told = append(t.Told, wshrpc.DagTold{TaskId: d.TaskId, Ts: ev.Ts, Text: d.Text})
		}
	}
	sort.SliceStable(t.Told, func(i, j int) bool { return t.Told[i].Ts < t.Told[j].Ts })
	return t
}
