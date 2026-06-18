// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var askClear bool

var askCmd = &cobra.Command{
	Use:                   "ask",
	Short:                 "project an AskUserQuestion into the Wave Agents panel (non-blocking)",
	Args:                  cobra.NoArgs,
	RunE:                  askRun,
	PreRunE:               preRunSetupRpcClient,
	Hidden:                true,
	DisableFlagsInUseLine: true,
}

func init() {
	askCmd.Flags().BoolVar(&askClear, "clear", false, "clear the pending ask for this block (PostToolUse)")
	rootCmd.AddCommand(askCmd)
}

// any error returned here exits non-zero; the hooks treat non-zero / failure as
// "the native terminal prompt handles it" (graceful degradation).
func askRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("ask", rtnErr == nil)
	}()

	oref, err := resolveBlockArg()
	if err != nil {
		return fmt.Errorf("resolving block: %w", err)
	}

	if askClear {
		return wshclient.AgentAskClearCommand(RpcClient, oref.String(), &wshrpc.RpcOpts{Timeout: 5000})
	}

	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return fmt.Errorf("reading stdin: %w", err)
	}

	var in struct {
		Questions []struct {
			Question    string `json:"question"`
			Header      string `json:"header"`
			MultiSelect bool   `json:"multiSelect"`
			Options     []struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return fmt.Errorf("no questions on stdin: %w", err)
	}
	if len(in.Questions) == 0 {
		return fmt.Errorf("no questions provided")
	}

	questions := make([]baseds.AgentAskQuestion, len(in.Questions))
	for i, q := range in.Questions {
		opts := make([]baseds.AgentAskOption, len(q.Options))
		for j, o := range q.Options {
			opts[j] = baseds.AgentAskOption{Label: o.Label, Description: o.Description}
		}
		questions[i] = baseds.AgentAskQuestion{
			Question:    q.Question,
			Header:      q.Header,
			MultiSelect: q.MultiSelect,
			Options:     opts,
		}
	}

	_, err = wshclient.AskCommand(RpcClient, wshrpc.CommandAskData{ORef: oref.String(), Questions: questions}, &wshrpc.RpcOpts{Timeout: 5000})
	return err
}
