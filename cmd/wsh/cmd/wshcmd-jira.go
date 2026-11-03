// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/jira"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

const (
	jiraProjectUnsure = "agent will ask"
	// wavesrv lists the ticket's attachments before it downloads one
	jiraReadSlackMs = 15_000
	// a full read pages every comment and infers the project from git history (up to 15s)
	jiraShowTimeoutMs = 60_000
	jiraDateLayout    = "2006-01-02"
	jiraDirMode       = 0o755
	jiraFileMode      = 0o644
)

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
	Short:   "read a ticket: summary, status, description, acceptance criteria, attachments, comments, and the project Arc infers",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		key, err := jiraKeyArg(args[0])
		if err != nil {
			return err
		}
		rtn, err := wshclient.JiraShowCommand(RpcClient, wshrpc.CommandJiraShowData{Key: key, Via: "show"}, &wshrpc.RpcOpts{Timeout: jiraShowTimeoutMs})
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

var jiraAttachmentsCmd = &cobra.Command{
	Use:     "attachments <KEY>",
	Short:   "save a ticket's attachments into a new directory and print each saved path (the API token stays in Arc)",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE:    runJiraAttachments,
}

type savedJiraAttachment struct {
	wshrpc.JiraAttachment
	Path string `json:"path"`
}

func runJiraAttachments(cmd *cobra.Command, args []string) error {
	key, err := jiraKeyArg(args[0])
	if err != nil {
		return err
	}
	out, _ := cmd.Flags().GetString("out")
	only, _ := cmd.Flags().GetString("only")
	list, err := wshclient.JiraAttachmentsCommand(RpcClient, wshrpc.CommandJiraAttachmentsData{Key: key}, nil)
	if err != nil {
		return err
	}
	picked, err := pickJiraAttachments(key, list.Attachments, only)
	if err != nil {
		return err
	}
	saved := []savedJiraAttachment{}
	if len(picked) == 0 {
		WriteStderr("%s has no attachments\n", key)
		if isJSON(cmd) {
			return jsonOut(saved)
		}
		return nil
	}
	dir, err := jiraAttachmentDir(key, out)
	if err != nil {
		return err
	}
	opts := &wshrpc.RpcOpts{Timeout: jira.DownloadTimeoutMs + jiraReadSlackMs}
	for _, a := range picked {
		path, err := fetchJiraAttachment(dir, key, a, opts)
		if err != nil {
			WriteStderr("%s %s: %v\n", a.ID, a.Filename, err)
			continue
		}
		saved = append(saved, savedJiraAttachment{JiraAttachment: a, Path: path})
		if !isJSON(cmd) {
			fmt.Println(path)
		}
	}
	if isJSON(cmd) {
		if err := jsonOut(saved); err != nil {
			return err
		}
	}
	if failed := len(picked) - len(saved); failed > 0 {
		return fmt.Errorf("%d of %d attachments of %s were not saved", failed, len(picked), key)
	}
	return nil
}

// pickJiraAttachments is every attachment, or with only the one with that id, else those with that
// file name (case-insensitively; a ticket can hold two "image.png"s).
func pickJiraAttachments(key string, atts []wshrpc.JiraAttachment, only string) ([]wshrpc.JiraAttachment, error) {
	only = strings.TrimSpace(only)
	if only == "" {
		return atts, nil
	}
	var picked []wshrpc.JiraAttachment
	for _, a := range atts {
		if a.ID == only {
			return []wshrpc.JiraAttachment{a}, nil
		}
		if strings.EqualFold(a.Filename, only) {
			picked = append(picked, a)
		}
	}
	if len(picked) > 0 {
		return picked, nil
	}
	if len(atts) == 0 {
		return nil, fmt.Errorf("EC-INVALID-ARGS: %s has no attachments", key)
	}
	names := make([]string, 0, len(atts))
	for _, a := range atts {
		names = append(names, a.ID+" "+a.Filename)
	}
	return nil, fmt.Errorf("EC-INVALID-ARGS: %s has no attachment named or numbered %q; it has: %s", key, only, strings.Join(names, ", "))
}

