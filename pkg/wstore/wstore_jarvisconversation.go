// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"sort"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func CreateJarvisConversation(ctx context.Context, oid, title, scopeMode, projectPath string, attachedORefs []string) (*waveobj.JarvisConvo, error) {
	now := time.Now().UnixMilli()
	convo := &waveobj.JarvisConvo{
		OID:           oid,
		Title:         title,
		ScopeMode:     scopeMode,
		ProjectPath:   projectPath,
		AttachedORefs: attachedORefs,
		Turns:         []waveobj.JarvisConvoTurn{},
		CreatedTs:     now,
		UpdatedTs:     now,
		Meta:          make(waveobj.MetaMapType),
	}
	if err := DBInsert(ctx, convo); err != nil {
		return nil, err
	}
	return convo, nil
}

func GetJarvisConversation(ctx context.Context, id string) (*waveobj.JarvisConvo, error) {
	return DBMustGet[*waveobj.JarvisConvo](ctx, id)
}

// GetJarvisConversations returns all conversations, newest-first by UpdatedTs.
func GetJarvisConversations(ctx context.Context) ([]*waveobj.JarvisConvo, error) {
	all, err := DBGetAllObjsByType[*waveobj.JarvisConvo](ctx, waveobj.OType_JarvisConversation)
	if err != nil {
		return nil, err
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].UpdatedTs != all[j].UpdatedTs {
			return all[i].UpdatedTs > all[j].UpdatedTs
		}
		return all[i].OID < all[j].OID
	})
	return all, nil
}

// AppendJarvisTurn appends a turn and bumps UpdatedTs. Turns are immutable/append-only.
func AppendJarvisTurn(ctx context.Context, id string, turn waveobj.JarvisConvoTurn) error {
	return DBUpdateFn(ctx, id, func(c *waveobj.JarvisConvo) {
		c.Turns = append(c.Turns, turn)
		c.UpdatedTs = time.Now().UnixMilli()
	})
}

func DeleteJarvisConversation(ctx context.Context, id string) error {
	return DBDelete(ctx, waveobj.OType_JarvisConversation, id)
}
