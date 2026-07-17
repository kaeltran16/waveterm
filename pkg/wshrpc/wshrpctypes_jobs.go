// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type JobCommands interface {
	RemoteGetInfoCommand(ctx context.Context) (RemoteInfo, error)
	RemoteInstallRcFilesCommand(ctx context.Context) error
	RemoteStartJobCommand(ctx context.Context, data CommandRemoteStartJobData) (*CommandStartJobRtnData, error)
	RemoteReconnectToJobManagerCommand(ctx context.Context, data CommandRemoteReconnectToJobManagerData) (*CommandRemoteReconnectToJobManagerRtnData, error)
	RemoteDisconnectFromJobManagerCommand(ctx context.Context, data CommandRemoteDisconnectFromJobManagerData) error
	RemoteTerminateJobManagerCommand(ctx context.Context, data CommandRemoteTerminateJobManagerData) error
	// streams
	StreamDataCommand(ctx context.Context, data CommandStreamData) error
	StreamDataAckCommand(ctx context.Context, data CommandStreamAckData) error
	StartJobCommand(ctx context.Context, data CommandStartJobData) (*CommandStartJobRtnData, error)
	JobPrepareConnectCommand(ctx context.Context, data CommandJobPrepareConnectData) (*CommandJobConnectRtnData, error)
	JobStartStreamCommand(ctx context.Context, data CommandJobStartStreamData) error
	JobInputCommand(ctx context.Context, data CommandJobInputData) error
	JobCmdExitedCommand(ctx context.Context, data CommandJobCmdExitedData) error // this is sent FROM the job manager => main server
	// job controller
	JobControllerDeleteJobCommand(ctx context.Context, jobId string) error
	JobControllerListCommand(ctx context.Context) ([]*waveobj.Job, error)
	JobControllerStartJobCommand(ctx context.Context, data CommandJobControllerStartJobData) (string, error)
	JobControllerExitJobCommand(ctx context.Context, jobId string) error
	JobControllerDisconnectJobCommand(ctx context.Context, jobId string) error
	JobControllerReconnectJobCommand(ctx context.Context, jobId string) error
	JobControllerReconnectJobsForConnCommand(ctx context.Context, connName string) error
	JobControllerConnectedJobsCommand(ctx context.Context) ([]string, error)
	JobControllerAttachJobCommand(ctx context.Context, data CommandJobControllerAttachJobData) error
	JobControllerDetachJobCommand(ctx context.Context, jobId string) error
	JobControllerGetAllJobManagerStatusCommand(ctx context.Context) ([]*JobManagerStatusUpdate, error)
	BlockJobStatusCommand(ctx context.Context, blockId string) (*BlockJobStatusData, error)
}

type CommandJobInputData struct {
	JobId          string            `json:"jobid"`
	InputSessionId string            `json:"inputsessionid,omitempty"`
	SeqNum         int               `json:"seqnum,omitempty"`
	InputData64    string            `json:"inputdata64,omitempty"`
	SigName        string            `json:"signame,omitempty"`
	TermSize       *waveobj.TermSize `json:"termsize,omitempty"`
}

type CommandStreamData struct {
	Id     string `json:"id"`  // streamid
	Seq    int64  `json:"seq"` // start offset (bytes)
	Data64 string `json:"data64,omitempty"`
	Eof    bool   `json:"eof,omitempty"`   // can be set with data or without
	Error  string `json:"error,omitempty"` // stream terminated with error
}

type CommandStreamAckData struct {
	Id     string `json:"id"`               // streamid
	Seq    int64  `json:"seq"`              // next expected byte
	RWnd   int64  `json:"rwnd"`             // receive window size
	Fin    bool   `json:"fin,omitempty"`    // observed end-of-stream (eof or error)
	Delay  int64  `json:"delay,omitempty"`  // ack delay in microseconds (from when data was received to when we sent out ack -- monotonic clock)
	Cancel bool   `json:"cancel,omitempty"` // used to cancel the stream
	Error  string `json:"error,omitempty"`  // reason for cancel (may only be set if cancel is true)
}

type CommandStartJobData struct {
	Cmd        string            `json:"cmd"`
	Args       []string          `json:"args"`
	Env        map[string]string `json:"env"`
	TermSize   waveobj.TermSize  `json:"termsize"`
	StreamMeta *StreamMeta       `json:"streammeta,omitempty"`
}

