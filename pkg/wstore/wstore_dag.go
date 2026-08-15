package wstore

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// AppendDag persists a new TaskGroup row (db_dag) at version 1.
func AppendDag(ctx context.Context, dag *waveobj.TaskGroup) error {
	return DBInsert(ctx, dag)
}

// GetDag reads a TaskGroup by id from its db_dag row.
func GetDag(ctx context.Context, dagId string) (*waveobj.TaskGroup, error) {
	return DBMustGet[*waveobj.TaskGroup](ctx, dagId)
}

// UpdateDag applies fn under the optimistic-concurrency version check and bumps Version.
func UpdateDag(ctx context.Context, dagId string, fn func(*waveobj.TaskGroup) error) error {
	return DBUpdateFnErr[*waveobj.TaskGroup](ctx, dagId, fn)
}
