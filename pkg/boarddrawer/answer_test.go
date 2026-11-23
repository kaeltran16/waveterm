// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boarddrawer

import (
	"fmt"
	"strings"
	"testing"
)

// checkScene holds two drawings: f1 (box, note, link, wire) and f2 (other), and the loose shape loose.
var checkScene = Scene{
	Types: map[string]string{
		"box": "rectangle", "note": "text", "link": "arrow", "wire": "line", "f1": "frame",
		"other": "rectangle", "f2": "frame", "loose": "ellipse",
	},
	Frames:  map[string]string{"f1": "Cache", "f2": "API"},
	FrameOf: map[string]string{"box": "f1", "note": "f1", "link": "f1", "wire": "f1", "other": "f2"},
	Shapes:  6,
}

const (
	twelveWords   = "one two three four five six seven eight nine ten eleven twelve"
	thirteenWords = twelveWords + " thirteen"
)

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
	// an edit whose add, update and remove stay in the drawing in view
	a, err := CheckAnswer("```json\n"+answerWith(`,"edit":true,"add":`+goodAdd+`,"update":[{"id":"box", "x":40,"label":"wavesrv"},{"id":"note","text":"hi","strokeColor":"#e03131"}],"remove":["wire"],"elsewhere":false`)+"\n```", checkScene, false, "f1")
	if err != nil {
		t.Fatalf("valid answer refused: %v", err)
	}
	if !a.Edit || a.Title != "wavesrv, opened up" || a.Added != 3 || a.Changed != 2 || a.Removed != 1 || a.Elsewhere || a.Question {
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
	words, err := CheckAnswer(`{"reply":"No drawing needed: it is one process."}`, checkScene, false, "")
	if err != nil || words.HasDrawing() || words.Question || words.Add != "" || words.Update != "" || words.Title != "" {
		t.Errorf("words only must be valid with no drawing and no question: %+v %v", words, err)
	}
	q, err := CheckAnswer(`{"question":true}`, checkScene, false, "")
	if err != nil || !q.Question || q.HasDrawing() || q.Elsewhere {
		t.Errorf("a question flag must pass as a question: %+v %v", q, err)
	}
	// a new drawing that only adds, with or without a drawing in view
	for _, inView := range []string{"", "f1"} {
		if a, err := CheckAnswer(`{"title":"x","add":`+goodAdd+`}`, checkScene, false, inView); err != nil || a.Added != 3 || a.Edit {
			t.Errorf("a new drawing (in view %q) must pass: %+v %v", inView, a, err)
		}
	}
	at := fmt.Sprintf(`,"add":[{"type":"rectangle","id":"a","label":{"text":%q}},{"type":"text","id":"b","text":%q}],"update":[{"id":"note","text":%q}]`, twelveWords, twelveWords, twelveWords)
	if _, err := CheckAnswer(answerWith(`,"edit":true`+at), checkScene, false, "f1"); err != nil {
		t.Errorf("%d words must pass: %v", MaxLabelWords, err)
	}

	edit := func(fields string) string { return answerWith(`,"edit":true` + fields) }
	cases := []struct {
		name, reply string
		allow       bool
		drawing     string
		wantErr     string
	}{
		{"blank output", "  \n", false, "", "without a reply"},
		{"question with a drawing", `{"question":true,"title":"x","add":` + goodAdd + `}`, false, "", "flags a question and also changes"},
		{"question with elsewhere", `{"question":true,"elsewhere":true}`, true, "", "flags a question and also says elsewhere"},
		{"question of the wrong type", `{"question":"yes"}`, false, "", "wrong types"},
		{"prose around", "Here:\n" + answerWith(""), false, "", "not one JSON object"},
		{"two objects", answerWith("") + answerWith(""), false, "", "not one JSON object"},
		{"an array", `[` + answerWith("") + `]`, false, "", "not one JSON object"},
		{"update id not in scene", answerWith(`,"update":[{"id":"nope","x":1}]`), false, "", `"nope", which is not on the board`},
		{"text on a non-text element", answerWith(`,"update":[{"id":"box","text":"hi"}]`), false, "", `text on "box"`},
		{"label on a text element", answerWith(`,"update":[{"id":"note","label":"hi"}]`), false, "", `label on "note"`},
		{"label on a line", answerWith(`,"update":[{"id":"wire","label":"hi"}]`), false, "", `label on "wire"`},
		{"unknown update key", answerWith(`,"update":[{"id":"box","angle":2}]`), false, "", `"angle"`},
		{"update key of the wrong type", answerWith(`,"update":[{"id":"box","x":"left"}]`), false, "", `"x" is not a number`},
		{"update without id", answerWith(`,"update":[{"x":1}]`), false, "", "has no id"},
		{"update twice", answerWith(`,"update":[{"id":"box","x":1},{"id":"box","y":1}]`), false, "", `"box" twice`},
		{"remove id not in scene", answerWith(`,"remove":["gone"]`), false, "", `remove names "gone"`},
		{"arrow binding outside add", answerWith(`,"add":[{"type":"arrow","id":"x","start":{"id":"box"}}]`), false, "", `binds to "box"`},
		{"bad add type", answerWith(`,"add":[{"type":"star","id":"a"}]`), false, "", `type "star"`},
		{"add without id", answerWith(`,"add":[{"type":"text","text":"x"}]`), false, "", "has no id"},
		{"add id twice", answerWith(`,"add":[{"type":"text","id":"a"},{"type":"ellipse","id":"a"}]`), false, "", "used twice"},
		{"201 entries", answerWith(`,"add":` + manyAdds(MaxShapes) + `,"remove":["wire"]`), false, "", "201 entries"},
		{"drawing without a title", `{"reply":"done","add":` + goodAdd + `}`, false, "", "no title"},
		{"elsewhere with a drawing", answerWith(`,"elsewhere":true,"add":` + goodAdd), true, "", "elsewhere and also changes"},
		{"elsewhere not allowed", `{"reply":"New board?","elsewhere":true}`, false, "", "says elsewhere"},
		{"wrong field types", `{"reply":"x","remove":[1]}`, false, "", "wrong types"},
		{"edit with no drawing in view", edit(`,"add":` + goodAdd), false, "", "no drawing is in view"},
		{"edit of a drawing no longer on the board", edit(`,"add":` + goodAdd), false, "gone", "no drawing is in view"},
		{"edit updating another drawing's shape", edit(`,"update":[{"id":"other","x":1}]`), false, "f1", `"other", which is outside the drawing`},
		{"edit removing a loose shape", edit(`,"remove":["loose"]`), false, "f1", `"loose", which is outside the drawing`},
		{"edit updating its frame", edit(`,"update":[{"id":"f1","x":1}]`), false, "f1", `"f1", a drawing's frame`},
		{"edit removing a frame", edit(`,"remove":["f2"]`), false, "f1", `"f2", a drawing's frame`},
		{"new drawing that updates", answerWith(`,"update":[{"id":"box","x":1}]`), false, "f1", "a new drawing only adds"},
		{"new drawing that removes", answerWith(`,"remove":["loose"]`), false, "", "a new drawing only adds"},
		{"41 adds", answerWith(`,"add":` + manyAdds(MaxDrawingAdds+1)), false, "", "adds 41 shapes"},
		{"added text over 12 words", answerWith(`,"add":[{"type":"text","id":"t","text":"` + thirteenWords + `"}]`), false, "", "13 words"},
		{"added label over 12 words", answerWith(`,"add":[{"type":"ellipse","id":"e","label":{"text":"` + thirteenWords + `"}}]`), false, "", "13 words"},
		{"updated label over 12 words", edit(`,"update":[{"id":"box","label":"` + thirteenWords + `"}]`), false, "f1", "13 words"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := CheckAnswer(c.reply, checkScene, c.allow, c.drawing)
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("want error containing %q, got %v", c.wantErr, err)
			}
			if !strings.HasPrefix(err.Error(), unusableHead) {
				t.Errorf("error %q must start %q", err, unusableHead)
			}
		})
	}

	if _, err := CheckAnswer(answerWith(`,"add":`+manyAdds(MaxDrawingAdds)), checkScene, false, ""); err != nil {
		t.Errorf("%d adds must pass: %v", MaxDrawingAdds, err)
	}
	ask, err := CheckAnswer(`{"reply":"This is about the store. New board?","elsewhere":true}`, checkScene, true, "")
	if err != nil || !ask.Elsewhere || ask.HasDrawing() {
		t.Errorf("an allowed elsewhere with no drawing must pass: %+v %v", ask, err)
	}
}
