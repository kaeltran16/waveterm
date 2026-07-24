// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/jarvisattrib"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/jarvisrecall"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func (ws *WshServer) GetJarvisProfileCommand(ctx context.Context, data wshrpc.CommandGetJarvisProfileData) (*wshrpc.CommandGetJarvisProfileRtnData, error) {
	if data.ChannelId == "" {
		return nil, fmt.Errorf("channelid is required")
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
	if err != nil {
		return nil, fmt.Errorf("loading channel: %w", err)
	}
	global := jarvis.LoadGlobalProfile()
	override := jarvis.OverrideFromMeta(ch)
	resolved, diagnostics := jarvis.ResolveProfileWithDiagnostics(global, override)
	// surface the override as a structured patch view (a legacy string becomes disable-all + one
	// legacy-project addition) so the FE never has to reason about the legacy marker.
	if override != nil && override.Principles != nil {
		normalized := *override
		normalized.Principles = jarvis.NormalizePrinciplePatch(global.Principles, override.Principles)
		override = &normalized
	}
	return &wshrpc.CommandGetJarvisProfileRtnData{
		Global:               global,
		Override:             override,
		Resolved:             resolved,
		PrincipleDiagnostics: diagnostics,
	}, nil
}

func (ws *WshServer) GetGlobalProfileCommand(ctx context.Context) (*waveobj.JarvisProfile, error) {
	profile := jarvis.LoadGlobalProfile()
	return &profile, nil
}

func (ws *WshServer) SetGlobalProfileCommand(ctx context.Context, data wshrpc.CommandSetGlobalProfileData) error {
	return jarvis.SaveGlobalProfile(data.Profile)
}

func (ws *WshServer) JarvisDecomposeCommand(ctx context.Context, data wshrpc.CommandJarvisDecomposeData) (*wshrpc.CommandJarvisDecomposeRtnData, error) {
	if strings.TrimSpace(data.Goal) == "" {
		return nil, fmt.Errorf("goal is required")
	}
	var channel *waveobj.Channel
	projectPath := ""
	if data.ChannelId != "" {
		if ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId); err == nil {
			channel = ch
			projectPath = ch.ProjectPath
		}
	}
	subtasks := jarvis.Decompose(ctx, projectPath, data.Goal, channel)
	return &wshrpc.CommandJarvisDecomposeRtnData{Subtasks: subtasks}, nil
}

const consultTimeout = 120 * time.Second

// postConsultReply persists a consult-reply message and live-updates the pinned channel atom. Mirrors
// PostChannelMessageCommand's post+update pattern for the fire-and-forget consult goroutine. It runs on
// a fresh context, not the RPC request ctx: the request ctx is routinely already cancelled/expired by
// the time a slow consult finishes, and the persisted reply is exactly what lets the FE card resolve,
// so the write must not be tied to the request lifecycle.
func postConsultReply(data wshrpc.CommandConsultData, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage("consult-reply", data.Runtime, text, "consult:"+data.ConsultId, time.Now().UnixMilli())
	if _, err := wstore.PostChannelMessage(ctx, data.ChannelId, msg); err != nil {
		log.Printf("consult: failed to post reply: %v", err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
}

func (ws *WshServer) ConsultCommand(ctx context.Context, data wshrpc.CommandConsultData) chan wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk])
	go func() {
		defer func() {
			panichandler.PanicHandler("ConsultCommand", recover())
		}()
		defer close(rtn)
		ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
		if err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Error: fmt.Errorf("channel not found: %w", err)}
			return
		}
		spec, ok := consult.SpecFor(data.Runtime)
		if !ok {
			postConsultReply(data, "consult is not supported for @"+data.Runtime)
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Error: fmt.Errorf("unsupported runtime: %s", data.Runtime)}
			return
		}
		// claude discovers ~/.claude/CLAUDE.md itself (it runs with cwd = project path); other runtimes
		// don't, so inject the operator's global principles for them. a read failure must not fail the
		// consult — log and continue with none.
		var principles string
		if data.Runtime != "claude" {
			p, perr := consult.OperatorPrinciples()
			if perr != nil {
				log.Printf("consult: reading operator principles: %v", perr)
			}
			principles = p
		}
		prompt := consult.BuildPrompt(ch.Messages, data.Prompt, principles)
		runCtx, cancel := context.WithTimeout(ctx, consultTimeout)
		defer cancel()
		full, runErr := consult.Run(runCtx, spec, ch.ProjectPath, prompt, func(chunk string) {
			// live streaming is best-effort: never let a stalled/absent stream consumer wedge Run
			// (the persisted consult-reply below is the reliable path the FE resolves on).
			select {
			case rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Response: wshrpc.ConsultChunk{Text: chunk}}:
			case <-runCtx.Done():
			}
		})
		reply := strings.TrimSpace(full)
		if runErr != nil {
			if reply != "" {
				reply += "\n\n"
			}
			reply += "consult failed: " + runErr.Error()
		}
		postConsultReply(data, reply)
	}()
	return rtn
}

