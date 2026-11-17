// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const agentQueueTestBlockId = "9d5b6c1e-3a1f-4a53-8a86-0c1d6a1f0a11"

func TestReadAgentQueueReportParsesTheHeldLeftAndTakeBack(t *testing.T) {
	body := `{"held":[{"id":"q1","text":"and the tests","ts":1700000000000}],"left":[{"id":"q0","how":"joined"}],"takeback":"r1"}`
	report, err := readAgentQueueReport(strings.NewReader(body))
	if err != nil {
		t.Fatalf("a valid report was refused: %v", err)
	}
	if len(report.Held) != 1 || report.Held[0].Id != "q1" || report.Held[0].Text != "and the tests" || report.Held[0].Ts != 1700000000000 {
		t.Fatalf("held: got %+v", report.Held)
	}
	if len(report.Left) != 1 || report.Left[0].Id != "q0" || report.Left[0].How != "joined" {
		t.Fatalf("left: got %+v", report.Left)
	}
	if report.TakeBack != "r1" {
		t.Fatalf("takeback: got %q", report.TakeBack)
	}
}

func TestReadAgentQueueReportNamesTheParseError(t *testing.T) {
	_, err := readAgentQueueReport(strings.NewReader(`{"held":[`))
	if err == nil || !strings.Contains(err.Error(), "not a JSON queue report") {
		t.Fatalf("got %v", err)
	}
}

func TestReadAgentQueueReportRefusesAnOversizedBody(t *testing.T) {
	_, err := readAgentQueueReport(strings.NewReader(strings.Repeat(" ", agentQueueMaxStdinBytes+1)))
	if err == nil || !strings.Contains(err.Error(), "over") {
		t.Fatalf("got %v", err)
	}
}

// runAgentQueueSet runs agentQueueSet on a goroutine so the test can read its request and answer it.
func runAgentQueueSet(body, blockId string) chan error {
	done := make(chan error, 1)
	go func() { done <- agentQueueSet(strings.NewReader(body), blockId) }()
	return done
}

func readAgentQueueRequest(t *testing.T, outputCh chan []byte) wshutil.RpcMessage {
	t.Helper()
	select {
	case msg := <-outputCh:
		var req wshutil.RpcMessage
		if err := json.Unmarshal(msg, &req); err != nil {
			t.Fatalf("request is not an rpc message: %v", err)
		}
		return req
	case <-time.After(2 * time.Second):
		t.Fatal("no request was sent")
	}
	return wshutil.RpcMessage{}
}

func answerAgentQueueRequest(t *testing.T, inputCh chan baseds.RpcInputChType, resp wshutil.RpcMessage) {
	t.Helper()
	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	inputCh <- baseds.RpcInputChType{MsgBytes: b}
}

func waitAgentQueueSet(t *testing.T, done chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("agentQueueSet did not return after the server replied")
	}
	return nil
}

func TestAgentQueueSetSendsTheReportForItsBlock(t *testing.T) {
	inputCh, outputCh := fakeRpc(t)
	body := `{"held":[{"id":"q1","text":"and the tests","ts":1700000000000}],"left":[{"id":"q0","how":"takenback"}],"takeback":"r1"}`
	done := runAgentQueueSet(body, agentQueueTestBlockId)

	req := readAgentQueueRequest(t, outputCh)
	if req.Command != "setagentqueue" {
		t.Fatalf("command = %q, want setagentqueue", req.Command)
	}
	var data wshrpc.CommandSetAgentQueueData
	raw, _ := json.Marshal(req.Data)
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatalf("data is not a queue report: %v", err)
	}
	if data.BlockId != agentQueueTestBlockId {
		t.Fatalf("blockid = %q, want %s", data.BlockId, agentQueueTestBlockId)
	}
	if len(data.Held) != 1 || data.Held[0] != (baseds.QueuedPrompt{Id: "q1", Text: "and the tests", Ts: 1700000000000}) {
		t.Fatalf("held: got %+v", data.Held)
	}
	if len(data.Left) != 1 || data.Left[0] != (wshrpc.QueueLeft{Id: "q0", How: "takenback"}) {
		t.Fatalf("left: got %+v", data.Left)
	}
	if data.TakeBack != "r1" {
		t.Fatalf("takeback: got %q", data.TakeBack)
	}

	answerAgentQueueRequest(t, inputCh, wshutil.RpcMessage{ResId: req.ReqId})
	if err := waitAgentQueueSet(t, done); err != nil {
		t.Fatalf("an accepted report failed: %v", err)
	}
}

func TestAgentQueueSetFailsWithTheServersError(t *testing.T) {
	inputCh, outputCh := fakeRpc(t)
	done := runAgentQueueSet(`{"held":[]}`, agentQueueTestBlockId)

	req := readAgentQueueRequest(t, outputCh)
	answerAgentQueueRequest(t, inputCh, wshutil.RpcMessage{ResId: req.ReqId, Error: "no such agent block"})

	err := waitAgentQueueSet(t, done)
	if err == nil || !strings.Contains(err.Error(), "no such agent block") || !strings.Contains(err.Error(), agentQueueTestBlockId) {
		t.Fatalf("want the server's error naming the block, got %v", err)
	}
}

func TestAgentQueueSetBadJSONSendsNothing(t *testing.T) {
	_, outputCh := fakeRpc(t)

	err := agentQueueSet(strings.NewReader(`{"held":[`), agentQueueTestBlockId)
	if err == nil || !strings.Contains(err.Error(), "not a JSON queue report") {
		t.Fatalf("got %v", err)
	}
	select {
	case msg := <-outputCh:
		t.Fatalf("a bad report must not reach the server, sent %s", msg)
	default:
	}
}

func TestAgentQueueSetWithoutABlockSendsNothing(t *testing.T) {
	_, outputCh := fakeRpc(t)

	err := agentQueueSet(strings.NewReader(`{"held":[]}`), "")
	if err == nil || !strings.Contains(err.Error(), "needs a block") {
		t.Fatalf("got %v", err)
	}
	select {
	case msg := <-outputCh:
		t.Fatalf("no block, yet a request went out: %s", msg)
	default:
	}
}
