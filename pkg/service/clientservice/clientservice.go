// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package clientservice

import (
	"context"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
)

type ClientService struct{}

const DefaultTimeout = 2 * time.Second

func (cs *ClientService) GetClientData() (*waveobj.Client, error) {
	log.Println("GetClientData")
	ctx, cancelFn := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancelFn()
	return wcore.GetClientData(ctx)
}