// postJarvisReply persists the jarvis-reply message and live-updates the pinned channel atom. Mirrors
// postConsultReply (fresh context, not the RPC request ctx, since a slow summary routinely outlives it).
func postJarvisReply(data wshrpc.CommandJarvisData, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage("jarvis-reply", "jarvis", text, "jarvis:"+data.RequestId, time.Now().UnixMilli())
	if _, err := wstore.PostChannelMessage(ctx, data.ChannelId, msg); err != nil {
		log.Printf("jarvis: failed to post reply: %v", err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
}

func (ws *WshServer) JarvisCommand(ctx context.Context, data wshrpc.CommandJarvisData) chan wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk])
	go func() {
		defer func() {
			panichandler.PanicHandler("JarvisCommand", recover())
		}()
		defer close(rtn)
		ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
		if err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Error: fmt.Errorf("channel not found: %w", err)}
			return
		}
		spec, ok := consult.SpecFor("claude")
		if !ok {
			postJarvisReply(data, "jarvis requires the claude CLI, which is not available")
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Error: fmt.Errorf("claude runtime unavailable")}
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, consultTimeout)
		defer cancel()
		full, runErr := consult.Run(runCtx, spec, ch.ProjectPath, data.Prompt, func(chunk string) {
			select {
			case rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Response: wshrpc.JarvisChunk{Text: chunk}}:
			case <-runCtx.Done():
			}
		})
		reply := strings.TrimSpace(full)
		if runErr != nil {
			if reply != "" {
				reply += "\n\n"
			}
			reply += "jarvis failed: " + runErr.Error()
		}
		postJarvisReply(data, reply)
	}()
	return rtn
}

func (ws *WshServer) JarvisConverseCommand(ctx context.Context, data wshrpc.CommandJarvisConverseData) chan wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk])
	go func() {
		defer func() { panichandler.PanicHandler("JarvisConverseCommand", recover()) }()
		defer close(rtn)
		if _, err := waveobj.ParseORef(waveobj.OType_JarvisConversation + ":" + data.ConversationId); err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk]{Error: fmt.Errorf("invalid conversationid: %w", err)}
			return
		}
		emit := func(chunk wshrpc.JarvisConverseChunk) {
			select {
			case rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk]{Response: chunk}:
			case <-ctx.Done():
			}
		}
		convo, err := wstore.GetJarvisConversation(ctx, data.ConversationId)
		if errors.Is(err, wstore.ErrNotFound) {
			convo, err = wstore.CreateJarvisConversation(ctx, data.ConversationId, firstLine(data.Prompt), data.ScopeMode, data.ProjectPath, data.AttachedORefs)
		}
		if err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk]{Error: fmt.Errorf("loading conversation: %w", err)}
			return
		}
		priorTurns := convo.Turns
		persistJarvisTurn(convo.OID, waveobj.JarvisConvoTurn{
			Role:        "user",
			Text:        strings.TrimSpace(data.Prompt),
			Attachments: attachmentsFromORefs(convo.AttachedORefs),
		})
		scope := jarvisrecall.ScopeArgs{
			Mode:          convo.ScopeMode,
			ProjectPath:   convo.ProjectPath,
			AttachedORefs: convo.AttachedORefs,
		}
		answerTurn, converseErr := jarvisrecall.Converse(ctx, scope, priorTurns, data.Prompt, emit)
		if answerTurn.Role != "" {
			persistJarvisTurn(convo.OID, answerTurn)
		}
		if converseErr != nil {
			log.Printf("jarvis converse: %v", converseErr)
			if answerTurn.Role == "" {
				rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk]{Error: converseErr}
			}
		}
	}()
	return rtn
}

