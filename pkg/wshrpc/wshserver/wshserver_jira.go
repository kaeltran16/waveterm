// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/effortstore"
	"github.com/wavetermdev/waveterm/pkg/jira"
	"github.com/wavetermdev/waveterm/pkg/memroots"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	// git log over every registered project; a slow disk must not hold Check Jira open
	jiraInferTimeout    = 15 * time.Second
	jiraSummaryTimeout  = 60 * time.Second
	jiraShortSHA        = 7
	jiraReportedNote    = "Reported as done in the progress comment."
	jiraNothingToSum    = "No run report or note to summarize, so the summaries were not rewritten."
	jiraHeadlessOffNote = "Headless AI isn't set up, so the summaries were not rewritten."
)

// seams for tests: the live config, the projects registry and the Headless AI runtime
var (
	loadJiraConfig = jira.LoadConfig
	jiraProjects   = func() map[string]string {
		out := map[string]string{}
		for name, path := range memroots.RegistryProjects() {
			out[name] = wavebase.ExpandHomeDirSafe(path)
		}
		return out
	}
	// jiraHeadless returns ok=false when no Headless AI runtime is set up
	jiraHeadless = func(ctx context.Context, prompt string) (string, bool, error) {
		spec, ok := consult.HeadlessSpecForTier(consult.TierCheap)
		if !ok {
			return "", false, nil
		}
		reply, err := consult.Run(ctx, spec, "", prompt, func(string) {})
		return reply, true, err
	}
)

func jiraNow() int64 { return time.Now().UnixMilli() }

func jiraClient() (*jira.Client, jira.Config, error) {
	cfg, err := loadJiraConfig()
	if err != nil {
		return nil, cfg, err
	}
	return jira.New(cfg, nil), cfg, nil
}

// noteJira records a Jira call's outcome for Settings > Jira and passes err through. Jira answering a
// request it refuses for the request's own sake (a missing key, a bad move) still means the connection
// works; only an auth refusal, a server error or no answer marks it failed. Errors that never reached
// Jira say nothing about the connection.
func noteJira(displayName string, err error) error {
	var he *jira.HTTPError
	switch {
	case err == nil:
		jira.NoteConnection(displayName, nil, jiraNow())
	case errors.As(err, &he):
		if he.Status == http.StatusUnauthorized || he.Status == http.StatusForbidden || he.Status >= http.StatusInternalServerError {
			jira.NoteConnection("", err, jiraNow())
		} else {
			jira.NoteConnection("", nil, jiraNow())
		}
	case strings.HasPrefix(err.Error(), jira.CodeUnreachable):
		jira.NoteConnection("", err, jiraNow())
	}
	return err
}

func (ws *WshServer) JiraConnectionCommand(ctx context.Context, data wshrpc.CommandJiraConnectionData) (*wshrpc.JiraConnection, error) {
	cfg, err := loadJiraConfig()
	var nc *jira.NotConfiguredError
	if errors.As(err, &nc) {
		return &wshrpc.JiraConnection{Configured: false, Missing: nc.Missing}, nil
	}
	if err != nil {
		return nil, err
	}
	if data.Test {
		name, err := jira.New(cfg, nil).Myself(ctx)
		if err != nil {
			// Test again reports on the connection itself: every refusal counts, a 404 included
			jira.NoteConnection("", err, jiraNow())
		} else {
			noteJira(name, nil)
		}
	}
	conn := jira.LastConnection()
	conn.Configured = true
	conn.Site = cfg.Site
	return &conn, nil
}

// jiraInference infers the Arc project for each distinct Jira project key in keys.
func jiraInference(ctx context.Context, efforts []*waveobj.Effort, keys []string) map[string]jira.Inference {
	ctx, cancel := context.WithTimeout(ctx, jiraInferTimeout)
	defer cancel()
	projects := jiraProjects()
	out := map[string]jira.Inference{}
	for _, key := range keys {
		pkey := jira.ProjectKey(key)
		if _, done := out[pkey]; done || pkey == "" {
			continue
		}
		out[pkey] = jira.InferProject(pkey, efforts, jira.CommitCounts(ctx, projects, pkey))
	}
	return out
}

