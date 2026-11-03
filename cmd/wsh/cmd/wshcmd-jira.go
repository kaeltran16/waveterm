// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/jira"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

const jiraProjectUnsure = "agent will ask"

var jiraCmd = &cobra.Command{
	Use:   "jira",
	Short: "read Jira tickets through Arc (the API token stays in Arc)",
}

var jiraCheckCmd = &cobra.Command{
	Use:     "check",
	Short:   "list the open tickets assigned to you that have no initiative yet",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		rtn, err := wshclient.JiraCheckCommand(RpcClient, nil)
		if err != nil {
			return err
		}
		if isJSON(cmd) {
			return jsonOut(rtn)
		}
		fmt.Print(formatJiraCheck(rtn))
		return nil
	},
}

var jiraShowCmd = &cobra.Command{
	Use:     "show <KEY>",
	Short:   "read a ticket: summary, status, description, acceptance criteria, and the project Arc infers",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		key, err := jiraKeyArg(args[0])
		if err != nil {
			return err
		}
		rtn, err := wshclient.JiraShowCommand(RpcClient, wshrpc.CommandJiraShowData{Key: key, Via: "show"}, nil)
		if err != nil {
			return err
		}
		if isJSON(cmd) {
			return jsonOut(rtn)
		}
		fmt.Print(formatJiraShow(rtn))
		return nil
	},
}

// jiraKeyArg normalizes a typed key, and refuses anything else before it can reach Jira.
func jiraKeyArg(arg string) (string, error) {
	key := jira.NormalizeKey(arg)
	if key == "" {
		return "", fmt.Errorf("EC-INVALID-ARGS: %q is not a Jira issue key; expected <PROJECT>-<number>, like PAY-318", arg)
	}
	return key, nil
}

func jiraTypeStatus(issueType, status string) string {
	return issueType + " · " + status
}

// formatJiraCheck is one tab-separated line per ticket (key, type and status, summary, project), then what
// was left out.
func formatJiraCheck(r *wshrpc.CommandJiraCheckRtnData) string {
	var b strings.Builder
	for _, t := range r.Tickets {
		project := jiraProjectUnsure
		if t.Sure {
			project = t.Project
		}
		if t.Evidence != "" {
			project += " (" + t.Evidence + ")"
		}
		fmt.Fprintf(&b, "%s\t%s\t%s\t%s\n", t.Key, jiraTypeStatus(t.Type, t.Status), t.Summary, project)
	}
	switch r.Covered {
	case 0:
		b.WriteString("Every ticket assigned to you has an initiative.\n")
	case 1:
		b.WriteString("1 more assigned ticket already has an initiative.\n")
	default:
		fmt.Fprintf(&b, "%d more assigned tickets already have an initiative.\n", r.Covered)
	}
	return b.String()
}

// formatJiraShow is the ticket as an agent plans from it, ending on the project it should create the
// initiative in, or the instruction to ask when Arc is not sure.
func formatJiraShow(r *wshrpc.CommandJiraShowRtnData) string {
	t := r.Ticket
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n%s\n%s\n", t.Summary, jiraTypeStatus(t.Type, t.Status), t.URL)
	if t.Description != "" {
		fmt.Fprintf(&b, "\n%s\n", t.Description)
	}
	if len(t.Acceptance) > 0 {
		b.WriteString("\nAcceptance criteria\n")
		for _, item := range t.Acceptance {
			fmt.Fprintf(&b, "- %s\n", item)
		}
	}
	evidence := ""
	if r.Evidence != "" {
		evidence = " (" + r.Evidence + ")"
	}
	if r.Sure {
		fmt.Fprintf(&b, "\nproject %s%s\n", r.Project, evidence)
	} else {
		fmt.Fprintf(&b, "\nproject unsure%s; ask which project before creating anything\n", evidence)
	}
	return b.String()
}

func init() {
	jiraCheckCmd.Flags().Bool("json", false, "JSON output")
	jiraShowCmd.Flags().Bool("json", false, "JSON output")
	jiraCmd.AddCommand(jiraCheckCmd, jiraShowCmd)
	rootCmd.AddCommand(jiraCmd)
}
