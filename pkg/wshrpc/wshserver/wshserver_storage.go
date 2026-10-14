// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/storagereport"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) StorageReportCommand(ctx context.Context) (*wshrpc.StorageReportData, error) {
	return storagereport.Snapshot(), nil
}

func (ws *WshServer) StorageScanCommand(ctx context.Context) error {
	return storagereport.StartScan()
}

func (ws *WshServer) StorageClearCommand(ctx context.Context, data wshrpc.CommandStorageClearData) error {
	return storagereport.StartClear(data.Ids)
}

func (ws *WshServer) StorageDeleteCommand(ctx context.Context, data wshrpc.CommandStorageDeleteData) error {
	return storagereport.StartDelete(data.Id, data.Tip)
}
