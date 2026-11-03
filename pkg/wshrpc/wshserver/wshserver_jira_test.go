// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/effortstore"
	"github.com/wavetermdev/waveterm/pkg/jira"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// fakeJira answers the REST v3 calls pkg/jira makes, for issues keyed by key with a status each.
type fakeJira struct {
	mu          sync.Mutex
	status      map[string]string // key -> status name
	calls       []string
	comments    []string // plain text of each posted comment
	failComment int      // status to answer a comment with; 0 posts it
	failMove    string   // Jira's message refusing every move; "" allows it
	attachments []any    // every issue's attachment field
}

var fakeStatusIDs = map[string]string{"To Do": "11", "In Progress": "21", "Done": "41"}

var fakeCategories = map[string]string{"To Do": "new", "In Progress": "indeterminate", "Done": "done"}

func (f *fakeJira) issueJSON(key string) map[string]any {
	st := f.status[key]
	return map[string]any{"key": key, "fields": map[string]any{
		"summary":    "Summary of " + key,
		"issuetype":  map[string]any{"name": "Story"},
		"status":     map[string]any{"name": st, "statusCategory": map[string]any{"key": fakeCategories[st]}},
		"updated":    "2026-11-01T10:00:00.000+0000",
		"attachment": f.attachments,
	}}
}

func adfText(v any) string {
	var b strings.Builder
	var walk func(any)
	walk = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			if s, ok := t["text"].(string); ok {
				b.WriteString(s)
			}
			walk(t["content"])
		case []any:
			for _, x := range t {
				walk(x)
			}
		}
	}
	walk(v)
	return b.String()
}

