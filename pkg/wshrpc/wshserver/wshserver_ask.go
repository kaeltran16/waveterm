// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// askEventTimeout bounds the ask-lifecycle recording work (a block -> run -> dag walk plus one
// append) so a slow store can never hold up the answer or clear path it hangs off.
const askEventTimeout = 5 * time.Second

func (ws *WshServer) AskCommand(ctx context.Context, data wshrpc.CommandAskData) (wshrpc.AskRtnData, error) {
	if data.ORef == "" || len(data.Questions) == 0 {
		return wshrpc.AskRtnData{}, fmt.Errorf("oref and at least one question are required")
	}
	oref, err := waveobj.ParseORef(data.ORef)
	if err != nil {
		return wshrpc.AskRtnData{}, fmt.Errorf("invalid oref %q: %w", data.ORef, err)
	}
	askId := uuid.New().String()
	// one raise time for both the registry entry and the published event: the attention list ages an ask
	// off its registry Ts while the frontend ages it off the event's, and two time.Now() calls would let
	// those two disagree by the width of this function.
	ts := time.Now().UnixMilli()
	agentask.GlobalRegistry.Set(data.ORef, agentask.PendingAsk{
		AskId:     askId,
		BlockId:   oref.OID,
		Questions: data.Questions,
		Ts:        ts,
		Prose:     data.Prose,
	})
	publishAgentAsk(baseds.AgentAskData{
		ORef:      data.ORef,
		AskId:     askId,
		Questions: data.Questions,
		Ts:        ts,
		Prose:     data.Prose,
	})
	// a dag child raising an ask is a lead event: the child blocks on the question, so the lead must
	// be able to see it (and answer it via `wsh jarvis dag answer`) — the child sessions are invisible
	// to the human (the "child asks never reach anyone" flaw).
	forwardChildAsk(ctx, data.ORef, askId, data.Questions)
	if !data.Wait {
		return wshrpc.AskRtnData{AskId: askId}, nil
	}
	// wait mode (pi ask bridge): block until the human answers in the cockpit, or the
	// caller dies. ctx.Done cleanup drops the pending ask and publishes the cleared
	// event so the attention list never shows a stale ask for a dead agent.
	ch := agentask.GlobalRegistry.RegisterWaiter(askId)
	select {
	case res := <-ch:
		return wshrpc.AskRtnData{AskId: askId, Answers: res.Answers, Cancelled: res.Cancelled}, nil
	case <-ctx.Done():
		agentask.GlobalRegistry.RemoveWaiter(askId)
		agentask.GlobalRegistry.Drop(data.ORef)
		recordAskTransition(data.ORef, askId, waveobj.RunEventKindChildAskCleared, orchestrate.AskClearReasonWaiterEnded)
		publishAgentAsk(baseds.AgentAskData{ORef: data.ORef, AskId: askId, Cleared: true})
		return wshrpc.AskRtnData{}, ctx.Err()
	}
}

func (ws *WshServer) AnswerAgentCommand(ctx context.Context, data wshrpc.CommandAnswerAgentData) error {
	if data.ORef == "" {
		return fmt.Errorf("oref is required")
	}
	_, err := agentask.DeliverAnswer(data.ORef, "", data.Answers)
	return err
}

func (ws *WshServer) AgentAskClearCommand(ctx context.Context, oref string) error {
	if oref == "" {
		return fmt.Errorf("oref is required")
	}
	askId := ""
	if pending, ok := agentask.GlobalRegistry.Get(oref); ok {
		askId = pending.AskId
		// a blocked --wait caller (pi) treats a cockpit dismiss as cancellation; CC's
		// PostToolUse clear finds no waiter and is unchanged in effect.
		agentask.GlobalRegistry.ResolveWaiter(askId, agentask.WaitResult{Cancelled: true})
		// only a clear that found something pending is a lifecycle transition — a repeat clear
		// (PostToolUse after a cockpit dismiss) must not append a second row.
		recordAskTransition(oref, askId, waveobj.RunEventKindChildAskCleared, orchestrate.AskClearReasonDismissed)
	}
	agentask.GlobalRegistry.Drop(oref)
	publishAgentAsk(baseds.AgentAskData{ORef: oref, AskId: askId, Cleared: true})
	return nil
}

func publishAgentAsk(data baseds.AgentAskData) {
	jarvis.OnAgentAsk(data) // Gatekeeper (server-side, non-blocking): auto-answer/escalate on enabled channels
	wps.Broker.Publish(wps.WaveEvent{
		Event:   wps.Event_AgentAsk,
		Scopes:  []string{data.ORef},
		Persist: 1,
		Data:    data,
	})
}

// forwardChildAsk routes a pending ask raised by a dag child's block to the dag + its owning run:
// the child's ask card renders only on the child session (invisible to the human), so the engine
// mirrors it as a dag:child-ask event the lead and the cockpit's parent-run surface can show. No-op
// for blocks that are not dag children.
func forwardChildAsk(ctx context.Context, blockOref, askId string, questions []baseds.AgentAskQuestion) {
	if len(questions) == 0 {
		return
	}
	g, target, ok := askTargetForBlock(ctx, blockOref, askId)
	if !ok {
		return
	}
	orchestrate.PublishChildAsk(ctx, g, target, questions[0].Question)
}

// askTargetForBlock resolves the dag task behind a block's ask, so the raise, answer and clear paths
// all attach their lifecycle rows to the same task and ask id. ok=false for a plain (non-dag) block.
func askTargetForBlock(ctx context.Context, blockOref, askId string) (*waveobj.TaskGroup, orchestrate.AskTarget, bool) {
	run, channelId, ok := ownerRunForBlock(ctx, blockOref)
	if !ok {
		return nil, orchestrate.AskTarget{}, false
	}
	return orchestrate.ResolveAskTarget(ctx, channelId, run, askId)
}

// recordAskTransition resolves the dag task behind a block's ask and records one lifecycle row for
// it. It builds its own bounded context rather than taking one: the clear-on-waiter-end caller's
// context is already cancelled, and a dead context would silently drop the row. Non-dag blocks
// resolve to nothing and record nothing.
func recordAskTransition(oref, askId, kind, detail string) {
	ctx, cancel := context.WithTimeout(context.Background(), askEventTimeout)
	defer cancel()
	if _, target, ok := askTargetForBlock(ctx, oref, askId); ok {
		orchestrate.RecordAskLifecycle(ctx, target, kind, detail)
	}
}

// RecordAskAnswered is agentask's answer-hook implementation, wired at server startup. It runs on
// every delivered answer — cockpit, Gatekeeper, or dag lead — and records the one child-answered row
// that closes the ask the child raised.
func RecordAskAnswered(oref, askId string) {
	recordAskTransition(oref, askId, waveobj.RunEventKindChildAnswered, "")
}
