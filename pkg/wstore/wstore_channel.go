// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func NewChannelMessage(kind, author, text, refORef string, ts int64) waveobj.ChannelMessage {
	return waveobj.ChannelMessage{
		ID:      uuid.NewString(),
		Kind:    kind,
		Author:  author,
		Text:    text,
		RefORef: refORef,
		Ts:      ts,
	}
}

func appendChannelMessage(ch *waveobj.Channel, msg waveobj.ChannelMessage) {
	ch.Messages = append(ch.Messages, msg)
}

func CreateChannel(ctx context.Context, name, projectPath string) (*waveobj.Channel, error) {
	ch := &waveobj.Channel{
		OID:         uuid.NewString(),
		Name:        name,
		ProjectPath: projectPath,
		CreatedTs:   time.Now().UnixMilli(),
		Meta:        make(waveobj.MetaMapType),
	}
	if err := DBInsert(ctx, ch); err != nil {
		return nil, err
	}
	return ch, nil
}

func DeleteChannel(ctx context.Context, channelId string) error {
	return DBDelete(ctx, waveobj.OType_Channel, channelId)
}

func GetChannels(ctx context.Context) ([]*waveobj.Channel, error) {
	chans, err := DBGetAllObjsByType[*waveobj.Channel](ctx, waveobj.OType_Channel)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(chans, func(i, j int) bool {
		return chans[i].CreatedTs > chans[j].CreatedTs
	})
	return chans, nil
}

// updateChannelMessageIn finds the message by id in ch and applies fn to it in place; returns an error
// if no message with that id exists. Pure over the channel object — the DB wrapper is UpdateChannelMessage.
func updateChannelMessageIn(ch *waveobj.Channel, messageId string, fn func(*waveobj.ChannelMessage) error) error {
	for i := range ch.Messages {
		if ch.Messages[i].ID == messageId {
			return fn(&ch.Messages[i])
		}
	}
	return fmt.Errorf("message %q not found in channel", messageId)
}

// UpdateChannelMessage applies fn to the identified message and persists the channel.
func UpdateChannelMessage(ctx context.Context, channelId, messageId string, fn func(*waveobj.ChannelMessage) error) error {
	return DBUpdateFnErr(ctx, channelId, func(ch *waveobj.Channel) error {
		return updateChannelMessageIn(ch, messageId, fn)
	})
}

func PostChannelMessage(ctx context.Context, channelId string, msg waveobj.ChannelMessage) (*waveobj.ChannelMessage, error) {
	err := DBUpdateFnErr(ctx, channelId, func(ch *waveobj.Channel) error {
		appendChannelMessage(ch, msg)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &msg, nil
}

func appendRunIn(ch *waveobj.Channel, run waveobj.Run) {
	ch.Runs = append(ch.Runs, run)
}

// AppendRun appends a run to the channel and persists it.
func AppendRun(ctx context.Context, channelId string, run waveobj.Run) error {
	return DBUpdateFnErr(ctx, channelId, func(ch *waveobj.Channel) error {
		appendRunIn(ch, run)
		return nil
	})
}

// updateRunIn finds the run by id in ch and applies fn in place; errors if not found.
func updateRunIn(ch *waveobj.Channel, runId string, fn func(*waveobj.Run) error) error {
	for i := range ch.Runs {
		if ch.Runs[i].ID == runId {
			return fn(&ch.Runs[i])
		}
	}
	return fmt.Errorf("run %q not found in channel", runId)
}

// UpdateRun applies fn to the identified run and persists the channel.
func UpdateRun(ctx context.Context, channelId, runId string, fn func(*waveobj.Run) error) error {
	return DBUpdateFnErr(ctx, channelId, func(ch *waveobj.Channel) error {
		return updateRunIn(ch, runId, fn)
	})
}

// GetRun reads a single run by id (a copy), for the orchestrator's read-back-then-spawn step.
func GetRun(ctx context.Context, channelId, runId string) (*waveobj.Run, error) {
	ch, err := DBMustGet[*waveobj.Channel](ctx, channelId)
	if err != nil {
		return nil, err
	}
	for i := range ch.Runs {
		if ch.Runs[i].ID == runId {
			r := ch.Runs[i]
			return &r, nil
		}
	}
	return nil, fmt.Errorf("run %q not found in channel", runId)
}

// MetaKey_ReadTs stores the per-channel last-read timestamp (ms) used to derive unread counts.
const MetaKey_ReadTs = "read:ts"

// SetChannelRead stamps the channel's last-read timestamp.
func SetChannelRead(ctx context.Context, channelId string, ts int64) error {
	return DBUpdateFn(ctx, channelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		ch.Meta[MetaKey_ReadTs] = float64(ts)
	})
}
