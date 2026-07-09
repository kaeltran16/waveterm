# Subagent Interior View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the focused-agent view, clicking a subagent child in the left tree opens that child's full, live-tailing transcript in the center pane, backed by the on-disk `subagents/*.jsonl` files (which also give real ✓/✗ outcomes and survive-the-turn history).

**Architecture:** Make Claude Code's on-disk `<parentDir>/<sessionId>/subagents/agent-<id>.jsonl` files the source of truth. One thin backend RPC globs + head-reads them; pure TS extracts the parent's `Task` spawns and correlates them to the files by prompt-match; a disk-backed store feeds the existing tree UI; selecting a child renders its transcript through the existing `NarrationTimeline` + `livetranscript` stream, swapped into the center pane (terminals kept mounted, hidden).

**Tech Stack:** Go (wavesrv wshrpc command), React 19 + jotai (frontend), vitest (FE tests), Go testing. Bindings regenerated via `task generate`.

**Spec:** `docs/superpowers/specs/2026-07-09-subagent-interior-view-design.md`

---

## File Structure

**Backend**
- `pkg/wshrpc/wshrpctypes.go` — new command types (`CommandGetSubagentsData`, `SubagentFileInfo`, `CommandGetSubagentsRtnData`) + interface method.
- `pkg/wshrpc/wshserver/transcript.go` — `subagentsDir`, `firstPromptOf`, `listSubagents` helpers.
- `pkg/wshrpc/wshserver/wshserver.go` — `GetSubagentsCommand` method.
- `pkg/wshrpc/wshserver/transcript_test.go` — helper tests.
- Generated (do NOT hand-edit): `wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`.

**Frontend**
- `frontend/app/view/agents/transcriptprojection.ts` — pure `extractSubagentSpawns` (+ `SubagentSpawn` type).
- `frontend/app/view/agents/subagentcorrelate.ts` — pure `correlateSubagents` (new file).
- `frontend/app/view/agents/session-models/sessionviewmodel.ts` — add `transcriptPath?` to `SubagentVM`.
- `frontend/app/view/agents/subagentsstore.ts` — disk-backed store + `focusSubagentAtom` (new file).
- `frontend/app/view/agents/agenttree.tsx` — read the disk store; per-agent load effect; child-row `onClick`.
- `frontend/app/view/agents/subagentinterior.tsx` — center interior pane (breadcrumb + narration) (new file).
- `frontend/app/view/agents/agentsurface.tsx` — swap the center to the interior when a child is selected.
- Tests: `transcriptprojection.test.ts`, `subagentcorrelate.test.ts`.

---

## Task 1: Phase 0 spike — confirm the prompt-match correlation

The whole interior link keys off `child.firstUserMessage === parentTask.input.prompt`. Confirm this before building `correlateSubagents`. No production code; this only decides the match strategy in Task 5.

**Files:**
- Create: `scratchpad/subagent-spike.mjs` (throwaway)

- [ ] **Step 1: Write the spike script**

```js
// scratchpad/subagent-spike.mjs — run: node scratchpad/subagent-spike.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

const root = join(homedir(), ".claude", "projects");
const norm = (s) => s.trim().replace(/\s+/g, " ");

function firstPrompt(file) {
  const first = readFileSync(file, "utf8").split("\n").find((l) => l.trim());
  if (!first) return "";
  const c = JSON.parse(first)?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return (c.find((b) => b.type === "text")?.text) ?? "";
  return "";
}
function taskPrompts(parent) {
  const out = [];
  for (const l of readFileSync(parent, "utf8").split("\n")) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const c = r?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b?.type === "tool_use" && (b.name === "Task" || b.name === "Agent"))
      out.push({ type: b.input?.subagent_type, prompt: b.input?.prompt ?? "" });
  }
  return out;
}

let exact = 0, normd = 0, total = 0;
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && e.name === "subagents") {
      const parent = join(dirname(dir), basename(dir) + ".jsonl");
      if (!existsSync(parent)) continue;
      const prompts = taskPrompts(parent);
      for (const f of readdirSync(p)) {
        if (!f.endsWith(".jsonl")) continue;
        total++;
        const fp = firstPrompt(join(p, f));
        if (prompts.some((t) => t.prompt === fp)) exact++;
        else if (prompts.some((t) => norm(t.prompt) === norm(fp))) normd++;
        else console.log("NO MATCH:", f, "::", fp.slice(0, 80));
      }
    } else if (e.isDirectory()) walk(p);
  }
}
walk(root);
console.log(`\nchild files: ${total}  exact: ${exact}  normalized-only: ${normd}  unmatched: ${total - exact - normd}`);
```

- [ ] **Step 2: Run it**

Run: `node scratchpad/subagent-spike.mjs`
Expected: a summary line. **Gate:** `exact + normalized-only` should equal `total` (or nearly). If unmatched > 0, inspect the `NO MATCH` lines — if it's whitespace, `correlateSubagents` (Task 5) already normalizes; if it's truncation/wrapping, switch its match to a prefix compare (noted in Task 5). If exact is 0 but normalized is high, that's fine — Task 5 normalizes anyway.

