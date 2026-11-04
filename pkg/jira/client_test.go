// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testEmail   = "me@acme.com"
	testToken   = "secret-token-value"
	testACField = "customfield_10050"
)

// fakeJira serves routes keyed "METHOD /path"; an unknown route is a test failure.
func fakeJira(t *testing.T, routes map[string]http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h, ok := routes[r.Method+" "+r.URL.Path]
		if !ok {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected", http.StatusNotFound)
			return
		}
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	return New(Config{Site: srv.URL, Email: testEmail, Token: testToken}, nil), srv
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func fieldsRoute(withAC bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fields := []map[string]any{
			{"id": "summary", "name": "Summary"},
			{"id": "description", "name": "Description"},
		}
		if withAC {
			fields = append(fields, map[string]any{"id": testACField, "name": "acceptance criteria"})
		}
		writeJSON(w, 200, fields)
	}
}

func adfPara(text string) map[string]any {
	return map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": text}}}
}

func adfBullets(items ...string) map[string]any {
	lis := []any{}
	for _, it := range items {
		lis = append(lis, map[string]any{"type": "listItem", "content": []any{adfPara(it)}})
	}
	return map[string]any{"type": "bulletList", "content": lis}
}

func adfDocOf(blocks ...any) map[string]any {
	return map[string]any{"type": "doc", "version": 1, "content": blocks}
}

func issueJSON(key string, extra map[string]any) map[string]any {
	fields := map[string]any{
		"summary":   "Retry webhook delivery",
		"issuetype": map[string]any{"name": "Story"},
		"status":    map[string]any{"name": "To Do", "statusCategory": map[string]any{"key": "new"}},
		"updated":   "2026-11-03T12:00:00.000+0000",
	}
	for k, v := range extra {
		fields[k] = v
	}
	return map[string]any{"id": "1", "key": key, "fields": fields}
}

func TestSearchOpenSendsJQLAndParses(t *testing.T) {
	var body map[string]any
	c, srv := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/field": fieldsRoute(true),
		"POST /rest/api/3/search/jql": func(w http.ResponseWriter, r *http.Request) {
			json.NewDecoder(r.Body).Decode(&body)
			writeJSON(w, 200, map[string]any{"issues": []any{issueJSON("PAY-318", nil)}, "isLast": true})
		},
	})
	tickets, err := c.SearchOpen(context.Background())
	if err != nil {
		t.Fatalf("SearchOpen: %v", err)
	}
	if body["jql"] != "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC" {
		t.Errorf("jql = %q", body["jql"])
	}
	if body["maxResults"] != float64(50) {
		t.Errorf("maxResults = %v", body["maxResults"])
	}
	if len(tickets) != 1 {
		t.Fatalf("got %d tickets", len(tickets))
	}
	tk := tickets[0]
	wantTs := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC).UnixMilli()
	if tk.Key != "PAY-318" || tk.URL != srv.URL+"/browse/PAY-318" || tk.UpdatedTs != wantTs {
		t.Errorf("ticket = %+v (want updated %d)", tk, wantTs)
	}
	if tk.Summary != "Retry webhook delivery" || tk.Type != "Story" || tk.Status != "To Do" || tk.StatusCategory != "new" {
		t.Errorf("ticket fields = %+v", tk)
	}
}

func TestIssueAcceptanceFromField(t *testing.T) {
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/field": fieldsRoute(true),
		"GET /rest/api/3/issue/PAY-318": func(w http.ResponseWriter, r *http.Request) {
			if !strings.Contains(r.URL.Query().Get("fields"), testACField) {
				t.Errorf("fields query %q does not ask for the AC field", r.URL.Query().Get("fields"))
			}
			writeJSON(w, 200, issueJSON("PAY-318", map[string]any{
				"description": adfDocOf(adfPara("Partners lose events."), adfPara("Acceptance criteria"), adfBullets("from description")),
				testACField:   adfDocOf(adfBullets("429 is retried", "gives up after 6")),
			}))
		},
	})
	tk, err := c.Issue(context.Background(), " pay-318 ")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if want := []string{"429 is retried", "gives up after 6"}; !reflect.DeepEqual(tk.Acceptance, want) {
		t.Errorf("Acceptance = %q, want %q", tk.Acceptance, want)
	}
	if !strings.HasPrefix(tk.Description, "Partners lose events.") {
		t.Errorf("Description = %q", tk.Description)
	}
}

func TestIssueAcceptanceFallsBackToDescription(t *testing.T) {
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/field": fieldsRoute(false),
		"GET /rest/api/3/issue/PAY-318": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, issueJSON("PAY-318", map[string]any{
				"description": adfDocOf(
					adfPara("Intro"),
					adfBullets("not criteria"),
					adfPara("Acceptance Criteria:"),
					adfBullets("first", "second"),
				),
			}))
		},
	})
	tk, err := c.Issue(context.Background(), "PAY-318")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if want := []string{"first", "second"}; !reflect.DeepEqual(tk.Acceptance, want) {
		t.Errorf("Acceptance = %q, want %q", tk.Acceptance, want)
	}
}

