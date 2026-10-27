// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) RunDesignAttachCommand(ctx context.Context, data wshrpc.CommandRunDesignAttachData) (*wshrpc.CommandRunDesignAttachRtnData, error) {
	return nil, fmt.Errorf("not implemented yet")
}

func (ws *WshServer) JarvisDesignCommand(ctx context.Context, data wshrpc.CommandJarvisDesignData) error {
	return fmt.Errorf("not implemented yet")
}
