// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package remotemode

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/url"
	"strconv"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// ErrAskGone means the ask the phone answered was answered or withdrawn meanwhile.
var ErrAskGone = errors.New("ask is gone")

// a push subscription or an answer is a few KB at most
const handlerMaxBody = 64 << 10

const handlerJSONType = "application/json"

// Deps is everything the phone handler calls out to, so it can be tested and previewed with fakes.
type Deps struct {
	Static fs.FS
	Verify func(*http.Request) error
	// Origin is the only Origin a POST may carry: https://<hostname>.
	Origin      string
	VapidPublic string
	Waiting     func(context.Context) (WaitingList, error)
	Answer      func(ctx context.Context, oref, askID string, answers []baseds.AgentAnswerItem) error
	Off         func(context.Context) error
	Subscribe   func(context.Context, PushSubscription) error
}

type handlerAnswerBody struct {
	ORef    string                   `json:"oref"`
	AskId   string                   `json:"askid"`
	Answers []baseds.AgentAnswerItem `json:"answers"`
}

// NewHandler serves the phone page and its API. Every request, static files included, passes Verify
// first; a POST must also be JSON from the phone's own origin, since Cloudflare adds the Access token to
// any request carrying the owner's cookie, a cross-site form post included.
func NewHandler(d Deps) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/waiting", d.handleWaiting)
	mux.Handle("POST /api/answer", d.handlerPost(d.handleAnswer))
	mux.Handle("POST /api/off", d.handlerPost(d.handleOff))
	mux.Handle("POST /api/subscribe", d.handlerPost(d.handleSubscribe))
	mux.Handle("/", http.FileServerFS(d.Static))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := d.Verify(r); err != nil {
			log.Printf("remote mode: refused %s %s: %v\n", r.Method, r.URL.Path, err)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (d Deps) handlerPost(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != d.Origin {
			log.Printf("remote mode: refused %s %s: origin %q\n", r.Method, r.URL.Path, origin)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != handlerJSONType {
			handlerWriteJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "content type must be " + handlerJSONType})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, handlerMaxBody)
		next(w, r)
	})
}

func (d Deps) handleWaiting(w http.ResponseWriter, r *http.Request) {
	list, err := d.Waiting(r.Context())
	if err != nil {
		log.Printf("remote mode: waiting list: %v\n", err)
		handlerWriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	list.VapidPublic = d.VapidPublic
	if list.Questions == nil {
		list.Questions = []WaitingQuestion{}
	}
	if list.Shown == nil {
		list.Shown = []WaitingShown{}
	}
	handlerWriteJSON(w, http.StatusOK, list)
}

func (d Deps) handleAnswer(w http.ResponseWriter, r *http.Request) {
	var body handlerAnswerBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		handlerBadRequest(w, "malformed body")
		return
	}
	if body.ORef == "" || body.AskId == "" || len(body.Answers) == 0 {
		handlerBadRequest(w, "oref, askid and answers are required")
		return
	}
	err := d.Answer(r.Context(), body.ORef, body.AskId, body.Answers)
	switch {
	case errors.Is(err, ErrAskGone):
		handlerWriteJSON(w, http.StatusConflict, map[string]string{"error": "gone"})
	case err != nil:
		log.Printf("remote mode: answer %s: %v\n", body.ORef, err)
		handlerWriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	default:
		handlerOK(w)
	}
}

// handleOff answers before turning off, and turns off on its own goroutine: Off closes the listener this
// request runs on, and a graceful shutdown would wait on this very handler.
func (d Deps) handleOff(w http.ResponseWriter, r *http.Request) {
	handlerOK(w)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go func() {
		if err := d.Off(context.Background()); err != nil {
			log.Printf("remote mode: turn off from the phone: %v\n", err)
		}
	}()
}

func (d Deps) handleSubscribe(w http.ResponseWriter, r *http.Request) {
	var sub PushSubscription
	if err := json.NewDecoder(r.Body).Decode(&sub); err != nil {
		handlerBadRequest(w, "malformed body")
		return
	}
	// the server posts to this endpoint, so it must be a push service's https url
	u, err := url.Parse(sub.Endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || sub.Keys.P256dh == "" || sub.Keys.Auth == "" {
		handlerBadRequest(w, "endpoint must be an https url, and keys.p256dh and keys.auth are required")
		return
	}
	if err := d.Subscribe(r.Context(), sub); err != nil {
		log.Printf("remote mode: store push subscription: %v\n", err)
		handlerWriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	handlerOK(w)
}

func handlerBadRequest(w http.ResponseWriter, msg string) {
	handlerWriteJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
}

func handlerOK(w http.ResponseWriter) {
	handlerWriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handlerWriteJSON sets Content-Length so a flushed response is complete even if the connection closes
// right after.
func handlerWriteJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		log.Printf("remote mode: encode response: %v\n", err)
		status = http.StatusInternalServerError
		body = []byte(`{"error":"encode response"}`)
	}
	h := w.Header()
	h.Set("Content-Type", handlerJSONType)
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	w.Write(body)
}
