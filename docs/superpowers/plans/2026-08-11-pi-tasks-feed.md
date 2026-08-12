# Pi Tasks Feed Implementation Plan (Workstream E)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only "Tasks" section in the Agent surface detail rail showing the pi-tasks records persisted under the agent's project (`.pi/tasks/*.json`).

**Architecture:** A tolerant Go scanner (`pkg/pitasks`) reads and aggregates pi-tasks store files; a new wshrpc domain (`TasksCommands`) exposes `GetTasksCommand(cwd)` over the existing reflection-dispatched RPC; the frontend loads it through a jotai store and renders a `CollapsibleRail` section in `agentdetailsrail.tsx`, with pure derive helpers in `pitasks.ts` for testability.

**Tech Stack:** Go (wavesrv/wshserver), wshrpc codegen (`task generate`), React 19 + jotai + Tailwind 4, vitest, Taskfile.

**Spec:** [`docs/superpowers/specs/2026-08-11-pi-tasks-feed-design.md`](../specs/2026-08-11-pi-tasks-feed-design.md). Read it before starting.

## Global Constraints

These apply to every task; each task's requirements implicitly include this section.

- **Generated files are never hand-edited** — `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`. Regenerate with `task generate` at the repo root.
- **Typecheck** (bare `npx tsc` stack-overflows on this repo; baseline is clean, exit 0):
  `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
- **Go builds of `pkg/wshrpc/...` need the CGO workaround** (sqlite-vec header; a POSIX path silently fails). From PowerShell at the repo root:
  `$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"`
  then `go build` / `go test`. `go test ./pkg/pitasks/...` has no CGO deps and needs nothing.
- **Git: no commits without explicit user approval** (AGENTS.md). Checkpoints use `git status` / `git diff`, never commits. One batched commit at the very end, only after approval.
- **No new `waveobj` type** → no SQL migration needed (PiTask is a wshrpc-only type).
- **Go files must pass `gofmt -l` (zero output)** — the code blocks in this plan use space indentation (markdownlint re-flow); `gofmt -w` the real files after writing.
- **Colors come from `@theme` tokens** (`frontend/tailwindsetup.css`), never raw hex in components.
- Status values on disk are only `pending | in_progress | completed`; `deleted` never persists (it removes the record from the JSON array).

---

### Task 1: `pkg/pitasks` scanner (Go, TDD)

**Files:**

- Create: `pkg/pitasks/pitasks.go`
- Test: `pkg/pitasks/pitasks_test.go`

**Interfaces:**

- Consumes: pi-tasks store files `<cwd>/.pi/tasks/*.json` shaped `{"nextId": number, "tasks": [Task]}`, where Task has `id, subject, description, status, activeForm?, owner?, metadata, blocks[], blockedBy[], createdAt, updatedAt` (persisted statuses only: `pending | in_progress | completed`).
- Produces (used by Task 2): `func Parse(data []byte) ([]Task, error)`, `func Read(cwd string) ([]Task, error)`, `type Task struct { ID, Subject, Description, Status, Owner string; Blocks, BlockedBy []string; CreatedAt, UpdatedAt int64 }`.

- [x] **Step 1: Write the failing tests**

