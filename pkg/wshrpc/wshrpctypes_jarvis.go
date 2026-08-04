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
	DeleteJarvisConversationCommand(ctx context.Context, data CommandDeleteJarvisConversationData) error                    // delete one recall conversation
	ArchiveJarvisConversationCommand(ctx context.Context, data CommandArchiveJarvisConversationData) error                  // hide a conversation from the active Threads list; reversible
	ListDossiersCommand(ctx context.Context) (*CommandListDossiersRtnData, error)                                          // list focusable task dossiers (active|paused), newest-updated first
	ResolveSpaceScopeCommand(ctx context.Context, data CommandResolveSpaceScopeData) (*SpaceScope, error)                  // resolve a task's attributed scope bundle (runs -> channels + worker tabs) for Presence C
	VaultGraphCommand(ctx context.Context) (*CommandVaultGraphRtnData, error)                                             // whole-vault wikilink graph (U3 base canvas): all vault nodes + resolved [[links]], no runs/attribution
	ResolveDossierEdgesCommand(ctx context.Context, data CommandResolveDossierEdgesData) (*CommandResolveDossierEdgesRtnData, error) // a dossier's attributed run nodes + typed attribution edges (U3 focus bloom)
	ResolveAmbientCommand(ctx context.Context) (*CommandResolveAmbientRtnData, error)                                              // whole-vault ambient attribution: every dossier, its attributed run orefs, and its decisions
	GetDossierCommand(ctx context.Context, data CommandGetDossierData) (*DossierDetail, error)                              // read one task dossier + its decisions for the Tasks surface
	ListTaskDossiersCommand(ctx context.Context) (*CommandListTaskDossiersRtnData, error)                                  // list ALL task dossiers (any status) for the Tasks surface, newest-updated first
	AppendDossierDecisionCommand(ctx context.Context, data CommandAppendDossierDecisionData) (*CommandAppendDossierDecisionRtnData, error) // human-append a decision to a dossier (user-attributed) + commit
	SetDossierStatusCommand(ctx context.Context, data CommandSetDossierStatusData) error                                                   // set a dossier's status (active|paused|completed|archived) + commit
	DetachDossierEdgeCommand(ctx context.Context, data CommandDossierEdgeData) error                                                       // human-reject a dossier<->run attribution; suppressed durably via the override log
	AcceptDossierEdgeCommand(ctx context.Context, data CommandDossierEdgeData) error                                                       // human-confirm a dossier<->run attribution and harden it into canonical refs; also restores a detached edge and attaches an unattributed run
	ListDetachedEdgesCommand(ctx context.Context, data CommandListDetachedEdgesData) (*CommandListDetachedEdgesRtnData, error)             // the human-suppressed edges for one dossier or one run, so a detach can be undone
	JarvisDecomposeCommand(ctx context.Context, data CommandJarvisDecomposeData) (*CommandJarvisDecomposeRtnData, error)    // decompose a goal into independent parallel subtasks (Delegator fan-out); fails safe to [goal]
	GetJarvisProfileCommand(ctx context.Context, data CommandGetJarvisProfileData) (*CommandGetJarvisProfileRtnData, error) // read a channel's Jarvis profile (global + per-project override + resolved)
	GetGlobalProfileCommand(ctx context.Context) (*waveobj.JarvisProfile, error)                                            // read the global Jarvis profile (builtins if unset)
	SetGlobalProfileCommand(ctx context.Context, data CommandSetGlobalProfileData) error                                    // write the global Jarvis profile to jarvis-profile.json
	ListConsultRuntimesCommand(ctx context.Context) (*CommandListConsultRuntimesRtnData, error)
	GetEmbedIndexStatusCommand(ctx context.Context) (*EmbedIndexStatus, error)                                                              // is semantic recall actually working right now: ok | off | stale, and why
	ListProactiveRefusalsCommand(ctx context.Context, data CommandListProactiveRefusalsData) (*CommandListProactiveRefusalsRtnData, error)  // recent persisted "I found nothing" verdicts from proactive recall, with their causes
	GetLatestResumeCommand(ctx context.Context) (*CommandGetLatestResumeRtnData, error)                                                     // the newest rest-transition narrative across all runs — "where we were" at launch
}

