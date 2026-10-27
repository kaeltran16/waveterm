// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/remotemode"
)

func TestFixtureMain(t *testing.T) {
	list, err := fixtureList(fixtureMain, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Questions) != 3 {
		t.Fatalf("want 3 questions, got %d", len(list.Questions))
	}

	first := list.Questions[0].Questions
	if len(first) != 1 || first[0].MultiSelect {
		t.Fatalf("first ask: want one single-select question, got %+v", first)
	}
	var recommended, preview bool
	for _, o := range first[0].Options {
		recommended = recommended || strings.HasSuffix(o.Label, "(Recommended)")
		preview = preview || o.Preview != ""
	}
	if !recommended || !preview {
		t.Fatalf("first ask: want a (Recommended) option and a preview, got %+v", first[0].Options)
	}

	second := list.Questions[1].Questions
	if len(second) != 2 || second[0].MultiSelect || !second[1].MultiSelect {
		t.Fatalf("second ask: want two questions, only the second multi-select, got %+v", second)
	}

	if list.Questions[2].ORef != withdrawnORef {
		t.Fatalf("third ask: want the withdrawn one, got %q", list.Questions[2].ORef)
	}
	if len(list.Shown) != 2 {
		t.Fatalf("want 2 held runs, got %d", len(list.Shown))
	}
	for _, s := range list.Shown {
		if s.Kind != jarvis.AttentionRunLandHeld || strings.Count(s.Reason, "\n") < 3 {
			t.Fatalf("held run: want kind %s with a multi-line git message, got %+v", jarvis.AttentionRunLandHeld, s)
		}
	}

	empty, err := fixtureList(fixtureEmpty, time.Now())
	if err != nil || len(empty.Questions) != 0 || len(empty.Shown) != 0 {
		t.Fatalf("empty fixture: got %+v, %v", empty, err)
	}
	if _, err := fixtureList("nope", time.Now()); err == nil {
		t.Fatal("an unknown fixture must fail")
	}
}

func TestFixtureMainAnswer(t *testing.T) {
	list, _ := fixtureList(fixtureMain, time.Now())
	var out bytes.Buffer
	p := &preview{list: list, out: &out}
	ctx := context.Background()
	answers := []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}}

	withdrawn := list.Questions[2]
	if err := p.answer(ctx, withdrawn.ORef, withdrawn.AskId, answers); !errors.Is(err, remotemode.ErrAskGone) {
		t.Fatalf("withdrawn ask: want ErrAskGone, got %v", err)
	}
	first := list.Questions[0]
	if err := p.answer(ctx, first.ORef, first.AskId, answers); err != nil {
		t.Fatal(err)
	}
	if err := p.answer(ctx, first.ORef, first.AskId, answers); !errors.Is(err, remotemode.ErrAskGone) {
		t.Fatalf("a second answer to the same ask: want ErrAskGone, got %v", err)
	}
	got, _ := p.waiting(ctx)
	if len(got.Questions) != 2 || got.Questions[0].ORef == first.ORef {
		t.Fatalf("the answered question must leave the list, got %+v", got.Questions)
	}
	want := `REMOTEPREVIEW answer {"answers":[{"selectedindexes":[0]}],"askid":"` + first.AskId + `","oref":"` + first.ORef + `"}` + "\n"
	if out.String() != want {
		t.Fatalf("recorded:\n%s\nwant:\n%s", out.String(), want)
	}
}

func TestPreviewServes(t *testing.T) {
	list, _ := fixtureList(fixtureMain, time.Now())
	vapid, err := vapidPublic()
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if ip := ln.Addr().(*net.TCPAddr).IP; !ip.IsLoopback() {
		t.Fatalf("want a loopback listener, got %s", ip)
	}
	base := "http://" + ln.Addr().String()
	p := &preview{list: list, out: io.Discard}
	srv := &http.Server{Handler: p.handler(base, vapid)}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })

	page := previewGet(t, base+"/")
	if !strings.Contains(page, "phone.js") {
		t.Fatalf("GET /: want the phone page, got %q", page)
	}
	var got remotemode.WaitingList
	if err := json.Unmarshal([]byte(previewGet(t, base+"/api/waiting")), &got); err != nil {
		t.Fatal(err)
	}
	if got.VapidPublic != vapid || len(got.Questions) != 3 || len(got.Shown) != 2 {
		t.Fatalf("GET /api/waiting: got vapid %q, %d questions, %d shown", got.VapidPublic, len(got.Questions), len(got.Shown))
	}
}

func previewGet(t *testing.T, url string) string {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: %d %s", url, res.StatusCode, body)
	}
	return string(body)
}