`pkg/pitasks/pitasks_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package pitasks

import (
 "os"
 "path/filepath"
 "reflect"
 "testing"
)

func TestParseSkipsMalformedRecords(t *testing.T) {
 data := []byte(`{"nextId": 3, "tasks": [
  {"id": "1", "subject": "ok", "status": "pending"},
  {"id": "", "subject": "no id", "status": "pending"},
  {"id": "2", "subject": "bad status", "status": "shipped"},
  {"id": "3", "subject": "no status", "status": ""}
 ]}`)
 got, err := Parse(data)
 if err != nil {
  t.Fatalf("Parse returned error: %v", err)
 }
 want := []Task{{ID: "1", Subject: "ok", Status: "pending"}}
 if !reflect.DeepEqual(got, want) {
  t.Fatalf("got %+v, want %+v", got, want)
 }
}

func TestParseMalformedFile(t *testing.T) {
 if _, err := Parse([]byte("{not json")); err == nil {
  t.Fatal("expected error for malformed JSON")
 }
}

func TestReadMissingDir(t *testing.T) {
 got, err := Read(t.TempDir())
 if err != nil {
  t.Fatalf("Read returned error: %v", err)
 }
 if got != nil {
  t.Fatalf("expected nil, got %+v", got)
 }
}

func TestReadEmptyCwd(t *testing.T) {
 got, err := Read("")
 if err != nil {
  t.Fatalf("Read returned error: %v", err)
 }
 if got != nil {
  t.Fatalf("expected nil, got %+v", got)
 }
}

func TestReadAggregatesDedupesSorts(t *testing.T) {
 root := t.TempDir()
 dir := filepath.Join(root, ".pi", "tasks")
 if err := os.MkdirAll(dir, 0o755); err != nil {
  t.Fatal(err)
 }
 // project scope: two records, id "1" old
 writeFile(t, filepath.Join(dir, "tasks.json"), `{"nextId": 3, "tasks": [
  {"id": "1", "subject": "old", "status": "pending", "updatedAt": 100},
  {"id": "2", "subject": "done", "status": "completed", "updatedAt": 200}
 ]}`)
 // session scope: id "1" collides with a newer updatedAt; id "3" in_progress
 writeFile(t, filepath.Join(dir, "tasks-sess.json"), `{"nextId": 2, "tasks": [
  {"id": "1", "subject": "new", "status": "pending", "updatedAt": 300},
  {"id": "3", "subject": "active", "status": "in_progress", "updatedAt": 150}
 ]}`)
 // malformed file is skipped, not fatal
 writeFile(t, filepath.Join(dir, "broken.json"), "not json")

 got, err := Read(root)
 if err != nil {
  t.Fatalf("Read returned error: %v", err)
 }
 want := []Task{
  {ID: "3", Subject: "active", Status: "in_progress", UpdatedAt: 150},
  {ID: "1", Subject: "new", Status: "pending", UpdatedAt: 300},
  {ID: "2", Subject: "done", Status: "completed", UpdatedAt: 200},
 }
 if !reflect.DeepEqual(got, want) {
  t.Fatalf("got %+v, want %+v", got, want)
 }
}

func writeFile(t *testing.T, path, contents string) {
 t.Helper()
 if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
  t.Fatal(err)
 }
}
```

- [x] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/pitasks/...`
Expected: FAIL — package does not exist (`no Go files` / build error).

- [x] **Step 3: Write the implementation**

`pkg/pitasks/pitasks.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package pitasks is a read-only scanner for the @tintinweb/pi-tasks file store
// (<cwd>/.pi/tasks/*.json). It mirrors pkg/bgagents / pkg/agentsessions conventions:
// tolerant parsing — malformed records are skipped, a malformed file is skipped by the
// caller, a missing dir is a silent empty result. It never writes; pi-tasks lock-protects
// its own files.
package pitasks

import (
 "encoding/json"
 "fmt"
 "os"
 "path/filepath"
 "sort"
 "strings"
)

// statusRank orders pi-tasks' persisted statuses for display: in-flight first, done last.
// "deleted" is a tool-input status that removes the record from the store file; it never
// appears on disk (pi-tasks/src/index.ts:1200), so it is not part of the persisted set.
var statusRank = map[string]int{
 "in_progress": 0,
 "pending":     1,
 "completed":   2,
}

// Task is the persisted subset of a pi-tasks record (src/types.ts Task). Unknown fields
// are ignored; no write-back support.
type Task struct {
 ID          string
 Subject     string
 Description string
 Status      string
 Owner       string
 Blocks      []string
 BlockedBy   []string
 CreatedAt   int64 // UnixMilli
 UpdatedAt   int64 // UnixMilli
}

