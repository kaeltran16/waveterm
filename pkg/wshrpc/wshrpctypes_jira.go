// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// JiraCommands are wavesrv's only way to Jira (pkg/jira); the cockpit and `wsh jira` both go through
// them, so the API token never leaves wavesrv.
type JiraCommands interface {
	JiraConnectionCommand(ctx context.Context, data CommandJiraConnectionData) (*JiraConnection, error)
	JiraCheckCommand(ctx context.Context) (*CommandJiraCheckRtnData, error)
	JiraShowCommand(ctx context.Context, data CommandJiraShowData) (*CommandJiraShowRtnData, error)
	JiraPostDraftCommand(ctx context.Context, data CommandJiraPostDraftData) (*CommandJiraPostDraftRtnData, error)
	JiraPostSummariesCommand(ctx context.Context, data CommandJiraPostDraftData) (*CommandJiraPostSummariesRtnData, error)
	JiraPostCommand(ctx context.Context, data CommandJiraPostData) (*CommandJiraPostRtnData, error)
	JiraAttachmentsCommand(ctx context.Context, data CommandJiraAttachmentsData) (*CommandJiraAttachmentsRtnData, error)
	JiraAttachmentReadCommand(ctx context.Context, data CommandJiraAttachmentReadData) (*CommandJiraAttachmentReadRtnData, error)
}

type CommandJiraConnectionData struct {
	Test bool `json:"test,omitempty"` // false reads the last known status without calling Jira
}

type JiraConnection struct {
	Configured  bool     `json:"configured"`
	Missing     []string `json:"missing,omitempty"` // site | email | token
	Site        string   `json:"site,omitempty"`
	Ok          bool     `json:"ok"`
	DisplayName string   `json:"displayname,omitempty"`
	CheckedTs   int64    `json:"checkedts,omitempty"` // last attempt
	LastOkTs    int64    `json:"lastokts,omitempty"`  // last successful call
	Error       string   `json:"error,omitempty"`
}

type JiraTicket struct {
	Key            string   `json:"key"`
	Summary        string   `json:"summary"`
	Type           string   `json:"type"`
	Status         string   `json:"status"`
	StatusCategory string   `json:"statuscategory"` // new | indeterminate | done
	Description    string   `json:"description,omitempty"`
	Acceptance     []string `json:"acceptance,omitempty"`
	URL            string   `json:"url"`
	UpdatedTs      int64    `json:"updatedts,omitempty"`
	// only a full read (show) fills these two
	Attachments []JiraAttachment `json:"attachments,omitempty"`
	Comments    []JiraComment    `json:"comments,omitempty"`
}

type JiraAttachment struct {
	ID        string `json:"id"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mimetype,omitempty"`
	Size      int64  `json:"size"`
	Author    string `json:"author,omitempty"`
	CreatedTs int64  `json:"createdts,omitempty"`
}

type JiraComment struct {
	ID        string `json:"id"`
	Author    string `json:"author,omitempty"`
	CreatedTs int64  `json:"createdts,omitempty"`
	Body      string `json:"body"` // plain text, embedded media marked as [image: ...]
}

// JiraTicketRow is one Check Jira result with its inferred project; the embedded ticket's fields
// are flat on the wire.
type JiraTicketRow struct {
	JiraTicket
	Project  string `json:"project,omitempty"`
	Evidence string `json:"evidence,omitempty"`
	Sure     bool   `json:"sure"`
}

type CommandJiraCheckRtnData struct {
	Site      string          `json:"site"`
	CheckedTs int64           `json:"checkedts"`
	Tickets   []JiraTicketRow `json:"tickets"`
	Covered   int             `json:"covered"` // tickets already on an initiative, left out of Tickets
}

type CommandJiraShowData struct {
	Key string `json:"key"`
	Via string `json:"via"` // show | refresh | lookup
}

type CommandJiraShowRtnData struct {
	Ticket   JiraTicket `json:"ticket"`
	Project  string     `json:"project,omitempty"`
	Evidence string     `json:"evidence,omitempty"`
	Sure     bool       `json:"sure"`
	SeenTs   int64      `json:"seents"`
}

type JiraTransition struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	To   string `json:"to"`
}

type CommandJiraPostDraftData struct {
	EffortOID string `json:"effortoid"`
}

type CommandJiraPostDraftRtnData struct {
	Key         string                  `json:"key"`
	Status      string                  `json:"status"`
	LastPost    *waveobj.EffortJiraPost `json:"lastpost,omitempty"`
	Comment     string                  `json:"comment"`
	DoneChunks  []string                `json:"donechunks,omitempty"`
	Transitions []JiraTransition        `json:"transitions,omitempty"`
}

type CommandJiraPostSummariesRtnData struct {
	Comment   string `json:"comment"`
	Rewritten bool   `json:"rewritten"`
	Reason    string `json:"reason,omitempty"` // why the code draft was kept
}

type CommandJiraPostData struct {
	EffortOID    string   `json:"effortoid"`
	Comment      string   `json:"comment"`
	TransitionID string   `json:"transitionid,omitempty"` // "" leaves the status as is
	DoneChunks   []string `json:"donechunks,omitempty"`
}

type CommandJiraPostRtnData struct {
	CommentURL string `json:"commenturl"`
	PostedTs   int64  `json:"postedts"`
	From       string `json:"from"`
	MovedTo    string `json:"movedto,omitempty"`
	MoveError  string `json:"moveerror,omitempty"`
	Status     string `json:"status"`
}

type CommandJiraAttachmentsData struct {
	Key string `json:"key"`
}

type CommandJiraAttachmentsRtnData struct {
	Key         string           `json:"key"`
	Attachments []JiraAttachment `json:"attachments"`
}

type CommandJiraAttachmentReadData struct {
	Key string `json:"key"`
	ID  string `json:"id"`
}

type CommandJiraAttachmentReadRtnData struct {
	Attachment JiraAttachment `json:"attachment"`
	Data64     string         `json:"data64"`
}
