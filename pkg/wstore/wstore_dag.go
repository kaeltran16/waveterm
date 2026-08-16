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

// GetDagsByStatus lists every dag row with the given derived status (e.g. "running") — the watchdog's
// iteration set.
func GetDagsByStatus(ctx context.Context, status string) ([]*waveobj.TaskGroup, error) {
	return WithReadTxRtn(ctx, func(tx *TxWrap) ([]*waveobj.TaskGroup, error) {
		query := `SELECT oid, version, data FROM db_dag
			WHERE json_extract(data, '$.status') = ?
			ORDER BY json_extract(data, '$.updatedts') ASC`
		var rows []idDataType
		tx.Select(&rows, query, status)
		out := make([]*waveobj.TaskGroup, 0, len(rows))
		for _, row := range rows {
			obj, err := waveobj.FromJson(row.Data)
			if err != nil {
				return nil, err
			}
			waveobj.SetVersion(obj, row.Version)
			out = append(out, obj.(*waveobj.TaskGroup))
		}
		return out, nil
	})
}

// UpdateDag applies fn under the optimistic-concurrency version check and bumps Version.
func UpdateDag(ctx context.Context, dagId string, fn func(*waveobj.TaskGroup) error) error {
	return DBUpdateFnErr[*waveobj.TaskGroup](ctx, dagId, fn)
}
