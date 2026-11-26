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

const (
	// MaxShapes is the most entries one answer may carry across add, update and remove.
	MaxShapes = 200
	// MaxDrawingAdds and MaxLabelWords refuse only a clear breach of "kept short": the prompt asks for far less.
	MaxDrawingAdds = 40
	MaxLabelWords  = 12
)

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

// graphDirections and graphShapes are the vocabulary of a graph; an absent value means the first of each.
var (
	graphDirections = map[string]bool{"TB": true, "LR": true, "BT": true, "RL": true}
	graphShapes     = map[string]bool{"rectangle": true, "ellipse": true, "diamond": true}
)

// Answer is a checked drawer reply: a drawing, a question flagged for the board's agent, or elsewhere. Add and
// Update are compact JSON arrays, Graph a compact JSON object, "" when empty. A drawing is new, or with Edit, a
// change to the drawing in view. Added counts add entries plus the graph's nodes, edges and groups; Removed counts
// remove entries, or for an edit with a graph, every shape of the drawing it redraws.
type Answer struct {
	Title, Add, Update, Graph string
	Remove                    []string
	Added, Changed, Removed   int
	Elsewhere, Question       bool
	Edit                      bool
}

func (a Answer) HasDrawing() bool {
	return a.Added+a.Changed+a.Removed > 0
}

type skeletonEntry struct {
	Type  string  `json:"type"`
	Id    *string `json:"id"`
	Text  string  `json:"text"`
	Label *struct {
		Text string `json:"text"`
	} `json:"label"`
	Start *bindingId `json:"start"`
	End   *bindingId `json:"end"`
}

type bindingId struct {
	Id *string `json:"id"`
}

type graphEntry struct {
	Id, Label, Shape, Group, From, To string
}

type graphBody struct {
	Direction string       `json:"direction"`
	Nodes     []graphEntry `json:"nodes"`
	Edges     []graphEntry `json:"edges"`
	Groups    []graphEntry `json:"groups"`
}

