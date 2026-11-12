// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
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

// a cancelled request never sends a final response, so forwarding the cancel is the router's last sight
// of it: the routing entry must go then, or every cancelled stream leaks one for the server's lifetime
func TestCancelDropsTheRoutingEntry(t *testing.T) {
	router, leaf, callerLink := routeRequest(t, "r1")

	cancel, _ := json.Marshal(RpcMessage{Cancel: true, ReqId: "r1"})
	router.inputCh <- baseds.RpcInputChType{MsgBytes: cancel, IngressLinkId: callerLink}

	waitUntil(t, "the cancel to reach the handler", func() bool { return leafGotCancel(leaf, "r1") })
	waitUntil(t, "r1's routing entry to go", func() bool { return !hasRouteInfo(router, "r1") })
}

// pkg/web called the main rpc's own per-link reap after UnregisterLink; the router's cancel reaches a real rpc
// server's handler on its own, so that second call was redundant
func TestUnregisterLinkCancelsTheHandlerContext(t *testing.T) {
	router := NewWshRouter()
	server := MakeWshRpc(wshrpc.RpcContext{}, nil, "test")
	if _, err := router.RegisterTrustedLeaf(server, DefaultRoute); err != nil {
		t.Fatal(err)
	}
	callerLink := router.RegisterTrustedRouter(newGatedClient(t))
	h, ctx := mkHandler(server, "r1", callerLink)
	server.Lock.Lock()
	server.ResponseHandlerMap["r1"] = h
	server.Lock.Unlock()
	router.registerRouteInfo("r1", callerLink, DefaultRoute, baseds.NoLinkId, 0)

	router.UnregisterLink(callerLink)

	select {
	case <-ctx.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("the gone link's handler context was not cancelled")
	}
}

// backend F2: a request whose destination link goes away before it answers can never get a reply: its routing
// entry must go, and the caller must be told now rather than wait out its timeout
func TestUnregisterLinkAnswersRequestsItWasHandling(t *testing.T) {
	router := NewWshRouter()
	leaf := newGatedClient(t)
	leaf.setBudget(-1)
	leafLink, err := router.RegisterTrustedLeaf(leaf, DefaultRoute)
	if err != nil {
		t.Fatal(err)
	}
	caller := newGatedClient(t)
	caller.setBudget(-1)
	callerLink := router.RegisterTrustedRouter(caller)
	cmd, _ := json.Marshal(RpcMessage{Command: "test", ReqId: "r1", Route: DefaultRoute})
	router.inputCh <- baseds.RpcInputChType{MsgBytes: cmd, IngressLinkId: callerLink}
	waitUntil(t, "the leaf to receive the request", func() bool { return len(leaf.received()) == 1 })
	waitUntil(t, "r1's routing entry", func() bool { return hasRouteInfo(router, "r1") })

	router.UnregisterLink(leafLink)

	if hasRouteInfo(router, "r1") {
		t.Fatal("the request kept its routing entry after its destination went away")
	}
	waitUntil(t, "an error reply for r1 at the caller", func() bool {
		for _, raw := range caller.received() {
			var msg RpcMessage
			if json.Unmarshal([]byte(raw), &msg) == nil && msg.ResId == "r1" && msg.Error != "" {
				return true
			}
		}
		return false
	})
}

// a destination that stays connected but never answers: once the request's own timeout passes, its caller
// has given up, so the router drops the entry; a request with no timeout (a frontend stream) keeps it
func TestRoutingEntryEndsWithItsRequestTimeout(t *testing.T) {
	router := NewWshRouter()
	leaf := newGatedClient(t)
	leaf.setBudget(-1)
	if _, err := router.RegisterTrustedLeaf(leaf, DefaultRoute); err != nil {
		t.Fatal(err)
	}
	callerLink := router.RegisterTrustedRouter(newGatedClient(t))
	for _, req := range []RpcMessage{
		{Command: "test", ReqId: "bounded", Route: DefaultRoute, Timeout: 50},
		{Command: "test", ReqId: "unbounded", Route: DefaultRoute},
	} {
		cmd, _ := json.Marshal(req)
		router.inputCh <- baseds.RpcInputChType{MsgBytes: cmd, IngressLinkId: callerLink}
	}
	waitUntil(t, "the leaf to receive both requests", func() bool { return len(leaf.received()) == 2 })
	waitUntil(t, "the timed-out request's entry to go", func() bool { return !hasRouteInfo(router, "bounded") })
	if !hasRouteInfo(router, "unbounded") {
		t.Fatal("a request with no timeout lost its routing entry")
	}
}
