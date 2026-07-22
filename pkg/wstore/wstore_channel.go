// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"fmt"
	"log"
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

// stampDispatchOwner is the concierge/gatekeeper analog of spawnRunWorkers' run stamp: when a dispatch or
// directive message links a worker tab to a channel, record the channel oref on that worker's meta so the
// worker→channel lookup (handleAsk/OnWorkerExit) is a direct read, not a full-channel scan. Best-effort.
func stampDispatchOwner(ctx context.Context, channelId string, msg *waveobj.ChannelMessage) {
	if msg.Kind != "dispatch" && msg.Kind != "directive" {
		return
	}
	oref, err := waveobj.ParseORef(msg.RefORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		return
	}
	channelORef := waveobj.MakeORef(waveobj.OType_Channel, channelId).String()
	if serr := StampWorkerOwner(ctx, msg.RefORef, "", channelORef); serr != nil {
		log.Printf("stampDispatchOwner: %v", serr)
	}
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
	stampDispatchOwner(ctx, channelId, &msg)
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
	if posted {
		stampDispatchOwner(ctx, channelId, &msg)
	}
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

// GetRun reads a single run by id from its db_run row (runId == oid), verifying it belongs to channelId.
// Row-backed (Phase 2); the channel blob is no longer scanned for this lookup.
func GetRun(ctx context.Context, channelId, runId string) (*waveobj.Run, error) {
	run, err := DBGet[*waveobj.Run](ctx, runId)
	if err != nil {
		return nil, err
	}
	if run == nil {
		return nil, fmt.Errorf("run %q not found", runId)
	}
	if run.ChannelOID != channelId {
		return nil, fmt.Errorf("run %q not in channel %q", runId, channelId)
	}
	return run, nil
}

// GetChannelRuns returns the db_run rows for a channel (indexed on channeloid), in createdts order —
// the row-backed replacement for reading Channel.Runs off the blob. Pure read (read pool).
func GetChannelRuns(ctx context.Context, channelId string) ([]*waveobj.Run, error) {
	return WithReadTxRtn(ctx, func(tx *TxWrap) ([]*waveobj.Run, error) {
		query := `SELECT oid, version, data FROM db_run
			WHERE json_extract(data, '$.channeloid') = ?
			ORDER BY json_extract(data, '$.createdts') ASC`
		var rows []idDataType
		tx.Select(&rows, query, channelId)
		rtn := make([]*waveobj.Run, 0, len(rows))
		for _, row := range rows {
			obj, err := waveobj.FromJson(row.Data)
			if err != nil {
				return nil, err
			}
			waveobj.SetVersion(obj, row.Version)
			rtn = append(rtn, obj.(*waveobj.Run))
		}
		return rtn, nil
	})
}

// DefaultChannelMessageLimit bounds a message-window fetch. Generous default per the design (true
// lazy "load older" UI is a follow-on); callers pass an explicit limit to paginate.
const DefaultChannelMessageLimit = 500

// GetChannelMessages returns a chronological (ts-ascending) window of a channel's messages from
// db_channelmessage — the row-backed replacement for reading Channel.Messages off the blob. It selects
// newest-first (hitting idx_channelmessage_channeloid_ts) then reverses to ascending. before==0 means
// latest; before>0 returns only messages strictly older than that ts (load-older). Pure read.
func GetChannelMessages(ctx context.Context, channelId string, before int64, limit int) ([]*waveobj.ChannelMessage, error) {
	if limit <= 0 {
		limit = DefaultChannelMessageLimit
	}
	return WithReadTxRtn(ctx, func(tx *TxWrap) ([]*waveobj.ChannelMessage, error) {
		var rows []idDataType
		if before > 0 {
			tx.Select(&rows, `SELECT oid, version, data FROM db_channelmessage
				WHERE json_extract(data, '$.channeloid') = ? AND json_extract(data, '$.ts') < ?
				ORDER BY json_extract(data, '$.ts') DESC LIMIT ?`, channelId, before, limit)
		} else {
			tx.Select(&rows, `SELECT oid, version, data FROM db_channelmessage
				WHERE json_extract(data, '$.channeloid') = ?
				ORDER BY json_extract(data, '$.ts') DESC LIMIT ?`, channelId, limit)
		}
		rtn := make([]*waveobj.ChannelMessage, 0, len(rows))
		for _, row := range rows {
			obj, err := waveobj.FromJson(row.Data)
			if err != nil {
				return nil, err
			}
			waveobj.SetVersion(obj, row.Version)
			rtn = append(rtn, obj.(*waveobj.ChannelMessage))
		}
		// reverse to chronological ascending (matches blob order the FE renders)
		for i, j := 0, len(rtn)-1; i < j; i, j = i+1, j-1 {
			rtn[i], rtn[j] = rtn[j], rtn[i]
		}
		return rtn, nil
	})
}

// GetChannelProjectPaths returns channelOID -> projectpath for every channel via a scalar json_extract
// query — no blob deserialize. Used by radar collect to pick matching channels without loading history.
func GetChannelProjectPaths(ctx context.Context) (map[string]string, error) {
	return WithReadTxRtn(ctx, func(tx *TxWrap) (map[string]string, error) {
		type row struct {
			OId         string `db:"oid"`
			ProjectPath string `db:"projectpath"`
		}
		var rows []row
		tx.Select(&rows, `SELECT oid, COALESCE(json_extract(data, '$.projectpath'), '') AS projectpath FROM db_channel`)
		m := make(map[string]string, len(rows))
		for _, r := range rows {
			m[r.OId] = r.ProjectPath
		}
		return m, nil
	})
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

// StampWorkerOwner records the owning run/channel oref on a worker tab's meta (only the non-empty ones —
// concierge workers pass runORef=="" and get channeloref only). Best-effort: a non-tab oref or a gone
// tab returns an error for the caller to log-and-continue; never mutates unrelated state.
func StampWorkerOwner(ctx context.Context, workerTabORef, runORef, channelORef string) error {
	oref, err := waveobj.ParseORef(workerTabORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		return fmt.Errorf("bad worker oref %q: %w", workerTabORef, err)
	}
	meta := waveobj.MetaMapType{}
	if runORef != "" {
		meta[MetaKey_JarvisRunORef] = runORef
	}
	if channelORef != "" {
		meta[MetaKey_JarvisChannelORef] = channelORef
	}
	if len(meta) == 0 {
		return nil
	}
	return UpdateObjectMeta(ctx, oref, meta, false)
}

// GetWorkerOwner reads the owning run:/channel: orefs stamped on a worker tab's meta (Phase-1/2 stamp).
// Empty strings when a key is absent. Errors only for a non-tab oref or a missing tab.
func GetWorkerOwner(ctx context.Context, workerTabORef string) (runORef string, channelORef string, err error) {
	oref, perr := waveobj.ParseORef(workerTabORef)
	if perr != nil || oref.OType != waveobj.OType_Tab {
		return "", "", fmt.Errorf("bad worker oref %q: %w", workerTabORef, perr)
	}
	tab, gerr := DBMustGet[*waveobj.Tab](ctx, oref.OID)
	if gerr != nil {
		return "", "", gerr
	}
	return tab.Meta.GetString(MetaKey_JarvisRunORef, ""), tab.Meta.GetString(MetaKey_JarvisChannelORef, ""), nil
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
