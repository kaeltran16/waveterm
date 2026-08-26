// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"
)

func TestRefreshRouteCatalogCommandReturnsNil(t *testing.T) {
	ws := &WshServer{}
	if err := ws.RefreshRouteCatalogCommand(context.Background()); err != nil {
		t.Fatalf("refresh must succeed: %v", err)
	}
}
