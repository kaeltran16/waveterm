// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// MemHygieneCommands is the Setup surface's Memory tab: Arc checks each registered project's Claude
// Code auto memory (pkg/memhygiene), proposes changes with evidence, and applies only the accepted
// ones. These types are also the stored shape of a project's state file.
type MemHygieneCommands interface {
	ListMemoryHygieneCommand(ctx context.Context) (*CommandListMemoryHygieneRtnData, error)
	// starts a check and returns at once: a check runs model calls, which can't fit the rpc budget
	CheckMemoryHygieneCommand(ctx context.Context, data CommandCheckMemoryHygieneData) error
	DecideMemoryChangeCommand(ctx context.Context, data CommandDecideMemoryChangeData) (*MemHygieneProject, error)
	// applies a whole split or cleanup row, or one doc move, change by change
	ApplyMemoryRowCommand(ctx context.Context, data CommandApplyMemoryRowData) (*MemRowResult, error)
	UndoMemoryBatchCommand(ctx context.Context, data CommandUndoMemoryBatchData) (*MemHygieneProject, error)
}

const (
	MemVerdict_Apply  = "apply"
	MemVerdict_Keep   = "keep"
	MemVerdict_Undo   = "undo"
	MemVerdict_Reopen = "reopen"
)

const (
	MemBatch_Routine = "routine"
	MemBatch_Split   = "split"
	MemBatch_Cleanup = "cleanup"
	MemBatch_Doc     = "doc"
)

const (
	MemRow_Split   = "split"
	MemRow_Cleanup = "cleanup"
	MemRow_Doc     = "doc"
)

const (
	MemStop_Changed = "changed"
	MemStop_Newer   = "newer"
	MemStop_Failed  = "failed"
)

const (
	MemSkip_Changed = "changed"
	MemSkip_Overlap = "overlap"
	MemSkip_Failed  = "failed"
)

type CommandApplyMemoryRowData struct {
	Project  string `json:"project"`
	Row      string `json:"row"`      // MemRow_*
	ChangeId string `json:"changeid"` // MemRow_Doc only: the move to apply
}

// MemRowResult is how a row apply ended. A stopped apply stores no error: it comes back here.
type MemRowResult struct {
	Project MemHygieneProject `json:"project"`
	Stop    string            `json:"stop"`    // "" = done, else MemStop_*
	Here    int               `json:"here"`    // memories brought over
	Total   int               `json:"total"`   // memories to bring over (not left out)
	Changed int               `json:"changed"` // memories changed since the check
	Newer   int               `json:"newer"`   // memories newer than the check
	Failed  string            `json:"failed"`  // the change title that failed
	Error   string            `json:"error"`   // and why
}

type CommandUndoMemoryBatchData struct {
	Project  string `json:"project"`
	BatchId  string `json:"batchid"`
	ChangeId string `json:"changeid"` // "" = the whole batch
}

// MemBatch is a set of changes Arc applied together. Newest first on the project.
type MemBatch struct {
	Id          string        `json:"id"`
	Kind        string        `json:"kind"`        // MemBatch_*
	At          int64         `json:"at"`          // unix ms of its last apply
	ChangeIds   []string      `json:"changeids"`   // apply order
	Skipped     []MemSkip     `json:"skipped"`     // routine only
	IndexBefore MemIndexStats `json:"indexbefore"` // routine only: the index its changes edit
	IndexAfter  MemIndexStats `json:"indexafter"`
	UndoBlock   *MemUndoBlock `json:"undoblock,omitempty"` // filled by List, never stored
}

type MemSkip struct {
	ChangeId string `json:"changeid"`
	Kind     string `json:"kind"`
	Title    string `json:"title"`
	Reason   string `json:"reason"` // MemSkip_*
	Error    string `json:"error"`  // the apply's error, for MemSkip_Failed only
}

// MemUndoBlock names the cleanup batch that must be undone before a split batch can be.
type MemUndoBlock struct {
	Project  string `json:"project"`
	BatchId  string `json:"batchid"`
	At       int64  `json:"at"`
	Memories int    `json:"memories"`
}

type CommandListMemoryHygieneRtnData struct {
	Projects []MemHygieneProject `json:"projects"`
}

type CommandCheckMemoryHygieneData struct {
	Project string `json:"project"`
}

type CommandDecideMemoryChangeData struct {
	Project  string `json:"project"`
	ChangeId string `json:"changeid"`
	Verdict  string `json:"verdict"` // apply|keep|undo|reopen
}

