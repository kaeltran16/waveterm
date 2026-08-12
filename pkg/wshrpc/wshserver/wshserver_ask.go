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
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
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
	})
	publishAgentAsk(baseds.AgentAskData{
		ORef:      data.ORef,
		AskId:     askId,
		Questions: data.Questions,
		Ts:        ts,
	})
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
