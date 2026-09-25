# Steering Sync Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce steering sync to its one job: copying the vault `AGENTS.md` into each harness between the `ARC-STEERING` markers. Delete the per-harness own-rules editing, the legacy `ARC-MEMORY` handling, the fold, and the UI built on them.

**Architecture:** `pkg/agentsync` keeps `applyRegion`/`steeringState` and the markers. It loses the memory-marker branch and every helper that split a harness file into own/shared/memory zones. Four RPCs go: harness read, harness write, drop memory and fold. The status RPC gains each harness's `path`, which is all the Setup surface still needs per harness. The Instructions tab becomes the shared-doc editor next to a read-only list of harness rows.

**Tech Stack:** Go (`pkg/agentsync`, `pkg/wshrpc`, `cmd/wsh`), React 19 + jotai (`frontend/app/view/agents/setup*`), vitest, CDP scenario harness.

**Spec:** none. Decided in conversation on 2026-09-25 and recorded below. The 2026-09-07 and 2026-09-08 harness-sync specs describe the own/memory/fold model this plan removes. They are history; do not update them.

## Context

- The vault steering doc is `C:\Users\kael02\IdeaProjects\obsidian_vault\steering\AGENTS.md` (`memroots.SteeringDocPath()`). The purpose of sync is one-way: edit the vault doc, and every harness gets it. No harness needs rules of its own. Every harness file on disk today starts with `ARC-STEERING:BEGIN` at line 1.
- The markers stay, for two reasons. The "generated — do not edit; managed by Arc" line points agents and people at the vault. And it keeps the installed Arc and this build writing the same file format, so there is no rollout hazard.
- `~/.codex/AGENTS.md` and `~/.config/opencode/AGENTS.md` still carry a leftover `ARC-MEMORY` block (lines 65–765) that nothing writes since memvault was removed (`7a4c0c18`). Task 3 removes those blocks once, by hand, instead of keeping code for them.
- Sync (`agentsync.Apply`) runs on every agent launch (`frontend/app/cockpit/cockpit-actions.ts:83`) and on every shared-doc save in Setup. Both paths are unchanged.

## Global Constraints

- The on-disk format is unchanged: the same `steeringBegin`/`steeringEnd` strings and the same `renderRegion` output. The installed Arc and this build must produce byte-identical files.
- Text outside the markers is never touched by a sync (unchanged behavior).
- A harness is written only when its config root exists. Arc never creates one (unchanged).
- Never hand-edit generated files. The one exception is the `wshclient.go` bootstrap in Task 1 Step 6 (see memory `task-generate-cannot-bootstrap-renamed-rpc`).
- Work on branch `refactor/steering-sync-cleanup`. The main checkout often holds other sessions' uncommitted edits, so stage only the files this plan lists. If another session is active in the main checkout, use a worktree (AGENTS.md "Worktrees (Windows)").

## Review Focus

1. A file still carrying an old `ARC-MEMORY` block (codex/opencode until Task 3 cleans them): its region must still be replaced in place, idempotently, with the memory text untouched. Pinned by the kept `TestApplyRegionReplacesInPlaceAndIsIdempotent`, whose fixture is exactly that shape.
2. A hand-written file with no region: sync appends the region and keeps the text. Pinned by the kept `TestApplyRegionAppendsWhenAbsent`.
3. A harness that is not installed still reports its path, so its row in Setup shows where the file would go. Pinned in Task 1 Step 1.
4. A blank shared doc reads as not written for every harness, never as in sync. Pinned by the `absent` row test in Task 2 Step 1 (`steeringState` already returns `absent` for a blank doc).
5. Harness rows must agree with `wsh agent-sync status`. Both read the same `steeringState`. Checked live in Task 3.

---

### Task 1: Backend: delete own/memory/fold, add path to status

