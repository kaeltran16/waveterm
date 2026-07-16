# Channel notes + Quick Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Refreshed 2026-07-16** against the current tree. The `0383e8b5` decompose refactor (plus composer-attachments and center-column commits) moved the frontend targets after this plan was first written: the notes UI is now in `channelchrome.tsx` (`OverviewStrip`, presentational) and the `@quick` send path is a branch in `channelssurface.tsx`'s `send()` handler. Backend verification also caught a type error in the original Task 1 (principles are a `waveobj.PrincipleList`, not a `string`). All anchors and code below are re-verified against the tree.

**Goal:** Turn the disabled "Channel notes" placeholder into a real persisted field, and make `@quick` create a real one-phase Run object (own run-strip tab + `Q` badge + Done lifecycle) instead of an ad-hoc dispatch.

**Architecture:** Both features reuse established patterns. Channel notes store at `Channel.Meta["channel:notes"]` via a `SetChannelNotesCommand` that clones `SetChannelTierCommand`. Quick Run adds a `RunMode_Quick` that resolves to a single-phase `execute` playbook with a bare (skill-less) worker prompt; the FE `@quick` command routes through `launchRun(body, {mode:"quick"})` like `@run` does.

**Tech Stack:** Go (wavesrv/wshrpc), React 19 + jotai + Tailwind 4 (cockpit FE), vitest for pure FE logic, `go test` for Go, CDP for cockpit visual verification (no jsdom render harness).

## Global Constraints

- **Never hand-edit generated files.** Go is the source of truth for the wire protocol. After changing any wshrpc type/interface, run `task generate` (regenerates `pkg/wshrpc/wshclient/wshclient.go`, `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`).
- **Go sqlite tests need CGO+zig.** Run package tests as: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/jarvis/...`
- **tsc gotcha:** typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline is clean; any error is yours).
- **No jsdom render harness for the cockpit** — React components are verified in the live dev app over CDP (`node scripts/cdp-shot.mjs [out.png]`), not unit-rendered.
- **Comments only for "why," lowercase, only when necessary.** Match surrounding code.
- **Do not commit without explicit user approval** (project rule); batch into a single commit at the end. Steps below show the intended commit but the executor must hold for approval.

## File Structure

- `pkg/jarvis/run.go` — add `RunMode_Quick`, `QuickPlaybook()`, `BuildQuickPrompt()`.
- `pkg/jarvis/runexec.go` — `phasePrompt` quick branch.
- `pkg/jarvis/run_test.go` — tests for the three additions.
- `pkg/wshrpc/wshserver/wshserver.go` — `resolveRunPlan` quick branch; new `SetChannelNotesCommand`.
- `pkg/wshrpc/wshrpctypes.go` — `CommandSetChannelNotesData` type + interface method; `CommandCreateRunData.Mode` doc comment.
- `pkg/jarvis/resolve.go` — `MetaKey_ChannelNotes` constant (in the const block with the delegator/gatekeeper channel-meta keys, ~lines 16-23).
- `frontend/app/view/agents/channelssurface.tsx` — `@quick`→`launchRun({mode:"quick"})` branch in `send()`; notes draft state + wiring passed to `OverviewStrip`.
- `frontend/app/view/agents/channelchrome.tsx` — `OverviewStrip` gains `notes`/`onNotesChange` props; collapsed hint + editable textarea.
- `frontend/app/view/agents/channelsstore.ts` — `setChannelNotes` action.
- `docs/deferred.md` — mark items resolved.

---

### Task 1: Quick Run backend (jarvis mode + playbook + prompt + resolution)

**Files:**
- Modify: `pkg/jarvis/run.go` (run-modes block at lines 34-38; add funcs after `DefaultOrchestratorPlaybook` ~line 80 and after `BuildPhasePrompt` ~line 288)
- Modify: `pkg/jarvis/runexec.go:96-102` (`phasePrompt`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1794-1811` (`resolveRunPlan`) and `pkg/wshrpc/wshrpctypes.go` (`CommandCreateRunData.Mode` comment)
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Produces:
  - `const RunMode_Quick = "quick"`
  - `func QuickPlaybook() []waveobj.RunPhase`
  - `func BuildQuickPrompt(goal string, principles waveobj.PrincipleList) string`
