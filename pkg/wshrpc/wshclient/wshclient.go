// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Generated Code. DO NOT EDIT.

package wshclient

import (
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/telemetry/telemetrydata"
	"github.com/wavetermdev/waveterm/pkg/vdom"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// command "advancerun", wshserver.AdvanceRunCommand
func AdvanceRunCommand(w *wshutil.WshRpc, data wshrpc.CommandAdvanceRunData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "advancerun", data, opts)
	return err
}

// command "agentaskclear", wshserver.AgentAskClearCommand
func AgentAskClearCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "agentaskclear", data, opts)
	return err
}

// command "answeragent", wshserver.AnswerAgentCommand
func AnswerAgentCommand(w *wshutil.WshRpc, data wshrpc.CommandAnswerAgentData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "answeragent", data, opts)
	return err
}

// command "archivechannel", wshserver.ArchiveChannelCommand
func ArchiveChannelCommand(w *wshutil.WshRpc, data wshrpc.CommandArchiveChannelData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "archivechannel", data, opts)
	return err
}

// command "ask", wshserver.AskCommand
func AskCommand(w *wshutil.WshRpc, data wshrpc.CommandAskData, opts *wshrpc.RpcOpts) (wshrpc.AskRtnData, error) {
	resp, err := sendRpcRequestCallHelper[wshrpc.AskRtnData](w, "ask", data, opts)
	return resp, err
}

// command "authenticate", wshserver.AuthenticateCommand
func AuthenticateCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) (wshrpc.CommandAuthenticateRtnData, error) {
	resp, err := sendRpcRequestCallHelper[wshrpc.CommandAuthenticateRtnData](w, "authenticate", data, opts)
	return resp, err
}

// command "authenticatejobmanager", wshserver.AuthenticateJobManagerCommand
func AuthenticateJobManagerCommand(w *wshutil.WshRpc, data wshrpc.CommandAuthenticateJobManagerData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "authenticatejobmanager", data, opts)
	return err
}

// command "authenticatejobmanagerverify", wshserver.AuthenticateJobManagerVerifyCommand
func AuthenticateJobManagerVerifyCommand(w *wshutil.WshRpc, data wshrpc.CommandAuthenticateJobManagerData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "authenticatejobmanagerverify", data, opts)
	return err
}

// command "authenticatetojobmanager", wshserver.AuthenticateToJobManagerCommand
func AuthenticateToJobManagerCommand(w *wshutil.WshRpc, data wshrpc.CommandAuthenticateToJobData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "authenticatetojobmanager", data, opts)
	return err
}

// command "authenticatetoken", wshserver.AuthenticateTokenCommand
func AuthenticateTokenCommand(w *wshutil.WshRpc, data wshrpc.CommandAuthenticateTokenData, opts *wshrpc.RpcOpts) (wshrpc.CommandAuthenticateRtnData, error) {
	resp, err := sendRpcRequestCallHelper[wshrpc.CommandAuthenticateRtnData](w, "authenticatetoken", data, opts)
	return resp, err
}

// command "authenticatetokenverify", wshserver.AuthenticateTokenVerifyCommand
func AuthenticateTokenVerifyCommand(w *wshutil.WshRpc, data wshrpc.CommandAuthenticateTokenData, opts *wshrpc.RpcOpts) (wshrpc.CommandAuthenticateRtnData, error) {
	resp, err := sendRpcRequestCallHelper[wshrpc.CommandAuthenticateRtnData](w, "authenticatetokenverify", data, opts)
	return resp, err
}

// command "badgewatchpid", wshserver.BadgeWatchPidCommand
func BadgeWatchPidCommand(w *wshutil.WshRpc, data wshrpc.CommandBadgeWatchPidData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "badgewatchpid", data, opts)
	return err
}

// command "blockinfo", wshserver.BlockInfoCommand
func BlockInfoCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) (*wshrpc.BlockInfoData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.BlockInfoData](w, "blockinfo", data, opts)
	return resp, err
}

// command "blockjobstatus", wshserver.BlockJobStatusCommand
func BlockJobStatusCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) (*wshrpc.BlockJobStatusData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.BlockJobStatusData](w, "blockjobstatus", data, opts)
	return resp, err
}

// command "blockslist", wshserver.BlocksListCommand
func BlocksListCommand(w *wshutil.WshRpc, data wshrpc.BlocksListRequest, opts *wshrpc.RpcOpts) ([]wshrpc.BlocksListEntry, error) {
	resp, err := sendRpcRequestCallHelper[[]wshrpc.BlocksListEntry](w, "blockslist", data, opts)
	return resp, err
}

// command "cancelradarscan", wshserver.CancelRadarScanCommand
func CancelRadarScanCommand(w *wshutil.WshRpc, data wshrpc.CommandCancelRadarScanData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "cancelradarscan", data, opts)
	return err
}

// command "cancelrun", wshserver.CancelRunCommand
func CancelRunCommand(w *wshutil.WshRpc, data wshrpc.CommandCancelRunData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "cancelrun", data, opts)
	return err
}

// command "captureblockscreenshot", wshserver.CaptureBlockScreenshotCommand
func CaptureBlockScreenshotCommand(w *wshutil.WshRpc, data wshrpc.CommandCaptureBlockScreenshotData, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "captureblockscreenshot", data, opts)
	return resp, err
}

// command "checkgoversion", wshserver.CheckGoVersionCommand
func CheckGoVersionCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (*wshrpc.CommandCheckGoVersionRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandCheckGoVersionRtnData](w, "checkgoversion", nil, opts)
	return resp, err
}

// command "connconnect", wshserver.ConnConnectCommand
func ConnConnectCommand(w *wshutil.WshRpc, data wshrpc.ConnRequest, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "connconnect", data, opts)
	return err
}

// command "conndisconnect", wshserver.ConnDisconnectCommand
func ConnDisconnectCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "conndisconnect", data, opts)
	return err
}

// command "connensure", wshserver.ConnEnsureCommand
func ConnEnsureCommand(w *wshutil.WshRpc, data wshrpc.ConnExtData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "connensure", data, opts)
	return err
}

// command "connlist", wshserver.ConnListCommand
func ConnListCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]string, error) {
	resp, err := sendRpcRequestCallHelper[[]string](w, "connlist", nil, opts)
	return resp, err
}

// command "connreinstallwsh", wshserver.ConnReinstallWshCommand
func ConnReinstallWshCommand(w *wshutil.WshRpc, data wshrpc.ConnExtData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "connreinstallwsh", data, opts)
	return err
}

// command "connserverinit", wshserver.ConnServerInitCommand
func ConnServerInitCommand(w *wshutil.WshRpc, data wshrpc.CommandConnServerInitData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "connserverinit", data, opts)
	return err
}

// command "connstatus", wshserver.ConnStatusCommand
func ConnStatusCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]wshrpc.ConnStatus, error) {
	resp, err := sendRpcRequestCallHelper[[]wshrpc.ConnStatus](w, "connstatus", nil, opts)
	return resp, err
}

// command "connupdatewsh", wshserver.ConnUpdateWshCommand
func ConnUpdateWshCommand(w *wshutil.WshRpc, data wshrpc.RemoteInfo, opts *wshrpc.RpcOpts) (bool, error) {
	resp, err := sendRpcRequestCallHelper[bool](w, "connupdatewsh", data, opts)
	return resp, err
}

