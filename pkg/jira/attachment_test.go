// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const testCreated = "2026-11-03T09:30:00.000+0000"

func attachmentJSON(id, name, mime string, size int) map[string]any {
	return map[string]any{
		"id": id, "filename": name, "mimeType": mime, "size": size, "created": testCreated,
		"author":  map[string]any{"displayName": "Ana"},
		"content": "https://acme.atlassian.net/rest/api/3/attachment/content/" + id,
	}
}

func commentJSON(id, author, text string) map[string]any {
	return map[string]any{
		"id": id, "author": map[string]any{"displayName": author}, "created": testCreated,
		"body": adfDocOf(adfPara(text), map[string]any{"type": "mediaSingle", "content": []any{
			map[string]any{"type": "media", "attrs": map[string]any{"id": "u", "type": "file", "alt": "shot.png"}},
		}}),
	}
}

func TestIssueDetailReadsAttachmentsAndEveryComment(t *testing.T) {
	var pagedFrom string
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/field": fieldsRoute(false),
		"GET /rest/api/3/issue/SIEM-1744": func(w http.ResponseWriter, r *http.Request) {
			if f := r.URL.Query().Get("fields"); !strings.Contains(f, "attachment") || !strings.Contains(f, "comment") {
				t.Errorf("fields = %q, want attachment and comment", f)
			}
			writeJSON(w, 200, issueJSON("SIEM-1744", map[string]any{
				"description": adfDocOf(adfPara("Normal results:"), map[string]any{"type": "mediaSingle", "content": []any{
					map[string]any{"type": "media", "attrs": map[string]any{"id": "u", "type": "file", "alt": "shot.png"}},
				}}),
				"attachment": []any{attachmentJSON("10001", "shot.png", "image/png", 2048), attachmentJSON("10002", "log.txt", "text/plain", 10)},
				"comment":    map[string]any{"comments": []any{commentJSON("1", "Ana", "first")}, "total": 3, "maxResults": 1, "startAt": 0},
			}))
		},
		"GET /rest/api/3/issue/SIEM-1744/comment": func(w http.ResponseWriter, r *http.Request) {
			pagedFrom = r.URL.Query().Get("startAt")
			writeJSON(w, 200, map[string]any{"comments": []any{commentJSON("2", "Bo", "second"), commentJSON("3", "Cy", "third")}, "total": 3, "startAt": 1})
		},
	})
	tk, err := c.IssueDetail(context.Background(), "SIEM-1744")
	if err != nil {
		t.Fatalf("IssueDetail: %v", err)
	}
	if want := "Normal results:\n\n[image: shot.png (attachment 10001)]"; tk.Description != want {
		t.Errorf("Description = %q, want %q", tk.Description, want)
	}
	created := time.Date(2026, 11, 3, 9, 30, 0, 0, time.UTC).UnixMilli()
	wantAtts := []wshrpc.JiraAttachment{
		{ID: "10001", Filename: "shot.png", MimeType: "image/png", Size: 2048, Author: "Ana", CreatedTs: created},
		{ID: "10002", Filename: "log.txt", MimeType: "text/plain", Size: 10, Author: "Ana", CreatedTs: created},
	}
	if !reflect.DeepEqual(tk.Attachments, wantAtts) {
		t.Errorf("Attachments = %+v", tk.Attachments)
	}
	if pagedFrom != "1" {
		t.Errorf("comments paged from %q, want 1", pagedFrom)
	}
	var got []string
	for _, cm := range tk.Comments {
		got = append(got, cm.ID+" "+cm.Author+" "+cm.Body)
		if cm.CreatedTs != created {
			t.Errorf("comment %s created %d", cm.ID, cm.CreatedTs)
		}
	}
	marker := "\n\n[image: shot.png (attachment 10001)]"
	if want := []string{"1 Ana first" + marker, "2 Bo second" + marker, "3 Cy third" + marker}; !reflect.DeepEqual(got, want) {
		t.Errorf("comments = %q", got)
	}
}

func TestIssueAsksForNoDetail(t *testing.T) {
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/field": fieldsRoute(false),
		"GET /rest/api/3/issue/PAY-1": func(w http.ResponseWriter, r *http.Request) {
			if f := r.URL.Query().Get("fields"); strings.Contains(f, "attachment") || strings.Contains(f, "comment") {
				t.Errorf("Issue asked for %q; posts don't need attachments or comments", f)
			}
			writeJSON(w, 200, issueJSON("PAY-1", nil))
		},
	})
	if _, err := c.Issue(context.Background(), "PAY-1"); err != nil {
		t.Fatal(err)
	}
}

func TestAttachmentsList(t *testing.T) {
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/issue/PAY-1": func(w http.ResponseWriter, r *http.Request) {
			if f := r.URL.Query().Get("fields"); f != "attachment" {
				t.Errorf("fields = %q", f)
			}
			writeJSON(w, 200, issueJSON("PAY-1", map[string]any{"attachment": []any{attachmentJSON("7", "a.png", "image/png", 1)}}))
		},
	})
	atts, err := c.Attachments(context.Background(), "pay-1")
	if err != nil || len(atts) != 1 || atts[0].ID != "7" || atts[0].Filename != "a.png" {
		t.Fatalf("Attachments = %+v, %v", atts, err)
	}
}

