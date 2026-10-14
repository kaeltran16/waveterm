// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"context"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func scan(ctx context.Context) ([]wshrpc.StorageItem, []wshrpc.StorageScanError, error) {
	return nil, nil, errors.New("storage scan is not built yet")
}
