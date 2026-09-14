// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
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