// command "consult", wshserver.ConsultCommand
func ConsultCommand(w *wshutil.WshRpc, data wshrpc.CommandConsultData, opts *wshrpc.RpcOpts) chan wshrpc.RespOrErrorUnion[wshrpc.ConsultChunk] {
	return sendRpcRequestResponseStreamHelper[wshrpc.ConsultChunk](w, "consult", data, opts)
}

// command "controlgetrouteid", wshserver.ControlGetRouteIdCommand
func ControlGetRouteIdCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "controlgetrouteid", nil, opts)
	return resp, err
}

// command "controllerappendoutput", wshserver.ControllerAppendOutputCommand
func ControllerAppendOutputCommand(w *wshutil.WshRpc, data wshrpc.CommandControllerAppendOutputData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "controllerappendoutput", data, opts)
	return err
}

// command "controllerdestroy", wshserver.ControllerDestroyCommand
func ControllerDestroyCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "controllerdestroy", data, opts)
	return err
}

// command "controllerinput", wshserver.ControllerInputCommand
func ControllerInputCommand(w *wshutil.WshRpc, data wshrpc.CommandBlockInputData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "controllerinput", data, opts)
	return err
}

// command "controllerresync", wshserver.ControllerResyncCommand
func ControllerResyncCommand(w *wshutil.WshRpc, data wshrpc.CommandControllerResyncData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "controllerresync", data, opts)
	return err
}

// command "createblock", wshserver.CreateBlockCommand
func CreateBlockCommand(w *wshutil.WshRpc, data wshrpc.CommandCreateBlockData, opts *wshrpc.RpcOpts) (waveobj.ORef, error) {
	resp, err := sendRpcRequestCallHelper[waveobj.ORef](w, "createblock", data, opts)
	return resp, err
}

// command "createchannel", wshserver.CreateChannelCommand
func CreateChannelCommand(w *wshutil.WshRpc, data wshrpc.CommandCreateChannelData, opts *wshrpc.RpcOpts) (*waveobj.Channel, error) {
	resp, err := sendRpcRequestCallHelper[*waveobj.Channel](w, "createchannel", data, opts)
	return resp, err
}

// command "createproject", wshserver.CreateProjectCommand
func CreateProjectCommand(w *wshutil.WshRpc, data wshrpc.CommandCreateProjectData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "createproject", data, opts)
	return err
}

// command "createrun", wshserver.CreateRunCommand
func CreateRunCommand(w *wshutil.WshRpc, data wshrpc.CommandCreateRunData, opts *wshrpc.RpcOpts) (*wshrpc.CommandCreateRunRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandCreateRunRtnData](w, "createrun", data, opts)
	return resp, err
}

// command "createsubblock", wshserver.CreateSubBlockCommand
func CreateSubBlockCommand(w *wshutil.WshRpc, data wshrpc.CommandCreateSubBlockData, opts *wshrpc.RpcOpts) (waveobj.ORef, error) {
	resp, err := sendRpcRequestCallHelper[waveobj.ORef](w, "createsubblock", data, opts)
	return resp, err
}

// command "createworktree", wshserver.CreateWorktreeCommand
func CreateWorktreeCommand(w *wshutil.WshRpc, data wshrpc.CommandCreateWorktreeData, opts *wshrpc.RpcOpts) (wshrpc.CommandCreateWorktreeRtnData, error) {
	resp, err := sendRpcRequestCallHelper[wshrpc.CommandCreateWorktreeRtnData](w, "createworktree", data, opts)
	return resp, err
}

// command "debugterm", wshserver.DebugTermCommand
func DebugTermCommand(w *wshutil.WshRpc, data wshrpc.CommandDebugTermData, opts *wshrpc.RpcOpts) (*wshrpc.CommandDebugTermRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandDebugTermRtnData](w, "debugterm", data, opts)
	return resp, err
}

// command "deleteappfile", wshserver.DeleteAppFileCommand
func DeleteAppFileCommand(w *wshutil.WshRpc, data wshrpc.CommandDeleteAppFileData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "deleteappfile", data, opts)
	return err
}

// command "deleteblock", wshserver.DeleteBlockCommand
func DeleteBlockCommand(w *wshutil.WshRpc, data wshrpc.CommandDeleteBlockData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "deleteblock", data, opts)
	return err
}

// command "deletebuilder", wshserver.DeleteBuilderCommand
func DeleteBuilderCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "deletebuilder", data, opts)
	return err
}

// command "deletechannel", wshserver.DeleteChannelCommand
func DeleteChannelCommand(w *wshutil.WshRpc, data wshrpc.CommandDeleteChannelData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "deletechannel", data, opts)
	return err
}

// command "deleteproject", wshserver.DeleteProjectCommand
func DeleteProjectCommand(w *wshutil.WshRpc, data wshrpc.CommandDeleteProjectData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "deleteproject", data, opts)
	return err
}

// command "deletesubblock", wshserver.DeleteSubBlockCommand
func DeleteSubBlockCommand(w *wshutil.WshRpc, data wshrpc.CommandDeleteBlockData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "deletesubblock", data, opts)
	return err
}

// command "disposesuggestions", wshserver.DisposeSuggestionsCommand
func DisposeSuggestionsCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "disposesuggestions", data, opts)
	return err
}

// command "electrondecrypt", wshserver.ElectronDecryptCommand
func ElectronDecryptCommand(w *wshutil.WshRpc, data wshrpc.CommandElectronDecryptData, opts *wshrpc.RpcOpts) (*wshrpc.CommandElectronDecryptRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandElectronDecryptRtnData](w, "electrondecrypt", data, opts)
	return resp, err
}

// command "electronencrypt", wshserver.ElectronEncryptCommand
func ElectronEncryptCommand(w *wshutil.WshRpc, data wshrpc.CommandElectronEncryptData, opts *wshrpc.RpcOpts) (*wshrpc.CommandElectronEncryptRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandElectronEncryptRtnData](w, "electronencrypt", data, opts)
	return resp, err
}

// command "electronsystembell", wshserver.ElectronSystemBellCommand
func ElectronSystemBellCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "electronsystembell", nil, opts)
	return err
}

// command "eventpublish", wshserver.EventPublishCommand
func EventPublishCommand(w *wshutil.WshRpc, data wps.WaveEvent, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "eventpublish", data, opts)
	return err
}

// command "eventreadhistory", wshserver.EventReadHistoryCommand
func EventReadHistoryCommand(w *wshutil.WshRpc, data wshrpc.CommandEventReadHistoryData, opts *wshrpc.RpcOpts) ([]*wps.WaveEvent, error) {
	resp, err := sendRpcRequestCallHelper[[]*wps.WaveEvent](w, "eventreadhistory", data, opts)
	return resp, err
}

// command "eventrecv", wshserver.EventRecvCommand
func EventRecvCommand(w *wshutil.WshRpc, data wps.WaveEvent, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "eventrecv", data, opts)
	return err
}

// command "eventsub", wshserver.EventSubCommand
func EventSubCommand(w *wshutil.WshRpc, data wps.SubscriptionRequest, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "eventsub", data, opts)
	return err
}

// command "eventunsub", wshserver.EventUnsubCommand
func EventUnsubCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "eventunsub", data, opts)
	return err
}

// command "fetchsuggestions", wshserver.FetchSuggestionsCommand
func FetchSuggestionsCommand(w *wshutil.WshRpc, data wshrpc.FetchSuggestionsData, opts *wshrpc.RpcOpts) (*wshrpc.FetchSuggestionsResponse, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.FetchSuggestionsResponse](w, "fetchsuggestions", data, opts)
	return resp, err
}

// command "fileappend", wshserver.FileAppendCommand
func FileAppendCommand(w *wshutil.WshRpc, data wshrpc.FileData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "fileappend", data, opts)
	return err
}

