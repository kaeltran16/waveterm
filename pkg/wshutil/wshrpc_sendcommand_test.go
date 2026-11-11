// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
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

// a request racing the input's close passed the server-done check, then sent on the output runServer had just
// closed: the recovered panic returned (nil, nil), and the caller dereferenced the nil handler. A request
// registered after the pending calls were failed would have waited on its response forever.
func TestRequestRacingCloseFailsCleanly(t *testing.T) {
	const rounds, senders = 200, 8
	for range rounds {
		inputCh := make(chan baseds.RpcInputChType)
		outputCh := make(chan []byte, 1)
		w := MakeWshRpcWithChannels(inputCh, outputCh, wshrpc.RpcContext{}, nil, "test")
		go func() {
			for range outputCh {
			}
		}()
		var wg sync.WaitGroup
		start := make(chan struct{})
		for range senders {
			wg.Go(func() {
				<-start
				for {
					h, err := w.SendComplexRequest("test", nil, &wshrpc.RpcOpts{Timeout: 60000})
					if err != nil {
						return
					}
					if h == nil {
						t.Error("SendComplexRequest returned no handler and no error")
						return
					}
					wg.Go(func() {
						got := make(chan error, 1)
						go func() {
							_, err := h.NextResponse()
							got <- err
						}()
						select {
						case err := <-got:
							h.finalize()
							if err == nil {
								t.Error("a call no one answered returned no error")
							}
						case <-time.After(5 * time.Second):
							t.Error("a call sent around the close still waits 5s on")
						}
					})
				}
			})
		}
		close(start)
		time.Sleep(50 * time.Microsecond)
		close(inputCh)
		wg.Wait()
		if t.Failed() {
			return
		}
	}
}
