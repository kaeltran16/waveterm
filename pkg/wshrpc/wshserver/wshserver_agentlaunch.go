// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// startAgentTab is the process-starting boundary, a var so tests launch no process.
var startAgentTab = jarvis.StartAgentTab

// LaunchAgentTabCommand opens the UI's agent tab with the command line the UI composed. A refused start keeps
// the tab and returns its refusal in StartError, because the UI marks "failed to start" by block id.
func (ws *WshServer) LaunchAgentTabCommand(ctx context.Context, data wshrpc.CommandLaunchAgentTabData) (*wshrpc.CommandLaunchAgentTabRtnData, error) {
	// the guard SetMetaCommand applies to a cwd the UI sets, which this command sets in its place
	if cwd := data.BlockMeta.GetString(waveobj.MetaKey_CmdCwd, ""); !wavebase.SnapshotMayStart(cwd) {
		return nil, fmt.Errorf("snapshot store: not launching an agent in %q, only inside %s", cwd, wavebase.SnapshotScratchDir())
	}
	tabId, blockId, err := jarvis.OpenAgentTab(ctx, jarvis.AgentTabSpec{
		WorkspaceId: data.WorkspaceId, TabName: data.TabName, TabMeta: data.TabMeta, BlockMeta: data.BlockMeta,
	})
	if err != nil {
		return nil, err
	}
	rtn := &wshrpc.CommandLaunchAgentTabRtnData{TabId: tabId, BlockId: blockId}
	if data.Start {
		if err := startAgentTab(ctx, tabId, blockId); err != nil {
			rtn.StartError = err.Error()
		}
	}
	return rtn, nil
}