// command "filecopy", wshserver.FileCopyCommand
func FileCopyCommand(w *wshutil.WshRpc, data wshrpc.CommandFileCopyData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "filecopy", data, opts)
	return err
}

// command "filecreate", wshserver.FileCreateCommand
func FileCreateCommand(w *wshutil.WshRpc, data wshrpc.FileData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "filecreate", data, opts)
	return err
}

// command "filedelete", wshserver.FileDeleteCommand
func FileDeleteCommand(w *wshutil.WshRpc, data wshrpc.CommandDeleteFileData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "filedelete", data, opts)
	return err
}

// command "fileinfo", wshserver.FileInfoCommand
func FileInfoCommand(w *wshutil.WshRpc, data wshrpc.FileData, opts *wshrpc.RpcOpts) (*wshrpc.FileInfo, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.FileInfo](w, "fileinfo", data, opts)
	return resp, err
}

// command "filejoin", wshserver.FileJoinCommand
func FileJoinCommand(w *wshutil.WshRpc, data []string, opts *wshrpc.RpcOpts) (*wshrpc.FileInfo, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.FileInfo](w, "filejoin", data, opts)
	return resp, err
}

// command "filelist", wshserver.FileListCommand
func FileListCommand(w *wshutil.WshRpc, data wshrpc.FileListData, opts *wshrpc.RpcOpts) ([]*wshrpc.FileInfo, error) {
	resp, err := sendRpcRequestCallHelper[[]*wshrpc.FileInfo](w, "filelist", data, opts)
	return resp, err
}

// command "fileliststream", wshserver.FileListStreamCommand
func FileListStreamCommand(w *wshutil.WshRpc, data wshrpc.FileListData, opts *wshrpc.RpcOpts) chan wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData] {
	return sendRpcRequestResponseStreamHelper[wshrpc.CommandRemoteListEntriesRtnData](w, "fileliststream", data, opts)
}

// command "filemkdir", wshserver.FileMkdirCommand
func FileMkdirCommand(w *wshutil.WshRpc, data wshrpc.FileData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "filemkdir", data, opts)
	return err
}

// command "filemove", wshserver.FileMoveCommand
func FileMoveCommand(w *wshutil.WshRpc, data wshrpc.CommandFileCopyData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "filemove", data, opts)
	return err
}

// command "fileread", wshserver.FileReadCommand
func FileReadCommand(w *wshutil.WshRpc, data wshrpc.FileData, opts *wshrpc.RpcOpts) (*wshrpc.FileData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.FileData](w, "fileread", data, opts)
	return resp, err
}

// command "filestream", wshserver.FileStreamCommand
func FileStreamCommand(w *wshutil.WshRpc, data wshrpc.CommandFileStreamData, opts *wshrpc.RpcOpts) (*wshrpc.FileInfo, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.FileInfo](w, "filestream", data, opts)
	return resp, err
}

// command "filewrite", wshserver.FileWriteCommand
func FileWriteCommand(w *wshutil.WshRpc, data wshrpc.FileData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "filewrite", data, opts)
	return err
}

// command "findgitbash", wshserver.FindGitBashCommand
func FindGitBashCommand(w *wshutil.WshRpc, data bool, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "findgitbash", data, opts)
	return resp, err
}

// command "focuswindow", wshserver.FocusWindowCommand
func FocusWindowCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "focuswindow", data, opts)
	return err
}

// command "getagenttranscript", wshserver.GetAgentTranscriptCommand
func GetAgentTranscriptCommand(w *wshutil.WshRpc, data wshrpc.CommandGetAgentTranscriptData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGetAgentTranscriptRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGetAgentTranscriptRtnData](w, "getagenttranscript", data, opts)
	return resp, err
}

// command "getallbadges", wshserver.GetAllBadgesCommand
func GetAllBadgesCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]baseds.BadgeEvent, error) {
	resp, err := sendRpcRequestCallHelper[[]baseds.BadgeEvent](w, "getallbadges", nil, opts)
	return resp, err
}

// command "getallvars", wshserver.GetAllVarsCommand
func GetAllVarsCommand(w *wshutil.WshRpc, data wshrpc.CommandVarData, opts *wshrpc.RpcOpts) ([]wshrpc.CommandVarResponseData, error) {
	resp, err := sendRpcRequestCallHelper[[]wshrpc.CommandVarResponseData](w, "getallvars", data, opts)
	return resp, err
}

// command "getbuilderoutput", wshserver.GetBuilderOutputCommand
func GetBuilderOutputCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) ([]string, error) {
	resp, err := sendRpcRequestCallHelper[[]string](w, "getbuilderoutput", data, opts)
	return resp, err
}

// command "getbuilderstatus", wshserver.GetBuilderStatusCommand
func GetBuilderStatusCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) (*wshrpc.BuilderStatusData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.BuilderStatusData](w, "getbuilderstatus", data, opts)
	return resp, err
}

// command "getcachestatus", wshserver.GetCacheStatusCommand
func GetCacheStatusCommand(w *wshutil.WshRpc, data wshrpc.CommandGetCacheStatusData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGetCacheStatusRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGetCacheStatusRtnData](w, "getcachestatus", data, opts)
	return resp, err
}

// command "getchannels", wshserver.GetChannelsCommand
func GetChannelsCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (*wshrpc.CommandGetChannelsRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGetChannelsRtnData](w, "getchannels", nil, opts)
	return resp, err
}

// command "getfullconfig", wshserver.GetFullConfigCommand
func GetFullConfigCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (wconfig.FullConfigType, error) {
	resp, err := sendRpcRequestCallHelper[wconfig.FullConfigType](w, "getfullconfig", nil, opts)
	return resp, err
}

// command "getjarvisprofile", wshserver.GetJarvisProfileCommand
func GetJarvisProfileCommand(w *wshutil.WshRpc, data wshrpc.CommandGetJarvisProfileData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGetJarvisProfileRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGetJarvisProfileRtnData](w, "getjarvisprofile", data, opts)
	return resp, err
}

// command "getjwtpublickey", wshserver.GetJwtPublicKeyCommand
func GetJwtPublicKeyCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "getjwtpublickey", nil, opts)
	return resp, err
}

// command "getmeta", wshserver.GetMetaCommand
func GetMetaCommand(w *wshutil.WshRpc, data wshrpc.CommandGetMetaData, opts *wshrpc.RpcOpts) (waveobj.MetaMapType, error) {
	resp, err := sendRpcRequestCallHelper[waveobj.MetaMapType](w, "getmeta", data, opts)
	return resp, err
}

// command "getrecentsessions", wshserver.GetRecentSessionsCommand
func GetRecentSessionsCommand(w *wshutil.WshRpc, data wshrpc.CommandGetRecentSessionsData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGetRecentSessionsRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGetRecentSessionsRtnData](w, "getrecentsessions", data, opts)
	return resp, err
}

// command "getrtinfo", wshserver.GetRTInfoCommand
func GetRTInfoCommand(w *wshutil.WshRpc, data wshrpc.CommandGetRTInfoData, opts *wshrpc.RpcOpts) (*waveobj.ObjRTInfo, error) {
	resp, err := sendRpcRequestCallHelper[*waveobj.ObjRTInfo](w, "getrtinfo", data, opts)
	return resp, err
}

// command "getsecrets", wshserver.GetSecretsCommand
func GetSecretsCommand(w *wshutil.WshRpc, data []string, opts *wshrpc.RpcOpts) (map[string]string, error) {
	resp, err := sendRpcRequestCallHelper[map[string]string](w, "getsecrets", data, opts)
	return resp, err
}

