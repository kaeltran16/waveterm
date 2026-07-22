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

// stampMessageIdentity sets the object identity and parent link on a message before it is written as a
// row (and, since it mutates the pointer before the blob append, on the embedded copy too — keeping the
// two representations identical during dual-write). OID == the message's own UUID.
func stampMessageIdentity(channelId string, msg *waveobj.ChannelMessage) {
	msg.OID = msg.ID
	msg.ChannelOID = channelId
}

// stampRunIdentity does the same for a run.
func stampRunIdentity(channelId string, run *waveobj.Run) {
	run.OID = run.ID
	run.ChannelOID = channelId
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

// UpdateChannelMessage applies fn to the identified message and persists the channel (blob + db_channelmessage row).
func UpdateChannelMessage(ctx context.Context, channelId, messageId string, fn func(*waveobj.ChannelMessage) error) error {
	return WithTx(ctx, func(tx *TxWrap) error {
		ch, err := DBMustGet[*waveobj.Channel](tx.Context(), channelId)
		if err != nil {
			return err
		}
		var updated *waveobj.ChannelMessage
		if err := updateChannelMessageIn(ch, messageId, func(m *waveobj.ChannelMessage) error {
			if err := fn(m); err != nil {
				return err
			}
			updated = m // pointer into ch.Messages; used for the row dual-write below
			return nil
		}); err != nil {
			return err
		}
		stampMessageIdentity(channelId, updated)
		if err := DBUpdate(tx.Context(), ch); err != nil {
			return err
		}
		return dbUpsertObjTx(tx.Context(), updated)
	})
}

func PostChannelMessage(ctx context.Context, channelId string, msg waveobj.ChannelMessage) (*waveobj.ChannelMessage, error) {
	stampMessageIdentity(channelId, &msg)
	err := WithTx(ctx, func(tx *TxWrap) error {
		ch, err := DBMustGet[*waveobj.Channel](tx.Context(), channelId)
		if err != nil {
			return err
		}
		appendChannelMessage(ch, msg)
		if err := DBUpdate(tx.Context(), ch); err != nil {
			return err
		}
		return dbUpsertObjTx(tx.Context(), &msg)
	})
	if err != nil {
		return nil, err
	}
	return &msg, nil
}

// PostChannelMessageIf appends msg to the channel only if cond reports true when evaluated against the
// current persisted channel inside the write transaction. Because wstore serializes on a single DB
// connection, two concurrent posters cannot both pass cond: the second transaction reads the first's
// committed message, so cond sees it. Returns true if the message was posted.
func PostChannelMessageIf(ctx context.Context, channelId string, msg waveobj.ChannelMessage, cond func(*waveobj.Channel) bool) (bool, error) {
	var posted bool
	err := WithTx(ctx, func(tx *TxWrap) error {
		ch, err := DBMustGet[*waveobj.Channel](tx.Context(), channelId)
		if err != nil {
			return err
		}
		if !cond(ch) {
			return nil
		}
		stampMessageIdentity(channelId, &msg)
		appendChannelMessage(ch, msg)
		posted = true
		if err := DBUpdate(tx.Context(), ch); err != nil {
			return err
		}
		return dbUpsertObjTx(tx.Context(), &msg)
	})
	return posted, err
}

func appendRunIn(ch *waveobj.Channel, run waveobj.Run) {
	ch.Runs = append(ch.Runs, run)
}

// AppendRun appends a run to the channel and persists it (blob + db_run row).
func AppendRun(ctx context.Context, channelId string, run waveobj.Run) error {
	stampRunIdentity(channelId, &run)
	return WithTx(ctx, func(tx *TxWrap) error {
		ch, err := DBMustGet[*waveobj.Channel](tx.Context(), channelId)
		if err != nil {
			return err
		}
		appendRunIn(ch, run)
		if err := DBUpdate(tx.Context(), ch); err != nil {
			return err
		}
		return dbUpsertObjTx(tx.Context(), &run)
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

// UpdateRun applies fn to the identified run and persists the channel (blob + db_run row).
func UpdateRun(ctx context.Context, channelId, runId string, fn func(*waveobj.Run) error) error {
	return WithTx(ctx, func(tx *TxWrap) error {
		ch, err := DBMustGet[*waveobj.Channel](tx.Context(), channelId)
		if err != nil {
			return err
		}
		var updated *waveobj.Run
		if err := updateRunIn(ch, runId, func(r *waveobj.Run) error {
			if err := fn(r); err != nil {
				return err
			}
			updated = r // pointer into ch.Runs; used for the row dual-write below
			return nil
		}); err != nil {
			return err
		}
		stampRunIdentity(channelId, updated)
		if err := DBUpdate(tx.Context(), ch); err != nil {
			return err
		}
		return dbUpsertObjTx(tx.Context(), updated)
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

// MetaKey_Archived hides a channel from the active rail list. Reversible; the channel is kept, not deleted.
const MetaKey_Archived = "archived"

// MetaKey_JarvisRunORef / MetaKey_JarvisChannelORef stamp the owning run: and channel: oref onto a
// worker tab's meta at spawn, so the worker-oref → run lookup is a direct field read instead of a full
// channel scan (channel-scaling design call 1).
const MetaKey_JarvisRunORef = "jarvis:runoref"
const MetaKey_JarvisChannelORef = "jarvis:channeloref"

// StampWorkerOwner records the owning run/channel oref on a worker tab's meta. Best-effort: a worker
// oref that is not a tab, or a tab that no longer exists (worker closed), is returned as an error for
// the caller to log-and-continue; it never mutates unrelated state.
func StampWorkerOwner(ctx context.Context, workerTabORef, runORef, channelORef string) error {
	oref, err := waveobj.ParseORef(workerTabORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		return fmt.Errorf("bad worker oref %q: %w", workerTabORef, err)
	}
	meta := waveobj.MetaMapType{
		MetaKey_JarvisRunORef:     runORef,
		MetaKey_JarvisChannelORef: channelORef,
	}
	return UpdateObjectMeta(ctx, oref, meta, false)
}

// SetChannelRead stamps the channel's last-read timestamp.
func SetChannelRead(ctx context.Context, channelId string, ts int64) error {
	return DBUpdateFn(ctx, channelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		ch.Meta[MetaKey_ReadTs] = float64(ts)
	})
}