// Parse reads one pi-tasks store file ({ "nextId": n, "tasks": [...] }). Malformed records
// (no id, empty or unknown status) are skipped; a file that is not valid JSON at all
// returns an error so Read can skip the whole file.
func Parse(data []byte) ([]Task, error) {
 var f struct {
  Tasks []struct {
   ID          string   `json:"id"`
   Subject     string   `json:"subject"`
   Description string   `json:"description"`
   Status      string   `json:"status"`
   Owner       string   `json:"owner"`
   Blocks      []string `json:"blocks"`
   BlockedBy   []string `json:"blockedBy"`
   CreatedAt   int64    `json:"createdAt"`
   UpdatedAt   int64    `json:"updatedAt"`
  } `json:"tasks"`
 }
 if err := json.Unmarshal(data, &f); err != nil {
  return nil, fmt.Errorf("parsing pi-tasks store: %w", err)
 }
 out := make([]Task, 0, len(f.Tasks))
 for _, r := range f.Tasks {
  if r.ID == "" || r.Status == "" {
   continue
  }
  if _, ok := statusRank[r.Status]; !ok {
   continue // unknown status → not a record we can render
  }
  out = append(out, Task{
   ID:          r.ID,
   Subject:     r.Subject,
   Description: r.Description,
   Status:      r.Status,
   Owner:       r.Owner,
   Blocks:      r.Blocks,
   BlockedBy:   r.BlockedBy,
   CreatedAt:   r.CreatedAt,
   UpdatedAt:   r.UpdatedAt,
  })
 }
 return out, nil
}

// Read aggregates every *.json in <cwd>/.pi/tasks (session-scope tasks-<sessionId>.json
// files and the project-scope tasks.json). A missing dir or empty cwd yields (nil, nil) —
// the machine simply has no pi-tasks files, which must not error on every rail poll. Ids
// can collide across store files (each file has its own nextId sequence); the record with
// the highest UpdatedAt wins. Result is sorted by status order then UpdatedAt descending.
func Read(cwd string) ([]Task, error) {
 if cwd == "" {
  return nil, nil
 }
 dir := filepath.Join(cwd, ".pi", "tasks")
 entries, err := os.ReadDir(dir)
 if err != nil {
  if os.IsNotExist(err) {
   return nil, nil
  }
  return nil, fmt.Errorf("reading pi-tasks dir %s: %w", dir, err)
 }
 byID := make(map[string]Task)
 for _, e := range entries {
  if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
   continue
  }
  data, err := os.ReadFile(filepath.Join(dir, e.Name()))
  if err != nil {
   continue // unreadable → skip the file, keep the rest
  }
  tasks, err := Parse(data)
  if err != nil {
   continue // malformed file → skip it, keep the rest
  }
  for _, t := range tasks {
   if prev, ok := byID[t.ID]; ok && prev.UpdatedAt > t.UpdatedAt {
    continue // existing record is newer
   }
   byID[t.ID] = t
  }
 }
 out := make([]Task, 0, len(byID))
 for _, t := range byID {
  out = append(out, t)
 }
 sort.Slice(out, func(i, j int) bool {
  ri, rj := statusRank[out[i].Status], statusRank[out[j].Status]
  if ri != rj {
   return ri < rj
  }
  return out[i].UpdatedAt > out[j].UpdatedAt
 })
 return out, nil
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/pitasks/...`
Expected: PASS (4 tests).

- [x] **Step 5: Checkpoint — no commit**

Run: `git status --short`
Expected: `?? pkg/pitasks/` only from this task.

---

### Task 2: wshrpc domain + codegen

**Files:**

- Create: `pkg/wshrpc/wshrpctypes_tasks.go`
- Create: `pkg/wshrpc/wshserver/wshserver_tasks.go`
- Modify: `pkg/wshrpc/wshrpctypes.go` (embed `TasksCommands` in `WshRpcInterface`)
- Generated (never hand-edited): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**

- Consumes: `pitasks.Read(cwd)` / `pitasks.Task` from Task 1.
- Produces (used by Tasks 3–4): wshrpc `TasksCommands` interface with `GetTasksCommand(ctx, CommandGetTasksData) (*CommandGetTasksRtnData, error)`; route id `"gettasks"`; generated TS `RpcApi.GetTasksCommand(client, data, opts)` and ambient `PiTask` type in `frontend/types/gotypes.d.ts` with all-lowercase fields (`id, subject, description, status, owner, blocks, blockedby, createdat, updatedat`).

- [x] **Step 1: Write the wshrpc type domain**

`pkg/wshrpc/wshrpctypes_tasks.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

