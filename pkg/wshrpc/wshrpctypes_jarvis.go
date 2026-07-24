// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type JarvisCommands interface {
	ConsultCommand(ctx context.Context, data CommandConsultData) chan RespOrErrorUnion[ConsultChunk]                        // one-shot headless CLI consult; streams reply chunks, posts a consult-reply on completion
	JarvisCommand(ctx context.Context, data CommandJarvisData) chan RespOrErrorUnion[JarvisChunk]                           // Jarvis (observe-only manager): headless claude summary of a channel's fleet; streams chunks, posts a jarvis-reply on completion
	JarvisConverseCommand(ctx context.Context, data CommandJarvisConverseData) chan RespOrErrorUnion[JarvisConverseChunk]   // recall shim: streams working-steps + grounding + prose + terminal
	ListJarvisConversationsCommand(ctx context.Context) (*CommandListJarvisConversationsRtnData, error)                     // list persisted recall conversations, newest-first
	ListDossiersCommand(ctx context.Context) (*CommandListDossiersRtnData, error)                                          // list focusable task dossiers (active|paused), newest-updated first
	ResolveSpaceScopeCommand(ctx context.Context, data CommandResolveSpaceScopeData) (*SpaceScope, error)                  // resolve a task's attributed scope bundle (runs -> channels + worker tabs) for Presence C
	GetDossierCommand(ctx context.Context, data CommandGetDossierData) (*DossierDetail, error)                              // read one task dossier + its decisions for the Tasks surface
	ListTaskDossiersCommand(ctx context.Context) (*CommandListTaskDossiersRtnData, error)                                  // list ALL task dossiers (any status) for the Tasks surface, newest-updated first
	AppendDossierDecisionCommand(ctx context.Context, data CommandAppendDossierDecisionData) (*CommandAppendDossierDecisionRtnData, error) // human-append a decision to a dossier (user-attributed) + commit
	SetDossierStatusCommand(ctx context.Context, data CommandSetDossierStatusData) error                                                   // set a dossier's status (active|paused|completed|archived) + commit
	JarvisDecomposeCommand(ctx context.Context, data CommandJarvisDecomposeData) (*CommandJarvisDecomposeRtnData, error)    // decompose a goal into independent parallel subtasks (Delegator fan-out); fails safe to [goal]
	GetJarvisProfileCommand(ctx context.Context, data CommandGetJarvisProfileData) (*CommandGetJarvisProfileRtnData, error) // read a channel's Jarvis profile (global + per-project override + resolved)
	GetGlobalProfileCommand(ctx context.Context) (*waveobj.JarvisProfile, error)                                            // read the global Jarvis profile (builtins if unset)
	SetGlobalProfileCommand(ctx context.Context, data CommandSetGlobalProfileData) error                                    // write the global Jarvis profile to jarvis-profile.json
	ListConsultRuntimesCommand(ctx context.Context) (*CommandListConsultRuntimesRtnData, error)
}

type CommandJarvisDecomposeData struct {
	ChannelId string `json:"channelid"`
	Goal      string `json:"goal"`
}

type CommandJarvisDecomposeRtnData struct {
	Subtasks []string `json:"subtasks"`
}

type CommandGetJarvisProfileData struct {
	ChannelId string `json:"channelid"`
}

type CommandGetJarvisProfileRtnData struct {
	Global               waveobj.JarvisProfile         `json:"global"`
	Override             *waveobj.ProfileOverride      `json:"override"`
	Resolved             waveobj.JarvisProfile         `json:"resolved"`
	PrincipleDiagnostics []waveobj.PrincipleDiagnostic `json:"principlediagnostics,omitempty"`
}

type CommandSetGlobalProfileData struct {
	Profile waveobj.JarvisProfile `json:"profile"`
}

type CommandConsultData struct {
	ChannelId string `json:"channelid"`
	Runtime   string `json:"runtime"`
	Prompt    string `json:"prompt"`
	ConsultId string `json:"consultid"`
}

type ConsultChunk struct {
	Text string `json:"text"`
}

type CommandJarvisData struct {
	ChannelId string `json:"channelid"`
	Prompt    string `json:"prompt"`
	RequestId string `json:"requestid"`
}

type JarvisChunk struct {
	Text string `json:"text"`
}

// CommandJarvisConverseData is one recall conversation turn: a question plus the resolved scope. The shim
// (pkg/jarvisrecall) filters retrieval by ScopeMode; the model is never asked to ignore out-of-scope objects.
type CommandJarvisConverseData struct {
	ConversationId string   `json:"conversationid"`
	Prompt         string   `json:"prompt"`
	ScopeMode      string   `json:"scopemode"` // object | project | all | attached
	ProjectPath    string   `json:"projectpath,omitempty"`
	AttachedORefs  []string `json:"attachedorefs,omitempty"`
	RequestId      string   `json:"requestid"`
}

