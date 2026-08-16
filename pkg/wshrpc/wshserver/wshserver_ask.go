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
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

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
	forwardChildAsk(ctx, data.ORef, data.Questions)
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
func forwardChildAsk(ctx context.Context, blockOref string, questions []baseds.AgentAskQuestion) {
	run, _, ok := ownerRunForBlock(ctx, blockOref)
	if !ok || run.DagORef == "" || len(questions) == 0 {
		return
	}
	g, err := wstore.GetDag(ctx, run.DagORef)
	if err != nil {
		return
	}
	taskId := ""
	for i := range g.Tasks {
		if g.Tasks[i].RunID == run.ID {
			taskId = g.Tasks[i].ID
			break
		}
	}
	if taskId == "" {
		return
	}
	orchestrate.PublishChildAsk(ctx, g, taskId, questions[0].Question)
}
