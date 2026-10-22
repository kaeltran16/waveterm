// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) BrainstormCheckCommand(ctx context.Context, data wshrpc.CommandBrainstormCheckData) error {
	return fmt.Errorf("the builder check is not wired yet")
}
