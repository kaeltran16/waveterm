// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"encoding/json"
	"fmt"
)

// UsageBucket is one kept row of Usage: a session's tokens with one model on one local day. Its fields match
// usagestats.Bucket's one for one, so that package converts between the two directly.
type UsageBucket struct {
	Harness         string   `db:"harness"`
	Provider        string   `db:"provider"`
	Model           string   `db:"model"`
	Day             string   `db:"day"`
	Session         string   `db:"session"`
	Input           int      `db:"input"`
	Output          int      `db:"output"`
	Reasoning       int      `db:"reasoning"`
	CacheRead       int      `db:"cacheread"`
	CacheCreate     int      `db:"cachecreate"`
	CacheCreate1h   int      `db:"cachecreate1h"`
	ReportedCostUsd *float64 `db:"reportedcostusd"`
	Msgs            int      `db:"msgs"`
}

// UsageSession is a kept session's cwd and title. Its fields match usagestats.SessionMeta's one for one.
type UsageSession struct {
	Harness string `db:"harness"`
	Session string `db:"session"`
	Cwd     string `db:"cwd"`
	Title   string `db:"title"`
}

// UsageSessionKey names a session.
type UsageSessionKey struct {
	Harness string
	Session string
}

type usageBucketKey struct{ harness, session, provider, model, day string }

func (b UsageBucket) key() usageBucketKey {
	return usageBucketKey{b.Harness, b.Session, b.Provider, b.Model, b.Day}
}

// tokens is the total the Usage surface counts: CacheCreate1h is a subset of CacheCreate.
func (b UsageBucket) tokens() int {
	return b.Input + b.Output + b.Reasoning + b.CacheRead + b.CacheCreate
}

func (b UsageBucket) equal(o UsageBucket) bool {
	sameCost := (b.ReportedCostUsd == nil) == (o.ReportedCostUsd == nil) &&
		(b.ReportedCostUsd == nil || *b.ReportedCostUsd == *o.ReportedCostUsd)
	b.ReportedCostUsd, o.ReportedCostUsd = nil, nil
	return sameCost && b == o
}

const usageBucketCols = `harness, session, provider, model, day, input, output, reasoning, cacheread, cachecreate,
	cachecreate1h, reportedcostusd, msgs`

// the token total of a row, as UsageBucket.tokens counts it
const usageTokensSQL = `%[1]s.input + %[1]s.output + %[1]s.reasoning + %[1]s.cacheread + %[1]s.cachecreate`

var upsertUsageBucketSQL = `INSERT INTO db_usagebucket (` + usageBucketCols + `)
	VALUES (:harness, :session, :provider, :model, :day, :input, :output, :reasoning, :cacheread, :cachecreate,
		:cachecreate1h, :reportedcostusd, :msgs)
	ON CONFLICT (harness, session, provider, model, day) DO UPDATE SET
		input = excluded.input, output = excluded.output, reasoning = excluded.reasoning,
		cacheread = excluded.cacheread, cachecreate = excluded.cachecreate, cachecreate1h = excluded.cachecreate1h,
		reportedcostusd = excluded.reportedcostusd, msgs = excluded.msgs
	WHERE ` + fmt.Sprintf(usageTokensSQL, "excluded") + ` >= ` + fmt.Sprintf(usageTokensSQL, "db_usagebucket")

