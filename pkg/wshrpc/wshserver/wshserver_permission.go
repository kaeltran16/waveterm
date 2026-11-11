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
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) AgentPermissionCommand(ctx context.Context, data wshrpc.CommandAgentPermissionData) (string, error) {
	if data.ORef == "" || data.ToolName == "" {
		return "", fmt.Errorf("oref and tool name are required")
	}
	oref, err := waveobj.ParseORef(data.ORef)
	if err != nil {
		return "", fmt.Errorf("invalid oref %q: %w", data.ORef, err)
	}
	p := agentask.PendingPermission{
		PermId:    uuid.New().String(),
		BlockId:   oref.OID,
		ToolName:  data.ToolName,
		ToolInput: data.ToolInput,
		ToolKey:   data.ToolKey,
		Choices:   agentask.PermissionChoices(data.ToolName, data.HasSuggestions),
		Ts:        time.Now().UnixMilli(),
	}
	agentask.GlobalPermissions.Raise(data.ORef, p)
	publishAgentPermission(baseds.AgentPermissionData{
		ORef:      data.ORef,
		PermId:    p.PermId,
		ToolName:  p.ToolName,
		ToolInput: p.ToolInput,
		Choices:   p.Choices,
		Ts:        p.Ts,
	})
	return p.PermId, nil
}

func (ws *WshServer) AnswerAgentPermissionCommand(ctx context.Context, data wshrpc.CommandAnswerAgentPermissionData) error {
	if data.ORef == "" || data.PermId == "" {
		return fmt.Errorf("oref and permid are required")
	}
	if err := agentask.DeliverPermission(data.ORef, data.PermId, data.Choice); err != nil {
		return err
	}
	publishAgentPermission(baseds.AgentPermissionData{ORef: data.ORef, PermId: data.PermId, Cleared: true})
	return nil
}

func (ws *WshServer) AgentPermissionListCommand(ctx context.Context) ([]baseds.AgentPermissionData, error) {
	return listAgentPermissions(agentask.GlobalPermissions.All()), nil
}

func listAgentPermissions(all map[string][]agentask.PendingPermission) []baseds.AgentPermissionData {
	list := []baseds.AgentPermissionData{}
	for oref, queue := range all {
		for _, p := range queue {
			list = append(list, baseds.AgentPermissionData{
				ORef:      oref,
				PermId:    p.PermId,
				ToolName:  p.ToolName,
				ToolInput: p.ToolInput,
				Choices:   p.Choices,
				Ts:        p.Ts,
			})
		}
	}
	return list
}

// retirePermissions drops the pending permission requests a status proves answered elsewhere: a PostToolUse
// or PostToolUseFailure for the same tool call, or a new prompt, a Stop or a new session after them. It runs before publishEvent's
// stale and out-of-turn drops, since a late PostToolUse those discard still proves its tool ran.
func retirePermissions(ev *wps.WaveEvent) {
	if ev == nil || ev.Event != wps.Event_AgentStatus {
		return
	}
	var data baseds.AgentStatusData
	if err := utilfn.ReUnmarshal(&data, ev.Data); err != nil || data.ORef == "" || data.Ts == 0 {
		return
	}
	var retired []agentask.PendingPermission
	switch data.Hook {
	case baseds.AgentHook_PostToolUse, baseds.AgentHook_PostToolUseFailure:
		retired = agentask.GlobalPermissions.RetireKey(data.ORef, data.ToolKey, data.Ts)
	case baseds.AgentHook_UserPromptSubmit, baseds.AgentHook_Stop, baseds.AgentHook_SessionStart:
		retired = agentask.GlobalPermissions.RetireUpTo(data.ORef, data.Ts)
	}
	for _, p := range retired {
		publishAgentPermission(baseds.AgentPermissionData{ORef: data.ORef, PermId: p.PermId, Cleared: true})
	}
}

// publishAgentPermission is not persisted: a queue per block does not replay from the last events, so a
// reloaded frontend reads the open requests from AgentPermissionListCommand instead.
func publishAgentPermission(data baseds.AgentPermissionData) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:  wps.Event_AgentPermission,
		Scopes: []string{data.ORef},
		Data:   data,
	})
}
