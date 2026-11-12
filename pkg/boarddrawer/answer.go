// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boarddrawer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// MaxShapes is the most entries one answer may carry across add, update and remove.
const MaxShapes = 200

const (
	unusableHead = "the drawer's answer is not usable: "
	jsonFence    = "```json"
	plainFence   = "```"
)

// skeletonTypes is the vocabulary the prompt names; anything else would not convert.
var skeletonTypes = map[string]bool{
	"rectangle": true, "ellipse": true, "diamond": true, typeText: true, "line": true, typeArrow: true,
}

// labelTypes are the elements whose label is bound text: containers and arrows.
var labelTypes = map[string]bool{"rectangle": true, "ellipse": true, "diamond": true, typeArrow: true}

// updateKeys is what an update may patch, by the JSON type its value must have.
var updateKeys = map[string]string{
	"id": "string", "x": "number", "y": "number", "width": "number", "height": "number",
	"text": "string", "label": "string", "strokeColor": "string", "backgroundColor": "string",
}

// Answer is a checked drawer reply. Add and Update are compact JSON arrays, "" when empty.
type Answer struct {
	Reply, Title, Add, Update string
	Remove                    []string
	Added, Changed, Removed   int
	Elsewhere                 bool
}

func (a Answer) HasDrawing() bool {
	return a.Added+a.Changed+a.Removed > 0
}

type skeletonEntry struct {
	Type  string     `json:"type"`
	Id    *string    `json:"id"`
	Start *bindingId `json:"start"`
	End   *bindingId `json:"end"`
}

type bindingId struct {
	Id *string `json:"id"`
}

// CheckAnswer checks the drawer's reply against the scene it was shown. Code, not the drawer, decides whether an
// answer is usable: one that would not apply fails the turn with the reason.
func CheckAnswer(reply string, scene Scene, allowElsewhere bool) (Answer, error) {
	body := strings.TrimSpace(reply)
	if body == "" {
		return Answer{}, unusable("the drawer ended without a reply")
	}
	var raw struct {
		Reply     *string           `json:"reply"`
		Title     string            `json:"title"`
		Add       []json.RawMessage `json:"add"`
		Update    []json.RawMessage `json:"update"`
		Remove    []string          `json:"remove"`
		Elsewhere bool              `json:"elsewhere"`
	}
	obj, err := oneObject(unfence(body))
	if err != nil {
		return Answer{}, unusable("%s", err)
	}
	if err := json.Unmarshal(obj, &raw); err != nil {
		return Answer{}, unusable("the reply's fields have the wrong types (%v)", err)
	}
	if raw.Reply == nil || strings.TrimSpace(*raw.Reply) == "" {
		return Answer{}, unusable("the reply has no words in reply")
	}
	a := Answer{
		Reply: strings.TrimSpace(*raw.Reply), Title: strings.TrimSpace(raw.Title), Remove: raw.Remove,
		Added: len(raw.Add), Changed: len(raw.Update), Removed: len(raw.Remove), Elsewhere: raw.Elsewhere,
	}
	if n := a.Added + a.Changed + a.Removed; n > MaxShapes {
		return Answer{}, unusable("it has %d entries across add, update and remove, more than %d", n, MaxShapes)
	}
	if a.Elsewhere && !allowElsewhere {
		return Answer{}, unusable("it says elsewhere, which only a briefing on a board with earlier turns may")
	}
	if a.Elsewhere && a.HasDrawing() {
		return Answer{}, unusable("it says elsewhere and also changes the drawing")
	}
	if a.HasDrawing() && a.Title == "" {
		return Answer{}, unusable("it changes the drawing but has no title")
	}
	if err := checkAdd(raw.Add); err != nil {
		return Answer{}, err
	}
	if err := checkUpdate(raw.Update, scene); err != nil {
		return Answer{}, err
	}
	for _, id := range raw.Remove {
		if _, ok := scene.Types[id]; !ok {
			return Answer{}, unusable("remove names %q, which is not on the board", id)
		}
	}
	if a.Add, err = compactArray(raw.Add); err != nil {
		return Answer{}, err
	}
	if a.Update, err = compactArray(raw.Update); err != nil {
		return Answer{}, err
	}
	return a, nil
}

