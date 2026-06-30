# Sessions Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the Agent-tab resume hero into a full, searchable, runtime-agnostic Sessions surface that lists past Claude **and** Codex sessions and resumes any of them.

**Architecture:** Refactor `pkg/agentsessions` from a single hardcoded Claude walk into a small **provider registry** (a slice of `{runtime, root, matches, extract, resumeCmd}` descriptors); add a Codex provider; carry a backend-computed `ResumeCommand` on `SessionInfo`. Reuse the existing `GetRecentSessions` wshrpc command (bigger window/cap). Build a new `SessionsSurface` (flat newest-first list + client-side search + runtime/project chips) wired into the cockpit NavRail, and route Resume through the existing `launchAgent`.

**Tech Stack:** Go (backend scan, table tests), wshrpc codegen (`task generate`), React 19 + jotai + Tailwind v4 (@theme tokens), vitest.

**Spec:** `docs/superpowers/specs/2026-06-30-sessions-tab-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `pkg/agentsessions/agentsessions.go` | provider registry + Claude/Codex extractors + scan | Modify |
| `pkg/agentsessions/agentsessions_test.go` | Go unit tests (Claude + Codex) | Modify |
| `pkg/wshrpc/wshrpctypes.go` | wire `SessionInfo.ResumeCommand` | Modify |
| `pkg/wshrpc/wshserver/wshserver.go` | map `ResumeCommand` in the handler | Modify |
| `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts` | generated bindings | Regenerated (`task generate`) |
| `frontend/app/view/agents/sessionsarchivestore.ts` | fetch (30d/100) + pure search/filter helpers | Create |
| `frontend/app/view/agents/sessionsarchivestore.test.ts` | vitest for the helpers | Create |
| `frontend/app/view/agents/sessionssurface.tsx` | the Sessions surface view | Create |
| `frontend/app/view/agents/cockpitshell.tsx` | render `SessionsSurface` for `surface === "sessions"` | Modify |
| `frontend/app/view/agents/agentlaunchhero.tsx` | resume via `s.resumecommand` + per-row runtime | Modify |
| `frontend/app/view/agents/placeholdersurface.tsx` | drop the now-unused `sessions` title | Modify |

---

## Task 1: Provider registry + ResumeCommand (Claude path), refactor

Turn the single Claude walk into a provider registry and add `ResumeCommand`, keeping Claude behavior identical. The existing tests are updated to the new `scanProvider` signature first (they stop compiling → the "failing" state), then the refactor makes them pass.

**Files:**
- Modify: `pkg/agentsessions/agentsessions.go`
- Test: `pkg/agentsessions/agentsessions_test.go`

- [ ] **Step 1: Update existing tests to the new signature + assert ResumeCommand**

In `pkg/agentsessions/agentsessions_test.go`, replace every `scanRoot(dir, …)` / `scanRoot(filepath.Join(…), …)` call with `scanProvider(claudeProvider(<root>), …)`. There are 5 call sites. Concretely:

In `TestScanRoot_parsesAndSortsNewestFirst`, change:
```go
	got := scanRoot(dir, 0, 10)
```
to:
```go
	got := scanProvider(claudeProvider(dir), 0, 10)
```
and add, after the `Runtime` assertion (after line 61):
```go
	if got[0].ResumeCommand != "claude --resume sess-a" {
		t.Errorf("resumeCommand = %q", got[0].ResumeCommand)
	}
