// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

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
