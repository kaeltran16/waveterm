package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestFormatJiraCheck(t *testing.T) {
	r := &wshrpc.CommandJiraCheckRtnData{
		Covered: 2,
		Tickets: []wshrpc.JiraTicketRow{
			{
				JiraTicket: wshrpc.JiraTicket{Key: "PAY-311", Summary: "Settlement report drops refunds", Type: "Bug", Status: "In Progress"},
				Project:    "payments-api", Evidence: "4 initiatives, 23 tagged commits", Sure: true,
			},
			{
				JiraTicket: wshrpc.JiraTicket{Key: "GROW-12", Summary: "Export the funnel", Type: "Story", Status: "To Do"},
				Evidence:   "No history for GROW",
			},
			{
				JiraTicket: wshrpc.JiraTicket{Key: "OPS-77", Summary: "Rotate credentials", Type: "Task", Status: "To Do"},
			},
		},
	}
	want := "PAY-311\tBug · In Progress\tSettlement report drops refunds\tpayments-api (4 initiatives, 23 tagged commits)\n" +
		"GROW-12\tStory · To Do\tExport the funnel\tagent will ask (No history for GROW)\n" +
		"OPS-77\tTask · To Do\tRotate credentials\tagent will ask\n" +
		"2 more assigned tickets already have an initiative.\n"
	if got := formatJiraCheck(r); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestFormatJiraCheckCoveredCounts(t *testing.T) {
	cases := []struct {
		covered int
		want    string
	}{
		{0, "Every ticket assigned to you has an initiative.\n"},
		{1, "1 more assigned ticket already has an initiative.\n"},
	}
	for _, c := range cases {
		got := formatJiraCheck(&wshrpc.CommandJiraCheckRtnData{Covered: c.covered, Tickets: nil})
		if got != c.want {
			t.Fatalf("covered %d: got %q want %q", c.covered, got, c.want)
		}
	}
}

func TestFormatJiraShow(t *testing.T) {
	r := &wshrpc.CommandJiraShowRtnData{
		Ticket: wshrpc.JiraTicket{
			Key: "PAY-318", Summary: "Retry webhook delivery when the partner returns 429", Type: "Story", Status: "To Do",
			URL:         "https://acme.atlassian.net/browse/PAY-318",
			Description: "When a partner answers 429 we drop the delivery.",
			Acceptance:  []string{"429 responses are retried", "A delivery gives up after 6 attempts"},
		},
		Project: "payments-api", Evidence: "4 initiatives, 23 tagged commits", Sure: true,
	}
	want := "Retry webhook delivery when the partner returns 429\n" +
		"Story · To Do\n" +
		"https://acme.atlassian.net/browse/PAY-318\n" +
		"\n" +
		"When a partner answers 429 we drop the delivery.\n" +
		"\n" +
		"Acceptance criteria\n" +
		"- 429 responses are retried\n" +
		"- A delivery gives up after 6 attempts\n" +
		"\n" +
		"project payments-api (4 initiatives, 23 tagged commits)\n"
	if got := formatJiraShow(r); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestFormatJiraShowUnsureAndBare(t *testing.T) {
	r := &wshrpc.CommandJiraShowRtnData{
		Ticket:   wshrpc.JiraTicket{Key: "OPS-77", Summary: "Rotate credentials", Type: "Task", Status: "To Do", URL: "https://acme.atlassian.net/browse/OPS-77"},
		Evidence: "Tied: payments-api and infra",
	}
	want := "Rotate credentials\n" +
		"Task · To Do\n" +
		"https://acme.atlassian.net/browse/OPS-77\n" +
		"\n" +
		"project unsure (Tied: payments-api and infra); ask which project before creating anything\n"
	if got := formatJiraShow(r); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestJiraKeyArg(t *testing.T) {
	if got, err := jiraKeyArg(" pay-318 "); err != nil || got != "PAY-318" {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, bad := range []string{"", "318", "PAY318", "pay-", "see PAY-318"} {
		_, err := jiraKeyArg(bad)
		if err == nil || !strings.Contains(err.Error(), "PAY-318") {
			t.Fatalf("%q: want an error naming the expected shape, got %v", bad, err)
		}
	}
}

func TestJiraSubcommandsRegistered(t *testing.T) {
	for _, want := range []string{"check", "show"} {
		if !hasSub(jiraCmd, want) {
			t.Fatalf("`jira %s` subcommand is not registered", want)
		}
		sub, _, _ := jiraCmd.Find([]string{want})
		if sub.Flags().Lookup("json") == nil {
			t.Fatalf("`jira %s` has no --json", want)
		}
	}
}
