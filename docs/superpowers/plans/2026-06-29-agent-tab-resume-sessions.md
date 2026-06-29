# Agent-tab Resume Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Agent tab has no live agent, show a "No terminal running" hero that lists recent Claude sessions (from a transcript scan) and resumes one with `claude --resume`.

**Architecture:** A new Go package (`pkg/agentsessions`) scans `~/.claude/projects/**/*.jsonl` and returns lightweight per-session records. A new wshrpc command (`GetRecentSessions`) exposes them. A thin frontend store fetches them; a new `AgentLaunchHero` view renders the launch CTA + resume list; `AgentSurface` swaps its empty-roster text for the hero. Resume routes through the existing `launchAgent`.

**Tech Stack:** Go (backend scan + wshrpc), `task generate` codegen (Go↔TS bindings), React 19 + jotai + Tailwind 4 (frontend), vitest + `go test` (tests).

---

## Git policy for this plan (overrides the skill's per-task commits)

The user's CLAUDE.md is STRICT: **never commit without explicit approval; batch into one commit at the end.** Spec/plan docs fold into that feature commit. So this plan does **not** commit per task — each task ends at a verification checkpoint. The final task stages everything and asks for approval. Treat per-task checkpoints as "stop, confirm green, continue."

## File structure

- **Create** `pkg/agentsessions/agentsessions.go` — the scan: walk transcripts → `SessionInfo` records. One responsibility: turn transcript files into resumable-session metadata.
- **Create** `pkg/agentsessions/agentsessions_test.go` — table tests against a fixture temp dir.
- **Modify** `pkg/wshrpc/wshrpctypes.go` — add the command to the interface + the wire types.
- **Modify** `pkg/wshrpc/wshserver/wshserver.go` — implement the handler (maps `agentsessions.SessionInfo` → wire).
- **Regenerated** `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, generated TS types — via `task generate` (never hand-edited).
- **Create** `frontend/app/view/agents/recentsessionsstore.ts` — fetch + cache atom.
- **Create** `frontend/app/view/agents/agentlaunchhero.tsx` — the hero view.
- **Modify** `frontend/app/view/agents/agentsurface.tsx:54-60` — empty-roster → `<AgentLaunchHero>`.

---

## Task 1: `pkg/agentsessions` scan (Go, TDD)

**Files:**
- Create: `pkg/agentsessions/agentsessions.go`
- Test: `pkg/agentsessions/agentsessions_test.go`

- [ ] **Step 1: Write the failing tests**

Create `pkg/agentsessions/agentsessions_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeJSONL(t *testing.T, dir, name string, lines ...string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestScanRoot_parsesAndSortsNewestFirst(t *testing.T) {
	dir := t.TempDir()
	writeJSONL(t, dir, "sess-a.jsonl",
		`{"type":"user","cwd":"/home/me/payments-api","gitBranch":"feat/auth","message":{"role":"user","content":"Fix the auth race"}}`,
		`{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`,
	)
	older := writeJSONL(t, dir, "sess-b.jsonl",
		`{"type":"user","cwd":"/home/me/web","gitBranch":"main","message":{"role":"user","content":"Add a button"}}`,
	)
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(older, old, old); err != nil {
		t.Fatal(err)
	}

	got := scanRoot(dir, 0, 10)
	if len(got) != 2 {
		t.Fatalf("want 2 sessions, got %d", len(got))
	}
	if got[0].ID != "sess-a" {
		t.Errorf("want newest sess-a first, got %q", got[0].ID)
	}
	if got[0].Task != "Fix the auth race" {
		t.Errorf("task = %q", got[0].Task)
	}
	if got[0].ProjectName != "payments-api" {
		t.Errorf("projectName = %q", got[0].ProjectName)
	}
	if got[0].Branch != "feat/auth" {
		t.Errorf("branch = %q", got[0].Branch)
	}
	if got[0].Model != "claude-opus-4-8" {
		t.Errorf("model = %q", got[0].Model)
	}
	if got[0].TokensTotal != 15 {
		t.Errorf("tokensTotal = %d", got[0].TokensTotal)
	}
	if got[0].Runtime != "claude" {
		t.Errorf("runtime = %q", got[0].Runtime)
	}
}

func TestScanRoot_skipsFilesWithoutHumanPrompt(t *testing.T) {
	dir := t.TempDir()
	// content is an array (a tool result), not a human string prompt
	writeJSONL(t, dir, "toolonly.jsonl",
		`{"type":"user","cwd":"/x","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}`,
		`{"type":"assistant","message":{"model":"claude-opus-4-8"}}`,
	)
	if got := scanRoot(dir, 0, 10); len(got) != 0 {
		t.Fatalf("want 0 (no human prompt), got %d", len(got))
	}
}

func TestScanRoot_capsToLimit(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"a", "b", "c"} {
		writeJSONL(t, dir, n+".jsonl", `{"type":"user","cwd":"/x","message":{"content":"hi `+n+`"}}`)
	}
	if got := scanRoot(dir, 0, 2); len(got) != 2 {
		t.Fatalf("cap: want 2, got %d", len(got))
	}
}

