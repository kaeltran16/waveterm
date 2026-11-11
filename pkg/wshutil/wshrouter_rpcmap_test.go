// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// routeRequest sends a command from a fresh caller link to a leaf bound to DefaultRoute and waits until
// the leaf has it, so the router holds the request's routing entry.
func routeRequest(t *testing.T, reqId string) (*WshRouter, *gatedClient, baseds.LinkId) {
	t.Helper()
	router := NewWshRouter()
	leaf := newGatedClient(t)
	leaf.setBudget(-1)
	if _, err := router.RegisterTrustedLeaf(leaf, DefaultRoute); err != nil {
		t.Fatal(err)
	}
	callerLink := router.RegisterTrustedRouter(newGatedClient(t))
	cmd, _ := json.Marshal(RpcMessage{Command: "test", ReqId: reqId, Route: DefaultRoute})
	router.inputCh <- baseds.RpcInputChType{MsgBytes: cmd, IngressLinkId: callerLink}
	waitUntil(t, "the leaf to receive the request", func() bool { return len(leaf.received()) == 1 })
	return router, leaf, callerLink
}

func leafGotCancel(leaf *gatedClient, reqId string) bool {
	for _, raw := range leaf.received() {
		var msg RpcMessage
		if json.Unmarshal([]byte(raw), &msg) == nil && msg.Cancel && msg.ReqId == reqId {
			return true
		}
	}
	return false
}

func hasRouteInfo(router *WshRouter, reqId string) bool {
	return router.getRouteInfo(reqId) != nil
}

// a link that goes away can never receive its replies: its in-flight requests must be cancelled at the
// handler (else an agentctl stream keeps its 30-day handler and wakes go to a dead process) and their
// routing entries dropped
func TestUnregisterLinkCancelsItsInFlightRequests(t *testing.T) {
	router, leaf, callerLink := routeRequest(t, "r1")

	router.UnregisterLink(callerLink)

	waitUntil(t, "a cancel for r1 at the handler", func() bool { return leafGotCancel(leaf, "r1") })
	if hasRouteInfo(router, "r1") {
		t.Fatal("the gone link's request kept its routing entry")
	}
}
