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

// PostOutcome posts a persisted "outcome" message to ch for workerORef, but only if ch actually
// dispatched the worker (a dispatch message references it) and no fresh outcome already exists. Taking a
// single resolved channel (not the full list) is the Phase-2 change; the dispatch-existence gate is kept
// so run workers — which have no dispatch message — still get no outcome. Fire-and-forget by the caller.
func PostOutcome(ch *waveobj.Channel, workerORef, runtime string, data OutcomeData) {
	if ch == nil {
		return
	}
	// preserve old semantics: only workers dispatched via a message earn an outcome
	if ResolveDispatchChannel([]*waveobj.Channel{ch}, workerORef) == nil {
		return
	}
	payload, _ := json.Marshal(data)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage("outcome", runtime, data.Summary, workerORef, time.Now().UnixMilli())
	msg.Data = string(payload)
	// re-check freshness inside the write transaction (against the current persisted channel) so two
	// near-simultaneous worker-exit signals can't both pass the check and double-post the outcome.
	posted, err := wstore.PostChannelMessageIf(ctx, ch.OID, msg, func(fresh *waveobj.Channel) bool {
		return !alreadyHasFreshOutcome(fresh, workerORef)
	})
	if err != nil {
		log.Printf("jarvis: post outcome failed: %v", err)
		return
	}
	if posted {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, ch.OID))
	}
}

// resolveDispatchChannelForWorker loads the worker's dispatching channel via the channeloref stamp,
// falling back to the full dispatch scan on a stamp miss. The PostOutcome dispatch-existence gate still
// applies, so a wrongly-stamped run worker won't get an outcome.
func resolveDispatchChannelForWorker(ctx context.Context, workerORef string) *waveobj.Channel {
	if _, channelORef, err := wstore.GetWorkerOwner(ctx, workerORef); err == nil && channelORef != "" {
		if chRef, perr := waveobj.ParseORef(channelORef); perr == nil {
			if ch, gerr := wstore.DBMustGet[*waveobj.Channel](ctx, chRef.OID); gerr == nil && ch != nil {
				return ch
			}
		}
	}
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil
	}
	return ResolveDispatchChannel(channels, workerORef)
}
