// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const brainstormTestBlock = "bbbbbbbb-2222-4222-8222-222222222222"

func TestBrainstormCheckCmdSendsBlockAndAbsolutePath(t *testing.T) {
	var got []wshrpc.CommandBrainstormCheckData
	send := func(d wshrpc.CommandBrainstormCheckData) error {
		got = append(got, d)
		return nil
	}
	rel := filepath.Join(".superpowers", "brainstorm", "topic", "brainstorm.json")
	if err := brainstormCheckStart(brainstormTestBlock, rel, send); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("sent %d requests, want 1", len(got))
	}
	if got[0].BlockId != brainstormTestBlock {
		t.Errorf("block = %q, want %q", got[0].BlockId, brainstormTestBlock)
	}
	if !filepath.IsAbs(got[0].File) || !strings.HasSuffix(got[0].File, rel) {
		t.Errorf("file = %q, want the absolute form of %q", got[0].File, rel)
	}
}

func TestBrainstormCheckCmdReturnsTheRpcError(t *testing.T) {
	boom := errors.New("a builder check is already reading this design")
	err := brainstormCheckStart(brainstormTestBlock, "brainstorm.json", func(wshrpc.CommandBrainstormCheckData) error { return boom })
	if !errors.Is(err, boom) {
		t.Errorf("err = %v, want the RPC's error as it came", err)
	}
}

func TestBrainstormCheckCmdRefusesAMissingArgument(t *testing.T) {
	if err := brainstormCheckCmd.Args(brainstormCheckCmd, nil); err == nil {
		t.Error("no argument was accepted")
	}
	if err := brainstormCheckCmd.Args(brainstormCheckCmd, []string{"a.json", "b.json"}); err == nil {
		t.Error("two arguments were accepted")
	}
	sent := false
	err := brainstormCheckStart(brainstormTestBlock, "", func(wshrpc.CommandBrainstormCheckData) error { sent = true; return nil })
	if err == nil || sent {
		t.Errorf("empty path: err = %v, sent = %v; want a refusal before any RPC", err, sent)
	}
}
