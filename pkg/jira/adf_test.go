// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestADFToPlain(t *testing.T) {
	doc := `{"type":"doc","version":1,"content":[
		{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Context"}]},
		{"type":"paragraph","content":[
			{"type":"text","text":"Ask "},
			{"type":"mention","attrs":{"id":"abc","text":"@Ana"}},
			{"type":"text","text":" about"},
			{"type":"hardBreak"},
			{"type":"inlineCard","attrs":{"url":"https://acme.atlassian.net/browse/PAY-1"}}
		]},
		{"type":"bulletList","content":[
			{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]}]},
			{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"two"}]}]}
		]},
		{"type":"orderedList","attrs":{"order":3},"content":[
			{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"third"}]}]},
			{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"fourth"}]}]}
		]},
		{"type":"someFutureNode","content":[{"type":"text","text":"kept"}]}
	]}`
	want := "Context\n\n" +
		"Ask @Ana about\nhttps://acme.atlassian.net/browse/PAY-1\n\n" +
		"- one\n- two\n\n" +
		"3. third\n4. fourth\n\n" +
		"kept"
	if got := ADFToPlain(json.RawMessage(doc), nil); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestADFToPlainMarksMedia(t *testing.T) {
	atts := []wshrpc.JiraAttachment{
		{ID: "10001", Filename: "normal-results.png", MimeType: "image/png"},
		{ID: "10002", Filename: "dup.png", MimeType: "image/png"},
		{ID: "10003", Filename: "dup.png", MimeType: "image/png"},
		{ID: "10004", Filename: "trace.log", MimeType: "text/plain"},
	}
	media := func(attrs string) string {
		return `{"type":"mediaSingle","attrs":{"layout":"center"},"content":[{"type":"media","attrs":` + attrs + `}]}`
	}
	doc := `{"type":"doc","version":1,"content":[
		{"type":"paragraph","content":[{"type":"text","text":"Normal results:"}]},
		` + media(`{"id":"8f2c-uuid","type":"file","collection":"c","alt":"normal-results.png"}`) + `,
		` + media(`{"id":"a","type":"file","collection":"c","alt":"dup.png"}`) + `,
		` + media(`{"id":"b","type":"file","collection":"c","alt":"gone.png"}`) + `,
		` + media(`{"id":"c","type":"file","collection":"c"}`) + `,
		` + media(`{"type":"external","url":"https://example.com/x.png"}`) + `,
		{"type":"mediaGroup","content":[
			{"type":"media","attrs":{"id":"d","type":"file","collection":"c","alt":"trace.log"}},
			{"type":"media","attrs":{"id":"e","type":"file","collection":"c","alt":"normal-results.png"}}
		]},
		{"type":"paragraph","content":[
			{"type":"text","text":"see "},
			{"type":"mediaInline","attrs":{"id":"f","type":"file","collection":"c","alt":"normal-results.png"}},
			{"type":"text","text":" inline"}
		]}
	]}`
	want := "Normal results:\n\n" +
		"[image: normal-results.png (attachment 10001)]\n\n" +
		"[image: dup.png (attachment 10002 or 10003)]\n\n" +
		"[image: gone.png]\n\n" +
		"[image]\n\n" +
		"[image: https://example.com/x.png]\n\n" +
		"[file: trace.log (attachment 10004)]\n[image: normal-results.png (attachment 10001)]\n\n" +
		"see [image: normal-results.png (attachment 10001)] inline"
	if got := ADFToPlain(json.RawMessage(doc), atts); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
	// without the attachment list a media node still shows, by its name
	if got := ADFToPlain(json.RawMessage(`{"type":"doc","content":[`+media(`{"id":"x","type":"file","alt":"a.png"}`)+`]}`), nil); got != "[image: a.png]" {
		t.Errorf("no attachments: got %q", got)
	}
}

func TestADFToPlainEmpty(t *testing.T) {
	for _, in := range []string{"", "null", `{"type":"doc","version":1,"content":[]}`} {
		if got := ADFToPlain(json.RawMessage(in), nil); got != "" {
			t.Errorf("ADFToPlain(%q) = %q", in, got)
		}
	}
}

func TestPlainToADF(t *testing.T) {
	plain := "Progress: 1 of 3 parts done.\n\nDone\n- Retry 429s. Merged.\n- Give up after 6.\n\nIn progress\n- Dashboard\n\nThanks\nKael"
	text := func(s string) map[string]any { return map[string]any{"type": "text", "text": s} }
	para := func(c ...any) map[string]any { return map[string]any{"type": "paragraph", "content": c} }
	strong := func(s string) map[string]any {
		return para(map[string]any{"type": "text", "text": s, "marks": []any{map[string]any{"type": "strong"}}})
	}
	bullets := func(items ...string) map[string]any {
		lis := []any{}
		for _, it := range items {
			lis = append(lis, map[string]any{"type": "listItem", "content": []any{para(text(it))}})
		}
		return map[string]any{"type": "bulletList", "content": lis}
	}
	want := map[string]any{"type": "doc", "version": 1, "content": []any{
		para(text("Progress: 1 of 3 parts done.")),
		strong("Done"),
		bullets("Retry 429s. Merged.", "Give up after 6."),
		strong("In progress"),
		bullets("Dashboard"),
		para(text("Thanks"), map[string]any{"type": "hardBreak"}, text("Kael")),
	}}
	got := PlainToADF(plain)
	// compare through JSON: the wire form is what Jira sees
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(want)
	var g, w any
	json.Unmarshal(gotJSON, &g)
	json.Unmarshal(wantJSON, &w)
	if !reflect.DeepEqual(g, w) {
		t.Errorf("got:\n%s\nwant:\n%s", gotJSON, wantJSON)
	}
}
