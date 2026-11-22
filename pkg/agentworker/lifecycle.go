// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentmsg"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// idleSweepEvery is how often the sweep looks for workers idle past their prompt cache's lifetime.
const idleSweepEvery = time.Minute

func init() {
	jarvis.AgentExitHook = onAgentExit
}

var (
	// lifeMu serializes every decision below: an idle report, a stop's re-check and an exit can race over the same
	// owed notice, which must go out once.
	lifeMu sync.Mutex
	// openTurns holds the worker blocks that reported working since their last turn end. A launch reports idle before
	// its first turn opens (claude's SessionStart, pi's session_start), and that idle is not an answer.
	openTurns = map[string]bool{}
)

// seams for tests, which run no processes
var (
	shellRunning = func(blockId string) bool {
		rs := blockcontroller.GetBlockControllerRuntimeStatus(blockId)
		return rs != nil && rs.ShellProcStatus == blockcontroller.Status_Running
	}
	deliverNotice = orchestrate.SendToSession
	now           = time.Now
)

// NoteStatus applies an agent's status report to the workers: a worker idle after its parent's turn notifies the
// parent and stops, and a parent whose agent runs receives the notices held for it.
func NoteStatus(ctx context.Context, data *baseds.AgentStatusData) {
	if data == nil || data.ORef == "" {
		return
	}
	tab, blockId := resolveAgent(ctx, data.ORef)
	if tab == nil {
		return
	}
	lifeMu.Lock()
	defer lifeMu.Unlock()
	if !data.Ended && shellRunning(blockId) {
		deliverHeldLocked(ctx, tab.OID, blockId)
	}
	if ParentOf(tab) == "" || !turnEnded(blockId, data) {
		return
	}
	settleLocked(ctx, tab, blockId)
}

func turnEnded(blockId string, data *baseds.AgentStatusData) bool {
	switch data.State {
	case baseds.AgentState_Working:
		openTurns[blockId] = true
	case baseds.AgentState_Idle:
		// a mid-turn compaction's SessionStart does not end the turn
		if data.Hook == baseds.AgentHook_SessionStart || !openTurns[blockId] {
			return false
		}
		delete(openTurns, blockId)
		return true
	}
	return false
}

// settleLocked sends an idle worker's owed notice and stops it, once no worker of its own still runs: a stopped
// worker would have no process to receive their notices.
func settleLocked(ctx context.Context, tab *waveobj.Tab, blockId string) {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		logErr("loading worker block %s: %v", blockId, err)
		return
	}
	if !block.Meta.GetBool(MetaNoticeOwed, false) || hasRunningChild(ctx, tab.OID) {
		return
	}
	if err := SetNoticeOwed(ctx, blockId, false); err != nil {
		logErr("clearing the owed notice of worker %s: %v", tab.OID, err)
		return
	}
	parentTab, parentBlock := loadTab(ctx, ParentOf(tab))
	if parentTab == nil {
		return // the parent's tab is closed: the notice is dropped
	}
	if !agentLive(parentTab.OID, parentBlock) {
		if err := setBlockMeta(ctx, blockId, MetaNoticeHeld, true); err != nil {
			logErr("holding the notice of worker %s: %v", tab.OID, err)
		}
		return
	}
	deliverNotice(parentBlock, agentmsg.WorkerNotice(tab.Name, tab.OID))
	// the parent was just handed a turn, so its re-check waits for that turn's end
	if err := stopLocked(ctx, tab.OID, false); err != nil {
		logErr("stopping worker %s after its notice: %v", tab.OID, err)
	}
}

// deliverHeldLocked hands a parent whose agent runs every notice held for it, and stops each of those workers that
// still runs and is idle.
func deliverHeldLocked(ctx context.Context, parentTabId, parentBlock string) {
	for _, child := range childTabs(ctx, parentTabId) {
		blockId := child.BlockIds[0]
		block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if err != nil || block == nil || !block.Meta.GetBool(MetaNoticeHeld, false) {
			continue
		}
		if err := setBlockMeta(ctx, blockId, MetaNoticeHeld, false); err != nil {
			logErr("clearing the held notice of worker %s: %v", child.OID, err)
			continue
		}
		deliverNotice(parentBlock, agentmsg.WorkerNotice(child.Name, child.OID))
		if shellRunning(blockId) && orchestrate.LatestAgentStatus(blockId, child.OID).State == baseds.AgentState_Idle {
			if err := stopLocked(ctx, child.OID, false); err != nil {
				logErr("stopping worker %s after its held notice: %v", child.OID, err)
			}
		}
	}
}

// StopWorker disarms a worker's block and ends its process; its tab stays (cmd:keeponexit) and its claim is released
// when the job closes. A parent worker left idle with no worker of its own running then settles.
func StopWorker(ctx context.Context, tabId string) error {
	lifeMu.Lock()
	defer lifeMu.Unlock()
	return stopLocked(ctx, tabId, true)
}

func stopLocked(ctx context.Context, tabId string, recheckParent bool) error {
	if err := jarvis.StopRunWorker(ctx, waveobj.MakeORef(waveobj.OType_Tab, tabId).String()); err != nil {
		return fmt.Errorf("stopping worker %s: %w", tabId, err)
	}
	if recheckParent {
		recheckParentLocked(ctx, tabId)
	}
	return nil
}

