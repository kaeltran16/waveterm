// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

// this file contains the implementation of the wsh server methods

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/skratchdot/open-golang/open"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/aiusechat"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/blocklogger"
	"github.com/wavetermdev/waveterm/pkg/buildercontroller"
	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/genconn"
	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/remote/fileshare/wshfs"
	"github.com/wavetermdev/waveterm/pkg/reporadar"
	"github.com/wavetermdev/waveterm/pkg/secretstore"
	"github.com/wavetermdev/waveterm/pkg/suggestion"
	"github.com/wavetermdev/waveterm/pkg/telemetry"
	"github.com/wavetermdev/waveterm/pkg/telemetry/telemetrydata"
	"github.com/wavetermdev/waveterm/pkg/usagestats"
	"github.com/wavetermdev/waveterm/pkg/util/envutil"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveappstore"
	"github.com/wavetermdev/waveterm/pkg/waveapputil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wavejwt"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcloud"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wsl"
	"github.com/wavetermdev/waveterm/pkg/wslconn"
	"github.com/wavetermdev/waveterm/pkg/wstore"
	"github.com/wavetermdev/waveterm/tsunami/build"
)

var InvalidWslDistroNames = []string{"docker-desktop", "docker-desktop-data"}

type WshServer struct{}

func (*WshServer) WshServerImpl() {}

var WshServerImpl = WshServer{}

func (ws *WshServer) GetJwtPublicKeyCommand(ctx context.Context) (string, error) {
	return wavejwt.GetPublicKeyBase64(), nil
}

func (ws *WshServer) TestCommand(ctx context.Context, data string) error {
	defer func() {
		panichandler.PanicHandler("TestCommand", recover())
	}()
	rpcSource := wshutil.GetRpcSourceFromContext(ctx)
	log.Printf("TEST src:%s | %s\n", rpcSource, data)
	return nil
}

func (ws *WshServer) TestMultiArgCommand(ctx context.Context, arg1 string, arg2 int, arg3 bool) (string, error) {
	defer func() {
		panichandler.PanicHandler("TestMultiArgCommand", recover())
	}()
	rpcSource := wshutil.GetRpcSourceFromContext(ctx)
	rtn := fmt.Sprintf("src:%s arg1:%q arg2:%d arg3:%t", rpcSource, arg1, arg2, arg3)
	log.Printf("TESTMULTI %s\n", rtn)
	return rtn, nil
}

// for testing
func (ws *WshServer) MessageCommand(ctx context.Context, data wshrpc.CommandMessageData) error {
	log.Printf("MESSAGE: %s\n", data.Message)
	return nil
}

// for testing
func (ws *WshServer) StreamTestCommand(ctx context.Context) chan wshrpc.RespOrErrorUnion[int] {
	rtn := make(chan wshrpc.RespOrErrorUnion[int])
	go func() {
		defer func() {
			panichandler.PanicHandler("StreamTestCommand", recover())
		}()
		for i := 1; i <= 5; i++ {
			rtn <- wshrpc.RespOrErrorUnion[int]{Response: i}
			time.Sleep(1 * time.Second)
		}
		close(rtn)
	}()
	return rtn
}

func (ws *WshServer) GetMetaCommand(ctx context.Context, data wshrpc.CommandGetMetaData) (waveobj.MetaMapType, error) {
	obj, err := wstore.DBGetORef(ctx, data.ORef)
	if err != nil {
		return nil, fmt.Errorf("error getting object: %w", err)
	}
	if obj == nil {
		return nil, fmt.Errorf("object not found: %s", data.ORef)
	}
	return waveobj.GetMeta(obj), nil
}

func (ws *WshServer) UpdateWorkspaceTabIdsCommand(ctx context.Context, workspaceId string, tabIds []string) error {
	oref := waveobj.ORef{OType: waveobj.OType_Workspace, OID: workspaceId}
	err := wcore.UpdateWorkspaceTabIds(ctx, workspaceId, tabIds)
	if err != nil {
		return fmt.Errorf("error updating workspace tab ids: %w", err)
	}
	wcore.SendWaveObjUpdate(oref)
	return nil
}

func (ws *WshServer) SetMetaCommand(ctx context.Context, data wshrpc.CommandSetMetaData) error {
	log.Printf("SetMetaCommand: %s | %v\n", data.ORef, data.Meta)
	oref := data.ORef
	err := wstore.UpdateObjectMeta(ctx, oref, data.Meta, false)
	if err != nil {
		return fmt.Errorf("error updating object meta: %w", err)
	}
	wcore.SendWaveObjUpdate(oref)
	return nil
}

func (ws *WshServer) GetRTInfoCommand(ctx context.Context, data wshrpc.CommandGetRTInfoData) (*waveobj.ObjRTInfo, error) {
	return wstore.GetRTInfo(data.ORef), nil
}

func (ws *WshServer) SetRTInfoCommand(ctx context.Context, data wshrpc.CommandSetRTInfoData) error {
	if data.Delete {
		wstore.DeleteRTInfo(data.ORef)
		return nil
	}
	wstore.SetRTInfo(data.ORef, data.Data)
	return nil
}

func (ws *WshServer) ResolveIdsCommand(ctx context.Context, data wshrpc.CommandResolveIdsData) (wshrpc.CommandResolveIdsRtnData, error) {
	rtn := wshrpc.CommandResolveIdsRtnData{}
	rtn.ResolvedIds = make(map[string]waveobj.ORef)
	var firstErr error
	for _, simpleId := range data.Ids {
		oref, err := resolveSimpleId(ctx, data, simpleId)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if oref == nil {
			continue
		}
		rtn.ResolvedIds[simpleId] = *oref
	}
	if firstErr != nil && len(data.Ids) == 1 {
		return rtn, firstErr
	}
	return rtn, nil
}

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

func (ws *WshServer) FileCreateCommand(ctx context.Context, data wshrpc.FileData) error {
	data.Data64 = ""
	err := wshfs.PutFile(ctx, data)
	if err != nil {
		return fmt.Errorf("error creating file: %w", err)
	}
	return nil
}

func (ws *WshServer) FileMkdirCommand(ctx context.Context, data wshrpc.FileData) error {
	return wshfs.Mkdir(ctx, data.Info.Path)
}

func (ws *WshServer) FileDeleteCommand(ctx context.Context, data wshrpc.CommandDeleteFileData) error {
	return wshfs.Delete(ctx, data)
}

func (ws *WshServer) FileInfoCommand(ctx context.Context, data wshrpc.FileData) (*wshrpc.FileInfo, error) {
	return wshfs.Stat(ctx, data.Info.Path)
}

func (ws *WshServer) FileListCommand(ctx context.Context, data wshrpc.FileListData) ([]*wshrpc.FileInfo, error) {
	return wshfs.ListEntries(ctx, data.Path, data.Opts)
}

func (ws *WshServer) FileListStreamCommand(ctx context.Context, data wshrpc.FileListData) <-chan wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData] {
	return wshfs.ListEntriesStream(ctx, data.Path, data.Opts)
}

func (ws *WshServer) FileWriteCommand(ctx context.Context, data wshrpc.FileData) error {
	return wshfs.PutFile(ctx, data)
}

func (ws *WshServer) FileReadCommand(ctx context.Context, data wshrpc.FileData) (*wshrpc.FileData, error) {
	return wshfs.Read(ctx, data)
}

func (ws *WshServer) FileStreamCommand(ctx context.Context, data wshrpc.CommandFileStreamData) (*wshrpc.FileInfo, error) {
	return wshfs.FileStream(ctx, data)
}

func (ws *WshServer) FileCopyCommand(ctx context.Context, data wshrpc.CommandFileCopyData) error {
	return wshfs.Copy(ctx, data)
}

func (ws *WshServer) FileMoveCommand(ctx context.Context, data wshrpc.CommandFileCopyData) error {
	return wshfs.Move(ctx, data)
}

func (ws *WshServer) FileAppendCommand(ctx context.Context, data wshrpc.FileData) error {
	return wshfs.Append(ctx, data)
}

func (ws *WshServer) FileJoinCommand(ctx context.Context, paths []string) (*wshrpc.FileInfo, error) {
	if len(paths) < 2 {
		if len(paths) == 0 {
			return nil, fmt.Errorf("no paths provided")
		}
		return wshfs.Stat(ctx, paths[0])
	}
	return wshfs.Join(ctx, paths[0], paths[1:]...)
}

