# Subagent-tree v1 follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the perpetual "working" dot on orphan subagents with a child-file done-signal (#5), retire the vestigial hook subagent path by migrating its two live consumers onto the disk store (#3), and add a `⑃ N` fan-out badge + peek to the cockpit card (#1).

**Architecture:** One shared data layer (`GetSubagentsCommand` → `SubagentFileInfo` → `correlateSubagents` → `subagentsByIdAtom`). A shared foundation lands first (a neutral `done` state + a `useSubagentTracking` hook extracted from the tree). Then three independent tracks build on it. The backend tail-reads a child's last record to detect completion; the frontend migrates the rail + Runs surfaces off the ephemeral `getSubagentsAtom` before deleting the hook path; the grid reuses the shared load hook and the card reads the same atom.

**Tech Stack:** Go (`pkg/wshrpc/wshserver`, `pkg/baseds`, `cmd/wsh`), React 19 + jotai + Tailwind 4 (`frontend/app/view/agents`), vitest, `go test`, `task generate`, CDP visual verification (`scripts/cdp-shot.mjs`).

**Spec:** `docs/superpowers/specs/2026-07-10-subagent-tree-followups-design.md`

**Conventions for every commit in this plan:**
- Never commit without the user's approval (repo rule). Steps say "Commit" as the natural stopping point; batch or gate per the user's instruction at execution time.
- The spec + this plan fold into the **first** feature commit — no separate docs-only commit.
- Frontend typecheck is `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows; baseline is clean, exit 0).
- Go tests: `go test ./pkg/wshrpc/wshserver/`. Frontend tests: `npx vitest run <file>`.
- **Never hand-edit generated files** (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`). Edit the Go source, then `task generate`.

---

## Track 0 — Shared foundation (do first; #1 and #3-Runs depend on it)

### Task 1: Add the neutral `done` state + colors

**Files:**
- Modify: `frontend/app/view/agents/session-models/sessionviewmodel.ts:13`
- Modify: `frontend/app/view/agents/agenttree.tsx:32-36`
- Modify: `frontend/app/view/agents/runssurface.tsx:294-297`

`done` = "finished, outcome unknown" — a terminated orphan child (no parent accept/reject). It must render in a neutral (non-green) color everywhere `SubagentState` is shown. `rollUpStatus`/`subagentExpanded` need no change: they only key off `"working"`, and a `done` child is not working.

- [ ] **Step 1: Extend the union**

In `sessionviewmodel.ts`, change line 13:

```ts
export type SubagentState = "working" | "success" | "failure" | "done";
```

- [ ] **Step 2: Add the tree color**

In `agenttree.tsx`, replace the `SUB_COLOR` map (lines 32-36):

```tsx
const SUB_COLOR: Record<SubagentState, string> = {
    working: "var(--color-accent)",
    success: "var(--color-success)",
    failure: "var(--color-error)",
    done: "var(--color-muted)",
};
```

- [ ] **Step 3: Add the Runs dot color**

In `runssurface.tsx`, replace the inline dot class (lines 294-297) so `done` gets the muted dot:

```tsx
                        className={
                            "h-[6px] w-[6px] flex-none rounded-full " +
                            (s.state === "failure"
                                ? "bg-error"
                                : s.state === "success"
                                  ? "bg-success"
                                  : s.state === "done"
                                    ? "bg-muted"
                                    : "bg-asking")
                        }
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (`Record<SubagentState, string>` now forces every consumer map to include `done` — a missing key would error here.)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/session-models/sessionviewmodel.ts frontend/app/view/agents/agenttree.tsx frontend/app/view/agents/runssurface.tsx docs/superpowers/specs/2026-07-10-subagent-tree-followups-design.md docs/superpowers/plans/2026-07-10-subagent-tree-followups.md
git commit -m "feat(agents): add neutral done subagent state (+ spec/plan)"
```

---

### Task 2: Extract `useSubagentTracking` and migrate the tree onto it

**Files:**
- Create: `frontend/app/view/agents/subagenttracking.ts`
- Modify: `frontend/app/view/agents/agenttree.tsx` (imports line 15, 24; the two effects + `trackedRef` at lines 192-218)

