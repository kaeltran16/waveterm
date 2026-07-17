// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/base64"
	"fmt"
	"io/fs"
	"log"

	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/blocklogger"
	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/genconn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func (ws *WshServer) CreateBlockCommand(ctx context.Context, data wshrpc.CommandCreateBlockData) (*waveobj.ORef, error) {
	ctx = waveobj.ContextWithUpdates(ctx)
	tabId := data.TabId
	blockData, err := wcore.CreateBlock(ctx, tabId, data.BlockDef, data.RtOpts)
	if err != nil {
		return nil, fmt.Errorf("error creating block: %w", err)
	}
	var layoutAction *waveobj.LayoutActionData
	if data.TargetBlockId != "" {
		switch data.TargetAction {
		case "replace":
			layoutAction = &waveobj.LayoutActionData{
				ActionType:    wcore.LayoutActionDataType_Replace,
				TargetBlockId: data.TargetBlockId,
				BlockId:       blockData.OID,
				Focused:       data.Focused,
			}
			err = wcore.DeleteBlock(ctx, data.TargetBlockId, false)
			if err != nil {
				return nil, fmt.Errorf("error deleting block (trying to do block replace): %w", err)
			}
		case "splitright":
			layoutAction = &waveobj.LayoutActionData{
				ActionType:    wcore.LayoutActionDataType_SplitHorizontal,
				BlockId:       blockData.OID,
				TargetBlockId: data.TargetBlockId,
				Position:      "after",
				Focused:       data.Focused,
			}
		case "splitleft":
			layoutAction = &waveobj.LayoutActionData{
				ActionType:    wcore.LayoutActionDataType_SplitHorizontal,
				BlockId:       blockData.OID,
				TargetBlockId: data.TargetBlockId,
				Position:      "before",
				Focused:       data.Focused,
			}
		case "splitup":
			layoutAction = &waveobj.LayoutActionData{
				ActionType:    wcore.LayoutActionDataType_SplitVertical,
				BlockId:       blockData.OID,
				TargetBlockId: data.TargetBlockId,
				Position:      "before",
				Focused:       data.Focused,
			}
		case "splitdown":
			layoutAction = &waveobj.LayoutActionData{
				ActionType:    wcore.LayoutActionDataType_SplitVertical,
				BlockId:       blockData.OID,
				TargetBlockId: data.TargetBlockId,
				Position:      "after",
				Focused:       data.Focused,
			}
		default:
			return nil, fmt.Errorf("invalid target action: %s", data.TargetAction)
		}
	} else {
		layoutAction = &waveobj.LayoutActionData{
			ActionType: wcore.LayoutActionDataType_Insert,
			BlockId:    blockData.OID,
			Magnified:  data.Magnified,
			Ephemeral:  data.Ephemeral,
			Focused:    data.Focused,
		}
	}
	err = wcore.QueueLayoutActionForTab(ctx, tabId, *layoutAction)
	if err != nil {
		return nil, fmt.Errorf("error queuing layout action: %w", err)
	}
	updates := waveobj.ContextGetUpdatesRtn(ctx)
	wps.Broker.SendUpdateEvents(updates)
	return &waveobj.ORef{OType: waveobj.OType_Block, OID: blockData.OID}, nil
}

func (ws *WshServer) CreateSubBlockCommand(ctx context.Context, data wshrpc.CommandCreateSubBlockData) (*waveobj.ORef, error) {
	parentBlockId := data.ParentBlockId
	blockData, err := wcore.CreateSubBlock(ctx, parentBlockId, data.BlockDef)
	if err != nil {
		return nil, fmt.Errorf("error creating block: %w", err)
	}
	blockRef := &waveobj.ORef{OType: waveobj.OType_Block, OID: blockData.OID}
	return blockRef, nil
}

func (ws *WshServer) ControllerDestroyCommand(ctx context.Context, blockId string) error {
	blockcontroller.DestroyBlockController(blockId)
	return nil
}

func (ws *WshServer) ControllerResyncCommand(ctx context.Context, data wshrpc.CommandControllerResyncData) error {
	ctx = genconn.ContextWithConnData(ctx, data.BlockId)
	ctx = termCtxWithLogBlockId(ctx, data.BlockId)
	return blockcontroller.ResyncController(ctx, data.TabId, data.BlockId, data.RtOpts, data.ForceRestart)
}