type TasksCommands interface {
 // GetTasksCommand lists the pi-tasks records persisted under <cwd>/.pi/tasks
 // (read-only mirror; empty cwd → empty result, no error).
 GetTasksCommand(ctx context.Context, data CommandGetTasksData) (*CommandGetTasksRtnData, error)
}

type CommandGetTasksData struct {
 Cwd string `json:"cwd"`
}

type CommandGetTasksRtnData struct {
 Tasks []PiTask `json:"tasks"`
}

// PiTask is the wshrpc mirror of pkg/pitasks.Task (persisted subset; no json tags, matching SessionInfo).
type PiTask struct {
 ID          string
 Subject     string
 Description string
 Status      string
 Owner       string
 Blocks      []string
 BlockedBy   []string
 CreatedAt   int64
 UpdatedAt   int64
}
```

- [x] **Step 2: Implement the wshserver command**

`pkg/wshrpc/wshserver/wshserver_tasks.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
 "context"
 "fmt"

 "github.com/wavetermdev/waveterm/pkg/pitasks"
 "github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func (ws *WshServer) GetTasksCommand(ctx context.Context, data wshrpc.CommandGetTasksData) (*wshrpc.CommandGetTasksRtnData, error) {
 tasks, err := pitasks.Read(data.Cwd)
 if err != nil {
  return nil, fmt.Errorf("reading pi-tasks: %w", err)
 }
 out := make([]wshrpc.PiTask, 0, len(tasks))
 for _, t := range tasks {
  out = append(out, wshrpc.PiTask{
   ID:          t.ID,
   Subject:     t.Subject,
   Description: t.Description,
   Status:      t.Status,
   Owner:       t.Owner,
   Blocks:      t.Blocks,
   BlockedBy:   t.BlockedBy,
   CreatedAt:   t.CreatedAt,
   UpdatedAt:   t.UpdatedAt,
  })
 }
 return &wshrpc.CommandGetTasksRtnData{Tasks: out}, nil
}
```

- [x] **Step 3: Embed the domain in WshRpcInterface**

`pkg/wshrpc/wshrpctypes.go` — add `TasksCommands` to the interface body, after `AskCommands`:

```go
 AskCommands
 TasksCommands
 WshRpcRemoteFileInterface
 WshRpcFileInterface
```

- [x] **Step 4: Regenerate bindings**

Run: `task generate` (repo root).
Then inspect `git status --short` — expected new/changed: the three task files above plus the three generated files. If anything else changed, stop and report (do not commit).

- [x] **Step 5: Verify generated artifacts**

- `grep -n "GetTasksCommand" pkg/wshrpc/wshclient/wshclient.go` → expect a function calling route `"gettasks"`.
- `grep -n "GetTasksCommand" frontend/app/store/wshclientapi.ts` → expect `RpcApi.GetTasksCommand(client, data, opts)`.
- `grep -n "type PiTask" frontend/types/gotypes.d.ts` → confirm the lowercase field names (`updatedat`, `blockedby`).

- [x] **Step 6: Build + typecheck**

From PowerShell at repo root:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go build ./pkg/wshrpc/... ./pkg/wshclient/...
```

Expected: exit 0, no output.
Then typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — expected exit 0.

- [x] **Step 7: Checkpoint — no commit**

Run: `git status --short`
Expected: exactly the files listed in Step 4. Report if anything else changed.

---

### Task 3: FE derive helpers + store (TDD)

**Files:**

- Create: `frontend/app/view/agents/pitasks.ts`
- Create: `frontend/app/view/agents/pitasks.test.ts`
- Create: `frontend/app/view/agents/pitasksstore.ts`

**Interfaces:**

- Consumes: generated ambient `PiTask` type (Task 2), `resolveCwd(transcriptPath, blockId): Promise<string | null>` from `./agentcwdresolve`, `RpcApi.GetTasksCommand` / `TabRpcClient` from `@/app/store/wshclientapi` and `@/app/store/wshrpcutil`.
- Produces (used by Task 4): `groupTasks(tasks): TaskGroup[]`, `capTasks(groups, cap): { groups, more }`, `edgeSummary(t): string | null`, `tasksAtom`, `loadTasksForAgent(id, transcriptPath, blockId?)`.

