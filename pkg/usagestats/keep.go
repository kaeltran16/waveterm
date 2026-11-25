// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package usagestats

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Keep stores the buckets and session metas a scan read, so Usage keeps them once their transcripts are gone.
// A stored bucket only grows, and a Codex session's buckets are its whole record (one running total, dated by
// its last token count), so keeping one on a later day drops its earlier day's. wstore.KeepUsage has the rules.
func Keep(ctx context.Context, buckets []Bucket, metas []SessionMeta) error {
	rows := make([]wstore.UsageBucket, len(buckets))
	var whole []wstore.UsageSessionKey
	for i, b := range buckets {
		rows[i] = wstore.UsageBucket(b)
		if b.Harness == scanCodex.harness() {
			whole = append(whole, wstore.UsageSessionKey{Harness: b.Harness, Session: b.Session})
		}
	}
	sessions := make([]wstore.UsageSession, len(metas))
	for i, m := range metas {
		sessions[i] = wstore.UsageSession(m)
	}
	if _, err := wstore.KeepUsage(ctx, rows, sessions, whole); err != nil {
		return fmt.Errorf("keeping usage: %w", err)
	}
	return nil
}

// Kept returns every kept bucket from sinceDay ("YYYY-MM-DD"; "" for all of them) on, and the kept meta of each
// session among them.
func Kept(ctx context.Context, sinceDay string) ([]Bucket, []SessionMeta, error) {
	rows, sessions, err := wstore.GetUsage(ctx, sinceDay)
	if err != nil {
		return nil, nil, err
	}
	buckets := make([]Bucket, len(rows))
	for i, r := range rows {
		buckets[i] = Bucket(r)
	}
	metas := make([]SessionMeta, len(sessions))
	for i, s := range sessions {
		metas[i] = SessionMeta(s)
	}
	return buckets, metas, nil
}

// KeepTranscriptDirs keeps the usage of every transcript under dirs, each a Claude project folder or a Pi session
// folder, read all-time with their subagents' files and named as the Usage scan names them. Storage runs it
// before clearing the folders.
func KeepTranscriptDirs(ctx context.Context, dirs []string) error {
	var files []scanFile
	for _, dir := range dirs {
		root := filepath.Dir(dir)
		if isPiTranscriptPath(dir) {
			files = append(files, walkPiDir(root, dir, time.Time{})...)
		} else {
			files = append(files, walkClaudeDir(root, dir, time.Time{})...)
		}
	}
	buckets := bucket(dedupe(parseFiles(files)))
	return Keep(ctx, buckets, sessionMetas(buckets, files))
}
