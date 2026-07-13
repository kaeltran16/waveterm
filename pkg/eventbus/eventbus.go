// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package eventbus

import (
	"sync"
)

const (
	WSEvent_Rpc                     = "rpc"
)

type WSEventType struct {
	EventType string `json:"eventtype"`
	ORef      string `json:"oref,omitempty"`
	Data      any    `json:"data"`
}

type WindowWatchData struct {
	WindowWSCh chan any
	RouteId    string
}

var globalLock = &sync.Mutex{}
var wsMap = make(map[string]*WindowWatchData) // websocketid => WindowWatchData

func RegisterWSChannel(connId string, routeId string, ch chan any) {
	globalLock.Lock()
	defer globalLock.Unlock()
	wsMap[connId] = &WindowWatchData{
		WindowWSCh: ch,
		RouteId:    routeId,
	}
}

func UnregisterWSChannel(connId string) {
	globalLock.Lock()
	defer globalLock.Unlock()
	delete(wsMap, connId)
}
