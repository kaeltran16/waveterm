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

var agentSyncCmd = &cobra.Command{
	Use:   "agent-sync",
	Short: "sync steering files and skills from the vault into every harness",
}

var agentSyncStatusCmd = &cobra.Command{
	Use:          "status",
	Short:        "show what each harness currently reflects",
	Args:         cobra.NoArgs,
	PreRunE:      preRunSetupRpcClient,
	RunE:         agentSyncStatusRun,
	SilenceUsage: true,
}

var agentSyncSyncCmd = &cobra.Command{
	Use:          "sync",
	Short:        "project the canonical steering doc and link canonical skills",
	Args:         cobra.NoArgs,
	PreRunE:      preRunSetupRpcClient,
	RunE:         agentSyncSyncRun,
	SilenceUsage: true,
}

var agentSyncAdoptCmd = &cobra.Command{
	Use:          "adopt",
	Short:        "migrate hand-maintained steering blocks and skills into the vault",
	Args:         cobra.NoArgs,
	PreRunE:      preRunSetupRpcClient,
	RunE:         agentSyncAdoptRun,
	SilenceUsage: true,
}

var (
	agentSyncDryRun     bool
	agentSyncApply      bool
	agentSyncPrefer     []string
	agentSyncAcceptLoss bool
)

func init() {
	agentSyncSyncCmd.Flags().BoolVar(&agentSyncDryRun, "dry-run", false, "print the plan without writing")
	agentSyncAdoptCmd.Flags().BoolVar(&agentSyncApply, "apply", false, "commit the migration (default is a dry run)")
	agentSyncAdoptCmd.Flags().StringArrayVar(&agentSyncPrefer, "prefer", nil, "resolve a skill collision, as <runtime>:<skill>")
	agentSyncAdoptCmd.Flags().BoolVar(&agentSyncAcceptLoss, "accept-loss", false, "accept dropping lines that exist only in a harness copy")
	agentSyncCmd.AddCommand(agentSyncStatusCmd, agentSyncSyncCmd, agentSyncAdoptCmd)
	rootCmd.AddCommand(agentSyncCmd)
}

func agentSyncStatusRun(cmd *cobra.Command, args []string) error {
	res, err := wshclient.AgentSyncStatusCommand(RpcClient, &wshrpc.RpcOpts{Timeout: 15000})
	if err != nil {
		return err
	}
	WriteStdout("canonical steering: %s\ncanonical skills:   %s\n\n", res.SteeringDoc, res.SkillsRoot)
	for _, h := range res.Harnesses {
		if !h.Present {
			WriteStdout("%-12s not present\n", h.Label)
			continue
		}
		line := fmt.Sprintf("%-12s steering %-8s skills %d linked", h.Label, h.Steering, h.SkillsLinked)
		if h.SkillsConflict > 0 {
			line += fmt.Sprintf(", %d conflict", h.SkillsConflict)
		}
		if h.Note != "" {
			line += "  (" + h.Note + ")"
		}
		WriteStdout("%s\n", line)
	}
	return nil
}

func agentSyncSyncRun(cmd *cobra.Command, args []string) error {
	res, err := wshclient.AgentSyncApplyCommand(RpcClient, wshrpc.CommandAgentSyncApplyData{DryRun: agentSyncDryRun}, &wshrpc.RpcOpts{Timeout: 30000})
	if err != nil {
		return err
	}
	if len(res.Actions) == 0 {
		WriteStdout("everything already in sync\n")
		return nil
	}
	for _, a := range res.Actions {
		detail := ""
		if a.Detail != "" {
			detail = "  " + a.Detail
		}
		WriteStdout("%-16s %-9s %s%s\n", a.Kind, a.Runtime, a.Path, detail)
	}
	return nil
}

func agentSyncAdoptRun(cmd *cobra.Command, args []string) error {
	prefer := map[string]string{}
	for _, p := range agentSyncPrefer {
		runtime, skill, ok := strings.Cut(p, ":")
		if !ok {
			return fmt.Errorf("--prefer wants <runtime>:<skill>, got %q", p)
		}
		prefer[skill] = runtime
	}
	res, err := wshclient.AgentSyncAdoptCommand(RpcClient, wshrpc.CommandAgentSyncAdoptData{
		Apply: agentSyncApply, Prefer: prefer, AcceptLoss: agentSyncAcceptLoss,
	}, &wshrpc.RpcOpts{Timeout: 60000})
	if res != nil {
		if res.SeedFrom != "" {
			WriteStdout("seed: %s (%d lines)\n", res.SeedFrom, res.SeedLines)
		}
		for _, c := range res.Carried {
			WriteStdout("carried  %-9s %s\n", c.Runtime, c.Line)
		}
		for _, m := range res.Moves {
			WriteStdout("move     %-9s %s\n", m.Runtime, m.From)
		}
		for _, c := range res.Collisions {
			WriteStdout("collision %s: %s\n", c.Name, strings.Join(c.Sources, ", "))
		}
		for _, r := range res.Reasons {
			WriteStdout("blocked: %s\n", r)
		}
	}
	return err
}