- [ ] **Step 3: Record the outcome**

Note the match rate in the PR/commit description for Task 5. No commit for this task (throwaway script). Delete `scratchpad/subagent-spike.mjs` when done.

---

## Task 2: Backend types + `listSubagents` helper

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (add types after `CommandGetAgentTranscriptRtnData`, ~line 648)
- Modify: `pkg/wshrpc/wshserver/transcript.go` (add helpers; extend imports)
- Test: `pkg/wshrpc/wshserver/transcript_test.go`

- [ ] **Step 1: Add the command types**

In `pkg/wshrpc/wshrpctypes.go`, directly after the `CommandGetAgentTranscriptRtnData` struct (ends ~line 648), add:

```go
type CommandGetSubagentsData struct {
	Path string `json:"path"` // the PARENT agent transcript path; its subagents/ dir is derived from it
}

type SubagentFileInfo struct {
	AgentId        string `json:"agentid"`
	TranscriptPath string `json:"transcriptpath"`
	FirstPrompt    string `json:"firstprompt"`
	StartedAtMs    int64  `json:"startedatms"`
}

type CommandGetSubagentsRtnData struct {
	Subagents []SubagentFileInfo `json:"subagents"`
}
```

- [ ] **Step 2: Extend transcript.go imports**

In `pkg/wshrpc/wshserver/transcript.go`, add `"encoding/json"` and `"sort"` to the import block (keep alphabetical: `context`, `encoding/json`, `fmt`, `io`, `log`, `os`, `path/filepath`, `sort`, `strings`, then the two module imports).

- [ ] **Step 3: Write the failing test**

Add to `pkg/wshrpc/wshserver/transcript_test.go` (ensure `"github.com/wavetermdev/waveterm/pkg/wshrpc"`, `"os"`, `"path/filepath"`, `"testing"` are imported):

```go
func TestListSubagents(t *testing.T) {
	dir := t.TempDir()
	parent := filepath.Join(dir, "sess.jsonl")
	if err := os.WriteFile(parent, []byte(`{"type":"user"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	subdir := filepath.Join(dir, "sess", "subagents")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(id, prompt string) {
		rec := `{"agentId":"` + id + `","type":"user","message":{"content":"` + prompt + `"}}` + "\n"
		if err := os.WriteFile(filepath.Join(subdir, "agent-"+id+".jsonl"), []byte(rec), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("aaa", "Explore the repo")
	write("bbb", "Plan the work")

	infos, err := listSubagents(parent)
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 2 {
		t.Fatalf("want 2 infos, got %d", len(infos))
	}
	byId := map[string]wshrpc.SubagentFileInfo{}
	for _, in := range infos {
		byId[in.AgentId] = in
	}
	if byId["aaa"].FirstPrompt != "Explore the repo" {
		t.Errorf("firstPrompt aaa = %q", byId["aaa"].FirstPrompt)
	}
	if byId["bbb"].TranscriptPath != filepath.Join(subdir, "agent-bbb.jsonl") {
		t.Errorf("transcriptPath bbb = %q", byId["bbb"].TranscriptPath)
	}
}

func TestListSubagentsMissingDir(t *testing.T) {
	dir := t.TempDir()
	parent := filepath.Join(dir, "none.jsonl")
	if err := os.WriteFile(parent, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	infos, err := listSubagents(parent)
	if err != nil {
		t.Fatalf("missing subagents dir must not error: %v", err)
	}
	if len(infos) != 0 {
		t.Fatalf("want 0 infos, got %d", len(infos))
	}
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestListSubagents -v`
Expected: FAIL — `undefined: listSubagents`.

- [ ] **Step 5: Implement the helpers**

Append to `pkg/wshrpc/wshserver/transcript.go`:

```go
// subagentsDir derives the Claude Code subagents directory for a parent transcript path:
// <dir>/<basename without .jsonl>/subagents.
func subagentsDir(parentPath string) string {
	base := strings.TrimSuffix(filepath.Base(parentPath), ".jsonl")
	return filepath.Join(filepath.Dir(parentPath), base, "subagents")
}

// firstPromptOf extracts the human prompt from a subagent transcript's first record. That record is a
// user turn whose message.content is either a bare string or an array of {type,text} blocks.
func firstPromptOf(line string) string {
	var rec struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(line), &rec) != nil {
		return ""
	}
	var s string
	if json.Unmarshal(rec.Message.Content, &s) == nil {
		return strings.TrimSpace(s)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(rec.Message.Content, &blocks) == nil {
		for _, b := range blocks {
			if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
				return strings.TrimSpace(b.Text)
			}
		}
	}
	return ""
}

// listSubagents returns one SubagentFileInfo per agent-*.jsonl in the parent's subagents dir, sorted by
// StartedAtMs ascending. A missing dir yields an empty slice (not an error) — a parent that never
// spawned a subagent has no dir.
func listSubagents(parentPath string) ([]wshrpc.SubagentFileInfo, error) {
	if parentPath == "" {
		return nil, fmt.Errorf("parent transcript path is required")
	}
	matches, err := filepath.Glob(filepath.Join(subagentsDir(parentPath), "agent-*.jsonl"))
	if err != nil {
		return nil, fmt.Errorf("globbing subagents: %w", err)
	}
	infos := make([]wshrpc.SubagentFileInfo, 0, len(matches))
	for _, path := range matches {
		head, err := readTranscriptHead(path, 1)
		if err != nil || len(head) == 0 {
			continue
		}
		info := wshrpc.SubagentFileInfo{
			AgentId:        strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "agent-"), ".jsonl"),
			TranscriptPath: path,
			FirstPrompt:    firstPromptOf(head[0]),
		}
		if st, statErr := os.Stat(path); statErr == nil {
			info.StartedAtMs = st.ModTime().UnixMilli()
		}
		infos = append(infos, info)
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].StartedAtMs < infos[j].StartedAtMs })
	return infos, nil
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestListSubagents -v`
Expected: PASS (both `TestListSubagents` and `TestListSubagentsMissingDir`).

- [ ] **Step 7: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/transcript.go pkg/wshrpc/wshserver/transcript_test.go
git commit -m "feat(agents): backend listSubagents helper + RPC types"
```

