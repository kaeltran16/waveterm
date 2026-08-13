// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisstate

import (
	"context"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/memdistill"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// sessionWindowDays / sessionLimit bound the transcript leg: the operators' sessions are scanned on
// every ask, so the window is a cost/recency tradeoff, not a fidelity choice.
const (
	sessionWindowDays = 30
	sessionLimit      = 200
)

// FetchWorkState fetches every ledger leg and derives the per-project work state. Each leg's read
// failure degrades that leg to empty and is reported in Sources — the "never ran vs ran and found
// nothing" discipline applied to the ledger; a leg failure never fails the whole query.
func FetchWorkState(ctx context.Context, projectFilter string, sinceMs int64) (wshrpc.WorkState, error) {
	st := wshrpc.WorkState{Sources: wshrpc.SourceHealth{Attention: "volatile"}}

	var runs []*waveobj.Run
	chans, err := wstore.GetChannels(ctx)
	if err == nil {
		for _, ch := range chans {
			cr, cerr := wstore.GetChannelRuns(ctx, ch.OID)
			if cerr != nil {
				continue // one bad channel must not sink the leg
			}
			runs = append(runs, cr...)
		}
		st.Sources.Runs = true
	}
	if err != nil {
		st.Sources.Runs = false
	}

	var sessions []agentsessions.SessionInfo
	if s, serr := agentsessions.ScanSessions(sessionWindowDays, sessionLimit); serr == nil {
		sessions = s
		st.Sources.Sessions = true
	}

	var attention []wshrpc.AttentionItem
	if a, aerr := jarvis.GatherAttention(ctx); aerr == nil {
		attention = a
	}

	var dossiers []jarvisdossier.Dossier
	var decisions []DecisionEntry
	if v, verr := wavevault.OpenVault(ctx); verr == nil {
		r := v.Retriever(wavevault.AllScope())
		if nodes, qerr := r.Query(wavevault.Filter{}); qerr == nil {
			for _, n := range nodes {
				switch n.Collection {
				case wavevault.CollTasks:
					if d, derr := jarvisdossier.LoadDossier(r, n.ID); derr == nil {
						dossiers = append(dossiers, *d)
					}
				case wavevault.CollDecisions:
					if d, derr := jarvisdossier.LoadDecision(r, n.ID); derr == nil {
						decisions = append(decisions, DecisionEntry{ID: d.ID, Summary: d.Summary, CreatedTs: d.Created})
					}
				}
			}
			st.Sources.Dossiers = true
		}
	}

	active := ActiveWork(runs, sessions, attention, dossiers)
	shipped := Shipped(runs, 0)
	timeline := Timeline(runs, sessions, decisions, dossiers, 0)
	delta := Delta(sinceMs, runs, sessions, decisions, attention, dossiers)

	byProject := map[string]*wshrpc.ProjectWork{}
	order := []string{}
	projectOf := func(p string) string {
		key := strings.TrimRight(strings.ReplaceAll(p, "\\", "/"), "/")
		if key == "" {
			key = "(none)"
		}
		if _, ok := byProject[key]; !ok {
			byProject[key] = &wshrpc.ProjectWork{Project: key}
			order = append(order, key)
		}
		return key
	}
	inProject := func(p string) bool {
		return projectFilter == "" || projectOf(p) == projectOf(projectFilter)
	}
	for _, it := range active {
		if !inProject(it.Project) {
			continue
		}
		key := projectOf(it.Project)
		byProject[key].Active = append(byProject[key].Active, it)
	}
	for _, it := range shipped {
		if !inProject(it.Project) {
			continue
		}
		key := projectOf(it.Project)
		byProject[key].Shipped = append(byProject[key].Shipped, it)
	}
	for _, e := range timeline {
		if !inProject(e.Project) {
			continue
		}
		key := projectOf(e.Project)
		byProject[key].Events = append(byProject[key].Events, e)
	}
	for _, e := range delta {
		if !inProject(e.Project) {
			continue
		}
		key := projectOf(e.Project)
		byProject[key].Delta = append(byProject[key].Delta, e)
	}
	sort.Strings(order)
	for _, key := range order {
		st.Projects = append(st.Projects, *byProject[key])
	}
	return st, nil
}

// FetchCaptureStatus reads the capture-pipeline accounting for `wsh jarvis status`. Every section
// degrades to "unavailable" rather than failing the command.
func FetchCaptureStatus(ctx context.Context) (wshrpc.CaptureStatus, error) {
	st := wshrpc.CaptureStatus{NoteCounts: map[string]int{}, DistillQueue: []wshrpc.CwdQueueWire{}}
	if v, err := wavevault.OpenVault(ctx); err == nil {
		r := v.Retriever(wavevault.AllScope())
		if nodes, qerr := r.Query(wavevault.Filter{}); qerr == nil {
			for _, n := range nodes {
				st.NoteCounts[n.Collection]++
			}
		}
	}
	if ix, err := jarvisembed.OpenIndex(ctx); err == nil {
		st.IndexAvailable = ix.Available()
		ix.Close()
	} else {
		st.IndexError = err.Error()
	}
	if qs, err := memdistill.QueueSummary(); err == nil {
		for _, q := range qs {
			var last *wshrpc.PassRecordWire
			if q.LastPass != nil {
				last = &wshrpc.PassRecordWire{Ts: q.LastPass.Ts, Sessions: q.LastPass.Sessions, Committed: q.LastPass.Committed, Queued: q.LastPass.Queued}
			}
			st.DistillQueue = append(st.DistillQueue, wshrpc.CwdQueueWire{Cwd: q.Cwd, Pending: q.Pending, LastPass: last})
		}
	}
	return st, nil
}
