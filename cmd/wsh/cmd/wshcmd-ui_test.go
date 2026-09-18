// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"errors"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestFormatUiActions(t *testing.T) {
	got := formatUiActions([]wshrpc.UiAction{
		{Id: "go:vault", Label: "Vault (memory, steering, skills)", Group: "Go to"},
		{Id: "code:save", Label: "Save the open file", Group: "Code", Destructive: true},
	})
	want := "go:vault\tVault (memory, steering, skills)\ncode:save\tSave the open file\tdestructive\n"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if got := formatUiActions(nil); got != "" {
		t.Fatalf("no actions should print nothing, got %q", got)
	}
}

func TestUiErrMapsMissingRoute(t *testing.T) {
	if got := uiErr(errors.New(`no route for "cockpit"`)).Error(); got != "the cockpit is not running" {
		t.Fatalf("got %q", got)
	}
	other := errors.New(`"x" is not an available action on usage right now; see wsh ui actions`)
	if uiErr(other) != other {
		t.Fatalf("other errors must pass through unchanged")
	}
}
