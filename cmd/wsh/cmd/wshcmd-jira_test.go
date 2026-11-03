package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

func TestFormatJiraShowAttachmentsAndComments(t *testing.T) {
	ts := time.Date(2026, 11, 3, 9, 30, 0, 0, time.UTC).UnixMilli()
	r := &wshrpc.CommandJiraShowRtnData{
		Ticket: wshrpc.JiraTicket{
			Key: "SIEM-1744", Summary: "Alert grid drops rows", Type: "Bug", Status: "To Do",
			URL:         "https://acme.atlassian.net/browse/SIEM-1744",
			Description: "Normal results:\n\n[image: shot.png (attachment 10001)]",
			Attachments: []wshrpc.JiraAttachment{
				{ID: "10001", Filename: "shot.png", MimeType: "image/png", Size: 245 * 1024, Author: "Ana", CreatedTs: ts},
				{ID: "10002", Filename: "dump.zip", MimeType: "application/zip", Size: 3 * 1024 * 1024},
			},
			Comments: []wshrpc.JiraComment{
				{ID: "1", Author: "Bo", CreatedTs: ts, Body: "Still broken.\n\n[image: shot.png (attachment 10001)]"},
			},
		},
		Project: "siem", Sure: true,
	}
	want := "Alert grid drops rows\n" +
		"Bug · To Do\n" +
		"https://acme.atlassian.net/browse/SIEM-1744\n" +
		"\n" +
		"Normal results:\n\n[image: shot.png (attachment 10001)]\n" +
		"\n" +
		"Attachments\n" +
		"- 10001 shot.png (image/png, 245 KB) Ana, 2026-11-03\n" +
		"- 10002 dump.zip (application/zip, 3.0 MB)\n" +
		"save them: wsh jira attachments SIEM-1744 [--only <name|id>]\n" +
		"\n" +
		"Comments\n" +
		"- Bo, 2026-11-03\n" +
		"  Still broken.\n" +
		"\n" +
		"  [image: shot.png (attachment 10001)]\n" +
		"\n" +
		"project siem\n"
	if got := formatJiraShow(r); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestPickJiraAttachments(t *testing.T) {
	atts := []wshrpc.JiraAttachment{
		{ID: "1", Filename: "image.png"}, {ID: "2", Filename: "Image.PNG"}, {ID: "3", Filename: "log.txt"},
	}
	ids := func(as []wshrpc.JiraAttachment) string {
		var out []string
		for _, a := range as {
			out = append(out, a.ID)
		}
		return strings.Join(out, ",")
	}
	cases := map[string]string{"": "1,2,3", "3": "3", "image.png": "1,2", " log.txt ": "3"}
	for only, want := range cases {
		got, err := pickJiraAttachments("PAY-1", atts, only)
		if err != nil || ids(got) != want {
			t.Errorf("only %q: got %s, %v; want %s", only, ids(got), err, want)
		}
	}
	_, err := pickJiraAttachments("PAY-1", atts, "missing.png")
	if err == nil || !strings.Contains(err.Error(), "3 log.txt") {
		t.Errorf("no match: err = %v, want the list of what the ticket has", err)
	}
}

func TestWriteJiraAttachmentStaysInDirAndNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	a := wshrpc.JiraAttachment{ID: "10001", Filename: "../../evil.png"}
	path, err := writeJiraAttachment(dir, a, []byte("one"))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(path) != dir || filepath.Base(path) != "10001-.._.._evil.png" {
		t.Fatalf("saved to %q", path)
	}
	if _, err := writeJiraAttachment(dir, a, []byte("two")); err == nil {
		t.Fatal("second save replaced the first")
	}
	if data, _ := os.ReadFile(path); string(data) != "one" {
		t.Fatalf("file holds %q", data)
	}
}

func TestJiraAttachmentDirIsNewPerCall(t *testing.T) {
	a, err := jiraAttachmentDir("PAY-1", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(a) })
	b, err := jiraAttachmentDir("PAY-1", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(b) })
	if a == b || !strings.Contains(filepath.Base(a), "PAY-1") {
		t.Fatalf("dirs %q, %q", a, b)
	}
	if entries, _ := os.ReadDir(a); len(entries) != 0 {
		t.Fatalf("%s is not empty", a)
	}
	out := filepath.Join(t.TempDir(), "nested", "out")
	if got, err := jiraAttachmentDir("PAY-1", out); err != nil || got != out {
		t.Fatalf("--out: %q, %v", got, err)
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
	for _, want := range []string{"check", "show", "attachments"} {
		if !hasSub(jiraCmd, want) {
			t.Fatalf("`jira %s` subcommand is not registered", want)
		}
		sub, _, _ := jiraCmd.Find([]string{want})
		if sub.Flags().Lookup("json") == nil {
			t.Fatalf("`jira %s` has no --json", want)
		}
	}
}
