# Channel notes + Quick Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the disabled "Channel notes" placeholder into a real persisted field, and make `@quick` create a real one-phase Run object (own run-strip tab + `Q` badge + Done lifecycle) instead of an ad-hoc dispatch.

**Architecture:** Both features reuse established patterns. Channel notes store at `Channel.Meta["channel:notes"]` via a `SetChannelNotesCommand` that clones `SetChannelTierCommand`. Quick Run adds a `RunMode_Quick` that resolves to a single-phase `execute` playbook with a bare (skill-less) worker prompt; the FE `@quick` command routes through `createRun({mode:"quick"})` like `@run` does.

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
- `pkg/jarvis/resolve.go` — `MetaKey_ChannelNotes` constant.
- `frontend/app/view/agents/channelssurface.tsx` — `@quick`→`createRun` redirect; notes textarea.
- `frontend/app/view/agents/channelsstore.ts` — `setChannelNotes` action.
- `docs/deferred.md` — mark items resolved.

---

### Task 1: Quick Run backend (jarvis mode + playbook + prompt + resolution)

**Files:**
- Modify: `pkg/jarvis/run.go` (run-modes block ~line 34; add funcs near `DefaultOrchestratorPlaybook` ~line 80 and `BuildPhasePrompt` ~line 266)
- Modify: `pkg/jarvis/runexec.go:96-102` (`phasePrompt`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1747-1769` (`resolveRunPlan`) and `pkg/wshrpc/wshrpctypes.go` (`CommandCreateRunData.Mode` comment)
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Produces:
  - `const RunMode_Quick = "quick"`
  - `func QuickPlaybook() []waveobj.RunPhase`
  - `func BuildQuickPrompt(goal, principles string) string`
- Consumes: `waveobj.RunPhase`, `PhaseKind_Execute`, `PhaseState_Pending`, `NewRun`, `recomputeStatus` (existing in `run.go`).

- [ ] **Step 1: Write the failing tests**

Append to `pkg/jarvis/run_test.go`:

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
	r := NewRun("fix the flake", "ws1", "/repo", "", RunMode_Quick, QuickPlaybook(), 1000)
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
	p := BuildQuickPrompt("add a spinner", "be tidy")
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

In `pkg/jarvis/run.go`, the run-modes block:

```go
// Run modes.
const (
	RunMode_Quick        = "quick"
	RunMode_Pipeline     = "pipeline"
	RunMode_Orchestrator = "orchestrator"
)
```

- [ ] **Step 4: Add `QuickPlaybook`**

In `pkg/jarvis/run.go`, after `DefaultOrchestratorPlaybook`:

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

In `pkg/jarvis/run.go`, after `BuildPhasePrompt`:

```go
// BuildQuickPrompt is the worker prompt for a quick run: same headless guidance as a pipeline phase
// but no skill directive — just do the goal directly and report completion.
func BuildQuickPrompt(goal, principles string) string {
	var b strings.Builder
	if strings.TrimSpace(principles) != "" {
		fmt.Fprintf(&b, "Work by these principles:\n%s\n\n", principles)
	}
	b.WriteString("You are running headless with no human at your terminal. Make reasonable assumptions for low-stakes or easily-reversible choices and keep going — do not ask about them. Only when a decision is genuinely consequential and a wrong assumption would waste real work, pause and use the AskUserQuestion tool (it reaches the human in the cockpit); otherwise proceed to the deliverable.\n")
	fmt.Fprintf(&b, "Goal: %s\n", goal)
	b.WriteString("When the goal is fully accomplished, run `wsh jarvis complete`.\n")
	return strings.TrimRight(b.String(), "\n")
}
```

- [ ] **Step 6: Route the quick prompt in `phasePrompt`**

In `pkg/jarvis/runexec.go`, `phasePrompt` (currently lines 96-102):

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

In `pkg/wshrpc/wshserver/wshserver.go`, `resolveRunPlan` — add the quick branch before the orchestrator check:

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

### Task 2: Quick Run frontend (`@quick` → createRun)

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx:735-760` (Launch-face send handler)

**Interfaces:**
- Consumes: `createRun(channelId, goal, opts)` from `./runactions` (accepts `{ mode }`); `parseComposerCommand` from `./composercommand`; `setActiveRunId` (existing local setter). The backend now accepts `mode: "quick"` (Task 1).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Redirect the quick branch**

In `channelssurface.tsx`, replace the current quick/ask transport block (lines ~745-759) so `@quick` creates a run and only `@ask` uses the consult transport:

```tsx
        if (cmd.mode === "quick") {
            fireAndForget(async () => {
                const created = await createRun(active.oid, cmd.body, { mode: "quick" });
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

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (no new errors).

- [ ] **Step 3: CDP visual verification**

Ensure the dev app is running (`task dev`). In the Channels surface, select/create a channel, type `@quick add a spinner`, press Enter. Verify:
- a new run-strip tab appears with a `Q` badge (`channelssurface.tsx:941`),
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
- Modify: `pkg/jarvis/resolve.go` (add `MetaKey_ChannelNotes` near the other channel-meta consts ~line 16)
- Modify: `pkg/wshrpc/wshrpctypes.go` (add `CommandSetChannelNotesData` type near `CommandSetChannelTierData` ~line 708; add interface method near line 116)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (add `SetChannelNotesCommand` after `SetChannelTierCommand` ~line 1648)
- Generated (do not hand-edit; produced by `task generate`): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`

**Interfaces:**
- Produces:
  - `const MetaKey_ChannelNotes = "channel:notes"` (package `jarvis`)
  - `type CommandSetChannelNotesData struct { ChannelId string; Notes string }`
  - `SetChannelNotesCommand(ctx, CommandSetChannelNotesData) error` (RPC; TS client `RpcApi.SetChannelNotesCommand` after generate)
- Consumes: `wstore.DBUpdateFn`, `wcore.SendWaveObjUpdate`, `waveobj.MetaMapType` (existing).

- [ ] **Step 1: Add the meta-key constant**

In `pkg/jarvis/resolve.go`, near the other channel-meta keys:

```go
// MetaKey_ChannelNotes holds a channel's free-text notes (plain text; single-writer field).
const MetaKey_ChannelNotes = "channel:notes"
```

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

In `pkg/wshrpc/wshserver/wshserver.go`, after `SetChannelTierCommand`:

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

### Task 4: Channel notes frontend (store action + textarea)

**Files:**
- Modify: `frontend/app/view/agents/channelsstore.ts` (add `setChannelNotes` after `archiveChannel` ~line 104)
- Modify: `frontend/app/view/agents/channelssurface.tsx` (import `setChannelNotes`; replace notes placeholder at lines ~878-892; local notes state)

**Interfaces:**
- Consumes: `RpcApi.SetChannelNotesCommand` (generated in Task 3), `TabRpcClient`, `loadChannels` (existing in `channelsstore.ts`); `active.oid`, `active.meta` (existing channel VM).
- Produces: `export async function setChannelNotes(channelId: string, notes: string): Promise<void>`.

- [ ] **Step 1: Add the store action**

In `frontend/app/view/agents/channelsstore.ts`, after `archiveChannel`:

```ts
// Persist a channel's notes (a Channel.Meta field), then refresh the snapshot-fed rail. Mirrors
// setChannelTier — the surface reads active.meta from the channelsAtom snapshot, so it needs a re-fetch.
export async function setChannelNotes(channelId: string, notes: string): Promise<void> {
    await RpcApi.SetChannelNotesCommand(TabRpcClient, { channelid: channelId, notes });
    await loadChannels();
}
```

- [ ] **Step 2: Import it and add local notes state in the surface**

In `channelssurface.tsx`, add `setChannelNotes` to the existing `channelsstore` import (alongside `setChannelTier`). Near the other component state (top of the component body), add local state seeded per-channel so a re-fetch of the same channel never clobbers in-progress typing:

```tsx
    const [notesDraft, setNotesDraft] = React.useState("");
    React.useEffect(() => {
        const stored = (active?.meta as Record<string, unknown> | undefined)?.["channel:notes"];
        setNotesDraft(typeof stored === "string" ? stored : "");
        // re-seed only when the active channel changes, not on every meta update
    }, [active?.oid]);

    const notesTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
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

(If `React` is not already imported as a namespace, use the file's existing hook import style — e.g. `useState`/`useEffect`/`useRef` named imports — to match.)

- [ ] **Step 3: Replace the collapsed hint**

In `channelssurface.tsx`, the collapsed-strip hint (lines ~878-882) — show a real hint instead of "coming soon":

```tsx
                                        {!overviewOpen ? (
                                            <span className="truncate text-[11px] text-muted" style={{ maxWidth: 420 }}>
                                                {notesDraft.trim() ? notesDraft.trim() : "No notes yet"}
                                            </span>
                                        ) : null}
```

- [ ] **Step 4: Replace the notes placeholder with a textarea**

In `channelssurface.tsx`, the expanded notes block (lines ~886-893) — swap the disabled div for a controlled textarea:

```tsx
                                            <div className="min-w-0 flex-1">
                                                <div className="mb-1.5 font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-muted">
                                                    Channel notes
                                                </div>
                                                <textarea
                                                    value={notesDraft}
                                                    onChange={(e) => onNotesChange(e.target.value)}
                                                    placeholder="Notes for this channel…"
                                                    rows={4}
                                                    className="w-full resize-y rounded-[10px] border border-border bg-background px-3 py-2.5 text-[12.5px] leading-[1.6] text-secondary outline-none focus:border-accent/40"
                                                />
                                            </div>
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: CDP visual verification**

Dev app running. In Channels: expand "Overview & notes", type into the notes textarea, wait ~1s, collapse the strip → the collapsed hint shows the typed text. Switch to another channel and back → notes persist and the correct per-channel text shows. Reload the app → notes still present (confirms backend persistence).

Capture: `node scripts/cdp-shot.mjs channel-notes.png`.
Expected: screenshot shows the editable notes with typed content.

- [ ] **Step 7: Commit** (hold for user approval)

```bash
git add frontend/app/view/agents/channelsstore.ts frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(agents): editable channel notes in the overview strip"
```

---

### Task 5: Update deferred log + final verification

**Files:**
- Modify: `docs/deferred.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Mark both items resolved in `docs/deferred.md`**

Edit the "Channel notes (merged surface)" entry (top of file): add a `> **Resolved 2026-07-14:**` blockquote noting the `SetChannelNotesCommand` + `Channel.Meta["channel:notes"]` + textarea landed, and the Quick Run follow-up shipped as `RunMode_Quick` (bare single-phase run). Keep the original text below for history (match the file's existing resolved-entry style, e.g. the "Usage-bar token counts" entry).

- [ ] **Step 2: Correct the 4 stale entries found in the 2026-07-14 scan**

Add short `> **Resolved / stale (verified 2026-07-14):**` notes to these entries, which the scan confirmed already shipped:
- Jump-to-bottom pill (in the "Feature-triage residue" cheap-polish bundle) — shipped: `sticktobottom.tsx` (`JumpToLatestPill`/`useStickToBottom`) wired at `agentrow.tsx:560`.
- Multi-answer free-text delivery ("Remaining gap" line in the 2026-07-03 entry) — shipped: `answerbar.tsx` input → `buildAskAnswers` → `encode.go` free-text keys, TDD'd.
- Repo Radar "Start investigation" handoff composer — shipped: `radarfindingdetail.tsx` → `pendingRunDraftAtom` → review composer in `channelssurface.tsx`.
- Open in External Editor (cheap-polish bundle) — done via `openExternal` (OS default handler) at `filessurface.tsx:238,444`.

- [ ] **Step 3: Full verification sweep**

Run each and confirm:
- `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/jarvis/... -v` → PASS
- `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go build ./pkg/...` → exit 0
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0
- `git status` shows no unintended edits to generated files beyond Task 3's regeneration.

- [ ] **Step 4: Commit** (hold for user approval)

```bash
git add docs/deferred.md
git commit -m "docs(deferred): resolve channel-notes + quick-run; correct stale entries"
```

---

## Self-Review

- **Spec coverage:** Feature A backend → Task 3; Feature A FE → Task 4; Feature B backend → Task 1; Feature B FE → Task 2; testing (Go unit + CDP) → Tasks 1/2/4; rollout checklist incl. `task generate`, tsc, CDP, deferred.md → Tasks 3/5. All spec sections mapped.
- **Placeholder scan:** every code step shows complete code; no TBD/TODO. CDP steps describe exact actions + expected result (no jsdom harness exists — this is the repo's real verification method).
- **Type consistency:** `RunMode_Quick`, `QuickPlaybook`, `BuildQuickPrompt`, `MetaKey_ChannelNotes`, `CommandSetChannelNotesData{ChannelId,Notes}`, `setChannelNotes(channelId, notes)`, `RpcApi.SetChannelNotesCommand({channelid, notes})`, `notesDraft`/`onNotesChange` — names used identically across producing and consuming tasks.
