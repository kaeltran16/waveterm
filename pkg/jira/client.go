// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	apiBase        = "/rest/api/3"
	defaultTimeout = 20 * time.Second
	searchMax      = 50
	openJQL        = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
	acFieldName    = "acceptance criteria"
	// cap on an error body read when it isn't Jira's JSON
	errBodyLimit    = 512
	commentPageSize = 100
)

var baseFields = []string{"summary", "issuetype", "status", "updated", "description"}

// what a full read (show) asks for on top of baseFields
var detailFields = []string{"attachment", "comment"}

// Jira's own timestamp shape, then RFC 3339 for anything that speaks it
var timeLayouts = []string{"2006-01-02T15:04:05.000-0700", time.RFC3339Nano}

type Client struct {
	cfg Config
	hc  *http.Client
}

func New(cfg Config, hc *http.Client) *Client {
	if hc == nil {
		hc = &http.Client{Timeout: defaultTimeout}
	}
	return &Client{cfg: cfg, hc: hc}
}

// site -> id of its "Acceptance Criteria" field ("" when the site has none); a site's fields rarely
// change, so one lookup per site per wavesrv run
var acFieldCache = struct {
	sync.Mutex
	ids map[string]string
}{ids: map[string]string{}}

func (c *Client) newRequest(ctx context.Context, method, path string, body any) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encoding Jira request: %w", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.cfg.Site+apiBase+path, reader)
	if err != nil {
		return nil, fmt.Errorf("building Jira request: %w", err)
	}
	req.SetBasicAuth(c.cfg.Email, c.cfg.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	req, err := c.newRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return Unreachable(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return httpError(resp)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("reading Jira's answer to %s %s: %w", method, path, err)
	}
	return nil
}

// httpError keeps Jira's own words: errorMessages first, then the per-field errors.
func httpError(resp *http.Response) error {
	raw, _ := io.ReadAll(resp.Body)
	var body struct {
		ErrorMessages []string          `json:"errorMessages"`
		Errors        map[string]string `json:"errors"`
	}
	var msgs []string
	if json.Unmarshal(raw, &body) == nil {
		msgs = append(msgs, body.ErrorMessages...)
		fields := make([]string, 0, len(body.Errors))
		for f := range body.Errors {
			fields = append(fields, f)
		}
		sort.Strings(fields)
		for _, f := range fields {
			msgs = append(msgs, body.Errors[f])
		}
	}
	msg := strings.Join(msgs, "; ")
	if msg == "" {
		msg = strings.TrimSpace(string(raw))
		if len(msg) > errBodyLimit {
			msg = msg[:errBodyLimit]
		}
	}
	if msg == "" {
		msg = http.StatusText(resp.StatusCode)
	}
	return &HTTPError{Status: resp.StatusCode, Message: msg}
}

func (c *Client) Myself(ctx context.Context) (string, error) {
	var me struct {
		DisplayName string `json:"displayName"`
	}
	if err := c.do(ctx, http.MethodGet, "/myself", nil, &me); err != nil {
		return "", err
	}
	return me.DisplayName, nil
}

func (c *Client) acceptanceField(ctx context.Context) (string, error) {
	acFieldCache.Lock()
	id, ok := acFieldCache.ids[c.cfg.Site]
	acFieldCache.Unlock()
	if ok {
		return id, nil
	}
	var fields []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := c.do(ctx, http.MethodGet, "/field", nil, &fields); err != nil {
		return "", err
	}
	id = ""
	for _, f := range fields {
		if strings.EqualFold(strings.TrimSpace(f.Name), acFieldName) {
			id = f.ID
			break
		}
	}
	acFieldCache.Lock()
	acFieldCache.ids[c.cfg.Site] = id
	acFieldCache.Unlock()
	return id, nil
}

func (c *Client) issueFields(ctx context.Context) ([]string, string, error) {
	acID, err := c.acceptanceField(ctx)
	if err != nil {
		return nil, "", err
	}
	fields := append([]string{}, baseFields...)
	if acID != "" {
		fields = append(fields, acID)
	}
	return fields, acID, nil
}

