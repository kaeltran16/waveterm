// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardscribe

import (
	"fmt"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestSourceKey(t *testing.T) {
	src := wshrpc.BoardSource{Kind: "agent", Ref: "t1"}
	if got := SourceKey(src, ""); got != "agent:t1" {
		t.Errorf("no ask: got %q", got)
	}
	if got := SourceKey(src, "  The   Data model "); got != "agent:t1|the data model" {
		t.Errorf("ask: got %q", got)
	}
	if SourceKey(src, "   ") != "agent:t1" {
		t.Errorf("a blank ask must not add a suffix")
	}
}

const goodSkeleton = `[{"type":"rectangle","id":"a","x":0,"y":0,"width":10,"height":10,"label":{"text":"A"}},{"type":"text","id":"b","x":0,"y":40,"text":"note"},{"type":"arrow","id":"ab","x":0,"y":0,"start":{"id":"a"},"end":{"id":"b"}}]`

func manyShapes(n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = fmt.Sprintf(`{"type":"text","id":"s%d","x":0,"y":0,"text":"x"}`, i)
	}
	return `{"skeleton":[` + strings.Join(parts, ",") + `]}`
}

func TestCheckReply(t *testing.T) {
	cases := []struct {
		name    string
		reply   string
		shapes  int
		wantErr string // "" = accepted; else a substring of the error
	}{
		{"plain", `{"skeleton":` + goodSkeleton + `}`, 3, ""},
		{"spaced", "\n  {\"skeleton\": [ {\"type\":\"ellipse\", \"id\":\"e\"} ] }  \n", 1, ""},
		{"fenced", "```json\n{\"skeleton\":" + goodSkeleton + "}\n```", 3, ""},
		{"empty", "   \n", 0, NoDrawingReason},
		{"prose around", "Here is the drawing:\n{\"skeleton\":" + goodSkeleton + "}\nHope it helps", 0, unusableHead + "the reply is not one JSON object"},
		{"two objects", `{"skeleton":` + goodSkeleton + `}{"skeleton":[]}`, 0, "not one JSON object"},
		{"no skeleton", `{"elements":[]}`, 0, "no skeleton array"},
		{"skeleton not array", `{"skeleton":"x"}`, 0, "not an array"},
		{"empty array", `{"skeleton":[]}`, 0, "empty"},
		{"bad type", `{"skeleton":[{"type":"star","id":"a"}]}`, 0, `type "star"`},
		{"missing id", `{"skeleton":[{"type":"text","text":"x"}]}`, 0, "no id"},
		{"duplicate id", `{"skeleton":[{"type":"text","id":"a"},{"type":"ellipse","id":"a"}]}`, 0, "used twice"},
		{"dangling arrow id", `{"skeleton":[{"type":"rectangle","id":"a"},{"type":"arrow","id":"x","start":{"id":"a"},"end":{"id":"nope"}}]}`, 0, `"nope"`},
		{"200 entries", manyShapes(MaxShapes), MaxShapes, ""},
		{"201 entries", manyShapes(MaxShapes + 1), 0, "more than 200"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			skel, n, err := CheckReply(c.reply)
			if c.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("want error containing %q, got %v", c.wantErr, err)
				}
				if c.wantErr != NoDrawingReason && !strings.HasPrefix(err.Error(), unusableHead) {
					t.Errorf("error %q must start %q", err, unusableHead)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if n != c.shapes {
				t.Errorf("shapes: got %d, want %d", n, c.shapes)
			}
			if !strings.HasPrefix(skel, "[") || strings.ContainsAny(skel, "\n") || strings.Contains(skel, ", ") {
				t.Errorf("skeleton not a compact array: %q", skel)
			}
		})
	}
}

func TestPromptRedrawCarriesPrevious(t *testing.T) {
	in := PromptInput{BoardName: "Data model", SourceTitle: "claude · waveterm", ThingText: "turn text [BOARD]", Reading: "the 16:09 turn end"}
	first := Prompt(in)
	for _, want := range []string{`"Data model"`, "claude · waveterm", "the 16:09 turn end", "turn text [BOARD]", wholeAsk, `{"skeleton":`} {
		if !strings.Contains(first, want) {
			t.Errorf("first draw prompt lacks %q", want)
		}
	}
	if strings.Contains(first, "What you drew before") {
		t.Errorf("a first draw must not carry a previous section")
	}
	in.Ask = "the store"
	in.Previous = goodSkeleton
	redraw := Prompt(in)
	if !strings.Contains(redraw, "What you drew before") || !strings.Contains(redraw, goodSkeleton) {
		t.Errorf("redraw prompt lacks the previous skeleton")
	}
	if !strings.Contains(redraw, "Focus: the store") {
		t.Errorf("redraw prompt lacks the ask")
	}
	if strings.Contains(redraw, "[PREVIOUS]") || strings.Contains(redraw, "[ASK]") {
		t.Errorf("placeholders left unfilled")
	}
}

func TestToolGuardFailsClosedOnExtraTools(t *testing.T) {
	cancelled := false
	g := &toolGuard{cancel: func() { cancelled = true }}
	if err := g.check([]byte(`{"type":"system","subtype":"init","tools":["Read","Glob","Grep"]}`)); err != nil || !g.sawInit {
		t.Fatalf("read-only tools refused: %v", err)
	}
	g = &toolGuard{cancel: func() { cancelled = true }}
	err := g.check([]byte(`{"type":"system","subtype":"init","tools":["Read","Bash","Edit"]}`))
	if err == nil || !cancelled || !strings.Contains(err.Error(), "Bash, Edit") {
		t.Fatalf("extra tools not refused: err=%v cancelled=%v", err, cancelled)
	}
	if g.check([]byte(`{"type":"assistant"}`)) == nil {
		t.Errorf("a failed guard must keep failing later lines")
	}
}