- [x] **Step 1: Write the failing derive tests**

`frontend/app/view/agents/pitasks.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { capTasks, edgeSummary, groupTasks } from "./pitasks";

const task = (id: string, status: string, updatedat: number, extra?: Partial<PiTask>): PiTask => ({
  id,
  status,
  subject: `task ${id}`,
  description: "",
  owner: "",
  blocks: [],
  blockedby: [],
  createdat: updatedat,
  updatedat,
  ...extra,
});

describe("groupTasks", () => {
  it("buckets by status in display order, updatedAt desc within group", () => {
    const groups = groupTasks([
      task("1", "pending", 100),
      task("2", "in_progress", 300),
      task("3", "completed", 200),
      task("4", "pending", 150),
    ]);
    expect(groups.map((g) => g.status)).toEqual(["in_progress", "pending", "completed"]);
    expect(groups[1].tasks.map((t) => t.id)).toEqual(["4", "1"]);
  });

  it("drops unknown statuses and empty groups", () => {
    expect(groupTasks([task("1", "shipped", 100)])).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(groupTasks([])).toEqual([]);
  });
});

describe("capTasks", () => {
  it("keeps the first cap rows and counts the rest", () => {
    const groups = groupTasks([task("1", "pending", 100), task("2", "pending", 200), task("3", "pending", 300)]);
    const { groups: kept, more } = capTasks(groups, 2);
    expect(more).toBe(1);
    expect(kept.flatMap((g) => g.tasks).length).toBe(2);
  });

  it("no more when under cap", () => {
    const { groups: kept, more } = capTasks(groupTasks([task("1", "pending", 100)]), 8);
    expect(more).toBe(0);
    expect(kept.flatMap((g) => g.tasks).length).toBe(1);
  });
});

describe("edgeSummary", () => {
  it("null when no edges", () => {
    expect(edgeSummary(task("1", "pending", 100))).toBeNull();
  });

  it("renders counts for blocks and blockedBy", () => {
    expect(edgeSummary(task("1", "pending", 100, { blocks: ["a"], blockedby: ["b", "c"] }))).toBe(
      "blocks 1 · blocked by 2"
    );
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/pitasks.test.ts`
Expected: FAIL — module not found (`./pitasks`).

- [x] **Step 3: Write the derive helpers**

`frontend/app/view/agents/pitasks.ts`:

```ts
// frontend/app/view/agents/pitasks.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure derive helpers for the rail's Tasks section. Rendering stays in agentdetailsrail.tsx;
// everything testable lives here (repo convention: testable logic extracted, not rendered).

export const TASK_STATUS_ORDER = ["in_progress", "pending", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUS_ORDER)[number];

export interface TaskGroup {
  status: TaskStatus;
  tasks: PiTask[]; // sorted updatedAt desc
}

// groupTasks buckets by status in display order, discarding unknown statuses (the backend
// already filters; this is belt-and-braces for hand-edited files).
export function groupTasks(tasks: PiTask[]): TaskGroup[] {
  const byStatus = new Map<TaskStatus, PiTask[]>();
  for (const t of tasks) {
    if (!TASK_STATUS_ORDER.includes(t.status as TaskStatus)) {
      continue;
    }
    const s = t.status as TaskStatus;
    const group = byStatus.get(s) ?? [];
    group.push(t);
    byStatus.set(s, group);
  }
  return TASK_STATUS_ORDER.filter((s) => (byStatus.get(s)?.length ?? 0) > 0).map((s) => ({
    status: s,
    tasks: (byStatus.get(s) ?? []).sort((a, b) => b.updatedat - a.updatedat),
  }));
}

// capTasks flattens groups in order and keeps the first `cap` rows; the rest are reported as
// `more` so the rail can render a single "+N more" row (RailFilesCap-style). Completed rows
// sort last, so the cap naturally cuts them first.
export function capTasks(groups: TaskGroup[], cap: number): { groups: TaskGroup[]; more: number } {
  const kept: TaskGroup[] = [];
  let budget = cap;
  let more = 0;
  for (const g of groups) {
    if (budget <= 0) {
      more += g.tasks.length;
      continue;
    }
    const take = Math.min(g.tasks.length, budget);
    kept.push({ status: g.status, tasks: g.tasks.slice(0, take) });
    budget -= take;
    more += g.tasks.length - take;
  }
  return { groups: kept, more };
}

// edgeSummary renders dependency edges as one muted line ("blocks 2 · blocked by 1") or null
// when there are none — ids are internal, counts are all the rail needs.
export function edgeSummary(t: PiTask): string | null {
  const parts: string[] = [];
  if (t.blocks.length > 0) {
    parts.push(`blocks ${t.blocks.length}`);
  }
  if (t.blockedby.length > 0) {
    parts.push(`blocked by ${t.blockedby.length}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/pitasks.test.ts`
Expected: PASS (8 tests).

- [x] **Step 5: Write the store**

`frontend/app/view/agents/pitasksstore.ts`:

```ts
// frontend/app/view/agents/pitasksstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Read-only pi-tasks mirror for the agent detail rail. Mirrors recentsessionsstore.ts (a
// single atom for the focused agent; null = not loaded, [] = loaded-empty) and
// railstore.ts loadRailForAgent (cwd resolution + stale-focus guard).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { resolveCwd } from "./agentcwdresolve";

