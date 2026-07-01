// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestSetProjectConfigValue(t *testing.T) {
	wavebase.ConfigHome_VarCache = t.TempDir() // point config home at a temp dir

	if err := SetProjectConfigValue("payments-api", waveobj.MetaMapType{"path": "/home/u/code/payments-api"}); err != nil {
		t.Fatalf("write: %v", err)
	}

	m, cerrs := ReadWaveHomeConfigFile(ProjectsFile)
	if len(cerrs) > 0 {
		t.Fatalf("read errors: %v", cerrs)
	}
	proj := m.GetMap("payments-api")
	if proj == nil {
		t.Fatal("project entry not written")
	}
	if got := proj.GetString("path", ""); got != "/home/u/code/payments-api" {
		t.Fatalf("path = %q, want /home/u/code/payments-api", got)
	}
}

func TestDeleteProjectConfigValue(t *testing.T) {
	wavebase.ConfigHome_VarCache = t.TempDir()

	if err := SetProjectConfigValue("keep", waveobj.MetaMapType{"path": "/a"}); err != nil {
		t.Fatalf("write keep: %v", err)
	}
	if err := SetProjectConfigValue("drop", waveobj.MetaMapType{"path": "/b"}); err != nil {
		t.Fatalf("write drop: %v", err)
	}

	if err := DeleteProjectConfigValue("drop"); err != nil {
		t.Fatalf("delete: %v", err)
	}

	m, cerrs := ReadWaveHomeConfigFile(ProjectsFile)
	if len(cerrs) > 0 {
		t.Fatalf("read errors: %v", cerrs)
	}
	if m.GetMap("drop") != nil {
		t.Fatal("deleted project still present")
	}
	if m.GetMap("keep") == nil {
		t.Fatal("surviving project was removed")
	}
}

func TestDeleteProjectConfigValueMissingIsNoop(t *testing.T) {
	wavebase.ConfigHome_VarCache = t.TempDir()
	if err := DeleteProjectConfigValue("never-registered"); err != nil {
		t.Fatalf("deleting a missing project should succeed, got %v", err)
	}
}
