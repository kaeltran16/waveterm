// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

const wsForwardTestTimeout = time.Second

func waitForForwarder(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(wsForwardTestTimeout):
		t.Fatal("RPC forwarder did not stop")
	}
}

func TestForwardRpcMessagesForwardsNormally(t *testing.T) {
	toRemoteCh := make(chan []byte)
	outputCh := make(chan any)
	closeCh := make(chan any)
	done := make(chan struct{})
	go func() {
		forwardRpcMessages(toRemoteCh, outputCh, closeCh)
		close(done)
	}()

	message := []byte(`{"command":"test"}`)
	go func() { toRemoteCh <- message }()

	select {
	case output := <-outputCh:
		rpcMessage, ok := output.(map[string]any)
		if !ok {
			t.Fatalf("output type = %T, want map[string]any", output)
		}
		if rpcMessage["eventtype"] != "rpc" {
			t.Fatalf("eventtype = %v, want rpc", rpcMessage["eventtype"])
		}
		data, ok := rpcMessage["data"].(json.RawMessage)
		if !ok {
			t.Fatalf("data type = %T, want json.RawMessage", rpcMessage["data"])
		}
		if !bytes.Equal(data, message) {
			t.Fatalf("data = %s, want %s", data, message)
		}
	case <-time.After(wsForwardTestTimeout):
		t.Fatal("timed out waiting for forwarded RPC message")
	}

	close(toRemoteCh)
	waitForForwarder(t, done)
}

func TestForwardRpcMessagesStopsWhenOutputIsFull(t *testing.T) {
	toRemoteCh := make(chan []byte)
	outputCh := make(chan any, 1)
	outputCh <- "occupied"
	closeCh := make(chan any)
	done := make(chan struct{})
	go func() {
		forwardRpcMessages(toRemoteCh, outputCh, closeCh)
		close(done)
	}()

	sent := make(chan struct{})
	go func() {
		toRemoteCh <- []byte(`{"command":"blocked"}`)
		close(sent)
	}()
	select {
	case <-sent:
	case <-time.After(wsForwardTestTimeout):
		t.Fatal("forwarder did not receive RPC message")
	}

	close(closeCh)
	waitForForwarder(t, done)
}
