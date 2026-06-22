// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// used for shared datastructures
package baseds

type LinkId int32

const NoLinkId = 0

type RpcInputChType struct {
	MsgBytes      []byte
	IngressLinkId LinkId
}

type Badge struct {
	BadgeId   string  `json:"badgeid"` // must be a uuidv7
	Icon      string  `json:"icon"`
	Color     string  `json:"color,omitempty"`
	Priority  float64 `json:"priority"`
	PidLinked bool    `json:"pidlinked,omitempty"`
}

type BadgeEvent struct {
	ORef      string `json:"oref"`
	Clear     bool   `json:"clear,omitempty"`
	ClearAll  bool   `json:"clearall,omitempty"`
	ClearById string `json:"clearbyid,omitempty"`
	Badge     *Badge `json:"badge,omitempty"`
}

const (
	AgentState_Working = "working"
	AgentState_Waiting = "waiting"
	AgentState_Idle    = "idle"
)

const (
	SubagentAction_Start = "start"
	SubagentAction_Stop  = "stop"
	SubagentAction_Model = "model"

	SubagentStatus_Success = "success"
	SubagentStatus_Failure = "failure"
)

// AgentSubagentDelta is an optional delta carried on AgentStatusData describing a single
// subagent lifecycle transition in the parent session (SubagentStart / SubagentStop hooks).
// It is a delta, not state: the frontend reduces a stream of these into a per-block list.
type AgentSubagentDelta struct {
	Action string `json:"action"` // SubagentAction_Start | SubagentAction_Stop | SubagentAction_Model
	Id     string `json:"id"`
	Type   string `json:"type,omitempty"`   // agent_type (e.g. Explore, Plan)
	Status string `json:"status,omitempty"` // SubagentStatus_* (stop only)
	Model  string `json:"model,omitempty"`  // resolved model id (e.g. claude-sonnet-4-6)
}

// AgentUsage is an optional usage snapshot carried on AgentStatusData, sourced from the Claude
// Code statusLine JSON. Like AgentSubagentDelta it rides a stateless (State-empty) Persist:0 event.
// The rate-limit fields are pointers because they are populated only for Claude.ai Pro/Max sessions
// and may be independently absent — nil means "unknown", which must render differently from 0%.
type AgentUsage struct {
	ContextPct    float64  `json:"contextpct,omitempty"`    // context_window.used_percentage
	ContextMax    int      `json:"contextmax,omitempty"`    // context_window_size (200000 | 1000000)
	CostUSD       float64  `json:"costusd,omitempty"`       // cost.total_cost_usd
	FiveHourPct   *float64 `json:"fivehourpct,omitempty"`   // rate_limits.five_hour.used_percentage
	FiveHourReset *int64   `json:"fivehourreset,omitempty"` // rate_limits.five_hour.resets_at (epoch seconds)
	WeekPct       *float64 `json:"weekpct,omitempty"`       // rate_limits.seven_day.used_percentage
	WeekReset     *int64   `json:"weekreset,omitempty"`     // rate_limits.seven_day.resets_at (epoch seconds)
}

// AgentStatusData is the payload of Event_AgentStatus. ORef is the block (or tab)
// the status applies to; State is one of the AgentState_* constants. When Subagent is
// non-nil the event carries a subagent delta, and when Usage is non-nil a usage snapshot;
// in both delta cases State may be empty.
type AgentStatusData struct {
	ORef           string              `json:"oref"`
	State          string              `json:"state"`
	Detail         string              `json:"detail,omitempty"`
	Agent          string              `json:"agent,omitempty"`
	Model          string              `json:"model,omitempty"`
	Title          string              `json:"title,omitempty"` // agent's ai-title (task summary), used as the sidebar label
	TranscriptPath string              `json:"transcriptpath,omitempty"`
	Ts             int64               `json:"ts"`
	Subagent       *AgentSubagentDelta `json:"subagent,omitempty"`
	Usage          *AgentUsage         `json:"usage,omitempty"`
}

type AgentAskOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type AgentAskQuestion struct {
	Question    string           `json:"question"`
	Header      string           `json:"header,omitempty"`
	MultiSelect bool             `json:"multiselect,omitempty"`
	Options     []AgentAskOption `json:"options,omitempty"`
}

// AgentAskData is the payload of Event_AgentAsk. ORef is the block the ask applies to;
// AskId keys the pending request in the agentask registry (for routing the answer back).
// A Cleared event (same ORef+AskId, Cleared=true, no questions) removes a resolved/cancelled ask.
type AgentAskData struct {
	ORef      string             `json:"oref"`
	AskId     string             `json:"askid"`
	Questions []AgentAskQuestion `json:"questions,omitempty"`
	Ts        int64              `json:"ts,omitempty"` // UnixMilli the ask was raised (for the "asking · 4m" age)
	Cleared   bool               `json:"cleared,omitempty"`
}

// AgentAnswerItem is one question's answer in a panel-submitted reply. SelectedIndexes
// indexes into that question's Options (MVP: exactly one for single-select).
type AgentAnswerItem struct {
	SelectedIndexes []int `json:"selectedindexes,omitempty"`
}
