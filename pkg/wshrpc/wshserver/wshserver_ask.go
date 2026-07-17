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
	agentask.GlobalRegistry.Set(data.ORef, agentask.PendingAsk{
		AskId:     askId,
		BlockId:   oref.OID,
		Questions: data.Questions,
	})
	publishAgentAsk(baseds.AgentAskData{
		ORef:      data.ORef,
		AskId:     askId,
		Questions: data.Questions,
		Ts:        time.Now().UnixMilli(),
	})
	return wshrpc.AskRtnData{AskId: askId}, nil
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