// command "getsecretslinuxstoragebackend", wshserver.GetSecretsLinuxStorageBackendCommand
func GetSecretsLinuxStorageBackendCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "getsecretslinuxstoragebackend", nil, opts)
	return resp, err
}

// command "getsecretsnames", wshserver.GetSecretsNamesCommand
func GetSecretsNamesCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]string, error) {
	resp, err := sendRpcRequestCallHelper[[]string](w, "getsecretsnames", nil, opts)
	return resp, err
}

// command "getsessiongroup", wshserver.GetSessionGroupCommand
func GetSessionGroupCommand(w *wshutil.WshRpc, data wshrpc.CommandGetSessionGroupData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGetSessionGroupRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGetSessionGroupRtnData](w, "getsessiongroup", data, opts)
	return resp, err
}

// command "getsessionsactivity", wshserver.GetSessionsActivityCommand
func GetSessionsActivityCommand(w *wshutil.WshRpc, data wshrpc.CommandGetSessionsActivityData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGetSessionsActivityRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGetSessionsActivityRtnData](w, "getsessionsactivity", data, opts)
	return resp, err
}

// command "getsubagents", wshserver.GetSubagentsCommand
func GetSubagentsCommand(w *wshutil.WshRpc, data wshrpc.CommandGetSubagentsData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGetSubagentsRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGetSubagentsRtnData](w, "getsubagents", data, opts)
	return resp, err
}

// command "gettranscripttokens", wshserver.GetTranscriptTokensCommand
func GetTranscriptTokensCommand(w *wshutil.WshRpc, data wshrpc.CommandGetTranscriptTokensData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGetTranscriptTokensRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGetTranscriptTokensRtnData](w, "gettranscripttokens", data, opts)
	return resp, err
}

// command "getupdatechannel", wshserver.GetUpdateChannelCommand
func GetUpdateChannelCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "getupdatechannel", nil, opts)
	return resp, err
}

// command "getusagestats", wshserver.GetUsageStatsCommand
func GetUsageStatsCommand(w *wshutil.WshRpc, data wshrpc.CommandGetUsageStatsData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGetUsageStatsRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGetUsageStatsRtnData](w, "getusagestats", data, opts)
	return resp, err
}

// command "getvar", wshserver.GetVarCommand
func GetVarCommand(w *wshutil.WshRpc, data wshrpc.CommandVarData, opts *wshrpc.RpcOpts) (*wshrpc.CommandVarResponseData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandVarResponseData](w, "getvar", data, opts)
	return resp, err
}

// command "getwaveaimodeconfig", wshserver.GetWaveAIModeConfigCommand
func GetWaveAIModeConfigCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (wconfig.AIModeConfigUpdate, error) {
	resp, err := sendRpcRequestCallHelper[wconfig.AIModeConfigUpdate](w, "getwaveaimodeconfig", nil, opts)
	return resp, err
}

// command "getwindowtokens", wshserver.GetWindowTokensCommand
func GetWindowTokensCommand(w *wshutil.WshRpc, data wshrpc.CommandGetWindowTokensData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGetWindowTokensRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGetWindowTokensRtnData](w, "getwindowtokens", data, opts)
	return resp, err
}

// command "gitchanges", wshserver.GitChangesCommand
func GitChangesCommand(w *wshutil.WshRpc, data wshrpc.CommandGitChangesData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGitChangesRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGitChangesRtnData](w, "gitchanges", data, opts)
	return resp, err
}

// command "gitdiff", wshserver.GitDiffCommand
func GitDiffCommand(w *wshutil.WshRpc, data wshrpc.CommandGitDiffData, opts *wshrpc.RpcOpts) (*wshrpc.CommandGitDiffRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandGitDiffRtnData](w, "gitdiff", data, opts)
	return resp, err
}

// command "gitrevert", wshserver.GitRevertCommand
func GitRevertCommand(w *wshutil.WshRpc, data wshrpc.CommandGitRevertData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "gitrevert", data, opts)
	return err
}

// command "jarvis", wshserver.JarvisCommand
func JarvisCommand(w *wshutil.WshRpc, data wshrpc.CommandJarvisData, opts *wshrpc.RpcOpts) chan wshrpc.RespOrErrorUnion[wshrpc.JarvisChunk] {
	return sendRpcRequestResponseStreamHelper[wshrpc.JarvisChunk](w, "jarvis", data, opts)
}

// command "jarvisdecompose", wshserver.JarvisDecomposeCommand
func JarvisDecomposeCommand(w *wshutil.WshRpc, data wshrpc.CommandJarvisDecomposeData, opts *wshrpc.RpcOpts) (*wshrpc.CommandJarvisDecomposeRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandJarvisDecomposeRtnData](w, "jarvisdecompose", data, opts)
	return resp, err
}

// command "jobcmdexited", wshserver.JobCmdExitedCommand
func JobCmdExitedCommand(w *wshutil.WshRpc, data wshrpc.CommandJobCmdExitedData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "jobcmdexited", data, opts)
	return err
}

// command "jobcontrollerattachjob", wshserver.JobControllerAttachJobCommand
func JobControllerAttachJobCommand(w *wshutil.WshRpc, data wshrpc.CommandJobControllerAttachJobData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "jobcontrollerattachjob", data, opts)
	return err
}

// command "jobcontrollerconnectedjobs", wshserver.JobControllerConnectedJobsCommand
func JobControllerConnectedJobsCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]string, error) {
	resp, err := sendRpcRequestCallHelper[[]string](w, "jobcontrollerconnectedjobs", nil, opts)
	return resp, err
}

// command "jobcontrollerdeletejob", wshserver.JobControllerDeleteJobCommand
func JobControllerDeleteJobCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "jobcontrollerdeletejob", data, opts)
	return err
}

// command "jobcontrollerdetachjob", wshserver.JobControllerDetachJobCommand
func JobControllerDetachJobCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "jobcontrollerdetachjob", data, opts)
	return err
}

// command "jobcontrollerdisconnectjob", wshserver.JobControllerDisconnectJobCommand
func JobControllerDisconnectJobCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "jobcontrollerdisconnectjob", data, opts)
	return err
}

// command "jobcontrollerexitjob", wshserver.JobControllerExitJobCommand
func JobControllerExitJobCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "jobcontrollerexitjob", data, opts)
	return err
}

// command "jobcontrollergetalljobmanagerstatus", wshserver.JobControllerGetAllJobManagerStatusCommand
func JobControllerGetAllJobManagerStatusCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]*wshrpc.JobManagerStatusUpdate, error) {
	resp, err := sendRpcRequestCallHelper[[]*wshrpc.JobManagerStatusUpdate](w, "jobcontrollergetalljobmanagerstatus", nil, opts)
	return resp, err
}

// command "jobcontrollerlist", wshserver.JobControllerListCommand
func JobControllerListCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]*waveobj.Job, error) {
	resp, err := sendRpcRequestCallHelper[[]*waveobj.Job](w, "jobcontrollerlist", nil, opts)
	return resp, err
}

// command "jobcontrollerreconnectjob", wshserver.JobControllerReconnectJobCommand
func JobControllerReconnectJobCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "jobcontrollerreconnectjob", data, opts)
	return err
}

// command "jobcontrollerreconnectjobsforconn", wshserver.JobControllerReconnectJobsForConnCommand
func JobControllerReconnectJobsForConnCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "jobcontrollerreconnectjobsforconn", data, opts)
	return err
}