type CommandRemoteStartJobData struct {
	Cmd                string            `json:"cmd"`
	Args               []string          `json:"args"`
	Env                map[string]string `json:"env"`
	TermSize           waveobj.TermSize  `json:"termsize"`
	StreamMeta         *StreamMeta       `json:"streammeta,omitempty"`
	JobAuthToken       string            `json:"jobauthtoken"`
	JobId              string            `json:"jobid"`
	MainServerJwtToken string            `json:"mainserverjwttoken"`
	ClientId           string            `json:"clientid"`
	PublicKeyBase64    string            `json:"publickeybase64"`
}

type CommandRemoteReconnectToJobManagerData struct {
	JobId              string `json:"jobid"`
	JobAuthToken       string `json:"jobauthtoken"`
	MainServerJwtToken string `json:"mainserverjwttoken"`
	JobManagerPid      int    `json:"jobmanagerpid"`
	JobManagerStartTs  int64  `json:"jobmanagerstartts"`
}

type CommandRemoteReconnectToJobManagerRtnData struct {
	Success        bool   `json:"success"`
	JobManagerGone bool   `json:"jobmanagergone"`
	Error          string `json:"error,omitempty"`
}

type CommandRemoteDisconnectFromJobManagerData struct {
	JobId string `json:"jobid"`
}

type CommandRemoteTerminateJobManagerData struct {
	JobId             string `json:"jobid"`
	JobManagerPid     int    `json:"jobmanagerpid"`
	JobManagerStartTs int64  `json:"jobmanagerstartts"`
}

type CommandStartJobRtnData struct {
	CmdPid            int   `json:"cmdpid"`
	CmdStartTs        int64 `json:"cmdstartts"`
	JobManagerPid     int   `json:"jobmanagerpid"`
	JobManagerStartTs int64 `json:"jobmanagerstartts"`
}

type CommandJobPrepareConnectData struct {
	StreamMeta StreamMeta       `json:"streammeta"`
	Seq        int64            `json:"seq"`
	TermSize   waveobj.TermSize `json:"termsize"`
}

type CommandJobStartStreamData struct {
}

type CommandJobConnectRtnData struct {
	Seq         int64  `json:"seq"`
	StreamDone  bool   `json:"streamdone,omitempty"`
	StreamError string `json:"streamerror,omitempty"`
	HasExited   bool   `json:"hasexited,omitempty"`
	ExitCode    *int   `json:"exitcode,omitempty"`
	ExitSignal  string `json:"exitsignal,omitempty"`
	ExitErr     string `json:"exiterr,omitempty"`
}

type CommandJobCmdExitedData struct {
	JobId      string `json:"jobid"`
	ExitCode   *int   `json:"exitcode,omitempty"`
	ExitSignal string `json:"exitsignal,omitempty"`
	ExitErr    string `json:"exiterr,omitempty"`
	ExitTs     int64  `json:"exitts,omitempty"`
}

type CommandJobControllerStartJobData struct {
	ConnName string            `json:"connname"`
	JobKind  string            `json:"jobkind"`
	Cmd      string            `json:"cmd"`
	Args     []string          `json:"args"`
	Env      map[string]string `json:"env"`
	TermSize *waveobj.TermSize `json:"termsize,omitempty"`
}

type CommandJobControllerAttachJobData struct {
	JobId   string `json:"jobid"`
	BlockId string `json:"blockid"`
}

type JobManagerStatusUpdate struct {
	JobId            string `json:"jobid"`
	JobManagerStatus string `json:"jobmanagerstatus"`
}

type BlockJobStatusData struct {
	BlockId       string `json:"blockid"`
	JobId         string `json:"jobid"`
	Status        string `json:"status,omitempty" tstype:"null | \"init\" | \"connected\" | \"disconnected\" | \"done\""`
	VersionTs     int64  `json:"versionts"`
	DoneReason    string `json:"donereason,omitempty"`
	StartupError  string `json:"startuperror,omitempty"`
	CmdExitTs     int64  `json:"cmdexitts,omitempty"`
	CmdExitCode   *int   `json:"cmdexitcode,omitempty"`
	CmdExitSignal string `json:"cmdexitsignal,omitempty"`
}