type rawIssue struct {
	Key    string                     `json:"key"`
	Fields map[string]json.RawMessage `json:"fields"`
}

func (c *Client) SearchOpen(ctx context.Context) ([]wshrpc.JiraTicket, error) {
	fields, acID, err := c.issueFields(ctx)
	if err != nil {
		return nil, err
	}
	req := map[string]any{"jql": openJQL, "maxResults": searchMax, "fields": fields}
	var resp struct {
		Issues []rawIssue `json:"issues"`
	}
	if err := c.do(ctx, http.MethodPost, "/search/jql", req, &resp); err != nil {
		return nil, err
	}
	tickets := make([]wshrpc.JiraTicket, 0, len(resp.Issues))
	for _, is := range resp.Issues {
		tickets = append(tickets, c.ticket(is, acID))
	}
	return tickets, nil
}

func issuePath(key, sub string) (string, error) {
	norm := NormalizeKey(key)
	if norm == "" {
		return "", fmt.Errorf("%q is not a Jira issue key like PAY-318", strings.TrimSpace(key))
	}
	return "/issue/" + url.PathEscape(norm) + sub, nil
}

func (c *Client) Issue(ctx context.Context, key string) (wshrpc.JiraTicket, error) {
	is, acID, err := c.rawIssue(ctx, key, nil)
	if err != nil {
		return wshrpc.JiraTicket{}, err
	}
	return c.ticket(is, acID), nil
}

// IssueDetail is Issue plus the ticket's attachments and every comment, for a full read.
func (c *Client) IssueDetail(ctx context.Context, key string) (wshrpc.JiraTicket, error) {
	is, acID, err := c.rawIssue(ctx, key, detailFields)
	if err != nil {
		return wshrpc.JiraTicket{}, err
	}
	t := c.ticket(is, acID)
	var page commentPage
	json.Unmarshal(is.Fields["comment"], &page)
	raw := page.Comments
	if len(raw) < page.Total {
		rest, err := c.commentsFrom(ctx, key, len(raw))
		if err != nil {
			return wshrpc.JiraTicket{}, err
		}
		raw = append(raw, rest...)
	}
	t.Comments = make([]wshrpc.JiraComment, 0, len(raw))
	for _, rc := range raw {
		t.Comments = append(t.Comments, wshrpc.JiraComment{
			ID:        rc.ID,
			Author:    rc.Author.DisplayName,
			CreatedTs: parseJiraTime(rc.Created),
			Body:      ADFToPlain(rc.Body, t.Attachments),
		})
	}
	return t, nil
}

func (c *Client) rawIssue(ctx context.Context, key string, extra []string) (rawIssue, string, error) {
	path, err := issuePath(key, "")
	if err != nil {
		return rawIssue{}, "", err
	}
	fields, acID, err := c.issueFields(ctx)
	if err != nil {
		return rawIssue{}, "", err
	}
	fields = append(fields, extra...)
	var is rawIssue
	if err := c.do(ctx, http.MethodGet, path+"?fields="+url.QueryEscape(strings.Join(fields, ",")), nil, &is); err != nil {
		return rawIssue{}, "", err
	}
	return is, acID, nil
}

type rawComment struct {
	ID     string `json:"id"`
	Author struct {
		DisplayName string `json:"displayName"`
	} `json:"author"`
	Created string          `json:"created"`
	Body    json.RawMessage `json:"body"`
}

// commentPage is both the issue's embedded comment field and one page of /issue/{key}/comment.
type commentPage struct {
	Comments []rawComment `json:"comments"`
	Total    int          `json:"total"`
}

// commentsFrom pages the issue's comments from start on, oldest first.
func (c *Client) commentsFrom(ctx context.Context, key string, start int) ([]rawComment, error) {
	path, err := issuePath(key, "/comment")
	if err != nil {
		return nil, err
	}
	var out []rawComment
	for {
		q := url.Values{"startAt": {strconv.Itoa(start)}, "maxResults": {strconv.Itoa(commentPageSize)}, "orderBy": {"created"}}
		var page commentPage
		if err := c.do(ctx, http.MethodGet, path+"?"+q.Encode(), nil, &page); err != nil {
			return nil, err
		}
		out = append(out, page.Comments...)
		start += len(page.Comments)
		if len(page.Comments) == 0 || start >= page.Total {
			return out, nil
		}
	}
}