---

## Task 3: `GetSubagentsCommand` RPC method + generate bindings

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface method after `GetAgentTranscriptCommand`, ~line 96)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (method after `GetAgentTranscriptCommand`, ~line 1480)
- Generated: `wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Add the interface method**

In `pkg/wshrpc/wshrpctypes.go`, directly below the `GetAgentTranscriptCommand` interface line (~line 96), add:

```go
	GetSubagentsCommand(ctx context.Context, data CommandGetSubagentsData) (*CommandGetSubagentsRtnData, error) // list a parent agent's on-disk subagent transcripts
```

- [ ] **Step 2: Add the server method**

In `pkg/wshrpc/wshserver/wshserver.go`, directly after `GetAgentTranscriptCommand` (ends ~line 1480), add:

```go
func (ws *WshServer) GetSubagentsCommand(ctx context.Context, data wshrpc.CommandGetSubagentsData) (*wshrpc.CommandGetSubagentsRtnData, error) {
	infos, err := listSubagents(data.Path)
	if err != nil {
		return nil, fmt.Errorf("listing subagents: %w", err)
	}
	return &wshrpc.CommandGetSubagentsRtnData{Subagents: infos}, nil
}
```

- [ ] **Step 3: Regenerate bindings**

Run: `task generate`
Expected: exit 0; it rewrites `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`.

- [ ] **Step 4: Verify the generated bindings**

Run: `grep -n "GetSubagentsCommand" frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts`
Expected: `wshclientapi.ts` shows a `GetSubagentsCommand(...)` method returning `Promise<CommandGetSubagentsRtnData>`; `gotypes.d.ts` shows `type CommandGetSubagentsData`, `type SubagentFileInfo`, `type CommandGetSubagentsRtnData` (do NOT hand-edit these).

- [ ] **Step 5: Build the backend**

Run: `go build ./...`
Expected: exit 0 (WshServer still satisfies the interface).

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(agents): GetSubagentsCommand RPC + regenerated bindings"
```

---

## Task 4: Pure `extractSubagentSpawns`

