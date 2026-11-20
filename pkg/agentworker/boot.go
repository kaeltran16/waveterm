// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// ResumeWorkersAtBoot settles the workers the previous wavesrv left: no process survived it, so every armed worker is
// disarmed before a block resync can replay its first prompt, and one cut off mid-task (its parent's turn unanswered)
// resumes in its own session with the nudge. A refused resume leaves the worker stopped with its notice owed. Event
// history did not survive either, so each stopped worker is published idle for the roster.
func ResumeWorkersAtBoot(ctx context.Context) {
	tabs, err := wstore.DBGetAllObjsByType[*waveobj.Tab](ctx, waveobj.OType_Tab)
	if err != nil {
		logErr("boot: loading tabs: %v", err)
		return
	}
	for _, tab := range tabs {
		if ParentOf(tab) == "" || len(tab.BlockIds) == 0 {
			continue
		}
		resumeAtBoot(ctx, tab)
	}
}

func resumeAtBoot(ctx context.Context, tab *waveobj.Tab) {
	blockId := tab.BlockIds[0]
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		logErr("boot: loading worker block %s: %v", blockId, err)
		return
	}
	if block.Meta.GetString(waveobj.MetaKey_Controller, "") != "" {
		if err := jarvis.StopRunWorker(ctx, waveobj.MakeORef(waveobj.OType_Tab, tab.OID).String()); err != nil {
			logErr("boot: disarming worker %s: %v", tab.OID, err)
			return
		}
		if block.Meta.GetBool(MetaNoticeOwed, false) {
			err := ResumeWorker(ctx, tab.OID, jarvis.ResumeNudge)
			if err == nil {
				return
			}
			logErr("boot: resuming worker %s: %v", tab.OID, err)
		}
	}
	if err := PublishStatus(ctx, blockId, baseds.AgentState_Idle); err != nil {
		logErr("boot: publishing stopped worker %s: %v", tab.OID, err)
	}
}
