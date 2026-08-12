// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestValidateNotifyData(t *testing.T) {
	if err := validateNotifyData(wshrpc.NotifyCommandData{Title: "hi"}); err != nil {
		t.Fatalf("valid notify rejected: %v", err)
	}
	for _, tc := range []struct {
		name string
		data wshrpc.NotifyCommandData
		want string
	}{
		{"empty title", wshrpc.NotifyCommandData{}, "title is required"},
		{"bad level", wshrpc.NotifyCommandData{Title: "hi", Level: "loud"}, "invalid notify level"},
	} {
		if err := validateNotifyData(tc.data); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want error containing %q", tc.name, err, tc.want)
		}
	}
}

func TestValidatePiControlData(t *testing.T) {
	if err := validatePiControlData(wshrpc.PiControlCommandData{SessionId: "s1", Command: "steer"}); err != nil {
		t.Fatalf("valid control rejected: %v", err)
	}
	for _, tc := range []struct {
		name string
		data wshrpc.PiControlCommandData
		want string
	}{
		{"empty session", wshrpc.PiControlCommandData{Command: "steer"}, "sessionid"},
		{"unknown command", wshrpc.PiControlCommandData{SessionId: "s1", Command: "moo"}, "unknown command"},
	} {
		if err := validatePiControlData(tc.data); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want error containing %q", tc.name, err, tc.want)
		}
	}
}

func TestWriteControlFileAtomic(t *testing.T) {
	dir := t.TempDir()
	data := wshrpc.PiControlCommandData{SessionId: "sess-1", Command: "steer", Content: "look at this"}
	if err := writeControlFile(dir, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	path := filepath.Join(dir, "sess-1.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading control file: %v", err)
	}
	var got struct {
		Cmd     string `json:"cmd"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Cmd != "steer" || got.Content != "look at this" {
		t.Fatalf("got %+v, want cmd=steer content='look at this'", got)
	}
	// overwrite is atomic: no *.tmp leftovers, second write replaces
	if err := writeControlFile(dir, wshrpc.PiControlCommandData{SessionId: "sess-1", Command: "abort"}); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	raw2, _ := os.ReadFile(path)
	if !strings.Contains(string(raw2), `"cmd":"abort"`) {
		t.Fatalf("rewrite did not replace: %s", string(raw2))
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected exactly one file, got %d (%v)", len(entries), entries)
	}
}