func persistJarvisTurn(convoID string, turn waveobj.JarvisConvoTurn) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := wstore.AppendJarvisTurn(ctx, convoID, turn); err != nil {
		log.Printf("jarvis: persist turn: %v", err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_JarvisConversation, convoID))
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	runes := []rune(s)
	if len(runes) > 120 {
		s = string(runes[:120])
	}
	if s == "" {
		return "New conversation"
	}
	return s
}

func attachmentsFromORefs(orefs []string) []waveobj.JarvisConvoSourceRef {
	if len(orefs) == 0 {
		return nil
	}
	out := make([]waveobj.JarvisConvoSourceRef, 0, len(orefs))
	for _, ref := range orefs {
		sourceType := ref
		if i := strings.IndexByte(ref, ':'); i > 0 {
			sourceType = ref[:i]
		}
		out = append(out, waveobj.JarvisConvoSourceRef{ORef: ref, SourceType: sourceType})
	}
	return out
}
func (ws *WshServer) ListJarvisConversationsCommand(ctx context.Context) (*wshrpc.CommandListJarvisConversationsRtnData, error) {
	conversations, err := wstore.GetJarvisConversations(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]wshrpc.JarvisConversationSummary, 0, len(conversations))
	for _, conversation := range conversations {
		out = append(out, wshrpc.JarvisConversationSummary{
			Id:        conversation.OID,
			Title:     conversation.Title,
			ScopeMode: conversation.ScopeMode,
			UpdatedTs: conversation.UpdatedTs,
		})
	}
	return &wshrpc.CommandListJarvisConversationsRtnData{Conversations: out}, nil
}
func (ws *WshServer) ListConsultRuntimesCommand(ctx context.Context) (*wshrpc.CommandListConsultRuntimesRtnData, error) {
	var infos []wshrpc.ConsultRuntimeInfo
	for _, rt := range consult.SupportedRuntimes() {
		installed, version := consult.ProbeInstalled(ctx, rt)
		infos = append(infos, wshrpc.ConsultRuntimeInfo{Runtime: rt, Installed: installed, Version: version})
	}
	return &wshrpc.CommandListConsultRuntimesRtnData{Runtimes: infos}, nil
}

func (ws *WshServer) ListDossiersCommand(ctx context.Context) (*wshrpc.CommandListDossiersRtnData, error) {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	return listDossiers(v)
}

// collectDossiers projects the tasks collection to SpaceSummaries, keeping those whose status passes
// keep, newest-updated first. The shared core behind ListDossiers (U1, active|paused) and
// ListTaskDossiers (U2, all statuses).
func collectDossiers(v *wavevault.Vault, keep func(status string) bool) ([]wshrpc.SpaceSummary, error) {
	r := v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollTasks}})
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		return nil, fmt.Errorf("querying tasks: %w", err)
	}
	out := []wshrpc.SpaceSummary{}
	for _, n := range nodes {
		d, err := jarvisdossier.LoadDossier(r, n.ID)
		if err != nil {
			continue // tolerant: skip an unreadable/foreign node
		}
		if !keep(d.Status) {
			continue
		}
		out = append(out, wshrpc.SpaceSummary{Id: d.ID, Objective: d.Objective, Ticket: d.Ticket, Status: d.Status, Updated: d.Updated})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	return out, nil
}

// listDossiers is U1's focusable-task core (active|paused only), unchanged in behavior.
func listDossiers(v *wavevault.Vault) (*wshrpc.CommandListDossiersRtnData, error) {
	spaces, err := collectDossiers(v, func(s string) bool { return s == "active" || s == "paused" })
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandListDossiersRtnData{Spaces: spaces}, nil
}

