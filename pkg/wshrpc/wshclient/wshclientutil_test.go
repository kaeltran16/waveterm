// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshclient

import (
	"testing"
)

func TestSendRpcRequestCallHelperNilClient(t *testing.T) {
	_, err := sendRpcRequestCallHelper[string](nil, "test", nil, nil)
	if err == nil {
		t.Fatal("expected error for nil wshrpc client")
	}
	if err.Error() != "nil wshrpc passed to wshclient" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSendRpcRequestResponseStreamHelperNilClient(t *testing.T) {
	ch := sendRpcRequestResponseStreamHelper[string](nil, "test", nil, nil)
	resp, ok := <-ch
	if !ok {
		t.Fatal("expected one error value before channel close")
	}
	if resp.Error == nil {
		t.Fatal("expected error in stream response for nil client")
	}
	if _, open := <-ch; open {
		t.Fatal("expected channel to be closed after the error")
	}
}