export const tasksAtom = atom<PiTask[] | null>(null) as PrimitiveAtom<PiTask[] | null>;

// guards against a stale focus's load overwriting a newer one (same pattern as railstore.ts)
const current = { id: "" };

export async function loadTasksForAgent(
  id: string,
  transcriptPath: string | undefined,
  blockId?: string
): Promise<void> {
  current.id = id;
  globalStore.set(tasksAtom, null);
  const cwd = await resolveCwd(transcriptPath, blockId);
  if (current.id !== id) {
    return;
  }
  if (!cwd) {
    globalStore.set(tasksAtom, []);
    return;
  }
  try {
    const rtn = await RpcApi.GetTasksCommand(TabRpcClient, { cwd });
    if (current.id !== id) {
      return;
    }
    globalStore.set(tasksAtom, rtn.tasks ?? []);
  } catch {
    if (current.id === id) {
      globalStore.set(tasksAtom, []); // scan failure -> empty, never breaks the rail
    }
  }
}
```

- [x] **Step 6: Typecheck + lint the new files**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — expected exit 0.
Run: `npx prettier --check frontend/app/view/agents/pitasks.ts frontend/app/view/agents/pitasks.test.ts frontend/app/view/agents/pitasksstore.ts`
Expected: all checked, no diff (run `npx prettier --write` on the three files if it flags formatting, then re-check).

- [x] **Step 7: Checkpoint — no commit**

Run: `git status --short` — confirm only the three new files plus Task 1–2 files are present.

---

### Task 4: Rail section + compaction

**Files:**

- Modify: `frontend/app/view/agents/agentdetailsrail.tsx`
- Modify: `frontend/app/view/agents/railicons.tsx`

**Interfaces:**

- Consumes: `tasksAtom`, `loadTasksForAgent` (Task 3), `groupTasks`, `capTasks`, `edgeSummary` (Task 3), `RAIL_ICON` (`frontend/app/view/agents/railicons.tsx`), `CollapsibleRail` / `RailSection` (`@/app/element/collapsiblerail`), `formatAge` (already imported in the file).

- [x] **Step 1: Add the tasks icon**

`frontend/app/view/agents/railicons.tsx` — add `ListTodo` to the lucide import and a `tasks` entry:

```tsx
import {
  BarChart3,
  Bell,
  Coins,
  Diamond,
  FileText,
  Folder,
  GitBranch,
  Info,
  ListTodo,
  Settings,
  Users,
  Wrench,
} from "lucide-react";
```

```tsx
    files: <FileText {...iconProps} />,
    tasks: <ListTodo {...iconProps} />,