func checkAdd(add []json.RawMessage) error {
	entries := make([]skeletonEntry, len(add))
	ids := make(map[string]bool, len(add))
	for i, r := range add {
		if json.Unmarshal(r, &entries[i]) != nil {
			return unusable("add entry %d is not a shape", i+1)
		}
		e := entries[i]
		if !skeletonTypes[e.Type] {
			return unusable("add entry %d has type %q, not one of rectangle, ellipse, diamond, text, line, arrow", i+1, e.Type)
		}
		if e.Id == nil || strings.TrimSpace(*e.Id) == "" {
			return unusable("add entry %d has no id", i+1)
		}
		if ids[*e.Id] {
			return unusable("the id %q is used twice in add", *e.Id)
		}
		ids[*e.Id] = true
	}
	for _, e := range entries {
		if e.Type != typeArrow {
			continue
		}
		for _, end := range []*bindingId{e.Start, e.End} {
			if end != nil && end.Id != nil && !ids[*end.Id] {
				return unusable("the arrow %q binds to %q, which is not a shape in add", *e.Id, *end.Id)
			}
		}
	}
	return nil
}

func checkUpdate(update []json.RawMessage, scene Scene) error {
	seen := make(map[string]bool, len(update))
	for i, r := range update {
		var patch map[string]json.RawMessage
		if json.Unmarshal(r, &patch) != nil || patch == nil {
			return unusable("update entry %d is not an object", i+1)
		}
		for k, v := range patch {
			kind, ok := updateKeys[k]
			if !ok {
				return unusable("update entry %d has the key %q, which an update cannot change", i+1, k)
			}
			if !hasKind(v, kind) {
				return unusable("update entry %d's %q is not a %s", i+1, k, kind)
			}
		}
		var id string
		if json.Unmarshal(patch["id"], &id) != nil || id == "" {
			return unusable("update entry %d has no id", i+1)
		}
		typ, ok := scene.Types[id]
		if !ok {
			return unusable("update names %q, which is not on the board", id)
		}
		if seen[id] {
			return unusable("update names %q twice", id)
		}
		seen[id] = true
		if _, ok := patch["text"]; ok && typ != typeText {
			return unusable("update sets text on %q, a %s, not a text element", id, typ)
		}
		if _, ok := patch["label"]; ok && !labelTypes[typ] {
			return unusable("update sets a label on %q, a %s, which has no label", id, typ)
		}
	}
	return nil
}

func hasKind(v json.RawMessage, kind string) bool {
	if kind == "number" {
		var f float64
		return json.Unmarshal(v, &f) == nil
	}
	var s string
	return json.Unmarshal(v, &s) == nil
}

func compactArray(entries []json.RawMessage) (string, error) {
	if len(entries) == 0 {
		return "", nil
	}
	// Marshal compacts each raw entry
	b, err := json.Marshal(entries)
	if err != nil {
		return "", unusable("%s", err)
	}
	return string(b), nil
}

// unfence strips one ```json (or bare ```) fence around the whole reply; anything else is left for oneObject to refuse.
func unfence(body string) string {
	if !strings.HasPrefix(body, plainFence) || !strings.HasSuffix(body, plainFence) || len(body) < 2*len(plainFence) {
		return body
	}
	inner := strings.TrimSuffix(body, plainFence)
	inner = strings.TrimPrefix(inner, jsonFence)
	inner = strings.TrimPrefix(inner, plainFence)
	if strings.Contains(inner, plainFence) {
		return body
	}
	return strings.TrimSpace(inner)
}

func oneObject(body string) (json.RawMessage, error) {
	dec := json.NewDecoder(strings.NewReader(body))
	var obj json.RawMessage
	notOne := errors.New("the reply is not one JSON object")
	if err := dec.Decode(&obj); err != nil || !bytes.HasPrefix(obj, []byte("{")) {
		return nil, notOne
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, notOne
	}
	return obj, nil
}

func unusable(format string, args ...any) error {
	return fmt.Errorf(unusableHead+format, args...)
}
