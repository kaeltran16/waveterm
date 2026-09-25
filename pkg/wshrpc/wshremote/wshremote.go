// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

type JobManagerConnection struct {
	JobId     string
	Conn      net.Conn
	WshRpc    *wshutil.WshRpc
	CleanupFn func()
}

type ServerImpl struct {
	LogWriter     io.Writer
	Router        *wshutil.WshRouter
	RpcClient     *wshutil.WshRpc
	IsLocal       bool
	InitialEnv    map[string]string
	JobManagerMap map[string]*JobManagerConnection
	SockName      string
	Lock          sync.Mutex
}

func MakeRemoteRpcServerImpl(logWriter io.Writer, router *wshutil.WshRouter, rpcClient *wshutil.WshRpc, isLocal bool, initialEnv map[string]string, sockName string) *ServerImpl {
	return &ServerImpl{
		LogWriter:     logWriter,
		Router:        router,
		RpcClient:     rpcClient,
		IsLocal:       isLocal,
		InitialEnv:    initialEnv,
		JobManagerMap: make(map[string]*JobManagerConnection),
		SockName:      sockName,
	}
}

func (*ServerImpl) WshServerImpl() {}

func (impl *ServerImpl) Log(format string, args ...interface{}) {
	if impl.LogWriter != nil {
		fmt.Fprintf(impl.LogWriter, format, args...)
	} else {
		log.Printf(format, args...)
	}
}

func (impl *ServerImpl) MessageCommand(ctx context.Context, data wshrpc.CommandMessageData) error {
	impl.Log("[message] %q\n", data.Message)
	return nil
}
