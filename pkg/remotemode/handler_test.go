// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package remotemode

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

const (
	handlerTestOrigin = "https://arc.example.com"
	handlerTestVapid  = "BPubKey"
)

type handlerFake struct {
	mu         sync.Mutex
	verifyErr  error
	answerErr  error
	answered   []handlerAnswerBody
	subscribed []PushSubscription
	offCalls   chan struct{}
}

func handlerNewFake() *handlerFake {
	return &handlerFake{offCalls: make(chan struct{}, 4)}
}

func (f *handlerFake) handler() http.Handler {
	return NewHandler(Deps{
		Static: fstest.MapFS{
			"index.html":           {Data: []byte("<html>phone</html>")},
			"phone.js":             {Data: []byte("export {}")},
			"manifest.webmanifest": {Data: []byte(`{"name":"Arc"}`)},
			"fonts/a.woff2":        {Data: []byte("not really a font")},
		},
		Verify:      func(*http.Request) error { return f.verifyErr },
		Origin:      handlerTestOrigin,
		VapidPublic: handlerTestVapid,
		Waiting: func(context.Context) (WaitingList, error) {
			return WaitingList{Questions: []WaitingQuestion{{Key: "ask:b", ORef: "b", AskId: "a1"}}}, nil
		},
		Answer: func(_ context.Context, oref, askID string, answers []baseds.AgentAnswerItem) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.answered = append(f.answered, handlerAnswerBody{ORef: oref, AskId: askID, Answers: answers})
			return f.answerErr
		},
		Off: func(context.Context) error {
			f.offCalls <- struct{}{}
			return nil
		},
		Subscribe: func(_ context.Context, sub PushSubscription) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.subscribed = append(f.subscribed, sub)
			return nil
		},
	})
}

func handlerDo(t *testing.T, h http.Handler, method, path, body string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func handlerPostJSON(t *testing.T, h http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return handlerDo(t, h, http.MethodPost, path, body, map[string]string{"Content-Type": "application/json", "Origin": handlerTestOrigin})
}

const handlerTestAnswer = `{"oref":"block:1","askid":"a1","answers":[{"selectedindexes":[0,2]},{"text":"own words"}]}`

const handlerTestSub = `{"endpoint":"https://push.example.com/sub/1","expirationTime":null,"keys":{"p256dh":"P","auth":"A"}}`

func TestHandlerRefusesEveryRouteWithoutAccess(t *testing.T) {
	f := handlerNewFake()
	f.verifyErr = errors.New("missing header")
	h := f.handler()
	for _, rt := range []struct{ method, path, body string }{
		{http.MethodGet, "/", ""},
		{http.MethodGet, "/index.html", ""},
		{http.MethodGet, "/phone.js", ""},
		{http.MethodGet, "/no-such-file", ""},
		{http.MethodGet, "/api/waiting", ""},
		{http.MethodPost, "/api/answer", handlerTestAnswer},
		{http.MethodPost, "/api/off", "{}"},
		{http.MethodPost, "/api/subscribe", handlerTestSub},
	} {
		rec := handlerDo(t, h, rt.method, rt.path, rt.body, map[string]string{"Content-Type": "application/json", "Origin": handlerTestOrigin})
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s: got %d, want 403", rt.method, rt.path, rec.Code)
		}
		if rec.Body.Len() != 0 {
			t.Errorf("%s %s: 403 body should be bare, got %q", rt.method, rt.path, rec.Body.String())
		}
	}
	if len(f.answered) != 0 || len(f.subscribed) != 0 || len(f.offCalls) != 0 {
		t.Fatalf("a refused request reached a dep: %+v", f)
	}
}

func TestHandlerServesStatic(t *testing.T) {
	h := handlerNewFake().handler()
	for path, want := range map[string]string{"/": "<html>phone</html>", "/phone.js": "export {}"} {
		rec := handlerDo(t, h, http.MethodGet, path, "", nil)
		if rec.Code != http.StatusOK || rec.Body.String() != want {
			t.Errorf("GET %s: got %d %q", path, rec.Code, rec.Body.String())
		}
	}
}

func TestHandlerStaticContentTypes(t *testing.T) {
	h := handlerNewFake().handler()
	for path, want := range map[string]string{
		"/manifest.webmanifest": "application/manifest+json",
		"/fonts/a.woff2":        "font/woff2",
		"/phone.js":             "text/javascript; charset=utf-8",
	} {
		rec := handlerDo(t, h, http.MethodGet, path, "", nil)
		if got := rec.Header().Get("Content-Type"); rec.Code != http.StatusOK || got != want {
			t.Errorf("GET %s: got %d %q, want %q", path, rec.Code, got, want)
		}
	}
}