// command "jobcontrollerstartjob", wshserver.JobControllerStartJobCommand
func JobControllerStartJobCommand(w *wshutil.WshRpc, data wshrpc.CommandJobControllerStartJobData, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "jobcontrollerstartjob", data, opts)
	return resp, err
}

// command "jobinput", wshserver.JobInputCommand
func JobInputCommand(w *wshutil.WshRpc, data wshrpc.CommandJobInputData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "jobinput", data, opts)
	return err
}

// command "jobprepareconnect", wshserver.JobPrepareConnectCommand
func JobPrepareConnectCommand(w *wshutil.WshRpc, data wshrpc.CommandJobPrepareConnectData, opts *wshrpc.RpcOpts) (*wshrpc.CommandJobConnectRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandJobConnectRtnData](w, "jobprepareconnect", data, opts)
	return resp, err
}

// command "jobstartstream", wshserver.JobStartStreamCommand
func JobStartStreamCommand(w *wshutil.WshRpc, data wshrpc.CommandJobStartStreamData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "jobstartstream", data, opts)
	return err
}

// command "listallappfiles", wshserver.ListAllAppFilesCommand
func ListAllAppFilesCommand(w *wshutil.WshRpc, data wshrpc.CommandListAllAppFilesData, opts *wshrpc.RpcOpts) (*wshrpc.CommandListAllAppFilesRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandListAllAppFilesRtnData](w, "listallappfiles", data, opts)
	return resp, err
}

// command "listallapps", wshserver.ListAllAppsCommand
func ListAllAppsCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]wshrpc.AppInfo, error) {
	resp, err := sendRpcRequestCallHelper[[]wshrpc.AppInfo](w, "listallapps", nil, opts)
	return resp, err
}

// command "listalleditableapps", wshserver.ListAllEditableAppsCommand
func ListAllEditableAppsCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]wshrpc.AppInfo, error) {
	resp, err := sendRpcRequestCallHelper[[]wshrpc.AppInfo](w, "listalleditableapps", nil, opts)
	return resp, err
}

// command "listbranches", wshserver.ListBranchesCommand
func ListBranchesCommand(w *wshutil.WshRpc, data wshrpc.CommandListBranchesData, opts *wshrpc.RpcOpts) (wshrpc.CommandListBranchesRtnData, error) {
	resp, err := sendRpcRequestCallHelper[wshrpc.CommandListBranchesRtnData](w, "listbranches", data, opts)
	return resp, err
}

// command "listconsultruntimes", wshserver.ListConsultRuntimesCommand
func ListConsultRuntimesCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (*wshrpc.CommandListConsultRuntimesRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandListConsultRuntimesRtnData](w, "listconsultruntimes", nil, opts)
	return resp, err
}

// command "listradarreports", wshserver.ListRadarReportsCommand
func ListRadarReportsCommand(w *wshutil.WshRpc, data wshrpc.CommandListRadarReportsData, opts *wshrpc.RpcOpts) (*wshrpc.CommandListRadarReportsRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandListRadarReportsRtnData](w, "listradarreports", data, opts)
	return resp, err
}

// command "macosversion", wshserver.MacOSVersionCommand
func MacOSVersionCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "macosversion", nil, opts)
	return resp, err
}

// command "makedraftfromlocal", wshserver.MakeDraftFromLocalCommand
func MakeDraftFromLocalCommand(w *wshutil.WshRpc, data wshrpc.CommandMakeDraftFromLocalData, opts *wshrpc.RpcOpts) (*wshrpc.CommandMakeDraftFromLocalRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandMakeDraftFromLocalRtnData](w, "makedraftfromlocal", data, opts)
	return resp, err
}

// command "memorycreate", wshserver.MemoryCreateCommand
func MemoryCreateCommand(w *wshutil.WshRpc, data wshrpc.CommandMemoryCreateData, opts *wshrpc.RpcOpts) (*wshrpc.CommandMemoryCreateRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandMemoryCreateRtnData](w, "memorycreate", data, opts)
	return resp, err
}

// command "memorydelete", wshserver.MemoryDeleteCommand
func MemoryDeleteCommand(w *wshutil.WshRpc, data wshrpc.CommandMemoryDeleteData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "memorydelete", data, opts)
	return err
}

// command "memoryharvest", wshserver.MemoryHarvestCommand
func MemoryHarvestCommand(w *wshutil.WshRpc, data wshrpc.CommandMemoryHarvestData, opts *wshrpc.RpcOpts) (*wshrpc.CommandMemoryHarvestRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandMemoryHarvestRtnData](w, "memoryharvest", data, opts)
	return resp, err
}

// command "memorylearn", wshserver.MemoryLearnCommand
func MemoryLearnCommand(w *wshutil.WshRpc, data wshrpc.CommandMemoryLearnData, opts *wshrpc.RpcOpts) (*wshrpc.CommandMemoryLearnRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandMemoryLearnRtnData](w, "memorylearn", data, opts)
	return resp, err
}

// command "memoryproject", wshserver.MemoryProjectCommand
func MemoryProjectCommand(w *wshutil.WshRpc, data wshrpc.CommandMemoryProjectData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "memoryproject", data, opts)
	return err
}

// command "memoryprojectionstatus", wshserver.MemoryProjectionStatusCommand
func MemoryProjectionStatusCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (*wshrpc.CommandMemoryProjectionStatusRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandMemoryProjectionStatusRtnData](w, "memoryprojectionstatus", nil, opts)
	return resp, err
}

// command "memoryprunelist", wshserver.MemoryPruneListCommand
func MemoryPruneListCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (*wshrpc.CommandMemoryPruneListRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandMemoryPruneListRtnData](w, "memoryprunelist", nil, opts)
	return resp, err
}

// command "memoryread", wshserver.MemoryReadCommand
func MemoryReadCommand(w *wshutil.WshRpc, data wshrpc.CommandMemoryReadData, opts *wshrpc.RpcOpts) (*wshrpc.CommandMemoryReadRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandMemoryReadRtnData](w, "memoryread", data, opts)
	return resp, err
}

// command "memoryreviewaccept", wshserver.MemoryReviewAcceptCommand
func MemoryReviewAcceptCommand(w *wshutil.WshRpc, data wshrpc.CommandMemoryReviewAcceptData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "memoryreviewaccept", data, opts)
	return err
}

// command "memoryreviewlist", wshserver.MemoryReviewListCommand
func MemoryReviewListCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (*wshrpc.CommandMemoryReviewListRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandMemoryReviewListRtnData](w, "memoryreviewlist", nil, opts)
	return resp, err
}

// command "memoryscan", wshserver.MemoryScanCommand
func MemoryScanCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (*wshrpc.CommandMemoryScanRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandMemoryScanRtnData](w, "memoryscan", nil, opts)
	return resp, err
}

// command "memorywrite", wshserver.MemoryWriteCommand
func MemoryWriteCommand(w *wshutil.WshRpc, data wshrpc.CommandMemoryWriteData, opts *wshrpc.RpcOpts) (*wshrpc.CommandMemoryWriteRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandMemoryWriteRtnData](w, "memorywrite", data, opts)
	return resp, err
}

// command "message", wshserver.MessageCommand
func MessageCommand(w *wshutil.WshRpc, data wshrpc.CommandMessageData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "message", data, opts)
	return err
}

// command "networkonline", wshserver.NetworkOnlineCommand
func NetworkOnlineCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (bool, error) {
	resp, err := sendRpcRequestCallHelper[bool](w, "networkonline", nil, opts)
	return resp, err
}