// listTaskDossiers is U2's all-statuses core (the Tasks surface groups them Active/Paused/Done).
func listTaskDossiers(v *wavevault.Vault) (*wshrpc.CommandListTaskDossiersRtnData, error) {
	dossiers, err := collectDossiers(v, func(string) bool { return true })
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandListTaskDossiersRtnData{Dossiers: dossiers}, nil
}

// getDossier assembles a dossier's read view-model: its machine fields/blocks, the human ## Notes
// prose, and its decisions (resolved by the decisions that [[link]] back to it), newest-first.
func getDossier(v *wavevault.Vault, id string) (*wshrpc.DossierDetail, error) {
	r := v.Retriever(wavevault.AllScope())
	d, err := jarvisdossier.LoadDossier(r, id)
	if err != nil {
		return nil, fmt.Errorf("loading dossier: %w", err)
	}
	cards, err := dossierDecisions(v, id)
	if err != nil {
		return nil, err
	}
	return &wshrpc.DossierDetail{
		Id: d.ID, Ticket: d.Ticket, Objective: d.Objective, Acceptance: d.Acceptance,
		Confidence: d.Confidence, Status: d.Status, Created: d.Created, Updated: d.Updated,
		State: d.State, Blockers: d.Blockers, Refs: d.Refs, Notes: d.Notes, Decisions: cards,
	}, nil
}

// dossierDecisions resolves the decision records linking back to dossierID, projected to cards,
// newest-created first. A decisions-scoped HasLink query (robust vs. parsing the mixed refs block).
func dossierDecisions(v *wavevault.Vault, dossierID string) ([]wshrpc.DecisionCard, error) {
	r := v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollDecisions}})
	nodes, err := r.Query(wavevault.Filter{HasLink: dossierID})
	if err != nil {
		return nil, fmt.Errorf("querying decisions: %w", err)
	}
	cards := []wshrpc.DecisionCard{}
	for _, n := range nodes {
		dec, err := jarvisdossier.LoadDecision(r, n.ID)
		if err != nil {
			continue
		}
		cards = append(cards, wshrpc.DecisionCard{
			Id: dec.ID, Created: dec.Created, Actor: dec.Actor, Provenance: dec.Provenance,
			Status: dec.Status, Links: dec.Links, Rationale: dec.Rationale,
		})
	}
	sort.SliceStable(cards, func(i, j int) bool { return cards[i].Created > cards[j].Created })
	return cards, nil
}

var validDossierStatuses = map[string]bool{"active": true, "paused": true, "completed": true, "archived": true}

// appendDossierDecision writes a human-attributed decision and commits at the boundary. Returns the
// decision id even on a commit error so the caller can surface a partial success.
func appendDossierDecision(ctx context.Context, v *wavevault.Vault, data wshrpc.CommandAppendDossierDecisionData) (string, error) {
	decID, err := jarvisdossier.AppendHumanDecision(v, jarvisdossier.DecisionFacts{
		TaskID:    data.DossierId,
		Links:     data.Links,
		Rationale: data.Rationale,
		Summary:   data.Summary,
	})
	if err != nil {
		return "", fmt.Errorf("appending decision: %w", err)
	}
	if err := v.Commit(ctx, "human: decision added — "+data.DossierId); err != nil {
		return decID, fmt.Errorf("committing decision: %w", err)
	}
	return decID, nil
}

// setDossierStatus validates and writes the machine-owned status, retrying once on a concurrent
// external edit (baseHash mismatch), then commits.
func setDossierStatus(ctx context.Context, v *wavevault.Vault, id, status string) error {
	if !validDossierStatuses[status] {
		return fmt.Errorf("invalid status %q", status)
	}
	d, err := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
	if err != nil {
		return fmt.Errorf("loading dossier: %w", err)
	}
	res, err := jarvisdossier.SetStatus(v, id, status, d.Hash)
	if err != nil {
		return fmt.Errorf("setting status: %w", err)
	}
	if res.Conflict {
		d2, err := jarvisdossier.LoadDossier(v.Retriever(wavevault.AllScope()), id)
		if err != nil {
			return fmt.Errorf("reloading after conflict: %w", err)
		}
		if _, err := jarvisdossier.SetStatus(v, id, status, d2.Hash); err != nil {
			return fmt.Errorf("retry after conflict: %w", err)
		}
	}
	return v.Commit(ctx, id+" → "+status)
}