func (ws *WshServer) WriteTempFileCommand(ctx context.Context, data wshrpc.CommandWriteTempFileData) (string, error) {
	if data.FileName == "" {
		return "", fmt.Errorf("filename is required")
	}
	name := filepath.Base(data.FileName)
	if name == "" || name == "." || name == ".." {
		return "", fmt.Errorf("invalid filename")
	}
	tempDir, err := os.MkdirTemp("", "waveterm-")
	if err != nil {
		return "", fmt.Errorf("error creating temp directory: %w", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(data.Data64)
	if err != nil {
		return "", fmt.Errorf("error decoding base64 data: %w", err)
	}
	tempPath := filepath.Join(tempDir, name)
	err = os.WriteFile(tempPath, decoded, 0600)
	if err != nil {
		return "", fmt.Errorf("error writing temp file: %w", err)
	}
	return tempPath, nil
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

func (ws *WshServer) WaitForRouteCommand(ctx context.Context, data wshrpc.CommandWaitForRouteData) (bool, error) {
	waitCtx, cancelFn := context.WithTimeout(ctx, time.Duration(data.WaitMs)*time.Millisecond)
	defer cancelFn()
	err := wshutil.DefaultRouter.WaitForRegister(waitCtx, data.RouteId)
	return err == nil, nil
}

func (ws *WshServer) EventRecvCommand(ctx context.Context, data wps.WaveEvent) error {
	return nil
}

func (ws *WshServer) EventPublishCommand(ctx context.Context, data wps.WaveEvent) error {
	rpcSource := wshutil.GetRpcSourceFromContext(ctx)
	if rpcSource == "" {
		return fmt.Errorf("no rpc source set")
	}
	if data.Sender == "" {
		data.Sender = rpcSource
	}
	wps.Broker.Publish(data)
	return nil
}

func (ws *WshServer) EventSubCommand(ctx context.Context, data wps.SubscriptionRequest) error {
	rpcSource := wshutil.GetRpcSourceFromContext(ctx)
	if rpcSource == "" {
		return fmt.Errorf("no rpc source set")
	}
	wps.Broker.Subscribe(rpcSource, data)
	return nil
}

func (ws *WshServer) EventUnsubCommand(ctx context.Context, data string) error {
	rpcSource := wshutil.GetRpcSourceFromContext(ctx)
	if rpcSource == "" {
		return fmt.Errorf("no rpc source set")
	}
	wps.Broker.Unsubscribe(rpcSource, data)
	return nil
}

func (ws *WshServer) EventReadHistoryCommand(ctx context.Context, data wshrpc.CommandEventReadHistoryData) ([]*wps.WaveEvent, error) {
	events := wps.Broker.ReadEventHistory(data.Event, data.Scope, data.MaxItems)
	return events, nil
}

func (ws *WshServer) SetConfigCommand(ctx context.Context, data wshrpc.MetaSettingsType) error {
	return wconfig.SetBaseConfigValue(data.MetaMapType)
}

func (ws *WshServer) SetConnectionsConfigCommand(ctx context.Context, data wshrpc.ConnConfigRequest) error {
	return wconfig.SetConnectionsConfigValue(data.Host, data.MetaMapType)
}

func (ws *WshServer) CreateProjectCommand(ctx context.Context, data wshrpc.CommandCreateProjectData) error {
	name := strings.TrimSpace(data.Name)
	if name == "" {
		return fmt.Errorf("project name is required")
	}
	path := strings.TrimSpace(data.Path)
	if path == "" {
		return fmt.Errorf("project path is required")
	}
	if strings.HasPrefix(path, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("cannot resolve home directory: %w", err)
		}
		path = filepath.Join(home, path[1:])
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("path does not exist: %s", path)
	}
	if !info.IsDir() {
		return fmt.Errorf("path is not a directory: %s", path)
	}
	return wconfig.SetProjectConfigValue(name, waveobj.MetaMapType{"path": path})
}

func (ws *WshServer) DeleteProjectCommand(ctx context.Context, data wshrpc.CommandDeleteProjectData) error {
	name := strings.TrimSpace(data.Name)
	if name == "" {
		return fmt.Errorf("project name is required")
	}
	return wconfig.DeleteProjectConfigValue(name)
}

func (ws *WshServer) CreateWorktreeCommand(ctx context.Context, data wshrpc.CommandCreateWorktreeData) (wshrpc.CommandCreateWorktreeRtnData, error) {
	wt, err := gitinfo.CreateWorktree(ctx, data.ProjectPath, data.Branch)
	if err != nil {
		return wshrpc.CommandCreateWorktreeRtnData{}, err
	}
	return wshrpc.CommandCreateWorktreeRtnData{WorktreePath: wt}, nil
}

func (ws *WshServer) ListBranchesCommand(ctx context.Context, data wshrpc.CommandListBranchesData) (wshrpc.CommandListBranchesRtnData, error) {
	branches, err := gitinfo.ListBranches(ctx, data.ProjectPath)
	if err != nil {
		return wshrpc.CommandListBranchesRtnData{}, err
	}
	rtn := wshrpc.CommandListBranchesRtnData{Branches: make([]wshrpc.BranchInfo, 0, len(branches))}
	for _, b := range branches {
		rtn.Branches = append(rtn.Branches, wshrpc.BranchInfo{Name: b.Name, Age: b.Age})
	}
	return rtn, nil
}

func (ws *WshServer) GetFullConfigCommand(ctx context.Context) (wconfig.FullConfigType, error) {
	watcher := wconfig.GetWatcher()
	return watcher.GetFullConfig(), nil
}

func (ws *WshServer) GetWaveAIModeConfigCommand(ctx context.Context) (wconfig.AIModeConfigUpdate, error) {
	fullConfig := wconfig.GetWatcher().GetFullConfig()
	resolvedConfigs := aiusechat.ComputeResolvedAIModeConfigs(fullConfig)
	return wconfig.AIModeConfigUpdate{Configs: resolvedConfigs}, nil
}

func (ws *WshServer) ConnStatusCommand(ctx context.Context) ([]wshrpc.ConnStatus, error) {
	rtn := conncontroller.GetAllConnStatus()
	return rtn, nil
}

func (ws *WshServer) WslStatusCommand(ctx context.Context) ([]wshrpc.ConnStatus, error) {
	rtn := wslconn.GetAllConnStatus()
	return rtn, nil
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

func (ws *WshServer) ConnEnsureCommand(ctx context.Context, data wshrpc.ConnExtData) error {
	ctx = genconn.ContextWithConnData(ctx, data.LogBlockId)
	ctx = termCtxWithLogBlockId(ctx, data.LogBlockId)
	if strings.HasPrefix(data.ConnName, "wsl://") {
		distroName := strings.TrimPrefix(data.ConnName, "wsl://")
		return wslconn.EnsureConnection(ctx, distroName)
	}
	return conncontroller.EnsureConnection(ctx, data.ConnName)
}

func (ws *WshServer) ConnDisconnectCommand(ctx context.Context, connName string) error {
	if conncontroller.IsLocalConnName(connName) {
		return nil
	}
	if strings.HasPrefix(connName, "wsl://") {
		distroName := strings.TrimPrefix(connName, "wsl://")
		conn := wslconn.GetWslConn(distroName)
		if conn == nil {
			return fmt.Errorf("distro not found: %s", connName)
		}
		return conn.Close()
	}
	connOpts, err := remote.ParseOpts(connName)
	if err != nil {
		return fmt.Errorf("error parsing connection name: %w", err)
	}
	conn := conncontroller.MaybeGetConn(connOpts)
	if conn == nil {
		return fmt.Errorf("connection not found: %s", connName)
	}
	return conn.Close()
}

func (ws *WshServer) ConnConnectCommand(ctx context.Context, connRequest wshrpc.ConnRequest) error {
	if conncontroller.IsLocalConnName(connRequest.Host) {
		return nil
	}
	ctx = genconn.ContextWithConnData(ctx, connRequest.LogBlockId)
	ctx = termCtxWithLogBlockId(ctx, connRequest.LogBlockId)
	connName := connRequest.Host
	if strings.HasPrefix(connName, "wsl://") {
		distroName := strings.TrimPrefix(connName, "wsl://")
		conn := wslconn.GetWslConn(distroName)
		if conn == nil {
			return fmt.Errorf("connection not found: %s", connName)
		}
		return conn.Connect(ctx)
	}
	connOpts, err := remote.ParseOpts(connName)
	if err != nil {
		return fmt.Errorf("error parsing connection name: %w", err)
	}
	conn := conncontroller.GetConn(connOpts)
	if conn == nil {
		return fmt.Errorf("connection not found: %s", connName)
	}
	return conn.Connect(ctx, &connRequest.Keywords)
}

func (ws *WshServer) ConnReinstallWshCommand(ctx context.Context, data wshrpc.ConnExtData) error {
	if conncontroller.IsLocalConnName(data.ConnName) {
		return nil
	}
	ctx = genconn.ContextWithConnData(ctx, data.LogBlockId)
	ctx = termCtxWithLogBlockId(ctx, data.LogBlockId)
	connName := data.ConnName
	if strings.HasPrefix(connName, "wsl://") {
		distroName := strings.TrimPrefix(connName, "wsl://")
		conn := wslconn.GetWslConn(distroName)
		if conn == nil {
			return fmt.Errorf("connection not found: %s", connName)
		}
		return conn.InstallWsh(ctx, "")
	}
	connOpts, err := remote.ParseOpts(connName)
	if err != nil {
		return fmt.Errorf("error parsing connection name: %w", err)
	}
	conn := conncontroller.GetConn(connOpts)
	if conn == nil {
		return fmt.Errorf("connection not found: %s", connName)
	}
	return conn.InstallWsh(ctx, "")
}

func (ws *WshServer) ConnUpdateWshCommand(ctx context.Context, remoteInfo wshrpc.RemoteInfo) (bool, error) {
	handler := wshutil.GetRpcResponseHandlerFromContext(ctx)
	if handler == nil {
		return false, fmt.Errorf("could not determine handler from context")
	}
	connName := handler.GetRpcContext().Conn
	if connName == "" {
		return false, fmt.Errorf("invalid remote info: missing connection name")
	}

	log.Printf("checking wsh version for connection %s (current: %s)", connName, remoteInfo.ClientVersion)
	upToDate, _, _, err := conncontroller.IsWshVersionUpToDate(ctx, remoteInfo.ClientVersion)
	if err != nil {
		return false, fmt.Errorf("unable to compare wsh version: %w", err)
	}
	if upToDate {
		// no need to update
		log.Printf("wsh is already up to date for connection %s", connName)
		return false, nil
	}

	// todo: need to add user input code here for validation

	if strings.HasPrefix(connName, "wsl://") {
		return false, fmt.Errorf("connupdatewshcommand is not supported for wsl connections")
	}
	connOpts, err := remote.ParseOpts(connName)
	if err != nil {
		return false, fmt.Errorf("error parsing connection name: %w", err)
	}
	conn := conncontroller.GetConn(connOpts)
	if conn == nil {
		return false, fmt.Errorf("connection not found: %s", connName)
	}
	err = conn.UpdateWsh(ctx, connName, &remoteInfo)
	if err != nil {
		return false, fmt.Errorf("wsh update failed for connection %s: %w", connName, err)
	}

	// todo: need to add code for modifying configs?
	return true, nil
}

func (ws *WshServer) ConnListCommand(ctx context.Context) ([]string, error) {
	return conncontroller.GetConnectionsList()
}

func (ws *WshServer) WslListCommand(ctx context.Context) ([]string, error) {
	distros, err := wsl.RegisteredDistros(ctx)
	if err != nil {
		return nil, err
	}
	var distroNames []string
	for _, distro := range distros {
		distroName := distro.Name()
		if utilfn.ContainsStr(InvalidWslDistroNames, distroName) {
			continue
		}
		distroNames = append(distroNames, distroName)
	}
	return distroNames, nil
}

func (ws *WshServer) WslDefaultDistroCommand(ctx context.Context) (string, error) {
	distro, ok, err := wsl.DefaultDistro(ctx)
	if err != nil {
		return "", fmt.Errorf("unable to determine default distro: %w", err)
	}
	if !ok {
		return "", fmt.Errorf("unable to determine default distro")
	}
	return distro.Name(), nil
}

func (ws *WshServer) FindGitBashCommand(ctx context.Context, rescan bool) (string, error) {
	fullConfig := wconfig.GetWatcher().GetFullConfig()
	return shellutil.FindGitBash(&fullConfig, rescan), nil
}

func waveFileToWaveFileInfo(wf *filestore.WaveFile) *wshrpc.WaveFileInfo {
	return &wshrpc.WaveFileInfo{
		ZoneId:    wf.ZoneId,
		Name:      wf.Name,
		Opts:      wf.Opts,
		CreatedTs: wf.CreatedTs,
		Size:      wf.Size,
		ModTs:     wf.ModTs,
		Meta:      wf.Meta,
	}
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

func (ws *WshServer) WaveInfoCommand(ctx context.Context) (*wshrpc.WaveInfoData, error) {
	return &wshrpc.WaveInfoData{
		Version:   wavebase.WaveVersion,
		ClientId:  wstore.GetClientId(),
		BuildTime: wavebase.BuildTime,
		ConfigDir: wavebase.GetWaveConfigDir(),
		DataDir:   wavebase.GetWaveDataDir(),
	}, nil
}

func (ws *WshServer) MacOSVersionCommand(ctx context.Context) (string, error) {
	return wavebase.ClientMacOSVersion(), nil
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

func (ws *WshServer) ListAllAppsCommand(ctx context.Context) ([]wshrpc.AppInfo, error) {
	return waveappstore.ListAllApps()
}

func (ws *WshServer) ListAllEditableAppsCommand(ctx context.Context) ([]wshrpc.AppInfo, error) {
	return waveappstore.ListAllEditableApps()
}

func (ws *WshServer) ListAllAppFilesCommand(ctx context.Context, data wshrpc.CommandListAllAppFilesData) (*wshrpc.CommandListAllAppFilesRtnData, error) {
	if data.AppId == "" {
		return nil, fmt.Errorf("must provide an appId to ListAllAppFilesCommand")
	}
	result, err := waveappstore.ListAllAppFiles(data.AppId)
	if err != nil {
		return nil, err
	}
	entries := make([]wshrpc.DirEntryOut, len(result.Entries))
	for i, entry := range result.Entries {
		entries[i] = wshrpc.DirEntryOut{
			Name:         entry.Name,
			Dir:          entry.Dir,
			Symlink:      entry.Symlink,
			Size:         entry.Size,
			Mode:         entry.Mode,
			Modified:     entry.Modified,
			ModifiedTime: entry.ModifiedTime,
		}
	}
	return &wshrpc.CommandListAllAppFilesRtnData{
		Path:         result.Path,
		AbsolutePath: result.AbsolutePath,
		ParentDir:    result.ParentDir,
		Entries:      entries,
		EntryCount:   result.EntryCount,
		TotalEntries: result.TotalEntries,
		Truncated:    result.Truncated,
	}, nil
}

func (ws *WshServer) ReadAppFileCommand(ctx context.Context, data wshrpc.CommandReadAppFileData) (*wshrpc.CommandReadAppFileRtnData, error) {
	if data.AppId == "" {
		return nil, fmt.Errorf("must provide an appId to ReadAppFileCommand")
	}
	fileData, err := waveappstore.ReadAppFile(data.AppId, data.FileName)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &wshrpc.CommandReadAppFileRtnData{
				NotFound: true,
			}, nil
		}
		return nil, fmt.Errorf("failed to read app file: %w", err)
	}
	return &wshrpc.CommandReadAppFileRtnData{
		Data64: base64.StdEncoding.EncodeToString(fileData.Contents),
		ModTs:  fileData.ModTs,
	}, nil
}

func (ws *WshServer) WriteAppFileCommand(ctx context.Context, data wshrpc.CommandWriteAppFileData) error {
	if data.AppId == "" {
		return fmt.Errorf("must provide an appId to WriteAppFileCommand")
	}
	contents, err := base64.StdEncoding.DecodeString(data.Data64)
	if err != nil {
		return fmt.Errorf("failed to decode data64: %w", err)
	}
	return waveappstore.WriteAppFile(data.AppId, data.FileName, contents)
}

func (ws *WshServer) WaveFileReadStreamCommand(ctx context.Context, data wshrpc.CommandWaveFileReadStreamData) (*wshrpc.WaveFileInfo, error) {
	const maxStreamFileSize = 5 * 1024 * 1024

	waveFile, err := filestore.WFS.Stat(ctx, data.ZoneId, data.Name)
	if err != nil {
		return nil, fmt.Errorf("error statting wavefile: %w", err)
	}

	dataLength := waveFile.DataLength()
	if dataLength > maxStreamFileSize {
		return nil, fmt.Errorf("file size %d exceeds maximum streaming size of %d bytes", dataLength, maxStreamFileSize)
	}

	wshRpc := wshutil.GetWshRpcFromContext(ctx)
	if wshRpc == nil || wshRpc.StreamBroker == nil {
		return nil, fmt.Errorf("no stream broker available")
	}

	writer, err := wshRpc.StreamBroker.CreateStreamWriter(&data.StreamMeta)
	if err != nil {
		return nil, fmt.Errorf("error creating stream writer: %w", err)
	}

	_, fileData, err := filestore.WFS.ReadFile(ctx, data.ZoneId, data.Name)
	if err != nil {
		writer.Close()
		return nil, fmt.Errorf("error reading wavefile: %w", err)
	}

	go func() {
		defer func() {
			panichandler.PanicHandler("WaveFileReadStreamCommand", recover())
		}()
		defer writer.Close()

		_, err := writer.Write(fileData)
		if err != nil {
			log.Printf("error writing to stream for wavefile %s:%s: %v\n", data.ZoneId, data.Name, err)
		}
	}()

	rtnInfo := &wshrpc.WaveFileInfo{
		ZoneId:    waveFile.ZoneId,
		Name:      waveFile.Name,
		Opts:      waveFile.Opts,
		CreatedTs: waveFile.CreatedTs,
		Size:      waveFile.Size,
		ModTs:     waveFile.ModTs,
		Meta:      waveFile.Meta,
	}
	return rtnInfo, nil
}

func (ws *WshServer) WriteAppGoFileCommand(ctx context.Context, data wshrpc.CommandWriteAppGoFileData) (*wshrpc.CommandWriteAppGoFileRtnData, error) {
	if data.AppId == "" {
		return nil, fmt.Errorf("must provide an appId to WriteAppGoFileCommand")
	}
	contents, err := base64.StdEncoding.DecodeString(data.Data64)
	if err != nil {
		return nil, fmt.Errorf("failed to decode data64: %w", err)
	}

	formattedOutput := waveapputil.FormatGoCode(contents)

	err = waveappstore.WriteAppFile(data.AppId, "app.go", formattedOutput)
	if err != nil {
		return nil, err
	}

	encoded := base64.StdEncoding.EncodeToString(formattedOutput)
	return &wshrpc.CommandWriteAppGoFileRtnData{Data64: encoded}, nil
}

func (ws *WshServer) DeleteAppFileCommand(ctx context.Context, data wshrpc.CommandDeleteAppFileData) error {
	if data.AppId == "" {
		return fmt.Errorf("must provide an appId to DeleteAppFileCommand")
	}
	return waveappstore.DeleteAppFile(data.AppId, data.FileName)
}

func (ws *WshServer) RenameAppFileCommand(ctx context.Context, data wshrpc.CommandRenameAppFileData) error {
	if data.AppId == "" {
		return fmt.Errorf("must provide an appId to RenameAppFileCommand")
	}
	return waveappstore.RenameAppFile(data.AppId, data.FromFileName, data.ToFileName)
}

func (ws *WshServer) WriteAppSecretBindingsCommand(ctx context.Context, data wshrpc.CommandWriteAppSecretBindingsData) error {
	if data.AppId == "" {
		return fmt.Errorf("must provide an appId to WriteAppSecretBindingsCommand")
	}
	return waveappstore.WriteAppSecretBindings(data.AppId, data.Bindings)
}

func (ws *WshServer) DeleteBuilderCommand(ctx context.Context, builderId string) error {
	if builderId == "" {
		return fmt.Errorf("must provide a builderId to DeleteBuilderCommand")
	}
	buildercontroller.DeleteController(builderId)
	return nil
}

func (ws *WshServer) StartBuilderCommand(ctx context.Context, data wshrpc.CommandStartBuilderData) error {
	if data.BuilderId == "" {
		return fmt.Errorf("must provide a builderId to StartBuilderCommand")
	}
	bc := buildercontroller.GetOrCreateController(data.BuilderId)
	rtInfo := wstore.GetRTInfo(waveobj.MakeORef("builder", data.BuilderId))
	if rtInfo == nil {
		return fmt.Errorf("builder rtinfo not found for builderid: %s", data.BuilderId)
	}
	appId := rtInfo.BuilderAppId
	if appId == "" {
		return fmt.Errorf("builder appid not set for builderid: %s", data.BuilderId)
	}
	return bc.Start(ctx, appId, rtInfo.BuilderEnv)
}

func (ws *WshServer) StopBuilderCommand(ctx context.Context, builderId string) error {
	if builderId == "" {
		return fmt.Errorf("must provide a builderId to StopBuilderCommand")
	}
	bc := buildercontroller.GetController(builderId)
	if bc == nil {
		return nil
	}
	return bc.Stop()
}

func (ws *WshServer) RestartBuilderAndWaitCommand(ctx context.Context, data wshrpc.CommandRestartBuilderAndWaitData) (*wshrpc.RestartBuilderAndWaitResult, error) {
	if data.BuilderId == "" {
		return nil, fmt.Errorf("must provide a builderId to RestartBuilderAndWaitCommand")
	}

	bc := buildercontroller.GetOrCreateController(data.BuilderId)
	rtInfo := wstore.GetRTInfo(waveobj.MakeORef("builder", data.BuilderId))
	if rtInfo == nil {
		return nil, fmt.Errorf("builder rtinfo not found for builderid: %s", data.BuilderId)
	}

	appId := rtInfo.BuilderAppId
	if appId == "" {
		return nil, fmt.Errorf("builder appid not set for builderid: %s", data.BuilderId)
	}

	result, err := bc.RestartAndWaitForBuild(ctx, appId, rtInfo.BuilderEnv)
	if err != nil {
		return nil, err
	}

	return &wshrpc.RestartBuilderAndWaitResult{
		Success:      result.Success,
		ErrorMessage: result.ErrorMessage,
		BuildOutput:  result.BuildOutput,
	}, nil
}

func (ws *WshServer) GetBuilderStatusCommand(ctx context.Context, builderId string) (*wshrpc.BuilderStatusData, error) {
	if builderId == "" {
		return nil, fmt.Errorf("must provide a builderId to GetBuilderStatusCommand")
	}
	bc := buildercontroller.GetOrCreateController(builderId)
	status := bc.GetStatus()
	return &status, nil
}

func (ws *WshServer) GetBuilderOutputCommand(ctx context.Context, builderId string) ([]string, error) {
	if builderId == "" {
		return nil, fmt.Errorf("must provide a builderId to GetBuilderOutputCommand")
	}
	bc := buildercontroller.GetOrCreateController(builderId)
	return bc.GetOutput(), nil
}

func (ws *WshServer) CheckGoVersionCommand(ctx context.Context) (*wshrpc.CommandCheckGoVersionRtnData, error) {
	watcher := wconfig.GetWatcher()
	fullConfig := watcher.GetFullConfig()
	goPath := fullConfig.Settings.TsunamiGoPath

	result := build.CheckGoVersion(goPath)

	return &wshrpc.CommandCheckGoVersionRtnData{
		GoStatus:    result.GoStatus,
		GoPath:      result.GoPath,
		GoVersion:   result.GoVersion,
		ErrorString: result.ErrorString,
	}, nil
}

func (ws *WshServer) PublishAppCommand(ctx context.Context, data wshrpc.CommandPublishAppData) (*wshrpc.CommandPublishAppRtnData, error) {
	publishedAppId, err := waveappstore.PublishDraft(data.AppId)
	if err != nil {
		return nil, fmt.Errorf("error publishing app: %w", err)
	}
	return &wshrpc.CommandPublishAppRtnData{
		PublishedAppId: publishedAppId,
	}, nil
}

func (ws *WshServer) MakeDraftFromLocalCommand(ctx context.Context, data wshrpc.CommandMakeDraftFromLocalData) (*wshrpc.CommandMakeDraftFromLocalRtnData, error) {
	draftAppId, err := waveappstore.MakeDraftFromLocal(data.LocalAppId)
	if err != nil {
		return nil, fmt.Errorf("error making draft from local: %w", err)
	}
	return &wshrpc.CommandMakeDraftFromLocalRtnData{
		DraftAppId: draftAppId,
	}, nil
}

func (ws *WshServer) RecordTEventCommand(ctx context.Context, data telemetrydata.TEvent) error {
	err := telemetry.RecordTEvent(ctx, &data)
	if err != nil {
		log.Printf("error recording telemetry event: %v", err)
	}
	return err
}

func (ws WshServer) SendTelemetryCommand(ctx context.Context) error {
	return wcloud.SendAllTelemetry(wstore.GetClientId())
}

func (ws *WshServer) WaveAIGetToolDiffCommand(ctx context.Context, data wshrpc.CommandWaveAIGetToolDiffData) (*wshrpc.CommandWaveAIGetToolDiffRtnData, error) {
	originalContent, modifiedContent, err := aiusechat.CreateWriteTextFileDiff(ctx, data.ChatId, data.ToolCallId)
	if err != nil {
		return nil, err
	}

	return &wshrpc.CommandWaveAIGetToolDiffRtnData{
		OriginalContents64: base64.StdEncoding.EncodeToString(originalContent),
		ModifiedContents64: base64.StdEncoding.EncodeToString(modifiedContent),
	}, nil
}

var wshActivityRe = regexp.MustCompile(`^[a-z:#]+$`)

func (ws *WshServer) WshActivityCommand(ctx context.Context, data map[string]int) error {
	if len(data) == 0 {
		return nil
	}
	props := telemetrydata.TEventProps{}
	for key, value := range data {
		if len(key) > 20 {
			delete(data, key)
		}
		if !wshActivityRe.MatchString(key) {
			delete(data, key)
		}
		if value != 1 {
			delete(data, key)
		}
		if strings.HasSuffix(key, "#error") {
			props.WshCmd = strings.TrimSuffix(key, "#error")
			props.WshErrorCount = 1
		} else {
			props.WshCmd = key
		}
	}
	activityUpdate := wshrpc.ActivityUpdate{
		WshCmds: data,
	}
	telemetry.GoUpdateActivityWrap(activityUpdate, "wsh-activity")
	telemetry.GoRecordTEventWrap(&telemetrydata.TEvent{
		Event: telemetry.WshRunEventName,
		Props: props,
	})
	return nil
}

func (ws *WshServer) GetVarCommand(ctx context.Context, data wshrpc.CommandVarData) (*wshrpc.CommandVarResponseData, error) {
	_, fileData, err := filestore.WFS.ReadFile(ctx, data.ZoneId, data.FileName)
	if err == fs.ErrNotExist {
		return &wshrpc.CommandVarResponseData{Key: data.Key, Exists: false}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("error reading blockfile: %w", err)
	}
	envMap := envutil.EnvToMap(string(fileData))
	value, ok := envMap[data.Key]
	return &wshrpc.CommandVarResponseData{Key: data.Key, Exists: ok, Val: value}, nil
}

func (ws *WshServer) GetAllVarsCommand(ctx context.Context, data wshrpc.CommandVarData) ([]wshrpc.CommandVarResponseData, error) {
	_, fileData, err := filestore.WFS.ReadFile(ctx, data.ZoneId, data.FileName)
	if err == fs.ErrNotExist {
		return []wshrpc.CommandVarResponseData{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("error reading blockfile: %w", err)
	}
	envMap := envutil.EnvToMap(string(fileData))
	keys := make([]string, 0, len(envMap))
	for k := range envMap {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	result := make([]wshrpc.CommandVarResponseData, 0, len(keys))
	for _, k := range keys {
		result = append(result, wshrpc.CommandVarResponseData{
			Key:    k,
			Val:    envMap[k],
			Exists: true,
		})
	}
	return result, nil
}

func (ws *WshServer) GetSessionGroupCommand(ctx context.Context, data wshrpc.CommandGetSessionGroupData) (*wshrpc.CommandGetSessionGroupRtnData, error) {
	if data.Cwd == "" {
		return nil, fmt.Errorf("cwd is required")
	}
	return resolveSessionGroup(data.Cwd), nil
}

func (ws *WshServer) GetAgentTranscriptCommand(ctx context.Context, data wshrpc.CommandGetAgentTranscriptData) (*wshrpc.CommandGetAgentTranscriptRtnData, error) {
	read := readTranscriptTail
	if data.FromStart {
		read = readTranscriptHead
	}
	lines, err := read(data.Path, data.MaxLines)
	if err != nil {
		return nil, fmt.Errorf("reading agent transcript: %w", err)
	}
	return &wshrpc.CommandGetAgentTranscriptRtnData{Lines: lines}, nil
}

func (ws *WshServer) GetSubagentsCommand(ctx context.Context, data wshrpc.CommandGetSubagentsData) (*wshrpc.CommandGetSubagentsRtnData, error) {
	infos, err := listSubagents(data.Path)
	if err != nil {
		return nil, fmt.Errorf("listing subagents: %w", err)
	}
	return &wshrpc.CommandGetSubagentsRtnData{Subagents: infos}, nil
}

func (ws *WshServer) GitChangesCommand(ctx context.Context, data wshrpc.CommandGitChangesData) (*wshrpc.CommandGitChangesRtnData, error) {
	ch, err := gitinfo.GetChanges(ctx, data.Cwd)
	if err != nil {
		return nil, fmt.Errorf("git changes: %w", err)
	}
	return &wshrpc.CommandGitChangesRtnData{Branch: ch.Branch, StatusZ: ch.StatusZ, Numstat: ch.Numstat, IsRepo: ch.IsRepo}, nil
}

func (ws *WshServer) GitDiffCommand(ctx context.Context, data wshrpc.CommandGitDiffData) (*wshrpc.CommandGitDiffRtnData, error) {
	d, err := gitinfo.GetDiff(ctx, data.Cwd, data.Path)
	if err != nil {
		return nil, fmt.Errorf("git diff: %w", err)
	}
	return &wshrpc.CommandGitDiffRtnData{Diff: d.Diff, Content: d.Content, Untracked: d.Untracked}, nil
}

func (ws *WshServer) GitRevertCommand(ctx context.Context, data wshrpc.CommandGitRevertData) error {
	if data.Patch != "" {
		return gitinfo.RevertHunk(ctx, data.Cwd, data.Path, data.Patch)
	}
	return gitinfo.RevertFile(ctx, data.Cwd, data.Path, data.Status)
}

func (ws *WshServer) GetUsageStatsCommand(ctx context.Context, data wshrpc.CommandGetUsageStatsData) (*wshrpc.CommandGetUsageStatsRtnData, error) {
	buckets, err := usagestats.ScanUsage(data.WindowDays)
	if err != nil {
		return nil, fmt.Errorf("scanning usage: %w", err)
	}
	out := make([]wshrpc.UsageBucket, len(buckets))
	for i, b := range buckets {
		out[i] = wshrpc.UsageBucket{
			Provider: b.Provider, Model: b.Model, Day: b.Day,
			Input: b.Input, Output: b.Output, CacheRead: b.CacheRead,
			CacheCreate: b.CacheCreate, CacheCreate1h: b.CacheCreate1h, Msgs: b.Msgs,
		}
	}
	return &wshrpc.CommandGetUsageStatsRtnData{Buckets: out}, nil
}

func (ws *WshServer) GetRecentSessionsCommand(ctx context.Context, data wshrpc.CommandGetRecentSessionsData) (*wshrpc.CommandGetRecentSessionsRtnData, error) {
	sessions, err := agentsessions.ScanSessions(data.WindowDays, data.Limit)
	if err != nil {
		return nil, fmt.Errorf("scanning sessions: %w", err)
	}
	out := make([]wshrpc.SessionInfo, len(sessions))
	for i, s := range sessions {
		out[i] = wshrpc.SessionInfo{
			ID: s.ID, Runtime: s.Runtime, ProjectPath: s.ProjectPath, ProjectName: s.ProjectName,
			Branch: s.Branch, Task: s.Task, Model: s.Model, TokensTotal: s.TokensTotal,
			LastActiveTs: s.LastActiveTs, ResumeCommand: s.ResumeCommand,
		}
	}
	return &wshrpc.CommandGetRecentSessionsRtnData{Sessions: out}, nil
}

func (ws *WshServer) GetSessionsActivityCommand(ctx context.Context, data wshrpc.CommandGetSessionsActivityData) (*wshrpc.CommandGetSessionsActivityRtnData, error) {
	sessions, err := agentsessions.ScanSessions(data.WindowDays, data.Limit)
	if err != nil {
		return nil, fmt.Errorf("scanning sessions: %w", err)
	}
	out := make([]wshrpc.SessionActivity, len(sessions))
	for i, s := range sessions {
		evs := make([]wshrpc.SessionEvent, len(s.Events))
		for j, e := range s.Events {
			evs[j] = wshrpc.SessionEvent{Type: e.Type, Ts: e.Ts, Text: e.Text}
		}
		out[i] = wshrpc.SessionActivity{
			ID: s.ID, Runtime: s.Runtime, ProjectPath: s.ProjectPath, ProjectName: s.ProjectName,
			Branch: s.Branch, Task: s.Task, Model: s.Model, TokensTotal: s.TokensTotal,
			LastActiveTs: s.LastActiveTs, ResumeCommand: s.ResumeCommand, TranscriptPath: s.TranscriptPath,
			Status: s.Status, StartedTs: s.StartedTs, DurationMs: s.DurationMs, Events: evs,
		}
	}
	return &wshrpc.CommandGetSessionsActivityRtnData{Sessions: out}, nil
}

func cutoffFromEpoch(sec int64) time.Time {
	if sec <= 0 {
		return time.Time{}
	}
	return time.Unix(sec, 0)
}

func (ws *WshServer) GetTranscriptTokensCommand(ctx context.Context, data wshrpc.CommandGetTranscriptTokensData) (*wshrpc.CommandGetTranscriptTokensRtnData, error) {
	total, err := usagestats.SumTranscript(data.Path)
	if err != nil {
		return nil, fmt.Errorf("summing transcript tokens: %w", err)
	}
	return &wshrpc.CommandGetTranscriptTokensRtnData{Tokens: total}, nil
}

func (ws *WshServer) GetCacheStatusCommand(ctx context.Context, data wshrpc.CommandGetCacheStatusData) (*wshrpc.CommandGetCacheStatusRtnData, error) {
	cw, err := usagestats.LastCacheWrite(data.Path)
	if err != nil {
		return nil, fmt.Errorf("checking cache status: %w", err)
	}
	if cw == nil {
		return &wshrpc.CommandGetCacheStatusRtnData{}, nil
	}
	return &wshrpc.CommandGetCacheStatusRtnData{LastWriteTs: cw.TS.Unix(), OneHour: cw.OneHour}, nil
}

func (ws *WshServer) GetWindowTokensCommand(ctx context.Context, data wshrpc.CommandGetWindowTokensData) (*wshrpc.CommandGetWindowTokensRtnData, error) {
	cutoffs := []time.Time{cutoffFromEpoch(data.FiveHourCutoff), cutoffFromEpoch(data.WeekCutoff)}
	sums, err := usagestats.WindowTokens(cutoffs)
	if err != nil {
		return nil, fmt.Errorf("summing window tokens: %w", err)
	}
	return &wshrpc.CommandGetWindowTokensRtnData{FiveHourTokens: sums[0], WeekTokens: sums[1]}, nil
}

func (ws *WshServer) MemoryScanCommand(ctx context.Context) (*wshrpc.CommandMemoryScanRtnData, error) {
	g, err := memvault.ScanVault(memvault.VaultRoots())
	if err != nil {
		return nil, fmt.Errorf("scanning memory vault: %w", err)
	}
	notes := make([]wshrpc.MemoryNote, len(g.Notes))
	for i, n := range g.Notes {
		notes[i] = wshrpc.MemoryNote{
			ID: n.ID, Title: n.Title, Description: n.Description, Type: n.Type,
			Scope: n.Scope, Source: n.Source, Path: n.Path, Links: n.Links, UpdatedTs: n.UpdatedTs,
			Reviewed: n.Reviewed, CapturedAt: n.CapturedAt, SupersededBy: n.SupersededBy, LastReferenced: n.LastReferenced,
		}
	}
	edges := make([]wshrpc.MemoryEdge, len(g.Edges))
	for i, e := range g.Edges {
		edges[i] = wshrpc.MemoryEdge{From: e.From, To: e.To}
	}
	return &wshrpc.CommandMemoryScanRtnData{Notes: notes, Edges: edges}, nil
}

func (ws *WshServer) MemoryReadCommand(ctx context.Context, data wshrpc.CommandMemoryReadData) (*wshrpc.CommandMemoryReadRtnData, error) {
	nb, err := memvault.ReadNote(data.Path, data.Source)
	if err != nil {
		return nil, fmt.Errorf("reading note: %w", err)
	}
	n := nb.Note
	return &wshrpc.CommandMemoryReadRtnData{
		Note: wshrpc.MemoryNote{
			ID: n.ID, Title: n.Title, Description: n.Description, Type: n.Type,
			Scope: n.Scope, Source: n.Source, Path: n.Path, Links: n.Links, UpdatedTs: n.UpdatedTs,
			Reviewed: n.Reviewed, CapturedAt: n.CapturedAt, SupersededBy: n.SupersededBy, LastReferenced: n.LastReferenced,
		},
		Body: nb.Body,
	}, nil
}

func (ws *WshServer) MemoryWriteCommand(ctx context.Context, data wshrpc.CommandMemoryWriteData) (*wshrpc.CommandMemoryWriteRtnData, error) {
	res, err := memvault.WriteNote(data.Path, data.Content, data.BaseMtime)
	if err != nil {
		return nil, fmt.Errorf("writing note: %w", err)
	}
	return &wshrpc.CommandMemoryWriteRtnData{Mtime: res.Mtime, Conflict: res.Conflict}, nil
}

func (ws *WshServer) MemoryCreateCommand(ctx context.Context, data wshrpc.CommandMemoryCreateData) (*wshrpc.CommandMemoryCreateRtnData, error) {
	vaultDir := memvault.DefaultVaultPath()
	if hub := memvault.HubDirForCwd(data.Cwd); hub != "" {
		vaultDir = hub
	}
	path, err := memvault.CreateNote(vaultDir, data.Name, data.Type, data.Scope, data.Body)
	if err != nil {
		return nil, fmt.Errorf("creating note: %w", err)
	}
	return &wshrpc.CommandMemoryCreateRtnData{Path: path}, nil
}

func (ws *WshServer) MemoryDeleteCommand(ctx context.Context, data wshrpc.CommandMemoryDeleteData) error {
	if err := memvault.DeleteNote(data.Path); err != nil {
		return fmt.Errorf("deleting note: %w", err)
	}
	return nil
}

func (ws *WshServer) MemoryProjectCommand(ctx context.Context, data wshrpc.CommandMemoryProjectData) error {
	if err := memvault.Project(data.Cwd); err != nil {
		return fmt.Errorf("projecting memory: %w", err)
	}
	return nil
}

func (ws *WshServer) MemoryProjectionStatusCommand(ctx context.Context) (*wshrpc.CommandMemoryProjectionStatusRtnData, error) {
	return &wshrpc.CommandMemoryProjectionStatusRtnData{Runtimes: memvault.ProjectionStatus()}, nil
}

func (ws *WshServer) MemoryHarvestCommand(ctx context.Context, data wshrpc.CommandMemoryHarvestData) (*wshrpc.CommandMemoryHarvestRtnData, error) {
	ingested, skipped, err := memvault.Harvest(data.Cwd)
	if err != nil {
		return nil, fmt.Errorf("harvesting memory: %w", err)
	}
	return &wshrpc.CommandMemoryHarvestRtnData{Ingested: ingested, Skipped: skipped}, nil
}

func (ws *WshServer) MemoryLearnCommand(ctx context.Context, data wshrpc.CommandMemoryLearnData) (*wshrpc.CommandMemoryLearnRtnData, error) {
	hub := memvault.HubDirForCwd(data.Cwd)
	rtn := &wshrpc.CommandMemoryLearnRtnData{}
	for _, c := range data.Candidates {
		cand := memvault.LearnCandidate{Type: c.Type, Scope: c.Scope, Body: c.Body, IsCorrection: c.IsCorrection, Supersedes: c.Supersedes}
		if c.IsCorrection {
			// corrections auto-commit into the project hub, or the default vault when there's no cwd
			target := hub
			if target == "" {
				target = memvault.DefaultVaultPath()
			}
			wrote, _, err := memvault.WriteLearning(target, cand)
			if err != nil {
				return nil, fmt.Errorf("writing learning: %w", err)
			}
			if wrote {
				rtn.Committed++
			}
		} else {
			if _, err := memvault.WritePending(memvault.PendingDir(), cand, data.Cwd); err != nil {
				return nil, fmt.Errorf("queuing candidate: %w", err)
			}
			rtn.Queued++
		}
	}
	if hub != "" {
		for _, c := range data.Candidates {
			if c.Supersedes != "" {
				_, slug, _ := memvault.WriteLearning(hub, memvault.LearnCandidate{Type: c.Type, Scope: c.Scope, Body: c.Body}) // slug of the new note
				_ = memvault.MarkSuperseded(hub, c.Supersedes, slug)
			}
		}
		if len(data.References) > 0 {
			_ = memvault.TouchReferenced(hub, data.References, time.Now().UTC().Format(time.RFC3339))
		}
	}
	return rtn, nil
}

func (ws *WshServer) MemoryReviewListCommand(ctx context.Context) (*wshrpc.CommandMemoryReviewListRtnData, error) {
	pns := memvault.ListPending(memvault.PendingDir())
	out := make([]wshrpc.MemoryPendingNote, len(pns))
	for i, p := range pns {
		out[i] = wshrpc.MemoryPendingNote{
			Path:       p.Path,
			Title:      p.Title,
			Type:       p.Type,
			Scope:      p.Scope,
			Source:     p.Source,
			Body:       p.Body,
			Cwd:        p.Cwd,
			CapturedAt: p.CapturedAt,
		}
	}
	return &wshrpc.CommandMemoryReviewListRtnData{Pending: out}, nil
}

func (ws *WshServer) MemoryReviewAcceptCommand(ctx context.Context, data wshrpc.CommandMemoryReviewAcceptData) error {
	if _, err := memvault.AcceptPending(data.Path); err != nil {
		return fmt.Errorf("accepting candidate: %w", err)
	}
	return nil
}

func (ws *WshServer) MemoryPruneListCommand(ctx context.Context) (*wshrpc.CommandMemoryPruneListRtnData, error) {
	cands := memvault.PruneCandidates(time.Now().UTC())
	out := make([]wshrpc.MemoryPruneCandidate, len(cands))
	for i, c := range cands {
		out[i] = wshrpc.MemoryPruneCandidate{ID: c.ID, Title: c.Title, Reason: c.Reason, Path: c.Path}
	}
	return &wshrpc.CommandMemoryPruneListRtnData{Candidates: out}, nil
}

func (ws *WshServer) CreateChannelCommand(ctx context.Context, data wshrpc.CommandCreateChannelData) (*waveobj.Channel, error) {
	ch, err := wstore.CreateChannel(ctx, data.Name, data.ProjectPath)
	if err != nil {
		return nil, fmt.Errorf("creating channel: %w", err)
	}
	return ch, nil
}

func (ws *WshServer) DeleteChannelCommand(ctx context.Context, data wshrpc.CommandDeleteChannelData) error {
	if err := wstore.DeleteChannel(ctx, data.ChannelId); err != nil {
		return fmt.Errorf("deleting channel: %w", err)
	}
	return nil
}

func (ws *WshServer) GetChannelsCommand(ctx context.Context) (*wshrpc.CommandGetChannelsRtnData, error) {
	chans, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing channels: %w", err)
	}
	return &wshrpc.CommandGetChannelsRtnData{Channels: chans}, nil
}

func (ws *WshServer) PostChannelMessageCommand(ctx context.Context, data wshrpc.CommandPostChannelMessageData) (*waveobj.ChannelMessage, error) {
	msg := wstore.NewChannelMessage(data.Kind, data.Author, data.Text, data.RefORef, time.Now().UnixMilli())
	stored, err := wstore.PostChannelMessage(ctx, data.ChannelId, msg)
	if err != nil {
		return nil, fmt.Errorf("posting channel message: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return stored, nil
}

func (ws *WshServer) SetChannelTierCommand(ctx context.Context, data wshrpc.CommandSetChannelTierData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	gk, del := jarvis.TierMeta(data.Tier)
	mode := data.Mode
	if mode == "" {
		mode = "report"
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		ch.Meta[jarvis.MetaKey_GatekeeperEnabled] = gk
		ch.Meta[jarvis.MetaKey_DelegatorEnabled] = del
		ch.Meta[jarvis.MetaKey_DelegatorMode] = mode
	})
	if err != nil {
		return fmt.Errorf("updating channel tier: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) SetChannelReadCommand(ctx context.Context, data wshrpc.CommandSetChannelReadData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	if err := wstore.SetChannelRead(ctx, data.ChannelId, data.Ts); err != nil {
		return fmt.Errorf("updating channel read ts: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) RenameChannelCommand(ctx context.Context, data wshrpc.CommandRenameChannelData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	name := strings.TrimSpace(data.Name)
	if name == "" {
		return fmt.Errorf("name is required")
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		ch.Name = name
	})
	if err != nil {
		return fmt.Errorf("renaming channel: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) ArchiveChannelCommand(ctx context.Context, data wshrpc.CommandArchiveChannelData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		ch.Meta[wstore.MetaKey_Archived] = data.Archived
	})
	if err != nil {
		return fmt.Errorf("updating channel archived flag: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) SetChannelMessagePickCommand(ctx context.Context, data wshrpc.CommandSetChannelMessagePickData) error {
	if data.ChannelId == "" || data.MessageId == "" {
		return fmt.Errorf("channelid and messageid are required")
	}
	err := wstore.UpdateChannelMessage(ctx, data.ChannelId, data.MessageId, func(msg *waveobj.ChannelMessage) error {
		patched, err := jarvis.SetCardHumanPick(msg.Data, data.Pick)
		if err != nil {
			return fmt.Errorf("patching card pick: %w", err)
		}
		msg.Data = patched
		return nil
	})
	if err != nil {
		return fmt.Errorf("recording message pick: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

// spawnRunWorkers reads the run back, spawns workers for any newly-running phase, and persists the
// attached orefs — a second write, so tab-creation never nests inside the run's state-transition write.
//
// EnsureWorkers creates a tab + block per worker (via wcore.CreateTab), which mutates the workspace's
// tab list and inserts new objects. Those mutations only reach the frontend if this ctx collects and
// flushes their update events — without that, the workspace atom never gains the worker's tab, the tab
// never enters the session roster, and the run renders a false "worker exited" until a full reload.
func spawnRunWorkers(ctx context.Context, channelId, runId, projectName string) error {
	ctx = waveobj.ContextWithUpdates(ctx)
	run, err := wstore.GetRun(ctx, channelId, runId)
	if err != nil {
		return err
	}
	spawned, spawnErr := jarvis.EnsureWorkers(ctx, run, projectName)
	if len(spawned) > 0 {
		if uerr := wstore.UpdateRun(ctx, channelId, runId, func(r *waveobj.Run) error {
			for idx, oref := range spawned {
				if idx >= 0 && idx < len(r.Phases) {
					r.Phases[idx].WorkerOrefs = append(r.Phases[idx].WorkerOrefs, oref)
				}
			}
			return nil
		}); uerr != nil {
			return uerr
		}
	}
	wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx))
	return spawnErr // surfaced but non-fatal to already-persisted state
}

// resolveRunPlan derives the effective mode + playbook for a new run from the resolved profile and the
// request's optional overrides. Precedence: request > profile default > built-in (pipeline; gate on).
func resolveRunPlan(resolved waveobj.JarvisProfile, reqMode string, reqPlanGate *bool) (string, []waveobj.RunPhase) {
	mode := reqMode
	if mode == "" {
		mode = resolved.DefaultMode
	}
	if mode == "" {
		mode = jarvis.RunMode_Pipeline
	}
	if mode == jarvis.RunMode_Orchestrator {
		gate := true
		if reqPlanGate != nil {
			gate = *reqPlanGate
		} else if resolved.DefaultPlanGate != nil {
			gate = *resolved.DefaultPlanGate
		}
		return mode, jarvis.DefaultOrchestratorPlaybook(gate)
	}
	playbook := resolved.Playbook
	if len(playbook) == 0 {
		playbook = jarvis.DefaultPlaybook()
	}
	return mode, playbook
}

func (ws *WshServer) CreateRunCommand(ctx context.Context, data wshrpc.CommandCreateRunData) (*wshrpc.CommandCreateRunRtnData, error) {
	if data.ChannelId == "" || data.WorkspaceId == "" || data.Goal == "" {
		return nil, fmt.Errorf("channelid, workspaceid and goal are required")
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
	if err != nil {
		return nil, fmt.Errorf("loading channel: %w", err)
	}
	global := jarvis.LoadGlobalProfile()
	resolved := jarvis.ResolveProfile(global, jarvis.OverrideFromMeta(ch))
	mode, playbook := resolveRunPlan(resolved, data.Mode, data.PlanGate)
	run := jarvis.NewRun(data.Goal, data.WorkspaceId, ch.ProjectPath, resolved.Principles, mode, playbook, time.Now().UnixMilli())
	run.RadarOrigin = data.RadarOrigin // nil for normal runs; set only from a Radar handoff
	if err := wstore.AppendRun(ctx, data.ChannelId, run); err != nil {
		return nil, fmt.Errorf("appending run: %w", err)
	}
	if err := spawnRunWorkers(ctx, data.ChannelId, run.ID, ch.Name); err != nil {
		// the run is persisted; surface the spawn failure but return the run so the UI can show blocked/retry
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
		return nil, fmt.Errorf("spawning first worker: %w", err)
	}
	out, _ := wstore.GetRun(ctx, data.ChannelId, run.ID)
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return &wshrpc.CommandCreateRunRtnData{Run: out}, nil
}

// steerRunLead sends a line of input into the block of a run worker (tab oref "tab:<id>"), resuming a
// long-lived lead in place. Best-effort: resolution/send failures are logged, never fatal.
func steerRunLead(ctx context.Context, tabORef, text string) {
	oref, err := waveobj.ParseORef(tabORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		log.Printf("steerRunLead: bad oref %q: %v", tabORef, err)
		return
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, oref.OID)
	if err != nil || len(tab.BlockIds) == 0 {
		log.Printf("steerRunLead: no block for %q: %v", tabORef, err)
		return
	}
	if err := blockcontroller.SendInput(tab.BlockIds[0], &blockcontroller.BlockInputUnion{InputData: []byte(text)}); err != nil {
		log.Printf("steerRunLead: sending input to %q: %v", tabORef, err)
	}
}

// applyRunAction dispatches a run action to the matching engine transition (pure; no persistence).
// Triage is non-blocking — it records the lead's verdict and leaves progress untouched.
func applyRunAction(r waveobj.Run, data wshrpc.CommandAdvanceRunData) (waveobj.Run, error) {
	switch data.Action {
	case jarvis.RunAction_Complete:
		return jarvis.CompletePhase(r, data.PhaseIdx, data.Artifacts)
	case jarvis.RunAction_Approve:
		return jarvis.ApproveGate(r)
	case jarvis.RunAction_SendBack:
		return jarvis.SendBackGate(r)
	case jarvis.RunAction_Hold:
		return jarvis.HoldPhase(r, data.PhaseIdx, data.Artifacts)
	case jarvis.RunAction_Triage:
		return jarvis.RecordTriage(r, data.PhaseIdx, data.Verdict, data.Note)
	default:
		return r, fmt.Errorf("unknown run action %q", data.Action)
	}
}

func (ws *WshServer) AdvanceRunCommand(ctx context.Context, data wshrpc.CommandAdvanceRunData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	// approve-in-place: an orchestrator lead held at the plan gate resumes via steer, not a fresh worker.
	leadToSteer := ""
	if data.Action == jarvis.RunAction_Approve {
		if pre, perr := wstore.GetRun(ctx, data.ChannelId, data.RunId); perr == nil {
			for i := range pre.Phases {
				if pre.Phases[i].State == jarvis.PhaseState_Running && pre.Phases[i].Held && len(pre.Phases[i].WorkerOrefs) > 0 {
					leadToSteer = pre.Phases[i].WorkerOrefs[0]
					break
				}
			}
		}
	}
	err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		next, e := applyRunAction(*r, data)
		if e != nil {
			return e
		}
		*r = next
		return nil
	})
	if err != nil {
		return fmt.Errorf("advancing run: %w", err)
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
	if err != nil {
		return fmt.Errorf("loading channel: %w", err)
	}
	if err := spawnRunWorkers(ctx, data.ChannelId, data.RunId, ch.Name); err != nil {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
		return fmt.Errorf("spawning next worker: %w", err)
	}
	if leadToSteer != "" {
		steerRunLead(ctx, leadToSteer, "approved, proceed\r")
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) ReportRunPhaseCommand(ctx context.Context, data wshrpc.CommandReportRunPhaseData) error {
	if data.ORef == "" {
		return fmt.Errorf("oref is required")
	}
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return fmt.Errorf("loading channels: %w", err)
	}
	m := jarvis.ResolveRunWorker(channels, data.ORef)
	if m == nil {
		log.Printf("ReportRunPhase: no run owns oref %q (ignoring)", data.ORef)
		return nil // fail safe: a stray report is a no-op, not an error
	}
	return ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: m.Channel.OID,
		RunId:     m.Run.ID,
		PhaseIdx:  m.PhaseIdx,
		Action:    data.Action,
		Artifacts: data.Artifacts,
		Verdict:   data.Verdict,
		Note:      data.Note,
	})
}

func (ws *WshServer) CancelRunCommand(ctx context.Context, data wshrpc.CommandCancelRunData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		*r = jarvis.CancelRun(*r)
		return nil
	})
	if err != nil {
		return fmt.Errorf("cancelling run: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) StartRadarScanCommand(ctx context.Context, data wshrpc.CommandStartRadarScanData) (*wshrpc.CommandStartRadarScanRtnData, error) {
	rpt, err := reporadar.Start(ctx, data.ProjectPath)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandStartRadarScanRtnData{Report: rpt}, nil
}

func (ws *WshServer) CancelRadarScanCommand(ctx context.Context, data wshrpc.CommandCancelRadarScanData) error {
	if data.ReportId == "" {
		return fmt.Errorf("reportid is required")
	}
	return reporadar.Cancel(data.ReportId)
}

func (ws *WshServer) ListRadarReportsCommand(ctx context.Context, data wshrpc.CommandListRadarReportsData) (*wshrpc.CommandListRadarReportsRtnData, error) {
	reports, err := reporadar.ListReports(ctx, data.ProjectPath)
	if err != nil {
		return nil, fmt.Errorf("listing radar reports: %w", err)
	}
	return &wshrpc.CommandListRadarReportsRtnData{Reports: reports}, nil
}

func (ws *WshServer) SetRadarFindingDispositionCommand(ctx context.Context, data wshrpc.CommandSetRadarFindingDispositionData) error {
	if data.ReportId == "" || data.FindingId == "" {
		return fmt.Errorf("reportid and findingid are required")
	}
	return reporadar.ApplyDisposition(ctx, data.ReportId, data.FindingId, data.Action, data.Reason, data.Note)
}

func (ws *WshServer) RetryRadarClusteringCommand(ctx context.Context, data wshrpc.CommandRetryRadarClusteringData) error {
	if data.ReportId == "" {
		return fmt.Errorf("reportid is required")
	}
	return reporadar.Retry(ctx, data.ReportId)
}

func (ws *WshServer) GetJarvisProfileCommand(ctx context.Context, data wshrpc.CommandGetJarvisProfileData) (*wshrpc.CommandGetJarvisProfileRtnData, error) {
	if data.ChannelId == "" {
		return nil, fmt.Errorf("channelid is required")
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
	if err != nil {
		return nil, fmt.Errorf("loading channel: %w", err)
	}
	global := jarvis.LoadGlobalProfile()
	override := jarvis.OverrideFromMeta(ch)
	return &wshrpc.CommandGetJarvisProfileRtnData{
		Global:   global,
		Override: override,
		Resolved: jarvis.ResolveProfile(global, override),
	}, nil
}

func (ws *WshServer) SetChannelProfileCommand(ctx context.Context, data wshrpc.CommandSetChannelProfileData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	empty := data.Override == nil || (data.Override.Playbook == nil && data.Override.Principles == nil &&
		data.Override.DefaultMode == nil && data.Override.DefaultPlanGate == nil)
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		if empty {
			delete(ch.Meta, jarvis.MetaKey_JarvisProfile)
		} else {
			ch.Meta[jarvis.MetaKey_JarvisProfile] = data.Override
		}
	})
	if err != nil {
		return fmt.Errorf("updating channel profile: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) JarvisDecomposeCommand(ctx context.Context, data wshrpc.CommandJarvisDecomposeData) (*wshrpc.CommandJarvisDecomposeRtnData, error) {
	if strings.TrimSpace(data.Goal) == "" {
		return nil, fmt.Errorf("goal is required")
	}
	var channel *waveobj.Channel
	projectPath := ""
	if data.ChannelId != "" {
		channels, err := wstore.GetChannels(ctx)
		if err == nil {
			for _, ch := range channels {
				if ch.OID == data.ChannelId {
					channel = ch
					projectPath = ch.ProjectPath
					break
				}
			}
		}
	}
	subtasks := jarvis.Decompose(ctx, projectPath, data.Goal, channel)
	return &wshrpc.CommandJarvisDecomposeRtnData{Subtasks: subtasks}, nil
}

const consultTimeout = 120 * time.Second

// postConsultReply persists a consult-reply message and live-updates the pinned channel atom. Mirrors
// PostChannelMessageCommand's post+update pattern for the fire-and-forget consult goroutine. It runs on
// a fresh context, not the RPC request ctx: the request ctx is routinely already cancelled/expired by
// the time a slow consult finishes, and the persisted reply is exactly what lets the FE card resolve,
// so the write must not be tied to the request lifecycle.
func postConsultReply(data wshrpc.CommandConsultData, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage("consult-reply", data.Runtime, text, "consult:"+data.ConsultId, time.Now().UnixMilli())
	if _, err := wstore.PostChannelMessage(ctx, data.ChannelId, msg); err != nil {
		log.Printf("consult: failed to post reply: %v", err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
}

func (ws *WshServer) ConsultCommand(ctx context.Context, data wshrpc.CommandConsultData) chan wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk])
	go func() {
		defer func() {
			panichandler.PanicHandler("ConsultCommand", recover())
		}()
		defer close(rtn)
		ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
		if err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Error: fmt.Errorf("channel not found: %w", err)}
			return
		}
		spec, ok := consult.SpecFor(data.Runtime)
		if !ok {
			postConsultReply(data, "consult is not supported for @"+data.Runtime)
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Error: fmt.Errorf("unsupported runtime: %s", data.Runtime)}
			return
		}
		// claude discovers ~/.claude/CLAUDE.md itself (it runs with cwd = project path); other runtimes
		// don't, so inject the operator's global principles for them. a read failure must not fail the
		// consult — log and continue with none.
		var principles string
		if data.Runtime != "claude" {
			p, perr := consult.OperatorPrinciples()
			if perr != nil {
				log.Printf("consult: reading operator principles: %v", perr)
			}
			principles = p
		}
		prompt := consult.BuildPrompt(ch.Messages, data.Prompt, principles)
		runCtx, cancel := context.WithTimeout(ctx, consultTimeout)
		defer cancel()
		full, runErr := consult.Run(runCtx, spec, ch.ProjectPath, prompt, func(chunk string) {
			// live streaming is best-effort: never let a stalled/absent stream consumer wedge Run
			// (the persisted consult-reply below is the reliable path the FE resolves on).
			select {
			case rtn <- wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk]{Response: wshrpc.ConsultChunk{Text: chunk}}:
			case <-runCtx.Done():
			}
		})
		reply := strings.TrimSpace(full)
		if runErr != nil {
			if reply != "" {
				reply += "\n\n"
			}
			reply += "consult failed: " + runErr.Error()
		}
		postConsultReply(data, reply)
	}()
	return rtn
}

// postJarvisReply persists the jarvis-reply message and live-updates the pinned channel atom. Mirrors
// postConsultReply (fresh context, not the RPC request ctx, since a slow summary routinely outlives it).
func postJarvisReply(data wshrpc.CommandJarvisData, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	msg := wstore.NewChannelMessage("jarvis-reply", "jarvis", text, "jarvis:"+data.RequestId, time.Now().UnixMilli())
	if _, err := wstore.PostChannelMessage(ctx, data.ChannelId, msg); err != nil {
		log.Printf("jarvis: failed to post reply: %v", err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
}

func (ws *WshServer) JarvisCommand(ctx context.Context, data wshrpc.CommandJarvisData) chan wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk])
	go func() {
		defer func() {
			panichandler.PanicHandler("JarvisCommand", recover())
		}()
		defer close(rtn)
		ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
		if err != nil {
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Error: fmt.Errorf("channel not found: %w", err)}
			return
		}
		spec, ok := consult.SpecFor("claude")
		if !ok {
			postJarvisReply(data, "jarvis requires the claude CLI, which is not available")
			rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Error: fmt.Errorf("claude runtime unavailable")}
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, consultTimeout)
		defer cancel()
		full, runErr := consult.Run(runCtx, spec, ch.ProjectPath, data.Prompt, func(chunk string) {
			select {
			case rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk]{Response: wshrpc.JarvisChunk{Text: chunk}}:
			case <-runCtx.Done():
			}
		})
		reply := strings.TrimSpace(full)
		if runErr != nil {
			if reply != "" {
				reply += "\n\n"
			}
			reply += "jarvis failed: " + runErr.Error()
		}
		postJarvisReply(data, reply)
	}()
	return rtn
}

