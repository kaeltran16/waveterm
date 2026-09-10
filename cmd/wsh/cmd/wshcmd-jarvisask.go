// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

// askRpcTimeoutMs bounds the stateless ask: retrieval + a cheap judge + a TierMid synthesize run
// synchronously inside the handler, far beyond the 5s default RPC budget (the EC-TIME trap
// SealEvidence/wsh jarvis complete hit). Two model calls, worst case.
const askRpcTimeoutMs = 180_000

var jarvisAskCmd = &cobra.Command{
	Use:     "ask \"<question>\"",
	Short:   "ask the work ledger a stateless question (status, history, decisions, bring-up)",
	Args:    cobra.MinimumNArgs(1),
	RunE:    jarvisAskRun,
	PreRunE: preRunSetupRpcClient,
}

var jarvisStatusCmd = &cobra.Command{
	Use:     "status",
	Short:   "capture accounting: vault note counts, index availability, distill queue",
	Args:    cobra.NoArgs,
	RunE:    jarvisStatusRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	jarvisAskCmd.Flags().String("cwd", "", "project directory to scope the question to")
	jarvisAskCmd.Flags().Bool("json", false, "print the full response as JSON")
	jarvisCmd.AddCommand(jarvisAskCmd)
	jarvisCmd.AddCommand(jarvisStatusCmd)
}

func jarvisAskRun(cmd *cobra.Command, args []string) error {
	question := strings.Join(args, " ")
	cwd, _ := cmd.Flags().GetString("cwd")
	rtn, err := wshclient.JarvisAskCommand(RpcClient, wshrpc.CommandJarvisAskData{Prompt: question, Cwd: cwd}, &wshrpc.RpcOpts{Timeout: askRpcTimeoutMs})
	if err != nil {
		return err
	}
	jsonOut, _ := cmd.Flags().GetBool("json")
	if jsonOut {
		b, err := json.MarshalIndent(rtn, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(b))
		return nil
	}
	fmt.Println(rtn.Answer)
	if len(rtn.Grounding) > 0 {
		fmt.Println("\nSources:")
		for _, c := range rtn.Grounding {
			// the freshness rides along now that the answer carries one: a CLI reader deciding whether to
			// trust a cited source needs the same reading the cockpit's band shows.
			fmt.Printf("  [%d] %s · %s (%s)\n", c.N, c.NavTarget, c.Title, c.Freshness)
		}
	}
	return nil
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
	b.WriteString("embedding index: ")
	if st.IndexAvailable {
		b.WriteString("available\n")
	} else if st.IndexError != "" {
		fmt.Fprintf(&b, "unavailable (%s)\n", st.IndexError)
	} else {
		b.WriteString("unavailable\n")
	}
	fmt.Fprintf(&b, "efforts: %d active · %d of %d chunks\n", st.Efforts.Active, st.Efforts.ChunksDone, st.Efforts.ChunksTotal)
	b.WriteString("distill queue:\n")
	if len(st.DistillQueue) == 0 {
		b.WriteString("  (empty)\n")
	} else {
		for _, q := range st.DistillQueue {
			last := "never"
			if q.LastPass != nil {
				last = fmt.Sprintf("%s (%d sessions, %d committed, %d queued)",
					time.UnixMilli(q.LastPass.Ts).Format("2006-01-02 15:04"),
					q.LastPass.Sessions, q.LastPass.Committed, q.LastPass.Queued)
			}
			fmt.Fprintf(&b, "  %s: %d pending; last pass %s\n", q.Cwd, q.Pending, last)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}
