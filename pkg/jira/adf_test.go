// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"encoding/json"
	"reflect"
	"testing"
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
	if got := ADFToPlain(json.RawMessage(doc)); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestADFToPlainEmpty(t *testing.T) {
	for _, in := range []string{"", "null", `{"type":"doc","version":1,"content":[]}`} {
		if got := ADFToPlain(json.RawMessage(in)); got != "" {
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
