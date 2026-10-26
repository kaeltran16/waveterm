// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"log"
	"sort"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// defaultMaxHits is the hits returned per session when the caller asks for none.
const defaultMaxHits = 20

// searchResults matches each session against q, links the matched ones to their runs, drops run agents unless
// runAgents, and returns them newest first. A link error is logged and the results are kept unlinked.
func searchResults(sessions []agentsessions.IndexedSession, q agentsessions.Query, runAgents bool, maxHits int, link func([]wshrpc.SessionActivity) error) []wshrpc.SessionSearchResult {
	var matched []wshrpc.SessionSearchResult
	for _, s := range sessions {
		ok, hits, turnHits, eventHits := q.Match(s, maxHits)
		if !ok {
			continue
		}
		matched = append(matched, wshrpc.SessionSearchResult{
			Session: sessionActivityOf(s.Info), Hits: hitsToWire(hits), TurnHits: turnHits, EventHits: eventHits,
		})
	}
	activity := make([]wshrpc.SessionActivity, len(matched))
	for i, r := range matched {
		activity[i] = r.Session
	}
	if err := link(activity); err != nil {
		log.Printf("sessions search: %v", err)
	}
	out := make([]wshrpc.SessionSearchResult, 0, len(matched))
	for i, r := range matched {
		r.Session = activity[i]
		if !runAgents && isRunAgent(r.Session.Role) {
			continue
		}
		out = append(out, r)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Session.LastActiveTs > out[j].Session.LastActiveTs })
	return out
}

func hitsToWire(hits []agentsessions.Hit) []wshrpc.SessionHit {
	out := make([]wshrpc.SessionHit, len(hits))
	for i, h := range hits {
		marks := make([][]int, len(h.Marks))
		for j, m := range h.Marks {
			marks[j] = []int{m[0], m[1]}
		}
		out[i] = wshrpc.SessionHit{Kind: h.Kind, Speaker: h.Speaker, Ord: h.Ord, Text: h.Text, Marks: marks}
	}
	return out
}
