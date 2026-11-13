// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boarddrawer

import (
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

func TestToolGuardFailsClosedOnExtraTools(t *testing.T) {
	cancelled := false
	g := &toolGuard{cancel: func() { cancelled = true }}
	if err := g.check([]byte(`{"type":"system","subtype":"init","tools":["Read","Glob","Grep"]}`)); err != nil || !g.sawInit {
		t.Fatalf("read-only tools refused: %v", err)
	}
	g = &toolGuard{cancel: func() { cancelled = true }}
	err := g.check([]byte(`{"type":"system","subtype":"init","tools":["Read","Bash","Edit"]}`))
	if err == nil || !cancelled || !strings.Contains(err.Error(), "Bash, Edit") {
		t.Fatalf("extra tools not refused: err=%v cancelled=%v", err, cancelled)
	}
	if g.check([]byte(`{"type":"assistant"}`)) == nil {
		t.Errorf("a failed guard must keep failing later lines")
	}
}

func TestDrawerArgs(t *testing.T) {
	base, ok := consult.SpecFor("claude")
	if !ok {
		t.Fatal("no claude spec")
	}
	cases := []struct {
		name string
		call Call
		want []string
		not  []string
	}{
		{"first turn", Call{SessionId: "X"}, []string{"--session-id X"}, []string{"--resume", "--fork-session"}},
		{"follow-up", Call{SessionId: "X", Resume: true}, []string{"--resume X"}, []string{"--session-id", "--fork-session"}},
		{"summary", Call{SessionId: "X", Resume: true, Fork: true}, []string{"--resume X --fork-session"}, []string{"--session-id"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			spec, _ := drawerSpec(base, c.call, func() {})
			args := strings.Join(spec.BaseArgs, " ")
			for _, w := range append(c.want, "--model sonnet", "--tools Read,Grep,Glob", "--strict-mcp-config",
				"--setting-sources= ", "--disable-slash-commands") {
				if !strings.Contains(args, w) {
					t.Errorf("args %q lack %q", args, w)
				}
			}
			for _, n := range c.not {
				if strings.Contains(args, n) {
					t.Errorf("args %q must not carry %q", args, n)
				}
			}
			if !strings.HasPrefix(args, strings.Join(base.BaseArgs, " ")) {
				t.Errorf("args %q dropped the runtime's base args", args)
			}
			for _, e := range append([]string{persistSessionsEnv}, leanEnv...) {
				if !slices.Contains(spec.Env, e) {
					t.Errorf("env %v lacks %q", spec.Env, e)
				}
			}
			for _, e := range base.Env {
				if !slices.Contains(spec.Env, e) {
					t.Errorf("env %v dropped the runtime's %q", spec.Env, e)
				}
			}
		})
	}
	if slices.Contains(base.Env, persistSessionsEnv) {
		t.Errorf("drawerSpec must not write into the shared runtime spec's env")
	}
}
