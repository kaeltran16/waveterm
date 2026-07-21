//go:build windows

// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(shellCmd)
}

var shellCmd = &cobra.Command{
	Use:    "shell",
	Hidden: true,
	Short:  "Print the login shell of this user",
	RunE: func(cmd *cobra.Command, args []string) error {
		return fmt.Errorf("wsh shell is not implemented on windows")
	},
}
