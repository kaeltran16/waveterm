// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardscribe

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	// MaxShapes is the most skeleton entries one draw may return.
	MaxShapes = 200

	// NoDrawingReason is why a pass fails when the scribe ended with no reply.
	NoDrawingReason = "the scribe session ended without returning a drawing"

	unusableHead = "the scribe's drawing is not usable: "
	wholeAsk     = "the whole thing"
	jsonFence    = "```json"
	plainFence   = "```"
	typeArrow    = "arrow"
)

//go:embed scribe-prompt.md
var promptTemplate string

// skeletonTypes is the vocabulary the prompt names; anything else would not convert.
var skeletonTypes = map[string]bool{
	"rectangle": true, "ellipse": true, "diamond": true, "text": true, "line": true, typeArrow: true,
}

// SourceKey names a (thing, ask) pair: the same thing with another ask is another group on the board.
func SourceKey(src wshrpc.BoardSource, ask string) string {
	key := src.Kind + ":" + src.Ref
	if a := normalizeAsk(ask); a != "" {
		key += "|" + a
	}
	return key
}

func normalizeAsk(ask string) string {
	return strings.Join(strings.Fields(strings.ToLower(ask)), " ")
}

type PromptInput struct {
	BoardName, Ask, SourceTitle, ThingText, Reading string
	Previous                                        string // the group's current skeleton, "" on a first draw
}

// Prompt fills the scribe prompt. One replacer pass, so a placeholder inside the thing's text stays literal.
func Prompt(in PromptInput) string {
	ask := strings.TrimSpace(in.Ask)
	if ask == "" {
		ask = wholeAsk
	}
	previous := ""
	if strings.TrimSpace(in.Previous) != "" {
		previous = "\n## What you drew before\n\nThis board already holds your earlier drawing of this source. Return the whole " +
			"replacement group, keeping what still holds and changing what the material changed:\n\n" + in.Previous + "\n"
	}
	return strings.NewReplacer(
		"[BOARD]", in.BoardName,
		"[SOURCE]", in.SourceTitle,
		"[ASK]", ask,
		"[READING]", in.Reading,
		"[THING]", in.ThingText,
		"[PREVIOUS]", previous,
	).Replace(promptTemplate)
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

// CheckReply checks the scribe's reply and returns its skeleton array, compacted, and its length. Code, not the
// scribe, decides whether a drawing is usable: one that would not convert fails the pass with the reason.
func CheckReply(reply string) (string, int, error) {
	body := strings.TrimSpace(reply)
	if body == "" {
		return "", 0, errors.New(NoDrawingReason)
	}
	body = unfence(body)
	raw, err := oneObject(body)
	if err != nil {
		return "", 0, unusable("%s", err)
	}
	skeletonRaw, ok := raw["skeleton"]
	if !ok {
		return "", 0, unusable("the reply has no skeleton array")
	}
	var entries []skeletonEntry
	if json.Unmarshal(skeletonRaw, &entries) != nil {
		return "", 0, unusable("skeleton is not an array of shapes")
	}
	if err := checkEntries(entries); err != nil {
		return "", 0, err
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, skeletonRaw); err != nil {
		return "", 0, unusable("%s", err)
	}
	return compact.String(), len(entries), nil
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

func oneObject(body string) (map[string]json.RawMessage, error) {
	dec := json.NewDecoder(strings.NewReader(body))
	var obj map[string]json.RawMessage
	if err := dec.Decode(&obj); err != nil || obj == nil {
		return nil, errors.New("the reply is not one JSON object")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("the reply is not one JSON object")
	}
	return obj, nil
}

func checkEntries(entries []skeletonEntry) error {
	if len(entries) == 0 {
		return unusable("the skeleton is empty")
	}
	if len(entries) > MaxShapes {
		return unusable("the skeleton has %d shapes, more than %d", len(entries), MaxShapes)
	}
	ids := make(map[string]bool, len(entries))
	for i, e := range entries {
		if !skeletonTypes[e.Type] {
			return unusable("shape %d has type %q, not one of rectangle, ellipse, diamond, text, line, arrow", i+1, e.Type)
		}
		if e.Id == nil || strings.TrimSpace(*e.Id) == "" {
			return unusable("shape %d has no id", i+1)
		}
		if ids[*e.Id] {
			return unusable("the id %q is used twice", *e.Id)
		}
		ids[*e.Id] = true
	}
	for _, e := range entries {
		if e.Type != typeArrow {
			continue
		}
		for _, end := range []*bindingId{e.Start, e.End} {
			if end != nil && end.Id != nil && !ids[*end.Id] {
				return unusable("the arrow %q binds to %q, which names no shape", *e.Id, *end.Id)
			}
		}
	}
	return nil
}

func unusable(format string, args ...any) error {
	return fmt.Errorf(unusableHead+format, args...)
}