// EmbedIndexStatus mirrors jarvisembed.IndexStatus. State is ok | off | stale: off means recall cannot
// happen (disabled, unkeyed, unreachable provider, unreadable vault), stale means the index exists but no
// longer matches what a query needs (indexed under a different model, never built, or content drifted).
// The counts make "stale" legible as a magnitude — one edited note and a never-built index are not the
// same problem. Mirrored rather than re-exported so pkg/wshrpc stays free of the CGO sqlite-vec build.
type EmbedIndexStatus struct {
	State        string `json:"state"`
	Reason       string `json:"reason,omitempty"`
	Detail       string `json:"detail,omitempty"`
	Enabled      bool   `json:"enabled"`
	HasKey       bool   `json:"haskey"`
	Model        string `json:"model,omitempty"`
	IndexedModel string `json:"indexedmodel,omitempty"`
	Dims         int    `json:"dims,omitempty"`
	IndexedNodes int    `json:"indexednodes"`
	VaultNodes   int    `json:"vaultnodes"`
	StaleNodes   int    `json:"stalenodes"`
}

// ProactiveRefusal is one persisted decision by proactive recall not to speak. The evaluator writes a
// verdict into run.Meta on every dispatch precisely so a silence is auditable rather than
// indistinguishable from never having run; this read is what finally makes that record reachable.
type ProactiveRefusal struct {
	RunORef    string `json:"runoref"`
	ChannelOid string `json:"channeloid,omitempty"`
	Goal       string `json:"goal,omitempty"`
	Reason     string `json:"reason"` // no-candidates | judge-declined | judge-error | embeddings-off | index-error | vault-error | query-error
	Ts         int64  `json:"ts"`     // the run's createdts — when the dispatch that refused was evaluated
}

type CommandListProactiveRefusalsData struct {
	Limit int `json:"limit,omitempty"` // 0 = server default; capped server-side
}

// CommandListProactiveRefusalsRtnData carries the newest refusals plus the count of every refusal on
// record — all of history, not a recent window. Total exists so truncation does not hide the scale; each
// row carries its own Ts, so a caller that wants "lately" windows the rows itself.
type CommandListProactiveRefusalsRtnData struct {
	Refusals []ProactiveRefusal `json:"refusals"`
	Total    int                `json:"total"`
}

// ResumeCardData mirrors jarviscontinuity.ResumeCard field for field, json tags included, so the generated
// TS type is structurally identical to the frontend's existing ResumeVM (view/agents/resume.ts) and
// consuming this command is an adapter rather than a translation.
type ResumeCardData struct {
	TaskId  string `json:"taskId"`
	Summary string `json:"summary"`
	Status  string `json:"status"`
	Updated int64  `json:"updated"`
}

// CommandGetLatestResumeRtnData is the newest rest-transition narrative across every run. No per-run read
// can answer it: the narrative is written into run.Meta, and there is no global runs list on the frontend,
// so "where we were" was unreachable at launch. Card is nil when no run carries an undismissed narrative.
type CommandGetLatestResumeRtnData struct {
	Card       *ResumeCardData `json:"card,omitempty"`
	RunORef    string          `json:"runoref,omitempty"`
	ChannelOid string          `json:"channeloid,omitempty"`
	RunStatus  string          `json:"runstatus,omitempty"` // the run's rest status: awaiting-review | blocked | done
	RunGoal    string          `json:"rungoal,omitempty"`
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
	// the frontend only ever sees summaries, so a field the summary omits is unreachable: without
	// AttachedORefs the per-source dedup cannot survive a restart, and without Archived the flag is
	// write-only.
	AttachedORefs []string `json:"attachedorefs,omitempty"`
	Archived      bool     `json:"archived,omitempty"`
}

type CommandListJarvisConversationsRtnData struct {
	Conversations []JarvisConversationSummary `json:"conversations"`
}

