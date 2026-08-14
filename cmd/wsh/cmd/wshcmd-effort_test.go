package cmd

import (
	"testing"

	"github.com/spf13/cobra"
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
	for _, want := range []string{"create", "list", "show", "rename", "project", "ticket", "status", "link", "unlink", "delete", "advance", "reopen", "chunk"} {
		if !hasSub(effortCmd, want) {
			t.Fatalf("`effort %s` subcommand is not registered", want)
		}
	}
	for _, want := range []string{"add", "rename", "move", "remove", "status", "note", "owner"} {
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
