// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) AgentsStartCommand(ctx context.Context, data wshrpc.CommandAgentsStartData) (*wshrpc.CommandAgentsStartRtnData, error) {
	return nil, errors.New("wsh agents start is not built yet")
}
