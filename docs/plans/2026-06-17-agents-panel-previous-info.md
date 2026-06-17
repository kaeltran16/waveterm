# Agents Panel — Previous-Info Projection (Plan 2 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an agent's "previous info" real — read its Claude Code transcript JSONL in-repo and project it into the `AgentEntry[]` the view already renders.

**Architecture:** Two links (spec §10.1, RESOLVED). (1) The out-of-repo reporter forwards `transcript_path` to Wave via a new `--transcript` flag on `wsh agentstatus`, carried as `AgentStatusData.TranscriptPath` and stored per-block by `agentstatusstore.ts` (no store change). (2) A new `GetAgentTranscriptCommand` RPC tail-reads the file by path and returns raw JSONL lines; a pure, vitest-tested TS module `projectTranscript(lines) → AgentEntry[]` does the projection. A thin `fetchPreviousInfo(path)` helper composes RPC + projection — the exact call Plan 3 makes when an asking card renders. **No UI changes this plan** (the visible asking-card display lands in Plan 3).

**Tech Stack:** Go (wshrpc), TypeScript/React, vitest, Go testing.

**Source of truth:** spec `docs/specs/2026-06-17-agents-panel-design.md` §5.3 (projection), §10.1 (resolved approach), §7 (transcript-unreadable path). Render contract `AgentEntry` is defined in `frontend/app/view/agents/agentsviewmodel.ts` (Plan 1) and is **unchanged** here.

**Transcript shape (verified against a real `~/.claude/projects/<enc>/<sessionId>.jsonl`):**
- `assistant` records → `.message.content[]` blocks of `thinking` (skip) / `text` / `tool_use` (`id`, `name`, `input`).
- `user` records → `.message.content[]` blocks of `tool_result` (`tool_use_id`, `is_error` — usually `null`/`false` on success, `true` on failure).
- Other record types (`ai-title`, `mode`, `last-prompt`, `attachment`, `file-history-snapshot`, `system`) → ignored.

**Scope note:** Plan 2 of 3. In scope: path plumbing, the Go read RPC, the pure projection (+ tests), the `fetchPreviousInfo` seam. Out of scope (Plan 3): the live asking-card display, `ask_human` channel, answer routing, idle peek.

---

## File Structure

**Create:**
- `pkg/wshrpc/wshserver/transcript.go` — `readTranscriptTail(path, maxLines) ([]string, error)`: file read + in-memory tail. Mirrors `sessiongroup.go` (logic beside the thin RPC method).
- `pkg/wshrpc/wshserver/transcript_test.go` — Go table test for `readTranscriptTail`.
- `frontend/app/view/agents/transcriptprojection.ts` — pure `projectTranscript(lines) → AgentEntry[]` + the tool→verb map. No React, no Wave runtime imports (mirrors `agentsviewmodel.ts`).
- `frontend/app/view/agents/transcriptprojection.test.ts` — vitest, fixture lines inline.
- `frontend/app/view/agents/previousinfo.ts` — `fetchPreviousInfo(transcriptPath)`: RPC + projection glue (the Plan 3 entry point).

**Modify:**
- `pkg/baseds/baseds.go` — add `TranscriptPath` to `AgentStatusData`.
- `cmd/wsh/cmd/wshcmd-agentstatus.go` — add the `--transcript` flag and set the field.
- `pkg/wshrpc/wshrpctypes.go` — add `GetAgentTranscriptCommand` + request/response types.
- `pkg/wshrpc/wshserver/wshserver.go` — implement the command (thin wrapper over `readTranscriptTail`).

---

### Task 1: Plumb the transcript path through `agentstatus`

**Files:**
- Modify: `pkg/baseds/baseds.go`
- Modify: `cmd/wsh/cmd/wshcmd-agentstatus.go`

- [ ] **Step 1: Add the field to `AgentStatusData`**

In `pkg/baseds/baseds.go`, add to the `AgentStatusData` struct after `Model`:

```go
	Model          string              `json:"model,omitempty"`
	TranscriptPath string              `json:"transcriptpath,omitempty"`
```