func TestAttachmentContentFollowsRedirect(t *testing.T) {
	var auth string
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/attachment/content/10001": func(w http.ResponseWriter, r *http.Request) {
			auth = r.Header.Get("Authorization")
			http.Redirect(w, r, "/media/file/u/binary?token=media-token", http.StatusSeeOther)
		},
		"GET /media/file/u/binary": func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("PNGDATA"))
		},
	})
	data, err := c.AttachmentContent(context.Background(), "PAY-1", "10001")
	if err != nil || string(data) != "PNGDATA" {
		t.Fatalf("AttachmentContent = %q, %v", data, err)
	}
	if !strings.HasPrefix(auth, "Basic ") {
		t.Errorf("site request had no basic auth: %q", auth)
	}
}

func TestAttachmentContentCapped(t *testing.T) {
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/attachment/content/1": func(w http.ResponseWriter, r *http.Request) {
			w.Write(bytes.Repeat([]byte{'x'}, AttachmentMaxBytes+1))
		},
	})
	_, err := c.AttachmentContent(context.Background(), "PAY-1", "1")
	if err == nil || !strings.HasPrefix(err.Error(), CodeTooLarge) {
		t.Fatalf("got %v, want %s", err, CodeTooLarge)
	}
}

func TestAttachmentContentRefusalsSayWhy(t *testing.T) {
	cases := []struct {
		status int
		want   string
	}{
		{401, "check it in Settings > Jira"},
		{403, "may not read this ticket's attachments"},
		{404, "attachment 5 is not on PAY-1 any more"},
	}
	for _, tc := range cases {
		c, _ := fakeJira(t, map[string]http.HandlerFunc{
			"GET /rest/api/3/attachment/content/5": func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, tc.status, map[string]any{"errorMessages": []string{"jira words"}})
			},
		})
		_, err := c.AttachmentContent(context.Background(), "PAY-1", "5")
		var he *HTTPError
		if !errors.As(err, &he) || he.Status != tc.status {
			t.Fatalf("%d: got %#v", tc.status, err)
		}
		if msg := err.Error(); !strings.Contains(msg, tc.want) || !strings.Contains(msg, "jira words") || strings.Contains(msg, testToken) {
			t.Errorf("%d: message %q", tc.status, msg)
		}
	}
}

func TestAttachmentsNotFoundSaysWhy(t *testing.T) {
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/issue/PAY-9": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 404, map[string]any{"errorMessages": []string{"Issue does not exist or you do not have permission to see it."}})
		},
	})
	_, err := c.Attachments(context.Background(), "PAY-9")
	if err == nil || !strings.Contains(err.Error(), "PAY-9 does not exist, or your Jira account can't see it") {
		t.Fatalf("got %v", err)
	}
}

func TestAttachmentContentRejectsNonID(t *testing.T) {
	c, _ := fakeJira(t, map[string]http.HandlerFunc{})
	for _, id := range []string{"", "../myself", "10001?x=1", "abc"} {
		if _, err := c.AttachmentContent(context.Background(), "PAY-1", id); err == nil {
			t.Errorf("%q: want an error, and no request", id)
		}
	}
}

func TestAttachmentDownloadErrorHidesMediaURL(t *testing.T) {
	closed := httptest.NewServer(http.NotFoundHandler())
	dead := closed.URL
	closed.Close()
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/attachment/content/1": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, dead+"/file/u/binary?token=media-secret", http.StatusFound)
		},
	})
	_, err := c.AttachmentContent(context.Background(), "PAY-1", "1")
	if err == nil || !strings.HasPrefix(err.Error(), CodeUnreachable) {
		t.Fatalf("got %v", err)
	}
	if strings.Contains(err.Error(), "media-secret") || strings.Contains(err.Error(), testToken) {
		t.Errorf("error leaks a token: %v", err)
	}
}

func TestSafeFileName(t *testing.T) {
	long := strings.Repeat("é", 100) + ".png"
	cases := []struct{ in, want string }{
		{"shot.png", "shot.png"},
		{"../../etc/passwd", "_.._etc_passwd"},
		{`..\..\Windows\win.ini`, `_.._Windows_win.ini`},
		{"..", "attachment"},
		{"", "attachment"},
		{" . ", "attachment"},
		{`a<b>c:d"e|f?g*h.txt`, "a_b_c_d_e_f_g_h.txt"},
		{"tab\there\x00.png", "tab_here_.png"},
		{"trailing. ", "trailing"},
		{"bad\xffutf8.png", "bad_utf8.png"},
	}
	for _, tc := range cases {
		if got := SafeFileName(tc.in); got != tc.want {
			t.Errorf("SafeFileName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	got := SafeFileName(long)
	if len(got) > fileNameMaxBytes || !strings.HasSuffix(got, ".png") || !strings.HasPrefix(got, "éé") {
		t.Errorf("long name cut to %q (%d bytes)", got, len(got))
	}
	if got := AttachmentFileName(wshrpc.JiraAttachment{ID: "10001", Filename: "../x.png"}); got != "10001-.._x.png" {
		t.Errorf("AttachmentFileName = %q", got)
	}
}