func (ws *WshServer) ListConsultRuntimesCommand(ctx context.Context) (*wshrpc.CommandListConsultRuntimesRtnData, error) {
	var infos []wshrpc.ConsultRuntimeInfo
	for _, rt := range consult.SupportedRuntimes() {
		installed, version := consult.ProbeInstalled(ctx, rt)
		infos = append(infos, wshrpc.ConsultRuntimeInfo{Runtime: rt, Installed: installed, Version: version})
	}
	return &wshrpc.CommandListConsultRuntimesRtnData{Runtimes: infos}, nil
}

func (ws *WshServer) StreamAgentTranscriptCommand(ctx context.Context, data wshrpc.CommandStreamAgentTranscriptData) chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate] {
	ch := make(chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate], 16)
	go func() {
		defer func() {
			panichandler.PanicHandler("StreamAgentTranscriptCommand", recover())
		}()
		defer close(ch)
		if err := streamTranscript(ctx, data.Path, data.TailLines, ch); err != nil {
			ch <- wshutil.RespErr[wshrpc.AgentTranscriptUpdate](err)
		}
	}()
	return ch
}

func (ws *WshServer) SetVarCommand(ctx context.Context, data wshrpc.CommandVarData) error {
	_, fileData, err := filestore.WFS.ReadFile(ctx, data.ZoneId, data.FileName)
	if err == fs.ErrNotExist {
		fileData = []byte{}
		err = filestore.WFS.MakeFile(ctx, data.ZoneId, data.FileName, nil, wshrpc.FileOpts{})
		if err != nil {
			return fmt.Errorf("error creating blockfile: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("error reading blockfile: %w", err)
	}
	envMap := envutil.EnvToMap(string(fileData))
	if data.Remove {
		delete(envMap, data.Key)
	} else {
		envMap[data.Key] = data.Val
	}
	envStr := envutil.MapToEnv(envMap)
	return filestore.WFS.WriteFile(ctx, data.ZoneId, data.FileName, []byte(envStr))
}

func (ws *WshServer) PathCommand(ctx context.Context, data wshrpc.PathCommandData) (string, error) {
	pathType := data.PathType
	openInternal := data.Open
	openExternal := data.OpenExternal
	var path string
	switch pathType {
	case "config":
		path = wavebase.GetWaveConfigDir()
	case "data":
		path = wavebase.GetWaveDataDir()
	case "log":
		path = filepath.Join(wavebase.GetWaveDataDir(), "waveapp.log")
	}

	if openInternal && openExternal {
		return "", fmt.Errorf("open and openExternal cannot both be true")
	}

	if openInternal {
		_, err := ws.CreateBlockCommand(ctx, wshrpc.CommandCreateBlockData{
			TabId: data.TabId,
			BlockDef: &waveobj.BlockDef{Meta: map[string]any{
				waveobj.MetaKey_View: "preview",
				waveobj.MetaKey_File: path,
			}},
			Ephemeral: true,
			Focused:   true,
		})

		if err != nil {
			return path, fmt.Errorf("error opening path: %w", err)
		}
	} else if openExternal {
		err := open.Run(path)
		if err != nil {
			return path, fmt.Errorf("error opening path: %w", err)
		}
	}
	return path, nil
}

func (ws *WshServer) FetchSuggestionsCommand(ctx context.Context, data wshrpc.FetchSuggestionsData) (*wshrpc.FetchSuggestionsResponse, error) {
	return suggestion.FetchSuggestions(ctx, data)
}

func (ws *WshServer) DisposeSuggestionsCommand(ctx context.Context, widgetId string) error {
	suggestion.DisposeSuggestions(ctx, widgetId)
	return nil
}

func (ws *WshServer) GetAllBadgesCommand(ctx context.Context) ([]baseds.BadgeEvent, error) {
	return wcore.GetAllBadges(), nil
}

func (ws *WshServer) GetSecretsCommand(ctx context.Context, names []string) (map[string]string, error) {
	result := make(map[string]string)
	for _, name := range names {
		value, exists, err := secretstore.GetSecret(name)
		if err != nil {
			return nil, fmt.Errorf("error getting secret %q: %w", name, err)
		}
		if exists {
			result[name] = value
		}
	}
	return result, nil
}

func (ws *WshServer) GetSecretsNamesCommand(ctx context.Context) ([]string, error) {
	names, err := secretstore.GetSecretNames()
	if err != nil {
		return nil, fmt.Errorf("error getting secret names: %w", err)
	}
	return names, nil
}

func (ws *WshServer) SetSecretsCommand(ctx context.Context, secrets map[string]*string) error {
	for name, value := range secrets {
		if value == nil {
			err := secretstore.DeleteSecret(name)
			if err != nil {
				return fmt.Errorf("error deleting secret %q: %w", name, err)
			}
		} else {
			err := secretstore.SetSecret(name, *value)
			if err != nil {
				return fmt.Errorf("error setting secret %q: %w", name, err)
			}
		}
	}
	return nil
}

func (ws *WshServer) GetSecretsLinuxStorageBackendCommand(ctx context.Context) (string, error) {
	backend, err := secretstore.GetLinuxStorageBackend()
	if err != nil {
		return "", fmt.Errorf("error getting linux storage backend: %w", err)
	}
	return backend, nil
}

func (ws *WshServer) JobCmdExitedCommand(ctx context.Context, data wshrpc.CommandJobCmdExitedData) error {
	return jobcontroller.HandleCmdJobExited(ctx, data.JobId, data)
}

func (ws *WshServer) JobControllerListCommand(ctx context.Context) ([]*waveobj.Job, error) {
	return wstore.DBGetAllObjsByType[*waveobj.Job](ctx, waveobj.OType_Job)
}

func (ws *WshServer) JobControllerDeleteJobCommand(ctx context.Context, jobId string) error {
	return jobcontroller.DeleteJob(ctx, jobId)
}

func (ws *WshServer) JobControllerStartJobCommand(ctx context.Context, data wshrpc.CommandJobControllerStartJobData) (string, error) {
	params := jobcontroller.StartJobParams{
		ConnName: data.ConnName,
		JobKind:  data.JobKind,
		Cmd:      data.Cmd,
		Args:     data.Args,
		Env:      data.Env,
		TermSize: data.TermSize,
	}
	return jobcontroller.StartJob(ctx, params)
}

func (ws *WshServer) JobControllerExitJobCommand(ctx context.Context, jobId string) error {
	return jobcontroller.TerminateJobManager(ctx, jobId)
}

func (ws *WshServer) JobControllerDisconnectJobCommand(ctx context.Context, jobId string) error {
	return jobcontroller.DisconnectJob(ctx, jobId)
}

func (ws *WshServer) JobControllerReconnectJobCommand(ctx context.Context, jobId string) error {
	return jobcontroller.ReconnectJob(ctx, jobId, nil)
}

func (ws *WshServer) JobControllerReconnectJobsForConnCommand(ctx context.Context, connName string) error {
	return jobcontroller.ReconnectJobsForConn(ctx, connName)
}

func (ws *WshServer) JobControllerConnectedJobsCommand(ctx context.Context) ([]string, error) {
	return jobcontroller.GetConnectedJobIds(), nil
}

func (ws *WshServer) JobControllerAttachJobCommand(ctx context.Context, data wshrpc.CommandJobControllerAttachJobData) error {
	return jobcontroller.AttachJobToBlock(ctx, data.JobId, data.BlockId)
}

func (ws *WshServer) JobControllerDetachJobCommand(ctx context.Context, jobId string) error {
	return jobcontroller.DetachJobFromBlock(ctx, jobId, true)
}

func (ws *WshServer) BlockJobStatusCommand(ctx context.Context, blockId string) (*wshrpc.BlockJobStatusData, error) {
	return jobcontroller.GetBlockJobStatus(ctx, blockId)
}

func (ws *WshServer) AskCommand(ctx context.Context, data wshrpc.CommandAskData) (wshrpc.AskRtnData, error) {
	if data.ORef == "" || len(data.Questions) == 0 {
		return wshrpc.AskRtnData{}, fmt.Errorf("oref and at least one question are required")
	}
	oref, err := waveobj.ParseORef(data.ORef)
	if err != nil {
		return wshrpc.AskRtnData{}, fmt.Errorf("invalid oref %q: %w", data.ORef, err)
	}
	askId := uuid.New().String()
	agentask.GlobalRegistry.Set(data.ORef, agentask.PendingAsk{
		AskId:     askId,
		BlockId:   oref.OID,
		Questions: data.Questions,
	})
	publishAgentAsk(baseds.AgentAskData{
		ORef:      data.ORef,
		AskId:     askId,
		Questions: data.Questions,
		Ts:        time.Now().UnixMilli(),
	})
	return wshrpc.AskRtnData{AskId: askId}, nil
}

func (ws *WshServer) AnswerAgentCommand(ctx context.Context, data wshrpc.CommandAnswerAgentData) error {
	if data.ORef == "" {
		return fmt.Errorf("oref is required")
	}
	_, err := agentask.DeliverAnswer(data.ORef, data.Answers)
	return err
}

func (ws *WshServer) AgentAskClearCommand(ctx context.Context, oref string) error {
	if oref == "" {
		return fmt.Errorf("oref is required")
	}
	askId := ""
	if pending, ok := agentask.GlobalRegistry.Get(oref); ok {
		askId = pending.AskId
	}
	agentask.GlobalRegistry.Drop(oref)
	publishAgentAsk(baseds.AgentAskData{ORef: oref, AskId: askId, Cleared: true})
	return nil
}

func publishAgentAsk(data baseds.AgentAskData) {
	jarvis.OnAgentAsk(data) // Gatekeeper (server-side, non-blocking): auto-answer/escalate on enabled channels
	wps.Broker.Publish(wps.WaveEvent{
		Event:   wps.Event_AgentAsk,
		Scopes:  []string{data.ORef},
		Persist: 1,
		Data:    data,
	})
}