func TestIssueRejectsNonKey(t *testing.T) {
	c, _ := fakeJira(t, map[string]http.HandlerFunc{})
	if _, err := c.Issue(context.Background(), "pay 318"); err == nil {
		t.Fatal("want an error for a non-key, and no request")
	}
}

func TestFieldLookupCachedPerSite(t *testing.T) {
	var fieldHits atomic.Int32
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/field": func(w http.ResponseWriter, r *http.Request) {
			fieldHits.Add(1)
			fieldsRoute(true)(w, r)
		},
		"GET /rest/api/3/issue/PAY-318": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, issueJSON("PAY-318", nil))
		},
	})
	for i := 0; i < 2; i++ {
		if _, err := c.Issue(context.Background(), "PAY-318"); err != nil {
			t.Fatalf("Issue %d: %v", i, err)
		}
	}
	if n := fieldHits.Load(); n != 1 {
		t.Errorf("/field hit %d times, want 1", n)
	}
}

func TestHTTPErrorCarriesJiraMessage(t *testing.T) {
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/myself": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 401, map[string]any{"errorMessages": []string{"Client must be authenticated to access this resource."}})
		},
		"POST /rest/api/3/issue/PAY-318/transitions": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 400, map[string]any{"errorMessages": []string{}, "errors": map[string]string{"Reviewer": "Field 'Reviewer' is required"}})
		},
	})
	_, err := c.Myself(context.Background())
	var he *HTTPError
	if !errors.As(err, &he) || he.Status != 401 || he.Message != "Client must be authenticated to access this resource." {
		t.Errorf("401: got %#v", err)
	}
	err = c.DoTransition(context.Background(), "PAY-318", "31")
	if !errors.As(err, &he) || he.Status != 400 || he.Message != "Field 'Reviewer' is required" {
		t.Errorf("400: got %#v", err)
	}
	if strings.Contains(err.Error(), testToken) {
		t.Error("error carries the token")
	}
}

func TestUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	c := New(Config{Site: url, Email: testEmail, Token: testToken}, nil)
	_, err := c.Myself(context.Background())
	if err == nil || !strings.HasPrefix(err.Error(), "EC-JIRA-UNREACHABLE:") {
		t.Fatalf("got %v", err)
	}
	if strings.Contains(err.Error(), testToken) {
		t.Error("error carries the token")
	}
}

func TestBasicAuth(t *testing.T) {
	var got string
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/myself": func(w http.ResponseWriter, r *http.Request) {
			got = r.Header.Get("Authorization")
			writeJSON(w, 200, map[string]any{"displayName": "Kael"})
		},
	})
	name, err := c.Myself(context.Background())
	if err != nil || name != "Kael" {
		t.Fatalf("Myself = %q, %v", name, err)
	}
	if want := "Basic " + base64.StdEncoding.EncodeToString([]byte(testEmail+":"+testToken)); got != want {
		t.Errorf("Authorization = %q, want %q", got, want)
	}
}

func TestAddCommentReturnsURL(t *testing.T) {
	var body map[string]any
	c, srv := fakeJira(t, map[string]http.HandlerFunc{
		"POST /rest/api/3/issue/PAY-318/comment": func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			json.Unmarshal(raw, &body)
			writeJSON(w, 201, map[string]any{"id": "10000"})
		},
	})
	url, err := c.AddComment(context.Background(), "PAY-318", "Progress: 1 of 2 parts done.")
	if err != nil {
		t.Fatalf("AddComment: %v", err)
	}
	if want := srv.URL + "/browse/PAY-318?focusedCommentId=10000"; url != want {
		t.Errorf("url = %q, want %q", url, want)
	}
	doc, _ := body["body"].(map[string]any)
	if doc["type"] != "doc" || doc["version"] != float64(1) {
		t.Errorf("body is not ADF: %v", body)
	}
}

func TestTransitionsParse(t *testing.T) {
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/issue/PAY-318/transitions": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"transitions": []any{
				map[string]any{"id": "31", "name": "Review", "to": map[string]any{"name": "In Review"}},
			}})
		},
	})
	ts, err := c.Transitions(context.Background(), "PAY-318")
	if err != nil || len(ts) != 1 || ts[0].ID != "31" || ts[0].Name != "Review" || ts[0].To != "In Review" {
		t.Errorf("Transitions = %+v, %v", ts, err)
	}
}

func TestSnapshotRefusesWritesButReads(t *testing.T) {
	t.Setenv("ARC_SNAPSHOT", "1")
	c, _ := fakeJira(t, map[string]http.HandlerFunc{
		"GET /rest/api/3/field": fieldsRoute(true),
		"POST /rest/api/3/search/jql": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 200, map[string]any{"issues": []any{issueJSON("PAY-318", nil)}, "isLast": true})
		},
	})
	if tickets, err := c.SearchOpen(context.Background()); err != nil || len(tickets) != 1 {
		t.Errorf("SearchOpen = %d tickets, %v; want the read to go through", len(tickets), err)
	}
	// fakeJira fails the test on any request it has no route for, so a refused write never reaching it is checked too
	if err := c.DoTransition(context.Background(), "PAY-318", "31"); !errors.Is(err, errSnapshotWrite) {
		t.Errorf("DoTransition = %v, want errSnapshotWrite", err)
	}
}
