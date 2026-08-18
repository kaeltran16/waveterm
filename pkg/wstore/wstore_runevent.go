// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// maxRunEventsPerRun bounds each run's log; pruning happens on append (bounded work).
const maxRunEventsPerRun = 1000

// runEventRow is the db_runevent scan struct (sqlx db tags).
type runEventRow struct {
	OID       string `db:"oid"`
	RunID     string `db:"runid"`
	ChannelID string `db:"channelid"`
	Ts        int64  `db:"ts"`
	Kind      string `db:"kind"`
	PhaseIdx  *int   `db:"phaseidx"`
	Data      []byte `db:"data"`
}

// AppendRunEvent appends one lifecycle event to a run's log, prunes to the newest
// maxRunEventsPerRun rows, and returns the persisted event (id + ts) so the caller can broadcast the
// exact row it stored. Callers treat failures as non-fatal telemetry — the run transition they
// accompany has already persisted; a log write must never fail the run it describes.
func AppendRunEvent(ctx context.Context, channelId, runId, kind string, phaseIdx *int, detail any) (waveobj.RunEvent, error) {
	detailJSON, err := json.Marshal(detail)
	if err != nil {
		return waveobj.RunEvent{}, fmt.Errorf("run event detail: %w", err)
	}
	ev := waveobj.RunEvent{
		ID: uuid.NewString(), RunID: runId, ChannelID: channelId,
		Ts: time.Now().UnixMilli(), Kind: kind, PhaseIdx: phaseIdx, Detail: detailJSON,
	}
	return ev, WithTx(ctx, func(tx *TxWrap) error {
		tx.Exec(`INSERT INTO db_runevent (oid, runid, channelid, ts, kind, phaseidx, data)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			ev.ID, runId, channelId, ev.Ts, kind, phaseIdx, detailJSON)
		if tx.Err != nil {
			return tx.Err
		}
		tx.Exec(`DELETE FROM db_runevent WHERE runid = ? AND rowid NOT IN (
			SELECT rowid FROM db_runevent WHERE runid = ? ORDER BY ts DESC, rowid DESC LIMIT ?)`,
			runId, runId, maxRunEventsPerRun)
		return tx.Err
	})
}

// QueryRunEvents returns a run's events newest-first, capped at limit rows (0/negative -> 200, max 500).
func QueryRunEvents(ctx context.Context, channelId, runId string, limit int) ([]waveobj.RunEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	return WithReadTxRtn(ctx, func(tx *TxWrap) ([]waveobj.RunEvent, error) {
		var rows []runEventRow
		tx.Select(&rows, `SELECT oid, runid, channelid, ts, kind, phaseidx, data FROM db_runevent
			WHERE runid = ? AND channelid = ?
			ORDER BY ts DESC, rowid DESC
			LIMIT ?`, runId, channelId, limit)
		if tx.Err != nil {
			return nil, tx.Err
		}
		out := make([]waveobj.RunEvent, 0, len(rows))
		for _, r := range rows {
			out = append(out, waveobj.RunEvent{
				ID: r.OID, RunID: r.RunID, ChannelID: r.ChannelID, Ts: r.Ts,
				Kind: r.Kind, PhaseIdx: r.PhaseIdx, Detail: json.RawMessage(r.Data),
			})
		}
		return out, nil
	})
}