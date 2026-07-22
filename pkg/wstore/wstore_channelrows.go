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

// MetaKey_ConciergeOwnersBackfilled marks the one-shot Phase-2 concierge-worker owner stamp as complete.
// Separate from MetaKey_ChannelRowsBackfilled (that Phase-1 marker already fired on existing data dirs).
const MetaKey_ConciergeOwnersBackfilled = "channel:conciergeownersbackfilled"

// BackfillChannelRows runs the one-shot backfills: Phase-1 unpacks messages/runs embedded in existing
// channel blobs into db_channelmessage/db_run rows and stamps run-worker-tab meta; Phase-2 stamps
// concierge/gatekeeper worker tabs referenced by existing dispatch/directive messages. Each pass is
// gated by its own MainServer marker so it is skipped on every boot after the first. Uses its own timeout
// (not InitWStore's 2s ctx) because a large store can take longer than steady-state init.
func BackfillChannelRows() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	done, err := singletonMetaBool(ctx, MetaKey_ChannelRowsBackfilled)
	if err != nil {
		return err
	}
	if !done {
		if err := backfillChannelRowsOnce(ctx); err != nil {
			return err
		}
		if err := markSingletonMetaBool(ctx, MetaKey_ChannelRowsBackfilled); err != nil {
			return err
		}
	}
	// Phase-2 concierge-owner stamp (separate marker; the Phase-1 marker already fired on existing dirs).
	done2, err := singletonMetaBool(ctx, MetaKey_ConciergeOwnersBackfilled)
	if err != nil {
		return err
	}
	if !done2 {
		if err := backfillConciergeOwnersOnce(ctx); err != nil {
			return err
		}
		if err := markSingletonMetaBool(ctx, MetaKey_ConciergeOwnersBackfilled); err != nil {
			return err
		}
	}
	return nil
}

// backfillConciergeOwnersOnce stamps jarvis:channeloref onto every worker tab referenced by an existing
// dispatch/directive message, so concierge/gatekeeper workers created before Phase 2 resolve their channel
// by meta. Idempotent (StampWorkerOwner just re-sets the same key). Best-effort per worker.
func backfillConciergeOwnersOnce(ctx context.Context) error {
	channels, err := GetChannels(ctx)
	if err != nil {
		return err
	}
	stamped := 0
	for _, ch := range channels {
		channelORef := waveobj.MakeORef(waveobj.OType_Channel, ch.OID).String()
		for i := range ch.Messages {
			m := ch.Messages[i]
			if m.Kind != "dispatch" && m.Kind != "directive" {
				continue
			}
			oref, perr := waveobj.ParseORef(m.RefORef)
			if perr != nil || oref.OType != waveobj.OType_Tab {
				continue
			}
			if serr := StampWorkerOwner(ctx, m.RefORef, "", channelORef); serr != nil {
				log.Printf("concierge backfill: stamp %s: %v", m.RefORef, serr)
				continue
			}
			stamped++
		}
	}
	log.Printf("concierge-owners backfill: stamped %d workers across %d channels\n", stamped, len(channels))
	return nil
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

// singletonMetaBool reads a boolean flag off the MainServer singleton meta. A fresh store with no
// MainServer row yet reports false (not done). Used to gate the one-shot backfills.
func singletonMetaBool(ctx context.Context, key string) (bool, error) {
	ms, err := DBGetSingleton[*waveobj.MainServer](ctx)
	if err != nil || ms == nil {
		// no MainServer yet (fresh store) → not set
		return false, nil
	}
	return ms.Meta.GetBool(key, false), nil
}

// markSingletonMetaBool sets a boolean flag on the MainServer singleton meta.
func markSingletonMetaBool(ctx context.Context, key string) error {
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
	ms.Meta[key] = true
	return DBUpdate(ctx, ms)
}
