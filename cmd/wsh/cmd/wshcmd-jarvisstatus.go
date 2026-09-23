// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var jarvisStatusCmd = &cobra.Command{
	Use:     "status",
	Short:   "capture accounting: vault note counts, distill queue",
	Args:    cobra.NoArgs,
	RunE:    jarvisStatusRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	jarvisCmd.AddCommand(jarvisStatusCmd)
}

func jarvisStatusRun(cmd *cobra.Command, args []string) error {
	rtn, err := wshclient.JarvisStatusCommand(RpcClient, wshrpc.CommandJarvisStatusData{}, nil)
	if err != nil {
		return err
	}
	fmt.Println(renderCaptureStatus(rtn.Status))
	return nil
}

// renderCaptureStatus formats the capture accounting. Every section degrades to "unavailable"
// rather than failing the command — "did it skip my session?" must be answerable, not crashable.
func renderCaptureStatus(st wshrpc.CaptureStatus) string {
	var b strings.Builder
	b.WriteString("vault notes:\n")
	if len(st.NoteCounts) == 0 {
		b.WriteString("  unavailable\n")
	} else {
		for _, coll := range []string{"memory", "tasks", "decisions"} {
			fmt.Fprintf(&b, "  %-10s %d\n", coll, st.NoteCounts[coll])
		}
	}
	fmt.Fprintf(&b, "efforts: %d active · %d of %d chunks\n", st.Efforts.Active, st.Efforts.ChunksDone, st.Efforts.ChunksTotal)
	return strings.TrimRight(b.String(), "\n")
}
