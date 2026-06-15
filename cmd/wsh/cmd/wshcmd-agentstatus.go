// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var agentStatusCmd = &cobra.Command{
	Use:                   "agentstatus",
	Short:                 "report coding-agent session status for a block",
	Args:                  cobra.NoArgs,
	RunE:                  agentStatusRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var (
	agentStatusState  string
	agentStatusDetail string
	agentStatusAgent  string
)

func init() {
	rootCmd.AddCommand(agentStatusCmd)
	agentStatusCmd.Flags().StringVar(&agentStatusState, "state", "", "agent state: working | waiting | idle")
	agentStatusCmd.Flags().StringVar(&agentStatusDetail, "detail", "", "activity detail line (e.g. \"editing foo.go\")")
	agentStatusCmd.Flags().StringVar(&agentStatusAgent, "agent", "", "agent identity (claude | codex)")
}

func validAgentState(s string) bool {
	return s == baseds.AgentState_Working || s == baseds.AgentState_Waiting || s == baseds.AgentState_Idle
}

func agentStatusRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agentstatus", rtnErr == nil)
	}()

	if !validAgentState(agentStatusState) {
		return fmt.Errorf("--state must be one of working, waiting, idle (got %q)", agentStatusState)
	}

	oref, err := resolveBlockArg()
	if err != nil {
		return fmt.Errorf("resolving block: %v", err)
	}
	if oref.OType != waveobj.OType_Block && oref.OType != waveobj.OType_Tab {
		return fmt.Errorf("agentstatus oref must be a block or tab (got %q)", oref.OType)
	}

	eventData := baseds.AgentStatusData{
		ORef:   oref.String(),
		State:  agentStatusState,
		Detail: agentStatusDetail,
		Agent:  agentStatusAgent,
		Ts:     time.Now().UnixMilli(),
	}

	event := wps.WaveEvent{
		Event:   wps.Event_AgentStatus,
		Scopes:  []string{oref.String()},
		Persist: 1,
		Data:    eventData,
	}

	err = wshclient.EventPublishCommand(RpcClient, event, &wshrpc.RpcOpts{NoResponse: true})
	if err != nil {
		return fmt.Errorf("publishing agentstatus event: %v", err)
	}
	fmt.Printf("agentstatus %s set\n", agentStatusState)
	return nil
}