- Consumes: `waveobj.RunPhase`, `PhaseKind_Execute`, `PhaseState_Pending`, `NewRun`, `recomputeStatus`, `RenderPrinciples` (existing in `pkg/jarvis`).

> **Correctness note (verified):** `NewRun(goal, workspaceId, projectPath string, principles waveobj.PrincipleList, mode string, playbook []waveobj.RunPhase, ts int64)` — the 4th arg is a `waveobj.PrincipleList`, not a string. `phasePrompt` passes `run.Principles` (a `PrincipleList`). `BuildQuickPrompt` must therefore accept a `PrincipleList` and render it with `RenderPrinciples` (mirrors `BuildPhasePrompt`/`BuildOrchestratePrompt`). The sibling skill directive text is `"Use the %s skill to work this goal ..."`, so a negative assertion on `"skill to work this goal"` distinguishes the quick prompt.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/jarvis/run_test.go` (ensure the file imports `strings` and `github.com/wavetermdev/waveterm/pkg/waveobj` — existing run tests already use both; add if missing):

```go
func TestQuickPlaybook(t *testing.T) {
	pb := QuickPlaybook()
	if len(pb) != 1 {
		t.Fatalf("QuickPlaybook: want 1 phase, got %d", len(pb))
	}
	p := pb[0]
	if p.Kind != PhaseKind_Execute {
		t.Errorf("phase kind = %q, want %q", p.Kind, PhaseKind_Execute)
	}
	if p.Gate {
		t.Errorf("quick phase must not gate")
	}
	if !p.FreshCtx {
		t.Errorf("quick phase should run in fresh context")
	}
	if p.Skill != "" {
		t.Errorf("quick phase must have no skill, got %q", p.Skill)
	}
}

func TestNewRunQuick(t *testing.T) {
	r := NewRun("fix the flake", "ws1", "/repo", nil, RunMode_Quick, QuickPlaybook(), 1000)
	if r.Mode != RunMode_Quick {
		t.Errorf("mode = %q, want quick", r.Mode)
	}
	if len(r.Phases) != 1 || r.Phases[0].State != PhaseState_Running {
		t.Fatalf("expected one running phase, got %+v", r.Phases)
	}
	if r.Status == RunStatus_AwaitingReview {
		t.Errorf("quick run must not await review")
	}
}

