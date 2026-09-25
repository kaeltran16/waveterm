// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// A connection that dies without anyone calling UnregisterLink (handleDomainSocketClient's teardown
// could miss its link id) left a registered link whose ToRemoteCh was closed. One reply routed to it
// panicked, went to the backlog, and processBacklog retried it every 50ms for the server's lifetime:
// ~20 panics/s, each a stack dump plus a telemetry row (seen in prod as 1M+ debug:panic a day).
func TestDeadLinkIsNotRetriedForever(t *testing.T) {
	var panics atomic.Int64
	prev := panichandler.PanicTelemetryHandler
	panichandler.PanicTelemetryHandler = func(string) { panics.Add(1) }
	defer func() { panichandler.PanicTelemetryHandler = prev }()

	router := NewWshRouter()
	proxy := MakeRpcProxy("test")
	linkId := router.RegisterUntrustedLink(proxy)

	// the connection goes away, but its teardown never unregisters the link
	close(proxy.FromRemoteCh)
	close(proxy.ToRemoteCh)
	// a reply addressed to the dead link arrives afterwards
	router.sendMessageToLink([]byte(`{"resid":"r1"}`), linkId, baseds.NoLinkId)

	// a retry or two can land before the link's recv loop sees EOF; what matters is that they stop
	deadline := time.Now().Add(time.Second)
	for router.getLinkMeta(linkId) != nil {
		if time.Now().After(deadline) {
			t.Fatalf("link whose input closed is still registered after 1s (%d panics so far)", panics.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
	settled := panics.Load()
	time.Sleep(300 * time.Millisecond) // six backlog rounds
	if n := panics.Load(); n != settled {
		t.Fatalf("panics kept coming after the link was unregistered: %d -> %d", settled, n)
	}
	router.lock.Lock()
	backlog := len(router.linkMsgBacklog[linkId])
	router.lock.Unlock()
	if backlog != 0 {
		t.Fatalf("dead link still holds %d backlogged messages", backlog)
	}
}
