// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workspaceservice

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/tsgen/tsgenmeta"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const DefaultTimeout = 2 * time.Second

type WorkspaceService struct{}

func (svc *WorkspaceService) GetWorkspace_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		ArgNames:   []string{"workspaceId"},
		ReturnDesc: "workspace",
	}
}

func (svc *WorkspaceService) GetWorkspace(workspaceId string) (*waveobj.Workspace, error) {
	ctx, cancelFn := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancelFn()
	ws, err := wstore.DBGet[*waveobj.Workspace](ctx, workspaceId)
	if err != nil {
		return nil, fmt.Errorf("error getting workspace: %w", err)
	}
	return ws, nil
}

func (svc *WorkspaceService) CreateTab_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		ArgNames:   []string{"workspaceId", "tabName", "activateTab"},
		ReturnDesc: "tabId",
	}
}

func (svc *WorkspaceService) CreateTab(workspaceId string, tabName string, activateTab bool) (string, waveobj.UpdatesRtnType, error) {
	ctx, cancelFn := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancelFn()
	ctx = waveobj.ContextWithUpdates(ctx)
	tabId, err := wcore.CreateTab(ctx, workspaceId, tabName, activateTab, false)
	if err != nil {
		return "", nil, fmt.Errorf("error creating tab: %w", err)
	}
	updates := waveobj.ContextGetUpdatesRtn(ctx)
	go func() {
		defer func() {
			panichandler.PanicHandler("WorkspaceService:CreateTab:SendUpdateEvents", recover())
		}()
		wps.Broker.SendUpdateEvents(updates)
	}()
	return tabId, updates, nil
}

type CloseTabRtnType struct {
	CloseWindow    bool   `json:"closewindow,omitempty"`
	NewActiveTabId string `json:"newactivetabid,omitempty"`
}

func (svc *WorkspaceService) CloseTab_Meta() tsgenmeta.MethodMeta {
	return tsgenmeta.MethodMeta{
		ArgNames:   []string{"ctx", "workspaceId", "tabId", "fromElectron"},
		ReturnDesc: "CloseTabRtn",
	}
}

// returns the new active tabid
func (svc *WorkspaceService) CloseTab(ctx context.Context, workspaceId string, tabId string, fromElectron bool) (*CloseTabRtnType, waveobj.UpdatesRtnType, error) {
	ctx = waveobj.ContextWithUpdates(ctx)
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err == nil && tab != nil {
		go func() {
			for _, blockId := range tab.BlockIds {
				blockcontroller.DestroyBlockController(blockId)
			}
		}()
	}
	newActiveTabId, err := wcore.DeleteTab(ctx, workspaceId, tabId, true)
	if err != nil {
		return nil, nil, fmt.Errorf("error closing tab: %w", err)
	}
	rtn := &CloseTabRtnType{}
	if newActiveTabId == "" {
		rtn.CloseWindow = true
	} else {
		rtn.NewActiveTabId = newActiveTabId
	}
	updates := waveobj.ContextGetUpdatesRtn(ctx)
	go func() {
		defer func() {
			panichandler.PanicHandler("WorkspaceService:CloseTab:SendUpdateEvents", recover())
		}()
		wps.Broker.SendUpdateEvents(updates)
	}()
	return rtn, updates, nil
}