// KeepUsage stores the usage a scan read and returns how many rows it wrote. A bucket replaces the stored one of
// its key only when its token total is at least the stored one's: a key's true usage never shrinks, so a smaller
// one means the scan saw part of it (a purged subagent file, a window's edge). Stored rows the batch does not name
// stay, except for the sessions in whole, whose batch rows are their whole record: their stored rows on keys the
// batch lacks are deleted. A session's cwd or title replaces the stored one only when it is not empty. Rows that
// would not change are not written, so a repeat scan with no new usage costs a read and no write.
func KeepUsage(ctx context.Context, buckets []UsageBucket, sessions []UsageSession, whole []UsageSessionKey) (int, error) {
	if len(buckets) == 0 && len(sessions) == 0 {
		return 0, nil
	}
	storedBuckets, storedSessions, err := usageOfSessions(ctx, buckets, sessions)
	if err != nil {
		return 0, err
	}
	var upserts []UsageBucket
	named := map[usageBucketKey]bool{}
	for _, b := range buckets {
		named[b.key()] = true
		if s, ok := storedBuckets[b.key()]; ok && (b.tokens() < s.tokens() || b.equal(s)) {
			continue
		}
		upserts = append(upserts, b)
	}
	inWhole := map[UsageSessionKey]bool{}
	for _, k := range whole {
		inWhole[k] = true
	}
	var stale []UsageBucket
	for k, s := range storedBuckets {
		if inWhole[UsageSessionKey{s.Harness, s.Session}] && !named[k] {
			stale = append(stale, s)
		}
	}
	var metas []UsageSession
	for _, m := range sessions {
		stored := storedSessions[UsageSessionKey{m.Harness, m.Session}]
		if (m.Cwd == "" || m.Cwd == stored.Cwd) && (m.Title == "" || m.Title == stored.Title) {
			continue
		}
		metas = append(metas, m)
	}
	written := len(upserts) + len(stale) + len(metas)
	if written == 0 {
		return 0, nil
	}
	return written, WithTx(ctx, func(tx *TxWrap) error {
		for _, b := range upserts {
			tx.NamedExec(upsertUsageBucketSQL, b)
		}
		for _, s := range stale {
			tx.Exec(`DELETE FROM db_usagebucket WHERE harness = ? AND session = ? AND provider = ? AND model = ? AND day = ?`,
				s.Harness, s.Session, s.Provider, s.Model, s.Day)
		}
		for _, m := range metas {
			tx.NamedExec(`INSERT INTO db_usagesession (harness, session, cwd, title) VALUES (:harness, :session, :cwd, :title)
				ON CONFLICT (harness, session) DO UPDATE SET
					cwd = CASE WHEN excluded.cwd <> '' THEN excluded.cwd ELSE cwd END,
					title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END`, m)
		}
		return tx.Err
	})
}

// usageOfSessions reads every stored row of the sessions buckets and sessions name. The names go as one JSON
// argument, since a batch can name more sessions than SQLite allows bound parameters.
func usageOfSessions(ctx context.Context, buckets []UsageBucket, sessions []UsageSession) (map[usageBucketKey]UsageBucket, map[UsageSessionKey]UsageSession, error) {
	seen := map[UsageSessionKey]bool{}
	var names [][2]string
	add := func(k UsageSessionKey) {
		if !seen[k] {
			seen[k] = true
			names = append(names, [2]string{k.Harness, k.Session})
		}
	}
	for _, b := range buckets {
		add(UsageSessionKey{b.Harness, b.Session})
	}
	for _, s := range sessions {
		add(UsageSessionKey{s.Harness, s.Session})
	}
	namesJSON, err := json.Marshal(names)
	if err != nil {
		return nil, nil, err
	}
	const inNames = `(harness, session) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`
	type stored struct {
		buckets  []UsageBucket
		sessions []UsageSession
	}
	rows, err := WithReadTxRtn(ctx, func(tx *TxWrap) (stored, error) {
		var s stored
		tx.Select(&s.buckets, `SELECT `+usageBucketCols+` FROM db_usagebucket WHERE `+inNames, string(namesJSON))
		tx.Select(&s.sessions, `SELECT harness, session, cwd, title FROM db_usagesession WHERE `+inNames, string(namesJSON))
		return s, tx.Err
	})
	if err != nil {
		return nil, nil, fmt.Errorf("reading kept usage: %w", err)
	}
	byKey := make(map[usageBucketKey]UsageBucket, len(rows.buckets))
	for _, b := range rows.buckets {
		byKey[b.key()] = b
	}
	bySession := make(map[UsageSessionKey]UsageSession, len(rows.sessions))
	for _, s := range rows.sessions {
		bySession[UsageSessionKey{s.Harness, s.Session}] = s
	}
	return byKey, bySession, nil
}

// GetUsage returns every kept bucket from sinceDay ("YYYY-MM-DD"; "" for all of them) on, and one UsageSession for
// each session among them, with an empty cwd and title where none was kept.
func GetUsage(ctx context.Context, sinceDay string) ([]UsageBucket, []UsageSession, error) {
	type kept struct {
		buckets  []UsageBucket
		sessions []UsageSession
	}
	rows, err := WithReadTxRtn(ctx, func(tx *TxWrap) (kept, error) {
		var k kept
		tx.Select(&k.buckets, `SELECT `+usageBucketCols+` FROM db_usagebucket WHERE day >= ?`, sinceDay)
		tx.Select(&k.sessions, `SELECT b.harness, b.session, COALESCE(s.cwd, '') AS cwd, COALESCE(s.title, '') AS title
			FROM (SELECT DISTINCT harness, session FROM db_usagebucket WHERE day >= ?) b
			LEFT JOIN db_usagesession s ON s.harness = b.harness AND s.session = b.session`, sinceDay)
		return k, tx.Err
	})
	if err != nil {
		return nil, nil, fmt.Errorf("reading kept usage since %q: %w", sinceDay, err)
	}
	return rows.buckets, rows.sessions, nil
}