- [ ] **Step 2: Add the `--transcript` flag**

In `cmd/wsh/cmd/wshcmd-agentstatus.go`, add to the `var ( … )` block with the other `agentStatus*` strings:

```go
	agentStatusTranscript string
```

In `init()`, register the flag (next to the `--model` flag registration):

```go
	agentStatusCmd.Flags().StringVar(&agentStatusTranscript, "transcript", "", "path to the agent's transcript JSONL (for previous-info projection)")
```

- [ ] **Step 3: Set the field on the published event**

In `agentStatusRun`, add `TranscriptPath` to the `baseds.AgentStatusData{ … }` literal (the state-update one, not the subagent one):

```go
	eventData := baseds.AgentStatusData{
		ORef:           oref.String(),
		State:          agentStatusState,
		Detail:         agentStatusDetail,
		Agent:          agentStatusAgent,
		Model:          agentStatusModel,
		TranscriptPath: agentStatusTranscript,
		Ts:             time.Now().UnixMilli(),
	}
```

- [ ] **Step 4: Regenerate TypeScript types**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` `AgentStatusData` gains `transcriptpath?: string;`. (`agentstatusstore.ts` already stores the whole `AgentStatusData`, so the path rides along — no store change.)

- [ ] **Step 5: Verify the generated field**

Run: `npx tsc --noEmit`
Expected: no new errors. Confirm `transcriptpath` is present in `gotypes.d.ts` (grep it). No Go errors reported by VSCode for the two edited files.

- [ ] **Step 6: Commit**

```bash
git add pkg/baseds/baseds.go cmd/wsh/cmd/wshcmd-agentstatus.go frontend/types/gotypes.d.ts
git commit -m "feat(agents): carry transcript path on agentstatus events"
```

---

### Task 2: Go transcript tail-read

**Files:**
- Create: `pkg/wshrpc/wshserver/transcript.go`
- Test: `pkg/wshrpc/wshserver/transcript_test.go`

- [ ] **Step 1: Write the failing test**

```go
// pkg/wshrpc/wshserver/transcript_test.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadTranscriptTail(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.jsonl")
	// blank line in the middle must be skipped
	if err := os.WriteFile(path, []byte("a\n\nb\nc\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	all, err := readTranscriptTail(path, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("want 3 non-empty lines, got %d (%v)", len(all), all)
	}

	tail, err := readTranscriptTail(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 2 || tail[0] != "b" || tail[1] != "c" {
		t.Fatalf("want [b c], got %v", tail)
	}

	if _, err := readTranscriptTail(filepath.Join(dir, "nope.jsonl"), 0); err == nil {
		t.Fatal("expected error for missing file")
	}
	if _, err := readTranscriptTail("", 0); err == nil {
		t.Fatal("expected error for empty path")
	}
	if _, err := readTranscriptTail(dir, 0); err == nil {
		t.Fatal("expected error when path is a directory")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (from project root): `go test ./pkg/wshrpc/wshserver/ -run TestReadTranscriptTail -v`
Expected: FAIL — `undefined: readTranscriptTail`.

- [ ] **Step 3: Write minimal implementation**

```go
// pkg/wshrpc/wshserver/transcript.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"fmt"
	"os"
	"strings"
)

const defaultTranscriptTailLines = 200

// readTranscriptTail returns the last maxLines non-empty lines of the JSONL transcript at path.
// The whole file is read then tailed in memory; session transcripts are MB-scale at most, so this
// stays simple (KISS) — switch to a seek-from-end read only if a real file proves too large.
func readTranscriptTail(path string, maxLines int) ([]string, error) {
	if path == "" {
		return nil, fmt.Errorf("transcript path is required")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("stat transcript: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("transcript path is a directory: %s", path)
	}
	if maxLines <= 0 {
		maxLines = defaultTranscriptTailLines
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read transcript: %w", err)
	}
	var lines []string
	for _, ln := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(ln) == "" {
			continue
		}
		lines = append(lines, ln)
	}
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return lines, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from project root): `go test ./pkg/wshrpc/wshserver/ -run TestReadTranscriptTail -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshserver/transcript.go pkg/wshrpc/wshserver/transcript_test.go
git commit -m "feat(agents): tail-read agent transcript JSONL"
```

---

### Task 3: `GetAgentTranscript` RPC

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`

- [ ] **Step 1: Add the command to the interface**

In `pkg/wshrpc/wshrpctypes.go`, add to `WshRpcInterface` next to `GetSessionGroupCommand`:

```go
	GetAgentTranscriptCommand(ctx context.Context, data CommandGetAgentTranscriptData) (*CommandGetAgentTranscriptRtnData, error)
```

- [ ] **Step 2: Define the request/response types**

In `pkg/wshrpc/wshrpctypes.go`, add near `CommandGetSessionGroupData`:

```go
type CommandGetAgentTranscriptData struct {
	Path     string `json:"path"`
	MaxLines int    `json:"maxlines,omitempty"`
}

type CommandGetAgentTranscriptRtnData struct {
	Lines []string `json:"lines"`
}
```

- [ ] **Step 3: Regenerate bindings**

Run: `task generate`
Expected: `frontend/app/store/wshclientapi.ts` gains `GetAgentTranscriptCommand`; `gotypes.d.ts` gains both new types. (Do not hand-edit generated files.)

- [ ] **Step 4: Implement the command**

In `pkg/wshrpc/wshserver/wshserver.go`, add after `GetSessionGroupCommand`:

```go
func (ws *WshServer) GetAgentTranscriptCommand(ctx context.Context, data wshrpc.CommandGetAgentTranscriptData) (*wshrpc.CommandGetAgentTranscriptRtnData, error) {
	lines, err := readTranscriptTail(data.Path, data.MaxLines)
	if err != nil {
		return nil, fmt.Errorf("reading agent transcript: %w", err)
	}
	return &wshrpc.CommandGetAgentTranscriptRtnData{Lines: lines}, nil
}
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no new errors. VSCode reports no Go errors (the `WshServer` now satisfies the extended interface; `fmt` is already imported in `wshserver.go`).

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(agents): GetAgentTranscript RPC"
```

---

### Task 4: Pure transcript projection

**Files:**
- Create: `frontend/app/view/agents/transcriptprojection.ts`
- Test: `frontend/app/view/agents/transcriptprojection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/app/view/agents/transcriptprojection.test.ts
import { describe, expect, it } from "vitest";
import { projectTranscript } from "./transcriptprojection";

const LINES: string[] = [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "fix the race" }] } }), // human prompt -> skipped
    JSON.stringify({
        type: "assistant",
        message: {
            content: [
                { type: "thinking", thinking: "let me look" }, // skipped
                { type: "text", text: "The clone re-reads the source block by id, so a stale id slips through." },
                { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/home/u/proj/sessionmodel.go" } },
            ],
        },
    }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } }), // edited, non-ran -> no outcome
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "go test ./...", description: "go test ./..." } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true }] } }), // ran + error -> fail
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { description: "go build" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", is_error: false }] } }), // ran + success -> ok
    "{ not valid json", // skipped
    JSON.stringify({ type: "file-history-snapshot", foo: 1 }), // unknown type -> ignored
];

describe("projectTranscript", () => {
    it("projects messages, actions, and outcomes in order", () => {
        expect(projectTranscript(LINES)).toEqual([
            { kind: "message", text: "The clone re-reads the source block by id, so a stale id slips through." },
            { kind: "action", verb: "edited", target: "sessionmodel.go" },
            { kind: "action", verb: "ran", target: "go test ./...", outcome: "fail" },
            { kind: "action", verb: "ran", target: "go build", outcome: "ok" },
        ]);
    });

    it("returns [] for empty input and skips unparseable lines", () => {
        expect(projectTranscript([])).toEqual([]);
        expect(projectTranscript(["garbage", "{bad"])).toEqual([]);
    });

    it("maps unknown tools to a lowercased verb and the salient input", () => {
        const out = projectTranscript([
            JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "WebFetch", input: { pattern: "abc" } }] } }),
        ]);
        expect(out).toEqual([{ kind: "action", verb: "webfetch", target: "abc" }]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts`
Expected: FAIL — cannot resolve `./transcriptprojection` / `projectTranscript is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/app/view/agents/transcriptprojection.ts
// Pure projection of a Claude Code transcript (JSONL lines) into AgentEntry[].
// No React, no Wave runtime imports. Deterministic; no LLM (spec §5.3).

import type { AgentEntry } from "./agentsviewmodel";

const VERB_BY_TOOL: Record<string, string> = {
    Read: "read",
    Edit: "edited",
    Write: "wrote",
    Bash: "ran",
    Grep: "grep",
    Glob: "glob",
    Task: "spawned",
};

function verbFor(name: string): string {
    return VERB_BY_TOOL[name] ?? name.toLowerCase();
}

function baseName(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] || p;
}

// the most salient input field, in priority order
function targetFor(input: any): string {
    if (input == null) {
        return "";
    }
    if (typeof input.file_path === "string") {
        return baseName(input.file_path);
    }
    if (typeof input.pattern === "string") {
        return input.pattern;
    }
    if (typeof input.description === "string") {
        return input.description;
    }
    if (typeof input.command === "string") {
        return input.command;
    }
    return "";
}

type ActionEntry = AgentEntry & { kind: "action" };

/** Pure: project transcript JSONL lines into ordered previous-info entries.
 *  assistant text -> message; tool_use -> action; tool_result -> outcome on the matching
 *  action (fail on error; ok only for "ran", to avoid a checkmark on every read/edit).
 *  Unparseable lines and unknown record types are skipped. */
export function projectTranscript(lines: string[]): AgentEntry[] {
    const entries: AgentEntry[] = [];
    const actionById = new Map<string, ActionEntry>();
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        const content = rec?.message?.content;
        if (!Array.isArray(content)) {
            continue;
        }
        if (rec.type === "assistant") {
            for (const block of content) {
                if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
                    entries.push({ kind: "message", text: block.text });
                    continue;
                }
                if (block?.type === "tool_use" && typeof block.name === "string") {
                    const action: ActionEntry = { kind: "action", verb: verbFor(block.name), target: targetFor(block.input) };
                    entries.push(action);
                    if (typeof block.id === "string") {
                        actionById.set(block.id, action);
                    }
                }
            }
            continue;
        }
        if (rec.type === "user") {
            for (const block of content) {
                if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {
                    continue;
                }
                const action = actionById.get(block.tool_use_id);
                if (action == null) {
                    continue;
                }
                if (block.is_error === true) {
                    action.outcome = "fail";
                } else if (action.verb === "ran") {
                    action.outcome = "ok";
                }
            }
        }
    }
    return entries;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/transcriptprojection.ts frontend/app/view/agents/transcriptprojection.test.ts
git commit -m "feat(agents): pure transcript->previous-info projection"
```

---

### Task 5: `fetchPreviousInfo` seam (RPC + projection)

**Files:**
- Create: `frontend/app/view/agents/previousinfo.ts`

- [ ] **Step 1: Write the helper**

```ts
// frontend/app/view/agents/previousinfo.ts
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { AgentEntry } from "./agentsviewmodel";
import { projectTranscript } from "./transcriptprojection";

const DEFAULT_TAIL_LINES = 300;

// Fetch + project an agent's recent transcript into previous-info entries. On any read failure
// returns [] (spec §7: render the question alone). Plan 3 calls this when an asking card renders,
// passing AgentStatusData.transcriptpath (carried since Task 1).
export async function fetchPreviousInfo(transcriptPath: string, maxLines = DEFAULT_TAIL_LINES): Promise<AgentEntry[]> {
    if (!transcriptPath) {
        return [];
    }
    try {
        const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: transcriptPath, maxlines: maxLines });
        return projectTranscript(rtn?.lines ?? []);
    } catch {
        return [];
    }
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npx tsc --noEmit && npx eslint frontend/app/view/agents/previousinfo.ts`
Expected: no errors. (`RpcApi.GetAgentTranscriptCommand` exists from Task 3's `task generate`; `TabRpcClient` is exported from `@/app/store/wshrpcutil`.)

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/previousinfo.ts
git commit -m "feat(agents): fetchPreviousInfo seam for transcript projection"
```

---

## Out-of-repo follow-up (NOT committed here — flag to the user)

Per the `agent-status-reporter` rule, the Python reporter at `C:\Users\kael02\IdeaProjects\agent-status-spike\agent_status_reporter.py` owns the `wsh agentstatus` contract and lives in a **separate repo**. For previous-info to populate end-to-end, the reporter must append `--transcript "$transcript_path"` (it already has `transcript_path` from every hook payload) to its state-update `agentstatus` calls, and its `test_reporter.py` `build_argv()` expectations updated. **This is a mirror task in that repo, surfaced to the user — not part of this plan's commits.** Until it ships, `AgentStatusData.TranscriptPath` is empty and `fetchPreviousInfo` returns `[]` (the graceful spec §7 path).

---

## Self-Review

**1. Spec coverage (Plan-2 scope):**
- §5.3 previous info = deterministic transcript projection (assistant text → message, `tool_use` → action, `tool_result` → outcome, no LLM) → Task 4 (`projectTranscript`), grounded in the verified JSONL shape.
- §10.1 in-repo transcript access (the named "largest unknown") → Task 1 (path plumbing) + Task 2 (tail-read) + Task 3 (RPC) + Task 5 (`fetchPreviousInfo`).
- §7 transcript-unreadable → answerable: Task 2 returns an error for missing/dir/empty paths; Task 5 catches it and returns `[]`; the existing `AskCard` already renders the question alone when `previousInfo` is empty (Plan 1, `askcard.tsx`).
- **Deferred to Plan 3 (explicitly out of scope):** the live asking-card display that calls `fetchPreviousInfo`, `ask_human` channel + answer routing (§5.2), idle-straggler peek (§5.5), the sidebar live asking count.

**2. Placeholder scan:** No "TBD/handle errors/similar to Task N". Every code step shows full code; every run step has an exact command + expected result. The out-of-repo reporter change is called out as a non-committed follow-up, not a silent gap.

**3. Type consistency:** `projectTranscript(lines: string[]): AgentEntry[]` (Task 4) consumes `AgentEntry` from `agentsviewmodel.ts` (Plan 1, unchanged) and is called by `fetchPreviousInfo` (Task 5). `CommandGetAgentTranscriptData {path, maxlines}` / `CommandGetAgentTranscriptRtnData {lines}` (Task 3, Go) match the frontend call `RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path, maxlines })` and `rtn.lines` (Task 5). `readTranscriptTail(path, maxLines)` (Task 2) signature matches its call in the RPC impl (Task 3). `AgentStatusData.TranscriptPath` json `transcriptpath` (Task 1) is what the reporter follow-up sets and what Plan 3 will read.

**4. Verification honesty:** `readTranscriptTail` (Go test) and `projectTranscript` (vitest) — the substantive logic — are unit-tested. The RPC wiring is guaranteed by codegen + types and checked by `tsc`/VSCode. `fetchPreviousInfo` is a typed 3-line glue verified by `tsc`/`eslint`; its true end-to-end exercise (real RPC round-trip + a real transcript) happens when Plan 3 renders the result. No task claims a live demo this plan.

---

## Notes for Plan 3
- Call `fetchPreviousInfo(status.transcriptpath)` when an agent enters `asking`, set the result onto the `AgentVM.previousInfo` the `AskCard` renders. The transcript path is already on `AgentStatusData` (Task 1) and stored per-block by `agentstatusstore.ts`.
- The projection tails the **parent** session transcript; subagent transcripts (`<session>/subagents/agent-<id>.jsonl`) are a later concern.
