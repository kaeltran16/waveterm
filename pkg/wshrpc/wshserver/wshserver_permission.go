// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

var errPermissionNotImplemented = errors.New("not implemented")

func (ws *WshServer) AgentPermissionCommand(ctx context.Context, data wshrpc.CommandAgentPermissionData) (string, error) {
	return "", errPermissionNotImplemented
}

func (ws *WshServer) AnswerAgentPermissionCommand(ctx context.Context, data wshrpc.CommandAnswerAgentPermissionData) error {
	return errPermissionNotImplemented
}
