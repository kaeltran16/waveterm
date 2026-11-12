// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// ResolveMemOwner names the footprint key a live job's peak is recorded under: a run command by its run's project
// and command, a run's session by the project and its usage role, any other block by its cwd's project and
// whether its tab is an agent. False when the block or run is gone, so nothing is recorded for it.
func ResolveMemOwner(ctx context.Context, o jobobject.Owner) (memgate.Key, bool) {
	if o.Kind == jobobject.OwnerKind_RunCmd {
		run, err := wstore.DBGet[*waveobj.Run](ctx, o.Id)
		if err != nil || run == nil {
			return memgate.Key{}, false
		}
		return memgate.Key{Project: orchestrate.MemProjectKey(run.ProjectPath), Role: o.Cmd}, true
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, o.Id)
	if err != nil || block == nil {
		return memgate.Key{}, false
	}
	if run, _, ok := ownerRunForBlock(ctx, "block:"+o.Id); ok {
		return memgate.Key{Project: orchestrate.MemProjectKey(run.ProjectPath), Role: jarvis.UsageRole(run)}, true
	}
	key := memgate.Key{Project: orchestrate.MemProjectKey(block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")), Role: memgate.RoleTerminal}
	if tabIsAgent(ctx, block) {
		key.Role = memgate.RoleAgent
	}
	return key, true
}

// tabIsAgent reports whether the block's tab hosts an agent session; an unreadable tab is not one.
func tabIsAgent(ctx context.Context, block *waveobj.Block) bool {
	tabORef, err := waveobj.ParseORef(block.ParentORef)
	if err != nil || tabORef.OType != waveobj.OType_Tab {
		return false
	}
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabORef.OID)
	return err == nil && tab != nil && tab.Meta.GetString(waveobj.MetaKey_SessionAgent, "") != ""
}
