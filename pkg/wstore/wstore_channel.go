// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
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
