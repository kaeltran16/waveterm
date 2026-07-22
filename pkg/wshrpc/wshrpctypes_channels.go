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
