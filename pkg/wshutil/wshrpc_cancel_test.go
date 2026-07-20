// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

func mkHandler(w *WshRpc, reqId string, link baseds.LinkId) (*RpcResponseHandler, context.Context) {
	ctx, cancel := context.WithCancel(context.Background())
	h := &RpcResponseHandler{
		w:               w,
		ctx:             ctx,
		reqId:           reqId,
		ingressLinkId:   link,
		done:            &atomic.Bool{},
		canceled:        &atomic.Bool{},
		contextCancelFn: &atomic.Pointer[context.CancelFunc]{},
	}
	cf := context.CancelFunc(cancel)
	h.contextCancelFn.Store(&cf)
	return h, ctx
}

// A client-issued cancel (msg.Cancel -> cancelRequest) must cancel the handler's context, not just
// flip the canceled bool — that is what lets a streaming handler's goroutine + fsnotify watcher unwind
// while the websocket is still up (the per-card-unmount leak). Mirrors the ctx-cancel guarantee that
// CancelRequestsForLink gives on link teardown.
func TestCancelRequestCancelsContext(t *testing.T) {
	w := &WshRpc{Lock: &sync.Mutex{}, ResponseHandlerMap: map[string]*RpcResponseHandler{}}
	h, ctx := mkHandler(w, "r1", baseds.LinkId(1))
	w.ResponseHandlerMap["r1"] = h

	w.cancelRequest("r1")

	select {
	case <-ctx.Done():
	default:
		t.Fatal("expected cancelRequest to cancel the handler ctx")
	}
	if !h.canceled.Load() {
		t.Fatal("expected canceled flag to be set")
	}
	if !h.done.Load() {
		t.Fatal("expected handler done after cancel")
	}
}

// cancelRequest must be a no-op (never panic) for an empty or unknown reqId.
func TestCancelRequestUnknown(t *testing.T) {
	w := &WshRpc{Lock: &sync.Mutex{}, ResponseHandlerMap: map[string]*RpcResponseHandler{}}
	w.cancelRequest("")
	w.cancelRequest("does-not-exist")
}

func TestCancelRequestsForLink(t *testing.T) {
	w := &WshRpc{Lock: &sync.Mutex{}, ResponseHandlerMap: map[string]*RpcResponseHandler{}}
	hA, ctxA := mkHandler(w, "rA", baseds.LinkId(1))
	hB, ctxB := mkHandler(w, "rB", baseds.LinkId(2))
	w.ResponseHandlerMap["rA"] = hA
	w.ResponseHandlerMap["rB"] = hB

	w.CancelRequestsForLink(baseds.LinkId(1))

	select {
	case <-ctxA.Done():
	default:
		t.Fatal("expected L1 handler ctx to be cancelled")
	}
	select {
	case <-ctxB.Done():
		t.Fatal("L2 handler ctx should NOT be cancelled")
	default:
	}
	if !hA.done.Load() {
		t.Fatal("expected L1 handler done")
	}
}