func (ws *WshServer) JiraCheckCommand(ctx context.Context) (*wshrpc.CommandJiraCheckRtnData, error) {
	client, cfg, err := jiraClient()
	if err != nil {
		return nil, err
	}
	tickets, err := client.SearchOpen(ctx)
	if noteJira("", err) != nil {
		return nil, err
	}
	now := jiraNow()
	efforts, err := effortstore.GetAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("reading initiatives for Check Jira: %w", err)
	}
	onInitiative := map[string]bool{}
	for _, e := range efforts {
		if key := jira.NormalizeKey(e.Ticket); key != "" {
			onInitiative[key] = true
		}
	}
	rtn := &wshrpc.CommandJiraCheckRtnData{Site: cfg.Site, CheckedTs: now, Tickets: []wshrpc.JiraTicketRow{}}
	var keys []string
	for _, t := range tickets {
		if onInitiative[jira.NormalizeKey(t.Key)] {
			rtn.Covered++
			if err := jira.RecordSeen(ctx, t, "check", now); err != nil {
				return nil, err
			}
			continue
		}
		rtn.Tickets = append(rtn.Tickets, wshrpc.JiraTicketRow{JiraTicket: t})
		keys = append(keys, t.Key)
	}
	inferred := jiraInference(ctx, efforts, keys)
	for i := range rtn.Tickets {
		inf := inferred[jira.ProjectKey(rtn.Tickets[i].Key)]
		rtn.Tickets[i].Project, rtn.Tickets[i].Evidence, rtn.Tickets[i].Sure = inf.Project, inf.Evidence, inf.Sure
	}
	return rtn, nil
}

var jiraShowVias = map[string]bool{"show": true, "refresh": true, "lookup": true}

func (ws *WshServer) JiraShowCommand(ctx context.Context, data wshrpc.CommandJiraShowData) (*wshrpc.CommandJiraShowRtnData, error) {
	via := data.Via
	if via == "" {
		via = "show"
	}
	if !jiraShowVias[via] {
		return nil, fmt.Errorf("EC-INVALID: via %q is not one of show, refresh, lookup", data.Via)
	}
	client, _, err := jiraClient()
	if err != nil {
		return nil, err
	}
	t, err := client.Issue(ctx, data.Key)
	if noteJira("", err) != nil {
		return nil, err
	}
	now := jiraNow()
	if err := jira.RecordSeen(ctx, t, via, now); err != nil {
		return nil, err
	}
	efforts, err := effortstore.GetAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("reading initiatives to infer %s's project: %w", t.Key, err)
	}
	inf := jiraInference(ctx, efforts, []string{t.Key})[jira.ProjectKey(t.Key)]
	return &wshrpc.CommandJiraShowRtnData{Ticket: t, Project: inf.Project, Evidence: inf.Evidence, Sure: inf.Sure, SeenTs: now}, nil
}

// ticketedEffort reads the initiative a post is for, refusing one with no ticket.
func ticketedEffort(ctx context.Context, oid string) (*waveobj.Effort, string, error) {
	e, err := effortstore.Get(ctx, effortstore.BareOID(oid))
	if err != nil {
		return nil, "", err
	}
	key := jira.NormalizeKey(e.Ticket)
	if key == "" {
		return nil, "", errors.New("EC-INVALID: this initiative has no ticket")
	}
	return e, key, nil
}

// jiraFinishers is, per chunk of the initiative, the newest landed run that worked it.
func jiraFinishers(ctx context.Context, effortOID string) (map[string]jira.Finisher, error) {
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return nil, fmt.Errorf("reading runs for the progress comment: %w", err)
	}
	runTs := func(r *waveobj.Run) int64 { return max(r.CompletedTs, r.CreatedTs) }
	newest := map[string]*waveobj.Run{}
	for _, r := range runs {
		ref := r.EffortRef
		if ref == nil || effortstore.BareOID(ref.EffortOID) != effortOID || r.Land == nil || r.Land.State != "landed" {
			continue
		}
		if cur := newest[ref.ChunkLabel]; cur == nil || runTs(r) > runTs(cur) {
			newest[ref.ChunkLabel] = r
		}
	}
	fin := map[string]jira.Finisher{}
	for label, r := range newest {
		f := jira.Finisher{Report: r.Report}
		// "Merged into <branch> as <sha>" needs both; a run with no base branch never landed on one
		if r.BaseBranch != "" && r.Land.Commit != "" {
			f.Branch = r.BaseBranch
			f.Commit = r.Land.Commit[:min(jiraShortSHA, len(r.Land.Commit))]
		}
		fin[label] = f
	}
	return fin, nil
}

