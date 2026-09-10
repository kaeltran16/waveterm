// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
)

// PendingAskRow is one persisted pending agent ask. The registry that owns these lives in
// pkg/agentask, which imports this package — so the row is spelled in wstore's own terms and the
// questions travel as the JSON blob agentask marshalled, rather than as a typed slice this package
// would need agentask to name.
//
// There is no wait column on purpose: a `wsh ask --wait` caller is an in-memory channel, so an ask
// with a waiter is never persisted (see agentask/durable.go) and a stored row is by construction a
// keystroke-delivered one.
type PendingAskRow struct {
	ORef      string `db:"oref"`
	AskId     string `db:"askid"`
	BlockId   string `db:"blockid"`
	Ts        int64  `db:"ts"`
	Prose     bool   `db:"prose"`
	Questions []byte `db:"questions"`
}

// PutPendingAsk upserts one pending ask. The oref is the primary key because an agent blocks on one
// question at a time, so a second ask for the same block replaces the first — the same rule the
// in-memory registry's map already enforces.
func PutPendingAsk(ctx context.Context, row PendingAskRow) error {
	return WithTx(ctx, func(tx *TxWrap) error {
		tx.Exec(`INSERT INTO db_pendingask (oref, askid, blockid, ts, prose, questions)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(oref) DO UPDATE SET
				askid = excluded.askid, blockid = excluded.blockid, ts = excluded.ts,
				prose = excluded.prose, questions = excluded.questions`,
			row.ORef, row.AskId, row.BlockId, row.Ts, row.Prose, row.Questions)
		return tx.Err
	})
}

// DeletePendingAsk forgets one pending ask. Deleting a row that is not there is not an error: the
// caller is a retirement path, and every retirement path can legitimately run twice.
func DeletePendingAsk(ctx context.Context, oref string) error {
	return WithTx(ctx, func(tx *TxWrap) error {
		tx.Exec(`DELETE FROM db_pendingask WHERE oref = ?`, oref)
		return tx.Err
	})
}

// GetPendingAsks returns every persisted pending ask. The table is bounded by the number of blocks
// that can be simultaneously blocked on a question, so it is read whole.
func GetPendingAsks(ctx context.Context) ([]PendingAskRow, error) {
	return WithReadTxRtn(ctx, func(tx *TxWrap) ([]PendingAskRow, error) {
		var rows []PendingAskRow
		tx.Select(&rows, `SELECT oref, askid, blockid, ts, prose, questions FROM db_pendingask
			ORDER BY ts ASC`)
		if tx.Err != nil {
			return nil, tx.Err
		}
		return rows, nil
	})
}