func (ws *WshServer) ControllerInputCommand(ctx context.Context, data wshrpc.CommandBlockInputData) error {
	inputUnion := &blockcontroller.BlockInputUnion{
		SigName:  data.SigName,
		TermSize: data.TermSize,
	}
	if len(data.InputData64) > 0 {
		inputBuf := make([]byte, base64.StdEncoding.DecodedLen(len(data.InputData64)))
		nw, err := base64.StdEncoding.Decode(inputBuf, []byte(data.InputData64))
		if err != nil {
			return fmt.Errorf("error decoding input data: %w", err)
		}
		inputUnion.InputData = inputBuf[:nw]
	}
	return blockcontroller.SendInput(data.BlockId, inputUnion)
}

func (ws *WshServer) ControllerAppendOutputCommand(ctx context.Context, data wshrpc.CommandControllerAppendOutputData) error {
	outputBuf := make([]byte, base64.StdEncoding.DecodedLen(len(data.Data64)))
	nw, err := base64.StdEncoding.Decode(outputBuf, []byte(data.Data64))
	if err != nil {
		return fmt.Errorf("error decoding output data: %w", err)
	}
	err = blockcontroller.HandleAppendBlockFile(data.BlockId, wavebase.BlockFile_Term, outputBuf[:nw])
	if err != nil {
		return fmt.Errorf("error appending to block file: %w", err)
	}
	return nil
}

func (ws *WshServer) DeleteSubBlockCommand(ctx context.Context, data wshrpc.CommandDeleteBlockData) error {
	if data.BlockId == "" {
		return fmt.Errorf("blockid is required")
	}
	err := wcore.DeleteBlock(ctx, data.BlockId, false)
	if err != nil {
		return fmt.Errorf("error deleting block: %w", err)
	}
	return nil
}

func (ws *WshServer) DeleteBlockCommand(ctx context.Context, data wshrpc.CommandDeleteBlockData) error {
	if data.BlockId == "" {
		return fmt.Errorf("blockid is required")
	}
	ctx = waveobj.ContextWithUpdates(ctx)
	tabId, err := wstore.DBFindTabForBlockId(ctx, data.BlockId)
	if err != nil {
		return fmt.Errorf("error finding tab for block: %w", err)
	}
	if tabId == "" {
		return fmt.Errorf("no tab found for block")
	}
	err = wcore.DeleteBlock(ctx, data.BlockId, true)
	if err != nil {
		return fmt.Errorf("error deleting block: %w", err)
	}
	// deleting the last block cascade-deletes its tab; only edit the layout tree if the tab survived
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return fmt.Errorf("error checking tab after block delete: %w", err)
	}
	if tab != nil {
		if err := wcore.QueueLayoutActionForTab(ctx, tabId, waveobj.LayoutActionData{
			ActionType: wcore.LayoutActionDataType_Remove,
			BlockId:    data.BlockId,
		}); err != nil {
			return fmt.Errorf("error queueing layout action: %w", err)
		}
	}
	updates := waveobj.ContextGetUpdatesRtn(ctx)
	wps.Broker.SendUpdateEvents(updates)
	return nil
}

func termCtxWithLogBlockId(ctx context.Context, logBlockId string) context.Context {
	if logBlockId == "" {
		return ctx
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, logBlockId)
	if err != nil {
		return ctx
	}
	connDebug := block.Meta.GetString(waveobj.MetaKey_TermConnDebug, "")
	if connDebug == "" {
		return ctx
	}
	return blocklogger.ContextWithLogBlockId(ctx, logBlockId, connDebug == "debug")
}

func (ws *WshServer) BlockInfoCommand(ctx context.Context, blockId string) (*wshrpc.BlockInfoData, error) {
	blockData, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return nil, fmt.Errorf("error getting block: %w", err)
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return nil, fmt.Errorf("error finding tab for block: %w", err)
	}
	workspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return nil, fmt.Errorf("error finding window for tab: %w", err)
	}
	fileList, err := filestore.WFS.ListFiles(ctx, blockId)
	if err != nil {
		return nil, fmt.Errorf("error listing blockfiles: %w", err)
	}
	var fileInfoList []*wshrpc.WaveFileInfo
	for _, wf := range fileList {
		fileInfoList = append(fileInfoList, waveFileToWaveFileInfo(wf))
	}
	return &wshrpc.BlockInfoData{
		BlockId:     blockId,
		TabId:       tabId,
		WorkspaceId: workspaceId,
		Block:       blockData,
		Files:       fileInfoList,
	}, nil
}

