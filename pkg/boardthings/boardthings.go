// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardthings

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/effortstore"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// MaxThingChars caps a thing's text; the newest end is kept, since what a draw asks about is the latest.
const MaxThingChars = 60000

const cutMarker = "[earlier part cut]\n"

// Read renders the thing src names as the text the scribe reads. Transcripts (agent, session) read only the
// turns after sinceTs and return the last turn's ts as the next cursor; with nothing new the text is empty and
// the cursor stays. A run, initiative or record is read whole, and its cursor is sinceTs. reading says what was
// read, for the scribe's status.
func Read(ctx context.Context, src wshrpc.BoardSource, sinceTs int64) (text, reading string, cursorTs int64, err error) {
	switch src.Kind {
	case "agent":
		path, runtime, err := agentTranscript(ctx, src.Ref)
		if err != nil {
			return "", "", sinceTs, fmt.Errorf("reading agent %s: %w", src.Ref, err)
		}
		text, reading, cursorTs = readTurns(path, runtime, sinceTs)
	case "session":
		text, reading, cursorTs = readTurns(src.Path, src.Runtime, sinceTs)
	case "run":
		text, err = readRun(ctx, src.ChannelId, src.Ref)
		reading, cursorTs = "the run, read whole", sinceTs
	case "effort":
		text, err = readEffort(ctx, src.Ref)
		reading, cursorTs = "the initiative, read whole", sinceTs
	case "record":
		text, err = readRecord(ctx, src.Ref)
		reading, cursorTs = "the record, read whole", sinceTs
	default:
		return "", "", sinceTs, fmt.Errorf("unknown board source kind %q (ref %q)", src.Kind, src.Ref)
	}
	if err != nil {
		return "", "", sinceTs, fmt.Errorf("reading %s %s: %w", src.Kind, src.Ref, err)
	}
	return capNewest(text), reading, cursorTs, nil
}

// agentTranscript is the transcript path the agent tab's first block recorded, and the tab's runtime.
func agentTranscript(ctx context.Context, tabId string) (path, runtime string, err error) {
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return "", "", err
	}
	if tab == nil || len(tab.BlockIds) == 0 {
		return "", "", fmt.Errorf("no agent tab %s", tabId)
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		return "", "", err
	}
	if block == nil {
		return "", "", fmt.Errorf("no block %s", tab.BlockIds[0])
	}
	path = block.Meta.GetString(waveobj.MetaKey_AgentTranscriptPath, "")
	if path == "" {
		return "", "", fmt.Errorf("the agent has no transcript yet")
	}
	return path, tab.Meta.GetString(waveobj.MetaKey_SessionAgent, ""), nil
}

func readTurns(path, runtime string, sinceTs int64) (text, reading string, cursorTs int64) {
	turns := agentsessions.TurnsSince(path, runtime, sinceTs)
	if len(turns) == 0 {
		return "", "", sinceTs
	}
	paras := make([]string, len(turns))
	for i, t := range turns {
		who := "Agent"
		if t.Speaker == "user" {
			who = "User"
		}
		paras[i] = who + ": " + t.Text
	}
	last := turns[len(turns)-1].Ts
	return strings.Join(paras, "\n\n"), "the " + time.UnixMilli(last).Format("15:04") + " turn end", last
}

func readRun(ctx context.Context, channelId, runId string) (string, error) {
	run, err := wstore.GetRun(ctx, channelId, runId)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Run %s\nGoal: %s\nStatus: %s\n", run.ID, strings.TrimSpace(run.Goal), run.Status)
	if tg := runTaskGroup(ctx, run); tg != nil {
		if tg.Title != "" {
			fmt.Fprintf(&b, "Plan: %s\n", tg.Title)
		}
		b.WriteString("\nTasks:\n")
		for _, t := range tg.Tasks {
			fmt.Fprintf(&b, "- %s %s [%s]", t.ID, t.Label, t.State)
			if len(t.Deps) > 0 {
				fmt.Fprintf(&b, " after %s", strings.Join(t.Deps, ", "))
			}
			b.WriteString("\n")
		}
	} else if len(run.Phases) > 0 {
		b.WriteString("\nPhases:\n")
		for _, p := range run.Phases {
			fmt.Fprintf(&b, "- %s [%s]\n", p.Kind, p.State)
		}
	}
	if r := strings.TrimSpace(run.Report); r != "" {
		fmt.Fprintf(&b, "\nReport:\n%s\n", r)
	}
	return strings.TrimSpace(b.String()), nil
}