func TestScanRoot_missingRootYieldsNothing(t *testing.T) {
	if got := scanRoot(filepath.Join(t.TempDir(), "does-not-exist"), 0, 10); len(got) != 0 {
		t.Fatalf("missing root: want 0, got %d", len(got))
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/agentsessions/`
Expected: FAIL — compile error (`undefined: scanRoot`, `SessionInfo`).

- [ ] **Step 3: Write the implementation**

Create `pkg/agentsessions/agentsessions.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentsessions scans Claude Code transcript JSONL on disk and returns lightweight,
// resumable per-session metadata for the Agent-tab "No terminal running" hero. Sibling to
// pkg/usagestats (which scans the same files for token buckets). The session id is the JSONL
// filename stem — the key for `claude --resume <id>`.
package agentsessions

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const (
	defaultWindowDays = 14
	defaultLimit      = 20
	maxTaskLen        = 120
)

// SessionInfo is one resumable past Claude session.
type SessionInfo struct {
	ID           string // filename stem = the `claude --resume` key
	Runtime      string // "claude"
	ProjectPath  string // cwd
	ProjectName  string // last path segment of cwd
	Branch       string
	Task         string // first human prompt, trimmed
	Model        string // last assistant model seen
	TokensTotal  int
	LastActiveTs int64 // file mtime, UnixMilli
}

type claudeLine struct {
	Type      string `json:"type"`
	Cwd       string `json:"cwd"`
	GitBranch string `json:"gitBranch"`
	Message   struct {
		Model   string          `json:"model"`
		Content json.RawMessage `json:"content"`
		Usage   *struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

// extractClaudeSession folds one transcript file's lines into a SessionInfo. Returns nil when the
// file carries no human prompt (e.g. a subagent/tool-only file) — those aren't useful to resume.
func extractClaudeSession(id string, lines []string) *SessionInfo {
	s := &SessionInfo{ID: id, Runtime: "claude"}
	hasTask := false
	for _, line := range lines {
		var rec claudeLine
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			continue
		}
		if s.ProjectPath == "" && rec.Cwd != "" {
			s.ProjectPath = rec.Cwd
			s.ProjectName = filepath.Base(rec.Cwd)
		}
		if s.Branch == "" && rec.GitBranch != "" {
			s.Branch = rec.GitBranch
		}
		if rec.Message.Model != "" {
			s.Model = rec.Message.Model // last assistant model wins
		}
		if rec.Message.Usage != nil {
			u := rec.Message.Usage
			s.TokensTotal += u.InputTokens + u.OutputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
		}
		if !hasTask && rec.Type == "user" {
			if txt := stringContent(rec.Message.Content); txt != "" {
				s.Task = trimTo(txt, maxTaskLen)
				hasTask = true
			}
		}
	}
	if !hasTask {
		return nil
	}
	return s
}

// stringContent returns trimmed text when message.content is a plain string (a human prompt).
// Returns "" for array content (tool results) or anything else.
func stringContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		return strings.TrimSpace(str)
	}
	return ""
}

func trimTo(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return strings.TrimSpace(s[:max]) + "…"
}

func readLines(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var lines []string
	for _, ln := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(ln) != "" {
			lines = append(lines, ln)
		}
	}
	return lines
}