```

Verify the export exists: `grep -n "ListTodo" node_modules/lucide-react/dist/lucide-react.d.ts` — if absent, use `CheckSquare` instead (same grep check).

- [x] **Step 2: Wire the store into the rail**

`frontend/app/view/agents/agentdetailsrail.tsx`:

- Add imports next to the existing store imports:

```tsx
import { capTasks, edgeSummary, groupTasks } from "./pitasks";
import { loadTasksForAgent, tasksAtom } from "./pitasksstore";
```

- Add the atom read next to the existing `useAtomValue` calls:

```tsx
const tasks = useAtomValue(tasksAtom);
```

- In the existing `useEffect`, add the focus load next to `loadSessionUsage`:

```tsx
fireAndForget(() => loadTasksForAgent(agent.id, agent.transcriptPath, agent.blockId));
```

- Extend the existing 15s refresh interval so it refreshes tasks too:

```tsx
const refresh = setInterval(() => {
  fireAndForget(() => loadSessionUsage(agent.id, agent.transcriptPath, { silent: true }));
  fireAndForget(() => loadTasksForAgent(agent.id, agent.transcriptPath, agent.blockId));
}, 15_000);
```

- [x] **Step 3: Compact the Details section**

Same file. Change `DetailRow` padding `py-[8px]` → `py-[5px]`:

```tsx
        <div className="flex items-baseline justify-between border-b border-edge-faint py-[5px] last:border-b-0">
```

Merge the "Running" row into the "Runtime" row (remove the standalone `Running` `DetailRow`):

```tsx
<DetailRow
  label="Runtime"
  value={
    <span className="inline-flex items-center gap-[5px]">
      <span className={cn("inline-flex items-center gap-[5px] font-semibold", rt.text)}>
        <RuntimeMark runtime={agent.agent} className="text-[11px]" />
        {rt.label}
      </span>
      <span className="text-muted">· {running}</span>
    </span>
  }
/>
```

The `running` const stays defined (it is now consumed above); the `Runtime` row keeps `rt.text` coloring on the runtime part only.

- [x] **Step 4: Add the Tasks section**

Same file. Insert after the "files" section object (after its closing `},`) and before the `];` that ends `sections`:

```tsx
        ...(tasks != null && tasks.length > 0
            ? [
                  {
                      id: "tasks",
                      label: "Tasks",
                      icon: RAIL_ICON.tasks,
                      content: <TasksSection tasks={tasks} now={now} />,
                  } as RailSection,
              ]
            : []),
```

Add the `TaskCap` constant and the `TasksSection` component at the bottom of the file, next to the other small components:

```tsx
const TaskCap = 8; // a 296px rail can't show a large backlog; overflow folds into "+N more"

