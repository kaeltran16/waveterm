// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// stubs until the handlers are built; each answers as an unreachable Jira
var errJiraNotBuilt = errors.New("EC-JIRA-UNREACHABLE: not built yet")

func (ws *WshServer) JiraConnectionCommand(ctx context.Context, data wshrpc.CommandJiraConnectionData) (*wshrpc.JiraConnection, error) {
	return nil, errJiraNotBuilt
}

func (ws *WshServer) JiraCheckCommand(ctx context.Context) (*wshrpc.CommandJiraCheckRtnData, error) {
	return nil, errJiraNotBuilt
}

func (ws *WshServer) JiraShowCommand(ctx context.Context, data wshrpc.CommandJiraShowData) (*wshrpc.CommandJiraShowRtnData, error) {
	return nil, errJiraNotBuilt
}

func (ws *WshServer) JiraPostDraftCommand(ctx context.Context, data wshrpc.CommandJiraPostDraftData) (*wshrpc.CommandJiraPostDraftRtnData, error) {
	return nil, errJiraNotBuilt
}

func (ws *WshServer) JiraPostSummariesCommand(ctx context.Context, data wshrpc.CommandJiraPostDraftData) (*wshrpc.CommandJiraPostSummariesRtnData, error) {
	return nil, errJiraNotBuilt
}

func (ws *WshServer) JiraPostCommand(ctx context.Context, data wshrpc.CommandJiraPostData) (*wshrpc.CommandJiraPostRtnData, error) {
	return nil, errJiraNotBuilt
}