// recheckParentLocked settles a stopped worker's parent as if it had just gone idle, when it is an idle worker.
func recheckParentLocked(ctx context.Context, childTabId string) {
	child, _ := loadTab(ctx, childTabId)
	if child == nil {
		return
	}
	parent, parentBlock := loadTab(ctx, ParentOf(child))
	if parent == nil || ParentOf(parent) == "" {
		return
	}
	if orchestrate.LatestAgentStatus(parentBlock, parent.OID).State != baseds.AgentState_Idle {
		return
	}
	settleLocked(ctx, parent, parentBlock)
}

// onAgentExit disarms a worker whose process exited on its own, so a terminal remount never replays its first prompt.
// A block already disarmed was stopped here, and that stop settled its parent.
func onAgentExit(ctx context.Context, tabId, blockId string) {
	lifeMu.Lock()
	defer lifeMu.Unlock()
	tab, _ := loadTab(ctx, tabId)
	if tab == nil || ParentOf(tab) == "" {
		return
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil || block.Meta.GetString(waveobj.MetaKey_Controller, "") == "" {
		return
	}
	if err := stopLocked(ctx, tabId, true); err != nil {
		logErr("disarming exited worker %s: %v", tabId, err)
	}
}

// StartIdleSweep stops, each minute, every running worker idle for its prompt cache's lifetime with no notice owed
// and no worker of its own running: past that a resume costs no more than staying alive.
func StartIdleSweep(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(idleSweepEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sweepIdle(ctx)
			}
		}
	}()
}

func sweepIdle(ctx context.Context) {
	lifeMu.Lock()
	defer lifeMu.Unlock()
	tabs, err := wstore.DBGetAllObjsByType[*waveobj.Tab](ctx, waveobj.OType_Tab)
	if err != nil {
		logErr("idle sweep: loading tabs: %v", err)
		return
	}
	for _, tab := range tabs {
		if ParentOf(tab) == "" || len(tab.BlockIds) == 0 || !idleTooLong(ctx, tab) {
			continue
		}
		if err := stopLocked(ctx, tab.OID, true); err != nil {
			logErr("idle sweep: %v", err)
		}
	}
}

func idleTooLong(ctx context.Context, tab *waveobj.Tab) bool {
	blockId := tab.BlockIds[0]
	if !shellRunning(blockId) {
		return false
	}
	st := orchestrate.LatestAgentStatus(blockId, tab.OID)
	if st.State != baseds.AgentState_Idle || now().Sub(time.UnixMilli(st.Ts)) < orchestrate.WorkerCacheTTL {
		return false
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil || block.Meta.GetBool(MetaNoticeOwed, false) {
		return false
	}
	return !hasRunningChild(ctx, tab.OID)
}

func hasRunningChild(ctx context.Context, tabId string) bool {
	for _, child := range childTabs(ctx, tabId) {
		if shellRunning(child.BlockIds[0]) {
			return true
		}
	}
	return false
}

// childTabs are the worker tabs whose parent is tabId, each with a block.
func childTabs(ctx context.Context, tabId string) []*waveobj.Tab {
	tabs, err := wstore.DBGetAllObjsByType[*waveobj.Tab](ctx, waveobj.OType_Tab)
	if err != nil {
		logErr("loading tabs: %v", err)
		return nil
	}
	var out []*waveobj.Tab
	for _, tab := range tabs {
		if ParentOf(tab) == tabId && len(tab.BlockIds) > 0 {
			out = append(out, tab)
		}
	}
	return out
}

// agentLive reports whether a parent has an agent to receive a notice: its shell runs and its agent has not quit back
// to a shell, where a typed notice would run as a command.
func agentLive(tabId, blockId string) bool {
	return shellRunning(blockId) && !orchestrate.LatestAgentStatus(blockId, tabId).Ended
}

// resolveAgent is the tab and agent block a status names, by block or by tab; a nil tab when either is gone.
func resolveAgent(ctx context.Context, orefStr string) (*waveobj.Tab, string) {
	oref, err := waveobj.ParseORef(orefStr)
	if err != nil {
		return nil, ""
	}
	switch oref.OType {
	case waveobj.OType_Block:
		tabId, err := wstore.DBFindTabForBlockId(ctx, oref.OID)
		if err != nil {
			return nil, ""
		}
		tab, _ := loadTab(ctx, tabId)
		return tab, oref.OID
	case waveobj.OType_Tab:
		return loadTab(ctx, oref.OID)
	}
	return nil, ""
}

// loadTab is a tab and its agent block, a nil tab when it is gone or has no block.
func loadTab(ctx context.Context, tabId string) (*waveobj.Tab, string) {
	if tabId == "" {
		return nil, ""
	}
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		logErr("loading tab %s: %v", tabId, err)
		return nil, ""
	}
	if tab == nil || len(tab.BlockIds) == 0 {
		return nil, ""
	}
	return tab, tab.BlockIds[0]
}

func setBlockMeta(ctx context.Context, blockId, key string, val any) error {
	_, err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockId), waveobj.MetaMapType{key: val}, false)
	return err
}

func logErr(format string, args ...any) {
	log.Printf("agentworker: "+format+"\n", args...)
}