Pure refactor — the tree's disk-load behavior is unchanged; the effect just moves so the grid (#1) and Runs (#3) can reuse it instead of copying it.

- [ ] **Step 1: Write the hook**

Create `frontend/app/view/agents/subagenttracking.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Load each agent's disk-backed subagents into subagentsByIdAtom: refresh on enter, debounce on parent
// transcript activity, drop on leave. Extracted from agenttree so the cockpit grid and the Runs surface
// populate the store the same way instead of each copying the effect. Safe to mount on more than one
// surface at once: refreshSubagents is seq-guarded and dropSubagents only clears ids this caller tracked.

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { lastActivityByIdAtom } from "./livetranscript";
import { dropSubagents, refreshSubagents, scheduleSubagents } from "./subagentsstore";

type Trackable = { id: string; transcriptPath?: string };

export function useSubagentTracking(agents: Trackable[]): void {
    const lastActivity = useAtomValue(lastActivityByIdAtom);
    const trackedRef = useRef<Set<string>>(new Set());
    const idsKey = agents.map((a) => a.id).join(",");
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
    }, [idsKey]);
    useEffect(() => {
        for (const a of agents) {
            if (lastActivity[a.id]) {
                scheduleSubagents(a.id, a.transcriptPath);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lastActivity]);
}
```

- [ ] **Step 2: Migrate the tree — fix imports**

In `agenttree.tsx`, change the `subagentsstore` import (line 24) to keep only what the component still reads directly:

```tsx
import { focusSubagentAtom, subagentsByIdAtom } from "./subagentsstore";
```

Add the hook import (next to the other local imports):

```tsx
import { useSubagentTracking } from "./subagenttracking";
```

Remove the now-unused `lastActivityByIdAtom` import at line 15 (it was used only by the effect being removed). If `useLayoutEffect`/`useRef`/`useEffect` are still used elsewhere in the file (they are — entrance state), leave the React import alone.

- [ ] **Step 3: Replace the two effects with the hook call**

In `AgentTree`, delete the whole disk-load block (lines 192-218: the `lastActivity`/`trackedRef` declarations and both `useEffect`s) and replace with a single call, placed right after `const rows = buildAgentTree(agents, order);`:

```tsx
    useSubagentTracking(agents);
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (no unused-import error for `lastActivityByIdAtom`/`refreshSubagents`/`scheduleSubagents`/`dropSubagents`).

- [ ] **Step 5: Existing subagent tests still green**

Run: `npx vitest run frontend/app/view/agents/subagentcorrelate.test.ts`
Expected: PASS (nothing about correlation changed).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/subagenttracking.ts frontend/app/view/agents/agenttree.tsx
git commit -m "refactor(agents): extract useSubagentTracking; tree consumes it"
```

---

## Track A — #5 child-file "done" signal

### Task 3: Backend — detect a terminated child and carry `Done`

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go:660-665` (`SubagentFileInfo`)
- Modify: `pkg/wshrpc/wshserver/transcript.go` (add `lastRecordTerminal`; wire into `listSubagents` at line 255-263)
- Test: `pkg/wshrpc/wshserver/transcript_test.go`
- Regenerated (do not hand-edit): `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Add the `Done` field**

In `wshrpctypes.go`, replace `SubagentFileInfo` (lines 660-665):

```go
type SubagentFileInfo struct {
	AgentId        string `json:"agentid"`
	TranscriptPath string `json:"transcriptpath"`
	FirstPrompt    string `json:"firstprompt"`
	StartedAtMs    int64  `json:"startedatms"`
	Done           bool   `json:"done"` // last record is a terminal assistant turn (finished; outcome unknown)
}
```

- [ ] **Step 2: Write the failing Go test**

Add to `transcript_test.go` (ensure `strings` is imported in the file — it is used elsewhere):

