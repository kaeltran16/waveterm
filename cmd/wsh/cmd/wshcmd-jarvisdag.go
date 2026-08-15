// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/pitasks"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var jarvisDagCmd = &cobra.Command{
	Use:   "dag",
	Short: "orchestration engine: submit/steer a task DAG",
	Args:  cobra.NoArgs,
	RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var dagSubmitCmd = &cobra.Command{
	Use:     "submit <dag-json>",
	Short:   "validate and submit a DAG for the current run",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		var data wshrpc.CommandDagSubmitData
		if err := json.Unmarshal([]byte(args[0]), &data); err != nil {
			return fmt.Errorf("dag json: %w", err)
		}
		g, err := wshclient.DagSubmitCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 20_000})
		if err != nil {
			return err
		}
		fmt.Printf("dag %s submitted (%d tasks, parallelism %d)\n", g.ID, len(g.Tasks), g.Parallelism)
		return nil
	},
}

var dagImportCmd = &cobra.Command{
	Use:     "import-tasks",
	Short:   "submit a DAG from the pi-tasks store in <cwd> (default .)",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, _ := cmd.Flags().GetString("dir")
		if dir == "" {
			dir = "."
		}
		tasks, err := pitasks.Read(dir)
		if err != nil {
			return fmt.Errorf("reading pi-tasks: %w", err)
		}
		nodes, err := orchestrate.ImportPitasks(tasks)
		if err != nil {
			return err
		}
		runId, _ := cmd.Flags().GetString("runid")
		channelId, _ := cmd.Flags().GetString("channel")
		if runId == "" || channelId == "" {
			return fmt.Errorf("--runid and --channel are required")
		}
		g, err := wshclient.DagSubmitCommand(RpcClient, wshrpc.CommandDagSubmitData{
			ChannelId: channelId, RunId: runId, Parallelism: 2, Tasks: nodes,
		}, &wshrpc.RpcOpts{Timeout: 20_000})
		if err != nil {
			return err
		}
		fmt.Printf("dag %s submitted from %d pi-tasks\n", g.ID, len(g.Tasks))
		return nil
	},
}

var dagStatusCmd = &cobra.Command{
	Use:     "status",
	Short:   "print the engine-owned DAG status snapshot",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		runId, _ := cmd.Flags().GetString("runid")
		channelId, _ := cmd.Flags().GetString("channel")
		g, err := wshclient.DagStatusCommand(RpcClient, wshrpc.CommandDagStatusData{ChannelId: channelId, RunId: runId}, &wshrpc.RpcOpts{Timeout: 10_000})
		if err != nil {
			return err
		}
		out, _ := json.MarshalIndent(g, "", "  ")
		fmt.Println(string(out))
		return nil
	},
}

func dagAction(action string) *cobra.Command {
	return &cobra.Command{
		Use:     fmt.Sprintf("%s <task-id>", action),
		Short:   fmt.Sprintf("dag action: %s", action),
		Args:    cobra.ExactArgs(1),
		PreRunE: preRunSetupRpcClient,
		RunE: func(cmd *cobra.Command, args []string) error {
			runId, _ := cmd.Flags().GetString("runid")
			channelId, _ := cmd.Flags().GetString("channel")
			return wshclient.DagActionCommand(RpcClient, wshrpc.CommandDagActionData{
				ChannelId: channelId, RunId: runId, TaskId: args[0], Action: action,
			}, &wshrpc.RpcOpts{Timeout: 10_000})
		},
	}
}

var dagMergeCmd = &cobra.Command{
	Use:     "merge",
	Short:   "squash-merge the run's worktree back into the project branch",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		runId, _ := cmd.Flags().GetString("runid")
		channelId, _ := cmd.Flags().GetString("channel")
		return wshclient.DagMergeCommand(RpcClient, wshrpc.CommandDagMergeData{ChannelId: channelId, RunId: runId}, &wshrpc.RpcOpts{Timeout: 60_000})
	},
}

func init() {
	jarvisDagCmd.AddCommand(dagSubmitCmd, dagImportCmd, dagStatusCmd, dagMergeCmd)
	jarvisDagCmd.AddCommand(dagAction("approve"), dagAction("sendback"), dagAction("retry"), dagAction("skip"), dagAction("cancel"))
	for _, c := range jarvisDagCmd.Commands() {
		c.Flags().String("runid", "", "run id")
		c.Flags().String("channel", "", "channel id")
	}
	dagImportCmd.Flags().String("dir", "", "pi-tasks dir (default .)")
	jarvisCmd.AddCommand(jarvisDagCmd)
}
