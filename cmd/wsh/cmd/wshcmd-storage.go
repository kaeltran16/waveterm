// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

const (
	storageWaitPoll = time.Second
	// a scan walks every project's trees and git state; a clear removes trees one by one
	storageWaitLimit  = 30 * time.Minute
	storageTimeLayout = "2006-01-02 15:04"
	storageShaLen     = 8
	// a run title is often its whole goal prompt
	storageTitleLen = 80
)

// the Settings > Storage sections, in their order
var storageGroups = []struct{ group, title string }{
	{wshrpc.StorageGroup_Left, "left over"},
	{wshrpc.StorageGroup_InUse, "in use"},
	{wshrpc.StorageGroup_Kept, "kept"},
}

var (
	storageWait   bool
	storageAll    bool
	storageTip    string
	storageAsJSON bool
)

var storageCmd = &cobra.Command{
	Use:   "storage",
	Short: "see and clear what Arc's runs left on disk: run trees, wave/* branches, Final outputs (Settings > Storage)",
}

var storageReportCmd = &cobra.Command{
	Use:     "report",
	Short:   "print the last scan's rows by group, with each left over row's id and why it is or is not clearable",
	Args:    cobra.NoArgs,
	RunE:    storageReportRun,
	PreRunE: preRunSetupRpcClient,
}

var storageScanCmd = &cobra.Command{
	Use:     "scan",
	Short:   "start a fresh scan; --wait blocks until it ends and prints the report",
	Args:    cobra.NoArgs,
	RunE:    storageScanRun,
	PreRunE: preRunSetupRpcClient,
}

var storageClearCmd = &cobra.Command{
	Use:   "clear [id...]",
	Short: "delete left over rows that lose nothing (no unmerged commits, no uncommitted files); --all takes every one",
	Long: `Delete left over rows the scan marked clearable. Each row is re-checked right before it is deleted,
so a row that changed since the scan (its run restarted, a commit landed) is skipped, not deleted.
--wait blocks until the clear ends and prints what it cleared, freed, skipped and failed.`,
	RunE:    storageClearRun,
	PreRunE: preRunSetupRpcClient,
}

var storageDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "force-delete a left over row with unmerged commits or uncommitted files; only after the user approves",
	Long: `Delete a left over row that clear skips for its unmerged commits or uncommitted files. That work is lost.
Run it only after showing the user the row's commits or files and getting their approval for this row.
--tip is the branch tip the report printed for the row; if the branch moved since, the row is skipped.`,
	Args:    cobra.ExactArgs(1),
	RunE:    storageDeleteRun,
	PreRunE: preRunSetupRpcClient,
}

func storageReport() (*wshrpc.StorageReportData, error) {
	r, err := wshclient.StorageReportCommand(RpcClient, nil)
	if err != nil {
		return nil, fmt.Errorf("reading the storage report: %w", err)
	}
	return r, nil
}

func storageReportRun(cmd *cobra.Command, args []string) error {
	r, err := storageReport()
	if err != nil {
		return err
	}
	if storageAsJSON {
		return jsonOut(r)
	}
	WriteStdout("%s", formatStorageReport(r, time.Local))
	return nil
}

func storageScanRun(cmd *cobra.Command, args []string) error {
	if err := wshclient.StorageScanCommand(RpcClient, nil); err != nil {
		return fmt.Errorf("starting the storage scan: %w", err)
	}
	if !storageWait {
		WriteStdout("scanning; see `wsh storage report`, or pass --wait\n")
		return nil
	}
	r, err := storageWaitIdle("scan")
	if err != nil {
		return err
	}
	WriteStdout("%s", formatStorageReport(r, time.Local))
	return nil
}