// JarvisWorkingStep is one deterministic retrieval/synthesis step, streamed as it runs.
type JarvisWorkingStep struct {
	Id     string `json:"id"`
	Label  string `json:"label"`
	Status string `json:"status"` // done | active | pending
}

// JarvisConverseChunk is one streamed update. Exactly one payload is meaningful per chunk, keyed by Kind:
//   - "step":      Step is set (a working-step lifecycle update)
//   - "grounding": Grounding is set (one deterministic source card)
//   - "text":      Text is set (an incremental fragment of the model's prose answer)
//   - "terminal":  Terminal is set (answered | weak | notfound; the last chunk of the turn)
type JarvisConverseChunk struct {
	Kind      string                            `json:"kind"`
	Step      *JarvisWorkingStep                `json:"step,omitempty"`
	Grounding *waveobj.JarvisConvoGroundingCard `json:"grounding,omitempty"`
	Text      string                            `json:"text,omitempty"`
	Terminal  string                            `json:"terminal,omitempty"`
}

type JarvisConversationSummary struct {
	Id        string `json:"id"`
	Title     string `json:"title"`
	ScopeMode string `json:"scopemode"`
	UpdatedTs int64  `json:"updatedts"`
}

type CommandListJarvisConversationsRtnData struct {
	Conversations []JarvisConversationSummary `json:"conversations"`
}
type CommandListConsultRuntimesRtnData struct {
	Runtimes []ConsultRuntimeInfo `json:"runtimes"`
}

// SpaceSummary is one focusable task (Presence C). Objective is the human label; Ticket a secondary tag.
type SpaceSummary struct {
	Id        string `json:"id"`
	Objective string `json:"objective"`
	Ticket    string `json:"ticket"`
	Status    string `json:"status"` // active | paused (the only focusable statuses)
	Updated   int64  `json:"updated"`
}

type CommandListDossiersRtnData struct {
	Spaces []SpaceSummary `json:"spaces"`
}

type CommandResolveSpaceScopeData struct {
	DossierId string `json:"dossierid"`
}

// SpaceScope is a task's derived scope bundle: its attributed run orefs, their channel oids, and the
// worker tab ids (tab: prefix stripped, so they match the roster's tabId key). Rebuildable, never stored.
type SpaceScope struct {
	RunORefs    []string `json:"runorefs"`
	ChannelOids []string `json:"channeloids"`
	TabIds      []string `json:"tabids"`
}

// DecisionCard is one decision record projected for the Tasks surface. Rationale is human prose;
// every other field is machine-owned. Read-only in the UI (decisions are append-only).
type DecisionCard struct {
	Id         string   `json:"id"`
	Created    int64    `json:"created"`
	Actor      string   `json:"actor"`
	Provenance string   `json:"provenance"`
	Status     string   `json:"status"`
	Links      []string `json:"links"`
	Rationale  string   `json:"rationale"`
}

// DossierDetail is a task dossier projected for the Tasks surface. Every field renders read-only
// except via the write commands (append a decision, set status). Notes is the human ## Notes prose,
// read-only this cycle.
type DossierDetail struct {
	Id         string         `json:"id"`
	Ticket     string         `json:"ticket"`
	Objective  string         `json:"objective"`
	Acceptance []string       `json:"acceptance"`
	Confidence string         `json:"confidence"`
	Status     string         `json:"status"`
	Created    int64          `json:"created"`
	Updated    int64          `json:"updated"`
	State      string         `json:"state"`
	Blockers   []string       `json:"blockers"`
	Refs       []string       `json:"refs"`
	Notes      string         `json:"notes"`
	Decisions  []DecisionCard `json:"decisions"`
}

type CommandGetDossierData struct {
	DossierId string `json:"dossierid"`
}

type CommandListTaskDossiersRtnData struct {
	Dossiers []SpaceSummary `json:"dossiers"`
}

type CommandAppendDossierDecisionData struct {
	DossierId string   `json:"dossierid"`
	Summary   string   `json:"summary"`
	Rationale string   `json:"rationale"`
	Links     []string `json:"links,omitempty"`
}

type CommandAppendDossierDecisionRtnData struct {
	DecisionId string `json:"decisionid"`
}

type CommandSetDossierStatusData struct {
	DossierId string `json:"dossierid"`
	Status    string `json:"status"`
}
