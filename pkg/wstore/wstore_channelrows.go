// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// MetaKey_ChannelRowsBackfilled marks (on the MainServer singleton) that the Phase-1 channel-blob →
// row backfill has completed, so it runs at most once per data dir.
const MetaKey_ChannelRowsBackfilled = "channel:rowsbackfilled"

// BackfillChannelRows runs the one-shot Phase-1 backfill: it unpacks messages/runs embedded in existing
// channel blobs into db_channelmessage/db_run rows and stamps worker-tab meta. Gated by a MainServer
// marker so it is skipped on every boot after the first. Uses its own timeout (not InitWStore's 2s ctx)
// because a large store can take longer than steady-state init.
func BackfillChannelRows() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	done, err := channelRowsBackfillDone(ctx)
	if err != nil {
		return err
	}
	if done {
		return nil
	}
	if err := backfillChannelRowsOnce(ctx); err != nil {
		return err
	}
	return markChannelRowsBackfilled(ctx)
}

// backfillChannelRowsOnce is the idempotent core: read every channel once, upsert each embedded message/
// run as a row (stamping identity + parent link), and stamp each existing worker tab's owner meta. Safe
// to call repeatedly — dbUpsertObjTx and StampWorkerOwner are both idempotent.
func backfillChannelRowsOnce(ctx context.Context) error {
	channels, err := GetChannels(ctx)
	if err != nil {
		return err
	}
	var msgs, runs int
	for _, ch := range channels {
		err := WithTx(ctx, func(tx *TxWrap) error {
			for i := range ch.Messages {
				m := ch.Messages[i]
				stampMessageIdentity(ch.OID, &m)
				if err := dbUpsertObjTx(tx.Context(), &m); err != nil {
					return err
				}
				msgs++
			}
			for i := range ch.Runs {
				r := ch.Runs[i]
				stampRunIdentity(ch.OID, &r)
				if err := dbUpsertObjTx(tx.Context(), &r); err != nil {
					return err
				}
				runs++
			}
			return nil
		})
		if err != nil {
			return err
		}
		// stamp worker tabs outside the channel's write tx (each is its own object update); best-effort.
		channelORef := waveobj.MakeORef(waveobj.OType_Channel, ch.OID).String()
		for i := range ch.Runs {
			runORef := waveobj.MakeORef(waveobj.OType_Run, ch.Runs[i].ID).String()
			for _, phase := range ch.Runs[i].Phases {
				for _, workerORef := range phase.WorkerOrefs {
					if serr := StampWorkerOwner(ctx, workerORef, runORef, channelORef); serr != nil {
						log.Printf("backfill: stamp worker %s: %v", workerORef, serr)
					}
				}
			}
		}
	}
	log.Printf("channel-rows backfill: %d messages, %d runs across %d channels\n", msgs, runs, len(channels))
	return nil
}

func channelRowsBackfillDone(ctx context.Context) (bool, error) {
	ms, err := DBGetSingleton[*waveobj.MainServer](ctx)
	if err != nil || ms == nil {
		// no MainServer yet (fresh store) → not backfilled
		return false, nil
	}
	return ms.Meta.GetBool(MetaKey_ChannelRowsBackfilled, false), nil
}

func markChannelRowsBackfilled(ctx context.Context) error {
	ms, err := DBGetSingleton[*waveobj.MainServer](ctx)
	if err != nil || ms == nil {
		// no MainServer row yet: the mark will be set by whoever creates it, and the backfill core is
		// idempotent, so a re-run on next boot is harmless. Skip marking rather than racing wcore's
		// lazy create.
		return nil
	}
	if ms.Meta == nil {
		ms.Meta = waveobj.MetaMapType{}
	}
	ms.Meta[MetaKey_ChannelRowsBackfilled] = true
	return DBUpdate(ctx, ms)
}
