// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type ChannelCommands interface {
	CreateChannelCommand(ctx context.Context, data CommandCreateChannelData) (*waveobj.Channel, error)
	DeleteChannelCommand(ctx context.Context, data CommandDeleteChannelData) error
	GetChannelsCommand(ctx context.Context) (*CommandGetChannelsRtnData, error)
	GetChannelRunsCommand(ctx context.Context, data CommandGetChannelRunsData) (*CommandGetChannelRunsRtnData, error)             // row-backed run list for a channel (Phase-2 active-channel surface)
	GetChannelMessagesCommand(ctx context.Context, data CommandGetChannelMessagesData) (*CommandGetChannelMessagesRtnData, error) // row-backed message window for a channel (before/limit cursor)
	PostChannelMessageCommand(ctx context.Context, data CommandPostChannelMessageData) (*waveobj.ChannelMessage, error)
	SetChannelTierCommand(ctx context.Context, data CommandSetChannelTierData) error               // sets a channel's Jarvis autonomy tier (concierge|gatekeeper|delegator) + default dispatch mode
	SetChannelNotesCommand(ctx context.Context, data CommandSetChannelNotesData) error             // sets a channel's free-text notes (Channel.Meta["channel:notes"])
	SetChannelReadCommand(ctx context.Context, data CommandSetChannelReadData) error               // stamps a channel's last-read timestamp for unread counts
	RenameChannelCommand(ctx context.Context, data CommandRenameChannelData) error                 // renames a channel (its rail display name)
	ArchiveChannelCommand(ctx context.Context, data CommandArchiveChannelData) error               // archives/unarchives a channel (hides it from the active rail list; kept, not deleted)
	SetChannelMessagePickCommand(ctx context.Context, data CommandSetChannelMessagePickData) error // records the human's chosen option index on a Jarvis card message (escalation answer / answered-override) so it survives a remount
	SetChannelProfileCommand(ctx context.Context, data CommandSetChannelProfileData) error         // write a channel's per-project profile override (empty clears it)
	GetAttentionCommand(ctx context.Context) (*CommandGetAttentionRtnData, error)                  // everything waiting on the human across every channel: review gates, Gatekeeper escalations, blocked workers
}

type CommandCreateChannelData struct {
	Name        string `json:"name"`
	ProjectPath string `json:"projectpath,omitempty"`
}

type CommandDeleteChannelData struct {
	ChannelId string `json:"channelid"`
}

type CommandGetChannelsRtnData struct {
	Channels []*waveobj.Channel `json:"channels"`
}

type CommandGetChannelRunsData struct {
	ChannelId string `json:"channelid"`
}

type CommandGetChannelRunsRtnData struct {
	Runs []*waveobj.Run `json:"runs"`
}

type CommandGetChannelMessagesData struct {
	ChannelId string `json:"channelid"`
	Before    int64  `json:"before,omitempty"` // ts cursor; 0 = latest
	Limit     int    `json:"limit,omitempty"`  // 0 = server default
}

type CommandGetChannelMessagesRtnData struct {
	Messages []*waveobj.ChannelMessage `json:"messages"`
}

type CommandPostChannelMessageData struct {
	ChannelId string `json:"channelid"`
	Kind      string `json:"kind"`
	Author    string `json:"author"`
	Text      string `json:"text"`
	RefORef   string `json:"reforef,omitempty"`
}

type CommandSetChannelTierData struct {
	ChannelId string `json:"channelid"`
	Tier      string `json:"tier"`           // concierge | gatekeeper | delegator
	Mode      string `json:"mode,omitempty"` // default dispatch mode: report | manage | fanout
}

type CommandSetChannelNotesData struct {
	ChannelId string `json:"channelid"`
	Notes     string `json:"notes"`
}

type CommandSetChannelReadData struct {
	ChannelId string `json:"channelid"`
	Ts        int64  `json:"ts"`
}

type CommandRenameChannelData struct {
	ChannelId string `json:"channelid"`
	Name      string `json:"name"`
}

type CommandArchiveChannelData struct {
	ChannelId string `json:"channelid"`
	Archived  bool   `json:"archived"`
}

type CommandSetChannelMessagePickData struct {
	ChannelId string `json:"channelid"`
	MessageId string `json:"messageid"`
	Pick      int    `json:"pick"`
}

type CommandSetChannelProfileData struct {
	ChannelId string                   `json:"channelid"`
	Override  *waveobj.ProfileOverride `json:"override"`
}

// AttentionItem is one thing waiting on the human, anywhere in the cockpit. Kind is "gate" |
// "escalation" | "ask". ChannelId/ChannelName are EMPTY for a standalone agent (one launched from the
// cockpit or Agent surface with no channel) — that is how the two nav-rail badges stay disjoint while
// coming from one source.
type AttentionItem struct {
	Kind         string `json:"kind"`
	Key          string `json:"key"` // stable across polls for the same waiting thing
	ChannelId    string `json:"channelid,omitempty"`
	ChannelName  string `json:"channelname,omitempty"`
	RunId        string `json:"runid,omitempty"`
	Source       string `json:"source"` // the run's goal, or the worker's name
	Text         string `json:"text"`
	Action       string `json:"action"`   // Review | Decide | Answer
	PhaseIdx     int    `json:"phaseidx"` // gate items only: the phase AdvanceRun must address to approve or send back
	WaitingSince int64  `json:"waitingsince"`
	// ORef addresses the object an item is about when it is not reachable through a channel. Today only
	// radar triage sets it; channel-backed items leave it empty because ChannelId+RunId already address
	// them, and the frontend's rule is that an item naming no destination renders static.
	ORef string `json:"oref,omitempty"`

	// EffortOID/ChunkLabel are the initiative this waiting thing belongs to, read off the owning run's
	// EffortRef. Only the oid travels: the effort's title is already on the Brief, so joining it here
	// would be a second source for one fact. Empty when the run is not attributed to an initiative.
	EffortOID  string `json:"effortoid,omitempty"`
	ChunkLabel string `json:"chunklabel,omitempty"`
	// Why is the one sentence of context Text cannot carry: what else is done, what stays stopped. It is
	// composed from counts the server already holds, never model-generated prose — a queue row that
	// summarised its own item with a language model would be an unverifiable claim on the one surface
	// whose whole promise is that every number is derived.
	Why string `json:"why,omitempty"`
	// Cites are the concrete things the decision rests on — today the gated phase's recorded artifacts.
	// Plain strings because they render as numbered labels, not controls: the row itself is the button,
	// and a second control inside it is the affordance defect invariant 4 names. They share the item's
	// WaitingSince (one phase produced them all), so they carry no per-citation timestamp.
	Cites []string `json:"cites,omitempty"`
}

type CommandGetAttentionRtnData struct {
	Items []AttentionItem `json:"items"`
}
