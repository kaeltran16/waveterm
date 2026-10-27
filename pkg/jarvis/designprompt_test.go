// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestDesignSessionPrompt(t *testing.T) {
	for kind, want := range map[string][]string{
		waveobj.RunDesignKind_Brainstorm: {"Brainstorm this goal with the human with superpowers:brainstorming: ship auth", "A run waits on this session", "Approve"},
		waveobj.RunDesignKind_Canvas:     {"Mock up this goal with arc:design: ship auth", "A run waits on this session", "Build this…"},
	} {
		p := DesignSessionPrompt("ship auth", kind)
		for _, w := range want {
			if !strings.Contains(p, w) {
				t.Errorf("%s prompt missing %q:\n%s", kind, w, p)
			}
		}
	}
	if strings.Contains(DesignSessionPrompt("ship auth", waveobj.RunDesignKind_Canvas), "brainstorming") {
		t.Error("a canvas session must not be told to brainstorm")
	}
}

// a design session is a normal session: run-agent env would hide it from the brainstorm pane, and a run stamp
// would let closing its tab fail the run
func TestSpawnDesignSessionIsANormalSession(t *testing.T) {
	stubWorkerSpawn(t)
	var persisted waveobj.MetaMapType
	persistWorkerBlockMeta = func(_ context.Context, _ string, meta waveobj.MetaMapType) error {
		persisted = meta
		return nil
	}
	opts := DesignSessionOptions("Ship the auth flow: tokens and sessions")
	if !opts.DesignSession || opts.RunId != "" || opts.TaskId != "" || opts.Label != "Ship the auth flow" {
		t.Fatalf("design session options = %+v", opts)
	}
	if _, err := SpawnRunWorker(context.Background(), piCap(t), "ws-1", "proj", "/proj", "brainstorm it", opts); err != nil {
		t.Fatal(err)
	}
	env := persisted.GetStringMap(waveobj.MetaKey_CmdEnv, false)
	if _, ok := env[RunAgentEnv]; ok {
		t.Fatalf("a design session carries %s: %v", RunAgentEnv, env)
	}
	if persisted.HasKey("agent:runid") || persisted.HasKey("agent:taskid") {
		t.Fatalf("a design session is stamped with a run: %v", persisted)
	}
}
