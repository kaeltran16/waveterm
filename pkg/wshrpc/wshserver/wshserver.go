// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

// this file contains the implementation of the wsh server methods

import (
	"context"
	"encoding/base64"
	"fmt"
	"io/fs"
	"log"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/skratchdot/open-golang/open"
	"github.com/wavetermdev/waveterm/pkg/aiusechat"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/suggestion"
	"github.com/wavetermdev/waveterm/pkg/telemetry"
	"github.com/wavetermdev/waveterm/pkg/telemetry/telemetrydata"
	"github.com/wavetermdev/waveterm/pkg/util/envutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wavejwt"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcloud"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

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

func (ws *WshServer) GetFullConfigCommand(ctx context.Context) (wconfig.FullConfigType, error) {
	watcher := wconfig.GetWatcher()
	return watcher.GetFullConfig(), nil
}

func (ws *WshServer) GetWaveAIModeConfigCommand(ctx context.Context) (wconfig.AIModeConfigUpdate, error) {
	fullConfig := wconfig.GetWatcher().GetFullConfig()
	resolvedConfigs := aiusechat.ComputeResolvedAIModeConfigs(fullConfig)
	return wconfig.AIModeConfigUpdate{Configs: resolvedConfigs}, nil
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
