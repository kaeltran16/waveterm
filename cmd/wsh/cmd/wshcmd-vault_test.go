// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestFormatVaultStatusOff(t *testing.T) {
	got := formatVaultStatus(&wshrpc.VaultStatusRtnData{Off: wavevault.SyncOffNoRemote}, time.UTC)
	if !strings.Contains(got, "sync is off: no remote") || strings.Contains(got, "last success") {
		t.Fatalf("status:\n%s", got)
	}
}

func TestFormatVaultStatusOn(t *testing.T) {
	ts := time.Date(2026, 10, 1, 14, 3, 22, 0, time.UTC)
	got := formatVaultStatus(&wshrpc.VaultStatusRtnData{
		RemoteURL:        "git@example.com:me/vault.git",
		LastSuccessTs:    ts.UnixMilli(),
		LastError:        "git fetch origin: exit status 128: could not resolve host",
		Conflicts:        []string{"conflicts/memory/a.md"},
		MalformedEfforts: []string{"efforts/x.json"},
	}, time.UTC)
	for _, want := range []string{
		"remote:       git@example.com:me/vault.git\n",
		"last success: 2026-10-01 14:03:22\n",
		"last error:   git fetch origin: exit status 128: could not resolve host\n",
		"conflict copies:\n  conflicts/memory/a.md\n",
		"malformed efforts:\n  efforts/x.json\n",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("status missing %q:\n%s", want, got)
		}
	}
}