// command "notify", wshserver.NotifyCommand
func NotifyCommand(w *wshutil.WshRpc, data wshrpc.WaveNotificationOptions, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "notify", data, opts)
	return err
}

// command "path", wshserver.PathCommand
func PathCommand(w *wshutil.WshRpc, data wshrpc.PathCommandData, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "path", data, opts)
	return resp, err
}

// command "postchannelmessage", wshserver.PostChannelMessageCommand
func PostChannelMessageCommand(w *wshutil.WshRpc, data wshrpc.CommandPostChannelMessageData, opts *wshrpc.RpcOpts) (*waveobj.ChannelMessage, error) {
	resp, err := sendRpcRequestCallHelper[*waveobj.ChannelMessage](w, "postchannelmessage", data, opts)
	return resp, err
}

// command "publishapp", wshserver.PublishAppCommand
func PublishAppCommand(w *wshutil.WshRpc, data wshrpc.CommandPublishAppData, opts *wshrpc.RpcOpts) (*wshrpc.CommandPublishAppRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandPublishAppRtnData](w, "publishapp", data, opts)
	return resp, err
}

// command "readappfile", wshserver.ReadAppFileCommand
func ReadAppFileCommand(w *wshutil.WshRpc, data wshrpc.CommandReadAppFileData, opts *wshrpc.RpcOpts) (*wshrpc.CommandReadAppFileRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandReadAppFileRtnData](w, "readappfile", data, opts)
	return resp, err
}

// command "recordtevent", wshserver.RecordTEventCommand
func RecordTEventCommand(w *wshutil.WshRpc, data telemetrydata.TEvent, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "recordtevent", data, opts)
	return err
}

// command "remotedisconnectfromjobmanager", wshserver.RemoteDisconnectFromJobManagerCommand
func RemoteDisconnectFromJobManagerCommand(w *wshutil.WshRpc, data wshrpc.CommandRemoteDisconnectFromJobManagerData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "remotedisconnectfromjobmanager", data, opts)
	return err
}

// command "remotefilecopy", wshserver.RemoteFileCopyCommand
func RemoteFileCopyCommand(w *wshutil.WshRpc, data wshrpc.CommandFileCopyData, opts *wshrpc.RpcOpts) (bool, error) {
	resp, err := sendRpcRequestCallHelper[bool](w, "remotefilecopy", data, opts)
	return resp, err
}

// command "remotefiledelete", wshserver.RemoteFileDeleteCommand
func RemoteFileDeleteCommand(w *wshutil.WshRpc, data wshrpc.CommandDeleteFileData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "remotefiledelete", data, opts)
	return err
}

// command "remotefileinfo", wshserver.RemoteFileInfoCommand
func RemoteFileInfoCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) (*wshrpc.FileInfo, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.FileInfo](w, "remotefileinfo", data, opts)
	return resp, err
}

// command "remotefilejoin", wshserver.RemoteFileJoinCommand
func RemoteFileJoinCommand(w *wshutil.WshRpc, data []string, opts *wshrpc.RpcOpts) (*wshrpc.FileInfo, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.FileInfo](w, "remotefilejoin", data, opts)
	return resp, err
}

// command "remotefilemove", wshserver.RemoteFileMoveCommand
func RemoteFileMoveCommand(w *wshutil.WshRpc, data wshrpc.CommandFileCopyData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "remotefilemove", data, opts)
	return err
}

// command "remotefilemultiinfo", wshserver.RemoteFileMultiInfoCommand
func RemoteFileMultiInfoCommand(w *wshutil.WshRpc, data wshrpc.CommandRemoteFileMultiInfoData, opts *wshrpc.RpcOpts) (map[string]wshrpc.FileInfo, error) {
	resp, err := sendRpcRequestCallHelper[map[string]wshrpc.FileInfo](w, "remotefilemultiinfo", data, opts)
	return resp, err
}

// command "remotefilestream", wshserver.RemoteFileStreamCommand
func RemoteFileStreamCommand(w *wshutil.WshRpc, data wshrpc.CommandRemoteFileStreamData, opts *wshrpc.RpcOpts) (*wshrpc.FileInfo, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.FileInfo](w, "remotefilestream", data, opts)
	return resp, err
}

// command "remotefiletouch", wshserver.RemoteFileTouchCommand
func RemoteFileTouchCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "remotefiletouch", data, opts)
	return err
}

// command "remotegetinfo", wshserver.RemoteGetInfoCommand
func RemoteGetInfoCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (wshrpc.RemoteInfo, error) {
	resp, err := sendRpcRequestCallHelper[wshrpc.RemoteInfo](w, "remotegetinfo", nil, opts)
	return resp, err
}

// command "remoteinstallrcfiles", wshserver.RemoteInstallRcFilesCommand
func RemoteInstallRcFilesCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "remoteinstallrcfiles", nil, opts)
	return err
}

// command "remotelistentries", wshserver.RemoteListEntriesCommand
func RemoteListEntriesCommand(w *wshutil.WshRpc, data wshrpc.CommandRemoteListEntriesData, opts *wshrpc.RpcOpts) chan wshrpc.RespOrErrorUnion[wshrpc.CommandRemoteListEntriesRtnData] {
	return sendRpcRequestResponseStreamHelper[wshrpc.CommandRemoteListEntriesRtnData](w, "remotelistentries", data, opts)
}

// command "remotemkdir", wshserver.RemoteMkdirCommand
func RemoteMkdirCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "remotemkdir", data, opts)
	return err
}

// command "remoteprocesslist", wshserver.RemoteProcessListCommand
func RemoteProcessListCommand(w *wshutil.WshRpc, data wshrpc.CommandRemoteProcessListData, opts *wshrpc.RpcOpts) (*wshrpc.ProcessListResponse, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.ProcessListResponse](w, "remoteprocesslist", data, opts)
	return resp, err
}

// command "remoteprocesssignal", wshserver.RemoteProcessSignalCommand
func RemoteProcessSignalCommand(w *wshutil.WshRpc, data wshrpc.CommandRemoteProcessSignalData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "remoteprocesssignal", data, opts)
	return err
}

// command "remotereconnecttojobmanager", wshserver.RemoteReconnectToJobManagerCommand
func RemoteReconnectToJobManagerCommand(w *wshutil.WshRpc, data wshrpc.CommandRemoteReconnectToJobManagerData, opts *wshrpc.RpcOpts) (*wshrpc.CommandRemoteReconnectToJobManagerRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandRemoteReconnectToJobManagerRtnData](w, "remotereconnecttojobmanager", data, opts)
	return resp, err
}

// command "remotestartjob", wshserver.RemoteStartJobCommand
func RemoteStartJobCommand(w *wshutil.WshRpc, data wshrpc.CommandRemoteStartJobData, opts *wshrpc.RpcOpts) (*wshrpc.CommandStartJobRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandStartJobRtnData](w, "remotestartjob", data, opts)
	return resp, err
}

// command "remotestreamcpudata", wshserver.RemoteStreamCpuDataCommand
func RemoteStreamCpuDataCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) chan wshrpc.RespOrErrorUnion[wshrpc.TimeSeriesData] {
	return sendRpcRequestResponseStreamHelper[wshrpc.TimeSeriesData](w, "remotestreamcpudata", nil, opts)
}

// command "remoteterminatejobmanager", wshserver.RemoteTerminateJobManagerCommand
func RemoteTerminateJobManagerCommand(w *wshutil.WshRpc, data wshrpc.CommandRemoteTerminateJobManagerData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "remoteterminatejobmanager", data, opts)
	return err
}

