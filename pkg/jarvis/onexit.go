// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func init() {
	blockcontroller.AgentOutcomeHook = OnWorkerExit
}

// OnWorkerExit posts a channel "outcome" message when a dispatched agent worker's process exits: it
// reads the transcript path stamped on the block by the hook, derives status+summary from the
// transcript (agentsessions), and posts to the dispatching channel (PostOutcome). No-op for a
// non-agent block, a block with no stamped transcript, or a worker no channel dispatched.
// Fire-and-forget; injected into blockcontroller.AgentOutcomeHook at init to avoid an import cycle.
func OnWorkerExit(blockId string, exitCode int) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	blockData, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return
	}
	tpath := blockData.Meta.GetString(waveobj.MetaKey_AgentTranscriptPath, "")
	if tpath == "" {
		return // no transcript stamped (non-agent, or hook never fired) — normal, skip
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return
	}
	runtime := tab.Meta.GetString("session:agent", "")
	if runtime == "" {
		return // not an agent session
	}
	sess, err := agentsessions.ExtractSession(tpath, runtime)
	if err != nil || sess == nil {
		return
	}
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return
	}
	workerORef := waveobj.MakeORef(waveobj.OType_Tab, tabId).String()
	PostOutcome(channels, workerORef, runtime, OutcomeData{
		Status:     OutcomeStatus(sess.Status),
		Summary:    outcomeSummary(sess),
		DurationMs: sess.DurationMs,
		ExitCode:   exitCode,
	})
}

// outcomeSummary picks a short "what came of it" line from a session: the last event's text (the
// events list ends with a "finished" entry for a done session), falling back to the task, trimmed.
func outcomeSummary(sess *agentsessions.SessionInfo) string {
	text := sess.Task
	if n := len(sess.Events); n > 0 && sess.Events[n-1].Text != "" {
		text = sess.Events[n-1].Text
	}
	const maxLen = 160
	if len(text) > maxLen {
		text = text[:maxLen]
	}
	return text
}
