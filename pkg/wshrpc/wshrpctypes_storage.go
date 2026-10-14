// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// StorageCommands is the Storage report API: what Arc and its agents keep on this machine, which run left each
// item, and clearing the left-over items (pkg/storagereport). Scan, clear and delete run as background jobs.
type StorageCommands interface {
	StorageReportCommand(ctx context.Context) (*StorageReportData, error) // snapshot, never blocks
	StorageScanCommand(ctx context.Context) error                         // starts a scan; ErrBusy while a job runs
	StorageClearCommand(ctx context.Context, data CommandStorageClearData) error
	StorageDeleteCommand(ctx context.Context, data CommandStorageDeleteData) error
}

const (
	StorageKind_RunTree     = "runtree"     // a folder under the worktree root (arc-wt)
	StorageKind_LegacyTree  = "legacytree"  // <project>\.waveterm\worktrees\<key>
	StorageKind_LegacyGroup = "legacygroup" // a project's emptied, untracked legacy folders of finished runs, one row
	StorageKind_Branch      = "branch"      // a wave/* branch with no tree
	StorageKind_FinalSlot   = "finalslot"   // %LOCALAPPDATA%\arc-final\target[-N]
	StorageKind_FinalStores = "finalstores" // %LOCALAPPDATA%\arc-final\stores[-N], one row
	StorageKind_FinalShots  = "finalshots"  // <data>\final-shots, one row
	StorageKind_FinalOut    = "finalout"    // hand-run Final output, one row per location
	StorageKind_Transcripts = "transcripts" // ~/.claude/projects or ~/.pi, one row each

	StorageGroup_Left  = "left"
	StorageGroup_InUse = "inuse"
	StorageGroup_Kept  = "kept"

	StorageSkip_Commits    = "commits"    // commits on no other branch
	StorageSkip_Dirty      = "dirty"      // uncommitted files in a tracked tree
	StorageSkip_Unreadable = "unreadable" // its run or git state could not be read

	StorageClear_Clearing = "clearing"
	StorageClear_Cleared  = "cleared"
	StorageClear_Failed   = "failed"
	StorageClear_Skipped  = "skipped" // changed since the scan
)

type StorageCommit struct {
	Sha     string `json:"sha"`
	Subject string `json:"subject"`
}

type StorageItem struct {
	Id      string   `json:"id"`              // kind + ":" + full path, or kind + ":" + project path + ":" + ref for a branch; stable across scans
	Kind    string   `json:"kind"`            // StorageKind_*
	Group   string   `json:"group"`           // StorageGroup_*
	Path    string   `json:"path,omitempty"`  // full path; a grouped row's parent folder; "" for a branch-only row
	Paths   []string `json:"paths,omitempty"` // a grouped row's members, deleted one by one
	Count   int      `json:"count,omitempty"` // members of a group; dags for finalshots
	Suffix  string   `json:"suffix,omitempty"`
	Harness string   `json:"harness,omitempty"` // transcripts: "claude" | "pi"
	Slot    int      `json:"slot,omitempty"`    // finalslot / finalstores slot number

	ProjectName string `json:"projectname,omitempty"`
	ProjectPath string `json:"projectpath,omitempty"`
	Branch      string `json:"branch,omitempty"` // wave/<key> the row owns
	BranchTip   string `json:"branchtip,omitempty"`

	RunId            string `json:"runid,omitempty"`
	RunChannelId     string `json:"runchannelid,omitempty"`
	RunTitle         string `json:"runtitle,omitempty"`
	RunStatus        string `json:"runstatus,omitempty"`
	RunLandState     string `json:"runlandstate,omitempty"`
	RunLandDismissed bool   `json:"runlanddismissed,omitempty"`
	RunTs            int64  `json:"runts,omitempty"`    // completed ts, else created ts (ms)
	RunCount         int    `json:"runcount,omitempty"` // legacygroup: finished runs it holds

	Tracked     bool            `json:"tracked,omitempty"`     // git worktree list of its project lists it
	HasGit      bool            `json:"hasgit,omitempty"`      // a .git entry exists (false = emptied)
	Dirty       int             `json:"dirty,omitempty"`       // uncommitted files in a tracked tree
	OnlyCount   int             `json:"onlycount,omitempty"`   // commits on no other branch
	OnlyCommits []StorageCommit `json:"onlycommits,omitempty"` // the first 20 of them
	AlsoOn      string          `json:"alsoon,omitempty"`      // a branch that holds every commit, when OnlyCount == 0

	Size  int64 `json:"size"`            // bytes, junctions and symlinks counted as 0
	ModTs int64 `json:"modts,omitempty"` // newest mtime under it, else the branch tip's commit time (ms)

	Clearable bool   `json:"clearable,omitempty"`
	Skip      string `json:"skip,omitempty"` // StorageSkip_* for a Left over row Clear skips

	ClearState string `json:"clearstate,omitempty"` // StorageClear_*, set by a running or finished job
	ClearError string `json:"clearerror,omitempty"`
	ClearHeld  bool   `json:"clearheld,omitempty"` // a process holds it
}

type StorageScanError struct {
	ProjectName string `json:"projectname"`
	ProjectPath string `json:"projectpath"`
	Error       string `json:"error"`
}

type StorageClearFailure struct {
	Id    string `json:"id"`
	Path  string `json:"path,omitempty"`
	Error string `json:"error"`
	Held  bool   `json:"held,omitempty"`
}

type StorageClearResult struct {
	Ts      int64                 `json:"ts"`
	Cleared int                   `json:"cleared"`
	Freed   int64                 `json:"freed"`
	Failed  []StorageClearFailure `json:"failed,omitempty"`
}

type StorageReportData struct {
	ScanTs      int64               `json:"scants"` // when the result finished; 0 = never scanned
	Scanning    bool                `json:"scanning,omitempty"`
	ScanStartTs int64               `json:"scanstartts,omitempty"`
	Clearing    bool                `json:"clearing,omitempty"`
	ClearTotal  int                 `json:"cleartotal,omitempty"`
	ClearDone   int                 `json:"cleardone,omitempty"`
	Items       []StorageItem       `json:"items"`
	Errors      []StorageScanError  `json:"errors,omitempty"`
	LastClear   *StorageClearResult `json:"lastclear,omitempty"`
	JobError    string              `json:"joberror,omitempty"` // the last job failing as a whole
}

type CommandStorageClearData struct {
	Ids []string `json:"ids"`
}

type CommandStorageDeleteData struct {
	Id  string `json:"id"`
	Tip string `json:"tip"`
}
