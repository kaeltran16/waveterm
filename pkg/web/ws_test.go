// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
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

// a message written after the last ping's deadline has lapsed must still go out: the ping deadline
// alone used to govern every write, so busy traffic hit spurious i/o timeouts and dropped the socket.
func TestWriteWsMessageIgnoresStalePingDeadline(t *testing.T) {
	serverConnCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		serverConnCh <- conn
	}))
	defer srv.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	server := <-serverConnCh
	defer server.Close()

	_ = server.SetWriteDeadline(time.Now().Add(-time.Second))
	if err := writeWsMessage(server, []byte(`{"type":"x"}`)); err != nil {
		t.Fatalf("write after a lapsed ping deadline failed: %v", err)
	}
	_ = client.SetReadDeadline(time.Now().Add(wsForwardTestTimeout))
	if _, msg, err := client.ReadMessage(); err != nil || string(msg) != `{"type":"x"}` {
		t.Fatalf("client read %q, %v", msg, err)
	}
}
