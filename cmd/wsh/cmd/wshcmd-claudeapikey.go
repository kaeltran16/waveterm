// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/secretstore"
)

var claudeApiKeyConfigDir string

// Claude Code's apiKeyHelper runs this to read the saved key. No PreRunE: it must work with wavesrv down,
// so it reads secrets.enc itself instead of opening an RPC connection.
var claudeApiKeyCmd = &cobra.Command{
	Use:                   jarvis.ClaudeApiKeyHelperCmd,
	Short:                 "Print the saved Claude API key (run by Claude Code's apiKeyHelper)",
	Args:                  cobra.NoArgs,
	Hidden:                true,
	DisableFlagsInUseLine: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return claudeApiKeyRun(claudeApiKeyConfigDir, cmd.OutOrStdout())
	},
}

func init() {
	rootCmd.AddCommand(claudeApiKeyCmd)
	claudeApiKeyCmd.Flags().StringVar(&claudeApiKeyConfigDir, "config-dir", "", "the Arc config dir holding secrets.enc")
}

func claudeApiKeyRun(configDir string, out io.Writer) error {
	if configDir == "" {
		return fmt.Errorf("claude-api-key needs --config-dir")
	}
	key, ok, err := secretstore.ReadSecretFile(configDir, jarvis.ClaudeApiKeySecretName)
	if err != nil {
		return err
	}
	if !ok || key == "" {
		return fmt.Errorf("no Claude API key is saved in Arc (%s); save one in Settings > Claude account, or switch back to a Claude.ai account", configDir)
	}
	_, err = io.WriteString(out, key)
	return err
}
