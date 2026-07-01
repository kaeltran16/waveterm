# Jarvis Delegator (v1.1: Fan-out) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Fan-out mode to the Delegator — Jarvis decomposes a goal into independent subtasks and spawns one Claude worker per subtask in its own git worktree, each Gatekeeper-coupled.

**Architecture:** A new fail-safe backend command `JarvisDecomposeCommand` (mirrors the shipped Gatekeeper `Classify` pattern: pure `BuildDecomposePrompt` + `ParseDecompose`, impure `Decompose` via `consult.Run(claude -p)`). The FE fan-out branch calls it, then reuses the shipped `launchAgent({branch})` worktree spawn once per subtask, posting a `"dispatch"` message per worker so each auto-couples to Gatekeeper. No new spawn machinery; no new waveobj type.

**Tech Stack:** Go (wavesrv, wshrpc, consult), TypeScript/React (cockpit FE), vitest, Go testing. Codegen via `task generate`.

**Depends on:** v1 plan `docs/superpowers/plans/2026-07-01-jarvis-delegator.md` (Report + Manage) — specifically `planDelegate` returning `mode:"fanout"` and the `sendChannelMessage` delegate branch it feeds.

**Spec:** `docs/superpowers/specs/2026-07-01-jarvis-delegator-design.md`

---

### Task 1: `BuildDecomposePrompt` + `ParseDecompose` (Go, pure)

**Files:**
- Create: `pkg/jarvis/decompose.go`
- Test: `pkg/jarvis/decompose_test.go`

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvis/decompose_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import "testing"

