// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisstate is the work-ledger query engine (Axis 1): deterministic derivations over the
// two lossless legs (wstore runs + sealed evidence, agentsessions scans) plus the derived layers
// (dossiers, attention). The functions here are pure over already-fetched inputs so tests need no
// OS or RPC; fetch.go is the thin wire layer that fetches the legs.
package jarvisstate

import (
	"sort"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// runTerminalStatuses are the statuses a run can end in; everything else is in-flight.
var runTerminalStatuses = map[string]bool{"done": true, "cancelled": true}

// ActiveWork derives the per-project needs-you surface: in-flight runs with status, live sessions
// (Status is "done"/"failed" only after the transcript finished), attention items (project resolved
// through the run they wait on), and dossier blockers (dossiers carry no project label — they group
// under "").
func ActiveWork(runs []*waveobj.Run, sessions []agentsessions.SessionInfo, attention []wshrpc.AttentionItem, dossiers []jarvisdossier.Dossier) []wshrpc.ActiveWorkItem {
	var out []wshrpc.ActiveWorkItem
	for _, r := range runs {
		if runTerminalStatuses[r.Status] {
			continue
		}
		out = append(out, wshrpc.ActiveWorkItem{
			Project: r.ProjectPath, Kind: "run", Title: r.Goal,
			Detail: "status: " + r.Status, Ts: r.CreatedTs, NavTarget: "run:" + r.OID,
		})
	}
	runByID := make(map[string]*waveobj.Run, len(runs))
	for _, r := range runs {
		runByID[r.OID] = r
	}
	for _, a := range attention {
		proj := ""
		if r, ok := runByID[a.RunId]; ok {
			proj = r.ProjectPath
		}
		out = append(out, wshrpc.ActiveWorkItem{
			Project: proj, Kind: "attention", Title: a.Source,
			Detail: a.Action + ": " + a.Text, Ts: a.WaitingSince, NavTarget: "run:" + a.RunId,
		})
	}
	for _, s := range sessions {
		if s.Status == "done" || s.Status == "failed" {
			continue
		}
		title := s.Task
		if title == "" {
			title = s.ID
		}
		out = append(out, wshrpc.ActiveWorkItem{
			Project: s.ProjectPath, Kind: "session", Title: title,
			Detail: s.Runtime + " " + s.Model, Ts: s.LastActiveTs,
		})
	}
	for _, d := range dossiers {
		if len(d.Blockers) == 0 {
			continue
		}
		out = append(out, wshrpc.ActiveWorkItem{
			Kind: "blocker", Title: d.Objective, Detail: joinBlockers(d.Blockers),
			Ts: d.Updated, NavTarget: "vault:" + d.ID,
		})
	}
	return out
}

func joinBlockers(bs []string) string {
	out := ""
	for i, b := range bs {
		if i > 0 {
			out += ", "
		}
		out += b
	}
	return out
}

// Shipped returns the completed, evidence-sealed runs within the window, newest first.
// windowStartMs 0 means unbounded. A done run without sealed evidence is not "shipped" — the seal
// is the lossless record and its absence means the run's outcome is not trustworthy.
func Shipped(runs []*waveobj.Run, windowStartMs int64) []wshrpc.ShippedItem {
	var out []wshrpc.ShippedItem
	for _, r := range runs {
		if r.Status != "done" || r.Evidence == nil {
			continue
		}
		if windowStartMs > 0 && r.CompletedTs < windowStartMs {
			continue
		}
		out = append(out, wshrpc.ShippedItem{
			Project: r.ProjectPath, RunOID: r.OID, Goal: r.Goal, Summary: r.Evidence.Summary,
			Files: r.Evidence.Files, Verifs: r.Evidence.Verifs, CompletedTs: r.CompletedTs,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CompletedTs > out[j].CompletedTs })
	return out
}

// DecisionEntry is one vault decision's ledger-relevant projection (a pure input; the fetch layer
// loads it from the decisions collection).
type DecisionEntry struct {
	ID        string
	Summary   string
	CreatedTs int64
}

// Timeline merges run, session, decision, and dossier events into one timestamp-descending stream,
// optionally windowed (windowStartMs 0 = unbounded). Status changes are not event-logged anywhere,
// so a dossier's current status is reported on its UpdatedTs event — the honest shape of the data.
func Timeline(runs []*waveobj.Run, sessions []agentsessions.SessionInfo, decisions []DecisionEntry, dossiers []jarvisdossier.Dossier, windowStartMs int64) []wshrpc.TimelineEvent {
	var evs []wshrpc.TimelineEvent
	add := func(ev wshrpc.TimelineEvent) {
		if windowStartMs > 0 && ev.Ts < windowStartMs {
			return
		}
		evs = append(evs, ev)
	}
	for _, r := range runs {
		add(wshrpc.TimelineEvent{Ts: r.CreatedTs, Kind: "run-created", Project: r.ProjectPath, Title: r.Goal, Detail: "status: " + r.Status, NavTarget: "run:" + r.OID})
		if r.CompletedTs > 0 {
			detail := ""
			if r.Evidence != nil {
				detail = r.Evidence.Summary
			}
			add(wshrpc.TimelineEvent{Ts: r.CompletedTs, Kind: "run-done", Project: r.ProjectPath, Title: r.Goal, Detail: detail, NavTarget: "run:" + r.OID})
		}
	}
	for _, s := range sessions {
		add(wshrpc.TimelineEvent{Ts: s.StartedTs, Kind: "session", Project: s.ProjectPath, Title: s.Task, Detail: s.Runtime + " " + s.Model})
	}
	for _, d := range decisions {
		add(wshrpc.TimelineEvent{Ts: d.CreatedTs, Kind: "decision", Title: d.Summary})
	}
	for _, d := range dossiers {
		add(wshrpc.TimelineEvent{Ts: d.Updated, Kind: "dossier", Title: d.Objective, Detail: "status: " + d.Status, NavTarget: "vault:" + d.ID})
	}
	sort.SliceStable(evs, func(i, j int) bool { return evs[i].Ts > evs[j].Ts })
	return evs
}

// Delta is the bring-up answer: everything new since sinceMs (Timeline windowed) plus attention
// items raised inside the window — the one leg Timeline does not see.
func Delta(sinceMs int64, runs []*waveobj.Run, sessions []agentsessions.SessionInfo, decisions []DecisionEntry, attention []wshrpc.AttentionItem, dossiers []jarvisdossier.Dossier) []wshrpc.TimelineEvent {
	evs := Timeline(runs, sessions, decisions, dossiers, sinceMs)
	runByID := make(map[string]string, len(runs))
	for _, r := range runs {
		runByID[r.OID] = r.ProjectPath
	}
	for _, a := range attention {
		if a.WaitingSince < sinceMs {
			continue
		}
		evs = append(evs, wshrpc.TimelineEvent{
			Ts: a.WaitingSince, Kind: "attention", Project: runByID[a.RunId],
			Title: a.Source, Detail: a.Action + ": " + a.Text, NavTarget: "run:" + a.RunId,
		})
	}
	sort.SliceStable(evs, func(i, j int) bool { return evs[i].Ts > evs[j].Ts })
	return evs
}
