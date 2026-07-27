// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package waveobj

// JarvisConvo is a persisted Jarvis recall conversation (sub-project F). Named JarvisConvo (not
// JarvisConversation) to avoid colliding with the FE view-model interface of that name in jarviscontract.ts;
// the otype string is "jarvisconversation". Working-steps are transient (streamed over RPC) and never
// persisted. The answer turn stores raw model prose; the FE derives display segments via parseCitations.
type JarvisConvo struct {
	OID           string            `json:"oid"`
	Version       int               `json:"version"`
	Title         string            `json:"title"`
	ScopeMode     string            `json:"scopemode"` // object | project | all | attached
	ProjectPath   string            `json:"projectpath,omitempty"`
	AttachedORefs []string          `json:"attachedorefs,omitempty"`
	Turns         []JarvisConvoTurn `json:"turns"`
	CreatedTs     int64             `json:"createdts"`
	UpdatedTs     int64             `json:"updatedts"`
	Meta          MetaMapType       `json:"meta"`
}

func (*JarvisConvo) GetOType() string {
	return OType_JarvisConversation
}

// JarvisConvoTurn is one persisted turn, discriminated by Role. User: Text + Attachments. Jarvis: Prose
// (raw model output with inline [n]) + Grounding + Terminal.
type JarvisConvoTurn struct {
	Role        string                     `json:"role"` // user | jarvis
	Text        string                     `json:"text,omitempty"`
	Attachments []JarvisConvoSourceRef     `json:"attachments,omitempty"`
	Prose       string                     `json:"prose,omitempty"`
	Grounding   []JarvisConvoGroundingCard `json:"grounding,omitempty"`
	Terminal    string                     `json:"terminal,omitempty"` // answered | weak | notfound
}

type JarvisConvoSourceRef struct {
	ORef       string `json:"oref"`
	SourceType string `json:"sourcetype"`
	Title      string `json:"title"`
}

// JarvisConvoGroundingCard is one retrieved source, built deterministically in Go. This is the single
// definition of the grounding card (the wshrpc streaming chunk references it — see Task 3), so there is
// no duplicate card type across the wire and persistence layers.
type JarvisConvoGroundingCard struct {
	N          int    `json:"n"`
	SourceType string `json:"sourcetype"`
	Title      string `json:"title"`
	Project    string `json:"project"`
	AgeMs      int64  `json:"agems"`
	Freshness  string `json:"freshness"`
	NavTarget  string `json:"navtarget"`
}
