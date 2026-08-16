// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// ownerRunForBlock resolves the run owning a block (block -> tab via ParentORef -> the run whose
// phases list that tab as a worker) plus its channel. Found=false for any unresolvable step — callers
// degrade gracefully (an ask from an unrelated block is not a dag child's ask).
func ownerRunForBlock(ctx context.Context, blockOrefStr string) (*waveobj.Run, string, bool) {
	if blockOrefStr == "" {
		return nil, "", false
	}
	oref, err := waveobj.ParseORef(blockOrefStr)
	if err != nil || oref.OType != waveobj.OType_Block {
		return nil, "", false
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, oref.OID)
	if err != nil || block.ParentORef == "" {
		return nil, "", false
	}
	tabORef, err := waveobj.ParseORef(block.ParentORef)
	if err != nil || tabORef.OType != waveobj.OType_Tab {
		return nil, "", false
	}
	tabOrefStr := "tab:" + tabORef.OID
	cwd := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, "", false
	}
	for _, ch := range channels {
		runs, rerr := wstore.GetChannelRuns(ctx, ch.OID)
		if rerr != nil {
			continue
		}
		for _, run := range runs {
			for _, p := range run.Phases {
				for _, w := range p.WorkerOrefs {
					if w == tabOrefStr {
						return run, ch.OID, true
					}
				}
			}
			// DAG-spawned children have no phase workerorefs; their block runs in the child's own
			// worktree (run.ProjectPath), so match the block's cwd against it. Only executing runs
			// match — a cancelled attempt shares the worktree with its respawn.
			if run.DagORef != "" && run.ProjectPath != "" && cwd != "" && runPhaseRunning(run) && filepath.Clean(cwd) == filepath.Clean(run.ProjectPath) {
				return run, ch.OID, true
			}
		}
	}
	return nil, "", false
}

// JarvisCtxCommand resolves the run context owning the caller's block: block -> tab (ParentORef) ->
// the run whose phases list that tab as a worker. Empty for an unresolvable caller — the lead's
// `wsh jarvis dag` commands fall back on this so the engine's own session never needs to dig ids out
// of the database (the "run context is not injected" flaw).
func runPhaseRunning(run *waveobj.Run) bool {
	for _, p := range run.Phases {
		if p.State == jarvis.PhaseState_Running {
			return true
		}
	}
	return false
}

func (ws *WshServer) JarvisCtxCommand(ctx context.Context, data wshrpc.CommandJarvisCtxData) (*wshrpc.CommandJarvisCtxRtnData, error) {
	rtn := &wshrpc.CommandJarvisCtxRtnData{}
	run, channelId, ok := ownerRunForBlock(ctx, data.BlockORef)
	if !ok {
		return rtn, nil
	}
	rtn.ChannelId = channelId
	rtn.RunId = run.ID
	rtn.DagOID = run.DagORef
	rtn.Goal = run.Goal
	return rtn, nil
}