func TestBuildQuickPrompt(t *testing.T) {
	// a single legacy-ID principle renders as its bare text (see RenderPrinciples)
	principles := waveobj.PrincipleList{{ID: waveobj.LegacyGlobalPrincipleID, Text: "be tidy"}}
	p := BuildQuickPrompt("add a spinner", principles)
	for _, want := range []string{"add a spinner", "be tidy", "wsh jarvis complete"} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt missing %q:\n%s", want, p)
		}
	}
	if strings.Contains(p, "skill to work this goal") {
		t.Errorf("quick prompt must not carry a skill directive:\n%s", p)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/jarvis/ -run 'Quick|NewRunQuick' -v`
Expected: FAIL — `undefined: QuickPlaybook`, `undefined: RunMode_Quick`, `undefined: BuildQuickPrompt`.

- [ ] **Step 3: Add the `RunMode_Quick` constant**

In `pkg/jarvis/run.go`, the run-modes block (lines 34-38) currently holds only Pipeline + Orchestrator. Replace it with:

```go
// Run modes.
const (
	RunMode_Quick        = "quick"
	RunMode_Pipeline     = "pipeline"
	RunMode_Orchestrator = "orchestrator"
)
```

- [ ] **Step 4: Add `QuickPlaybook`**

In `pkg/jarvis/run.go`, after `DefaultOrchestratorPlaybook` (~line 80):

```go
// QuickPlaybook is a single bare execute phase: one worker, no plan gate, fresh context, no skill
// scaffolding. The worker is prompted (BuildQuickPrompt) to do the goal directly and self-report.
func QuickPlaybook() []waveobj.RunPhase {
	return []waveobj.RunPhase{
		{Kind: PhaseKind_Execute, State: PhaseState_Pending, FreshCtx: true},
	}
}
```

- [ ] **Step 5: Add `BuildQuickPrompt`**

In `pkg/jarvis/run.go`, after `BuildPhasePrompt` (~line 288). Note the `waveobj.PrincipleList` param and `RenderPrinciples` call — same principles handling as its siblings, minus the skill directive:

```go
// BuildQuickPrompt is the worker prompt for a quick run: same headless guidance as a pipeline execute
// phase but no skill directive — just do the goal directly and report completion.
func BuildQuickPrompt(goal string, principles waveobj.PrincipleList) string {
	var b strings.Builder
	if rendered := RenderPrinciples(principles); rendered != "" {
		fmt.Fprintf(&b, "Work by these principles:\n%s\n\n", rendered)
	}
	b.WriteString("You are running headless with no human at your terminal. Make reasonable assumptions for low-stakes or easily-reversible choices and keep going — do not ask about them. Only when a decision is genuinely consequential and a wrong assumption would waste real work, pause and use the AskUserQuestion tool (it reaches the human in the cockpit); otherwise proceed to the deliverable.\n")
	fmt.Fprintf(&b, "Goal: %s\n", goal)
	b.WriteString("When the goal is fully accomplished, run `wsh jarvis complete`.\n")
	return strings.TrimRight(b.String(), "\n")
}
```

- [ ] **Step 6: Route the quick prompt in `phasePrompt`**

In `pkg/jarvis/runexec.go`, `phasePrompt` (currently lines 96-102) — add the quick branch before the orchestrator check:

```go
func phasePrompt(run *waveobj.Run, idx int) string {
	p := run.Phases[idx]
	if run.Mode == RunMode_Quick {
		return BuildQuickPrompt(run.Goal, run.Principles)
	}
	if run.Mode == RunMode_Orchestrator {
		return BuildOrchestratePrompt(run.Goal, run.Principles, p.Gate)
	}
	return BuildPhasePrompt(p, run.Goal, priorArtifacts(run, idx), run.Principles)
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/jarvis/ -run 'Quick|NewRunQuick' -v`
Expected: PASS (all three).

- [ ] **Step 8: Wire `resolveRunPlan` + fix the doc comment**

In `pkg/wshrpc/wshserver/wshserver.go`, `resolveRunPlan` (~line 1794) — add the quick branch before the orchestrator check:

```go
func resolveRunPlan(resolved waveobj.JarvisProfile, reqMode string, reqPlanGate *bool) (string, []waveobj.RunPhase) {
	mode := reqMode
	if mode == "" {
		mode = resolved.DefaultMode
	}
	if mode == "" {
		mode = jarvis.RunMode_Pipeline
	}
	if mode == jarvis.RunMode_Quick {
		// quick is a bare single-phase run; it has no plan gate, so reqPlanGate is ignored.
		return mode, jarvis.QuickPlaybook()
	}
	if mode == jarvis.RunMode_Orchestrator {
		gate := true
		if reqPlanGate != nil {
			gate = *reqPlanGate
		} else if resolved.DefaultPlanGate != nil {
			gate = *resolved.DefaultPlanGate
		}
		return mode, jarvis.DefaultOrchestratorPlaybook(gate)
	}
	playbook := resolved.Playbook
	if len(playbook) == 0 {
		playbook = jarvis.DefaultPlaybook()
	}
	return mode, playbook
}
```

> Preserve the existing body's exact logic; only the `RunMode_Quick` branch is new. If the current `resolveRunPlan` differs in detail (e.g. field names), keep those and insert only the quick branch before the orchestrator check.

In `pkg/wshrpc/wshrpctypes.go`, update the `CommandCreateRunData.Mode` doc comment to read:
`// quick | pipeline | orchestrator (empty = resolved profile default)`

- [ ] **Step 9: Build the backend to confirm it compiles**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go build ./pkg/...`
Expected: exit 0.

- [ ] **Step 10: Commit** (hold for user approval per project rule)

```bash
git add pkg/jarvis/run.go pkg/jarvis/runexec.go pkg/jarvis/run_test.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshrpctypes.go
git commit -m "feat(jarvis): quick run mode — bare single-phase run object"
```

---

### Task 2: Quick Run frontend (`@quick` → launchRun)

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` — the `send()` handler's command dispatch (currently lines ~233-254)

**Interfaces:**
- Consumes: `launchRun(goal, extra?)` (local helper at `channelssurface.tsx:182`, which calls `createRun(active.oid, goal, {mode, planGate, ...extra})`); `parseComposerCommand` from `./composercommand`; `setActiveRunId` (existing local setter). The backend now accepts `mode: "quick"` (Task 1).
- Produces: nothing consumed downstream.

> **Current state (verified):** `@run` calls `launchRun(cmd.body)` (lines 234-240). `@quick` and `@ask` both fall through to a single transport-string ternary (`channelssurface.tsx:243`): `@quick` → `@{runtime} {body}` (bare dispatch, no run object), `@ask` → `ask @{runtime} {body}` (consult), both via `sendChannelMessage`. This task splits `@quick` out into a real run and leaves the transport for `@ask` only.
>
> `launchRun` spreads `extra` last over `{mode: profile?.defaultmode, planGate: profile?.defaultplangate}`, so `launchRun(cmd.body, {mode: "quick"})` overrides the mode. The `planGate` still rides along but the backend's `resolveRunPlan` ignores it for quick mode (Task 1) — no FE change needed for that.

- [ ] **Step 1: Split `@quick` into its own run branch**

In `channelssurface.tsx`, the `@run` branch stays as-is. Replace the trailing quick/ask transport block (currently lines ~241-254) so `@quick` creates a run mirroring `@run`, and only `@ask` uses the consult transport:

```tsx
        if (cmd.mode === "quick") {
            fireAndForget(async () => {
                const created = await launchRun(cmd.body, { mode: "quick" });
                setActiveRunId(created.id);
            });
            return;
        }
        // @ask → one-shot consult (no worker), via sendChannelMessage's ask transport.
        const transport = `ask @${cmd.runtime ?? "claude"} ${cmd.body}`;
        fireAndForget(() =>
            sendChannelMessage({
                model,
                channelId: active.oid,
                projectPath: active.projectpath ?? "",
                projectName: active.name ?? "agent",
                roster,
                agents,
                text: transport,
            })
        );
```

(The exact `sendChannelMessage({...})` argument object already exists in the current code — reuse it verbatim; only the `transport` string and the new `@quick` branch change.)

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (no new errors).

- [ ] **Step 3: CDP visual verification**

Ensure the dev app is running (`task dev`). In the Channels surface, select/create a channel, type `@quick add a spinner`, press Enter. Verify:
- a new run-strip tab appears with a `Q` badge (`channelchrome.tsx:202`, rendered on `r.mode === "quick"` — no FE change needed there; it lights up once the backend produces quick-mode runs),
- a worker terminal spawns for it,
- the run is selectable and shows a single phase.

Capture: `node scripts/cdp-shot.mjs quick-run.png`. (If the roster is empty, inject with `node scripts/inject-live-agents.mjs <scenario>` first.)
Expected: screenshot shows the `Q`-badged run tab.

- [ ] **Step 4: Commit** (hold for user approval)

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(agents): @quick creates a real quick run object"
```

---

### Task 3: Channel notes backend (meta key + RPC + generate)

**Files:**
- Modify: `pkg/jarvis/resolve.go` (add `MetaKey_ChannelNotes` to the const block with the delegator/gatekeeper channel-meta keys, ~lines 16-23)
- Modify: `pkg/wshrpc/wshrpctypes.go` (add `CommandSetChannelNotesData` type near `CommandSetChannelTierData`; add interface method near the other `SetChannel*Command` methods)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (add `SetChannelNotesCommand` after `SetChannelTierCommand`, which ends at ~line 1657)
- Generated (do not hand-edit; produced by `task generate`): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`

**Interfaces:**
- Produces:
  - `const MetaKey_ChannelNotes = "channel:notes"` (package `jarvis`)
  - `type CommandSetChannelNotesData struct { ChannelId string; Notes string }`
  - `SetChannelNotesCommand(ctx, CommandSetChannelNotesData) error` (RPC; TS client `RpcApi.SetChannelNotesCommand` after generate)
- Consumes: `wstore.DBUpdateFn`, `wcore.SendWaveObjUpdate`, `waveobj.MetaMapType` (existing; verified against `SetChannelTierCommand`).

- [ ] **Step 1: Add the meta-key constant**

In `pkg/jarvis/resolve.go`, in the const block that already holds `MetaKey_GatekeeperEnabled` / `MetaKey_DelegatorEnabled` / `MetaKey_DelegatorMode` (~lines 16-23):

```go
// MetaKey_ChannelNotes holds a channel's free-text notes (plain text; single-writer field).
const MetaKey_ChannelNotes = "channel:notes"
```

(If they are a single grouped `const (...)` block, add the line inside it rather than a second standalone `const`.)

- [ ] **Step 2: Add the command data type**

In `pkg/wshrpc/wshrpctypes.go`, after `CommandSetChannelTierData`:

```go
type CommandSetChannelNotesData struct {
	ChannelId string `json:"channelid"`
	Notes     string `json:"notes"`
}
```

- [ ] **Step 3: Declare the interface method**

In `pkg/wshrpc/wshrpctypes.go`, in `WshRpcInterface`, after the `SetChannelTierCommand` line:

```go
	SetChannelNotesCommand(ctx context.Context, data CommandSetChannelNotesData) error                                   // sets a channel's free-text notes (Channel.Meta["channel:notes"])
```

- [ ] **Step 4: Implement the command**

In `pkg/wshrpc/wshserver/wshserver.go`, after `SetChannelTierCommand` (its closing brace is ~line 1657) — this is a direct clone of that command's shape (`DBUpdateFn` + meta-init + `SendWaveObjUpdate`, verified against lines 1635-1657):

```go
func (ws *WshServer) SetChannelNotesCommand(ctx context.Context, data wshrpc.CommandSetChannelNotesData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		// keep meta clean: an empty notes value drops the key rather than storing ""
		if data.Notes == "" {
			delete(ch.Meta, jarvis.MetaKey_ChannelNotes)
		} else {
			ch.Meta[jarvis.MetaKey_ChannelNotes] = data.Notes
		}
	})
	if err != nil {
		return fmt.Errorf("updating channel notes: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
```

- [ ] **Step 5: Build to confirm the interface is satisfied**

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go build ./pkg/...`
Expected: exit 0 (a missing impl would fail: `*WshServer does not implement WshRpcInterface`).

- [ ] **Step 6: Regenerate the clients**

Run: `task generate`
Expected: exit 0; `git status` shows modified `pkg/wshrpc/wshclient/wshclient.go`, `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts` containing `SetChannelNotes`.

Verify: `grep -c SetChannelNotes frontend/app/store/wshclientapi.ts` returns ≥ 1.

- [ ] **Step 7: Commit** (hold for user approval)

```bash
git add pkg/jarvis/resolve.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshclient/wshclient.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "feat(agents): SetChannelNotesCommand — persist channel notes to meta"
```

---

### Task 4: Channel notes frontend (store action + OverviewStrip props + surface wiring)

**Files:**
- Modify: `frontend/app/view/agents/channelsstore.ts` (add `setChannelNotes` after `archiveChannel` ~line 104)
- Modify: `frontend/app/view/agents/channelchrome.tsx` (`OverviewStrip` gains `notes`/`onNotesChange` props; collapsed hint + editable textarea replace the "coming soon" placeholders at lines 116-118 and 122-130)
- Modify: `frontend/app/view/agents/channelssurface.tsx` (import `setChannelNotes`; add `useRef` to the React import; add notes draft state + debounced change handler; pass `notes`/`onNotesChange` to `<OverviewStrip>` at ~line 306)

**Interfaces:**
- Consumes: `RpcApi.SetChannelNotesCommand` (generated in Task 3), `TabRpcClient`, `loadChannels` (existing in `channelsstore.ts`); `active.oid`, `active.meta` (existing channel VM from `activeChannelAtom`).
- Produces:
  - `export async function setChannelNotes(channelId: string, notes: string): Promise<void>`
  - `OverviewStrip` props `notes: string`, `onNotesChange: (value: string) => void`.

- [ ] **Step 1: Add the store action**

In `frontend/app/view/agents/channelsstore.ts`, after `archiveChannel` (~line 104):

```ts
// Persist a channel's notes (a Channel.Meta field), then refresh the snapshot-fed rail. Mirrors
// setChannelTier — the surface reads active.meta from the channelsAtom snapshot, so it needs a re-fetch.
export async function setChannelNotes(channelId: string, notes: string): Promise<void> {
    await RpcApi.SetChannelNotesCommand(TabRpcClient, { channelid: channelId, notes });
    await loadChannels();
}
```

- [ ] **Step 2: Add `notes`/`onNotesChange` props to `OverviewStrip`**

In `frontend/app/view/agents/channelchrome.tsx`, extend the `OverviewStrip` prop signature (currently `open, onToggle, runCount, summary, onRunSummary`):

```tsx
export function OverviewStrip({
    open,
    onToggle,
    runCount,
    summary,
    onRunSummary,
    notes,
    onNotesChange,
}: {
    open: boolean;
    onToggle: () => void;
    runCount: number;
    summary: SummaryState | null;
    onRunSummary: () => void;
    notes: string;
    onNotesChange: (value: string) => void;
}) {
```

- [ ] **Step 3: Wire the collapsed hint**

In the same file, replace the collapsed-strip hint (currently lines 115-119, "Channel notes — coming soon"):

```tsx
                {!open ? (
                    <span className="truncate text-[11px] text-muted" style={{ maxWidth: 420 }}>
                        {notes.trim() ? notes.trim() : "No notes yet"}
                    </span>
                ) : null}
```

- [ ] **Step 4: Replace the disabled placeholder with a textarea**

In the same file, the expanded notes block (currently lines 123-130) — swap the disabled div for a controlled textarea. `stopPropagation` on the click keeps typing from toggling the strip (the wrapping `<button>` collapses it on click):

```tsx
                    <div className="min-w-0 flex-1">
                        <div className="mb-1.5 font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-muted">
                            Channel notes
                        </div>
                        <textarea
                            value={notes}
                            onChange={(e) => onNotesChange(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            placeholder="Notes for this channel…"
                            rows={4}
                            className="w-full resize-y rounded-[10px] border border-border bg-background px-3 py-2.5 text-[12.5px] leading-[1.6] text-secondary outline-none focus:border-accent/40"
                        />
                    </div>
```

> Note: the expanded region (`channelchrome.tsx:121-160`) is rendered *inside* the toggle `<button>`. If nesting a textarea in the button causes hydration/interaction issues, lift the expanded `<div>` out of the button as a sibling (keeping the same `open` guard) — a small, contained refactor. Verify interaction in the CDP step.

- [ ] **Step 5: Import the action and add draft state in the surface**

In `channelssurface.tsx`:

- Add `useRef` to the React import (currently `import { useEffect, useState } from "react";` → `import { useEffect, useRef, useState } from "react";`).
- Add `setChannelNotes` to the existing `./channelsstore` import (alongside `setChannelTier`).
- Near the other component state (the `useState` block ~lines 63-72), add per-channel draft state seeded on channel change, plus a debounced change handler:

```tsx
    const [notesDraft, setNotesDraft] = useState("");
    useEffect(() => {
        const stored = (active?.meta as Record<string, unknown> | undefined)?.["channel:notes"];
        setNotesDraft(typeof stored === "string" ? stored : "");
        // re-seed only when the active channel changes, not on every meta update (avoids clobbering typing)
    }, [active?.oid]);

    const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onNotesChange = (value: string) => {
        setNotesDraft(value);
        if (!active) {
            return;
        }
        const oid = active.oid;
        if (notesTimer.current) {
            clearTimeout(notesTimer.current);
        }
        notesTimer.current = setTimeout(() => {
            fireAndForget(() => setChannelNotes(oid, value));
        }, 600);
    };
```

- [ ] **Step 6: Pass the props to `<OverviewStrip>`**

In `channelssurface.tsx`, the `<OverviewStrip .../>` render (~line 306) — add the two props:

```tsx
                                <OverviewStrip
                                    open={overviewOpen}
                                    onToggle={() => setOverviewOpen((o) => !o)}
                                    runCount={runs.length}
                                    summary={summary}
                                    onRunSummary={() => runSummary(active, agents)}
                                    notes={notesDraft}
                                    onNotesChange={onNotesChange}
                                />
```

- [ ] **Step 7: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 8: CDP visual verification**

Dev app running. In Channels: expand "Overview & notes", type into the notes textarea, wait ~1s, collapse the strip → the collapsed hint shows the typed text (not "No notes yet"). Switch to another channel and back → notes persist and the correct per-channel text shows. Reload the app → notes still present (confirms backend persistence).

Capture: `node scripts/cdp-shot.mjs channel-notes.png`.
Expected: screenshot shows the editable notes with typed content.

- [ ] **Step 9: Commit** (hold for user approval)

```bash
git add frontend/app/view/agents/channelsstore.ts frontend/app/view/agents/channelchrome.tsx frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(agents): editable channel notes in the overview strip"
```

---

### Task 5: Update deferred log + final verification

**Files:**
- Modify: `docs/deferred.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Mark both items resolved in `docs/deferred.md`**

Edit the "Channel notes (merged surface)" entry (top of file): add a `> **Resolved 2026-07-16:**` blockquote noting the `SetChannelNotesCommand` + `Channel.Meta["channel:notes"]` + textarea landed, and the Quick Run follow-up shipped as `RunMode_Quick` (bare single-phase run). Keep the original text below for history (match the file's existing resolved-entry style, e.g. the "Usage-bar token counts" entry).

- [ ] **Step 2: Full verification sweep**

Run each and confirm:
- `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/jarvis/... -v` → PASS
- `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go build ./pkg/...` → exit 0
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0
- `git status` shows no unintended edits to generated files beyond Task 3's regeneration.

- [ ] **Step 3: Commit** (hold for user approval)

```bash
git add docs/deferred.md
git commit -m "docs(deferred): resolve channel-notes + quick-run"
```

---

## Self-Review

- **Spec coverage:** Feature A backend → Task 3; Feature A FE → Task 4; Feature B backend → Task 1; Feature B FE → Task 2; testing (Go unit + CDP) → Tasks 1/2/4; rollout checklist incl. `task generate`, tsc, CDP, deferred.md → Tasks 3/5. All spec sections mapped.
- **Placeholder scan:** every code step shows complete code; no TBD/TODO. CDP steps describe exact actions + expected result (no jsdom harness exists — this is the repo's real verification method).
- **Anchor freshness (2026-07-16):** all line numbers re-verified against the tree. Backend: run-modes block `run.go:34-38`, `phasePrompt` `runexec.go:96`, `resolveRunPlan` `wshserver.go:1794`, `SetChannelTierCommand` `wshserver.go:1635-1657`, channel-meta consts `resolve.go:16-23`. Frontend: `send()` dispatch `channelssurface.tsx:233-254`, `launchRun` helper `channelssurface.tsx:182`, `OverviewStrip` `channelchrome.tsx:85-163`, `<OverviewStrip>` render `channelssurface.tsx:306`, state block `channelssurface.tsx:63-72`.
- **Type consistency:** `BuildQuickPrompt(goal string, principles waveobj.PrincipleList)` (NOT string — verified against `NewRun`/`phasePrompt`/`BuildPhasePrompt`); `RunMode_Quick`, `QuickPlaybook`, `MetaKey_ChannelNotes`, `CommandSetChannelNotesData{ChannelId,Notes}`, `setChannelNotes(channelId, notes)`, `RpcApi.SetChannelNotesCommand({channelid, notes})`, `notesDraft`/`onNotesChange`, `OverviewStrip` `notes`/`onNotesChange` props — names used identically across producing and consuming tasks.