// runTaskGroup is an orchestrator run's dag, nil for a run without one.
func runTaskGroup(ctx context.Context, run *waveobj.Run) *waveobj.TaskGroup {
	oref, err := waveobj.ParseORef(run.DagORef)
	if err != nil {
		return nil
	}
	obj, err := wstore.DBGetORef(ctx, oref)
	if err != nil {
		return nil
	}
	tg, _ := obj.(*waveobj.TaskGroup)
	return tg
}

func readEffort(ctx context.Context, oid string) (string, error) {
	e, err := effortstore.Get(ctx, oid)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Initiative: %s\nStatus: %s\n", e.Title, e.Status)
	if e.Ticket != "" {
		fmt.Fprintf(&b, "Ticket: %s\n", e.Ticket)
	}
	if len(e.Chunks) > 0 {
		b.WriteString("\nChunks:\n")
		for _, c := range e.Chunks {
			fmt.Fprintf(&b, "- %s [%s]", c.Label, c.Status)
			if c.Stage != "" {
				fmt.Fprintf(&b, " (stage: %s)", c.Stage)
			}
			b.WriteString("\n")
			for _, n := range c.Notes {
				fmt.Fprintf(&b, "  note: %s\n", oneLine(n.Text))
			}
		}
	}
	if len(e.Notes) > 0 {
		b.WriteString("\nNotes:\n")
		for _, n := range e.Notes {
			fmt.Fprintf(&b, "- %s\n", oneLine(n.Text))
		}
	}
	return strings.TrimSpace(b.String()), nil
}

// readRecord loads a dossier and the decisions linking back to it, as the record RPCs (GetDossierCommand) do.
func readRecord(ctx context.Context, id string) (string, error) {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return "", fmt.Errorf("opening vault: %w", err)
	}
	d, err := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Record %s\nObjective: %s\nStatus: %s\n", d.ID, d.Objective, d.Status)
	if d.Ticket != "" {
		fmt.Fprintf(&b, "Ticket: %s\n", d.Ticket)
	}
	if s := strings.TrimSpace(d.State); s != "" {
		fmt.Fprintf(&b, "\nState:\n%s\n", s)
	}
	if len(d.Blockers) > 0 {
		fmt.Fprintf(&b, "\nBlockers:\n- %s\n", strings.Join(d.Blockers, "\n- "))
	}
	r := v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollDecisions}})
	nodes, err := r.Query(wavevault.Filter{HasLink: id})
	if err != nil {
		return "", fmt.Errorf("querying decisions: %w", err)
	}
	var decisions []string
	for _, n := range nodes {
		dec, err := jarvisdossier.LoadDecision(r, n.ID)
		if err != nil {
			continue
		}
		line := "- " + dec.Summary
		if rat := strings.TrimSpace(dec.Rationale); rat != "" {
			line += ": " + oneLine(rat)
		}
		decisions = append(decisions, line)
	}
	if len(decisions) > 0 {
		fmt.Fprintf(&b, "\nDecisions:\n%s\n", strings.Join(decisions, "\n"))
	}
	return strings.TrimSpace(b.String()), nil
}

func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// capNewest keeps the last MaxThingChars characters of text, cut on a rune boundary, behind cutMarker.
func capNewest(text string) string {
	if utf8.RuneCountInString(text) <= MaxThingChars {
		return text
	}
	r := []rune(text)
	return cutMarker + string(r[len(r)-MaxThingChars:])
}