// command "remotewritefile", wshserver.RemoteWriteFileCommand
func RemoteWriteFileCommand(w *wshutil.WshRpc, data wshrpc.FileData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "remotewritefile", data, opts)
	return err
}

// command "renameappfile", wshserver.RenameAppFileCommand
func RenameAppFileCommand(w *wshutil.WshRpc, data wshrpc.CommandRenameAppFileData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "renameappfile", data, opts)
	return err
}

// command "renamechannel", wshserver.RenameChannelCommand
func RenameChannelCommand(w *wshutil.WshRpc, data wshrpc.CommandRenameChannelData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "renamechannel", data, opts)
	return err
}

// command "reportrunphase", wshserver.ReportRunPhaseCommand
func ReportRunPhaseCommand(w *wshutil.WshRpc, data wshrpc.CommandReportRunPhaseData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "reportrunphase", data, opts)
	return err
}

// command "resolveids", wshserver.ResolveIdsCommand
func ResolveIdsCommand(w *wshutil.WshRpc, data wshrpc.CommandResolveIdsData, opts *wshrpc.RpcOpts) (wshrpc.CommandResolveIdsRtnData, error) {
	resp, err := sendRpcRequestCallHelper[wshrpc.CommandResolveIdsRtnData](w, "resolveids", data, opts)
	return resp, err
}

// command "restartbuilderandwait", wshserver.RestartBuilderAndWaitCommand
func RestartBuilderAndWaitCommand(w *wshutil.WshRpc, data wshrpc.CommandRestartBuilderAndWaitData, opts *wshrpc.RpcOpts) (*wshrpc.RestartBuilderAndWaitResult, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.RestartBuilderAndWaitResult](w, "restartbuilderandwait", data, opts)
	return resp, err
}

// command "retryradarclustering", wshserver.RetryRadarClusteringCommand
func RetryRadarClusteringCommand(w *wshutil.WshRpc, data wshrpc.CommandRetryRadarClusteringData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "retryradarclustering", data, opts)
	return err
}

// command "routeannounce", wshserver.RouteAnnounceCommand
func RouteAnnounceCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "routeannounce", nil, opts)
	return err
}

// command "routeunannounce", wshserver.RouteUnannounceCommand
func RouteUnannounceCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "routeunannounce", nil, opts)
	return err
}

// command "sendtelemetry", wshserver.SendTelemetryCommand
func SendTelemetryCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "sendtelemetry", nil, opts)
	return err
}

// command "setblockfocus", wshserver.SetBlockFocusCommand
func SetBlockFocusCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setblockfocus", data, opts)
	return err
}

// command "setchannelmessagepick", wshserver.SetChannelMessagePickCommand
func SetChannelMessagePickCommand(w *wshutil.WshRpc, data wshrpc.CommandSetChannelMessagePickData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setchannelmessagepick", data, opts)
	return err
}

// command "setchannelprofile", wshserver.SetChannelProfileCommand
func SetChannelProfileCommand(w *wshutil.WshRpc, data wshrpc.CommandSetChannelProfileData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setchannelprofile", data, opts)
	return err
}

// command "setchannelread", wshserver.SetChannelReadCommand
func SetChannelReadCommand(w *wshutil.WshRpc, data wshrpc.CommandSetChannelReadData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setchannelread", data, opts)
	return err
}

// command "setchanneltier", wshserver.SetChannelTierCommand
func SetChannelTierCommand(w *wshutil.WshRpc, data wshrpc.CommandSetChannelTierData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setchanneltier", data, opts)
	return err
}

// command "setconfig", wshserver.SetConfigCommand
func SetConfigCommand(w *wshutil.WshRpc, data wshrpc.MetaSettingsType, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setconfig", data, opts)
	return err
}

// command "setconnectionsconfig", wshserver.SetConnectionsConfigCommand
func SetConnectionsConfigCommand(w *wshutil.WshRpc, data wshrpc.ConnConfigRequest, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setconnectionsconfig", data, opts)
	return err
}

// command "setmeta", wshserver.SetMetaCommand
func SetMetaCommand(w *wshutil.WshRpc, data wshrpc.CommandSetMetaData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setmeta", data, opts)
	return err
}

// command "setpeerinfo", wshserver.SetPeerInfoCommand
func SetPeerInfoCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setpeerinfo", data, opts)
	return err
}

// command "setradarfindingdisposition", wshserver.SetRadarFindingDispositionCommand
func SetRadarFindingDispositionCommand(w *wshutil.WshRpc, data wshrpc.CommandSetRadarFindingDispositionData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setradarfindingdisposition", data, opts)
	return err
}

// command "setrtinfo", wshserver.SetRTInfoCommand
func SetRTInfoCommand(w *wshutil.WshRpc, data wshrpc.CommandSetRTInfoData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setrtinfo", data, opts)
	return err
}

// command "setsecrets", wshserver.SetSecretsCommand
func SetSecretsCommand(w *wshutil.WshRpc, data map[string]*string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setsecrets", data, opts)
	return err
}

// command "setvar", wshserver.SetVarCommand
func SetVarCommand(w *wshutil.WshRpc, data wshrpc.CommandVarData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "setvar", data, opts)
	return err
}

// command "startbuilder", wshserver.StartBuilderCommand
func StartBuilderCommand(w *wshutil.WshRpc, data wshrpc.CommandStartBuilderData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "startbuilder", data, opts)
	return err
}

// command "startjob", wshserver.StartJobCommand
func StartJobCommand(w *wshutil.WshRpc, data wshrpc.CommandStartJobData, opts *wshrpc.RpcOpts) (*wshrpc.CommandStartJobRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandStartJobRtnData](w, "startjob", data, opts)
	return resp, err
}

// command "startradarscan", wshserver.StartRadarScanCommand
func StartRadarScanCommand(w *wshutil.WshRpc, data wshrpc.CommandStartRadarScanData, opts *wshrpc.RpcOpts) (*wshrpc.CommandStartRadarScanRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandStartRadarScanRtnData](w, "startradarscan", data, opts)
	return resp, err
}

// command "stopbuilder", wshserver.StopBuilderCommand
func StopBuilderCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "stopbuilder", data, opts)
	return err
}

// command "streamagenttranscript", wshserver.StreamAgentTranscriptCommand
func StreamAgentTranscriptCommand(w *wshutil.WshRpc, data wshrpc.CommandStreamAgentTranscriptData, opts *wshrpc.RpcOpts) chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate] {
	return sendRpcRequestResponseStreamHelper[wshrpc.AgentTranscriptUpdate](w, "streamagenttranscript", data, opts)
}

// command "streamcpudata", wshserver.StreamCpuDataCommand
func StreamCpuDataCommand(w *wshutil.WshRpc, data wshrpc.CpuDataRequest, opts *wshrpc.RpcOpts) chan wshrpc.RespOrErrorUnion[wshrpc.TimeSeriesData] {
	return sendRpcRequestResponseStreamHelper[wshrpc.TimeSeriesData](w, "streamcpudata", data, opts)
}

// command "streamdata", wshserver.StreamDataCommand
func StreamDataCommand(w *wshutil.WshRpc, data wshrpc.CommandStreamData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "streamdata", data, opts)
	return err
}

// command "streamdataack", wshserver.StreamDataAckCommand
func StreamDataAckCommand(w *wshutil.WshRpc, data wshrpc.CommandStreamAckData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "streamdataack", data, opts)
	return err
}

