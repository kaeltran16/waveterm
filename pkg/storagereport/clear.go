// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package storagereport

import (
	"context"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func clearItem(ctx context.Context, item wshrpc.StorageItem, force bool, tip string) (int64, error) {
	return 0, errors.New("storage scan is not built yet")
}
