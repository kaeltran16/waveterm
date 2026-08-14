// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func CreateEffort(ctx context.Context, e *waveobj.Effort) error {
	if e.OID == "" {
		e.OID = uuid.NewString()
	}
	if e.Status == "" {
		e.Status = "active"
	}
	e.Version = 1
	now := time.Now().UnixMilli()
	e.CreatedTs = now
	e.UpdatedTs = now
	return DBInsert(ctx, e)
}

func GetEffort(ctx context.Context, oid string) (*waveobj.Effort, error) {
	return DBMustGet[*waveobj.Effort](ctx, oid)
}

func GetAllEfforts(ctx context.Context) ([]*waveobj.Effort, error) {
	all, err := DBGetAllObjsByType[*waveobj.Effort](ctx, waveobj.OType_Effort)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].UpdatedTs > all[j].UpdatedTs })
	return all, nil
}

// UpdateEffort applies fn inside one DB transaction; a returned error rolls the write back.
func UpdateEffort(ctx context.Context, oid string, fn func(*waveobj.Effort) error) error {
	return DBUpdateFnErr(ctx, oid, func(e *waveobj.Effort) error {
		if err := fn(e); err != nil {
			return err
		}
		e.Version++
		e.UpdatedTs = time.Now().UnixMilli()
		return nil
	})
}
