// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"fmt"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func init() {
	for _, rtype := range waveobj.AllWaveObjTypes() {
		waveobj.RegisterType(rtype)
	}
}

var (
	clientIdLock   sync.Mutex
	cachedClientId string
)

func SetClientId(clientId string) {
	clientIdLock.Lock()
	defer clientIdLock.Unlock()
	cachedClientId = clientId
}

// in the main server, this will not return empty string
// it does return empty in wsh, but all wstore methods are invalid in wsh mode, so that shouldn't be an issue
func GetClientId() string {
	clientIdLock.Lock()
	defer clientIdLock.Unlock()
	if wavebase.IsDevMode() && cachedClientId == "" {
		panic("cachedClientId is empty")
	}
	return cachedClientId
}

func UpdateObjectMeta(ctx context.Context, oref waveobj.ORef, meta waveobj.MetaMapType, mergeSpecial bool) error {
	return WithTx(ctx, func(tx *TxWrap) error {
		if oref.IsEmpty() {
			return fmt.Errorf("empty object reference")
		}
		obj, _ := DBGetORef(tx.Context(), oref)
		if obj == nil {
			return ErrNotFound
		}
		objMeta := waveobj.GetMeta(obj)
		if objMeta == nil {
			objMeta = make(map[string]any)
		}
		newMeta := waveobj.MergeMeta(objMeta, meta, mergeSpecial)
		waveobj.SetMeta(obj, newMeta)
		DBUpdate(tx.Context(), obj)
		return nil
	})
}
