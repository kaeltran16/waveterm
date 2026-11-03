// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	// per-file download cap: its base64 has to fit one rpc message to wsh
	AttachmentMaxBytes = 20 << 20
	// a download gets longer than defaultTimeout; wsh waits a little past it
	DownloadTimeoutMs = 120_000
	// a saved file's name, extension included
	fileNameMaxBytes = 120
	fileExtMaxBytes  = 16
	fileNameFallback = "attachment"
	// what Windows refuses in a file name, on top of control characters
	fileNameIllegal = `<>:"/\|?*`
)

var attachmentIDRe = regexp.MustCompile(`^\d+$`)

type rawAttachment struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Author   struct {
		DisplayName string `json:"displayName"`
	} `json:"author"`
	Created  string `json:"created"`
	Size     int64  `json:"size"`
	MimeType string `json:"mimeType"`
}

// parseAttachments reads an issue's attachment field; an absent field is nil.
func parseAttachments(field json.RawMessage) []wshrpc.JiraAttachment {
	var raw []rawAttachment
	if len(field) == 0 || json.Unmarshal(field, &raw) != nil || len(raw) == 0 {
		return nil
	}
	out := make([]wshrpc.JiraAttachment, 0, len(raw))
	for _, a := range raw {
		out = append(out, wshrpc.JiraAttachment{
			ID:        a.ID,
			Filename:  a.Filename,
			MimeType:  a.MimeType,
			Size:      a.Size,
			Author:    a.Author.DisplayName,
			CreatedTs: parseJiraTime(a.Created),
		})
	}
	return out
}

// Attachments lists the ticket's attachments.
func (c *Client) Attachments(ctx context.Context, key string) ([]wshrpc.JiraAttachment, error) {
	path, err := issuePath(key, "?fields=attachment")
	if err != nil {
		return nil, err
	}
	var is rawIssue
	if err := c.do(ctx, http.MethodGet, path, nil, &is); err != nil {
		return nil, explainRefusal(err, NormalizeKey(key)+" does not exist, or your Jira account can't see it")
	}
	return parseAttachments(is.Fields["attachment"]), nil
}

// AttachmentContent downloads one attachment of key, refusing more than AttachmentMaxBytes. Jira
// answers with a redirect to Atlassian's media host; Go drops the Authorization header on that
// cross-host redirect, so the token only ever goes to the configured site.
func (c *Client) AttachmentContent(ctx context.Context, key, id string) ([]byte, error) {
	if !attachmentIDRe.MatchString(id) {
		return nil, fmt.Errorf("EC-INVALID: %q is not a Jira attachment id", id)
	}
	req, err := c.newRequest(ctx, http.MethodGet, "/attachment/content/"+id, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "*/*")
	dl := *c.hc
	dl.Timeout = DownloadTimeoutMs * time.Millisecond
	resp, err := dl.Do(req)
	if err != nil {
		return nil, Unreachable(fmt.Errorf("downloading attachment %s: %w", id, withoutURL(err)))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, explainRefusal(httpError(resp), fmt.Sprintf("attachment %s is not on %s any more", id, NormalizeKey(key)))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, AttachmentMaxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("reading attachment %s: %w", id, withoutURL(err))
	}
	if len(data) > AttachmentMaxBytes {
		return nil, TooLarge(id)
	}
	return data, nil
}

// TooLarge is the refusal of an attachment over AttachmentMaxBytes.
func TooLarge(id string) error {
	return fmt.Errorf("%s: attachment %s is over the %d MB download limit", CodeTooLarge, id, AttachmentMaxBytes>>20)
}

// withoutURL drops the URL a transport error quotes: after the redirect it is the media host's, and
// that URL carries a short-lived access token.
func withoutURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// explainRefusal puts a plain reason ahead of Jira's own words for the refusals a download meets.
func explainRefusal(err error, notFound string) error {
	var he *HTTPError
	if !errors.As(err, &he) {
		return err
	}
	var why string
	switch he.Status {
	case http.StatusUnauthorized:
		why = "Jira refused Arc's API token; check it in Settings > Jira"
	case http.StatusForbidden:
		why = "your Jira account may not read this ticket's attachments"
	case http.StatusNotFound:
		why = notFound
	default:
		return err
	}
	return &HTTPError{Status: he.Status, Message: why + ". Jira said: " + he.Message}
}

// AttachmentFileName is the name an attachment is saved under: its id, so two "image.png"s never
// collide, then its own name made safe for any file system.
func AttachmentFileName(a wshrpc.JiraAttachment) string {
	return SafeFileName(a.ID + "-" + a.Filename)
}

// SafeFileName makes name a single path element: separators, characters Windows refuses and control
// characters become "_", leading and trailing dots and spaces go (so ".." is never a name), and a
// long name is cut at a rune boundary, keeping its extension.
func SafeFileName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(fileNameIllegal, r) {
			return '_'
		}
		return r
	}, strings.ToValidUTF8(name, "_"))
	name = strings.Trim(name, ". ")
	if name == "" {
		return fileNameFallback
	}
	if len(name) <= fileNameMaxBytes {
		return name
	}
	ext := filepath.Ext(name)
	if len(ext) > fileExtMaxBytes {
		ext = ""
	}
	stem := name[:fileNameMaxBytes-len(ext)]
	for !utf8.ValidString(stem) {
		stem = stem[:len(stem)-1]
	}
	return strings.TrimRight(stem, ". ") + ext
}