// command "streamtest", wshserver.StreamTestCommand
func StreamTestCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) chan wshrpc.RespOrErrorUnion[int] {
	return sendRpcRequestResponseStreamHelper[int](w, "streamtest", nil, opts)
}

// command "termgetscrollbacklines", wshserver.TermGetScrollbackLinesCommand
func TermGetScrollbackLinesCommand(w *wshutil.WshRpc, data wshrpc.CommandTermGetScrollbackLinesData, opts *wshrpc.RpcOpts) (*wshrpc.CommandTermGetScrollbackLinesRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandTermGetScrollbackLinesRtnData](w, "termgetscrollbacklines", data, opts)
	return resp, err
}

// command "test", wshserver.TestCommand
func TestCommand(w *wshutil.WshRpc, data string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "test", data, opts)
	return err
}

// command "testmultiarg", wshserver.TestMultiArgCommand
func TestMultiArgCommand(w *wshutil.WshRpc, arg1 string, arg2 int, arg3 bool, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "testmultiarg", wshrpc.MultiArg{Args: []any{arg1, arg2, arg3}}, opts)
	return resp, err
}

// command "updateworkspacetabids", wshserver.UpdateWorkspaceTabIdsCommand
func UpdateWorkspaceTabIdsCommand(w *wshutil.WshRpc, arg1 string, arg2 []string, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "updateworkspacetabids", wshrpc.MultiArg{Args: []any{arg1, arg2}}, opts)
	return err
}

// command "vdomasyncinitiation", wshserver.VDomAsyncInitiationCommand
func VDomAsyncInitiationCommand(w *wshutil.WshRpc, data vdom.VDomAsyncInitiationRequest, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "vdomasyncinitiation", data, opts)
	return err
}

// command "vdomcreatecontext", wshserver.VDomCreateContextCommand
func VDomCreateContextCommand(w *wshutil.WshRpc, data vdom.VDomCreateContext, opts *wshrpc.RpcOpts) (*waveobj.ORef, error) {
	resp, err := sendRpcRequestCallHelper[*waveobj.ORef](w, "vdomcreatecontext", data, opts)
	return resp, err
}

// command "vdomrender", wshserver.VDomRenderCommand
func VDomRenderCommand(w *wshutil.WshRpc, data vdom.VDomFrontendUpdate, opts *wshrpc.RpcOpts) chan wshrpc.RespOrErrorUnion[*vdom.VDomBackendUpdate] {
	return sendRpcRequestResponseStreamHelper[*vdom.VDomBackendUpdate](w, "vdomrender", data, opts)
}

// command "vdomurlrequest", wshserver.VDomUrlRequestCommand
func VDomUrlRequestCommand(w *wshutil.WshRpc, data wshrpc.VDomUrlRequestData, opts *wshrpc.RpcOpts) chan wshrpc.RespOrErrorUnion[wshrpc.VDomUrlRequestResponse] {
	return sendRpcRequestResponseStreamHelper[wshrpc.VDomUrlRequestResponse](w, "vdomurlrequest", data, opts)
}

// command "waitforroute", wshserver.WaitForRouteCommand
func WaitForRouteCommand(w *wshutil.WshRpc, data wshrpc.CommandWaitForRouteData, opts *wshrpc.RpcOpts) (bool, error) {
	resp, err := sendRpcRequestCallHelper[bool](w, "waitforroute", data, opts)
	return resp, err
}

// command "waveaiaddcontext", wshserver.WaveAIAddContextCommand
func WaveAIAddContextCommand(w *wshutil.WshRpc, data wshrpc.CommandWaveAIAddContextData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "waveaiaddcontext", data, opts)
	return err
}

// command "waveaigettooldiff", wshserver.WaveAIGetToolDiffCommand
func WaveAIGetToolDiffCommand(w *wshutil.WshRpc, data wshrpc.CommandWaveAIGetToolDiffData, opts *wshrpc.RpcOpts) (*wshrpc.CommandWaveAIGetToolDiffRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandWaveAIGetToolDiffRtnData](w, "waveaigettooldiff", data, opts)
	return resp, err
}

// command "wavefilereadstream", wshserver.WaveFileReadStreamCommand
func WaveFileReadStreamCommand(w *wshutil.WshRpc, data wshrpc.CommandWaveFileReadStreamData, opts *wshrpc.RpcOpts) (*wshrpc.WaveFileInfo, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.WaveFileInfo](w, "wavefilereadstream", data, opts)
	return resp, err
}

// command "waveinfo", wshserver.WaveInfoCommand
func WaveInfoCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (*wshrpc.WaveInfoData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.WaveInfoData](w, "waveinfo", nil, opts)
	return resp, err
}

// command "webselector", wshserver.WebSelectorCommand
func WebSelectorCommand(w *wshutil.WshRpc, data wshrpc.CommandWebSelectorData, opts *wshrpc.RpcOpts) ([]string, error) {
	resp, err := sendRpcRequestCallHelper[[]string](w, "webselector", data, opts)
	return resp, err
}

// command "workspacelist", wshserver.WorkspaceListCommand
func WorkspaceListCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]wshrpc.WorkspaceInfoData, error) {
	resp, err := sendRpcRequestCallHelper[[]wshrpc.WorkspaceInfoData](w, "workspacelist", nil, opts)
	return resp, err
}

// command "writeappfile", wshserver.WriteAppFileCommand
func WriteAppFileCommand(w *wshutil.WshRpc, data wshrpc.CommandWriteAppFileData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "writeappfile", data, opts)
	return err
}

// command "writeappgofile", wshserver.WriteAppGoFileCommand
func WriteAppGoFileCommand(w *wshutil.WshRpc, data wshrpc.CommandWriteAppGoFileData, opts *wshrpc.RpcOpts) (*wshrpc.CommandWriteAppGoFileRtnData, error) {
	resp, err := sendRpcRequestCallHelper[*wshrpc.CommandWriteAppGoFileRtnData](w, "writeappgofile", data, opts)
	return resp, err
}

// command "writeappsecretbindings", wshserver.WriteAppSecretBindingsCommand
func WriteAppSecretBindingsCommand(w *wshutil.WshRpc, data wshrpc.CommandWriteAppSecretBindingsData, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "writeappsecretbindings", data, opts)
	return err
}

// command "writetempfile", wshserver.WriteTempFileCommand
func WriteTempFileCommand(w *wshutil.WshRpc, data wshrpc.CommandWriteTempFileData, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "writetempfile", data, opts)
	return resp, err
}

// command "wshactivity", wshserver.WshActivityCommand
func WshActivityCommand(w *wshutil.WshRpc, data map[string]int, opts *wshrpc.RpcOpts) error {
	_, err := sendRpcRequestCallHelper[any](w, "wshactivity", data, opts)
	return err
}

// command "wsldefaultdistro", wshserver.WslDefaultDistroCommand
func WslDefaultDistroCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) (string, error) {
	resp, err := sendRpcRequestCallHelper[string](w, "wsldefaultdistro", nil, opts)
	return resp, err
}

// command "wsllist", wshserver.WslListCommand
func WslListCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]string, error) {
	resp, err := sendRpcRequestCallHelper[[]string](w, "wsllist", nil, opts)
	return resp, err
}

// command "wslstatus", wshserver.WslStatusCommand
func WslStatusCommand(w *wshutil.WshRpc, opts *wshrpc.RpcOpts) ([]wshrpc.ConnStatus, error) {
	resp, err := sendRpcRequestCallHelper[[]wshrpc.ConnStatus](w, "wslstatus", nil, opts)
	return resp, err
}