// CheckAnswer checks the drawer's reply against the scene it was shown and drawing, the frame id of the drawing in
// view (none when it is not a live frame). Code, not the drawer, decides whether an answer is usable: one that would
// not apply, or reaches outside its drawing, fails the turn with the reason. A reply key, the 11-12 words answer, is
// ignored.
func CheckAnswer(reply string, scene Scene, allowElsewhere bool, drawing string) (Answer, error) {
	body := strings.TrimSpace(reply)
	if body == "" {
		return Answer{}, unusable("the drawer ended without a reply")
	}
	var raw struct {
		Title     string            `json:"title"`
		Add       []json.RawMessage `json:"add"`
		Update    []json.RawMessage `json:"update"`
		Graph     json.RawMessage   `json:"graph"`
		Remove    []string          `json:"remove"`
		Elsewhere bool              `json:"elsewhere"`
		Question  bool              `json:"question"`
		Edit      bool              `json:"edit"`
	}
	obj, err := oneObject(unfence(body))
	if err != nil {
		return Answer{}, unusable("%s", err)
	}
	if err := json.Unmarshal(obj, &raw); err != nil {
		return Answer{}, unusable("the reply's fields have the wrong types (%v)", err)
	}
	graph, err := parseGraph(raw.Graph)
	if err != nil {
		return Answer{}, err
	}
	a := Answer{
		Title: strings.TrimSpace(raw.Title), Remove: raw.Remove,
		Added: len(raw.Add) + graph.shapes(), Changed: len(raw.Update), Removed: len(raw.Remove), Elsewhere: raw.Elsewhere, Question: raw.Question,
		Edit: raw.Edit,
	}
	if graph != nil && a.Edit && a.Changed+a.Removed > 0 {
		return Answer{}, unusable("an edit with a graph redraws the drawing, so it cannot also update or remove shapes")
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
	if a.Question && a.HasDrawing() {
		return Answer{}, unusable("it flags a question and also changes the drawing")
	}
	if a.Question && a.Elsewhere {
		return Answer{}, unusable("it flags a question and also says elsewhere")
	}
	if a.HasDrawing() && a.Title == "" {
		return Answer{}, unusable("it changes the drawing but has no title")
	}
	graphIds, err := checkGraph(graph)
	if err != nil {
		return Answer{}, err
	}
	if err := checkAdd(raw.Add, graphIds); err != nil {
		return Answer{}, err
	}
	updated, err := checkUpdate(raw.Update, scene)
	if err != nil {
		return Answer{}, err
	}
	for _, id := range raw.Remove {
		if _, ok := scene.Types[id]; !ok {
			return Answer{}, unusable("remove names %q, which is not on the board", id)
		}
	}
	if err := checkScope(a, append(updated, raw.Remove...), scene, drawing); err != nil {
		return Answer{}, err
	}
	// set only after the checks, which bound the reply's own counts, not the redraw's
	if graph != nil && a.Edit {
		a.Removed = shapesIn(scene, drawing)
	}
	if a.Add, err = compactArray(raw.Add); err != nil {
		return Answer{}, err
	}
	if a.Update, err = compactArray(raw.Update); err != nil {
		return Answer{}, err
	}
	if graph != nil {
		a.Graph, err = compactObject(raw.Graph)
	}
	return a, err
}

// routeAnswer settles what a checked answer does to its turn. On your own ask, an answer that draws nothing is a
// question for the agent, so a question is never dropped; a turn that must draw (mustDraw names why) fails instead.
func routeAnswer(a Answer, mustDraw string) (Answer, error) {
	if a.Elsewhere {
		return a, nil
	}
	if mustDraw != "" && a.Question {
		return Answer{}, unusable("it flags the line as a question, but %s", mustDraw)
	}
	if mustDraw != "" && !a.HasDrawing() {
		return Answer{}, unusable("it draws nothing, but %s", mustDraw)
	}
	if !a.HasDrawing() {
		a.Question, a.Title = true, ""
	}
	return a, nil
}

// checkScope keeps an answer to one drawing: a new drawing only adds, and an edit changes (updates or removes) only
// shapes of the drawing in view, never a frame. Both are kept short. An answer that draws nothing has no drawing to
// keep to, so its edit key is moot.
func checkScope(a Answer, changed []string, scene Scene, drawing string) error {
	if a.Added > MaxDrawingAdds {
		return unusable("it adds %d shapes, more than %d", a.Added, MaxDrawingAdds)
	}
	if _, ok := scene.Frames[drawing]; a.Edit && a.HasDrawing() && !ok {
		return unusable("it edits the drawing in view, but no drawing is in view")
	}
	if !a.Edit && a.Changed+a.Removed > 0 {
		return unusable("a new drawing only adds shapes, and it updates or removes shapes on the board")
	}
	for _, id := range changed {
		if scene.Types[id] == typeFrame {
			return unusable("it changes %q, a drawing's frame, which only Arc changes", id)
		}
		if scene.FrameOf[id] != drawing {
			return unusable("it changes %q, which is outside the drawing it edits", id)
		}
	}
	return nil
}

// shapesIn is how many shapes the scene puts in the drawing, its frame not counted.
func shapesIn(scene Scene, drawing string) int {
	n := 0
	for id, frame := range scene.FrameOf {
		if frame == drawing && id != drawing {
			n++
		}
	}
	return n
}

// tooWordy is the words a text or label has, when over MaxLabelWords; else 0.
func tooWordy(s string) int {
	if n := len(strings.Fields(s)); n > MaxLabelWords {
		return n
	}
	return 0
}

// parseGraph reads the reply's graph key: nil when it is absent or null.
func parseGraph(raw json.RawMessage) (*graphBody, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var g graphBody
	if err := json.Unmarshal(raw, &g); err != nil {
		return nil, unusable("the reply's fields have the wrong types (graph: %v)", err)
	}
	return &g, nil
}

// shapes is how many shapes the graph adds: its nodes, edges and groups. A nil graph adds none.
func (g *graphBody) shapes() int {
	if g == nil {
		return 0
	}
	return len(g.Nodes) + len(g.Edges) + len(g.Groups)
}

// checkGraph checks a graph's own rules and returns the ids it claims (nodes and groups), which add may not reuse
// and add arrows may bind.
func checkGraph(g *graphBody) (map[string]bool, error) {
	if g == nil {
		return nil, nil
	}
	if g.Direction != "" && !graphDirections[g.Direction] {
		return nil, unusable("the graph has direction %q, not one of TB, LR, BT, RL", g.Direction)
	}
	if len(g.Nodes) == 0 {
		return nil, unusable("the graph has no nodes")
	}
	ids := map[string]bool{}
	claim := func(id string) error {
		if ids[id] {
			return unusable("the id %q is used twice in the graph", id)
		}
		ids[id] = true
		return nil
	}
	groups := map[string]bool{}
	for i, grp := range g.Groups {
		if strings.TrimSpace(grp.Id) == "" {
			return nil, unusable("graph group %d has no id", i+1)
		}
		if strings.TrimSpace(grp.Label) == "" {
			return nil, unusable("graph group %q has no label", grp.Id)
		}
		if err := claim(grp.Id); err != nil {
			return nil, err
		}
		groups[grp.Id] = true
		if n := tooWordy(grp.Label); n > 0 {
			return nil, unusable("graph group %q's label has %d words, more than %d", grp.Id, n, MaxLabelWords)
		}
	}
	nodes := map[string]bool{}
	for i, n := range g.Nodes {
		if strings.TrimSpace(n.Id) == "" {
			return nil, unusable("graph node %d has no id", i+1)
		}
		if strings.TrimSpace(n.Label) == "" {
			return nil, unusable("graph node %d (%q) has no label", i+1, n.Id)
		}
		if err := claim(n.Id); err != nil {
			return nil, err
		}
		nodes[n.Id] = true
		if n.Shape != "" && !graphShapes[n.Shape] {
			return nil, unusable("graph node %q has shape %q, not one of rectangle, ellipse, diamond", n.Id, n.Shape)
		}
		if n.Group != "" && !groups[n.Group] {
			return nil, unusable("graph node %q is in group %q, which is not in groups", n.Id, n.Group)
		}
		if w := tooWordy(n.Label); w > 0 {
			return nil, unusable("graph node %q's label has %d words, more than %d", n.Id, w, MaxLabelWords)
		}
	}
	for i, e := range g.Edges {
		for _, end := range []string{e.From, e.To} {
			if !nodes[end] {
				return nil, unusable("graph edge %d names %q, which is not a node", i+1, end)
			}
		}
		if e.From == e.To {
			return nil, unusable("graph edge %d joins node %q to itself", i+1, e.From)
		}
		if n := tooWordy(e.Label); n > 0 {
			return nil, unusable("graph edge %d's label has %d words, more than %d", i+1, n, MaxLabelWords)
		}
	}
	return ids, nil
}

func checkAdd(add []json.RawMessage, graphIds map[string]bool) error {
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
		if ids[*e.Id] || graphIds[*e.Id] {
			return unusable("the id %q is used twice in add and graph", *e.Id)
		}
		ids[*e.Id] = true
		text := e.Text
		if e.Label != nil {
			text = e.Label.Text
		}
		if n := tooWordy(text); n > 0 {
			return unusable("add entry %d's text has %d words, more than %d", i+1, n, MaxLabelWords)
		}
	}
	for _, e := range entries {
		if e.Type != typeArrow {
			continue
		}
		for _, end := range []*bindingId{e.Start, e.End} {
			if end != nil && end.Id != nil && !ids[*end.Id] && !graphIds[*end.Id] {
				return unusable("the arrow %q binds to %q, which is not a shape in add or a graph node", *e.Id, *end.Id)
			}
		}
	}
	return nil
}

