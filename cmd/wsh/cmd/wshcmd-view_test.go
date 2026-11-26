// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"path/filepath"
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

func TestCheckViewPath(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.md")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "gone.md")
	cases := []struct {
		name    string
		path    string
		edit    bool
		wantErr bool
	}{
		{"view an existing file", file, false, false},
		{"view a directory", dir, false, false},
		{"view a missing file", missing, false, true},
		{"edit a new file in an existing folder", missing, true, false},
		{"edit in a missing folder", filepath.Join(dir, "no", "b.md"), true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := checkViewPath(tc.path, tc.edit); (err != nil) != tc.wantErr {
				t.Fatalf("checkViewPath(%q, %v) = %v, want error %v", tc.path, tc.edit, err, tc.wantErr)
			}
		})
	}
}