func (ws *WshServer) DebugTermCommand(ctx context.Context, data wshrpc.CommandDebugTermData) (*wshrpc.CommandDebugTermRtnData, error) {
	if data.BlockId == "" {
		return nil, fmt.Errorf("blockid is required")
	}
	if data.Size <= 0 {
		return nil, fmt.Errorf("size must be greater than 0")
	}
	waveFile, err := filestore.WFS.Stat(ctx, data.BlockId, wavebase.BlockFile_Term)
	if err == fs.ErrNotExist {
		return &wshrpc.CommandDebugTermRtnData{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("error statting term file: %w", err)
	}
	readSize := data.Size
	dataLength := waveFile.DataLength()
	if readSize > dataLength {
		readSize = dataLength
	}
	readOffset := waveFile.Size - readSize
	readOffset, readData, err := filestore.WFS.ReadAt(ctx, data.BlockId, wavebase.BlockFile_Term, readOffset, readSize)
	if err != nil {
		return nil, fmt.Errorf("error reading term file: %w", err)
	}
	return &wshrpc.CommandDebugTermRtnData{
		Offset: readOffset,
		Data64: base64.StdEncoding.EncodeToString(readData),
	}, nil
}

// BlocksListCommand returns every block visible in the requested
// scope (current workspace by default).
func (ws *WshServer) BlocksListCommand(
	ctx context.Context,
	req wshrpc.BlocksListRequest) ([]wshrpc.BlocksListEntry, error) {
	var results []wshrpc.BlocksListEntry

	// Resolve the set of workspaces to inspect
	var workspaceIDs []string
	if req.WorkspaceId != "" {
		workspaceIDs = []string{req.WorkspaceId}
	} else if req.WindowId != "" {
		win, err := wcore.GetWindow(ctx, req.WindowId)
		if err != nil {
			return nil, err
		}
		workspaceIDs = []string{win.WorkspaceId}
	} else {
		// "current" == first workspace in client focus list
		client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
		if err != nil {
			return nil, err
		}
		if len(client.WindowIds) == 0 {
			return nil, fmt.Errorf("no active window")
		}
		win, err := wcore.GetWindow(ctx, client.WindowIds[0])
		if err != nil {
			return nil, err
		}
		workspaceIDs = []string{win.WorkspaceId}
	}

	for _, wsID := range workspaceIDs {
		wsData, err := wcore.GetWorkspace(ctx, wsID)
		if err != nil {
			return nil, err
		}

		windowId, err := wstore.DBFindWindowForWorkspaceId(ctx, wsID)
		if err != nil {
			log.Printf("error finding window for workspace %s: %v", wsID, err)
		}

		for _, tabID := range wsData.TabIds {
			tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabID)
			if err != nil {
				return nil, err
			}
			for _, blkID := range tab.BlockIds {
				blk, err := wstore.DBMustGet[*waveobj.Block](ctx, blkID)
				if err != nil {
					return nil, err
				}
				results = append(results, wshrpc.BlocksListEntry{
					WindowId:    windowId,
					WorkspaceId: wsID,
					TabId:       tabID,
					BlockId:     blkID,
					Meta:        blk.Meta,
				})
			}
		}
	}
	return results, nil
}

func (ws *WshServer) WorkspaceListCommand(ctx context.Context) ([]wshrpc.WorkspaceInfoData, error) {
	workspaceList, err := wcore.ListWorkspaces(ctx)
	if err != nil {
		return nil, fmt.Errorf("error listing workspaces: %w", err)
	}
	var rtn []wshrpc.WorkspaceInfoData
	for _, workspaceEntry := range workspaceList {
		workspaceData, err := wcore.GetWorkspace(ctx, workspaceEntry.WorkspaceId)
		if err != nil {
			return nil, fmt.Errorf("error getting workspace: %w", err)
		}
		rtn = append(rtn, wshrpc.WorkspaceInfoData{
			WindowId:      workspaceEntry.WindowId,
			WorkspaceData: workspaceData,
		})
	}
	return rtn, nil
}