// checkUpdate returns the ids the update names.
func checkUpdate(update []json.RawMessage, scene Scene) ([]string, error) {
	ids := make([]string, 0, len(update))
	seen := make(map[string]bool, len(update))
	for i, r := range update {
		var patch map[string]json.RawMessage
		if json.Unmarshal(r, &patch) != nil || patch == nil {
			return nil, unusable("update entry %d is not an object", i+1)
		}
		for k, v := range patch {
			kind, ok := updateKeys[k]
			if !ok {
				return nil, unusable("update entry %d has the key %q, which an update cannot change", i+1, k)
			}
			if !hasKind(v, kind) {
				return nil, unusable("update entry %d's %q is not a %s", i+1, k, kind)
			}
		}
		var id string
		if json.Unmarshal(patch["id"], &id) != nil || id == "" {
			return nil, unusable("update entry %d has no id", i+1)
		}
		typ, ok := scene.Types[id]
		if !ok {
			return nil, unusable("update names %q, which is not on the board", id)
		}
		if seen[id] {
			return nil, unusable("update names %q twice", id)
		}
		seen[id] = true
		if _, ok := patch["text"]; ok && typ != typeText {
			return nil, unusable("update sets text on %q, a %s, not a text element", id, typ)
		}
		if _, ok := patch["label"]; ok && !labelTypes[typ] {
			return nil, unusable("update sets a label on %q, a %s, which has no label", id, typ)
		}
		for _, k := range []string{"text", "label"} {
			var words string
			if json.Unmarshal(patch[k], &words) != nil {
				continue
			}
			if n := tooWordy(words); n > 0 {
				return nil, unusable("update entry %d's %s has %d words, more than %d", i+1, k, n, MaxLabelWords)
			}
		}
		ids = append(ids, id)
	}
	return ids, nil
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

func compactObject(obj json.RawMessage) (string, error) {
	var buf bytes.Buffer
	if err := json.Compact(&buf, obj); err != nil {
		return "", unusable("%s", err)
	}
	return buf.String(), nil
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
