// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// the package's test vault (TestMain) has no origin remote, so sync is off
func TestVaultStatusCommandOff(t *testing.T) {
	rtn, err := (&WshServer{}).VaultStatusCommand(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rtn.Off != wavevault.SyncOffNoRemote {
		t.Fatalf("Off = %q, want %q", rtn.Off, wavevault.SyncOffNoRemote)
	}
	if rtn.RemoteURL != "" {
		t.Fatalf("RemoteURL = %q, want empty", rtn.RemoteURL)
	}
}
