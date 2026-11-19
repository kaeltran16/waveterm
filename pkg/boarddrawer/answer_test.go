// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boarddrawer

import (
	"fmt"
	"strings"
	"testing"
)

var checkScene = Scene{Types: map[string]string{"box": "rectangle", "note": "text", "link": "arrow", "wire": "line"}, Shapes: 4}

const goodAdd = `[{"type":"rectangle","id":"a","x":0,"y":300,"width":10,"height":10,"label":{"text":"A"}}, {"type":"text","id":"b","x":0,"y":340,"text":"note"},{"type":"arrow","id":"ab","x":0,"y":300,"start":{"id":"a"},"end":{"id":"b"}}]`

func answerWith(fields string) string {
	return `{"reply":"It splits in two.","title":"wavesrv, opened up"` + fields + `}`
}

func manyAdds(n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = fmt.Sprintf(`{"type":"text","id":"s%d","x":0,"y":0,"text":"x"}`, i)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func TestCheckAnswer(t *testing.T) {
	a, err := CheckAnswer("```json\n"+answerWith(`,"add":`+goodAdd+`,"update":[{"id":"box", "x":40,"label":"wavesrv"},{"id":"note","text":"hi","strokeColor":"#e03131"}],"remove":["wire"],"elsewhere":false`)+"\n```", checkScene, false)
	if err != nil {
		t.Fatalf("valid answer refused: %v", err)
	}
	if a.Title != "wavesrv, opened up" || a.Added != 3 || a.Changed != 2 || a.Removed != 1 || a.Elsewhere || a.Question {
		t.Errorf("answer: %+v", a)
	}
	for name, s := range map[string]string{"add": a.Add, "update": a.Update} {
		if !strings.HasPrefix(s, "[") || strings.Contains(s, ", ") || strings.Contains(s, "\n") {
			t.Errorf("%s is not a compact array: %q", name, s)
		}
	}
	if len(a.Remove) != 1 || a.Remove[0] != "wire" {
		t.Errorf("remove: %v", a.Remove)
	}

	// a reply key is ignored: words alone draw nothing and flag nothing, and the turn decides what that means
	words, err := CheckAnswer(`{"reply":"No drawing needed: it is one process."}`, checkScene, false)
	if err != nil || words.HasDrawing() || words.Question || words.Add != "" || words.Update != "" || words.Title != "" {
		t.Errorf("words only must be valid with no drawing and no question: %+v %v", words, err)
	}
	q, err := CheckAnswer(`{"question":true}`, checkScene, false)
	if err != nil || !q.Question || q.HasDrawing() || q.Elsewhere {
		t.Errorf("a question flag must pass as a question: %+v %v", q, err)
	}
	if a, err := CheckAnswer(`{"title":"x","add":`+goodAdd+`}`, checkScene, false); err != nil || a.Added != 3 {
		t.Errorf("a drawing with no reply must pass: %+v %v", a, err)
	}

	cases := []struct {
		name, reply string
		allow       bool
		wantErr     string
	}{
		{"blank output", "  \n", false, "without a reply"},
		{"question with a drawing", `{"question":true,"title":"x","add":` + goodAdd + `}`, false, "flags a question and also changes"},
		{"question with elsewhere", `{"question":true,"elsewhere":true}`, true, "flags a question and also says elsewhere"},
		{"question of the wrong type", `{"question":"yes"}`, false, "wrong types"},
		{"prose around", "Here:\n" + answerWith(""), false, "not one JSON object"},
		{"two objects", answerWith("") + answerWith(""), false, "not one JSON object"},
		{"an array", `[` + answerWith("") + `]`, false, "not one JSON object"},
		{"update id not in scene", answerWith(`,"update":[{"id":"nope","x":1}]`), false, `"nope", which is not on the board`},
		{"text on a non-text element", answerWith(`,"update":[{"id":"box","text":"hi"}]`), false, `text on "box"`},
		{"label on a text element", answerWith(`,"update":[{"id":"note","label":"hi"}]`), false, `label on "note"`},
		{"label on a line", answerWith(`,"update":[{"id":"wire","label":"hi"}]`), false, `label on "wire"`},
		{"unknown update key", answerWith(`,"update":[{"id":"box","angle":2}]`), false, `"angle"`},
		{"update key of the wrong type", answerWith(`,"update":[{"id":"box","x":"left"}]`), false, `"x" is not a number`},
		{"update without id", answerWith(`,"update":[{"x":1}]`), false, "has no id"},
		{"update twice", answerWith(`,"update":[{"id":"box","x":1},{"id":"box","y":1}]`), false, `"box" twice`},
		{"remove id not in scene", answerWith(`,"remove":["gone"]`), false, `remove names "gone"`},
		{"arrow binding outside add", answerWith(`,"add":[{"type":"arrow","id":"x","start":{"id":"box"}}]`), false, `binds to "box"`},
		{"bad add type", answerWith(`,"add":[{"type":"star","id":"a"}]`), false, `type "star"`},
		{"add without id", answerWith(`,"add":[{"type":"text","text":"x"}]`), false, "has no id"},
		{"add id twice", answerWith(`,"add":[{"type":"text","id":"a"},{"type":"ellipse","id":"a"}]`), false, "used twice"},
		{"201 entries", answerWith(`,"add":` + manyAdds(MaxShapes) + `,"remove":["wire"]`), false, "201 entries"},
		{"drawing without a title", `{"reply":"done","add":` + goodAdd + `}`, false, "no title"},
		{"elsewhere with a drawing", answerWith(`,"elsewhere":true,"add":` + goodAdd), true, "elsewhere and also changes"},
		{"elsewhere not allowed", `{"reply":"New board?","elsewhere":true}`, false, "says elsewhere"},
		{"wrong field types", `{"reply":"x","remove":[1]}`, false, "wrong types"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := CheckAnswer(c.reply, checkScene, c.allow)
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("want error containing %q, got %v", c.wantErr, err)
			}
			if !strings.HasPrefix(err.Error(), unusableHead) {
				t.Errorf("error %q must start %q", err, unusableHead)
			}
		})
	}

	if _, err := CheckAnswer(answerWith(`,"add":`+manyAdds(MaxShapes)), checkScene, false); err != nil {
		t.Errorf("200 entries must pass: %v", err)
	}
	ask, err := CheckAnswer(`{"reply":"This is about the store. New board?","elsewhere":true}`, checkScene, true)
	if err != nil || !ask.Elsewhere || ask.HasDrawing() {
		t.Errorf("an allowed elsewhere with no drawing must pass: %+v %v", ask, err)
	}
}
