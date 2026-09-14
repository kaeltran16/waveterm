// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func validateNotifyData(data wshrpc.NotifyCommandData) error {
	if data.Title == "" {
		return fmt.Errorf("notify title is required")
	}
	if data.Level != "" && data.Level != "info" && data.Level != "warn" && data.Level != "error" {
		return fmt.Errorf("invalid notify level %q (want info, warn, or error)", data.Level)
	}
	return nil
}

func (ws *WshServer) NotifyCommand(ctx context.Context, data wshrpc.NotifyCommandData) error {
	if err := validateNotifyData(data); err != nil {
		return err
	}
	if data.Level == "" {
		data.Level = "info"
	}
	wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_Notify, Data: data})
	return nil
}
