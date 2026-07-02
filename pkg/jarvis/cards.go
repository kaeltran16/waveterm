// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import "github.com/wavetermdev/waveterm/pkg/baseds"

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
	Choice     *int               `json:"choice,omitempty"` // present ⇒ answered; absent ⇒ escalation
	Reason     string             `json:"reason,omitempty"`
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
