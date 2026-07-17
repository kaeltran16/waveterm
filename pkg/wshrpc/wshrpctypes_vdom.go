// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/vdom"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type VDomCommands interface {
	// terminal
	VDomCreateContextCommand(ctx context.Context, data vdom.VDomCreateContext) (*waveobj.ORef, error)
	VDomAsyncInitiationCommand(ctx context.Context, data vdom.VDomAsyncInitiationRequest) error
	// proc
	VDomRenderCommand(ctx context.Context, data vdom.VDomFrontendUpdate) chan RespOrErrorUnion[*vdom.VDomBackendUpdate]
	VDomUrlRequestCommand(ctx context.Context, data VDomUrlRequestData) chan RespOrErrorUnion[VDomUrlRequestResponse]
}

type VDomUrlRequestData struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    []byte            `json:"body,omitempty"`
}

type VDomUrlRequestResponse struct {
	StatusCode int               `json:"statuscode,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       []byte            `json:"body,omitempty"`
}