func (ws *WshServer) JiraPostDraftCommand(ctx context.Context, data wshrpc.CommandJiraPostDraftData) (*wshrpc.CommandJiraPostDraftRtnData, error) {
	client, _, err := jiraClient()
	if err != nil {
		return nil, err
	}
	e, key, err := ticketedEffort(ctx, data.EffortOID)
	if err != nil {
		return nil, err
	}
	t, err := client.Issue(ctx, key)
	if noteJira("", err) != nil {
		return nil, err
	}
	transitions, err := client.Transitions(ctx, key)
	if noteJira("", err) != nil {
		return nil, err
	}
	if err := jira.RecordSeen(ctx, t, "post", jiraNow()); err != nil {
		return nil, err
	}
	fin, err := jiraFinishers(ctx, e.OID)
	if err != nil {
		return nil, err
	}
	rtn := &wshrpc.CommandJiraPostDraftRtnData{
		Key: key, Status: t.Status, Comment: jira.CodeDraft(e, fin), DoneChunks: jira.DoneSincePost(e),
		Transitions: transitions,
	}
	if e.Jira != nil {
		rtn.LastPost = e.Jira.Clone().LastPost
	}
	return rtn, nil
}

// hasSummarySource reports whether a Done chunk has a run report or a note for the model to rewrite.
func hasSummarySource(e *waveobj.Effort, label string, fin map[string]jira.Finisher) bool {
	if strings.TrimSpace(fin[label].Report) != "" {
		return true
	}
	for _, c := range e.Chunks {
		if c.Label == label {
			return len(c.Notes) > 0
		}
	}
	return false
}

func (ws *WshServer) JiraPostSummariesCommand(ctx context.Context, data wshrpc.CommandJiraPostDraftData) (*wshrpc.CommandJiraPostSummariesRtnData, error) {
	if _, err := loadJiraConfig(); err != nil {
		return nil, err
	}
	e, _, err := ticketedEffort(ctx, data.EffortOID)
	if err != nil {
		return nil, err
	}
	fin, err := jiraFinishers(ctx, e.OID)
	if err != nil {
		return nil, err
	}
	code := jira.CodeDraft(e, fin)
	kept := func(reason string) *wshrpc.CommandJiraPostSummariesRtnData {
		return &wshrpc.CommandJiraPostSummariesRtnData{Comment: code, Reason: reason}
	}
	var labels []string
	for _, label := range jira.DoneSincePost(e) {
		if hasSummarySource(e, label, fin) {
			labels = append(labels, label)
		}
	}
	if len(labels) == 0 {
		return kept(jiraNothingToSum), nil
	}
	sctx, cancel := context.WithTimeout(ctx, jiraSummaryTimeout)
	defer cancel()
	reply, ok, err := jiraHeadless(sctx, jira.SummariesPrompt(e, labels, fin))
	if !ok {
		return kept(jiraHeadlessOffNote), nil
	}
	if errors.Is(sctx.Err(), context.DeadlineExceeded) {
		return kept("Headless AI took longer than a minute, so the summaries were not rewritten."), nil
	}
	if err != nil {
		log.Printf("jira: drafting summaries for %s: %v\n", e.Ticket, err)
		return kept(oneLine("Headless AI failed, so the summaries were not rewritten: " + err.Error())), nil
	}
	sums, err := jira.ParseSummaries(reply)
	if err != nil {
		log.Printf("jira: reading the summaries for %s: %v\n", e.Ticket, err)
		return kept("Headless AI's reply could not be read, so the summaries were not rewritten."), nil
	}
	return &wshrpc.CommandJiraPostSummariesRtnData{Comment: jira.DraftWithSummaries(e, fin, sums), Rewritten: true}, nil
}

func oneLine(s string) string {
	first, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return first
}

// jiraMove is the transition a post makes, resolved before anything is posted.
type jiraMove struct {
	id, to string
}

func resolveMove(ctx context.Context, client *jira.Client, key, id string) (*jiraMove, error) {
	if id == "" {
		return nil, nil
	}
	transitions, err := client.Transitions(ctx, key)
	if noteJira("", err) != nil {
		return nil, err
	}
	for _, t := range transitions {
		if t.ID == id {
			return &jiraMove{id: t.ID, to: t.To}, nil
		}
	}
	return nil, fmt.Errorf("EC-INVALID: %s can't move by transition %s from its current status", key, id)
}

// checkReported refuses labels the initiative doesn't have, before anything reaches Jira.
func checkReported(e *waveobj.Effort, labels []string) error {
	for _, label := range labels {
		found := false
		for _, c := range e.Chunks {
			found = found || c.Label == label
		}
		if !found {
			return fmt.Errorf("EC-INVALID: this initiative has no part named %q", label)
		}
	}
	return nil
}

