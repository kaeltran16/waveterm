package wstore

import (
	"context"
	"fmt"

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

func GetDagsWithPendingCleanup(ctx context.Context) ([]*waveobj.TaskGroup, error) {
	return WithReadTxRtn(ctx, func(tx *TxWrap) ([]*waveobj.TaskGroup, error) {
		query := `SELECT oid, version, data FROM db_dag
			WHERE EXISTS (
				SELECT 1 FROM json_each(data, '$.tasks') AS task
				WHERE json_extract(task.value, '$.cleanuppending') = 1
				   OR json_extract(task.value, '$.cleanuperror') != ''
			)
			ORDER BY json_extract(data, '$.updatedts') ASC`
		var rows []idDataType
		tx.Select(&rows, query)
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

func CreateDagForRun(ctx context.Context, channelID string, runID string, proposed *waveobj.TaskGroup, transition func(*waveobj.Run) error) (dag *waveobj.TaskGroup, created bool, err error) {
	err = WithTx(ctx, func(tx *TxWrap) error {
		txCtx := tx.Context()
		ch, txErr := DBMustGet[*waveobj.Channel](txCtx, channelID)
		if txErr != nil {
			return fmt.Errorf("loading channel: %w", txErr)
		}
		var run *waveobj.Run
		for i := range ch.Runs {
			if ch.Runs[i].ID == runID {
				run = &ch.Runs[i]
				break
			}
		}
		if run == nil {
			return fmt.Errorf("run %q not found in channel", runID)
		}
		if run.DagORef != "" {
			existing, txErr := DBMustGet[*waveobj.TaskGroup](txCtx, run.DagORef)
			if txErr != nil {
				return txErr
			}
			dag = existing
			created = false
			return nil
		}
		if transition != nil {
			if txErr := transition(run); txErr != nil {
				return txErr
			}
		}
		run.DagORef = proposed.OID
		if txErr := DBInsert(txCtx, proposed); txErr != nil {
			return txErr
		}
		if txErr := DBUpdate(txCtx, ch); txErr != nil {
			return txErr
		}
		if txErr := dbUpsertObjTx(txCtx, run); txErr != nil {
			return txErr
		}
		dag = proposed
		created = true
		return nil
	})
	return dag, created, err
}
