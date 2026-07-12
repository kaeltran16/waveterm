// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// OutcomeData is the structured payload of a channel "outcome" message (JSON in ChannelMessage.Data).
// The FE styles the status pill off Status.
type OutcomeData struct {
	Status     string `json:"status"`     // "done" | "failed" | "waiting"
	Summary    string `json:"summary"`    // short transcript-derived "what came of it" line
	DurationMs int64  `json:"durationMs"` // wall time from the transcript
	ExitCode   int    `json:"exitCode"`   // process exit code (recorded, not the status source)
}

// OutcomeStatus maps an agentsessions status to the persisted pill status. Unknown/empty -> "done"
// (a session with no error/ask marker completed a turn cleanly).
func OutcomeStatus(sessionStatus string) string {
	switch sessionStatus {
	case "failed":
		return "failed"
	case "waiting":
		return "waiting"
	default:
		return "done"
	}
}

// alreadyHasFreshOutcome reports whether an outcome message for workerORef is newer-or-equal to the
// worker's latest dispatch/directive — meaning a re-post would be a duplicate. A later re-dispatch
// (newer ts) makes it stale again, so the worker can earn a fresh outcome. Pure.
func alreadyHasFreshOutcome(ch *waveobj.Channel, workerORef string) bool {
	var latestDispatch, latestOutcome int64
	for _, m := range ch.Messages {
		if m.RefORef != workerORef {
			continue
		}
		switch m.Kind {
		case "dispatch", "directive":
			if m.Ts > latestDispatch {
				latestDispatch = m.Ts
			}
		case "outcome":
			if m.Ts > latestOutcome {
				latestOutcome = m.Ts
			}
		}
	}
	return latestOutcome >= latestDispatch && latestOutcome > 0
}

// PostOutcome resolves the dispatching channel for workerORef and posts a persisted "outcome" message,
// unless there is no owning channel or a fresh outcome already exists. Fire-and-forget by the caller.
func PostOutcome(channels []*waveobj.Channel, workerORef, runtime string, data OutcomeData) {
	ch := ResolveDispatchChannel(channels, workerORef)
	if ch == nil || alreadyHasFreshOutcome(ch, workerORef) {
		return
	}
	payload, _ := json.Marshal(data)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage("outcome", runtime, data.Summary, workerORef, time.Now().UnixMilli())
	msg.Data = string(payload)
	if _, err := wstore.PostChannelMessage(ctx, ch.OID, msg); err != nil {
		log.Printf("jarvis: post outcome failed: %v", err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, ch.OID))
}
