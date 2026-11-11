// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"bufio"
	"net"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// the server dropping the connection mid-call must fail the call at once with a lost-connection error,
// not leave it waiting out its timeout (30 days for agentctl, 30 minutes for ask --wait)
func TestClientCallFailsWhenServerDropsConnection(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	rpc, _, err := SetupConnRpcClient(clientConn, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		// take the request, then go away without answering
		bufio.NewReader(serverConn).ReadBytes('\n')
		serverConn.Close()
	}()

	type result struct{ err error }
	done := make(chan result, 1)
	go func() {
		_, err := rpc.SendRpcRequest("test", nil, &wshrpc.RpcOpts{Timeout: 60000})
		done <- result{err}
	}()

	select {
	case r := <-done:
		if r.err == nil {
			t.Fatal("call on a dropped connection returned no error")
		}
		if IsTimeoutErr(r.err) {
			t.Fatalf("call reported a timeout, want a lost connection: %v", r.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("call still waiting 3s after the server dropped the connection")
	}
	if _, err := rpc.SendRpcRequest("test", nil, nil); err == nil {
		t.Fatal("a call after the connection dropped returned no error")
	}
}