func storageClearRun(cmd *cobra.Command, args []string) error {
	ids := args
	if storageAll == (len(ids) > 0) {
		return fmt.Errorf("pass row ids or --all, not both or neither")
	}
	if storageAll {
		r, err := storageReport()
		if err != nil {
			return err
		}
		ids = storageClearableIds(r)
		if len(ids) == 0 {
			WriteStdout("nothing left over is clearable\n")
			return nil
		}
	}
	if err := wshclient.StorageClearCommand(RpcClient, wshrpc.CommandStorageClearData{Ids: ids}, nil); err != nil {
		return fmt.Errorf("starting the clear: %w", err)
	}
	return storageFinishClear(ids)
}

func storageDeleteRun(cmd *cobra.Command, args []string) error {
	if err := wshclient.StorageDeleteCommand(RpcClient, wshrpc.CommandStorageDeleteData{Id: args[0], Tip: storageTip}, nil); err != nil {
		return fmt.Errorf("starting the delete: %w", err)
	}
	return storageFinishClear(args)
}

func storageFinishClear(ids []string) error {
	if !storageWait {
		WriteStdout("clearing %d row(s); see `wsh storage report`, or pass --wait\n", len(ids))
		return nil
	}
	r, err := storageWaitIdle("clear")
	if err != nil {
		return err
	}
	WriteStdout("%s", formatStorageClear(r, ids))
	return nil
}

// storageWaitIdle polls until no scan or clear runs; a job that failed as a whole is the error.
func storageWaitIdle(what string) (*wshrpc.StorageReportData, error) {
	deadline := time.Now().Add(storageWaitLimit)
	for {
		time.Sleep(storageWaitPoll)
		r, err := storageReport()
		if err != nil {
			return nil, err
		}
		if !r.Scanning && !r.Clearing {
			if r.JobError != "" {
				return nil, fmt.Errorf("storage %s: %s", what, r.JobError)
			}
			return r, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("storage %s still running after %s", what, storageWaitLimit)
		}
	}
}

func storageClearableIds(r *wshrpc.StorageReportData) []string {
	var ids []string
	for _, it := range r.Items {
		if it.Group == wshrpc.StorageGroup_Left && it.Clearable {
			ids = append(ids, it.Id)
		}
	}
	return ids
}

func formatStorageSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}

func shortSha(sha string) string {
	if len(sha) > storageShaLen {
		return sha[:storageShaLen]
	}
	return sha
}

// storageRowState says whether clear takes the row, and if not, why not
func storageRowState(it wshrpc.StorageItem) string {
	switch {
	case it.ClearState != "":
		if it.ClearError != "" {
			return it.ClearState + ": " + it.ClearError
		}
		return it.ClearState
	case it.Clearable:
		return "clearable"
	case it.Skip == wshrpc.StorageSkip_Commits:
		return fmt.Sprintf("%d unmerged commit(s)", it.OnlyCount)
	case it.Skip == wshrpc.StorageSkip_Dirty:
		return fmt.Sprintf("%d uncommitted file(s)", it.Dirty)
	case it.Skip == wshrpc.StorageSkip_Unreadable:
		return "unreadable"
	}
	return ""
}

func formatStorageRow(b *strings.Builder, it wshrpc.StorageItem) {
	parts := []string{it.Kind, formatStorageSize(it.Size)}
	if s := storageRowState(it); s != "" {
		parts = append(parts, s)
	}
	if it.ProjectName != "" {
		parts = append(parts, "project "+it.ProjectName)
	}
	if it.RunTitle != "" {
		parts = append(parts, fmt.Sprintf("run %q (%s)", utilfn.EllipsisStr(it.RunTitle, storageTitleLen), it.RunStatus))
	}
	if it.Branch != "" {
		parts = append(parts, "branch "+it.Branch)
	}
	// the tip delete --tip needs; an unmerged row's whole point
	if it.BranchTip != "" && (it.Skip == wshrpc.StorageSkip_Commits || it.Skip == wshrpc.StorageSkip_Dirty) {
		parts = append(parts, "tip "+it.BranchTip)
	}
	if it.AlsoOn != "" {
		parts = append(parts, "all commits also on "+it.AlsoOn)
	}
	fmt.Fprintf(b, "  %s\n    %s\n", it.Id, strings.Join(parts, ", "))
	for _, c := range it.OnlyCommits {
		fmt.Fprintf(b, "      %s %s\n", shortSha(c.Sha), c.Subject)
	}
}

