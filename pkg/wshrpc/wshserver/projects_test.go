// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestCreateProjectCommandRejectsMissingPath(t *testing.T) {
	ws := &WshServer{}
	err := ws.CreateProjectCommand(context.Background(), wshrpc.CommandCreateProjectData{
		Name: "x", Path: "/no/such/dir/definitely-missing",
	})
	if err == nil {
		t.Fatal("expected error for a non-existent path")
	}
}

func TestCreateProjectCommandRejectsEmptyName(t *testing.T) {
	ws := &WshServer{}
	err := ws.CreateProjectCommand(context.Background(), wshrpc.CommandCreateProjectData{
		Name: "  ", Path: t.TempDir(),
	})
	if err == nil {
		t.Fatal("expected error for an empty name")
	}
}

func TestCreateProjectCommandWritesValid(t *testing.T) {
	wavebase.ConfigHome_VarCache = t.TempDir()
	ws := &WshServer{}
	if err := ws.CreateProjectCommand(context.Background(), wshrpc.CommandCreateProjectData{
		Name: "proj", Path: t.TempDir(),
	}); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
}