type MemHygieneProject struct {
	Project      string         `json:"project"`
	Path         string         `json:"path"`
	CheckedAt    int64          `json:"checkedat"`   // unix ms; 0 = never checked
	NextCheckAt  int64          `json:"nextcheckat"` // unix ms, a week after the last attempt; 0 = never attempted
	Checking     bool           `json:"checking"`
	LastError    string         `json:"lasterror"` // the last failed check's reason; the last good result stays
	Memories     int            `json:"memories"`
	Sessions     int            `json:"sessions"`
	Folder       string         `json:"folder"`       // the memory folder its sessions load today
	SharedWith   []string       `json:"sharedwith"`   // other registered projects loading Folder; empty = its own
	OwnFolder    string         `json:"ownfolder"`    // split target; "" unless sharing or formerly sharing
	FormerShared string         `json:"formershared"` // the shared folder it loaded before switching over
	SwitchedAt   int64          `json:"switchedat"`
	Index        MemIndexStats  `json:"index"`              // Folder's MEMORY.md
	OwnIndex     *MemIndexStats `json:"ownindex,omitempty"` // OwnFolder's, during a split
	Changes      []MemChange    `json:"changes"`
	Batches      []MemBatch     `json:"batches,omitempty"` // newest first
}

type MemIndexStats struct {
	Exists bool `json:"exists"`
	Lines  int  `json:"lines"`
	Bytes  int  `json:"bytes"`
}

type MemChange struct {
	Id            string        `json:"id"`    // sha256 of kind + sorted file paths + their hashes; stable across checks
	Kind          string        `json:"kind"`  // delete|trim|merge|move-to-doc|add-to-index|move-here|copy-here|remove-shared|settings
	Group         string        `json:"group"` // ""|shared|own|switch (the split's three groups)
	Title         string        `json:"title"`
	Note          string        `json:"note"`
	ApplyLabel    string        `json:"applylabel"` // the rail button label
	Effect        string        `json:"effect"`     // the table cell
	Files         []MemFileRef  `json:"files"`      // every file the change touches, with sha256 at check time ("" = must not exist yet)
	Evidence      []MemEvidence `json:"evidence"`
	Diffs         []MemDiff     `json:"diffs"`
	IndexDelta    MemIndexDelta `json:"indexdelta"`    // effect on Folder's MEMORY.md
	OwnIndexDelta MemIndexDelta `json:"ownindexdelta"` // effect on OwnFolder's MEMORY.md
	Op            MemOp         `json:"op"`
	Status        string        `json:"status"`       // open|applied|kept|conflict
	ConflictFile  string        `json:"conflictfile"` // the file whose hash changed since the check
	DecidedAt     int64         `json:"decidedat"`
	BackupUntil   int64         `json:"backupuntil"`
	ApplyId       string        `json:"applyid"`
}

type MemFileRef struct {
	Path   string `json:"path"`
	Sha256 string `json:"sha256"`
}

type MemEvidence struct {
	Tone string `json:"tone"` // ok|warn|none
	Text string `json:"text"`
	Code string `json:"code"` // the monospace tail
}

type MemDiff struct {
	Path  string        `json:"path"`
	Note  string        `json:"note"`
	Lines []MemDiffLine `json:"lines"`
}

type MemDiffLine struct {
	Sign string `json:"sign"` // "-", "+" or " "
	Text string `json:"text"`
}

type MemIndexDelta struct {
	Lines int `json:"lines"`
	Bytes int `json:"bytes"`
}

// MemOp is what apply writes; folders are absolute.
type MemOp struct {
	Folder         string   `json:"folder"`      // the folder the memory files live in (the source, for split moves)
	Memories       []string `json:"memories"`    // memory file names in Folder the change acts on
	Old            string   `json:"old"`         // trim: the exact passage
	New            string   `json:"new"`         // trim: its replacement
	IndexRemove    []string `json:"indexremove"` // exact index lines removed from Folder's MEMORY.md
	IndexAdd       string   `json:"indexadd"`    // one index line added to IndexFolder's MEMORY.md
	IndexFolder    string   `json:"indexfolder"` // defaults to Folder
	WriteName      string   `json:"writename"`   // merge: the file written
	WriteBody      string   `json:"writebody"`
	DocPath        string   `json:"docpath"` // move-to-doc
	DocSection     string   `json:"docsection"`
	DocPassage     string   `json:"docpassage"`
	ToFolder       string   `json:"tofolder"`       // move-here / copy-here destination
	SettingsPath   string   `json:"settingspath"`   // settings: the file
	SettingsValue  string   `json:"settingsvalue"`  // settings: the autoMemoryDirectory value
	StripHarvester bool     `json:"stripharvester"` // add-to-index: drop source/source_hash/harvested_at
}
