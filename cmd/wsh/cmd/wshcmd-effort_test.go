package cmd

import (
	"testing"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func hasSub(cmd *cobra.Command, name string) bool {
	for _, c := range cmd.Commands() {
		if c.Name() == name {
			return true
		}
	}
	return false
}

func TestEffortSubcommandsRegistered(t *testing.T) {
	for _, want := range []string{"create", "list", "show", "rename", "project", "ticket", "status", "unarchive", "link", "unlink", "delete", "advance", "reopen", "chunk"} {
		if !hasSub(effortCmd, want) {
			t.Fatalf("`effort %s` subcommand is not registered", want)
		}
	}
	for _, want := range []string{"add", "rename", "move", "remove", "status", "note", "owner", "stage"} {
		if !hasSub(effortChunkCmd, want) {
			t.Fatalf("`effort chunk %s` subcommand is not registered", want)
		}
	}
}

func TestEffortCreateFlags(t *testing.T) {
	f := effortCreateCmd.Flags()
	for _, want := range []string{"project", "ticket", "chunk", "parent", "json"} {
		if f.Lookup(want) == nil {
			t.Fatalf("missing --%s flag", want)
		}
	}
}

func TestEffortListFlags(t *testing.T) {
	f := effortListCmd.Flags()
	// without --archived there is no way to learn an archived effort's oid, and `effort unarchive`
	// needs one.
	for _, want := range []string{"project", "archived", "json"} {
		if f.Lookup(want) == nil {
			t.Fatalf("missing --%s flag", want)
		}
	}
}

func TestEffortChunkAttachDetachRegistered(t *testing.T) {
	for _, want := range []string{"attach", "detach"} {
		if !hasSub(effortChunkCmd, want) {
			t.Fatalf("`effort chunk %s` subcommand is not registered", want)
		}
	}
}

func TestEffortChunkAttachFlags(t *testing.T) {
	f := effortChunkAttachCmd.Flags()
	for _, want := range []string{"run", "agent"} {
		if f.Lookup(want) == nil {
			t.Fatalf("missing --%s flag", want)
		}
	}
}

func TestEffortChunkAddStageFlag(t *testing.T) {
	if effortChunkAddCmd.Flags().Lookup("stage") == nil {
		t.Fatal("missing --stage flag on `effort chunk add`")
	}
}

func TestFormatEffortShowGroupsConsecutiveStages(t *testing.T) {
	e := &waveobj.Effort{Title: "T", Status: "active", Chunks: []waveobj.EffortChunk{
		{Label: "a", Status: "done", Stage: "Evidence"},
		{Label: "b", Status: "active", Stage: "Evidence"},
		{Label: "c", Status: "pending", Stage: "Rollout"},
		{Label: "d", Status: "pending"},
		{Label: "e", Status: "pending", Stage: "Evidence"},
	}}
	got := formatEffortShow(e)
	want := "# T (active) — 1/5\n" +
		"  -- Evidence --\n" +
		"  1. [done] a\n" +
		"  2. [active] b\n" +
		"  -- Rollout --\n" +
		"  3. [pending] c\n" +
		"  4. [pending] d\n" + // unstaged: no header, and it does not inherit Rollout
		"  -- Evidence --\n" + // a stage that reappears prints again rather than gathering chunks
		"  5. [pending] e\n"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}