func formatStorageReport(r *wshrpc.StorageReportData, loc *time.Location) string {
	var b strings.Builder
	if r.ScanTs == 0 {
		b.WriteString("never scanned\n")
	} else {
		fmt.Fprintf(&b, "scanned %s\n", time.UnixMilli(r.ScanTs).In(loc).Format(storageTimeLayout))
	}
	if r.Scanning {
		b.WriteString("scanning now\n")
	}
	if r.Clearing {
		fmt.Fprintf(&b, "clearing now, %d of %d done\n", r.ClearDone, r.ClearTotal)
	}
	if r.JobError != "" {
		fmt.Fprintf(&b, "last job failed: %s\n", r.JobError)
	}
	for _, e := range r.Errors {
		fmt.Fprintf(&b, "could not scan %s (%s): %s\n", e.ProjectName, e.ProjectPath, e.Error)
	}
	for _, g := range storageGroups {
		var rows []wshrpc.StorageItem
		var total, clearable int64
		for _, it := range r.Items {
			if it.Group != g.group {
				continue
			}
			rows = append(rows, it)
			total += it.Size
			if it.Clearable {
				clearable += it.Size
			}
		}
		if len(rows) == 0 {
			continue
		}
		slices.SortStableFunc(rows, func(a, b wshrpc.StorageItem) int { return cmp.Compare(b.Size, a.Size) })
		fmt.Fprintf(&b, "\n%s: %d row(s), %s", g.title, len(rows), formatStorageSize(total))
		if clearable > 0 {
			fmt.Fprintf(&b, ", %s clearable", formatStorageSize(clearable))
		}
		b.WriteString("\n")
		for _, it := range rows {
			formatStorageRow(&b, it)
		}
	}
	return b.String()
}

// formatStorageClear reports the clear of ids: cleared rows leave the report, skipped and failed ones stay with
// their state.
func formatStorageClear(r *wshrpc.StorageReportData, ids []string) string {
	var b strings.Builder
	if lc := r.LastClear; lc != nil {
		fmt.Fprintf(&b, "cleared %d row(s), freed %s\n", lc.Cleared, formatStorageSize(lc.Freed))
	}
	for _, it := range r.Items {
		if !slices.Contains(ids, it.Id) {
			continue
		}
		switch it.ClearState {
		case wshrpc.StorageClear_Skipped, wshrpc.StorageClear_Failed:
			fmt.Fprintf(&b, "%s %s: %s\n", it.ClearState, it.Id, it.ClearError)
			if it.ClearHeld {
				b.WriteString("  a process holds it open\n")
			}
		}
	}
	return b.String()
}

func init() {
	storageReportCmd.Flags().BoolVar(&storageAsJSON, "json", false, "JSON output (the full report, every row's facts)")
	storageScanCmd.Flags().BoolVar(&storageWait, "wait", false, "block until the scan ends, then print the report")
	storageClearCmd.Flags().BoolVar(&storageWait, "wait", false, "block until the clear ends, then print the result")
	storageClearCmd.Flags().BoolVar(&storageAll, "all", false, "clear every clearable left over row")
	storageDeleteCmd.Flags().BoolVar(&storageWait, "wait", false, "block until the delete ends, then print the result")
	storageDeleteCmd.Flags().StringVar(&storageTip, "tip", "", "the row's branch tip from the report; omit for a row with no branch")
	storageCmd.AddCommand(storageReportCmd, storageScanCmd, storageClearCmd, storageDeleteCmd)
	rootCmd.AddCommand(storageCmd)
}
