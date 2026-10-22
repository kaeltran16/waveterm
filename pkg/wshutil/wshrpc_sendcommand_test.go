// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// Fire-and-forget sends that queue behind a full output channel must all be delivered. Each one used to
// register under the shared empty request id, so one send finishing cancelled another still waiting for
// room, which returned "timeout sending request" and lost its message: the stream-file stall under
// parallel requests.
func TestSendCommandBackedUpOutputDeliversAll(t *testing.T) {
	const sends = 50
	outputCh := make(chan []byte, 1)
	w := MakeWshRpcWithChannels(nil, outputCh, wshrpc.RpcContext{}, nil, "test")

	var delivered atomic.Int32
	go func() {
		for range outputCh {
			delivered.Add(1)
			time.Sleep(time.Millisecond)
		}
	}()

	var wg sync.WaitGroup
	var failed atomic.Int32
	for range sends {
		wg.Go(func() {
			if err := w.SendCommand(wshrpc.Command_StreamData, wshrpc.CommandStreamData{Id: "s"}, nil); err != nil {
				failed.Add(1)
				t.Logf("SendCommand: %v", err)
			}
		})
	}
	wg.Wait()

	if n := failed.Load(); n > 0 {
		t.Fatalf("%d of %d sends failed", n, sends)
	}
	deadline := time.Now().Add(2 * time.Second)
	for delivered.Load() < sends && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := delivered.Load(); n != sends {
		t.Fatalf("delivered %d of %d messages", n, sends)
	}
}
