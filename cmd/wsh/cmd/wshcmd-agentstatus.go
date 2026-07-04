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
	agentStatusState      string
	agentStatusDetail     string
	agentStatusAgent      string
	agentStatusModel      string
	agentStatusTitle      string
	agentStatusTranscript string

	agentSubagentStart  bool
	agentSubagentStop   bool
	agentSubagentModel  bool
	agentSubagentId     string
	agentSubagentType   string
	agentSubagentStatus string

	agentUsageFlag       bool
	agentUsageContext    float64
	agentUsageContextMax int
	agentUsageCost       float64
	agentUsageFiveHour   float64
	agentUsageFiveReset  int64
	agentUsageWeek       float64
	agentUsageWeekReset  int64
)

func init() {
	rootCmd.AddCommand(agentStatusCmd)
	agentStatusCmd.Flags().StringVar(&agentStatusState, "state", "", "agent state: working | waiting | idle")
	agentStatusCmd.Flags().StringVar(&agentStatusDetail, "detail", "", "activity detail line (e.g. \"editing foo.go\")")
	agentStatusCmd.Flags().StringVar(&agentStatusAgent, "agent", "", "agent identity (claude | codex)")
	agentStatusCmd.Flags().BoolVar(&agentSubagentStart, "subagent-start", false, "report a subagent that started (requires --id, --type)")
	agentStatusCmd.Flags().BoolVar(&agentSubagentStop, "subagent-stop", false, "report a subagent that stopped (requires --id; optionally --status success|failure)")
	agentStatusCmd.Flags().StringVar(&agentSubagentId, "id", "", "subagent agent_id (with --subagent-start/--subagent-stop)")
	agentStatusCmd.Flags().StringVar(&agentSubagentType, "type", "", "subagent agent_type (e.g. Explore, Plan)")
	agentStatusCmd.Flags().StringVar(&agentSubagentStatus, "status", "", "subagent outcome: success | failure (with --subagent-stop)")
	agentStatusCmd.Flags().StringVar(&agentStatusModel, "model", "", "resolved model id (e.g. claude-sonnet-4-6)")
	agentStatusCmd.Flags().StringVar(&agentStatusTitle, "title", "", "agent ai-title / task summary (used as the sidebar tab label)")
	agentStatusCmd.Flags().StringVar(&agentStatusTranscript, "transcript", "", "path to the agent's transcript JSONL (for previous-info projection)")
	agentStatusCmd.Flags().BoolVar(&agentSubagentModel, "subagent-model", false, "report a subagent's resolved model (requires --id, --model)")
	agentStatusCmd.Flags().BoolVar(&agentUsageFlag, "usage", false, "report a usage-only delta from the statusLine JSON (no --state)")
	agentStatusCmd.Flags().Float64Var(&agentUsageContext, "context-pct", 0, "context window used percentage")
	agentStatusCmd.Flags().IntVar(&agentUsageContextMax, "context-max", 0, "context window size in tokens (200000 | 1000000)")
	agentStatusCmd.Flags().Float64Var(&agentUsageCost, "cost-usd", 0, "session cost in USD")
	agentStatusCmd.Flags().Float64Var(&agentUsageFiveHour, "five-hour-pct", 0, "5-hour rate-limit used percentage (Claude.ai Pro/Max only)")
	agentStatusCmd.Flags().Int64Var(&agentUsageFiveReset, "five-hour-reset", 0, "5-hour window reset (epoch seconds)")
	agentStatusCmd.Flags().Float64Var(&agentUsageWeek, "week-pct", 0, "weekly rate-limit used percentage (Claude.ai Pro/Max only)")
	agentStatusCmd.Flags().Int64Var(&agentUsageWeekReset, "week-reset", 0, "weekly window reset (epoch seconds)")
}

func validAgentState(s string) bool {
	return s == baseds.AgentState_Working || s == baseds.AgentState_Waiting || s == baseds.AgentState_Idle
}

func buildAgentStatusEvent(oref *waveobj.ORef, data baseds.AgentStatusData, persist int) wps.WaveEvent {
	return wps.WaveEvent{
		Event:   wps.Event_AgentStatus,
		Scopes:  []string{oref.String()},
		Persist: persist,
		Data:    data,
	}
}

func publishAgentStatusData(oref *waveobj.ORef, data baseds.AgentStatusData, persist int) error {
	event := buildAgentStatusEvent(oref, data, persist)
	return wshclient.EventPublishCommand(RpcClient, event, &wshrpc.RpcOpts{NoResponse: true})
}

func agentStatusRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("agentstatus", rtnErr == nil)
	}()

	oref, err := resolveBlockArg()
	if err != nil {
		return fmt.Errorf("resolving block: %v", err)
	}
	if oref.OType != waveobj.OType_Block && oref.OType != waveobj.OType_Tab {
		return fmt.Errorf("agentstatus oref must be a block or tab (got %q)", oref.OType)
	}

	if agentSubagentStart || agentSubagentStop || agentSubagentModel {
		return publishSubagentDelta(oref)
	}

	if agentUsageFlag {
		return publishUsageDelta(cmd, oref)
	}

	if !validAgentState(agentStatusState) {
		return fmt.Errorf("--state must be one of working, waiting, idle (got %q)", agentStatusState)
	}

	eventData := baseds.AgentStatusData{
		ORef:           oref.String(),
		State:          agentStatusState,
		Detail:         agentStatusDetail,
		Agent:          agentStatusAgent,
		Model:          agentStatusModel,
		Title:          agentStatusTitle,
		TranscriptPath: agentStatusTranscript,
		Ts:             time.Now().UnixMilli(),
	}

	err = publishAgentStatusData(oref, eventData, 1)
	if err != nil {
		return fmt.Errorf("publishing agentstatus event: %v", err)
	}
	fmt.Printf("agentstatus %s set\n", agentStatusState)
	return nil
}

func publishUsageDelta(cmd *cobra.Command, oref *waveobj.ORef) error {
	usage := &baseds.AgentUsage{
		ContextPct: agentUsageContext,
		ContextMax: agentUsageContextMax,
		CostUSD:    agentUsageCost,
	}
	// only attach the rate-limit fields when explicitly provided, so an API-key (non-Pro/Max)
	// session that omits them reports nil ("unknown") rather than a misleading 0%
	if cmd.Flags().Changed("five-hour-pct") {
		usage.FiveHourPct = &agentUsageFiveHour
		if cmd.Flags().Changed("five-hour-reset") {
			usage.FiveHourReset = &agentUsageFiveReset
		}
	}
	if cmd.Flags().Changed("week-pct") {
		usage.WeekPct = &agentUsageWeek
		if cmd.Flags().Changed("week-reset") {
			usage.WeekReset = &agentUsageWeekReset
		}
	}

	if err := publishUsage(oref, usage); err != nil {
		return fmt.Errorf("publishing agentstatus usage event: %v", err)
	}
	fmt.Printf("agentstatus usage set\n")
	return nil
}

func publishUsage(oref *waveobj.ORef, usage *baseds.AgentUsage) error {
	eventData := baseds.AgentStatusData{
		ORef:  oref.String(),
		Ts:    time.Now().UnixMilli(),
		Usage: usage,
	}
	// Persist:0 — usage deltas are ephemeral; a retained usage event would evict the
	// retained Persist:1 parent-state event that a late subscriber must replay.
	return publishAgentStatusData(oref, eventData, 0)
}

func publishSubagentDelta(oref *waveobj.ORef) error {
	if agentSubagentStart && agentSubagentStop {
		return fmt.Errorf("--subagent-start and --subagent-stop are mutually exclusive")
	}
	if agentSubagentId == "" {
		return fmt.Errorf("--id is required with --subagent-start/--subagent-stop/--subagent-model")
	}

	action := baseds.SubagentAction_Start
	status := ""
	if agentSubagentStop {
		action = baseds.SubagentAction_Stop
		if agentSubagentStatus != "" && agentSubagentStatus != baseds.SubagentStatus_Success && agentSubagentStatus != baseds.SubagentStatus_Failure {
			return fmt.Errorf("--status must be success or failure (got %q)", agentSubagentStatus)
		}
		status = agentSubagentStatus
	}
	if agentSubagentModel {
		action = baseds.SubagentAction_Model
		if agentStatusModel == "" {
			return fmt.Errorf("--model is required with --subagent-model")
		}
	}

	eventData := baseds.AgentStatusData{
		ORef:  oref.String(),
		Agent: agentStatusAgent,
		Ts:    time.Now().UnixMilli(),
		Subagent: &baseds.AgentSubagentDelta{
			Action: action,
			Id:     agentSubagentId,
			Type:   agentSubagentType,
			Status: status,
			Model:  agentStatusModel,
		},
	}

	// Persist:0 — subagent deltas are ephemeral; they must not be retained or replayed to
	// late subscribers (a replayed delta would resurrect a phantom child). The retained
	// Persist:1 parent-state event for the same scope is untouched (pkg/wps/wps.go:196,228).
	err := publishAgentStatusData(oref, eventData, 0)
	if err != nil {
		return fmt.Errorf("publishing agentstatus subagent event: %v", err)
	}
	fmt.Printf("agentstatus subagent %s %s set\n", action, agentSubagentId)
	return nil
}
