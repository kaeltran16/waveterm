// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package memdistill

import (
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// memoryActivityPersist bounds how much of the recent past a late subscriber can replay. The unattended
// passes ride an hourly ticker, so a handful covers "while you were out" for a session. The buffer lives
// in the broker's memory, so a fresh wavesrv starts empty — this is a replay window, never a durable log.
const memoryActivityPersist = 20

// publishActivitySink is the transport, swappable so tests observe a real announcement rather than a
// stand-in for one. It sits below the stamping in PublishActivity on purpose: identity and time are part
// of the contract every emitter owes its consumer, so they must not be mockable away.
var publishActivitySink = func(ev wps.WaveEvent) { wps.Broker.Publish(ev) }

// PublishActivity announces one finished unattended memory pass. Deliberately scope-less: this is a fact
// about the vault, not about an object, so a consumer subscribes by event name alone and the broker routes
// it through AllSubs. Retained (Persist) so a frontend that connects after the pass can still report it.
// Both the coordinator and the gardener announce through here so their events cannot drift in shape.
func PublishActivity(data baseds.MemoryActivityData) {
	if data.Id == "" {
		data.Id = uuid.NewString()
	}
	if data.Ts == 0 {
		data.Ts = time.Now().UnixMilli()
	}
	publishActivitySink(wps.WaveEvent{
		Event:   wps.Event_MemoryActivity,
		Persist: memoryActivityPersist,
		Data:    data,
	})
}

// SetActivitySinkForTest swaps the broker transport so a test in another package (the gardener's) can
// observe an announcement without a live broker. Returns a restore func the caller defers.
func SetActivitySinkForTest(fn func(wps.WaveEvent)) (restore func()) {
	prev := publishActivitySink
	publishActivitySink = fn
	return func() { publishActivitySink = prev }
}
