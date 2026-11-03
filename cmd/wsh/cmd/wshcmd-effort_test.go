package cmd

import (
	"testing"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
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

func ticketedEffort() *waveobj.Effort {
	seen := time.Date(2026, 11, 3, 14, 2, 0, 0, time.Local).UnixMilli()
	return &waveobj.Effort{
		Title: "Retry webhook delivery", Status: "active", Project: "payments-api", Ticket: "PAY-318",
		Jira: &waveobj.EffortJira{Type: "Story", Status: "In Review", SeenTs: seen},
		Chunks: []waveobj.EffortChunk{
			{Label: "Retry with backoff", Status: "done"},
			{Label: "Give up after 6 attempts", Status: "active"},
		},
	}
}

func TestFormatEffortShowTicket(t *testing.T) {
	want := "# Retry webhook delivery (active) — 1/2\n" +
		"project  payments-api\n" +
		"ticket   PAY-318  Story · In Review (seen 11-03 14:02)\n" +
		"         read it: wsh jira show PAY-318\n" +
		"  1. [done] Retry with backoff\n" +
		"  2. [active] Give up after 6 attempts\n"
	if got := formatEffortShow(ticketedEffort()); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestFormatEffortShowTicketBeforeAnyCopy(t *testing.T) {
	e := ticketedEffort()
	e.Jira = nil
	want := "# Retry webhook delivery (active) — 1/2\n" +
		"project  payments-api\n" +
		"ticket   PAY-318\n" +
		"         read it: wsh jira show PAY-318\n" +
		"  1. [done] Retry with backoff\n" +
		"  2. [active] Give up after 6 attempts\n"
	if got := formatEffortShow(e); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestFormatEffortShowNoTicket(t *testing.T) {
	e := &waveobj.Effort{Title: "T", Status: "active", Project: "payments-api", Chunks: []waveobj.EffortChunk{{Label: "a", Status: "done"}}}
	want := "# T (active) — 1/1\n" +
		"project  payments-api\n" +
		"  1. [done] a\n"
	if got := formatEffortShow(e); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	e.Project = ""
	if got, want := formatEffortShow(e), "# T (active) — 1/1\n  1. [done] a\n"; got != want {
		t.Fatalf("no project: got:\n%s\nwant:\n%s", got, want)
	}
}

func TestEffortListTicketColumn(t *testing.T) {
	base := wshrpc.EffortSummary{ORef: "effort:3f81", Title: "Retry", Status: "active", Done: 1, Total: 3, ActiveChunk: "Give up"}
	if got, want := effortListLine(base), "effort:3f81\tRetry\tactive\t1/3\tGive up"; got != want {
		t.Fatalf("no ticket: got %q want %q", got, want)
	}
	base.Ticket = "PAY-318"
	if got, want := effortListLine(base), "effort:3f81\tRetry\tactive\t1/3\tGive up\tPAY-318"; got != want {
		t.Fatalf("before any copy: got %q want %q", got, want)
	}
	base.TicketSeen = &wshrpc.EffortTicketSeen{Type: "Story", Status: "In Review"}
	if got, want := effortListLine(base), "effort:3f81\tRetry\tactive\t1/3\tGive up\tPAY-318 Story · In Review"; got != want {
		t.Fatalf("with copy: got %q want %q", got, want)
	}
}
