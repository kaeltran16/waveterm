// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestViewDataFromArgs(t *testing.T) {
	cases := []struct {
		name    string
		edit    bool
		blockId string
		want    wshrpc.OpenFileData
	}{
		{"names the calling block", false, "blk-1", wshrpc.OpenFileData{Path: "/r/a.md", ORef: "block:blk-1"}},
		{"outside a block names none", false, "", wshrpc.OpenFileData{Path: "/r/a.md"}},
		{"edit carries through", true, "blk-1", wshrpc.OpenFileData{Path: "/r/a.md", Edit: true, ORef: "block:blk-1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := viewDataFromArgs("/r/a.md", tc.edit, tc.blockId); got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}
