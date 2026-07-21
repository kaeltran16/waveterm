// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// WithReadTxRtn returns data committed through the write handle.
func TestReadPoolReadsCommittedData(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "read-pool", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	name, err := WithReadTxRtn(ctx, func(tx *TxWrap) (string, error) {
		return tx.GetString("SELECT json_extract(data, '$.name') FROM db_channel WHERE oid = ?", ch.OID), nil
	})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if name != "read-pool" {
		t.Fatalf("want name %q, got %q", "read-pool", name)
	}
}

// The read pool is opened mode=ro: a write attempted through it errors, catching a mis-audited
// "read" helper at runtime instead of letting it silently bypass the write connection.
func TestReadPoolRejectsWrites(t *testing.T) {
	ctx := context.Background()
	err := WithReadTx(ctx, func(tx *TxWrap) error {
		tx.Exec("INSERT INTO db_channel (oid, version, data) VALUES (?, ?, ?)", "ro-test", 1, "{}")
		return tx.Err
	})
	if err == nil {
		t.Fatal("expected a write through the read-only pool to error, got nil")
	}
}

// A top-level read must complete promptly while a writer holds the single write connection, instead
// of queueing behind it. Before the read helpers move to the pool this FAILS (the read blocks on the
// one write conn); after, it passes (the read uses the separate ro pool + WAL snapshot).
func TestReadsDoNotBlockBehindWriter(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "no-block", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	writeHeld := make(chan struct{})
	writeRelease := make(chan struct{})
	go func() {
		_ = WithTx(ctx, func(tx *TxWrap) error {
			close(writeHeld)
			<-writeRelease // hold the single write connection open
			return nil
		})
	}()
	<-writeHeld

	done := make(chan error, 1)
	go func() {
		_, e := DBMustGet[*waveobj.Channel](ctx, ch.OID)
		done <- e
	}()
	select {
	case e := <-done:
		close(writeRelease)
		if e != nil {
			t.Fatalf("read failed: %v", e)
		}
	case <-time.After(2 * time.Second):
		close(writeRelease)
		t.Fatal("read blocked behind the held write transaction")
	}
}

// A read that reuses an enclosing write tx (called with tx.Context()) must see that tx's uncommitted
// row — proving nested reads stay on the write connection and are NOT diverted to the ro pool (which
// could not see uncommitted data). Guards the txwrap-reuse assumption the whole phase rests on.
func TestNestedReadReusesWriteTx(t *testing.T) {
	ctx := context.Background()
	oid := uuid.NewString()
	err := WithTx(ctx, func(tx *TxWrap) error {
		ch := &waveobj.Channel{OID: oid, Name: "nested", Meta: waveobj.MetaMapType{}}
		if e := DBInsert(tx.Context(), ch); e != nil {
			return e
		}
		got, e := DBMustGet[*waveobj.Channel](tx.Context(), oid)
		if e != nil {
			return e
		}
		if got.Name != "nested" {
			t.Errorf("nested read did not see the uncommitted row (name=%q)", got.Name)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("tx failed: %v", err)
	}
}

// The A3 correctness invariant: PostChannelMessageIf's cond-check + append run in one WithTx on the
// write handle, so concurrent posters still serialize even with the read pool present. With a cond
// of "only if empty", exactly one of N racing posters may post. Run under -race.
func TestPostChannelMessageIfSerializesUnderRace(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "serialize", "/p")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	var wg sync.WaitGroup
	var posted int32
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			msg := NewChannelMessage("human", "you", "only-one", "", int64(n))
			ok, e := PostChannelMessageIf(ctx, ch.OID, msg, func(c *waveobj.Channel) bool {
				return len(c.Messages) == 0
			})
			if e == nil && ok {
				atomic.AddInt32(&posted, 1)
			}
		}(i)
	}
	wg.Wait()

	if posted != 1 {
		t.Fatalf("want exactly 1 successful post (serialized), got %d", posted)
	}
	got, err := DBMustGet[*waveobj.Channel](ctx, ch.OID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if len(got.Messages) != 1 {
		t.Fatalf("want 1 message persisted, got %d", len(got.Messages))
	}
}
