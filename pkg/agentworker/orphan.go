// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func init() {
	wcore.AgentTabCloseHook = onTabClose
}

// goneParents holds, under lifeMu, the tabs whose close has begun. The hook runs before the tab leaves the store, so
// a settle in between still finds the tab, with its process ended, and would hold the notice for it.
var goneParents = map[string]bool{}

// onTabClose orphans the workers of a closing tab: each one idle with its notice owed or held raises its answer and
// stops; one mid-turn raises when its turn settles.
func onTabClose(ctx context.Context, tabId string) {
	lifeMu.Lock()
	defer lifeMu.Unlock()
	goneParents[tabId] = true
	for _, child := range childTabs(ctx, tabId) {
		orphanLocked(ctx, child)
	}
}

func orphanLocked(ctx context.Context, tab *waveobj.Tab) {
	blockId := tab.BlockIds[0]
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		logErr("loading orphaned worker block %s: %v", blockId, err)
		return
	}
	if block.Meta.GetBool(MetaNoticeHeld, false) {
		if err := setBlockMeta(ctx, blockId, MetaNoticeHeld, false); err != nil {
			logErr("clearing the held notice of orphaned worker %s: %v", tab.OID, err)
			return
		}
		raiseOrphan(ctx, tab, block)
		// one running a turn the user typed keeps running under the user-turn rule
		if idleAndStoppable(tab, block) {
			if err := stopLocked(ctx, tab.OID, false); err != nil {
				logErr("stopping orphaned worker %s: %v", tab.OID, err)
			}
		}
		return
	}
	if !block.Meta.GetBool(MetaNoticeOwed, false) || turnUnsettled(tab.OID, blockId) {
		return
	}
	settleLocked(ctx, tab, blockId)
}

// turnUnsettled reports whether the worker's turn is still to settle, which raises the orphan then.
func turnUnsettled(tabId, blockId string) bool {
	if _, open := openTurns[blockId]; open {
		return true
	}
	if _, ended := endedTurns[blockId]; ended {
		return true
	}
	if !shellRunning(blockId) {
		return false
	}
	st := orchestrate.LatestAgentStatus(blockId, tabId)
	// a launch's or a compaction's SessionStart idle comes before the turn's end, as in turnEnded
	return st.State != baseds.AgentState_Idle || st.Hook == baseds.AgentHook_SessionStart
}

// idleAndStoppable reports whether a worker runs, is idle and has no background task a stop would kill.
func idleAndStoppable(tab *waveobj.Tab, block *waveobj.Block) bool {
	return shellRunning(block.OID) && orchestrate.LatestAgentStatus(block.OID, tab.OID).State == baseds.AgentState_Idle &&
		!backgroundTasksRunning(tab, block)
}

// raiseOrphan marks the worker's tab with its answer's first line, which the attention list shows until it is
// acknowledged. The answer is read once here, since the cockpit polls the list and a transcript read is whole-file.
func raiseOrphan(ctx context.Context, tab *waveobj.Tab, block *waveobj.Block) {
	answer := ""
	if transcript := block.Meta.GetString(waveobj.MetaKey_AgentTranscriptPath, ""); transcript != "" {
		answer, _ = agentsessions.LastAnswer(transcript, tab.Meta.GetString(metaTabHarness, ""))
	}
	meta := waveobj.MetaMapType{
		jarvis.MetaWorkerOrphaned:     now().UnixMilli(),
		jarvis.MetaWorkerOrphanAnswer: jarvis.OrphanAnswerLine(answer),
	}
	if _, err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Tab, tab.OID), meta, false); err != nil {
		logErr("marking orphaned worker %s: %v", tab.OID, err)
	}
}

// parentGone reports whether a worker's parent tab is closed or closing.
func parentGone(parentTab *waveobj.Tab, parentId string) bool {
	return parentTab == nil || goneParents[parentId]
}
