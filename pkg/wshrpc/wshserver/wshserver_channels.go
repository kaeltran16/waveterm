// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func (ws *WshServer) CreateChannelCommand(ctx context.Context, data wshrpc.CommandCreateChannelData) (*waveobj.Channel, error) {
	ch, err := wstore.CreateChannel(ctx, data.Name, data.ProjectPath)
	if err != nil {
		return nil, fmt.Errorf("creating channel: %w", err)
	}
	return ch, nil
}

func (ws *WshServer) DeleteChannelCommand(ctx context.Context, data wshrpc.CommandDeleteChannelData) error {
	if err := wstore.DeleteChannel(ctx, data.ChannelId); err != nil {
		return fmt.Errorf("deleting channel: %w", err)
	}
	return nil
}

func (ws *WshServer) GetChannelsCommand(ctx context.Context) (*wshrpc.CommandGetChannelsRtnData, error) {
	chans, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing channels: %w", err)
	}
	return &wshrpc.CommandGetChannelsRtnData{Channels: chans}, nil
}

func (ws *WshServer) PostChannelMessageCommand(ctx context.Context, data wshrpc.CommandPostChannelMessageData) (*waveobj.ChannelMessage, error) {
	msg := wstore.NewChannelMessage(data.Kind, data.Author, data.Text, data.RefORef, time.Now().UnixMilli())
	stored, err := wstore.PostChannelMessage(ctx, data.ChannelId, msg)
	if err != nil {
		return nil, fmt.Errorf("posting channel message: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return stored, nil
}

func (ws *WshServer) SetChannelTierCommand(ctx context.Context, data wshrpc.CommandSetChannelTierData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	gk, del := jarvis.TierMeta(data.Tier)
	mode := data.Mode
	if mode == "" {
		mode = "report"
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		ch.Meta[jarvis.MetaKey_GatekeeperEnabled] = gk
		ch.Meta[jarvis.MetaKey_DelegatorEnabled] = del
		ch.Meta[jarvis.MetaKey_DelegatorMode] = mode
	})
	if err != nil {
		return fmt.Errorf("updating channel tier: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) SetChannelNotesCommand(ctx context.Context, data wshrpc.CommandSetChannelNotesData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		// keep meta clean: an empty notes value drops the key rather than storing ""
		if data.Notes == "" {
			delete(ch.Meta, jarvis.MetaKey_ChannelNotes)
		} else {
			ch.Meta[jarvis.MetaKey_ChannelNotes] = data.Notes
		}
	})
	if err != nil {
		return fmt.Errorf("updating channel notes: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) SetChannelReadCommand(ctx context.Context, data wshrpc.CommandSetChannelReadData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	if err := wstore.SetChannelRead(ctx, data.ChannelId, data.Ts); err != nil {
		return fmt.Errorf("updating channel read ts: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) RenameChannelCommand(ctx context.Context, data wshrpc.CommandRenameChannelData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	name := strings.TrimSpace(data.Name)
	if name == "" {
		return fmt.Errorf("name is required")
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		ch.Name = name
	})
	if err != nil {
		return fmt.Errorf("renaming channel: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) ArchiveChannelCommand(ctx context.Context, data wshrpc.CommandArchiveChannelData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		ch.Meta[wstore.MetaKey_Archived] = data.Archived
	})
	if err != nil {
		return fmt.Errorf("updating channel archived flag: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) SetChannelMessagePickCommand(ctx context.Context, data wshrpc.CommandSetChannelMessagePickData) error {
	if data.ChannelId == "" || data.MessageId == "" {
		return fmt.Errorf("channelid and messageid are required")
	}
	err := wstore.UpdateChannelMessage(ctx, data.ChannelId, data.MessageId, func(msg *waveobj.ChannelMessage) error {
		patched, err := jarvis.SetCardHumanPick(msg.Data, data.Pick)
		if err != nil {
			return fmt.Errorf("patching card pick: %w", err)
		}
		msg.Data = patched
		return nil
	})
	if err != nil {
		return fmt.Errorf("recording message pick: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) SetChannelProfileCommand(ctx context.Context, data wshrpc.CommandSetChannelProfileData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	if data.Override != nil && data.Override.Principles != nil {
		global := jarvis.LoadGlobalProfile()
		// a legacy string arriving from an old client becomes a structured patch before validation/storage.
		patch := jarvis.NormalizePrinciplePatch(global.Principles, data.Override.Principles)
		if err := jarvis.ValidatePrinciplePatch(global.Principles, patch); err != nil {
			return fmt.Errorf("validating principle patch: %w", err)
		}
		if patch.IsEmpty() {
			patch = nil
		}
		data.Override.Principles = patch
	}
	empty := data.Override == nil || (data.Override.Playbook == nil && data.Override.Principles == nil &&
		data.Override.DefaultMode == nil && data.Override.DefaultPlanGate == nil)
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		if empty {
			delete(ch.Meta, jarvis.MetaKey_JarvisProfile)
		} else {
			ch.Meta[jarvis.MetaKey_JarvisProfile] = data.Override
		}
	})
	if err != nil {
		return fmt.Errorf("updating channel profile: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
