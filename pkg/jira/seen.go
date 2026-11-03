// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/effortstore"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

type seenEntry struct {
	ticket wshrpc.JiraTicket
	ts     int64
}

// every ticket Arc saw this wavesrv run, by normalized key: creating or retargeting an initiative
// attaches it without another Jira call
var seenCache = struct {
	sync.Mutex
	byKey map[string]seenEntry
}{byKey: map[string]seenEntry{}}

// CopyOf is the last-seen copy of t; it keeps prev's LastPost, since a read of the ticket says nothing
// about Arc's posts.
func CopyOf(t wshrpc.JiraTicket, via string, now int64, prev *waveobj.EffortJira) *waveobj.EffortJira {
	c := &waveobj.EffortJira{
		Summary:        t.Summary,
		Type:           t.Type,
		Status:         t.Status,
		StatusCategory: t.StatusCategory,
		Description:    t.Description,
		Acceptance:     slices.Clone(t.Acceptance),
		SeenTs:         now,
		SeenVia:        via,
	}
	if prev != nil {
		c.LastPost = prev.Clone().LastPost
	}
	return c
}

// RecordSeen writes t's copy onto every initiative whose ticket is t's key (archived ones included) and
// caches t.
func RecordSeen(ctx context.Context, t wshrpc.JiraTicket, via string, now int64) error {
	key := NormalizeKey(t.Key)
	if key == "" {
		return fmt.Errorf("recording Jira ticket: %q is not an issue key", t.Key)
	}
	seenCache.Lock()
	seenCache.byKey[key] = seenEntry{ticket: t, ts: now}
	seenCache.Unlock()
	all, err := effortstore.GetAll(ctx)
	if err != nil {
		return fmt.Errorf("recording %s on its initiatives: %w", key, err)
	}
	var errs []error
	for _, e := range all {
		if NormalizeKey(e.Ticket) != key {
			continue
		}
		err := effortstore.Update(ctx, e.OID, func(cur *waveobj.Effort) error {
			// the ticket may have changed since the listing
			if NormalizeKey(cur.Ticket) == key {
				cur.Jira = CopyOf(t, via, now, cur.Jira)
			}
			return nil
		})
		if err != nil {
			errs = append(errs, fmt.Errorf("recording %s on initiative %s: %w", key, e.OID, err))
		}
	}
	return errors.Join(errs...)
}

// Cached is the ticket Arc last saw for key this run, with when it saw it.
func Cached(key string) (wshrpc.JiraTicket, int64, bool) {
	seenCache.Lock()
	defer seenCache.Unlock()
	entry, ok := seenCache.byKey[NormalizeKey(key)]
	return entry.ticket, entry.ts, ok
}

// the outcome of the last Jira call, for Settings > Jira without a call of its own
var connMem = struct {
	sync.Mutex
	conn wshrpc.JiraConnection
}{}

// NoteConnection records a Jira call's outcome. Every call moves CheckedTs and Error; only a success
// moves LastOkTs, and the display name when the call knows it, so a refusal keeps when Jira last answered.
func NoteConnection(displayName string, err error, now int64) {
	connMem.Lock()
	defer connMem.Unlock()
	c := &connMem.conn
	c.CheckedTs = now
	if err != nil {
		c.Ok = false
		c.Error = err.Error()
		return
	}
	c.Ok = true
	c.Error = ""
	c.LastOkTs = now
	if strings.TrimSpace(displayName) != "" {
		c.DisplayName = displayName
	}
}

// LastConnection is what the last Jira call learned: Ok, DisplayName, CheckedTs, LastOkTs and Error.
func LastConnection() wshrpc.JiraConnection {
	connMem.Lock()
	defer connMem.Unlock()
	return connMem.conn
}

func setConnection(c wshrpc.JiraConnection) {
	connMem.Lock()
	connMem.conn = c
	connMem.Unlock()
}