func TestParseDecompose(t *testing.T) {
	goal := "add coupon codes"
	t.Run("valid array", func(t *testing.T) {
		got := ParseDecompose(`sure: ["add input","wire totals","write tests"] done`, goal)
		if len(got) != 3 || got[0] != "add input" || got[2] != "write tests" {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("no array falls back to goal", func(t *testing.T) {
		got := ParseDecompose("I cannot split this", goal)
		if len(got) != 1 || got[0] != goal {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("malformed json falls back to goal", func(t *testing.T) {
		got := ParseDecompose(`[not valid`, goal)
		if len(got) != 1 || got[0] != goal {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("empty array falls back to goal", func(t *testing.T) {
		got := ParseDecompose(`[]`, goal)
		if len(got) != 1 || got[0] != goal {
			t.Fatalf("got %#v", got)
		}
	})
	t.Run("blanks dropped and capped at 5", func(t *testing.T) {
		got := ParseDecompose(`["a","","b","c","d","e","f"]`, goal)
		if len(got) != 5 || got[0] != "a" || got[4] != "f" {
			t.Fatalf("got %#v", got)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/jarvis/ -run TestParseDecompose -v`
Expected: FAIL — `undefined: ParseDecompose`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/jarvis/decompose.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	decomposeTimeout = 120 * time.Second
	maxSubtasks      = 5
)

// BuildDecomposePrompt asks for a JSON array of independent, parallelizable subtasks. If the goal is
// not safely splittable the model is told to return a single-element array (the whole goal).
func BuildDecomposePrompt(goal string, channel *waveobj.Channel) string {
	name := "this"
	if channel != nil && channel.Name != "" {
		name = channel.Name
	}
	return strings.Join([]string{
		fmt.Sprintf(`You are Jarvis, planning parallel work for coding agents in the "%s" channel.`, name),
		`Break the goal into 2 to 5 INDEPENDENT subtasks that can be implemented in parallel git worktrees without conflicting. Each subtask must be self-contained and worth its own worker. If the goal is small or not safely splittable, return a single-element array containing the whole goal.`,
		"",
		"Goal: " + goal,
		"",
		`Reply with ONLY a JSON array of short imperative subtask strings, no prose. Example: ["add the CouponInput component","wire discounts into cart totals","write coupon tests"].`,
	}, "\n")
}

// ParseDecompose extracts the JSON array from the reply, trims and drops blank entries, and caps at
// maxSubtasks. ANY problem — no array, bad JSON, or all-empty — falls back to a single dispatch of the
// whole goal, so Fan-out degrades to Manage rather than erroring.
func ParseDecompose(reply, goal string) []string {
	start := strings.Index(reply, "[")
	end := strings.LastIndex(reply, "]")
	if start < 0 || end <= start {
		return []string{goal}
	}
	var arr []string
	if err := json.Unmarshal([]byte(reply[start:end+1]), &arr); err != nil {
		return []string{goal}
	}
	var out []string
	for _, s := range arr {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
		if len(out) == maxSubtasks {
			break
		}
	}
	if len(out) == 0 {
		return []string{goal}
	}
	return out
}

// Decompose runs the headless claude planner. Fails safe to a single-element list on any CLI/timeout
// error (never blocks the dispatch).
func Decompose(ctx context.Context, projectPath, goal string, channel *waveobj.Channel) []string {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return []string{goal}
	}
	runCtx, cancel := context.WithTimeout(ctx, decomposeTimeout)
	defer cancel()
	reply, err := consult.Run(runCtx, spec, projectPath, BuildDecomposePrompt(goal, channel), func(string) {})
	if err != nil {
		return []string{goal}
	}
	return ParseDecompose(reply, goal)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/jarvis/ -run TestParseDecompose -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/decompose.go pkg/jarvis/decompose_test.go
git commit -m "feat(jarvis): fail-safe goal decompose (BuildDecomposePrompt/ParseDecompose)"
```

---

### Task 2: `JarvisDecomposeCommand` (Go wshrpc)

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface + data + rtn types)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (handler)
- Runs codegen: `task generate`

- [ ] **Step 1: Add the command to the interface**

In `pkg/wshrpc/wshrpctypes.go`, directly below the `JarvisCommand` line (~line 114) add:

```go
	JarvisDecomposeCommand(ctx context.Context, data CommandJarvisDecomposeData) (*CommandJarvisDecomposeRtnData, error) // decompose a goal into independent parallel subtasks (Delegator fan-out); fails safe to [goal]
```

- [ ] **Step 2: Add the data + return types**

In `pkg/wshrpc/wshrpctypes.go`, near the other channel command types (below `CommandSetChannelTierData` from the v1 plan) add:

```go
type CommandJarvisDecomposeData struct {
	ChannelId string `json:"channelid"`
	Goal      string `json:"goal"`
}

type CommandJarvisDecomposeRtnData struct {
	Subtasks []string `json:"subtasks"`
}
```

- [ ] **Step 3: Implement the handler**

In `pkg/wshrpc/wshserver/wshserver.go`, below `SetChannelTierCommand` (from the v1 plan) add:

```go
func (ws *WshServer) JarvisDecomposeCommand(ctx context.Context, data wshrpc.CommandJarvisDecomposeData) (*wshrpc.CommandJarvisDecomposeRtnData, error) {
	if strings.TrimSpace(data.Goal) == "" {
		return nil, fmt.Errorf("goal is required")
	}
	var channel *waveobj.Channel
	projectPath := ""
	if data.ChannelId != "" {
		channels, err := wstore.GetChannels(ctx)
		if err == nil {
			for _, ch := range channels {
				if ch.OID == data.ChannelId {
					channel = ch
					projectPath = ch.ProjectPath
					break
				}
			}
		}
	}
	subtasks := jarvis.Decompose(ctx, projectPath, data.Goal, channel)
	return &wshrpc.CommandJarvisDecomposeRtnData{Subtasks: subtasks}, nil
}
```

- [ ] **Step 4: Regenerate bindings**

Run: `task generate`
Expected: no errors; `git diff --stat` shows `JarvisDecomposeCommand` added in `pkg/wshrpc/wshclient/wshclient.go` and `frontend/app/store/wshclientapi.ts`, and the two new types in `frontend/types/gotypes.d.ts`.

- [ ] **Step 5: Verify the backend builds**

Run: `go build ./pkg/... ./cmd/...`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(jarvis): JarvisDecomposeCommand exposes fan-out decompose to the FE"
```

---

### Task 3: Fan-out spawn branch in `sendChannelMessage` (FE glue)

**Files:**
- Modify: `frontend/app/view/agents/channelactions.ts`

**Context:** The v1 delegate branch handles a single dispatch. This task adds a fan-out short-circuit for `del.mode === "fanout"` that decomposes the goal and spawns one worktree-isolated worker per subtask. `planDelegate` (pure, from the v1 plan) is unchanged.

- [ ] **Step 1: Add imports**

In `frontend/app/view/agents/channelactions.ts`, add `deriveBranch` to the existing `./launch` import:

```ts
import { deriveBranch, runtimeStartupCommand } from "./launch";
```

- [ ] **Step 2: Add the fan-out branch**

In the delegate block (inside `if (plan.kind === "jarvis")`, after `const del = planDelegate(...)` and the `if (del.action === "dispatch") {`), insert the fan-out handling BEFORE the single-dispatch `launchAgent` call:

```ts
        if (del.action === "dispatch") {
            if (del.mode === "fanout") {
                const { subtasks } = await RpcApi.JarvisDecomposeCommand(
                    TabRpcClient,
                    { channelid: channelId, goal: plan.text },
                    { timeout: CONSULT_RPC_TIMEOUT_MS }
                );
                let existing: string[] = [];
                try {
                    const br = await RpcApi.ListBranchesCommand(TabRpcClient, { projectpath: projectPath });
                    existing = (br.branches ?? []).map((b) => b.name);
                } catch {
                    // no git / listing failed — deriveBranch still yields unique names off an empty set
                }
                const base = projectName || "agent";
                for (let i = 0; i < subtasks.length; i++) {
                    const branch = deriveBranch(`${base}-${i + 1}`, existing);
                    existing.push(branch);
                    const task = `/goal ${subtasks[i]}`;
                    const tabId = await launchAgent(model, {
                        runtime: "claude",
                        startupCommand: runtimeStartupCommand("claude"),
                        task,
                        projectPath,
                        projectName: `${base}-${i + 1}`,
                        branch,
                    });
                    await post(channelId, "dispatch", "claude", task, `tab:${tabId}`);
                }
                return;
            }
            // (v1 single-dispatch path continues below unchanged)
```

Leave the existing single-dispatch `launchAgent` + `post("dispatch", ...)` (report/manage) exactly as-is after this block.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 pre-existing `frontend/tauri/api.test.ts` baseline errors.

- [ ] **Step 4: Run the FE test suite**

Run: `npx vitest run`
Expected: all green (no new behavior for non-fanout paths).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/channelactions.ts
git commit -m "feat(jarvis): fan-out dispatch spawns one worktree worker per subtask"
```

---

### Task 4: Live verification (CDP on the dev app)

**Reference:** requires a wavesrv rebuild (new commands) — per project notes, touch `src-tauri/src/main.rs` to trigger the cargo-tauri watcher relaunch that re-spawns wavesrv from `dist/bin`; run `task dev` kept alive via `tail -f /dev/null | task dev`; drive over CDP on `:9222` (`scripts/cdp-shot.mjs`).

- [ ] **Step 1: Set a channel to Delegator + fanout default**

Over CDP call `SetChannelTierCommand` `{tier:"delegator", mode:"fanout"}` for a test channel bound to a real repo (`ProjectPath` set). Confirm meta shows `delegator:mode="fanout"`.

- [ ] **Step 2: Decompose smoke test**

Over CDP call `JarvisDecomposeCommand` `{channelid, goal:"add a coupon-code field to checkout"}` directly and confirm it returns a JSON array of 2–5 subtask strings (proves the claude planner + parse round-trip on the running backend).

- [ ] **Step 3: Full fan-out dispatch**

Send `@jarvis add a coupon-code field to checkout` in the channel. Verify: multiple agent tabs spawn, each in its own worktree (check the worktree paths differ), one `"dispatch"` message per worker appears (each `tab:<id>`), and the roster shows all workers.

- [ ] **Step 4: Gatekeeper couples per worker**

Confirm that when any fan-out worker raises a routine `AskUserQuestion`, Gatekeeper auto-answers it (a `jarvis-answered` message + the worker resumes) — proving each spawned worker is Gatekeeper-coupled via its dispatch RefORef.

- [ ] **Step 5: Fail-safe check**

Send `@jarvis:fanout <a tiny goal>` and confirm that when decompose returns a single element, exactly one worker spawns (degrades to a single `/goal` dispatch, no error).

- [ ] **Step 6: Record results**

Note pass/fail per step in the PR/commit description. No code commit unless a fix is needed.

---

## Self-review notes

- **Spec coverage:** Fan-out decompose (Task 1 pure + Task 2 command), per-worker worktree spawn via `launchAgent({branch})` (Task 3), N dispatch messages so each worker Gatekeeper-couples (Task 3 + verified Task 4), fail-safe degrade to single dispatch (Task 1 `ParseDecompose`, Task 4 step 5), blast-radius cap `maxSubtasks=5` (Task 1). Worktree trust gate is a known deferred item (spec §Error handling) — surfaces as a one-time manual confirm in each worker terminal.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `ParseDecompose(reply, goal)` / `Decompose(ctx, projectPath, goal, channel)` / `maxSubtasks` defined Task 1, used Task 2; `CommandJarvisDecomposeData{ChannelId,Goal}` / `CommandJarvisDecomposeRtnData{Subtasks}` defined Task 2, consumed Task 3; `deriveBranch(base, existing)` and `ListBranchesCommand({projectpath})→{branches:[{name}]}` are existing shipped APIs.

## Deferred (presentational / later)

- **Grouped fan-out card.** v1.1 posts N separate `"dispatch"` messages (one per worker) — the channel shows N rows. The handoff mock renders the N workers inside a single aggregated dispatch card; grouping them visually (by a shared dispatch group correlation) is a presentational follow-up and is not required for the functional fan-out. Reference: `wave-handoff/wave/project/Wave-cockpit-live.dc.html` (fan-out dispatch card).
- Aggregated completion summary across the N workers.
- Worktree auto-trust affordance (avoid the per-worktree "trust this folder?" prompt).