function TasksSection({ tasks, now }: { tasks: PiTask[]; now: number }) {
  const { groups, more } = capTasks(groupTasks(tasks), TaskCap);
  return (
    <div>
      <div className="mb-[11px]">
        <SectionLabel>Tasks</SectionLabel>
      </div>
      <div className="flex flex-col gap-[7px]">
        {groups.map((g) =>
          g.tasks.map((t) => {
            const edges = edgeSummary(t);
            return (
              <div
                key={t.id}
                className="flex items-center gap-[10px] rounded-[10px] border border-border bg-surface px-[11px] py-[9px]"
              >
                <span
                  className={cn(
                    "h-[6px] w-[6px] shrink-0 rounded-full",
                    t.status === "in_progress" ? "bg-accent" : t.status === "pending" ? "bg-warning" : "bg-success"
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11.5px] font-semibold text-secondary">{t.subject}</div>
                  {edges != null ? <div className="truncate text-[10px] text-muted">{edges}</div> : null}
                </div>
                <span className="whitespace-nowrap font-mono text-[9.5px] font-medium text-muted">
                  {formatAge(now - t.updatedat)}
                </span>
              </div>
            );
          })
        )}
        {more > 0 ? <div className="px-[5px] py-[3px] text-[11px] text-muted">+{more} more</div> : null}
      </div>
    </div>
  );
}
```

`now` is already available in `AgentDetailsRail` (`useAtomValue(model.nowAtom)`); pass it through.

- [x] **Step 5: Typecheck + format check**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — expected exit 0.
Run: `npx prettier --check frontend/app/view/agents/agentdetailsrail.tsx frontend/app/view/agents/railicons.tsx` — fix with `--write` if flagged, then re-check.

- [ ] **Step 6: Render smoke** — SKIPPED BY DECISION (2026-08-12): user opted to skip CDP verification for this workstream. Surface-smoke will be re-run as part of the next full cockpit pass.

Run: `task verify:ui -- surface-smoke`
Expected: PASS (the cockpit boots and renders; the new section is conditional, so it cannot break the smoke).

- [ ] **Step 7: Visual verification (CDP)** — SKIPPED BY DECISION (2026-08-12): requires `task dev` + a launched agent whose cwd resolves to the fixture project; user opted to skip. The fixture setup below is retained for a future pass.

The repo has no jsdom render tests — verify the rendered rail against the live dev app:

1. Create a fixture project:

   ```bash
   mkdir -p /tmp/pitask-demo/.pi/tasks
   cat > /tmp/pitask-demo/.pi/tasks/tasks.json <<'EOF'
   {"nextId": 3, "tasks": [
     {"id": "1", "subject": "Ship the tasks feed", "description": "", "status": "in_progress", "blocks": ["2"], "blockedBy": [], "createdAt": 1750000000000, "updatedAt": 1755000000000},
     {"id": "2", "subject": "Review the PR", "description": "", "status": "pending", "blocks": [], "blockedBy": ["1"], "createdAt": 1750000000000, "updatedAt": 1754000000000},
     {"id": "3", "subject": "Retro notes", "description": "", "status": "completed", "blocks": [], "blockedBy": [], "createdAt": 1740000000000, "updatedAt": 1749000000000}
   ]}
   EOF
   ```

2. Start the dev app (`task dev`), launch or focus an agent whose cwd resolves to `/tmp/pitask-demo`, open the rail (it is off by default — toggle it).
3. Capture: `node scripts/cdp-shot.mjs out.png` — visually confirm the Tasks section (dot colors, subject, `blocks 1 · blocked by 1`, age, `+N more` absent), and that the Details section rows are denser with Runtime showing `· idle/running`.

If the dev app cannot run in this environment, do NOT claim visual verification — report the gap explicitly and leave Step 7 as the recorded next action.

- [x] **Step 8: Checkpoint — no commit**

Run: `git status --short` — confirm only the expected files changed.

---

### Task 5: Full verification + diff review

- [x] **Step 1: Run the full verification suite**

- `go test ./pkg/pitasks/...` — PASS.
- PowerShell CGO build (same env var as Task 2): `go build ./pkg/wshrpc/... ./pkg/wshclient/...` — exit 0.
- `npx vitest run frontend/app/view/agents/pitasks.test.ts` — PASS.
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — exit 0.
- `npx prettier --check` on every changed file — clean.
- `task verify:ui -- surface-smoke` — SKIPPED (no dev app running on :9222; needs `task dev` up before it can attach)

- [x] **Step 2: Self-review the diff**

`git status` + `git diff --stat`. Check: no commented-out code, no debug statements, no stray changes outside the files listed in Tasks 1–4 plus the generated files, spec, and this plan. Confirm the generated files contain only additive changes (new `GetTasksCommand` / `PiTask`).

- [x] **Step 3: Present for approval — do not commit**

Summarize the changed files and the verification results. Per AGENTS.md, commits require explicit user approval; when approved, create ONE commit (spec + plan fold in):

```bash
git add pkg/pitasks/ pkg/wshrpc/wshrpctypes_tasks.go pkg/wshrpc/wshserver/wshserver_tasks.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts frontend/app/view/agents/pitasks.ts frontend/app/view/agents/pitasks.test.ts frontend/app/view/agents/pitasksstore.ts frontend/app/view/agents/agentdetailsrail.tsx frontend/app/view/agents/railicons.tsx docs/superpowers/specs/2026-08-11-pi-tasks-feed-design.md docs/superpowers/plans/2026-08-11-pi-tasks-feed.md
git commit -m "feat: pi-tasks feed in the agent detail rail (workstream E)"
```
