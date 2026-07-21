// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import "testing"

func TestJarvisRunSubcommandRegistered(t *testing.T) {
	var found bool
	for _, c := range jarvisCmd.Commands() {
		if c.Name() == "run" {
			found = true
		}
	}
	if !found {
		t.Fatal("`jarvis run` subcommand is not registered")
	}
}