func TestHandlerPostRefusesNonJSON(t *testing.T) {
	f := handlerNewFake()
	h := f.handler()
	for _, path := range []string{"/api/answer", "/api/off", "/api/subscribe"} {
		rec := handlerDo(t, h, http.MethodPost, path, handlerTestAnswer, map[string]string{"Content-Type": "text/plain", "Origin": handlerTestOrigin})
		if rec.Code != http.StatusUnsupportedMediaType {
			t.Errorf("POST %s text/plain: got %d, want 415", path, rec.Code)
		}
	}
	if len(f.answered) != 0 || len(f.offCalls) != 0 {
		t.Fatalf("a non-json post reached a dep")
	}
}

func TestHandlerPostChecksOrigin(t *testing.T) {
	f := handlerNewFake()
	h := f.handler()
	for _, origin := range []string{"https://evil.example", "", "http://arc.example.com", handlerTestOrigin + ".evil.example"} {
		rec := handlerDo(t, h, http.MethodPost, "/api/answer", handlerTestAnswer, map[string]string{"Content-Type": "application/json", "Origin": origin})
		if rec.Code != http.StatusForbidden {
			t.Errorf("origin %q: got %d, want 403", origin, rec.Code)
		}
	}
	if len(f.answered) != 0 {
		t.Fatalf("a cross-origin post reached Answer")
	}
	rec := handlerDo(t, h, http.MethodPost, "/api/answer", handlerTestAnswer, map[string]string{"Content-Type": "application/json; charset=utf-8", "Origin": handlerTestOrigin})
	if rec.Code != http.StatusOK {
		t.Fatalf("own origin: got %d %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerAnswer(t *testing.T) {
	f := handlerNewFake()
	rec := handlerPostJSON(t, f.handler(), "/api/answer", handlerTestAnswer)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"ok":true}` {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
	want := []handlerAnswerBody{{ORef: "block:1", AskId: "a1", Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{0, 2}}, {Text: "own words"}}}}
	if !reflect.DeepEqual(f.answered, want) {
		t.Fatalf("Answer got %+v, want %+v", f.answered, want)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control %q", cc)
	}
}

func TestHandlerAnswerGone(t *testing.T) {
	f := handlerNewFake()
	f.answerErr = ErrAskGone
	rec := handlerPostJSON(t, f.handler(), "/api/answer", handlerTestAnswer)
	if rec.Code != http.StatusConflict || strings.TrimSpace(rec.Body.String()) != `{"error":"gone"}` {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerAnswerMalformed(t *testing.T) {
	f := handlerNewFake()
	h := f.handler()
	for _, body := range []string{
		`not json`,
		`{"askid":"a1","answers":[{"text":"x"}]}`,
		`{"oref":"block:1","answers":[{"text":"x"}]}`,
		`{"oref":"block:1","askid":"a1","answers":[]}`,
		`{"oref":"block:1","askid":"a1"}`,
	} {
		if rec := handlerPostJSON(t, h, "/api/answer", body); rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: got %d, want 400", body, rec.Code)
		}
	}
	if len(f.answered) != 0 {
		t.Fatalf("a malformed answer reached Answer: %+v", f.answered)
	}
}

func TestHandlerWaiting(t *testing.T) {
	rec := handlerDo(t, handlerNewFake().handler(), http.MethodGet, "/api/waiting", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control %q", cc)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(got["vapidpublic"]) != `"`+handlerTestVapid+`"` {
		t.Errorf("vapidpublic %s", got["vapidpublic"])
	}
	if string(got["shown"]) != "[]" {
		t.Errorf("shown should be [] when the list has none, got %s", got["shown"])
	}
	if !strings.Contains(string(got["questions"]), `"askid":"a1"`) {
		t.Errorf("questions %s", got["questions"])
	}
}

func TestHandlerOff(t *testing.T) {
	f := handlerNewFake()
	rec := handlerPostJSON(t, f.handler(), "/api/off", "{}")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"ok":true}` {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
	select {
	case <-f.offCalls:
	case <-time.After(2 * time.Second):
		t.Fatal("Off was not called")
	}
	select {
	case <-f.offCalls:
		t.Fatal("Off was called twice")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestHandlerSubscribe(t *testing.T) {
	f := handlerNewFake()
	h := f.handler()
	rec := handlerPostJSON(t, h, "/api/subscribe", handlerTestSub)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
	var want PushSubscription
	want.Endpoint = "https://push.example.com/sub/1"
	want.Keys.P256dh = "P"
	want.Keys.Auth = "A"
	if !reflect.DeepEqual(f.subscribed, []PushSubscription{want}) {
		t.Fatalf("Subscribe got %+v", f.subscribed)
	}
	for _, body := range []string{
		`{"endpoint":"http://push.example.com/x","keys":{"p256dh":"P","auth":"A"}}`,
		`{"endpoint":"https://push.example.com/x","keys":{"auth":"A"}}`,
		`{"keys":{"p256dh":"P","auth":"A"}}`,
	} {
		if rec := handlerPostJSON(t, h, "/api/subscribe", body); rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: got %d, want 400", body, rec.Code)
		}
	}
	if len(f.subscribed) != 1 {
		t.Fatalf("an invalid subscription reached Subscribe: %+v", f.subscribed)
	}
}
