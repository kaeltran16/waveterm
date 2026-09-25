// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"
)

type StreamCommands interface {
	StreamDataCommand(ctx context.Context, data CommandStreamData) error
	StreamDataAckCommand(ctx context.Context, data CommandStreamAckData) error
}

type CommandStreamData struct {
	Id     string `json:"id"`  // streamid
	Seq    int64  `json:"seq"` // start offset (bytes)
	Data64 string `json:"data64,omitempty"`
	Eof    bool   `json:"eof,omitempty"`   // can be set with data or without
	Error  string `json:"error,omitempty"` // stream terminated with error
}

type CommandStreamAckData struct {
	Id     string `json:"id"`               // streamid
	Seq    int64  `json:"seq"`              // next expected byte
	RWnd   int64  `json:"rwnd"`             // receive window size
	Fin    bool   `json:"fin,omitempty"`    // observed end-of-stream (eof or error)
	Delay  int64  `json:"delay,omitempty"`  // ack delay in microseconds (from when data was received to when we sent out ack -- monotonic clock)
	Cancel bool   `json:"cancel,omitempty"` // used to cancel the stream
	Error  string `json:"error,omitempty"`  // reason for cancel (may only be set if cancel is true)
}
