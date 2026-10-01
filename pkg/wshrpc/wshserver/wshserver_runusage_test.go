// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestRunUsageReturnsTheSealedTotal(t *testing.T) {
	sealed := []waveobj.UsageRow{
		{Role: "lead", Model: "claude-opus-5-5", Input: 10, Output: 20, CacheRead: 300},
		{Role: "worker", TaskId: "t-1", Model: "claude-sonnet-5-5", Input: 1, Output: 2},
	}
	ctx, channelId, runId := seedModelRun(t, func(run *waveobj.Run) {
		run.Evidence = &waveobj.RunEvidence{Usage: sealed}
	})
	rtn, err := (&WshServer{}).RunUsageCommand(ctx, wshrpc.CommandRunUsageData{ChannelId: channelId, RunId: runId})
	if err != nil {
		t.Fatal(err)
	}
	if !rtn.Sealed || !reflect.DeepEqual(rtn.Usage, sealed) {
		t.Fatalf("got sealed=%v usage=%+v, want the evidence's rows sealed", rtn.Sealed, rtn.Usage)
	}
}

// a run with no evidence yet is totalled from its transcripts and stays open to a later read
func TestRunUsageOfAnUnsealedRunIsLive(t *testing.T) {
	ctx, channelId, runId := seedModelRun(t, nil)
	rtn, err := (&WshServer{}).RunUsageCommand(ctx, wshrpc.CommandRunUsageData{ChannelId: channelId, RunId: runId})
	if err != nil {
		t.Fatal(err)
	}
	if rtn.Sealed {
		t.Fatal("an unsealed run's total reported sealed")
	}
}

func TestRunUsageRequiresIds(t *testing.T) {
	ctx, channelId, _ := seedModelRun(t, nil)
	if _, err := (&WshServer{}).RunUsageCommand(ctx, wshrpc.CommandRunUsageData{ChannelId: channelId}); err == nil {
		t.Fatal("want an error without a run id")
	}
}