```go
func TestSubagentDoneSignal(t *testing.T) {
	dir := t.TempDir()
	parent := filepath.Join(dir, "sess.jsonl")
	if err := os.WriteFile(parent, []byte(`{"type":"user"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	subdir := filepath.Join(dir, "sess", "subagents")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeRecs := func(id string, recs ...string) {
		if err := os.WriteFile(filepath.Join(subdir, "agent-"+id+".jsonl"), []byte(strings.Join(recs, "\n")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// terminated: last record is an assistant text turn
	writeRecs("done1",
		`{"agentId":"done1","type":"user","message":{"content":"Explore"}}`,
		`{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"result"}]}}`)
	// live: last record is a pending tool_use
	writeRecs("live1",
		`{"agentId":"live1","type":"user","message":{"content":"Plan"}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}`)

	infos, err := listSubagents(parent)
	if err != nil {
		t.Fatal(err)
	}
	byId := map[string]wshrpc.SubagentFileInfo{}
	for _, in := range infos {
		byId[in.AgentId] = in
	}
	if !byId["done1"].Done {
		t.Errorf("done1: want Done=true")
	}
	if byId["live1"].Done {
		t.Errorf("live1: want Done=false (pending tool_use)")
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestSubagentDoneSignal -v`
Expected: FAIL (`Done` is always false — `lastRecordTerminal` not wired yet).

- [ ] **Step 4: Implement `lastRecordTerminal` and wire it in**

In `transcript.go`, add near `firstPromptOf` (after line 236):

```go
// lastRecordTerminal reports whether the transcript's last record is a terminal assistant turn: an
// assistant message with a text block and no pending tool_use. Verified 2026-07-10 across 619 real
// subagent files — a finished child always ends this way (end_turn/stop_sequence); a live child's last
// record is a pending tool_use or a mid-flight tool_result. Read error / no records / non-assistant -> false.
func lastRecordTerminal(path string) bool {
	tail, err := readTranscriptTail(path, 1)
	if err != nil || len(tail) == 0 {
		return false
	}
	var rec struct {
		Type    string `json:"type"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(tail[0]), &rec) != nil || rec.Type != "assistant" {
		return false
	}
	var blocks []struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(rec.Message.Content, &blocks) != nil {
		return false
	}
	hasText := false
	for _, b := range blocks {
		if b.Type == "tool_use" {
			return false // a tool call awaits its result: still working
		}
		if b.Type == "text" {
			hasText = true
		}
	}
	return hasText
}
```

In `listSubagents`, set the field on each info (after line 259, before the `os.Stat` block):

```go
		info := wshrpc.SubagentFileInfo{
			AgentId:        strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "agent-"), ".jsonl"),
			TranscriptPath: path,
			FirstPrompt:    firstPromptOf(head[0]),
			Done:           lastRecordTerminal(path),
		}
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestSubagentDoneSignal -v`
Expected: PASS. Also run the existing suite: `go test ./pkg/wshrpc/wshserver/ -run TestListSubagents -v` → PASS (the added field defaults false; `FirstPrompt`/`TranscriptPath` unchanged).

- [ ] **Step 6: Regenerate TS bindings**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` `SubagentFileInfo` now has `done: boolean`.

- [ ] **Step 7: Verify Go build + tsc**

Run: `go build ./pkg/...` → exit 0.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0 (the new required `done` field will fail the `subagentcorrelate.test.ts` factory — that is fixed in Task 4; if running tasks in order, tsc is clean because the factory has no `done` yet only errors once consumed. If tsc flags the test factory now, proceed to Task 4 which fixes it, then re-run).

> Note: `done: boolean` is a required field on `SubagentFileInfo`. The only place a `SubagentFileInfo` is *constructed* in TS is the `file()` test factory (Task 4 Step 1 adds `done: false`). Production code only *reads* the type (RPC return), so nothing else breaks. Sequence Task 4 immediately after.

- [ ] **Step 8: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/transcript.go pkg/wshrpc/wshserver/transcript_test.go frontend/types/gotypes.d.ts
git commit -m "feat(agentask): tail-read a subagent's done signal into SubagentFileInfo"
```

---

### Task 4: Pure — resolve orphan-but-terminated children to `done`

**Files:**
- Modify: `frontend/app/view/agents/subagentcorrelate.ts:39-45`
- Test: `frontend/app/view/agents/subagentcorrelate.test.ts:13-19, 32-35`

- [ ] **Step 1: Update the test factory + write the failing tests**

In `subagentcorrelate.test.ts`, add `done` to the `file()` factory default (line 13-19):

```ts
const file = (over: Partial<SubagentFileInfo>): SubagentFileInfo => ({
    agentid: "a1",
    transcriptpath: "/p/agent-a1.jsonl",
    firstprompt: "look at X",
    startedatms: 1,
    done: false,
    ...over,
});
```

Replace the existing "maps a running (or unmatched) file to working" test (lines 32-35) with these three — an orphan is now `working` only while unfinished, and `done` once its file terminates:

```ts
    it("maps a matched running spawn to working", () => {
        expect(correlateSubagents([spawn({ done: false })], [file({})])[0].state).toBe("working");
    });

    it("maps an unmatched, unfinished file to working", () => {
        expect(correlateSubagents([], [file({ firstprompt: "orphan", done: false })])[0].state).toBe("working");
    });

    it("maps an unmatched, terminated file to the neutral done state", () => {
        expect(correlateSubagents([], [file({ firstprompt: "orphan", done: true })])[0].state).toBe("done");
    });
```

- [ ] **Step 2: Run to verify the new done test fails**

Run: `npx vitest run frontend/app/view/agents/subagentcorrelate.test.ts`
Expected: FAIL on "maps an unmatched, terminated file to the neutral done state" (current code returns `working` for any unmatched file).

- [ ] **Step 3: Implement the fallback**

In `subagentcorrelate.ts`, add a helper above `correlateSubagents` and use it in the `.map`. Replace the map body (lines 39-45):

```ts
// state resolution: a matched spawn's parent tool_result is authoritative (working/failure/success).
// An orphan (no matching spawn) has no parent accept/reject signal, so the child file tells us only
// whether it *finished* — a terminated orphan is the neutral "done", never a green success.
function resolveState(spawn: SubagentSpawn | undefined, fileDone: boolean): SubagentVM["state"] {
    if (spawn != null) {
        return !spawn.done ? "working" : spawn.failed ? "failure" : "success";
    }
    return fileDone ? "done" : "working";
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
        return { id: f.agentid, type, state: resolveState(spawn, f.done), transcriptPath: f.transcriptpath };
    });
}
```

(Add `import type { SubagentVM } from "./session-models/sessionviewmodel";` is already present line 14; `SubagentSpawn` import already present line 15.)

- [ ] **Step 4: Run to verify all pass**

Run: `npx vitest run frontend/app/view/agents/subagentcorrelate.test.ts`
Expected: PASS (all cases, including the two unchanged matched-spawn tests).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/subagentcorrelate.ts frontend/app/view/agents/subagentcorrelate.test.ts
git commit -m "feat(agents): resolve terminated orphan subagents to done"
```

---

## Track B — #3 retire the vestigial hook path

### Task 5: Migrate the details rail to the disk store

**Files:**
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx` (import line 29; consumer line 56)

The rail renders inside the focused view, where `AgentTree`'s `useSubagentTracking` already populates `subagentsByIdAtom[agent.id]`. No load needed — just read the disk atom.

- [ ] **Step 1: Swap the source**

In `agentdetailsrail.tsx`, replace line 56:

```tsx
    const subs = useAtomValue(subagentsByIdAtom)[agent.id] ?? [];
```

- [ ] **Step 2: Fix imports**

Remove the `getSubagentsAtom` import (line 29). Add:

```tsx
import { subagentsByIdAtom } from "./subagentsstore";
```

(If `getSubagentsAtom` was the only symbol imported from `./session-models/agentstatusstore` on that line, delete the whole import line.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/agentdetailsrail.tsx
git commit -m "refactor(agents): rail reads disk-backed subagents"
```

---

### Task 6: Migrate the Runs orchestrator subagent rows to the disk store

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx` (import; `PhaseRail` at line 307; `SubagentRows` at line 284-305)

`SubagentRows` is rendered `leadId={w.id}` where `w` is a worker `AgentVM` (line 349) that carries `w.transcriptPath`. Load the run's workers via the shared hook at the `PhaseRail` level (a hook cannot be called inside the phases `.map`), then read the disk atom in `SubagentRows`.

- [ ] **Step 1: Add imports**

In `runssurface.tsx`, add:

```tsx
import { subagentsByIdAtom } from "./subagentsstore";
import { useSubagentTracking } from "./subagenttracking";
```

Remove the `getSubagentsAtom` import (line 36) if it becomes unused after Step 3 (it will).

- [ ] **Step 2: Load workers in `PhaseRail`**

In `PhaseRail` (line 307), after `const phases = run.phases ?? [];`, collect every phase's workers and track them — but only for orchestrator runs, which are the only ones that render `SubagentRows`:

```tsx
    const phases = run.phases ?? [];
    const trackedWorkers = isOrchestrator(run) ? phases.flatMap((p) => phaseWorkers(p, agents)) : [];
    useSubagentTracking(trackedWorkers);
```

(`phaseWorkers`, `isOrchestrator`, and `agents` are already in scope in this component.)

- [ ] **Step 3: Read the disk atom in `SubagentRows`**

Replace the `SubagentRows` body (line 285):

```tsx
    const subs = useAtomValue(subagentsByIdAtom)[leadId] ?? [];
```

The rest of `SubagentRows` (the `if (subs.length === 0) return null;` and the row map, including the `s.state === "done"` dot added in Task 1) is unchanged.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (no unused `getSubagentsAtom`).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/runssurface.tsx
git commit -m "refactor(runs): orchestrator subagent rows read the disk store"
```

---

### Task 7: Delete the vestigial hook subagent path

**Files:**
- Modify: `frontend/app/view/agents/session-models/agentstatusstore.ts`
- Modify: `frontend/app/view/agents/session-models/sessionviewmodel.ts`
- Modify: `frontend/app/view/agents/session-models/sessionsidebarmodel.ts` (import line 17; line 79)
- Modify: `pkg/baseds/baseds.go` (lines 42-57, 88)
- Modify: `cmd/wsh/cmd/wshcmd-agenthook.go`
- Regenerated: `frontend/types/gotypes.d.ts`

Only the subagent-*delta* path retires. Keep: usage/rate-limit emission, parent `state`/resume emission, and the expand atoms (`getSubagentExpandAtom`/`toggleSubagentExpand` — the disk tree uses them).

- [ ] **Step 1: Frontend — `agentstatusstore.ts`**

Remove `getSubagentsAtom`, `subagentAtoms`, `scheduleSubagentExpiry`, `normalizeSubagentStatus`, `COMPLETED_SUBAGENT_TTL_MS`, and the `reduceSubagents`/`SubagentDelta` names from the import. Change the import (line 7) to:

```ts
import { type SubagentVM } from "./sessionviewmodel";
```

(`SubagentVM` is still referenced by the expand atoms' types? No — after removing `getSubagentsAtom` it is not. If tsc reports `SubagentVM` unused, drop it from the import entirely and delete line 7.)

Delete `COMPLETED_SUBAGENT_TTL_MS` (line 11-12), `getSubagentsAtom` + `subagentAtoms` (lines 57-67), `normalizeSubagentStatus` (lines 88-96), and `scheduleSubagentExpiry` (lines 98-107). **Keep** `getAgentStatusAtom`, `getAgentUsageAtom`, `normalizeAgentUsage`, `invertPct`, and `getSubagentExpandAtom`/`toggleSubagentExpand`/`subagentExpandAtoms`.

In `setupAgentStatusSubscription`, delete the entire `if (data.subagent != null) {…}` block (lines 122-138), and inside the `if (data.state)` branch delete the idle-clear of the subagent list (the `if (data.state === "idle") { … getSubagentsAtom … }` at lines 151-155) — but **keep** clearing the expand override on idle. The `data.state` branch becomes:

```ts
            // a delta-only event carries an empty state; only a real state update should touch the parent atom
            if (data.state) {
                globalStore.set(getAgentStatusAtom(data.oref), data);
                // resume-on-reopen: bake this Claude session's --resume key into the block's launch command
                void persistClaudeResume(data.oref, data.agent, data.transcriptpath);
                if (data.state === "idle") {
                    // turn ended: reset the manual subagent-expand override (disk-backed list persists)
                    globalStore.set(getSubagentExpandAtom(data.oref), undefined);
                }
            }
```

- [ ] **Step 2: Frontend — `sessionviewmodel.ts`**

Delete `SubagentDelta` (lines 24-30) and `reduceSubagents` (lines 260-278). **Keep** `SubagentVM`, `SubagentState`, `rollUpStatus`, `subagentExpanded`.

- [ ] **Step 3: Frontend — `sessionsidebarmodel.ts`**

Remove `getSubagentsAtom` from the import (line 17) — keep `getAgentStatusAtom`, `getSubagentExpandAtom`. Delete line 79 (`subagents = get(getSubagentsAtom(termBlockOref));`). `subagents` stays the initialized `[]`; line 80's `subagentExpanded([], …)` correctly returns false.

- [ ] **Step 4: Frontend typecheck (catches every dangling reference)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. Any remaining `getSubagentsAtom`/`reduceSubagents`/`SubagentDelta` reference surfaces here — resolve before moving on.

- [ ] **Step 5: Backend — `baseds.go`**

Delete the `SubagentAction_*` and `SubagentStatus_*` const groups (lines 42-47), the `AgentSubagentDelta` struct (lines 50-57), and the `Subagent *AgentSubagentDelta` field on `AgentStatusData` (line 88). Fix the neighboring comment at line 62 if it references `AgentSubagentDelta` (reword to reference the activity/usage delta it actually describes, or drop the comparison clause).

- [ ] **Step 6: Backend — `wshcmd-agenthook.go`**

- Remove the `Subagent *baseds.AgentSubagentDelta` field from `agentEmission` (line 39) and reword the comment (lines 32-34) to drop the "Subagent" clause.
- Delete the `SubagentStop` case (lines 52-56) — it only emitted the subagent stop; removed, `SubagentStop` falls through to the final `return agentEmission{}` (a clean no-op).
- In the `Task` case (lines 60-68), drop the subagent-start block; it becomes:

```go
		case "Task":
			return agentEmission{State: baseds.AgentState_Working, AttachModelTitle: true}
```

- Change the emit guard (line 317) to:

```go
	if em.State == "" {
```

- Delete the `if em.Subagent != nil {…}` publish block (lines 355-363).

- [ ] **Step 7: Regenerate + backend build**

Run: `task generate` (drops `subagent`/`AgentSubagentDelta` from `gotypes.d.ts`).
Run: `go build ./pkg/... ./cmd/...`
Expected: exit 0.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (the regenerated `AgentStatusData` no longer has `subagent`; nothing should reference it after Step 1).

- [ ] **Step 8: Full test sweep (no regressions)**

Run: `go test ./pkg/...` → PASS.
Run: `npx vitest run frontend/app/view/agents/` → PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/app/view/agents/session-models/agentstatusstore.ts frontend/app/view/agents/session-models/sessionviewmodel.ts frontend/app/view/agents/session-models/sessionsidebarmodel.ts pkg/baseds/baseds.go cmd/wsh/cmd/wshcmd-agenthook.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "refactor(agents): remove the vestigial hook subagent-delta path"
```

---

## Track C — #1 cockpit-card fan-out badge

### Task 8: Load subagents in the grid + render the badge/peek

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (import; component body near line 218)
- Modify: `frontend/app/view/agents/agentrow.tsx` (imports; a new `FanoutBadge` + `SUB_COLOR`; render near line 352)

- [ ] **Step 1: Populate the store from the grid**

In `cockpitsurface.tsx`, add the import:

```tsx
import { useSubagentTracking } from "./subagenttracking";
```

In the `CockpitSurface` component, right after `const agents = useAtomValue(model.agentsAtom);` (line 218), add:

```tsx
    useSubagentTracking(agents);
```

- [ ] **Step 2: Card imports + `SUB_COLOR`**

In `agentrow.tsx`, add imports:

```tsx
import { subagentsByIdAtom } from "./subagentsstore";
import type { SubagentState, SubagentVM } from "./session-models/sessionviewmodel";
```

Add a module-level color map (mirrors `agenttree.tsx`, matching this file's token style) near the top-level constants:

```tsx
const SUB_COLOR: Record<SubagentState, string> = {
    working: "var(--color-accent)",
    success: "var(--color-success)",
    failure: "var(--color-error)",
    done: "var(--color-muted)",
};
```

- [ ] **Step 3: Add the `FanoutBadge` component**

Add to `agentrow.tsx` (a small read-only badge + hover peek; reuses the already-imported `PopoverReveal`):

```tsx
// A ⑃ N fan-out badge for the cockpit card: count of the agent's subagents, with a hover peek listing
// each child's type + state dot. Read-only; clicking opens the focused view (where the tree/interior live).
function FanoutBadge({ subs, onOpen }: { subs: SubagentVM[]; onOpen: () => void }) {
    const [peek, setPeek] = useState(false);
    return (
        <div className="relative shrink-0" onMouseEnter={() => setPeek(true)} onMouseLeave={() => setPeek(false)}>
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    onOpen();
                }}
                title={`${subs.length} subagent${subs.length === 1 ? "" : "s"}`}
                className="flex cursor-pointer items-center gap-1 rounded-[5px] border border-edge-mid px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-muted hover:border-accent hover:text-accent-soft"
            >
                <span className="text-[10px] leading-none">⑃</span>
                {subs.length}
            </button>
            <PopoverReveal
                open={peek}
                origin="top right"
                className="absolute right-0 top-[24px] z-30 w-[212px] rounded-[9px] border border-edge-strong bg-surface-raised p-2 shadow-[0_14px_36px_rgba(0,0,0,0.5)]"
            >
                <div className="flex flex-col gap-1">
                    {subs.map((s) => (
                        <div key={s.id} className="flex items-center gap-2">
                            <span className="h-[5px] w-[5px] shrink-0 rounded-full" style={{ background: SUB_COLOR[s.state] }} />
                            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-secondary">{s.type || "subagent"}</span>
                            <span className="font-mono text-[9px] text-muted">{s.state}</span>
                        </div>
                    ))}
                </div>
            </PopoverReveal>
        </div>
    );
}
```

- [ ] **Step 4: Read the atom + render the badge in the header**

In `AgentRow`, near the other atom reads (after line 217 `const diff = useAtomValue(diffStatsByIdAtom)[agent.id];`), add:

```tsx
    const subs = useAtomValue(subagentsByIdAtom)[agent.id] ?? [];
```

In the header control row, render the badge just before the diff button (before line 339's `{diff ? (`):

```tsx
                {subs.length > 0 ? <FanoutBadge subs={subs} onOpen={onOpen} /> : null}
```

(`onOpen` is an existing `AgentRow` prop — line 120 — that opens the focused view.)

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Card tests still green**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: PASS (no view-model behavior changed).

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/agents/agentrow.tsx
git commit -m "feat(agents): cockpit-card fan-out badge + peek"
```

---

## Track D — closeout

### Task 9: Update deferred.md + live CDP verification

**Files:**
- Modify: `docs/deferred.md` (the 2026-07-09 "Subagent interior view — v1 exclusions" entry)

- [ ] **Step 1: Record the outcomes in deferred.md**

Under the 2026-07-09 entry, mark items 1/3 done and 4/5 closed, and correct the two stale claims. Append:

```markdown
**Update 2026-07-10 (subagent-tree-followups):** items 1, 3, and the state half of 5 shipped
(spec/plan `docs/superpowers/{specs,plans}/2026-07-10-subagent-tree-followups.md`).
- **#1 fan-out badge** — `⑃ N` + hover peek on `agentrow.tsx`, fed by `subagentsByIdAtom` via the
  extracted `useSubagentTracking` hook (also used by the cockpit grid and the Runs surface).
- **#5 done signal** — the backend tail-reads a child's last record (`lastRecordTerminal`) into
  `SubagentFileInfo.Done`; `correlateSubagents` resolves a terminated *orphan* (no parent Task
  `tool_result`) to a new neutral **`done`** state instead of a perpetual "working". Success/failure is
  still only knowable for matched children — `done` is deliberately outcome-neutral.
- **#3 hook path retired** — the rail and Runs orchestrator rows now read the disk store; the
  `AgentSubagentDelta` emission (`wshcmd-agenthook.go`), the `agentstatusstore` reducer/TTL/idle-clear,
  `getSubagentsAtom`, and `baseds.AgentSubagentDelta` are deleted. Correction: `getSubagentsAtom` was
  **not** a dead export (it was live in the rail + Runs) — this migrated then removed it.
- **#4 deep nesting — CLOSED (no-go).** 0 nested `subagents/*/subagents` dirs across 619 real child
  files; CC writes a flat layout. Reopen only if a nested child file is observed.
- **#2 Codex subagents — remains no-go** (no per-subagent files).
```

- [ ] **Step 2: Rebuild the backend for live verification**

The `Done` field + hook deletion live in `wavesrv`. Per memory (dev status reporter routes `wsh` to the packaged Wave), verify in a packaged build or with the dev terminal's `wsh` pointed at the dev wavesrv.

Run: `task build:backend`
Then run the app: `tail -f /dev/null | task dev` (headless `task dev` dies on stdin EOF — see CLAUDE.md).

- [ ] **Step 3: Verify the fan-out badge (#1)**

Drive a real Claude agent that spawns subagents (or inject: `node scripts/inject-live-agents.mjs <scenario>`). On the cockpit grid, confirm:
1. A card with subagents shows the `⑃ N` badge with the right count.
2. Hovering the badge opens the peek listing each child (type + state dot).
3. Clicking the badge opens the focused view for that agent.

Capture: `node scripts/cdp-shot.mjs subagent-fanout-badge.png`

- [ ] **Step 4: Verify the done signal (#5)**

Open the focused view for an agent whose spawn has no parent Task match (a workflow/Workflow-tool run, if available) after its child transcript has finished. Confirm the child row shows the neutral **done** dot/label, not a stuck "working". (If no orphan run is reproducible, confirm the matched children still show correct ✓/✗ — no regression.)

Capture: `node scripts/cdp-shot.mjs subagent-done-state.png`

- [ ] **Step 5: Verify #3 migration — no regression**

Confirm the details rail still lists subagents (focused view) and the Runs orchestrator still nests subagent rows under a lead. Both now read the disk store.

- [ ] **Step 6: Commit**

```bash
git add docs/deferred.md
git commit -m "docs(deferred): record subagent-tree follow-ups (1/3/5 shipped, 2/4 closed)"
```

---

## Self-review

**Spec coverage:**
- Neutral `done` state (spec §3, §5a) → Task 1. ✓
- `useSubagentTracking` extraction (spec §5b) → Task 2. ✓
- #5 backend done-signal (spec §6) → Task 3. ✓
- #5 `correlateSubagents` orphan fallback (spec §6) → Task 4. ✓
- #3 rail migration (spec §7) → Task 5. ✓
- #3 Runs migration (spec §7, flagged risk resolved) → Task 6. ✓
- #3 surgical deletion (spec §7) → Task 7. ✓
- #1 grid load + card badge/peek (spec §8) → Task 8. ✓
- Out-of-scope #2/#4 closed with evidence (spec §9) → Task 9 Step 1. ✓
- Testing: pure (Tasks 2,4), backend (Task 3), build gates (Task 7), CDP (Task 9) — matches spec §10. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows the full edit. The one plan-time verification (whether `agentstatusstore`'s `SubagentVM` import is still needed after deletion — Task 7 Step 1) is resolved by tsc, with the concrete fallback stated inline.

**Type consistency:** `SubagentState` gains `done` (Task 1) and every `Record<SubagentState, …>` map is updated (Tasks 1, 8). `SubagentFileInfo.Done` (Go `Done bool` / TS `done: boolean`, Task 3) is defaulted in the test factory and consumed as `f.done` in `resolveState` (Task 4). `useSubagentTracking(agents: {id, transcriptPath?}[])` is called with `AgentVM[]` in all three consumers (Tasks 2, 6, 8). `subagentsByIdAtom` keyed by `agent.id`/`leadId`/`w.id` consistently. `getSubagentExpandAtom`/`toggleSubagentExpand` are explicitly kept in Task 7; `getSubagentsAtom`/`reduceSubagents`/`SubagentDelta`/`AgentSubagentDelta` are fully removed.