// scanRoot walks a Claude projects root, parsing each *.jsonl within the window into a SessionInfo,
// newest-first, capped to limit. Unexported so tests can target a fixture dir.
func scanRoot(root string, windowDays, limit int) []SessionInfo {
	var cutoff time.Time
	if windowDays > 0 {
		cutoff = time.Now().AddDate(0, 0, -windowDays-1)
	}
	var out []SessionInfo
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		info, statErr := os.Stat(path)
		if statErr != nil {
			return nil
		}
		if !cutoff.IsZero() && info.ModTime().Before(cutoff) {
			return nil
		}
		s := extractClaudeSession(strings.TrimSuffix(d.Name(), ".jsonl"), readLines(path))
		if s == nil {
			return nil
		}
		s.LastActiveTs = info.ModTime().UnixMilli()
		out = append(out, *s)
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].LastActiveTs > out[j].LastActiveTs })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// ScanSessions lists recent resumable Claude sessions from ~/.claude/projects. windowDays<=0 and
// limit<=0 fall back to the package defaults.
func ScanSessions(windowDays, limit int) ([]SessionInfo, error) {
	if windowDays <= 0 {
		windowDays = defaultWindowDays
	}
	if limit <= 0 {
		limit = defaultLimit
	}
	root := filepath.Join(wavebase.GetHomeDir(), ".claude", "projects")
	return scanRoot(root, windowDays, limit), nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/agentsessions/`
Expected: PASS (4 tests, `ok`).

- [ ] **Step 5: Checkpoint** — confirm green, no commit yet (see git policy).

---

## Task 2: `GetRecentSessions` wshrpc command (Go + codegen)

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface line ~98; types after `CommandGetUsageStatsRtnData` ~651)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (handler after `GetUsageStatsCommand` ~1487; import ~46)

- [ ] **Step 1: Add the interface method**

In `pkg/wshrpc/wshrpctypes.go`, immediately after the `GetUsageStatsCommand(...)` line (line ~98):

```go
	GetRecentSessionsCommand(ctx context.Context, data CommandGetRecentSessionsData) (*CommandGetRecentSessionsRtnData, error)
```

- [ ] **Step 2: Add the wire types**

In `pkg/wshrpc/wshrpctypes.go`, immediately after the `CommandGetUsageStatsRtnData` struct (line ~651):

```go
type SessionInfo struct {
	ID           string `json:"id"`
	Runtime      string `json:"runtime"`
	ProjectPath  string `json:"projectpath"`
	ProjectName  string `json:"projectname"`
	Branch       string `json:"branch"`
	Task         string `json:"task"`
	Model        string `json:"model"`
	TokensTotal  int    `json:"tokenstotal"`
	LastActiveTs int64  `json:"lastactivets"`
}

type CommandGetRecentSessionsData struct {
	WindowDays int `json:"windowdays,omitempty"`
	Limit      int `json:"limit,omitempty"`
}

type CommandGetRecentSessionsRtnData struct {
	Sessions []SessionInfo `json:"sessions"`
}
```

- [ ] **Step 3: Add the handler + import**

In `pkg/wshrpc/wshserver/wshserver.go`, add the import next to the existing usagestats import (line ~46):

```go
	"github.com/wavetermdev/waveterm/pkg/agentsessions"
```

Then add the handler immediately after `GetUsageStatsCommand` (after line ~1487):

```go
func (ws *WshServer) GetRecentSessionsCommand(ctx context.Context, data wshrpc.CommandGetRecentSessionsData) (*wshrpc.CommandGetRecentSessionsRtnData, error) {
	sessions, err := agentsessions.ScanSessions(data.WindowDays, data.Limit)
	if err != nil {
		return nil, fmt.Errorf("scanning sessions: %w", err)
	}
	out := make([]wshrpc.SessionInfo, len(sessions))
	for i, s := range sessions {
		out[i] = wshrpc.SessionInfo{
			ID: s.ID, Runtime: s.Runtime, ProjectPath: s.ProjectPath, ProjectName: s.ProjectName,
			Branch: s.Branch, Task: s.Task, Model: s.Model, TokensTotal: s.TokensTotal, LastActiveTs: s.LastActiveTs,
		}
	}
	return &wshrpc.CommandGetRecentSessionsRtnData{Sessions: out}, nil
}
```

- [ ] **Step 4: Verify it compiles**

Run: `go build ./pkg/...`
Expected: no output (success). If `fmt` is reported unused/missing it is already imported in wshserver.go — do not add it twice.

- [ ] **Step 5: Regenerate bindings**

Run: `task generate`
Expected: regenerates `pkg/wshrpc/wshclient/wshclient.go` (adds `GetRecentSessionsCommand` calling `"getrecentsessions"`) and `frontend/app/store/wshclientapi.ts` (adds `GetRecentSessionsCommand`) and the generated TS types (adds `SessionInfo`). **Do not hand-edit these.**

- [ ] **Step 6: Verify generation landed**

Run: `grep -rl "GetRecentSessionsCommand" pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts`
Expected: both files listed.

- [ ] **Step 7: Checkpoint** — `go test ./pkg/agentsessions/` still green; confirm, no commit.

---

## Task 3: `recentsessionsstore.ts` (frontend fetch atom)

**Files:**
- Create: `frontend/app/view/agents/recentsessionsstore.ts`

> No unit test: this is a thin RPC wrapper with no branching logic. The cockpit has no jsdom/render harness (CLAUDE.md); store/view layers here are verified by tsc + CDP, matching the convention used by `railstore.ts`/`filesstore.ts`. The scan logic that *does* branch is unit-tested in Task 1.

- [ ] **Step 1: Write the store**

Create `frontend/app/view/agents/recentsessionsstore.ts`:

```ts
// frontend/app/view/agents/recentsessionsstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Recent resumable Claude sessions from the backend transcript scan (GetRecentSessions). Powers the
// Agent-tab "No terminal running" hero. `SessionInfo` is the generated wire type (global ambient).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

// null = not loaded yet; [] = loaded-empty.
export const recentSessionsAtom = atom<SessionInfo[] | null>(null) as PrimitiveAtom<SessionInfo[] | null>;

let loading = false;

export async function loadRecentSessions(): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const rtn = await RpcApi.GetRecentSessionsCommand(TabRpcClient, { windowdays: 14, limit: 20 });
        globalStore.set(recentSessionsAtom, rtn.sessions ?? []);
    } catch {
        globalStore.set(recentSessionsAtom, []); // scan failure -> empty list, never breaks the hero
    } finally {
        loading = false;
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit 2>&1 | grep -v "api.test.ts"`
Expected: no new errors (only the leaked second line of the baseline api.test.ts TS2345 may appear). If `SessionInfo` is "Cannot find name", Task 2's `task generate` did not emit the TS type — re-run `task generate` and confirm `SessionInfo` exists in the generated types file.

- [ ] **Step 3: Checkpoint** — confirm, no commit.

---

## Task 4: `agentlaunchhero.tsx` (the hero view)

**Files:**
- Create: `frontend/app/view/agents/agentlaunchhero.tsx`

> No unit test (view-only; verified by tsc + CDP, per the Task 3 note). All colors use existing `@theme` utility classes (no raw hex), per the user's flagged convention.

- [ ] **Step 1: Write the component**

Create `frontend/app/view/agents/agentlaunchhero.tsx`:

```tsx
// frontend/app/view/agents/agentlaunchhero.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Agent-tab "No terminal running" state (handoff dc.html tui.notLaunched, lines 569-583): a
// launch CTA + a list of recent Claude sessions (from recentsessionsstore) you can click to resume.
// Resume + launch both route through launchAgent; resume passes `claude --resume <id>` and no task,
// so the agent picks up its prior session in its original cwd.

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import { formatAge, formatTokens } from "./agentsviewmodel";
import { loadRecentSessions, recentSessionsAtom } from "./recentsessionsstore";

export function AgentLaunchHero({ model }: { model: AgentsViewModel }) {
    const sessions = useAtomValue(recentSessionsAtom);
    useEffect(() => {
        fireAndForget(loadRecentSessions);
    }, []);

    const launchFresh = () =>
        fireAndForget(() =>
            launchAgent(model, {
                runtime: "claude",
                startupCommand: "claude",
                task: "",
                projectPath: "",
                projectName: "agent",
            })
        );

    const resume = (s: SessionInfo) =>
        fireAndForget(() =>
            launchAgent(model, {
                runtime: "claude",
                startupCommand: `claude --resume ${s.id}`,
                task: "",
                projectPath: s.projectpath,
                projectName: s.projectname || "agent",
            })
        );

    const now = Date.now();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center bg-background px-8 py-9">
            <div className="flex w-full max-w-[440px] flex-col items-center text-center">
                <div className="mb-5 flex h-[54px] w-[54px] items-center justify-center rounded-[14px] border border-edge-mid bg-surface-raised text-accent">
                    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 4 6.5 8 3 12" />
                        <line x1="8.5" y1="12" x2="13" y2="12" />
                    </svg>
                </div>
                <div className="text-[16px] font-semibold text-primary">No terminal running</div>
                <p className="mt-2 max-w-[350px] text-[13px] leading-[1.55] text-muted">
                    Launch a Claude Code agent — the full TUI runs live right here.
                </p>
                <button
                    type="button"
                    onClick={launchFresh}
                    className="mt-[22px] flex items-center gap-2 rounded-[9px] bg-accent px-[18px] py-[10px] text-[13px] font-semibold text-background hover:opacity-90"
                >
                    Launch new terminal
                </button>

                {sessions != null && sessions.length > 0 ? (
                    <div className="mt-6 w-full overflow-hidden rounded-[12px] border border-border bg-surface text-left">
                        <div className="flex items-center gap-2 px-[14px] pb-[9px] pt-[11px] font-mono text-[10px] font-semibold uppercase tracking-[.1em] text-muted">
                            <span>Recent sessions</span>
                            <span className="opacity-60">{sessions.length}</span>
                            <div className="flex-1" />
                            <span className="opacity-60">click to resume</span>
                        </div>
                        {sessions.map((s) => (
                            <button
                                key={s.id}
                                type="button"
                                onClick={() => resume(s)}
                                className="flex w-full items-center gap-[11px] border-t border-border px-[14px] py-[11px] text-left hover:bg-surface-hover"
                            >
                                <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-accent" />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[12.5px] font-semibold text-primary">
                                        {s.task || "(untitled session)"}
                                    </div>
                                    <div className="mt-[2px] truncate font-mono text-[10.5px] text-muted">
                                        {s.projectname} · {s.branch || "—"} · {s.model || "—"} · {formatTokens(s.tokenstotal)} tok
                                    </div>
                                </div>
                                <span className="shrink-0 font-mono text-[10.5px] text-muted">
                                    {formatAge(now - s.lastactivets)}
                                </span>
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit 2>&1 | grep -v "api.test.ts"`
Expected: no new errors. (`SessionInfo` global, `formatAge`/`formatTokens` exist in `agentsviewmodel.ts`, `launchAgent`/`LaunchAgentOpts` in `cockpit-actions.ts`.)

- [ ] **Step 3: Checkpoint** — confirm, no commit.

---

## Task 5: Wire the hero into `AgentSurface` + verify

**Files:**
- Modify: `frontend/app/view/agents/agentsurface.tsx` (import + the `if (!agent)` block, lines ~54-60)

- [ ] **Step 1: Add the import**

In `frontend/app/view/agents/agentsurface.tsx`, add after the `AgentHeader` import (line ~20):

```tsx
import { AgentLaunchHero } from "./agentlaunchhero";
```

- [ ] **Step 2: Swap the empty-roster branch**

Replace the existing block (lines ~54-60):

```tsx
    if (!agent) {
        return (
            <div className="flex h-full w-full items-center justify-center text-[13px] text-muted">
                No active agents.
            </div>
        );
    }
```

with:

```tsx
    if (!agent) {
        return <AgentLaunchHero model={model} />;
    }
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit 2>&1 | grep -v "api.test.ts"`
Expected: no new errors.

- [ ] **Step 4: Run the existing test suite (no regressions)**

Run: `npx vitest run`
Expected: all green (baseline 391 passed; this plan adds no FE tests, so the count is unchanged).

- [ ] **Step 5: CDP visual verification (live dev app)**

Pre-req: dev app running via `tail -f /dev/null | task dev` (the stdin-EOF gotcha), CDP on `:9222`. Ensure **zero live agents** in the dev roster (close any, or use a clean dev data dir) so the Agent surface hits the empty-roster branch.
- Navigate to the Agent tab, confirm the "No terminal running" hero renders with a Launch CTA and (if transcripts exist) a Recent-sessions list.
- Capture: `node scripts/cdp-shot.mjs agent-hero.png`.
- Click a recent session; confirm a terminal launches and `--resume` is in its command (the agent appears as a live roster row and the TUI takes over).

- [ ] **Step 6: Checkpoint** — confirm hero renders + resume launches.

---

## Task 6: Final commit (await approval)

- [ ] **Step 1: Self-review the diff**

Run: `git status && git diff --stat`
Confirm only the intended files changed (plus the three regenerated binding files from `task generate`). No debug logs, no commented-out code.

- [ ] **Step 2: Present for approval (per CLAUDE.md — never commit without it)**

Show the file list (M/A/D) + this proposed message, then ask "Awaiting approval. Proceed? (yes/no)":

```
feat(agents): resume past sessions from the Agent-tab launch hero

Empty-roster Agent tab now shows a "No terminal running" hero listing recent
Claude sessions (new pkg/agentsessions transcript scan + GetRecentSessions
wshrpc command); clicking one resumes it via `claude --resume`. Folds in the
real-tui header-controls work and the two design/spec docs.
```

The commit folds in: Tasks 1-5 here, the Task-1-of-the-other-thread header controls (`agentheader.tsx`, etc.), `2026-06-29-agent-tab-real-tui-design.md`, `2026-06-29-agent-tab-resume-sessions.md` (spec), and this plan — per the user's "spec/plan docs fold into the feature commit" rule.

- [ ] **Step 3: On approval, commit** (do not push unless asked).

---

## Self-review (plan vs. spec)

**Spec coverage:**
- Backend scan reusing usagestats walk → Task 1. ✅
- `GetRecentSessions` wshrpc + codegen → Task 2. ✅
- `recentsessionsstore.ts` → Task 3. ✅
- `agentlaunchhero.tsx` (hero = CTA + resume list) → Task 4. ✅
- `agentsurface.tsx` empty-roster swap → Task 5. ✅
- Resume via `launchAgent` + `claude --resume <id>` → Task 4 (`resume`). ✅
- Edge: scan failure → empty list (Task 3 catch); missing root → nothing (Task 1 test). ✅
- Deferred (Codex resume, status field, dedupe-vs-live, sessions nav surface, resume-while-busy): intentionally **not** in any task — matches the spec's Deferred section. ✅

**Placeholder scan:** none — every code step has full code; every command has expected output.

**Type consistency:** Go `SessionInfo` fields (Task 1) → wire `SessionInfo` json tags (Task 2: `projectpath`/`projectname`/`tokenstotal`/`lastactivets`) → FE reads the lowercased tag names (`s.projectpath`, `s.projectname`, `s.tokenstotal`, `s.lastactivets`) in Task 4, mapped to `LaunchAgentOpts`' camelCase (`projectPath`/`projectName`). Command name derives to `"getrecentsessions"`. Consistent across tasks. ✅