**Files:**
- Modify: `frontend/app/view/agents/transcriptprojection.ts`
- Test: `frontend/app/view/agents/transcriptprojection.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `frontend/app/view/agents/transcriptprojection.test.ts` (add `extractSubagentSpawns` to the existing import from `./transcriptprojection`):

```ts
describe("extractSubagentSpawns", () => {
    const asst = (blocks: any[]) => JSON.stringify({ type: "assistant", message: { content: blocks } });
    const usr = (blocks: any[]) => JSON.stringify({ type: "user", message: { content: blocks } });

    it("pairs a completed Task with its ok result", () => {
        const lines = [
            asst([{ type: "tool_use", id: "t1", name: "Task", input: { subagent_type: "Explore", prompt: "look at X" } }]),
            usr([{ type: "tool_result", tool_use_id: "t1", is_error: false }]),
        ];
        expect(extractSubagentSpawns(lines)).toEqual([
            { toolUseId: "t1", subagentType: "Explore", prompt: "look at X", done: true, failed: false },
        ]);
    });

    it("marks a still-running Task as not done", () => {
        const lines = [asst([{ type: "tool_use", id: "t2", name: "Task", input: { subagent_type: "Plan", prompt: "plan Y" } }])];
        expect(extractSubagentSpawns(lines)[0]).toMatchObject({ done: false, failed: false });
    });

    it("marks an errored Task as failed", () => {
        const lines = [
            asst([{ type: "tool_use", id: "t3", name: "Task", input: { subagent_type: "Test", prompt: "test Z" } }]),
            usr([{ type: "tool_result", tool_use_id: "t3", is_error: true }]),
        ];
        expect(extractSubagentSpawns(lines)[0]).toMatchObject({ done: true, failed: true });
    });

    it("keeps parallel spawns in first-seen order and ignores non-Task tools", () => {
        const lines = [
            asst([{ type: "tool_use", id: "r", name: "Read", input: { file_path: "a" } }]),
            asst([{ type: "tool_use", id: "a", name: "Task", input: { subagent_type: "Explore", prompt: "P1" } }]),
            asst([{ type: "tool_use", id: "b", name: "Task", input: { subagent_type: "Explore", prompt: "P2" } }]),
        ];
        expect(extractSubagentSpawns(lines).map((s) => s.toolUseId)).toEqual(["a", "b"]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts -t extractSubagentSpawns`
Expected: FAIL — `extractSubagentSpawns is not a function`.

- [ ] **Step 3: Implement the function**

Append to `frontend/app/view/agents/transcriptprojection.ts`:

```ts
export interface SubagentSpawn {
    toolUseId: string;
    subagentType: string;
    prompt: string;
    done: boolean;
    failed: boolean;
}

/** Pure: Task/Agent tool_use blocks in a Claude transcript -> subagent spawns, each joined to its
 *  tool_result by tool_use_id (done + failed via is_error). A spawn with no matching result is still
 *  running (done=false). Spawns keep first-seen order; non-Task tools are ignored. */
export function extractSubagentSpawns(lines: string[]): SubagentSpawn[] {
    const spawns = new Map<string, SubagentSpawn>();
    const order: string[] = [];
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
        for (const block of content) {
            if (
                block?.type === "tool_use" &&
                (block.name === "Task" || block.name === "Agent") &&
                typeof block.id === "string"
            ) {
                const input = block.input ?? {};
                spawns.set(block.id, {
                    toolUseId: block.id,
                    subagentType: typeof input.subagent_type === "string" ? input.subagent_type : "",
                    prompt: typeof input.prompt === "string" ? input.prompt : "",
                    done: false,
                    failed: false,
                });
                order.push(block.id);
            } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
                const s = spawns.get(block.tool_use_id);
                if (s) {
                    s.done = true;
                    s.failed = block.is_error === true;
                }
            }
        }
    }
    return order.map((id) => spawns.get(id)!);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts -t extractSubagentSpawns`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/transcriptprojection.ts frontend/app/view/agents/transcriptprojection.test.ts
git commit -m "feat(agents): pure extractSubagentSpawns projection"
```

---

## Task 5: Add `transcriptPath?` to `SubagentVM` + pure `correlateSubagents`

**Files:**
- Modify: `frontend/app/view/agents/session-models/sessionviewmodel.ts` (extend `SubagentVM`)
- Create: `frontend/app/view/agents/subagentcorrelate.ts`
- Test: `frontend/app/view/agents/subagentcorrelate.test.ts`

- [ ] **Step 1: Extend the `SubagentVM` interface**

In `frontend/app/view/agents/session-models/sessionviewmodel.ts`, change the `SubagentVM` interface (~line 15) to add an optional `transcriptPath`:

```ts
export interface SubagentVM {
    id: string;
    type: string;
    state: SubagentState;
    model?: string;
    transcriptPath?: string; // disk-backed source: the child's own transcript file (undefined for the legacy hook path)
}
```

- [ ] **Step 2: Write the failing test**

Create `frontend/app/view/agents/subagentcorrelate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { correlateSubagents } from "./subagentcorrelate";
import type { SubagentSpawn } from "./transcriptprojection";

const spawn = (over: Partial<SubagentSpawn>): SubagentSpawn => ({
    toolUseId: "t",
    subagentType: "Explore",
    prompt: "look at X",
    done: false,
    failed: false,
    ...over,
});
const file = (over: Partial<SubagentFileInfo>): SubagentFileInfo => ({
    agentid: "a1",
    transcriptpath: "/p/agent-a1.jsonl",
    firstprompt: "look at X",
    startedatms: 1,
    ...over,
});

describe("correlateSubagents", () => {
    it("takes type + success state from a matched, completed spawn", () => {
        const out = correlateSubagents([spawn({ done: true })], [file({})]);
        expect(out).toEqual([{ id: "a1", type: "Explore", state: "success", transcriptPath: "/p/agent-a1.jsonl" }]);
    });

    it("maps an errored spawn to failure", () => {
        const out = correlateSubagents([spawn({ done: true, failed: true })], [file({})]);
        expect(out[0].state).toBe("failure");
    });

    it("maps a running (or unmatched) file to working", () => {
        expect(correlateSubagents([spawn({ done: false })], [file({})])[0].state).toBe("working");
        expect(correlateSubagents([], [file({ firstprompt: "orphan" })])[0].state).toBe("working");
    });

    it("matches on normalized whitespace", () => {
        const out = correlateSubagents([spawn({ prompt: "look   at\nX", done: true })], [file({ firstprompt: "look at X" })]);
        expect(out[0].type).toBe("Explore");
    });

    it("pairs parallel same-type spawns 1:1 in file order", () => {
        const spawns = [spawn({ toolUseId: "a", prompt: "P1", done: true }), spawn({ toolUseId: "b", prompt: "P2", done: true, failed: true })];
        const files = [file({ agentid: "f1", firstprompt: "P1" }), file({ agentid: "f2", firstprompt: "P2" })];
        const out = correlateSubagents(spawns, files);
        expect(out.map((s) => [s.id, s.state])).toEqual([["f1", "success"], ["f2", "failure"]]);
    });

    it("falls back to the prompt's first line when no spawn matches", () => {
        const out = correlateSubagents([], [file({ firstprompt: "Investigate the crash\nmore detail" })]);
        expect(out[0].type).toBe("Investigate the crash");
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/subagentcorrelate.test.ts`
Expected: FAIL — cannot find module `./subagentcorrelate`.

- [ ] **Step 4: Implement the function**

Create `frontend/app/view/agents/subagentcorrelate.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: join on-disk subagent files (SubagentFileInfo, from GetSubagentsCommand) to the parent's Task
// spawns (SubagentSpawn) by prompt-match. type + state come from the matched spawn; an unmatched file
// (spawn not yet in the tailed parent window, or a fallback) stays "working" with a prompt-derived label.
// No React, no runtime imports. SubagentFileInfo is a generated global type (gotypes.d.ts).

import type { SubagentVM } from "./session-models/sessionviewmodel";
import type { SubagentSpawn } from "./transcriptprojection";

const FALLBACK_LABEL_MAX = 40;

function normPrompt(p: string): string {
    return p.trim().replace(/\s+/g, " ");
}

function firstLineLabel(prompt: string): string {
    const line = prompt.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
    return line.length > FALLBACK_LABEL_MAX ? line.slice(0, FALLBACK_LABEL_MAX) : line;
}

export function correlateSubagents(spawns: SubagentSpawn[], files: SubagentFileInfo[]): SubagentVM[] {
    const byPrompt = new Map<string, SubagentSpawn[]>();
    for (const s of spawns) {
        const key = normPrompt(s.prompt);
        const bucket = byPrompt.get(key);
        if (bucket) {
            bucket.push(s);
        } else {
            byPrompt.set(key, [s]);
        }
    }
    return files.map((f) => {
        // shift() consumes the match so parallel same-prompt spawns pair 1:1 with files in order
        const spawn = byPrompt.get(normPrompt(f.firstprompt))?.shift();
        const type = spawn?.subagentType || firstLineLabel(f.firstprompt) || "subagent";
        const state: SubagentVM["state"] = spawn == null || !spawn.done ? "working" : spawn.failed ? "failure" : "success";
        return { id: f.agentid, type, state, transcriptPath: f.transcriptpath };
    });
}
```

> **If Task 1's spike found unmatched prompts due to truncation/wrapping** (not just whitespace): change the `byPrompt` lookup to a prefix compare — build the map keyed by the first 120 normalized chars and look up `normPrompt(f.firstprompt).slice(0, 120)`. Otherwise leave as written.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/subagentcorrelate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/session-models/sessionviewmodel.ts frontend/app/view/agents/subagentcorrelate.ts frontend/app/view/agents/subagentcorrelate.test.ts
git commit -m "feat(agents): pure correlateSubagents (prompt-match) + SubagentVM.transcriptPath"
```

---

## Task 6: Disk-backed store + `focusSubagentAtom`

**Files:**
- Create: `frontend/app/view/agents/subagentsstore.ts`

- [ ] **Step 1: Write the store**

Create `frontend/app/view/agents/subagentsstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Disk-backed subagent lists per parent agent, plus the "which child interior is open" selection.
// Mirrors cardgitstore.ts: refresh on enter, scheduleSubagents (debounced) on parent-transcript
// activity, drop on leave. The source of truth is the on-disk subagents/ dir (GetSubagentsCommand);
// the parent transcript tail supplies the Task spawns that correlate type + outcome onto each file.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import { correlateSubagents } from "./subagentcorrelate";
import { extractSubagentSpawns } from "./transcriptprojection";

export interface FocusSubagent {
    parentId: string;
    agentId: string;
    transcriptPath: string;
    label: string;
}

// per parent-agent-id -> its correlated children
export const subagentsByIdAtom = atom<Record<string, SubagentVM[]>>({}) as PrimitiveAtom<Record<string, SubagentVM[]>>;
// the child interior currently open in the focused view (null = show the parent terminal)
export const focusSubagentAtom = atom<FocusSubagent | null>(null) as PrimitiveAtom<FocusSubagent | null>;

const PARENT_TAIL_LINES = 1000; // covers the current turn's Task spawns + results
const DEBOUNCE_MS = 4000; // same cadence as cardgitstore
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const loadSeq = new Map<string, number>();

function setList(id: string, list: SubagentVM[] | null): void {
    const cur = globalStore.get(subagentsByIdAtom);
    if (list == null || list.length === 0) {
        if (!(id in cur)) {
            return;
        }
        const { [id]: _, ...rest } = cur;
        globalStore.set(subagentsByIdAtom, rest);
        return;
    }
    globalStore.set(subagentsByIdAtom, { ...cur, [id]: list });
}

/** Load the parent's subagent files + tail its transcript, correlate, and store. Guarded so a
 *  superseding load (or a drop) discards a slower older result. */
export async function refreshSubagents(id: string, transcriptPath: string | undefined): Promise<void> {
    const seq = (loadSeq.get(id) ?? 0) + 1;
    loadSeq.set(id, seq);
    if (!transcriptPath) {
        setList(id, null);
        return;
    }
    try {
        const [subs, tr] = await Promise.all([
            RpcApi.GetSubagentsCommand(TabRpcClient, { path: transcriptPath }),
            RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: transcriptPath, maxlines: PARENT_TAIL_LINES }),
        ]);
        if (loadSeq.get(id) !== seq) {
            return;
        }
        const files = subs.subagents ?? [];
        if (files.length === 0) {
            setList(id, null);
            return;
        }
        setList(id, correlateSubagents(extractSubagentSpawns(tr.lines ?? []), files));
    } catch {
        if (loadSeq.get(id) === seq) {
            setList(id, null);
        }
    }
}

/** Debounced refresh, coalescing a burst of parent activity into one load. */
export function scheduleSubagents(id: string, transcriptPath: string | undefined): void {
    const existing = timers.get(id);
    if (existing) {
        clearTimeout(existing);
    }
    timers.set(
        id,
        setTimeout(() => {
            timers.delete(id);
            void refreshSubagents(id, transcriptPath);
        }, DEBOUNCE_MS)
    );
}

/** Stop tracking a parent that left the rendered set: cancel pending work, invalidate in-flight loads,
 *  drop its list, and close the interior if it belonged to this parent. */
export function dropSubagents(id: string): void {
    const existing = timers.get(id);
    if (existing) {
        clearTimeout(existing);
        timers.delete(id);
    }
    loadSeq.set(id, (loadSeq.get(id) ?? 0) + 1);
    setList(id, null);
    const fs = globalStore.get(focusSubagentAtom);
    if (fs && fs.parentId === id) {
        globalStore.set(focusSubagentAtom, null);
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (no errors; `RpcApi.GetSubagentsCommand` resolves from Task 3's generate).

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/subagentsstore.ts
git commit -m "feat(agents): disk-backed subagent store + focusSubagentAtom"
```

---

## Task 7: Wire the tree to the disk store + click-to-open

**Files:**
- Modify: `frontend/app/view/agents/agenttree.tsx`

- [ ] **Step 1: Update imports**

In `frontend/app/view/agents/agenttree.tsx`, remove the `getSubagentsAtom` import from `./session-models/agentstatusstore` (keep `getSubagentExpandAtom`, `toggleSubagentExpand`), and add:

```ts
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { lastActivityByIdAtom } from "./livetranscript";
import { dropSubagents, focusSubagentAtom, refreshSubagents, scheduleSubagents, subagentsByIdAtom } from "./subagentsstore";
```

(`useAtomValue`, `useLayoutEffect`, `useRef` are already imported; add `useEffect` to the existing `react` import.)

- [ ] **Step 2: Read the disk store in `ParentRow`**

In `ParentRow`, replace the subagent source line:

```ts
    const subs = useAtomValue(getSubagentsAtom(oref));
```

with:

```ts
    const subs = useAtomValue(subagentsByIdAtom)[agent.id] ?? [];
```

(`oref` is still used by the expand atoms below — leave it.)

- [ ] **Step 3: Make child rows clickable → open the interior**

In `ParentRow`, the child row `<div>` inside the `subs.map((s) => ...)` currently starts:

```tsx
                            <div
                                key={s.id}
                                className="relative flex items-center gap-[8px] rounded-[9px] py-[7px] pl-[28px] pr-[10px] hover:bg-surface-hover"
                            >
```

Replace it with a clickable row that opens the interior when the child has a transcript path:

```tsx
                            <div
                                key={s.id}
                                onClick={() => {
                                    if (!s.transcriptPath) {
                                        return;
                                    }
                                    globalStore.set(model.focusIdAtom, agent.id);
                                    globalStore.set(focusSubagentAtom, {
                                        parentId: agent.id,
                                        agentId: s.id,
                                        transcriptPath: s.transcriptPath,
                                        label: s.type || "subagent",
                                    });
                                }}
                                className={cn(
                                    "relative flex items-center gap-[8px] rounded-[9px] py-[7px] pl-[28px] pr-[10px] hover:bg-surface-hover",
                                    s.transcriptPath && "cursor-pointer"
                                )}
                            >
```

(`globalStore` and `cn` are already imported in this file.)

- [ ] **Step 4: Add the per-agent load effect in `AgentTree`**

In the `AgentTree` component, after `const rows = buildAgentTree(agents, order);`, add:

```tsx
    // Disk-backed subagent loading for every rendered parent: refresh on enter, debounce on parent
    // transcript activity, drop on leave. Mirrors cockpitsurface's per-card git effect.
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const trackedRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const now = new Set(agents.map((a) => a.id));
        for (const a of agents) {
            if (!trackedRef.current.has(a.id)) {
                void refreshSubagents(a.id, a.transcriptPath);
            }
        }
        for (const id of trackedRef.current) {
            if (!now.has(id)) {
                dropSubagents(id);
            }
        }
        trackedRef.current = now;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agents.map((a) => a.id).join(",")]);
    useEffect(() => {
        for (const a of agents) {
            if (lastActivity[a.id]) {
                scheduleSubagents(a.id, a.transcriptPath);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lastActivity]);
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. If it flags `getSubagentsAtom` as unused elsewhere, that's expected — leave `agentstatusstore.ts` itself untouched (the hook path stays dormant per spec §8).

- [ ] **Step 6: Run the agents test suite (guard against regressions)**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (existing suite green; no test targets the tree component directly).

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/agenttree.tsx
git commit -m "feat(agents): tree reads disk-backed subagents + click-to-open child"
```

---

## Task 8: Center interior pane (breadcrumb + narration) and surface swap

**Files:**
- Create: `frontend/app/view/agents/subagentinterior.tsx`
- Modify: `frontend/app/view/agents/agentsurface.tsx`

- [ ] **Step 1: Create the interior component**

Create `frontend/app/view/agents/subagentinterior.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The subagent interior: a child's transcript rendered as narration in the focused view's center pane,
// swapped in over the (kept-mounted) parent terminal. Tails the child's own transcript file via the
// shared livetranscript stream (keyed sub:<agentId>); breadcrumb / Esc returns to the parent.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { liveEntriesByIdAtom, startTranscriptStream, stopTranscriptStream } from "./livetranscript";
import { NarrationTimeline } from "./narrationtimeline";
import { focusSubagentAtom, type FocusSubagent } from "./subagentsstore";

export function SubagentInterior({ sub, parentName }: { sub: FocusSubagent; parentName: string }) {
    const streamId = `sub:${sub.agentId}`;
    useEffect(() => {
        startTranscriptStream(streamId, sub.transcriptPath, "claude");
        return () => stopTranscriptStream(streamId);
    }, [streamId, sub.transcriptPath]);

    const back = () => globalStore.set(focusSubagentAtom, null);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                back();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const entries = useAtomValue(liveEntriesByIdAtom)[streamId] ?? [];
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-edge-mid bg-surface px-3 py-2 font-mono text-[11px]">
                <button type="button" onClick={back} title="Back to parent (Esc)" className="cursor-pointer text-muted hover:text-primary">
                    ◂ {parentName}
                </button>
                <span className="text-edge-strong">›</span>
                <span className="text-accent">{sub.label}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                {entries.length > 0 ? (
                    <NarrationTimeline entries={entries} accentLatest active />
                ) : (
                    <div className="flex h-full items-center justify-center text-[12px] text-muted">
                        Loading subagent transcript…
                    </div>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Import into the surface**

In `frontend/app/view/agents/agentsurface.tsx`, add:

```ts
import { focusSubagentAtom } from "./subagentsstore";
import { SubagentInterior } from "./subagentinterior";
```

- [ ] **Step 3: Read the selection + clear it on parent change**

In `AgentSurface`, after `const fullscreen = useAtomValue(terminalFullscreenAtom);`, add:

```ts
    const focusSub = useAtomValue(focusSubagentAtom);
    const showSub = focusSub != null && focusSub.parentId === agent?.id;
```

Then, after the existing `useEffect` that syncs `focusId` to the defaulted agent, add:

```ts
    // a stale interior (its parent is no longer focused) closes so the terminal returns
    useEffect(() => {
        if (focusSub != null && focusSub.parentId !== agent?.id) {
            globalStore.set(focusSubagentAtom, null);
        }
    }, [agent?.id, focusSub]);
```

(`agent` is declared above these effects; referencing `agent?.id` is safe.)

- [ ] **Step 4: Swap the center pane**

In `AgentSurface`'s returned JSX, replace the center column block:

```tsx
                <div className="flex min-w-0 flex-1 flex-col">
                    <AgentHeader agent={agent} />
                    {/* Keep every live agent's terminal mounted ... */}
                    {mountable
                        .filter((a) => a.blockId != null)
                        .map((a) => (
                            <div
                                key={a.id}
                                className={cn("min-h-0 flex-1", a.id === agent.id ? "flex flex-col" : "hidden")}
                            >
                                <CockpitFocusPane blockId={a.blockId!} tabId={tabId} />
                            </div>
                        ))}
                    {agent.blockId == null ? (
                        <div className="flex flex-1 items-center justify-center text-[13px] text-muted">
                            No live terminal for this agent.
                        </div>
                    ) : null}
                </div>
```

with a version that hides (never unmounts) the terminal stack while the interior is shown:

```tsx
                <div className="flex min-w-0 flex-1 flex-col">
                    {/* terminal stack stays mounted (hidden) while a subagent interior is shown, so
                        returning to the parent never remounts/replays the live TUI (frame-stacking) */}
                    <div className={cn("flex min-h-0 flex-1 flex-col", showSub && "hidden")}>
                        <AgentHeader agent={agent} />
                        {mountable
                            .filter((a) => a.blockId != null)
                            .map((a) => (
                                <div
                                    key={a.id}
                                    className={cn("min-h-0 flex-1", a.id === agent.id ? "flex flex-col" : "hidden")}
                                >
                                    <CockpitFocusPane blockId={a.blockId!} tabId={tabId} />
                                </div>
                            ))}
                        {agent.blockId == null ? (
                            <div className="flex flex-1 items-center justify-center text-[13px] text-muted">
                                No live terminal for this agent.
                            </div>
                        ) : null}
                    </div>
                    {showSub ? <SubagentInterior sub={focusSub!} parentName={agent.name} /> : null}
                </div>
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Build the frontend (catches JSX/bundler issues)**

Run: `npx vite build`
Expected: exit 0 (build completes).

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/subagentinterior.tsx frontend/app/view/agents/agentsurface.tsx
git commit -m "feat(agents): subagent interior pane + center-swap in the focus view"
```

---

## Task 9: Live verification + close-out

**Files:**
- Modify: `docs/deferred.md` (record what's deferred)

- [ ] **Step 1: Rebuild backend + run the dev app**

Run: `task build:backend` then `tail -f /dev/null | task dev` (headless-safe per `memory/dev-task-dev-stdin-eof.md`). Wait for the cockpit to boot.

- [ ] **Step 2: Drive a real fan-out and verify end to end**

In a focused Claude agent, run a prompt that spawns subagents (e.g. ask it to dispatch two `Explore` agents). Then, via CDP screenshot (`node scripts/cdp-shot.mjs scratchpad/subagents.png`) or by watching the app:
- Confirm the left-tree parent shows the count badge and expands to child rows with type labels.
- Confirm a completed child shows ✓ (or ✗ on failure), and children persist after the parent goes idle.
- Click a child → confirm the center pane swaps to its transcript (narration), the breadcrumb reads `◂ <parent> › <type>`, and new tool lines stream in live.
- Press Esc (or click the breadcrumb) → confirm the parent's live terminal returns intact (no frame-stacking/distortion).

Expected: all four behaviors hold. If the tree stays empty, check `WAVETERM_HOOK_DEBUG` output and that the agent's `transcriptPath` is set (a freshly-launched agent with no reporter enrichment has none until its first turn — see `docs/deferred.md`).

- [ ] **Step 3: Record deferred items**

Append to `docs/deferred.md` (top): the v1 exclusions from spec §11 — cockpit-card fan-out badge, Codex subagents, retiring the vestigial hook path, deep nesting — with a one-line pointer to the spec.

- [ ] **Step 4: Commit**

```bash
git add docs/deferred.md
git commit -m "docs(agents): record subagent interior view deferred items"
```

---

## Self-Review

- **Spec coverage:** §1 interior view → Tasks 6–8; §2 disk source of truth → Tasks 2,3,6; §3 correlation → Tasks 4,5 (spike Task 1); §5 architecture/data flow → Tasks 2–8; §6 backend RPC → Tasks 2,3; §7 frontend (projections/store/tree/center) → Tasks 4–8; §8 reuse (NarrationTimeline/livetranscript/tree) → Tasks 7,8, vestigial hook path left dormant (Task 7 note); §9 spike → Task 1; §10 testing → Tasks 2,4,5 unit tests + Task 9 live; §11 out-of-scope → Task 9 doc. No uncovered requirement.
- **Placeholder scan:** none — every code step carries full code; commands have expected output.
- **Type consistency:** `SubagentFileInfo` fields (`agentid`/`transcriptpath`/`firstprompt`/`startedatms`, generated lowercase JSON tags) are used consistently in tests and `correlateSubagents`; `SubagentSpawn` shape matches between `extractSubagentSpawns` (Task 4) and `correlateSubagents` (Task 5); `SubagentVM.transcriptPath` (Task 5) is produced by correlate and consumed by the tree (Task 7) and interior (`FocusSubagent.transcriptPath`, Task 6→8); `focusSubagentAtom`/`FocusSubagent`/`refreshSubagents`/`scheduleSubagents`/`dropSubagents`/`subagentsByIdAtom` names match across Tasks 6/7/8.

**Note on generated types:** `SubagentFileInfo` is emitted into `gotypes.d.ts`'s global type namespace by `task generate` (Task 3), so `.test.ts` and `subagentcorrelate.ts` reference it unqualified (matching how the codebase references other generated types like `AgentUsage`). Task 3 must run before Tasks 5–8 typecheck.