func (ws *WshServer) ResolveSpaceScopeCommand(ctx context.Context, data wshrpc.CommandResolveSpaceScopeData) (*wshrpc.SpaceScope, error) {
	if data.DossierId == "" {
		return nil, fmt.Errorf("dossierid is required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	edges, err := jarvisattrib.EdgesFor(ctx, v, data.DossierId)
	if err != nil {
		return nil, fmt.Errorf("resolving edges: %w", err)
	}
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return nil, fmt.Errorf("loading runs: %w", err)
	}
	byORef := make(map[string]*waveobj.Run, len(runs))
	for _, run := range runs {
		byORef["run:"+run.OID] = run
	}
	scope := buildSpaceScope(edges, byORef)
	return &scope, nil
}

func (ws *WshServer) GetDossierCommand(ctx context.Context, data wshrpc.CommandGetDossierData) (*wshrpc.DossierDetail, error) {
	if data.DossierId == "" {
		return nil, fmt.Errorf("dossierid is required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	return getDossier(v, data.DossierId)
}

func (ws *WshServer) ListTaskDossiersCommand(ctx context.Context) (*wshrpc.CommandListTaskDossiersRtnData, error) {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	return listTaskDossiers(v)
}

func (ws *WshServer) AppendDossierDecisionCommand(ctx context.Context, data wshrpc.CommandAppendDossierDecisionData) (*wshrpc.CommandAppendDossierDecisionRtnData, error) {
	if data.DossierId == "" {
		return nil, fmt.Errorf("dossierid is required")
	}
	if strings.TrimSpace(data.Rationale) == "" {
		return nil, fmt.Errorf("rationale is required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening vault: %w", err)
	}
	decID, err := appendDossierDecision(ctx, v, data)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandAppendDossierDecisionRtnData{DecisionId: decID}, nil
}

func (ws *WshServer) SetDossierStatusCommand(ctx context.Context, data wshrpc.CommandSetDossierStatusData) error {
	if data.DossierId == "" {
		return fmt.Errorf("dossierid is required")
	}
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return fmt.Errorf("opening vault: %w", err)
	}
	return setDossierStatus(ctx, v, data.DossierId, data.Status)
}

// buildSpaceScope is the pure edge->bundle core: dedup the attributed run orefs, their channel oids, and
// the worker tab ids (tab: prefix stripped) from each run's phases. Order-stable by first appearance; an
// edge to a run missing from byORef still contributes its run oref (surfaced, not dropped).
func buildSpaceScope(edges []jarvisattrib.AttributedEdge, byORef map[string]*waveobj.Run) wshrpc.SpaceScope {
	scope := wshrpc.SpaceScope{RunORefs: []string{}, ChannelOids: []string{}, TabIds: []string{}}
	seenRun := map[string]bool{}
	seenChan := map[string]bool{}
	seenTab := map[string]bool{}
	for _, e := range edges {
		if seenRun[e.RunORef] {
			continue
		}
		seenRun[e.RunORef] = true
		scope.RunORefs = append(scope.RunORefs, e.RunORef)
		run := byORef[e.RunORef]
		if run == nil {
			continue
		}
		if run.ChannelOID != "" && !seenChan[run.ChannelOID] {
			seenChan[run.ChannelOID] = true
			scope.ChannelOids = append(scope.ChannelOids, run.ChannelOID)
		}
		for _, ph := range run.Phases {
			for _, wo := range ph.WorkerOrefs {
				if !strings.HasPrefix(wo, "tab:") {
					continue
				}
				tabID := strings.TrimPrefix(wo, "tab:")
				if tabID == "" || seenTab[tabID] {
					continue
				}
				seenTab[tabID] = true
				scope.TabIds = append(scope.TabIds, tabID)
			}
		}
	}
	return scope
}