func (c *Client) ticket(is rawIssue, acID string) wshrpc.JiraTicket {
	atts := parseAttachments(is.Fields["attachment"])
	var named struct {
		Name string `json:"name"`
	}
	var status struct {
		Name           string `json:"name"`
		StatusCategory struct {
			Key string `json:"key"`
		} `json:"statusCategory"`
	}
	var summary, updated string
	json.Unmarshal(is.Fields["summary"], &summary)
	json.Unmarshal(is.Fields["issuetype"], &named)
	json.Unmarshal(is.Fields["status"], &status)
	json.Unmarshal(is.Fields["updated"], &updated)
	return wshrpc.JiraTicket{
		Key:            is.Key,
		Summary:        summary,
		Type:           named.Name,
		Status:         status.Name,
		StatusCategory: status.StatusCategory.Key,
		Description:    ADFToPlain(is.Fields["description"], atts),
		Acceptance:     acceptance(is.Fields[acID], is.Fields["description"], acID != "", atts),
		URL:            c.cfg.Site + "/browse/" + is.Key,
		UpdatedTs:      parseJiraTime(updated),
		Attachments:    atts,
	}
}

func parseJiraTime(s string) int64 {
	for _, layout := range timeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli()
		}
	}
	return 0
}

// acceptance reads the site's Acceptance Criteria field, else the list under a description line
// reading "Acceptance criteria".
func acceptance(field, description json.RawMessage, hasField bool, atts []wshrpc.JiraAttachment) []string {
	if hasField {
		if items := fieldItems(field, atts); len(items) > 0 {
			return items
		}
	}
	doc, ok := parseADF(description, atts)
	if !ok {
		return nil
	}
	for i, b := range doc.Content {
		if b.Type != "paragraph" && b.Type != "heading" {
			continue
		}
		title := strings.TrimSuffix(strings.TrimSpace(inlineText(b.Content)), ":")
		if strings.EqualFold(title, acFieldName) {
			return listItems(doc.Content, i+1)
		}
	}
	return nil
}

// fieldItems takes a field's list items, or its non-blank lines when it holds no list.
func fieldItems(field json.RawMessage, atts []wshrpc.JiraAttachment) []string {
	if doc, ok := parseADF(field, atts); ok {
		if items := listItems(doc.Content, 0); len(items) > 0 {
			return items
		}
	}
	var items []string
	for _, line := range strings.Split(ADFToPlain(field, atts), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), bulletMarker))
		if line != "" {
			items = append(items, line)
		}
	}
	return items
}

func (c *Client) Transitions(ctx context.Context, key string) ([]wshrpc.JiraTransition, error) {
	path, err := issuePath(key, "/transitions")
	if err != nil {
		return nil, err
	}
	var resp struct {
		Transitions []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			To   struct {
				Name string `json:"name"`
			} `json:"to"`
		} `json:"transitions"`
	}
	if err := c.do(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	out := make([]wshrpc.JiraTransition, 0, len(resp.Transitions))
	for _, t := range resp.Transitions {
		out = append(out, wshrpc.JiraTransition{ID: t.ID, Name: t.Name, To: t.To.Name})
	}
	return out, nil
}

// AddComment posts plain as an ADF comment and returns the link that opens the issue on it.
func (c *Client) AddComment(ctx context.Context, key, plain string) (string, error) {
	path, err := issuePath(key, "/comment")
	if err != nil {
		return "", err
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := c.do(ctx, http.MethodPost, path, map[string]any{"body": PlainToADF(plain)}, &resp); err != nil {
		return "", err
	}
	return c.cfg.Site + "/browse/" + NormalizeKey(key) + "?focusedCommentId=" + url.QueryEscape(resp.ID), nil
}

func (c *Client) DoTransition(ctx context.Context, key, id string) error {
	path, err := issuePath(key, "/transitions")
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodPost, path, map[string]any{"transition": map[string]string{"id": id}}, nil)
}