```

In `TestScanRoot_skipsFilesWithoutHumanPrompt`:
```go
	if got := scanProvider(claudeProvider(dir), 0, 10); len(got) != 0 {
```
In `TestScanRoot_capsToLimit`:
```go
	if got := scanProvider(claudeProvider(dir), 0, 2); len(got) != 2 {
```
In `TestScanRoot_readsOnlyNewestUpToLimit`:
```go
	got := scanProvider(claudeProvider(dir), 0, 2)
```
In `TestScanRoot_missingRootYieldsNothing`:
```go
	if got := scanProvider(claudeProvider(filepath.Join(t.TempDir(), "does-not-exist")), 0, 10); len(got) != 0 {
```

- [ ] **Step 2: Run tests to verify they fail to compile**

Run: `go test ./pkg/agentsessions/`
Expected: FAIL — `undefined: scanProvider`, `undefined: claudeProvider`.

- [ ] **Step 3: Add ResumeCommand to the internal struct**

In `pkg/agentsessions/agentsessions.go`, add a field to `SessionInfo` (after `LastActiveTs`, line 38):
```go
	LastActiveTs int64  // file mtime, UnixMilli
	ResumeCommand string // the runtime's resume invocation; "" = not resumable
```

- [ ] **Step 4: Drop the hardcoded runtime in extractClaudeSession**

`scanProvider` now sets `Runtime`. Change line 60 from:
```go
	s := &SessionInfo{ID: id, Runtime: "claude"}
```
to:
```go
	s := &SessionInfo{ID: id}
```

- [ ] **Step 5: Add the provider type + Claude provider + scanProvider; rewrite ScanSessions**

Replace the existing `scanRoot` function and the `ScanSessions` function (current lines 131-190) with:
```go
// provider describes one runtime's resumable transcripts: where they live, how to recognize and
// parse one, and how to resume it. Adding a runtime = appending one descriptor.
type provider struct {
	runtime   string                                       // row tag: "claude" | "codex" | …
	root      string                                       // transcript root dir
	matches   func(name string) bool                       // filename predicate
	extract   func(stem string, lines []string) *SessionInfo // stem = filename without .jsonl
	resumeCmd func(s *SessionInfo) string                  // "" = not resumable
}

func claudeProvider(root string) provider {
	return provider{
		runtime:   "claude",
		root:      root,
		matches:   func(name string) bool { return strings.HasSuffix(name, ".jsonl") },
		extract:   extractClaudeSession,
		resumeCmd: func(s *SessionInfo) string { return "claude --resume " + s.ID },
	}
}

// scanProvider returns up to `limit` sessions from one provider's root, newest-first. It stats every
// matching file (cheap dirent metadata, no content read) to rank by mtime, then reads CONTENT only
// for the newest candidates — just enough to fill `limit` valid sessions.
func scanProvider(p provider, windowDays, limit int) []SessionInfo {
	var cutoff time.Time
	if windowDays > 0 {
		cutoff = time.Now().AddDate(0, 0, -windowDays-1)
	}
	type candidate struct {
		path  string
		stem  string
		mtime time.Time
	}
	var cands []candidate
	_ = filepath.WalkDir(p.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !p.matches(d.Name()) {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		if !cutoff.IsZero() && info.ModTime().Before(cutoff) {
			return nil
		}
		cands = append(cands, candidate{path: path, stem: strings.TrimSuffix(d.Name(), ".jsonl"), mtime: info.ModTime()})
		return nil
	})
	sort.Slice(cands, func(i, j int) bool { return cands[i].mtime.After(cands[j].mtime) })

	var out []SessionInfo
	for _, c := range cands {
		if limit > 0 && len(out) >= limit {
			break
		}
		s := p.extract(c.stem, readLines(c.path))
		if s == nil {
			continue
		}
		s.Runtime = p.runtime
		s.LastActiveTs = c.mtime.UnixMilli()
		s.ResumeCommand = p.resumeCmd(s)
		out = append(out, *s)
	}
	return out
}

// ScanSessions lists recent resumable sessions across all runtime providers, newest-first.
// windowDays<=0 and limit<=0 fall back to the package defaults.
func ScanSessions(windowDays, limit int) ([]SessionInfo, error) {
	if windowDays <= 0 {
		windowDays = defaultWindowDays
	}
	if limit <= 0 {
		limit = defaultLimit
	}
	home := wavebase.GetHomeDir()
	providers := []provider{
		claudeProvider(filepath.Join(home, ".claude", "projects")),
		codexProvider(filepath.Join(home, ".codex", "sessions")),
	}
	var all []SessionInfo
	for _, p := range providers {
		all = append(all, scanProvider(p, windowDays, limit)...)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].LastActiveTs > all[j].LastActiveTs })
	if limit > 0 && len(all) > limit {
		all = all[:limit]
	}
	return all, nil
}
```

Note: `ScanSessions` references `codexProvider`, added in Task 2. This task will not compile until Task 2 is done — that's intentional; the two are one cohesive backend change. (If running tasks strictly in isolation, temporarily comment the `codexProvider(...)` line and the comment, then restore in Task 2. Otherwise proceed to Task 2 before running.)

- [ ] **Step 6: Defer the run to Task 2** (the package won't compile without `codexProvider`).

---

## Task 2: Codex provider + extractor

Add the Codex provider: scan `~/.codex/sessions/rollout-*.jsonl`, extract the session id (the `codex resume` key) and metadata from the `session_meta` first line, the model from `turn_context`, and the task from the first `event_msg`/`user_message`.

**Files:**
- Modify: `pkg/agentsessions/agentsessions.go`
- Test: `pkg/agentsessions/agentsessions_test.go`

- [ ] **Step 1: Write the failing Codex test**

Append to `pkg/agentsessions/agentsessions_test.go`:
```go
func TestScanProvider_codexExtractsResumeKeyAndMeta(t *testing.T) {
	dir := t.TempDir()
	// matcher requires the rollout- prefix; the filename stem is NOT the resume key for codex.
	writeJSONL(t, dir, "rollout-2026-06-30T08-45-09-019f1633.jsonl",
		`{"type":"session_meta","payload":{"session_id":"019f1633-9e5d-7791","cwd":"/home/me/waveterm","git":{"branch":"main"}}}`,
		`{"type":"event_msg","payload":{"type":"task_started"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions"}]}}`,
		`{"type":"turn_context","payload":{"model":"gpt-5-codex"}}`,
		`{"type":"event_msg","payload":{"type":"user_message","message":"check the handoff"}}`,
	)

	got := scanProvider(codexProvider(dir), 0, 10)
	if len(got) != 1 {
		t.Fatalf("want 1 codex session, got %d", len(got))
	}
	s := got[0]
	if s.ID != "019f1633-9e5d-7791" {
		t.Errorf("ID (resume key) = %q, want the session_meta session_id", s.ID)
	}
	if s.Runtime != "codex" {
		t.Errorf("runtime = %q", s.Runtime)
	}
	if s.ProjectName != "waveterm" {
		t.Errorf("projectName = %q", s.ProjectName)
	}
	if s.Branch != "main" {
		t.Errorf("branch = %q", s.Branch)
	}
	if s.Model != "gpt-5-codex" {
		t.Errorf("model = %q", s.Model)
	}
	if s.Task != "check the handoff" {
		t.Errorf("task = %q (must be the user_message, not the AGENTS.md injection)", s.Task)
	}
	if s.ResumeCommand != "codex resume 019f1633-9e5d-7791" {
		t.Errorf("resumeCommand = %q", s.ResumeCommand)
	}
}

func TestScanProvider_codexSkipsFileWithoutUserMessage(t *testing.T) {
	dir := t.TempDir()
	writeJSONL(t, dir, "rollout-x.jsonl",
		`{"type":"session_meta","payload":{"session_id":"abc","cwd":"/x"}}`,
		`{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"env"}]}}`,
	)
	if got := scanProvider(codexProvider(dir), 0, 10); len(got) != 0 {
		t.Fatalf("want 0 (no human user_message), got %d", len(got))
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./pkg/agentsessions/ -run TestScanProvider_codex`
Expected: FAIL — `undefined: codexProvider`.

- [ ] **Step 3: Add the Codex extractor + provider**

In `pkg/agentsessions/agentsessions.go`, add after `extractClaudeSession` (and its helpers):
```go
type codexLine struct {
	Type    string `json:"type"`
	Payload struct {
		Type      string `json:"type"`
		SessionID string `json:"session_id"`
		Cwd       string `json:"cwd"`
		Model     string `json:"model"`
		Message   string `json:"message"`
		Git       struct {
			Branch string `json:"branch"`
		} `json:"git"`
	} `json:"payload"`
}

// extractCodexSession folds one Codex rollout file into a SessionInfo. The resume key is the
// session_meta.session_id (NOT the filename stem). The task is the first event_msg/user_message
// (the response_item user lines are AGENTS.md / environment injections, not the human prompt).
// Returns nil when there is no session id or no human prompt.
func extractCodexSession(_ string, lines []string) *SessionInfo {
	s := &SessionInfo{}
	model := "codex"
	hasTask := false
	for _, line := range lines {
		var rec codexLine
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			continue
		}
		switch rec.Type {
		case "session_meta":
			if rec.Payload.SessionID != "" {
				s.ID = rec.Payload.SessionID
			}
			if rec.Payload.Cwd != "" {
				s.ProjectPath = rec.Payload.Cwd
				s.ProjectName = filepath.Base(rec.Payload.Cwd)
			}
			if rec.Payload.Git.Branch != "" {
				s.Branch = rec.Payload.Git.Branch
			}
		case "turn_context":
			if rec.Payload.Model != "" {
				model = rec.Payload.Model // last turn_context model wins
			}
		case "event_msg":
			if rec.Payload.Type == "user_message" && !hasTask {
				if txt := strings.TrimSpace(rec.Payload.Message); txt != "" {
					s.Task = trimTo(txt, maxTaskLen)
					hasTask = true
				}
			}
		}
	}
	s.Model = model
	if s.ID == "" || !hasTask {
		return nil
	}
	return s
}

func codexProvider(root string) provider {
	return provider{
		runtime:   "codex",
		root:      root,
		matches:   func(name string) bool { return strings.HasPrefix(name, "rollout-") && strings.HasSuffix(name, ".jsonl") },
		extract:   extractCodexSession,
		resumeCmd: func(s *SessionInfo) string { return "codex resume " + s.ID },
	}
}
```
If you commented the `codexProvider(...)` line in `ScanSessions` during Task 1, uncomment it now.

- [ ] **Step 4: Run the full package tests**

Run: `go test ./pkg/agentsessions/`
Expected: PASS (all Claude tests + both Codex tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/agentsessions/agentsessions.go pkg/agentsessions/agentsessions_test.go
git commit -m "feat(agentsessions): provider registry + Codex resumable sessions"
```

---

## Task 3: Wire ResumeCommand through the wshrpc boundary + regenerate

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go:654-664`
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1497-1500`
- Regenerated: `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`

- [ ] **Step 1: Add the wire field**

In `pkg/wshrpc/wshrpctypes.go`, add to the `SessionInfo` struct (after `LastActiveTs`, line 663):
```go
	LastActiveTs  int64  `json:"lastactivets"`
	ResumeCommand string `json:"resumecommand"`
```

- [ ] **Step 2: Map it in the handler**

In `pkg/wshrpc/wshserver/wshserver.go`, update the mapping in `GetRecentSessionsCommand` (lines 1497-1500) to include the field:
```go
		out[i] = wshrpc.SessionInfo{
			ID: s.ID, Runtime: s.Runtime, ProjectPath: s.ProjectPath, ProjectName: s.ProjectName,
			Branch: s.Branch, Task: s.Task, Model: s.Model, TokensTotal: s.TokensTotal,
			LastActiveTs: s.LastActiveTs, ResumeCommand: s.ResumeCommand,
		}
```

- [ ] **Step 3: Regenerate bindings**

Run: `task generate`
Expected: success; `frontend/types/gotypes.d.ts` `SessionInfo` now has `resumecommand: string`.

- [ ] **Step 4: Verify the generated type**

Run: `grep -n "resumecommand" frontend/types/gotypes.d.ts`
Expected: a line `resumecommand: string;` inside `type SessionInfo = {`.

- [ ] **Step 5: Build the backend to confirm it compiles**

Run: `go build ./pkg/...`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "feat(wshrpc): carry ResumeCommand on SessionInfo"
```

---

## Task 4: Sessions archive store + pure search/filter helpers

**Files:**
- Create: `frontend/app/view/agents/sessionsarchivestore.ts`
- Test: `frontend/app/view/agents/sessionsarchivestore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/sessionsarchivestore.test.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { filterSessions, projectsOf, runtimesOf, searchSessions } from "./sessionsarchivestore";

const mk = (over: Partial<SessionInfo> = {}): SessionInfo => ({
    id: "x",
    runtime: "claude",
    projectpath: "/p",
    projectname: "proj",
    branch: "main",
    task: "do the thing",
    model: "claude",
    tokenstotal: 0,
    lastactivets: 0,
    resumecommand: "claude --resume x",
    ...over,
});

describe("searchSessions", () => {
    const list = [
        mk({ id: "a", task: "Fix the auth race", projectname: "payments", branch: "feat/auth" }),
        mk({ id: "b", task: "Add a button", projectname: "web", branch: "main" }),
    ];
    it("returns all on empty query", () => {
        expect(searchSessions(list, "  ")).toHaveLength(2);
    });
    it("matches task case-insensitively", () => {
        expect(searchSessions(list, "AUTH").map((s) => s.id)).toEqual(["a"]);
    });
    it("matches project and branch", () => {
        expect(searchSessions(list, "web").map((s) => s.id)).toEqual(["b"]);
        expect(searchSessions(list, "feat/").map((s) => s.id)).toEqual(["a"]);
    });
});

describe("filterSessions", () => {
    const list = [
        mk({ id: "a", runtime: "claude", projectname: "payments" }),
        mk({ id: "b", runtime: "codex", projectname: "web" }),
    ];
    it("passes everything on all/all", () => {
        expect(filterSessions(list, { runtime: "all", project: "all" })).toHaveLength(2);
    });
    it("filters by runtime", () => {
        expect(filterSessions(list, { runtime: "codex", project: "all" }).map((s) => s.id)).toEqual(["b"]);
    });
    it("filters by project", () => {
        expect(filterSessions(list, { runtime: "all", project: "payments" }).map((s) => s.id)).toEqual(["a"]);
    });
});

describe("runtimesOf / projectsOf", () => {
    const list = [mk({ runtime: "codex", projectname: "web" }), mk({ runtime: "claude", projectname: "web" }), mk({ runtime: "claude", projectname: "api" })];
    it("returns unique sorted runtimes", () => {
        expect(runtimesOf(list)).toEqual(["claude", "codex"]);
    });
    it("returns unique sorted projects", () => {
        expect(projectsOf(list)).toEqual(["api", "web"]);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run frontend/app/view/agents/sessionsarchivestore.test.ts`
Expected: FAIL — cannot resolve `./sessionsarchivestore`.

- [ ] **Step 3: Implement the store**

Create `frontend/app/view/agents/sessionsarchivestore.ts`:
```ts
// frontend/app/view/agents/sessionsarchivestore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Past resumable sessions across runtimes (Claude + Codex) from GetRecentSessions, plus pure
// client-side search/filter helpers. Powers the Sessions surface. Separate from recentsessionsstore
// (the Agent-tab hero's small 5-row cache) so the two callers don't fight over one atom.
// `SessionInfo` is the generated wire type (global ambient).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

const WINDOW_DAYS = 30;
const LIMIT = 100;

// null = not loaded yet; [] = loaded-empty.
export const sessionsArchiveAtom = atom<SessionInfo[] | null>(null) as PrimitiveAtom<SessionInfo[] | null>;

let loading = false;

export async function loadSessionsArchive(): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const rtn = await RpcApi.GetRecentSessionsCommand(TabRpcClient, { windowdays: WINDOW_DAYS, limit: LIMIT });
        globalStore.set(sessionsArchiveAtom, rtn.sessions ?? []);
    } catch {
        globalStore.set(sessionsArchiveAtom, []); // scan failure -> empty, never breaks the surface
    } finally {
        loading = false;
    }
}

export function searchSessions(list: SessionInfo[], query: string): SessionInfo[] {
    const q = query.trim().toLowerCase();
    if (!q) {
        return list;
    }
    return list.filter(
        (s) =>
            s.task.toLowerCase().includes(q) ||
            s.projectname.toLowerCase().includes(q) ||
            s.branch.toLowerCase().includes(q)
    );
}

export interface SessionFilter {
    runtime: string; // "all" | runtime
    project: string; // "all" | projectname
}

export function filterSessions(list: SessionInfo[], f: SessionFilter): SessionInfo[] {
    return list.filter(
        (s) => (f.runtime === "all" || s.runtime === f.runtime) && (f.project === "all" || s.projectname === f.project)
    );
}

export function runtimesOf(list: SessionInfo[]): string[] {
    return [...new Set(list.map((s) => s.runtime))].sort();
}

export function projectsOf(list: SessionInfo[]): string[] {
    return [...new Set(list.map((s) => s.projectname))].sort();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run frontend/app/view/agents/sessionsarchivestore.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/sessionsarchivestore.ts frontend/app/view/agents/sessionsarchivestore.test.ts
git commit -m "feat(sessions): archive store + search/filter helpers"
```

---

## Task 5: The Sessions surface + NavRail wiring

**Files:**
- Create: `frontend/app/view/agents/sessionssurface.tsx`
- Modify: `frontend/app/view/agents/cockpitshell.tsx`

- [ ] **Step 1: Create the surface**

Create `frontend/app/view/agents/sessionssurface.tsx`:
```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Sessions surface: a runtime-agnostic archive of past resumable sessions (Claude + Codex), promoted
// from the Agent-tab resume hero. Flat newest-first list with client-side search + runtime/project
// chips. Resume routes through launchAgent (which switches to the Agent tab and focuses the new agent).

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { formatAge, formatTokens } from "./agentsviewmodel";
import type { Runtime } from "./launch";
import {
    filterSessions,
    loadSessionsArchive,
    projectsOf,
    runtimesOf,
    searchSessions,
    sessionsArchiveAtom,
} from "./sessionsarchivestore";

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "cursor-pointer rounded-[8px] border px-[13px] py-[6px] text-[12px] font-medium",
                active
                    ? "border-accent bg-accentbg text-accent-soft"
                    : "border-border bg-surface text-ink-mid hover:border-edge-strong"
            )}
        >
            {label}
        </button>
    );
}

export function SessionsSurface({ model }: { model: AgentsViewModel }) {
    const sessions = useAtomValue(sessionsArchiveAtom);
    const [query, setQuery] = useState("");
    const [runtime, setRuntime] = useState("all");
    const [project, setProject] = useState("all");
    useEffect(() => {
        fireAndForget(loadSessionsArchive);
    }, []);

    const list = sessions ?? [];
    const runtimes = runtimesOf(list);
    const projects = projectsOf(list);
    const shown = filterSessions(searchSessions(list, query), { runtime, project });
    const now = Date.now();

    const resume = (s: SessionInfo) => {
        if (!s.resumecommand) {
            return;
        }
        fireAndForget(() =>
            launchAgent(model, {
                runtime: s.runtime as Runtime,
                startupCommand: s.resumecommand,
                task: "",
                projectPath: s.projectpath,
                projectName: s.projectname || "agent",
            })
        );
    };

    return (
        <div className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto max-w-[820px] px-[30px] pb-[70px] pt-[30px]">
                <div className="mb-5">
                    <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">Sessions</h1>
                    <p className="text-[13.5px] text-secondary">
                        Past agent sessions across runtimes. Click Resume to pick one back up.
                    </p>
                </div>

                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search task, project, or branch…"
                    className="mb-4 w-full rounded-[9px] border border-border bg-surface px-[13px] py-[9px] text-[13px] text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                />

                <div className="mb-3 flex flex-wrap gap-2">
                    <FilterChip label="All runtimes" active={runtime === "all"} onClick={() => setRuntime("all")} />
                    {runtimes.map((r) => (
                        <FilterChip key={r} label={r} active={runtime === r} onClick={() => setRuntime(r)} />
                    ))}
                </div>
                <div className="mb-7 flex flex-wrap gap-2">
                    <FilterChip label="All projects" active={project === "all"} onClick={() => setProject("all")} />
                    {projects.map((p) => (
                        <FilterChip key={p} label={p} active={project === p} onClick={() => setProject(p)} />
                    ))}
                </div>

                {sessions == null ? (
                    <div className="mt-10 text-center text-[13px] text-muted">Loading…</div>
                ) : shown.length === 0 ? (
                    <div className="mt-10 text-center text-[13px] text-muted">No sessions found.</div>
                ) : (
                    <div className="overflow-hidden rounded-[12px] border border-border bg-surface">
                        {shown.map((s) => (
                            <div
                                key={`${s.runtime}:${s.id}`}
                                className="flex items-center gap-[11px] border-b border-border px-[14px] py-[12px] last:border-b-0 hover:bg-surface-hover"
                            >
                                <span className="shrink-0 rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[.08em] text-muted">
                                    {s.runtime}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[12.5px] font-semibold text-primary">
                                        {s.task || "(untitled session)"}
                                    </div>
                                    <div className="mt-[2px] truncate font-mono text-[10.5px] text-muted">
                                        {s.projectname} · {s.branch || "—"} · {s.model || "—"}
                                        {s.tokenstotal > 0 ? ` · ${formatTokens(s.tokenstotal)} tok` : ""}
                                    </div>
                                </div>
                                <span className="shrink-0 font-mono text-[10.5px] text-muted">
                                    {formatAge(now - s.lastactivets)}
                                </span>
                                {s.resumecommand ? (
                                    <button
                                        type="button"
                                        onClick={() => resume(s)}
                                        className="shrink-0 cursor-pointer rounded-[7px] border border-border px-[11px] py-[5px] text-[11.5px] font-medium text-ink-mid hover:border-accent hover:text-accent-soft"
                                    >
                                        Resume →
                                    </button>
                                ) : (
                                    <span className="shrink-0 text-[10.5px] text-muted">read-only</span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Wire it into the cockpit shell**

In `frontend/app/view/agents/cockpitshell.tsx`, add the import after the `PlaceholderSurface` import (line 14):
```tsx
import { SessionsSurface } from "./sessionssurface";
```
Then add a branch in the surface switch, before the `usage` branch (between lines 56 and 57):
```tsx
                ) : surface === "usage" ? (
                    <UsageSurface model={model} />
                ) : surface === "sessions" ? (
                    <SessionsSurface model={model} />
                ) : (
                    <PlaceholderSurface surface={surface} />
                )}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors (baseline has 3 pre-existing `frontend/tauri/api.test.ts` errors).

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/sessionssurface.tsx frontend/app/view/agents/cockpitshell.tsx
git commit -m "feat(sessions): Sessions surface wired into the NavRail"
```

---

## Task 6: Single-source resume — hero + placeholder cleanup

The hero hardcodes `claude --resume ${id}` and `runtime: "claude"`. Now that `GetRecentSessions` returns Codex sessions too and each row carries `resumecommand`, switch the hero to the backend command + per-row runtime (single source of truth; the hero now also surfaces Codex recents).

**Files:**
- Modify: `frontend/app/view/agents/agentlaunchhero.tsx:29-38`
- Modify: `frontend/app/view/agents/placeholdersurface.tsx:4-9`

- [ ] **Step 1: Switch the hero's resume to the backend command + runtime**

In `frontend/app/view/agents/agentlaunchhero.tsx`, add the `Runtime` import after the `loadRecentSessions` import (line 17):
```tsx
import type { Runtime } from "./launch";
```
Then replace the `resume` function (lines 29-38):
```tsx
    const resume = (s: SessionInfo) =>
        fireAndForget(() =>
            launchAgent(model, {
                runtime: s.runtime as Runtime,
                startupCommand: s.resumecommand,
                task: "",
                projectPath: s.projectpath,
                projectName: s.projectname || "agent",
            })
        );
```

- [ ] **Step 2: Drop the unused placeholder title**

In `frontend/app/view/agents/placeholdersurface.tsx`, remove the `sessions` entry from `TITLES` (line 6):
```tsx
const TITLES: Record<string, string> = {
    channels: "Channels",
    files: "Files",
    memory: "Memory",
};
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors beyond the 3 pre-existing `api.test.ts` ones.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/agentlaunchhero.tsx frontend/app/view/agents/placeholdersurface.tsx
git commit -m "refactor(sessions): single-source resume command across hero + surface"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Go tests**

Run: `go test ./pkg/agentsessions/ ./pkg/wshrpc/...`
Expected: PASS.

- [ ] **Step 2: Frontend unit tests**

Run: `npx vitest run`
Expected: PASS (existing suite + the new `sessionsarchivestore.test.ts`).

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `frontend/tauri/api.test.ts` errors.

- [ ] **Step 4: CDP visual verification (live dev app)**

Per `docs` + the project's CDP notes: start the dev app so wavesrv keeps a live stdin — `tail -f /dev/null | task dev` (a closed stdin makes wavesrv exit on EOF). Then:
- `node scripts/cdp-shot.mjs sessions.png` after navigating the NavRail to **Sessions** (the page is the Vite app in WebView2 on `:9222`; use `Runtime.evaluate` to click the Sessions nav button or set `surfaceAtom`).
- Confirm: rows render for **both** runtimes with correct runtime tags; the search box and runtime/project chips filter the list; clicking **Resume** on a Claude row launches `claude --resume <id>` and on a Codex row launches `codex resume <uuid>`, each becoming a live agent on the Agent tab (the surface auto-switches via `launchAgent`).

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(sessions): verification fixups"
```

---

## Notes for the executor

- **Tasks 1 and 2 are one cohesive backend change** — Task 1's `ScanSessions` references `codexProvider` from Task 2, so run the Go tests only after Task 2 (or temporarily stub as noted in Task 1 Step 5). Commit happens once, at the end of Task 2.
- **Do not hand-edit generated files** (`gotypes.d.ts`, `wshclientapi.ts`) — they come from `task generate` (Task 3). Go is the source of truth.
- **No SCSS, no hardcoded colors** — the surface uses only existing @theme utility classes already used by `activitysurface.tsx` / `agentlaunchhero.tsx` (`bg-surface`, `border-border`, `text-muted`, `accentbg`, `accent-soft`, `ink-mid`, `edge-strong`, `surface-hover`).
- **Codex token totals are intentionally 0** this pass (deferred in the spec); the surface omits the `tok` segment when `tokenstotal === 0`.
- **Per the user's git workflow**, fold these commits + the spec + this plan into the feature as appropriate and get explicit approval before any push.
```