**Files:**
- Modify: `pkg/agentsync/steering.go`
- Modify: `pkg/agentsync/agentsync.go`
- Modify: `pkg/agentsync/status.go`
- Modify: `pkg/agentsync/adopt.go:17-19` (comment only)
- Modify: `pkg/wshrpc/wshrpctypes_agentsync.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_agentsync.go`
- Modify: `cmd/wsh/cmd/wshcmd-agentsync.go`
- Regenerate: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`
- Test: `pkg/agentsync/steering_test.go`, `pkg/agentsync/agentsync_test.go`, `pkg/agentsync/status_test.go`

**Interfaces:**
- Keeps unchanged: `applyRegion(existing, body string) string`, `renderRegion`, `steeringState(existing, shared string) string` (returns `"current" | "stale" | "absent"`), `projectSteering`, `Apply`, `WriteSteering`.
- Produces: `HarnessStatus.Path string` (`json:"path"`), which replaces `HarnessStatus.Own`.
- Produces: `wshrpc.AgentSyncHarness.Path string` (`json:"path"`), which replaces `Own`. In TS: `AgentSyncHarness.path: string`, and `own` is gone.
- Removes: `memoryBeginMarker`, `blockBefore`, `memoryRegion`, `joinOwn`, `regionBody`, `foldBlock`, `carriedLines`, `HarnessDoc`, `ReadHarness`, `WriteHarnessOwn`, `DropMemory`, `FoldResult`, `FoldIntoShared`, and the RPCs `AgentSyncHarnessReadCommand`, `AgentSyncHarnessWriteCommand`, `AgentSyncHarnessDropMemoryCommand` and `AgentSyncFoldCommand` together with their `Command*Data`/`*RtnData` types.

- [ ] **Step 1: Write the failing status test and prune the tests of deleted code**

In `pkg/agentsync/status_test.go`, delete `TestStatusReportsAHarnessHoldingItsOwnRules` (lines 70–97). In `TestStatusReportsSteeringState`, after the `pi` check (line 31), add:

```go
	if got := byRuntime()["codex"]; got.Path != filepath.Join(p.Home, ".codex", "AGENTS.md") {
		t.Fatalf("codex path = %q, want its steering file", got.Path)
	}
	if got := byRuntime()["pi"]; got.Path == "" {
		t.Fatalf("pi is not installed but its row still needs a path: %+v", got)
	}
```

In `pkg/agentsync/steering_test.go`:
- Delete `TestApplyRegionInsertsBeforeMemoryRegion` (lines 23–34).
- Delete every test from line 51 to the end of the file (`TestBlockBefore…` through `TestReadHarnessDoesNotCarry…`).
- Reduce the import block to `"strings"` and `"testing"`, because `path/filepath` and `reflect` were used only by the deleted tests.
- Keep `TestApplyRegionAppendsWhenAbsent` and `TestApplyRegionReplacesInPlaceAndIsIdempotent` byte-identical.

In `pkg/agentsync/agentsync_test.go`:
- Delete `TestProjectSteeringInsertsBeforeExistingMemoryRegion` (lines 68–88).
- Delete the four `TestDropMemory*` tests (line 121 to the end of the file).
- Remove `"strings"` from the imports; nothing left in the file uses it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/agentsync/`
Expected: build failure, `got.Path undefined (type HarnessStatus has no field or method Path)`.

- [ ] **Step 3: Delete the zone helpers from `steering.go`**

In `pkg/agentsync/steering.go`:
- Delete the `memoryBeginMarker` constant.
- Delete `blockBefore`, `memoryRegion`, `joinOwn`, `regionBody`, `foldBlock` and `carriedLines`. What remains is the two marker constants, `renderRegion`, `applyRegion` and `steeringState`.
- Replace `applyRegion` and its comment with:

```go
// applyRegion returns existing with the ARC-STEERING region set to body. Content outside the markers
// is untouched; a file with no region gets one appended.
func applyRegion(existing, body string) string {
	region := renderRegion(body)
	if start := strings.Index(existing, steeringBegin); start >= 0 {
		rest := existing[start:]
		if endIdx := strings.Index(rest, steeringEnd); endIdx >= 0 {
			tail := rest[endIdx+len(steeringEnd):]
			return existing[:start] + region + strings.TrimPrefix(tail, "\n")
		}
	}
	if strings.TrimSpace(existing) == "" {
		return region
	}
	return strings.TrimRight(existing, "\n") + "\n\n" + region
}
```

- [ ] **Step 4: Delete the harness-file API and add the path to status**

In `pkg/agentsync/agentsync.go`:
- Delete everything from the `HarnessDoc` comment (line 119) to the end of the file: `HarnessDoc`, `ReadHarness`, `WriteHarnessOwn`, `DropMemory`, `FoldResult` and `FoldIntoShared`.
- Remove `"strings"` from the imports; nothing left uses it.
- In `projectSteering`, change the comment `// nothing canonical yet; adoption seeds it` to `// nothing canonical yet`.

In `pkg/agentsync/status.go`:
- In `HarnessStatus`, replace the `Own` field and its comment (lines 21–22) with:

```go
	// Path is the harness's steering file, whether or not it exists yet.
	Path string `json:"path"`
```

- Replace lines 37–43 (the `st := ...` line through the closing brace of `if st.Present`) with:

```go
		st := HarnessStatus{Runtime: spec.Runtime, Label: spec.Label, Steering: "absent", Path: spec.SteeringPath(p.Home)}
		st.Present = configRootExists(spec, p.Home)
		if st.Present {
			existing, _ := os.ReadFile(st.Path)
			st.Steering = steeringState(string(existing), string(canonicalBody))
		}
```

In `pkg/agentsync/adopt.go`, replace lines 17–19 with:

```go
// Adoption brings a harness's hand-maintained skill directories into the vault.
```

- [ ] **Step 5: Run the package tests**

Run: `go test ./pkg/agentsync/`
Expected: PASS.

- [ ] **Step 6: Remove the four RPCs and regenerate**

In `pkg/wshrpc/wshrpctypes_agentsync.go`:
- Delete the interface lines `AgentSyncHarnessReadCommand`, `AgentSyncHarnessWriteCommand`, `AgentSyncHarnessDropMemoryCommand` and `AgentSyncFoldCommand`.
- Delete the types `CommandAgentSyncHarnessReadData`, `CommandAgentSyncHarnessReadRtnData` (and its comment), `CommandAgentSyncHarnessWriteData`, `CommandAgentSyncHarnessWriteRtnData`, `CommandAgentSyncHarnessDropMemoryData`, `CommandAgentSyncHarnessDropMemoryRtnData`, `CommandAgentSyncFoldData` and `CommandAgentSyncFoldRtnData`.
- In `AgentSyncHarness`, replace the `Own` field and its comment with `Path string \`json:"path"\``, placed after `Label`.

In `pkg/wshrpc/wshserver/wshserver_agentsync.go`:
- Delete the handlers `AgentSyncHarnessReadCommand`, `AgentSyncHarnessWriteCommand`, `AgentSyncHarnessDropMemoryCommand` and `AgentSyncFoldCommand`.
- In `AgentSyncStatusCommand`, change `Steering: r.Steering, Own: r.Own,` to `Path: r.Path, Steering: r.Steering,`.

In `cmd/wsh/cmd/wshcmd-agentsync.go`:
- Delete `agentSyncFoldCmd` (lines 38–45) and `agentSyncFoldRun` (lines 113–129), and remove `agentSyncFoldCmd` from the `AddCommand` call.
- Delete the `if h.Own { ... }` block (lines 83–85).