func (f *fakeJira) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	path := strings.TrimPrefix(r.URL.Path, "/rest/api/3")
	reply := func(status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	refuse := func(status int, msg string) { reply(status, map[string]any{"errorMessages": []string{msg}}) }
	switch {
	case path == "/myself":
		reply(200, map[string]any{"displayName": "Fixture User"})
	case path == "/field":
		reply(200, []any{})
	case strings.HasPrefix(path, "/attachment/content/"):
		w.Write([]byte("DATA-" + strings.TrimPrefix(path, "/attachment/content/")))
	case path == "/search/jql":
		var issues []any
		for key, st := range f.status {
			if st != "Done" {
				issues = append(issues, f.issueJSON(key))
			}
		}
		reply(200, map[string]any{"issues": issues})
	case strings.HasPrefix(path, "/issue/"):
		parts := strings.Split(strings.TrimPrefix(path, "/issue/"), "/")
		key := parts[0]
		if _, ok := f.status[key]; !ok {
			refuse(404, "Issue does not exist or you do not have permission to see it.")
			return
		}
		sub := ""
		if len(parts) > 1 {
			sub = parts[1]
		}
		switch {
		case sub == "" && r.Method == http.MethodGet:
			reply(200, f.issueJSON(key))
		case sub == "transitions" && r.Method == http.MethodGet:
			var ts []any
			for name, id := range fakeStatusIDs {
				if name != f.status[key] {
					ts = append(ts, map[string]any{"id": id, "name": name, "to": map[string]any{"name": name}})
				}
			}
			reply(200, map[string]any{"transitions": ts})
		case sub == "transitions" && r.Method == http.MethodPost:
			if f.failMove != "" {
				refuse(400, f.failMove)
				return
			}
			var body struct {
				Transition struct {
					ID string `json:"id"`
				} `json:"transition"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			for name, id := range fakeStatusIDs {
				if id == body.Transition.ID {
					f.status[key] = name
				}
			}
			w.WriteHeader(204)
		case sub == "comment" && r.Method == http.MethodPost:
			if f.failComment != 0 {
				refuse(f.failComment, "Comment refused")
				return
			}
			var body struct {
				Body any `json:"body"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			f.comments = append(f.comments, adfText(body.Body))
			reply(201, map[string]any{"id": "10000"})
		default:
			refuse(405, "unexpected "+r.Method+" "+path)
		}
	default:
		refuse(404, "unexpected "+r.Method+" "+path)
	}
}

func (f *fakeJira) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// useFakeJira points the handlers at a fake Jira holding status (key -> status), with a temp effort
// root and no registered projects.
func useFakeJira(t *testing.T, status map[string]string) (*fakeJira, string) {
	t.Helper()
	f := &fakeJira{status: status}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	t.Cleanup(effortstore.UseRootForTest(t.TempDir()))
	prevCfg, prevProjects := loadJiraConfig, jiraProjects
	loadJiraConfig = func() (jira.Config, error) {
		return jira.Config{Site: srv.URL, Email: "me@example.com", Token: "tok"}, nil
	}
	jiraProjects = func() map[string]string { return map[string]string{} }
	t.Cleanup(func() { loadJiraConfig, jiraProjects = prevCfg, prevProjects })
	return f, srv.URL
}

func mkTicketEffort(t *testing.T, e *waveobj.Effort) string {
	t.Helper()
	if err := effortstore.Create(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	return e.OID
}

func getEffort(t *testing.T, oid string) *waveobj.Effort {
	t.Helper()
	e, err := effortstore.Get(context.Background(), oid)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestJiraCheckDropsTicketsOnInitiatives(t *testing.T) {
	useFakeJira(t, map[string]string{"PAY-1": "To Do", "PAY-2": "In Progress", "PAY-3": "To Do", "PAY-4": "Done"})
	mkTicketEffort(t, &waveobj.Effort{Title: "a", Ticket: "PAY-1"})
	mkTicketEffort(t, &waveobj.Effort{Title: "b", Ticket: "pay-2", Status: "archived"})
	got, err := (&WshServer{}).JiraCheckCommand(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tickets) != 1 || got.Tickets[0].Key != "PAY-3" || got.Covered != 2 {
		t.Fatalf("tickets %+v, covered %d", got.Tickets, got.Covered)
	}
	row := got.Tickets[0]
	if row.Sure || row.Project != "" || row.Evidence != "No history for PAY" {
		t.Errorf("inference = %+v", row)
	}
	if got.Site == "" || got.CheckedTs == 0 {
		t.Errorf("site %q checkedts %d", got.Site, got.CheckedTs)
	}
}

func TestJiraCheckRefreshesCoveredCopies(t *testing.T) {
	useFakeJira(t, map[string]string{"PAY-1": "In Progress"})
	post := &waveobj.EffortJiraPost{Ts: 1, CommentURL: "u", From: "To Do"}
	oid := mkTicketEffort(t, &waveobj.Effort{Title: "a", Ticket: "PAY-1", Jira: &waveobj.EffortJira{Status: "To Do", LastPost: post}})
	if _, err := (&WshServer{}).JiraCheckCommand(context.Background()); err != nil {
		t.Fatal(err)
	}
	j := getEffort(t, oid).Jira
	if j.Status != "In Progress" || j.SeenVia != "check" || j.Summary != "Summary of PAY-1" || !reflect.DeepEqual(j.LastPost, post) {
		t.Fatalf("copy = %+v", j)
	}
}

func TestJiraShowRecordsSeenOnEveryMatchingEffort(t *testing.T) {
	useFakeJira(t, map[string]string{"PAY-1": "To Do"})
	a := mkTicketEffort(t, &waveobj.Effort{Title: "a", Ticket: "PAY-1"})
	b := mkTicketEffort(t, &waveobj.Effort{Title: "b", Ticket: "pay-1"})
	other := mkTicketEffort(t, &waveobj.Effort{Title: "c", Ticket: "PAY-10"})
	got, err := (&WshServer{}).JiraShowCommand(context.Background(), wshrpc.CommandJiraShowData{Key: " pay-1 ", Via: "refresh"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Ticket.Key != "PAY-1" || got.SeenTs == 0 || got.Evidence != "No history for PAY" || got.Sure {
		t.Fatalf("show = %+v", got)
	}
	for _, oid := range []string{a, b} {
		if j := getEffort(t, oid).Jira; j == nil || j.SeenVia != "refresh" || j.SeenTs != got.SeenTs {
			t.Errorf("effort %s copy = %+v", oid, j)
		}
	}
	if j := getEffort(t, other).Jira; j != nil {
		t.Errorf("PAY-10 got PAY-1's copy: %+v", j)
	}
}

func TestJiraShowRefusesNonKeyWithoutCalling(t *testing.T) {
	f, _ := useFakeJira(t, map[string]string{})
	_, err := (&WshServer{}).JiraShowCommand(context.Background(), wshrpc.CommandJiraShowData{Key: "refund flow"})
	if err == nil || !strings.Contains(err.Error(), "not a Jira issue key") {
		t.Fatalf("err = %v", err)
	}
	for _, c := range f.calls {
		if strings.Contains(c, "/issue/") {
			t.Errorf("a non-key reached Jira: %s", c)
		}
	}
}

func TestJiraShowNotFoundKeepsJirasMessage(t *testing.T) {
	useFakeJira(t, map[string]string{})
	_, err := (&WshServer{}).JiraShowCommand(context.Background(), wshrpc.CommandJiraShowData{Key: "PAY-9", Via: "lookup"})
	if err == nil || !strings.HasPrefix(err.Error(), "EC-JIRA-HTTP 404: Issue does not exist") {
		t.Fatalf("err = %v", err)
	}
}

func TestJiraAttachmentReadOnlyTheTicketsUnderTheCap(t *testing.T) {
	f, _ := useFakeJira(t, map[string]string{"PAY-1": "To Do"})
	f.attachments = []any{
		map[string]any{"id": "10001", "filename": "a.png", "mimeType": "image/png", "size": 10},
		map[string]any{"id": "10002", "filename": "big.mov", "mimeType": "video/quicktime", "size": jira.AttachmentMaxBytes + 1},
	}
	ws := &WshServer{}
	ctx := context.Background()
	got, err := ws.JiraAttachmentReadCommand(ctx, wshrpc.CommandJiraAttachmentReadData{Key: "pay-1", ID: "10001"})
	if err != nil {
		t.Fatal(err)
	}
	if data, _ := base64.StdEncoding.DecodeString(got.Data64); string(data) != "DATA-10001" || got.Attachment.Filename != "a.png" {
		t.Fatalf("read = %+v (data %q)", got.Attachment, data)
	}
	contentCalls := func() int {
		n := 0
		for _, c := range f.calls {
			if strings.Contains(c, "/attachment/content/") {
				n++
			}
		}
		return n
	}
	before := contentCalls()
	if _, err := ws.JiraAttachmentReadCommand(ctx, wshrpc.CommandJiraAttachmentReadData{Key: "PAY-1", ID: "99"}); err == nil || !strings.Contains(err.Error(), `PAY-1 has no attachment "99"`) {
		t.Errorf("foreign id: err = %v", err)
	}
	if _, err := ws.JiraAttachmentReadCommand(ctx, wshrpc.CommandJiraAttachmentReadData{Key: "PAY-1", ID: "10002"}); err == nil || !strings.HasPrefix(err.Error(), jira.CodeTooLarge) {
		t.Errorf("over the cap: err = %v", err)
	}
	if n := contentCalls(); n != before {
		t.Errorf("%d downloads for refused reads", n-before)
	}
	list, err := ws.JiraAttachmentsCommand(ctx, wshrpc.CommandJiraAttachmentsData{Key: "pay-1"})
	if err != nil || list.Key != "PAY-1" || len(list.Attachments) != 2 {
		t.Fatalf("list = %+v, %v", list, err)
	}
}

func TestSetTicketClearsStaleCopy(t *testing.T) {
	useFakeJira(t, map[string]string{"PAY-2": "In Progress"})
	ctx := context.Background()
	ws := &WshServer{}
	oid := mkTicketEffort(t, &waveobj.Effort{Title: "a", Ticket: "PAY-1", Jira: &waveobj.EffortJira{Summary: "Summary of PAY-1"}})
	setTicket := func(key string) *waveobj.Effort {
		t.Helper()
		got, err := ws.EffortMutateCommand(ctx, wshrpc.CommandEffortMutateData{EffortOID: oid, Ops: []wshrpc.EffortOp{{Op: "setTicket", Ticket: key}}})
		if err != nil {
			t.Fatal(err)
		}
		return got.Effort
	}
	if e := setTicket("PAY-77"); e.Jira != nil {
		t.Fatalf("an unseen key kept the old copy: %+v", e.Jira)
	}
	if _, err := ws.JiraShowCommand(ctx, wshrpc.CommandJiraShowData{Key: "PAY-2"}); err != nil {
		t.Fatal(err)
	}
	if e := setTicket("pay-2"); e.Jira == nil || e.Jira.Summary != "Summary of PAY-2" || e.Jira.SeenVia != "lookup" {
		t.Fatalf("a seen key has copy %+v", e.Jira)
	}
	if e := setTicket(""); e.Jira != nil {
		t.Fatalf("clearing the ticket kept a copy: %+v", e.Jira)
	}
}

func TestCreateWithTicketAttachesCachedCopy(t *testing.T) {
	useFakeJira(t, map[string]string{"PAY-5": "To Do"})
	ctx := context.Background()
	ws := &WshServer{}
	show, err := ws.JiraShowCommand(ctx, wshrpc.CommandJiraShowData{Key: "PAY-5"})
	if err != nil {
		t.Fatal(err)
	}
	rtn, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "Refunds", Ticket: "PAY-5"})
	if err != nil {
		t.Fatal(err)
	}
	j := getEffort(t, rtn.EffortOID).Jira
	if j == nil || j.Summary != "Summary of PAY-5" || j.SeenVia != "make" || j.SeenTs != show.SeenTs {
		t.Fatalf("copy = %+v", j)
	}
	plain, err := ws.EffortCreateCommand(ctx, wshrpc.CommandEffortCreateData{Title: "No ticket"})
	if err != nil {
		t.Fatal(err)
	}
	if j := getEffort(t, plain.EffortOID).Jira; j != nil {
		t.Errorf("an initiative with no ticket has a copy: %+v", j)
	}
}

func postEffort(t *testing.T) string {
	t.Helper()
	return mkTicketEffort(t, &waveobj.Effort{Title: "Refunds", Ticket: "PAY-1", Chunks: []waveobj.EffortChunk{
		{Label: "Build", Status: "done", Notes: []waveobj.EffortNote{{Ts: 1, Text: "built the refund endpoint"}}},
		{Label: "Ship", Status: "active"},
		{Label: "Docs", Status: "pending"},
	}})
}

func seedFinishingRun(t *testing.T, effortOID, chunk string) {
	t.Helper()
	ctx := context.Background()
	run := &waveobj.Run{
		OID: "jira-landed-" + effortOID, Goal: "build", Status: "done", BaseBranch: "main", CreatedTs: 10, CompletedTs: 20,
		Report:    "Refunds post to the ledger.\n\nDetails follow.",
		Land:      &waveobj.RunLand{State: "landed", Commit: "3e91a0c55aa"},
		EffortRef: &waveobj.RunEffortRef{EffortOID: effortOID, ChunkLabel: chunk},
	}
	run.ID = run.OID
	if err := wstore.DBInsert(ctx, run); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { wstore.DBDelete(context.Background(), waveobj.OType_Run, run.OID) })
}

func TestJiraPostRecordsNotesAndLastPost(t *testing.T) {
	f, _ := useFakeJira(t, map[string]string{"PAY-1": "To Do"})
	ctx := context.Background()
	ws := &WshServer{}
	oid := postEffort(t)
	seedFinishingRun(t, oid, "Build")
	draft, err := ws.JiraPostDraftCommand(ctx, wshrpc.CommandJiraPostDraftData{EffortOID: "effort:" + oid})
	if err != nil {
		t.Fatal(err)
	}
	if draft.Key != "PAY-1" || draft.Status != "To Do" || !reflect.DeepEqual(draft.DoneChunks, []string{"Build"}) || len(draft.Transitions) != 2 || draft.LastPost != nil {
		t.Fatalf("draft = %+v", draft)
	}
	if !strings.Contains(draft.Comment, "- Build. Refunds post to the ledger. Merged into main as 3e91a0c.") {
		t.Fatalf("draft comment:\n%s", draft.Comment)
	}
	got, err := ws.JiraPostCommand(ctx, wshrpc.CommandJiraPostData{EffortOID: oid, Comment: draft.Comment, TransitionID: "21", DoneChunks: draft.DoneChunks})
	if err != nil {
		t.Fatal(err)
	}
	if got.From != "To Do" || got.MovedTo != "In Progress" || got.Status != "In Progress" || got.MoveError != "" || !strings.HasSuffix(got.CommentURL, "/browse/PAY-1?focusedCommentId=10000") {
		t.Fatalf("post = %+v", got)
	}
	if len(f.comments) != 1 || !strings.Contains(f.comments[0], "Progress: 1 of 3 parts done.") {
		t.Fatalf("comments = %q", f.comments)
	}
	e := getEffort(t, oid)
	notes := e.Chunks[0].Notes
	last := notes[len(notes)-1]
	if last.Text != "Reported as done in the progress comment." || last.Author != "you" || last.JiraPost != got.CommentURL || last.Ts != got.PostedTs {
		t.Errorf("chunk note = %+v", last)
	}
	for _, c := range e.Chunks[1:] {
		if len(c.Notes) != 0 {
			t.Errorf("chunk %s got a note: %+v", c.Label, c.Notes)
		}
	}
	eNote := e.Notes[len(e.Notes)-1]
	if eNote.Text != "Posted progress to PAY-1. Moved To Do to In Progress." || eNote.JiraPost != got.CommentURL || eNote.Author != "you" {
		t.Errorf("initiative note = %+v", eNote)
	}
	want := &waveobj.EffortJiraPost{Ts: got.PostedTs, CommentURL: got.CommentURL, From: "To Do", MovedTo: "In Progress"}
	if !reflect.DeepEqual(e.Jira.LastPost, want) || e.Jira.Status != "In Progress" || e.Jira.SeenVia != "post" {
		t.Errorf("copy = %+v, lastpost %+v", e.Jira, e.Jira.LastPost)
	}
}

func TestJiraPostMoveFailsKeepsRecord(t *testing.T) {
	f, _ := useFakeJira(t, map[string]string{"PAY-1": "To Do"})
	f.failMove = "You don't have permission to transition this issue."
	ctx := context.Background()
	ws := &WshServer{}
	oid := postEffort(t)
	draft, err := ws.JiraPostDraftCommand(ctx, wshrpc.CommandJiraPostDraftData{EffortOID: oid})
	if err != nil {
		t.Fatal(err)
	}
	got, err := ws.JiraPostCommand(ctx, wshrpc.CommandJiraPostData{EffortOID: oid, Comment: draft.Comment, TransitionID: "41", DoneChunks: draft.DoneChunks})
	if err != nil {
		t.Fatal(err)
	}
	if got.MoveError != "EC-JIRA-HTTP 400: You don't have permission to transition this issue." || got.Status != "To Do" || got.MovedTo != "" || got.CommentURL == "" {
		t.Fatalf("post = %+v", got)
	}
	e := getEffort(t, oid)
	if n := e.Chunks[0].Notes; n[len(n)-1].JiraPost != got.CommentURL {
		t.Errorf("chunk notes = %+v", n)
	}
	if eNote := e.Notes[len(e.Notes)-1]; eNote.Text != "Posted progress to PAY-1." {
		t.Errorf("initiative note = %+v", eNote)
	}
	if lp := e.Jira.LastPost; lp == nil || lp.MoveError != got.MoveError || lp.MovedTo != "" {
		t.Errorf("lastpost = %+v", lp)
	}
	again, err := ws.JiraPostDraftCommand(ctx, wshrpc.CommandJiraPostDraftData{EffortOID: oid})
	if err != nil {
		t.Fatal(err)
	}
	if len(again.DoneChunks) != 0 || strings.Contains(again.Comment, "Done\n") || again.LastPost == nil {
		t.Fatalf("second draft = %+v", again)
	}
}

func TestJiraPostCommentFailsRecordsNothing(t *testing.T) {
	f, _ := useFakeJira(t, map[string]string{"PAY-1": "To Do"})
	f.failComment = http.StatusInternalServerError
	ctx := context.Background()
	oid := postEffort(t)
	_, err := (&WshServer{}).JiraPostCommand(ctx, wshrpc.CommandJiraPostData{EffortOID: oid, Comment: "Progress", TransitionID: "21", DoneChunks: []string{"Build"}})
	if err == nil || !strings.HasPrefix(err.Error(), "EC-JIRA-HTTP 500: Comment refused") {
		t.Fatalf("err = %v", err)
	}
	e := getEffort(t, oid)
	if len(e.Chunks[0].Notes) != 1 || len(e.Notes) != 0 || (e.Jira != nil && e.Jira.LastPost != nil) {
		t.Fatalf("recorded after a failed comment: chunk %+v, notes %+v, jira %+v", e.Chunks[0].Notes, e.Notes, e.Jira)
	}
	for _, c := range f.calls {
		if c == "POST /rest/api/3/issue/PAY-1/transitions" {
			t.Error("moved after the comment failed")
		}
	}
}

func TestJiraPostDraftRefusesNoTicket(t *testing.T) {
	useFakeJira(t, map[string]string{})
	oid := mkTicketEffort(t, &waveobj.Effort{Title: "no ticket"})
	_, err := (&WshServer{}).JiraPostDraftCommand(context.Background(), wshrpc.CommandJiraPostDraftData{EffortOID: oid})
	if err == nil || err.Error() != "EC-INVALID: this initiative has no ticket" {
		t.Fatalf("err = %v", err)
	}
}

func useHeadless(t *testing.T, fn func(ctx context.Context, prompt string) (string, bool, error)) {
	t.Helper()
	prev := jiraHeadless
	jiraHeadless = fn
	t.Cleanup(func() { jiraHeadless = prev })
}

func TestJiraPostSummariesFallsBack(t *testing.T) {
	useFakeJira(t, map[string]string{"PAY-1": "To Do"})
	useHeadless(t, func(context.Context, string) (string, bool, error) { return "", false, nil })
	ctx := context.Background()
	ws := &WshServer{}
	oid := postEffort(t)
	draft, err := ws.JiraPostDraftCommand(ctx, wshrpc.CommandJiraPostDraftData{EffortOID: oid})
	if err != nil {
		t.Fatal(err)
	}
	got, err := ws.JiraPostSummariesCommand(ctx, wshrpc.CommandJiraPostDraftData{EffortOID: oid})
	if err != nil {
		t.Fatal(err)
	}
	if got.Rewritten || got.Comment != draft.Comment || got.Reason == "" || strings.Contains(got.Reason, "\n") {
		t.Fatalf("summaries = %+v", got)
	}
	useHeadless(t, func(context.Context, string) (string, bool, error) { return "not json", true, nil })
	if got, _ := ws.JiraPostSummariesCommand(ctx, wshrpc.CommandJiraPostDraftData{EffortOID: oid}); got.Rewritten || got.Comment != draft.Comment {
		t.Fatalf("garbage reply rewrote: %+v", got)
	}
}

func TestJiraPostSummariesRewrites(t *testing.T) {
	useFakeJira(t, map[string]string{"PAY-1": "To Do"})
	useHeadless(t, func(context.Context, string) (string, bool, error) {
		return "```json\n{\"Build\": \"Support can refund an order\"}\n```", true, nil
	})
	oid := postEffort(t)
	got, err := (&WshServer{}).JiraPostSummariesCommand(context.Background(), wshrpc.CommandJiraPostDraftData{EffortOID: oid})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Rewritten || !strings.Contains(got.Comment, "- Build. Support can refund an order.") {
		t.Fatalf("summaries = %+v", got)
	}
}

func TestJiraConnectionReadsWithoutCalling(t *testing.T) {
	f, site := useFakeJira(t, map[string]string{})
	ws := &WshServer{}
	got, err := ws.JiraConnectionCommand(context.Background(), wshrpc.CommandJiraConnectionData{})
	if err != nil {
		t.Fatal(err)
	}
	if f.callCount() != 0 || !got.Configured || got.Site != site {
		t.Fatalf("read called Jira %d times: %+v", f.callCount(), got)
	}
	got, err = ws.JiraConnectionCommand(context.Background(), wshrpc.CommandJiraConnectionData{Test: true})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Ok || got.DisplayName != "Fixture User" || got.CheckedTs == 0 || got.Error != "" {
		t.Fatalf("test = %+v", got)
	}
}

func TestNotConfiguredMessage(t *testing.T) {
	f, _ := useFakeJira(t, map[string]string{"PAY-1": "To Do"})
	loadJiraConfig = func() (jira.Config, error) {
		return jira.Config{}, &jira.NotConfiguredError{Missing: []string{"site", "email", "token"}}
	}
	ctx := context.Background()
	ws := &WshServer{}
	oid := postEffort(t)
	const want = "EC-JIRA-NOTCONFIGURED: Jira isn't set up: add your site, account email and API token in Settings > Jira."
	calls := map[string]func() error{
		"check": func() error { _, err := ws.JiraCheckCommand(ctx); return err },
		"show":  func() error { _, err := ws.JiraShowCommand(ctx, wshrpc.CommandJiraShowData{Key: "PAY-1"}); return err },
		"draft": func() error {
			_, err := ws.JiraPostDraftCommand(ctx, wshrpc.CommandJiraPostDraftData{EffortOID: oid})
			return err
		},
		"summaries": func() error {
			_, err := ws.JiraPostSummariesCommand(ctx, wshrpc.CommandJiraPostDraftData{EffortOID: oid})
			return err
		},
		"post": func() error {
			_, err := ws.JiraPostCommand(ctx, wshrpc.CommandJiraPostData{EffortOID: oid, Comment: "x"})
			return err
		},
	}
	for name, call := range calls {
		if err := call(); err == nil || err.Error() != want {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	for _, test := range []bool{false, true} {
		conn, err := ws.JiraConnectionCommand(ctx, wshrpc.CommandJiraConnectionData{Test: test})
		if err != nil || conn.Configured || !reflect.DeepEqual(conn.Missing, []string{"site", "email", "token"}) || conn.CheckedTs != 0 {
			t.Errorf("connection (test=%v) = %+v, %v", test, conn, err)
		}
	}
	if f.callCount() != 0 {
		t.Errorf("Jira was called %d times while not configured", f.callCount())
	}
}