type CommandDeleteJarvisConversationData struct {
	ConversationId string `json:"conversationid"`
}

type CommandArchiveJarvisConversationData struct {
	ConversationId string `json:"conversationid"`
	Archived       bool   `json:"archived"`
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

// GraphNode is one node in the vault graph surface (U3). Kind: task|decision|memory|run.
// Status is frontmatter-derived (absent for memory notes; runs carry their run status).
type GraphNode struct {
	Id      string `json:"id"`
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	Status  string `json:"status,omitempty"`
	Updated int64  `json:"updated,omitempty"`
}

// GraphLink is one edge. Kind: wikilink|attribution. Provenance/Bucket/State are set only on
// attribution edges (dossier->run, from D's EdgesFor); wikilinks leave them empty.
type GraphLink struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Kind       string `json:"kind"`
	Provenance string `json:"provenance,omitempty"`
	Bucket     string `json:"bucket,omitempty"`
	State      string `json:"state,omitempty"`
}

type CommandVaultGraphRtnData struct {
	Nodes []GraphNode `json:"nodes"`
	Links []GraphLink `json:"links"`
}

type CommandResolveDossierEdgesData struct {
	DossierId string `json:"dossierid"`
}

type CommandResolveDossierEdgesRtnData struct {
	Runs  []GraphNode `json:"runs"`
	Links []GraphLink `json:"links"`
}

// AmbientTask is a dossier reduced to what an ambient tag renders: its id and display label. The whole
// set ships (not just attributed ones) so a memory note's [[wikilink]] can resolve to a tag too.
type AmbientTask struct {
	Id    string `json:"id"`
	Label string `json:"label"`
}

// AmbientEdge is one attributed object -> dossier link. ORef is the object the tag renders on (a run
// oref today). Provenance/Bucket/State mirror the U3 attribution encoding so the ambient layer can give
// a provisional edge a distinct treatment — a low-confidence edge must never read as canonical.
type AmbientEdge struct {
	ORef       string `json:"oref"`
	DossierId  string `json:"dossierid"`
	Provenance string `json:"provenance"`
	Bucket     string `json:"bucket"` // weak | medium | strong
	State      string `json:"state"`  // informing | confirmed
}

// CommandDossierEdgeData names one dossier<->run attribution. Both ids are required: an edge is the pair.
type CommandDossierEdgeData struct {
	DossierId string `json:"dossierid"`
	RunORef   string `json:"runoref"`
}

// CommandListDetachedEdgesData asks the inverse question from each end — a record's suppressed runs, or a
// run's suppressed records. Exactly one id is set; setting neither is an error, since an unfiltered read
// would return every correction ever made.
type CommandListDetachedEdgesData struct {
	DossierId string `json:"dossierid,omitempty"`
	RunORef   string `json:"runoref,omitempty"`
}

// CommandListDetachedEdgesRtnData mirrors ResolveAmbient's first two fields so the frontend joins labels
// to edges with the machinery it already has. An edge whose underlying signal is gone (Detach strips a
// hardened ref) carries an empty Provenance and Bucket — absent, never a fabricated "weak".
type CommandListDetachedEdgesRtnData struct {
	Tasks []AmbientTask `json:"tasks"`
	Edges []AmbientEdge `json:"edges"`
}

// AmbientDecision is one decision record reachable from a dossier, projected for the ambient
// "relevant past decisions" card. Title is lifted off the rationale — decisions carry no title field.
type AmbientDecision struct {
	DossierId string `json:"dossierid"`
	Id        string `json:"id"`
	Title     string `json:"title"`
	Created   int64  `json:"created"`
}

// CommandResolveAmbientRtnData is the whole ambient map in one read: the frontend joins Edges to Tasks
// by dossier id and renders Decisions on an object's detail. Loaded once per surface, not per row.
type CommandResolveAmbientRtnData struct {
	Tasks     []AmbientTask     `json:"tasks"`
	Edges     []AmbientEdge     `json:"edges"`
	Decisions []AmbientDecision `json:"decisions"`
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