Bootstrap the generator. `cmd/generatets` imports `wshclient`, which will not compile while it still names the deleted types. Delete the four generated functions `AgentSyncFoldCommand`, `AgentSyncHarnessDropMemoryCommand`, `AgentSyncHarnessReadCommand` and `AgentSyncHarnessWriteCommand`, each with its `// command "..."` comment line, from `pkg/wshrpc/wshclient/wshclient.go`. Then run:

Run: `task generate`
Expected: exit 0. `git diff --stat` then shows `wshclientapi.ts` losing four methods, and `gotypes.d.ts` losing eight types while `AgentSyncHarness` gains `path` and loses `own`.

- [ ] **Step 7: Build and test everything Go touched**

Run: `go build ./... && go vet ./pkg/agentsync/ ./pkg/wshrpc/... ./cmd/wsh/... && go test ./pkg/agentsync/ ./pkg/wshrpc/... ./cmd/wsh/...`
Expected: all PASS. Then run `gofmt -l pkg/agentsync pkg/wshrpc/wshrpctypes_agentsync.go pkg/wshrpc/wshserver/wshserver_agentsync.go cmd/wsh/cmd/wshcmd-agentsync.go`, which should print nothing.

The frontend does not typecheck yet (Task 2 fixes it). No commit here; the plan commits once, at the end.

---

### Task 2: Setup surface: shared editor plus read-only harness rows

**Depends on:** Task 1

**Files:**
- Modify: `frontend/app/view/agents/setupmodel.ts`
- Modify: `frontend/app/view/agents/setupstore.ts`
- Modify: `frontend/app/view/agents/setupsurface.tsx`
- Test: `frontend/app/view/agents/setupmodel.test.ts`

**Interfaces:**
- Consumes: `AgentSyncHarness` with `path` and `steering` (`"current" | "stale" | "absent"`), and `CommandAgentSyncStatusRtnData.harnesses`.
- Produces: `harnessRowState(h: Pick<AgentSyncHarness, "present" | "steering">): HarnessRowState`, where `HarnessRowState = "in-sync" | "out-of-date" | "not-written" | "not-set-up"`. Also `harnessRowLabel(state)`, `harnessRowTone(state)`, `saveTargetCount(rows)` and `headerStatus(rows)`, all taking `AgentSyncHarness`-shaped rows.
- Removes: `HarnessRow`, `HarnessDoc`, `harnessRows`, `SetupSelection`, `SHARED`, `saveTargetNote`, `isFirstRun`, `FirstRunOffer`, `firstRunOffer`, `MemoryNotice`, `memoryNotices`, `formatSize`, `sharedZoneStatus`, `previewLines` and `joinLabels`. Also the store's `setupSelectionAtom`, `setupDocsAtom`, `setupOwnAtom`, `setupFreshStartAtom`, `selectShared`, `selectHarness`, `startEmptyPage`, `typeOwn`, `discardOwn`, `reloadOwn`, `saveOwn`, `foldIntoShared` and `dropMemory`. Only the `setup*` files import these (checked: `skillsmatrix.ts` imports only `Tone`).

- [ ] **Step 1: Rewrite the model tests**

In `frontend/app/view/agents/setupmodel.test.ts`, replace lines 1–176 (imports through the `sharedZoneStatus` block) with the block below. Keep the `changedLineCount` and `editor conflict transitions` blocks as they are, and delete the `joinLabels` block at the end.

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    changedLineCount,
    editorDiscard,
    editorLoaded,
    editorReload,
    editorSaved,
    editorTyped,
    EMPTY_EDITOR,
    harnessRowLabel,
    harnessRowState,
    headerStatus,
    isDirty,
    saveBaseMtime,
    saveTargetCount,
} from "./setupmodel";

function h(runtime: string, over: Partial<AgentSyncHarness> = {}): AgentSyncHarness {
    return {
        runtime,
        label: runtime.toUpperCase(),
        present: true,
        path: `/h/${runtime}.md`,
        steering: "absent",
        skillsmanaged: 0,
        skillsunmanaged: 0,
        ...over,
    };
}