// recordPost writes what a posted comment reported: a note on each reported chunk not already in a
// post, the initiative's own note and LastPost. It runs as soon as the comment exists, so a failed move
// or a retry never reports a chunk twice.
func recordPost(ctx context.Context, oid string, labels []string, t wshrpc.JiraTicket, post waveobj.EffortJiraPost) error {
	return effortstore.Update(ctx, oid, func(e *waveobj.Effort) error {
		reported := map[string]bool{}
		for _, l := range jira.DoneSincePost(e) {
			reported[l] = true
		}
		for _, label := range labels {
			for i := range e.Chunks {
				c := &e.Chunks[i]
				if c.Label != label || !reported[label] {
					continue
				}
				c.Notes = append(c.Notes, waveobj.EffortNote{Ts: post.Ts, Text: jiraReportedNote, Author: "you", JiraPost: post.CommentURL})
				c.UpdatedTs = post.Ts
			}
		}
		e.Notes = append(e.Notes, waveobj.EffortNote{
			Ts: post.Ts, Text: fmt.Sprintf("Posted progress to %s.", jira.NormalizeKey(e.Ticket)), Author: "you", JiraPost: post.CommentURL,
		})
		if e.Jira == nil {
			e.Jira = jira.CopyOf(t, "post", post.Ts, nil)
		}
		e.Jira.LastPost = &post
		return nil
	})
}

// recordMove adds the move's outcome to the post recordPost wrote.
func recordMove(ctx context.Context, oid string, post waveobj.EffortJiraPost) error {
	return effortstore.Update(ctx, oid, func(e *waveobj.Effort) error {
		if post.MovedTo != "" {
			for i := range e.Notes {
				n := &e.Notes[i]
				if n.JiraPost == post.CommentURL && n.Ts == post.Ts {
					n.Text += fmt.Sprintf(" Moved %s to %s.", post.From, post.MovedTo)
				}
			}
		}
		if e.Jira != nil {
			e.Jira.LastPost = &post
		}
		return nil
	})
}

func (ws *WshServer) JiraPostCommand(ctx context.Context, data wshrpc.CommandJiraPostData) (*wshrpc.CommandJiraPostRtnData, error) {
	client, _, err := jiraClient()
	if err != nil {
		return nil, err
	}
	e, key, err := ticketedEffort(ctx, data.EffortOID)
	if err != nil {
		return nil, err
	}
	comment := strings.TrimSpace(data.Comment)
	if comment == "" {
		return nil, errors.New("EC-INVALID: the comment is empty")
	}
	if err := checkReported(e, data.DoneChunks); err != nil {
		return nil, err
	}
	t, err := client.Issue(ctx, key)
	if noteJira("", err) != nil {
		return nil, err
	}
	move, err := resolveMove(ctx, client, key, data.TransitionID)
	if err != nil {
		return nil, err
	}
	url, err := client.AddComment(ctx, key, comment)
	if noteJira("", err) != nil {
		return nil, err
	}
	post := waveobj.EffortJiraPost{Ts: jiraNow(), CommentURL: url, From: t.Status}
	if err := recordPost(ctx, e.OID, data.DoneChunks, t, post); err != nil {
		return nil, fmt.Errorf("the comment is on Jira (%s), but Arc could not record it: %w", url, err)
	}
	rtn := &wshrpc.CommandJiraPostRtnData{CommentURL: url, PostedTs: post.Ts, From: t.Status, Status: t.Status}
	if move == nil {
		logSeenAfterPost(ctx, t)
		return rtn, nil
	}
	if err := noteJira("", client.DoTransition(ctx, key, move.id)); err != nil {
		post.MoveError = err.Error()
		rtn.MoveError = post.MoveError
	} else {
		post.MovedTo = move.to
		rtn.MovedTo, rtn.Status = move.to, move.to
	}
	if err := recordMove(ctx, e.OID, post); err != nil {
		return nil, fmt.Errorf("the comment is on Jira (%s), but Arc could not record the move: %w", url, err)
	}
	// Jira's own status after the move, above all when it refused it
	after, err := client.Issue(ctx, key)
	if noteJira("", err) != nil {
		log.Printf("jira: re-reading %s after the post: %v\n", key, err)
		return rtn, nil
	}
	rtn.Status = after.Status
	logSeenAfterPost(ctx, after)
	return rtn, nil
}

// logSeenAfterPost refreshes the copy once the post is recorded; failing it must not turn a post that
// landed into an error, since the post is already on Jira and in the record.
func logSeenAfterPost(ctx context.Context, t wshrpc.JiraTicket) {
	if err := jira.RecordSeen(ctx, t, "post", jiraNow()); err != nil {
		log.Printf("jira: refreshing %s's copy after the post: %v\n", t.Key, err)
	}
}
