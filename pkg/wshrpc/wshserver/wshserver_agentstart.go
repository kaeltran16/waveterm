// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/agentworker"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// AgentsStartCommand starts a worker under the calling agent. A run's agent is refused: its tree is merged and
// deleted by the engine, so a worker there would work outside review, landing and the run's memory accounting.
func (ws *WshServer) AgentsStartCommand(ctx context.Context, data wshrpc.CommandAgentsStartData) (*wshrpc.CommandAgentsStartRtnData, error) {
	facts, err := loadAgentRosterFacts(ctx)
	if err != nil {
		return nil, err
	}
	blockId, tab, err := senderTab(facts, data.FromORef)
	if err != nil {
		return nil, err
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return nil, fmt.Errorf("loading the caller's block %s: %w", blockId, err)
	}
	if block.Meta.GetString("agent:runid", "") != "" || ownerRun(facts.Runs, tab.OID) != nil {
		return nil, fmt.Errorf("a run's agent cannot start workers: runs delegate through their plan")
	}
	return agentworker.Start(ctx, data)
}