describe("harnessRowState", () => {
    it("reads a current region as in sync and a stale one as out of date", () => {
        expect(harnessRowState(h("claude", { steering: "current" }))).toBe("in-sync");
        expect(harnessRowState(h("claude", { steering: "stale" }))).toBe("out-of-date");
    });

    it("reads no region, no file or a blank shared doc as not written yet", () => {
        expect(harnessRowState(h("claude", { steering: "absent" }))).toBe("not-written");
        expect(harnessRowLabel("not-written")).toBe("Not written yet");
    });

    it("reads a missing harness as not set up, whatever its file says", () => {
        expect(harnessRowState(h("pi", { present: false, steering: "current" }))).toBe("not-set-up");
        expect(harnessRowLabel("not-set-up")).toBe("Not set up");
    });
});

describe("saveTargetCount", () => {
    it("counts the present harnesses whatever their state", () => {
        const rows = [
            h("claude", { steering: "current" }),
            h("codex", { steering: "stale" }),
            h("opencode", { present: false }),
            h("pi"),
        ];
        expect(saveTargetCount(rows)).toBe(3);
    });
});

describe("headerStatus", () => {
    it("reports no harness when none is set up", () => {
        expect(headerStatus([h("pi", { present: false })])).toEqual({ text: "No harnesses set up", tone: "none" });
    });

    it("reports every present harness in sync", () => {
        const rows = [h("claude", { steering: "current" }), h("pi", { present: false })];
        expect(headerStatus(rows)).toEqual({ text: "1 harness in sync", tone: "ok" });
    });

    it("counts stale and unwritten harnesses as behind the shared doc", () => {
        const rows = [h("claude", { steering: "current" }), h("codex", { steering: "stale" }), h("pi")];
        expect(headerStatus(rows)).toEqual({ text: "2 of 3 harnesses out of date", tone: "warn" });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/setupmodel.test.ts`
Expected: FAIL. Under the old three-argument signature, `harnessRowState(h(...))` reads the missing second argument as "no file read yet" and returns `"no-file"`, and `harnessRowLabel("not-written")` is undefined.

- [ ] **Step 3: Rewrite `setupmodel.ts` down to what the tab still uses**

Replace lines 1–245 of `frontend/app/view/agents/setupmodel.ts` (header through `changedLineCount`) with the block below. Keep the `// ---- editor ... ----` section, but:
- change "The shared doc and a harness's own zone both use it." to "The shared doc uses it."
- change the `editorLoaded` comment's second sentence to "A draft keeps its base and mtime, so an outside edit still surfaces as a conflict on save, unless the text on disk is unchanged and only its mtime moved."
- delete `joinLabels` at the end.

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure derivations behind the Setup surface's Instructions tab: each harness row's state, the header
// status, the save count, and the editor's conflict transitions. setupstore.ts feeds these the agentsync
// RPC results; setupsurface.tsx renders them.

export type HarnessRowState = "in-sync" | "out-of-date" | "not-written" | "not-set-up";

// "absent" covers a missing file, a file with no Arc region, and a blank shared doc: in each case
// the harness does not have the shared instructions yet.
export function harnessRowState(h: Pick<AgentSyncHarness, "present" | "steering">): HarnessRowState {
    if (!h.present) {
        return "not-set-up";
    }
    if (h.steering === "current") {
        return "in-sync";
    }
    if (h.steering === "stale") {
        return "out-of-date";
    }
    return "not-written";
}

export function harnessRowLabel(state: HarnessRowState): string {
    switch (state) {
        case "in-sync":
            return "In sync";
        case "out-of-date":
            return "Out of date";
        case "not-written":
            return "Not written yet";
        case "not-set-up":
            return "Not set up";
    }
}

export type Tone = "ok" | "warn" | "none";

export function harnessRowTone(state: HarnessRowState): Tone {
    switch (state) {
        case "in-sync":
            return "ok";
        case "out-of-date":
            return "warn";
        default:
            return "none";
    }
}

// "Save to N harnesses": a save writes every present harness, whatever its state.
export function saveTargetCount(rows: Pick<AgentSyncHarness, "present">[]): number {
    return rows.filter((r) => r.present).length;
}

export interface HeaderStatus {
    text: string;
    tone: Tone;
}

export function headerStatus(rows: Pick<AgentSyncHarness, "present" | "steering">[]): HeaderStatus {
    const present = rows.filter((r) => r.present);
    const n = present.length;
    if (n === 0) {
        return { text: "No harnesses set up", tone: "none" };
    }
    const behind = present.filter((r) => r.steering !== "current").length;
    if (behind === 0) {
        return { text: `${n} ${n === 1 ? "harness" : "harnesses"} in sync`, tone: "ok" };
    }
    return { text: `${behind} of ${n} harnesses out of date`, tone: "warn" };
}

export function lineCount(text: string): number {
    const t = text.replace(/\n+$/, "");
    return t === "" ? 0 : t.split("\n").length;
}
```

Then re-append the unchanged `changedLineCount` function (old lines 221–245) directly after `lineCount`, before the editor section.

- [ ] **Step 4: Run the model tests**

Run: `npx vitest run frontend/app/view/agents/setupmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Strip the store and the surface**

In `frontend/app/view/agents/setupstore.ts`:
- From the `./setupmodel` import, drop `SHARED` and `type SetupSelection`.
- Delete `setupSelectionAtom`, `setupDocsAtom`, `setupOwnAtom` (and its comment), `setupFreshStartAtom` (and its comment), `syncOwnEditor`, `selectShared`, `selectHarness`, `startEmptyPage`, the whole `// ---- one harness ----` section (`typeOwn`, `discardOwn`, `reloadOwn`, `saveOwn`, `foldIntoShared`) and `dropMemory`.
- Replace `load` with:

```ts
// Status gives the rows, their order, and each harness file's state against the shared doc.
async function load(): Promise<void> {
    const [status, steering] = await Promise.all([
        RpcApi.AgentSyncStatusCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS }),
        RpcApi.AgentSyncSteeringReadCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS }),
    ]);
    globalStore.set(setupStatusAtom, status);
    globalStore.set(setupSharedPathAtom, steering.path ?? status.steeringdoc ?? "");
    globalStore.set(
        setupSharedAtom,
        editorLoaded(globalStore.get(setupSharedAtom), steering.content ?? "", steering.mtime ?? 0)
    );
}
```

In `frontend/app/view/agents/setupsurface.tsx`:
- Replace the header comment (lines 4–8) with:

```tsx
// The Setup surface: the instructions and skills every harness reads. The Instructions tab edits the
// shared doc, which every save writes into each harness's file, and lists each harness file's state.
// The Skills tab views every harness's skills and moves them into the vault; it never creates or edits
// one. Logic lives in setupmodel.ts and skillsmatrix.ts, the RPCs and the atoms in setupstore.ts.
```

- Imports:
  - lucide: `Share2, TriangleAlert`.
  - react: `useEffect, useRef, type KeyboardEvent`.
  - `./setupmodel`: `changedLineCount, harnessRowLabel, harnessRowState, harnessRowTone, headerStatus, isDirty, lineCount, saveTargetCount, type DocEditor, type Tone`.
  - `./setupstore`: keep `adoptSkills, discardShared, loadSetup, loadSkills, openSkillFile, reloadShared, saveShared, selectSkill, setSkillKeep, setupBusyAtom, setupErrorAtom, setupSharedAtom, setupSharedPathAtom, setupSkillKeepAtom, setupSkillsAtom, setupSkillSelectedAtom, setupStatusAtom, setupTabAtom, typeShared, type SetupTab`.
- Delete the constants `LINK` and `PREVIEW_LINES`, and the functions `useFirstRun`, `Preview`, `FirstRun`, `Zone`, `OwnZone`, `SharedZone`, `MemoryZone` and `HarnessPane`.
- Replace `useRows` with:

```tsx
function useRows(): AgentSyncHarness[] {
    return useAtomValue(setupStatusAtom)?.harnesses ?? [];
}
```

- In `HeaderStatus`, delete the `firstRun` line and call `headerStatus(rows)`.
- Replace `FileList` with:

```tsx
function FileList({ rows }: { rows: AgentSyncHarness[] }) {
    const shared = useAtomValue(setupSharedAtom);
    const status = useAtomValue(setupStatusAtom);
    const rowClass = "flex w-full items-start gap-2.5 rounded px-2.5 py-[9px]";
    return (
        <aside
            aria-label="Instruction files"
            className="flex w-[264px] flex-none flex-col gap-1 overflow-y-auto border-r border-border bg-surface px-2.5 py-3.5"
        >
            <div className={cn(SECTION_HEAD, "px-2 pb-1.5")}>Shared</div>
            <div className={cn(rowClass, "bg-surface-selected text-primary ring-1 ring-edge-strong ring-inset")}>
                <span className="flex h-5 w-5 flex-none items-center justify-center rounded-[5px] bg-accentbg text-accent-soft">
                    <Share2 size={12} strokeWidth={2.2} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-[13px] font-semibold">
                        For every harness
                        {isDirty(shared) ? (
                            <span
                                aria-label="Unsaved changes"
                                title="Unsaved changes"
                                className="ml-auto h-[7px] w-[7px] rounded-full bg-accent"
                            />
                        ) : null}
                    </span>
                    <span className="font-mono text-[10.5px] text-muted">vault/steering/AGENTS.md</span>
                </span>
            </div>

            <div className={cn(SECTION_HEAD, "px-2 pb-1.5 pt-4")}>Harness files</div>
            {status == null ? <div className="px-2 text-[12px] text-muted">Reading…</div> : null}
            {rows.map((r) => {
                const state = harnessRowState(r);
                const tone = harnessRowTone(state);
                return (
                    <div key={r.runtime} className={cn(rowClass, "text-secondary", !r.present && "opacity-50")}>
                        <HarnessMark runtime={r.runtime} />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-[13px] font-medium">{r.label}</span>
                            <span title={r.path} className="truncate font-mono text-[10.5px] text-muted">
                                {r.path}
                            </span>
                            <span className={cn("mt-[3px] flex items-center gap-1.5 text-[11px]", TONE_TEXT[tone])}>
                                <Dot tone={tone} />
                                {harnessRowLabel(state)}
                            </span>
                        </span>
                    </div>
                );
            })}
        </aside>
    );
}
```

- In `SharedEditor`:
  - change the `rows` prop type to `AgentSyncHarness[]`.
  - change the subtitle to `Saving writes this into each harness file below.`
  - change the `LineEditor` placeholder to `"The instructions every harness should follow. Saving writes them into each harness's file."`
- In `SharedRail`:
  - change the `rows` prop type to `AgentSyncHarness[]`.
  - replace the whole "How each harness file is split" block (the first `<div className="flex flex-col gap-2.5">` and its three zones) with:

```tsx
            <div className="flex flex-col gap-2">
                <div className={SECTION_HEAD}>How saving works</div>
                <p className="m-0 text-[12px] leading-[1.45] text-ink-mid">
                    Each harness file gets this doc between two Arc marker lines. Anything outside them is left
                    alone.
                </p>
            </div>
```

  - In the "Saving writes to" list, delete the `<span className="ml-auto text-[11px] font-normal text-muted">{saveTargetNote(r.doc)}</span>`. Then delete the `const zone = ...` line, which is now unused.
- Replace `InstructionsTab` with:

```tsx
function InstructionsTab() {
    const rows = useRows();
    const error = useAtomValue(setupErrorAtom);
    const status = useAtomValue(setupStatusAtom);
    return (
        <div className="flex min-h-0 flex-1">
            <FileList rows={rows} />
            <div className="flex min-w-0 flex-1 flex-col">
                {error ? (
                    <div
                        role="alert"
                        className="flex-none border-b border-error/30 bg-error/10 px-5 py-2 text-[12.5px] text-error-soft"
                    >
                        {error}
                    </div>
                ) : null}
                <div className="flex min-h-0 flex-1">
                    {status == null ? (
                        <div className="flex flex-1 items-center justify-center text-[13px] text-muted">Reading…</div>
                    ) : (
                        <>
                            <SharedEditor rows={rows} />
                            <SharedRail rows={rows} />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 6: Typecheck, lint, test**

Run: `task check:ts` (give it a 5-minute timeout; it takes about 2 minutes).
Expected: exit 0. The baseline is clean, so any error comes from this plan.

Run: `npx vitest run frontend/app/view/agents/ && npx eslint frontend/app/view/agents/setupmodel.ts frontend/app/view/agents/setupstore.ts frontend/app/view/agents/setupsurface.tsx frontend/app/view/agents/setupmodel.test.ts && npx prettier --check frontend/app/view/agents/setupmodel.ts frontend/app/view/agents/setupstore.ts frontend/app/view/agents/setupsurface.tsx frontend/app/view/agents/setupmodel.test.ts`
Expected: all PASS, with no unused-import warnings.

---

### Task 3: Live check, leftover cleanup, commit

**Depends on:** Task 2

**Files:**
- Modify: `scripts/cdp/attach.mjs` (`SURFACE_LABEL`)
- Modify: `scripts/cdp/scenarios.mjs:305` (`SMOKE_SURFACES`)

- [ ] **Step 1: Put Setup in the smoke run**

In `scripts/cdp/attach.mjs`, add `setup: "Setup",` to `SURFACE_LABEL` after `settings`. In `scripts/cdp/scenarios.mjs`, add `"setup"` to the end of `SMOKE_SURFACES`. Edit both by hand and never run prettier on `scripts/*.mjs`.

- [ ] **Step 2: Verify in the dev app**

Run `tail -f /dev/null | task dev` in the background. Wait until `node scripts/cdp-shot.mjs cdp-shots/boot.png` produces a non-blank page.

Run: `task verify:ui -- surface-smoke`
Expected: PASS, including the new `goto setup` step. Open `cdp-shots/surface-setup.png` and check:
- the left column shows the shared entry plus a row per harness, each with its path and a state;
- each row's state matches the `steering` column of `wsh agent-sync status` run from an Arc terminal;
- the rail says "How saving works";
- there is no harness page, own-rules zone, first-run offer or old-memory warning.

Stop the dev app by PID, never by image name (AGENTS.md "Stop the dev app by PID"), and TaskStop the `tail -f` half.

- [ ] **Step 3: Remove the leftover memory blocks (with the user's OK)**

Show the user the first and last lines of each block, then ask before deleting. For both `~/.codex/AGENTS.md` and `~/.config/opencode/AGENTS.md`:
- delete from the blank line before `<!-- ARC-MEMORY:BEGIN` through `<!-- ARC-MEMORY:END -->`;
- check that the file still ends with `<!-- ARC-STEERING:END -->` plus a single newline;
- check that `grep -c "ARC-MEMORY"` prints `0`.

Use the Edit tool or a script file, not an inline heredoc (steering: "File edits go through the Edit/Write tools").

- [ ] **Step 4: Commit (after approval)**

Show the user the file list with M/A/D status, a one-line summary per file, and this message for approval:

```
refactor(agentsync): drop per-harness own rules, memory and fold from steering sync
```

Stage only the files named in Tasks 1–3 plus this plan, then commit once approved. Do not add a co-author trailer.
