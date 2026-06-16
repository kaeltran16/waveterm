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

// AgentStatusData is the payload of Event_AgentStatus. ORef is the block (or tab)
// the status applies to; State is one of the AgentState_* constants. When Subagent is
// non-nil the event carries a subagent delta (State may be empty in that case).
type AgentStatusData struct {
	ORef     string              `json:"oref"`
	State    string              `json:"state"`
	Detail   string              `json:"detail,omitempty"`
	Agent    string              `json:"agent,omitempty"`
	Model    string              `json:"model,omitempty"`
	Ts       int64               `json:"ts"`
	Subagent *AgentSubagentDelta `json:"subagent,omitempty"`
}
