// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// JarvisCardOption is one selectable option in a Gatekeeper card.
type JarvisCardOption struct {
	Label string `json:"label"`
	Sub   string `json:"sub,omitempty"`
}

// JarvisCardData is the structured payload the FE uses to render the rich Gatekeeper answered /
// escalation cards. Serialized into ChannelMessage.Data. AskORef is the block-level ask oref (used to
// deliver an answer); WorkerORef is the worker's tab oref (used to resolve the roster row + steer).
type JarvisCardData struct {
	AskORef    string             `json:"askORef"`
	WorkerORef string             `json:"workerORef"`
	Question   string             `json:"question"`
	Options    []JarvisCardOption `json:"options"`
	Choice     *int               `json:"choice,omitempty"`    // Jarvis's own pick: present ⇒ auto-answered; absent ⇒ escalation
	HumanPick  *int               `json:"humanPick,omitempty"` // the option a human selected on this card (escalation answer / answered-override); persisted so it survives a surface remount
	Reason     string             `json:"reason,omitempty"`
}

// SetCardHumanPick patches HumanPick onto a JarvisCardData JSON blob, recording the option index a human
// selected on the card so it survives a surface remount (otherwise the FE only holds it in local state,
// which resets on tab switch). Returns an error if data isn't a parseable card.
func SetCardHumanPick(data string, pick int) (string, error) {
	var card JarvisCardData
	if err := json.Unmarshal([]byte(data), &card); err != nil {
		return "", err
	}
	card.HumanPick = &pick
	out, err := json.Marshal(card)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// BuildCardData assembles the card payload from a single-select ask question.
func BuildCardData(q baseds.AgentAskQuestion, choice *int, reason, askORef, workerORef string) JarvisCardData {
	opts := make([]JarvisCardOption, 0, len(q.Options))
	for _, o := range q.Options {
		opts = append(opts, JarvisCardOption{Label: o.Label, Sub: o.Description})
	}
	return JarvisCardData{
		AskORef:    askORef,
		WorkerORef: workerORef,
		Question:   q.Question,
		Options:    opts,
		Choice:     choice,
		Reason:     reason,
	}
}
