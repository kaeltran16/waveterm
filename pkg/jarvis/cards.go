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

// JarvisCardQuestion is one question of the ask a Gatekeeper card is about.
type JarvisCardQuestion struct {
	Question    string             `json:"question"`
	MultiSelect bool               `json:"multiSelect,omitempty"`
	Options     []JarvisCardOption `json:"options"`
}

// JarvisCardData is the structured payload the FE uses to render the rich Gatekeeper answered /
// escalation cards. Serialized into ChannelMessage.Data. AskORef is the block-level ask oref (used to
// deliver an answer); WorkerORef is the worker's tab oref (used to resolve the roster row + steer).
// Question / Options / Choice describe question 0 only, as every card did before asks could carry
// several questions; Questions and Answers hold the whole ask.
type JarvisCardData struct {
	AskORef string `json:"askORef"`
	// AskId names the one ask this card is about: every ask an agent raises shares its block's AskORef.
	AskId      string                   `json:"askId,omitempty"`
	WorkerORef string                   `json:"workerORef"`
	Question   string                   `json:"question"`
	Options    []JarvisCardOption       `json:"options"`
	Questions  []JarvisCardQuestion     `json:"questions,omitempty"`
	Answers    []baseds.AgentAnswerItem `json:"answers,omitempty"`   // Jarvis's answer, one per question: present ⇒ auto-answered
	Choice     *int                     `json:"choice,omitempty"`    // Jarvis's pick on question 0 when that answer is a single pick
	HumanPick  *int                     `json:"humanPick,omitempty"` // the option a human selected on this card (escalation answer / answered-override); persisted so it survives a surface remount
	Reason     string                   `json:"reason,omitempty"`
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

// BuildCardData assembles the card payload for an ask; answers is nil for an escalation.
func BuildCardData(questions []baseds.AgentAskQuestion, answers []baseds.AgentAnswerItem, reason, askORef, askId, workerORef string) JarvisCardData {
	card := JarvisCardData{
		AskORef:    askORef,
		AskId:      askId,
		WorkerORef: workerORef,
		Answers:    answers,
		Reason:     reason,
	}
	for _, q := range questions {
		opts := make([]JarvisCardOption, 0, len(q.Options))
		for _, o := range q.Options {
			opts = append(opts, JarvisCardOption{Label: o.Label, Sub: o.Description})
		}
		card.Questions = append(card.Questions, JarvisCardQuestion{Question: q.Question, MultiSelect: q.MultiSelect, Options: opts})
	}
	if len(card.Questions) > 0 {
		card.Question = card.Questions[0].Question
		card.Options = card.Questions[0].Options
	}
	if len(answers) > 0 && len(answers[0].SelectedIndexes) == 1 {
		choice := answers[0].SelectedIndexes[0]
		card.Choice = &choice
	}
	return card
}