// jiraAttachmentDir is out, made if missing, or a new empty directory for the ticket.
func jiraAttachmentDir(key, out string) (string, error) {
	if out == "" {
		dir, err := os.MkdirTemp("", "arc-jira-"+key+"-")
		if err != nil {
			return "", fmt.Errorf("making a directory for %s's attachments: %w", key, err)
		}
		return dir, nil
	}
	dir, err := filepath.Abs(out)
	if err != nil {
		return "", fmt.Errorf("resolving --out %q: %w", out, err)
	}
	if err := os.MkdirAll(dir, jiraDirMode); err != nil {
		return "", fmt.Errorf("making --out %q: %w", out, err)
	}
	return dir, nil
}

func fetchJiraAttachment(dir, key string, a wshrpc.JiraAttachment, opts *wshrpc.RpcOpts) (string, error) {
	rtn, err := wshclient.JiraAttachmentReadCommand(RpcClient, wshrpc.CommandJiraAttachmentReadData{Key: key, ID: a.ID}, opts)
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(rtn.Data64)
	if err != nil {
		return "", fmt.Errorf("decoding attachment %s: %w", a.ID, err)
	}
	return writeJiraAttachment(dir, a, data)
}

// writeJiraAttachment creates the attachment's file in dir and never replaces one already there.
func writeJiraAttachment(dir string, a wshrpc.JiraAttachment, data []byte) (string, error) {
	path := filepath.Join(dir, jira.AttachmentFileName(a))
	// AttachmentFileName is one path element; this guards that promise where the file is written
	if filepath.Dir(path) != filepath.Clean(dir) {
		return "", fmt.Errorf("attachment %s's name %q leaves %s", a.ID, a.Filename, dir)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, jiraFileMode)
	if err != nil {
		return "", fmt.Errorf("saving attachment %s: %w", a.ID, err)
	}
	_, werr := f.Write(data)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		os.Remove(path)
		return "", fmt.Errorf("saving attachment %s to %s: %w", a.ID, path, errors.Join(werr, cerr))
	}
	return path, nil
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
	if len(t.Attachments) > 0 {
		b.WriteString("\nAttachments\n")
		for _, a := range t.Attachments {
			line := fmt.Sprintf("- %s %s (%s, %s) %s", a.ID, a.Filename, a.MimeType, jiraSize(a.Size), jiraByline(a.Author, a.CreatedTs))
			fmt.Fprintf(&b, "%s\n", strings.TrimRight(line, " "))
		}
		fmt.Fprintf(&b, "save them: wsh jira attachments %s [--only <name|id>]\n", t.Key)
	}
	if len(t.Comments) > 0 {
		b.WriteString("\nComments\n")
		for _, c := range t.Comments {
			fmt.Fprintf(&b, "- %s\n", jiraByline(c.Author, c.CreatedTs))
			for _, line := range strings.Split(c.Body, "\n") {
				fmt.Fprintf(&b, "%s\n", strings.TrimRight("  "+line, " "))
			}
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

// jiraByline reads "Ana, 2026-11-03", leaving out whichever part Jira did not give.
func jiraByline(author string, ts int64) string {
	parts := []string{}
	if author != "" {
		parts = append(parts, author)
	}
	if ts > 0 {
		parts = append(parts, time.UnixMilli(ts).UTC().Format(jiraDateLayout))
	}
	return strings.Join(parts, ", ")
}

func jiraSize(n int64) string {
	const kb, mb = 1024, 1024 * 1024
	switch {
	case n < kb:
		return fmt.Sprintf("%d B", n)
	case n < mb:
		return fmt.Sprintf("%d KB", (n+kb/2)/kb)
	default:
		return fmt.Sprintf("%.1f MB", float64(n)/mb)
	}
}

func init() {
	jiraCheckCmd.Flags().Bool("json", false, "JSON output")
	jiraShowCmd.Flags().Bool("json", false, "JSON output")
	jiraAttachmentsCmd.Flags().Bool("json", false, "JSON output: each saved attachment with its path")
	jiraAttachmentsCmd.Flags().String("out", "", "directory to save into (made if missing; an existing file is never replaced); default a new temp directory")
	jiraAttachmentsCmd.Flags().String("only", "", "save only the attachment with this id, or those with this file name")
	jiraCmd.AddCommand(jiraCheckCmd, jiraShowCmd, jiraAttachmentsCmd)
	rootCmd.AddCommand(jiraCmd)
}
