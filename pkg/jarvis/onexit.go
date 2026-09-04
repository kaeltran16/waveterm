// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func init() {
	blockcontroller.AgentOutcomeHook = OnWorkerExit
}

func notifyChildOutcome(ctx context.Context, workerORef string, data OutcomeData) {
	if ChildOutcomeHook == nil {
		return
	}
	if err := ChildOutcomeHook(ctx, workerORef, data); err != nil {
		log.Printf("jarvis child outcome for %s: %v", workerORef, err)
	}
}

// OnWorkerExit posts a channel "outcome" message when a dispatched agent worker's process exits: it
// reads the transcript path stamped on the block by the hook, derives status+summary from the
// transcript (agentsessions), and posts to the dispatching channel (PostOutcome). No-op for a
// non-agent block or a block with no stamped transcript; every other failure logs — a silent exit
// is indistinguishable from "worker produced nothing".
// Fire-and-forget; injected into blockcontroller.AgentOutcomeHook at init to avoid an import cycle.
func OnWorkerExit(blockId string, exitCode int) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	blockData, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		log.Printf("jarvis onexit: block %s unreadable: %v", blockId, err)
		return
	}
	tpath := blockData.Meta.GetString(waveobj.MetaKey_AgentTranscriptPath, "")
	if !reportableExit(tpath, exitCode) {
		return
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		log.Printf("jarvis onexit: tab lookup for block %s failed: %v", blockId, err)
		return
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		log.Printf("jarvis onexit: tab %s unreadable: %v", tabId, err)
		return
	}
	runtime := tab.Meta.GetString("session:agent", "")
	if runtime == "" {
		return // not an agent session
	}
	data, ok := exitOutcome(tpath, runtime, exitCode)
	if !ok {
		return
	}
	workerORef := waveobj.MakeORef(waveobj.OType_Tab, tabId).String()
	notifyChildOutcome(ctx, workerORef, data)
	ch := resolveDispatchChannelForWorker(ctx, workerORef)
	if ch == nil {
		log.Printf("jarvis onexit: no dispatch channel for worker %s; outcome not posted", workerORef)
		return
	}
	PostOutcome(ch, workerORef, runtime, data)
}

// reportableExit reports whether an exited worker's outcome is worth resolving at all. A clean exit
// that stamped no transcript is a runtime whose reporter hook is not installed — the documented
// normal case, and by far the most common — so it is taken before the tab lookup and stays silent.
func reportableExit(tpath string, exitCode int) bool {
	return tpath != "" || exitCode != 0
}

// exitOutcome derives the outcome of an exited agent worker, and whether there is one to report.
// The transcript is the normal source. An agent that exited NON-ZERO having never stamped one is the
// case no watcher can see: it died before its first token (rejected model, missing entitlement, auth
// failure), so liveness has no mtime to age and the work reads healthy until the stall threshold
// expires. A clean exit with no transcript is left alone as before — that is a runtime whose reporter
// hook is not installed, not a failure.
func exitOutcome(tpath, runtime string, exitCode int) (OutcomeData, bool) {
	if !reportableExit(tpath, exitCode) {
		return OutcomeData{}, false
	}
	if tpath == "" {
		return OutcomeData{
			Status:       "failed",
			Summary:      fmt.Sprintf("exited with code %d before writing a transcript — the agent died before its first token", exitCode),
			ExitCode:     exitCode,
			NoTranscript: true,
		}, true
	}
	sess, err := agentsessions.ExtractSession(tpath, runtime)
	if err != nil || sess == nil {
		log.Printf("jarvis onexit: transcript %s parse failed: %v", tpath, err)
		return OutcomeData{}, false
	}
	return OutcomeData{
		Status:     OutcomeStatus(sess.Status),
		Summary:    outcomeSummary(sess),
		DurationMs: sess.DurationMs,
		ExitCode:   exitCode,
	}, true
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
