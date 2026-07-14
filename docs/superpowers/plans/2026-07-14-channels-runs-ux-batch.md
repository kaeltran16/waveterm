# Channels / Runs UX batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four Channels/Runs surface defects: multiline composer doesn't grow, newest text sits under the composer, pipeline runs never advance (no accept affordance), and dispatched-agent cards/instruction render inconsistently.

**Architecture:** Reuse existing primitives everywhere — CSS `field-sizing` for composer growth, the existing `useStickToBottom` hook for auto-scroll, the existing phase state machine (driven by adding a worker self-report trigger), and `InlineMarkdown` for the instruction. No new abstractions.

**Tech Stack:** React 19 + jotai + Tailwind 4 (frontend), Go (run engine + `wsh` CLI), vitest + `go test`.

## Global Constraints

- No new SCSS; Tailwind `@theme` tokens only; never raw hex/rgba.
- Never hand-edit generated files (`gotypes.d.ts`, `wshclientapi.ts`); Go is the source of truth.
- tsc must be run as `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows); baseline is clean.
- Windows env: for multi-line git commits use multiple `-m` flags or `git commit -F`, never PowerShell here-strings in the Bash tool.
- Do NOT touch the in-flight `cancel-run-stops-workers` changes already uncommitted on this branch (`runmodel.ts`, `runactions.ts`, and existing hunks of `runbody.tsx`); edits here are additive and must not conflict.
- Do not commit or push without explicit approval; batch into one feature commit at the end (spec + plan docs fold into it).

---

## File map

- `frontend/app/view/agents/channelcomposers.tsx` — the two channel textareas (multiline fix, #1).
- `frontend/app/view/agents/runbody.tsx` — `RunBody` pipeline scroll region (#2), `RunHeader` goal (#4a), `DispatchedAgents` rows (#4c).
- `frontend/app/view/agents/runworkercard.tsx` — `RunWorkerCard` card radius (#4b).
- `frontend/app/view/agents/sticktobottom.tsx` — existing `useStickToBottom` / `JumpToLatestPill` (reused, not modified).
- `frontend/app/view/agents/inlinemarkdown.tsx` — existing `InlineMarkdown` (reused, not modified).
- `cmd/wsh/cmd/wshcmd-jarvis.go` — `jarvis complete` gains an optional deliverable-path arg (#3).
- `pkg/jarvis/run.go` — `BuildPhasePrompt` self-report line (#3).
- `pkg/jarvis/run_test.go`, `pkg/jarvis/runexec_test.go` — prompt assertions (#3).

---

### Task 1: Multiline composer grows (#1)

The channel composers pass their own textarea via `inputRegion`, which bypasses `ComposerShell`'s
`scrollHeight` auto-grow (gated to `inputRegion == null`, `composer-shell.tsx:45`). Both textareas are
`rows={1}` and never grow. Fix with CSS `field-sizing: content` (Tailwind `field-sizing-content`) — WebView2
is Chromium/Edge (Chromium ≥123 supports `field-sizing`), so the control grows from one row to `max-h-[160px]`
then scrolls, no JS. This is a runtime-visual change with no unit-test harness (no jsdom render tests here), so
it is verified by build + live CDP, not a vitest.

**Files:**
- Modify: `frontend/app/view/agents/channelcomposers.tsx:148` (LaunchComposer textarea class)
- Modify: `frontend/app/view/agents/channelcomposers.tsx:209` (TalkComposer textarea class)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add `field-sizing-content` to the LaunchComposer textarea class**

At `channelcomposers.tsx:148`, change:
```tsx
className="max-h-[160px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.5] text-primary placeholder:text-muted focus:outline-none"
```
to:
```tsx
className="field-sizing-content max-h-[160px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.5] text-primary placeholder:text-muted focus:outline-none"
```

- [ ] **Step 2: Add `field-sizing-content` to the TalkComposer textarea class**

At `channelcomposers.tsx:209`, apply the identical prefix change to the class string (the two class strings are currently identical).

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline; className strings are untyped so this only confirms nothing else broke).

- [ ] **Step 4: Commit (batched — see final commit step)**

Stage `channelcomposers.tsx`. Do not commit yet; see the Verification & Commit section.

**Fallback (only if CDP shows the box not growing):** revert the CSS and instead add a `useRef` +
`useLayoutEffect` scrollHeight resizer to each textarea, mirroring `composer-shell.tsx:43-49`
(`ta.style.height = "0px"; ta.style.height = ta.scrollHeight + "px"`), keyed on `value`. TalkComposer
would need a new `taRef`.

---

### Task 2: Channels auto-scroll to bottom (#2)

The pipeline `RunBody` scroll region (`runbody.tsx:755`) has no stick-to-bottom; new content is not
followed, so the newest line sits flush under the composer (an in-flow sibling below it). Reuse the
existing `useStickToBottom` hook + `JumpToLatestPill` (same pattern as `runworkercard.tsx:35,110-115`).
The orchestrator body (`runbody.tsx:559`) is untouched — it delegates scrolling to its fill transcript,
which already sticks. No unit test (layout/scroll behavior); verified by CDP.

**Files:**
- Modify: `frontend/app/view/agents/runbody.tsx` — import (line 21-region), `RunBody` return (`:754-783`)

**Interfaces:**
- Consumes: `useStickToBottom`, `JumpToLatestPill` from `./sticktobottom`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Import the stick-to-bottom primitives**

Add to the imports near the top of `runbody.tsx` (it does not yet import from `./sticktobottom`):
```tsx
import { JumpToLatestPill, useStickToBottom } from "./sticktobottom";
```

- [ ] **Step 2: Wire the hook into `RunBody`**

In `RunBody` (`runbody.tsx:686`), after the `railKey`/entrance block and before the `noop`/return
(around `:731`), add:
```tsx
// auto-follow the run as it grows so the newest phase/worker card clears the composer below.
// A fresh signature array each render re-pins while the user is at the bottom (releases on scroll-up).
const stick = useStickToBottom([run.status, railKey, now]);
```
`railKey` and `now` are already in scope (`:712`, `:695`).

- [ ] **Step 3: Attach the ref + pill to the pipeline scroll region**

Replace the pipeline return (`runbody.tsx:754-783`) so the scroll `<div>` gets the ref/onScroll and is
wrapped in a `relative` flex parent that anchors the pill:
```tsx
    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            <div ref={stick.scrollRef} onScroll={stick.onScroll} className="sc min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-5">
                <div>
                    <RunHeader
                        run={run}
                        agents={agents}
                        channel={channel}
                        steering={false}
                        steerDraft=""
                        setSteerDraft={noop}
                        onSteerToggle={noop}
                        onSteerClose={noop}
                        hideSteer
                    />
                    {run.status === "executing" && primaryWorker ? <RunRollup agent={primaryWorker} now={now} /> : null}
                    <CompactStepper run={run} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
                    {expanded ? (
                        <PhaseRail model={model} run={run} agents={agents} channelId={channel.oid} liveTabIds={liveTabIds} now={now} entranceIds={entranceIds} />
                    ) : null}
                    {!isTerminal(run.status) ? (
                        <CancelRunButton
                            channelId={channel.oid}
                            run={run}
                            agents={agents}
                            className="mt-4 rounded border border-edge-mid px-3 py-1.5 text-[11.5px] font-semibold text-muted hover:border-error hover:text-error"
                        />
                    ) : null}
                </div>
            </div>
            {!stick.atBottom ? <JumpToLatestPill onClick={stick.jumpToBottom} /> : null}
        </div>
    );
```
(Only the outer wrapper + `ref`/`onScroll` + trailing pill are new; the inner content is unchanged from
`:756-781`.)

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit (batched — see final commit step)**

Stage `runbody.tsx` (also modified by Tasks 4a/4c — one staged file, committed once at the end).

---

### Task 3: Pipeline phases auto-advance via worker self-report (#3)

The phase state machine already auto-starts a non-gated successor and halts a gated phase into
`awaiting-review` (surfaced as the existing `ReviewGateCard`). The only missing piece is the pipeline
worker never being told to report completion. Add a `wsh jarvis complete <deliverable-path>` instruction
to `BuildPhasePrompt` (pipeline), and extend the CLI to accept the path (mirroring `jarvis hold`). The
gated plan phase needs `complete` only — it halts structurally, no `hold`.

**Files:**
- Modify: `cmd/wsh/cmd/wshcmd-jarvis.go:34-39` (`jarvisCompleteCmd`)
- Modify: `pkg/jarvis/run.go:269-281` (`BuildPhasePrompt`)
- Test: `pkg/jarvis/runexec_test.go:14-24` (`TestPhasePrompt_ModeAware`)
- Test: `pkg/jarvis/run_test.go` (new `TestBuildPhasePromptTellsWorkerToSelfReportComplete`)

**Interfaces:**
- Consumes: `wshrpc.CommandReportRunPhaseData{Action, Artifacts}` (already carries `Artifacts`; `hold` uses it).
- Produces: pipeline `BuildPhasePrompt` output now contains the literal `wsh jarvis complete`.

- [ ] **Step 1: Update the failing prompt test first (TDD — ModeAware)**

In `pkg/jarvis/runexec_test.go`, replace the pipeline assertion (`:20-23`) so it now requires the
self-report verb and still forbids the hold verb:
```go
	pipe := NewRun("do X", "ws", "/p", "be clean", RunMode_Pipeline, DefaultPlaybook(), 1)
	pp := phasePrompt(&pipe, 0)
	if !strings.Contains(pp, "wsh jarvis complete") {
		t.Fatalf("pipeline prompt should tell the worker to self-report completion:\n%s", pp)
	}
	if strings.Contains(pp, "wsh jarvis hold") {
		t.Fatalf("pipeline prompt must not hold-gate (gate is structural):\n%s", pp)
	}
```

- [ ] **Step 2: Add a focused prompt test (TDD)**

Append to `pkg/jarvis/run_test.go`:
```go
func TestBuildPhasePromptTellsWorkerToSelfReportComplete(t *testing.T) {
	p := waveobj.RunPhase{Kind: PhaseKind_Brainstorm, Skill: "superpowers:brainstorming"}
	got := BuildPhasePrompt(p, "write a haiku", nil, "")
	if !strings.Contains(got, "wsh jarvis complete") {
		t.Errorf("prompt missing self-report instruction: %s", got)
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run 'TestPhasePrompt_ModeAware|TestBuildPhasePromptTellsWorkerToSelfReportComplete' -v`
Expected: FAIL — prompt does not yet contain `wsh jarvis complete`.

- [ ] **Step 4: Add the self-report line to `BuildPhasePrompt`**

In `pkg/jarvis/run.go`, change the skill line (`:274`) from "then stop when the phase's deliverable is
written" to end the sentence at the deliverable, and add a completion line after the artifacts block
(before the final `return`, `:279`):
```go
	fmt.Fprintf(&b, "Use the %s skill to work this goal until the phase's deliverable is written.\n", phase.Skill)
	b.WriteString("You are running headless with no human at your terminal. Make reasonable assumptions for low-stakes or easily-reversible choices and keep going — do not ask about them. Only when a decision is genuinely consequential and a wrong assumption would waste real work, pause and use the AskUserQuestion tool (it reaches the human in the cockpit); otherwise proceed to the deliverable.\n")
	fmt.Fprintf(&b, "Goal: %s\n", goal)
	if len(priorArtifacts) > 0 {
		fmt.Fprintf(&b, "Prior artifacts to build on: %s\n", strings.Join(priorArtifacts, ", "))
	}
	b.WriteString("When the deliverable is fully written, run `wsh jarvis complete <deliverable-path>` (pass the path to the file you produced) to record it and hand the run off to the next phase. Run it only once the deliverable actually exists.\n")
	return strings.TrimRight(b.String(), "\n")
```
(The `headless`/`AskUserQuestion` guidance is unchanged, so the existing self-serve/escalate test still passes.)

- [ ] **Step 5: Extend `jarvis complete` to accept the deliverable path**

In `cmd/wsh/cmd/wshcmd-jarvis.go`, replace `jarvisCompleteCmd` (`:34-39`) with (mirroring `jarvisHoldCmd`):
```go
var jarvisCompleteCmd = &cobra.Command{
	Use:   "complete [deliverable-path]",
	Short: "mark the current run's phase complete (optionally recording its deliverable)",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		var artifacts []string
		if len(args) > 0 && args[0] != "" {
			artifacts = []string{args[0]}
		}
		return reportRunPhase(wshrpc.CommandReportRunPhaseData{Action: "complete", Artifacts: artifacts})
	},
	PreRunE: preRunSetupRpcClient,
}
```

- [ ] **Step 6: Run the Go tests to verify they pass**

Run: `go test ./pkg/jarvis/ -run 'TestPhasePrompt_ModeAware|TestBuildPhasePrompt' -v`
Expected: PASS (ModeAware, SelfReportComplete, MentionsSkillGoalAndArtifacts, TellsWorkerToSelfServeAndEscalate, IncludesPrinciplesWhenPresent, OmitsPrinciplesWhenEmpty).

- [ ] **Step 7: Full package tests + build the CLI**

Run: `go test ./pkg/jarvis/ ./cmd/wsh/...`
Expected: PASS.
Then rebuild the backend binaries so the dev app picks up the new prompt + CLI: `task build:backend`
Expected: builds `wavesrv` + `wsh` into `dist/bin/` with no error.

- [ ] **Step 8: Commit (batched — see final commit step)**

Stage `wshcmd-jarvis.go`, `run.go`, `run_test.go`, `runexec_test.go`.

---

### Task 4a: Format the run instruction (#4)

`run.goal` is dumped as a raw string in `RunHeader` (`runbody.tsx:409`). Render it with `InlineMarkdown`
condensed to one line, clamped, with a click-to-expand toggle for the full formatted text. No unit test
(render/visual); verified by CDP.

**Files:**
- Modify: `frontend/app/view/agents/runbody.tsx` — import + `RunHeader` (`:380-453`)

**Interfaces:**
- Consumes: `InlineMarkdown` from `./inlinemarkdown`, `MarkdownMessage` (already imported, `:28`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Import InlineMarkdown**

Add to `runbody.tsx` imports:
```tsx
import { InlineMarkdown } from "./inlinemarkdown";
```

- [ ] **Step 2: Add expand state + render the goal formatted**

In `RunHeader` (`runbody.tsx:380`), add a local state at the top of the component body:
```tsx
    const [goalExpanded, setGoalExpanded] = useState(false);
```
(`useState` is already imported, `:21`.) Then replace the raw goal `<div>` (`:409`):
```tsx
                        <div className="text-[19px] font-bold leading-tight tracking-[-0.01em] text-primary">{run.goal}</div>
```
with a clickable, formatted goal that condenses to one line and expands to full markdown on click:
```tsx
                        <button
                            type="button"
                            onClick={() => setGoalExpanded((v) => !v)}
                            title={goalExpanded ? "Collapse" : "Expand"}
                            className="block w-full cursor-pointer text-left text-[19px] font-bold leading-tight tracking-[-0.01em] text-primary hover:opacity-90"
                        >
                            {goalExpanded ? (
                                <MarkdownMessage text={run.goal} className="text-[15px] font-semibold leading-snug text-primary" />
                            ) : (
                                <span className="line-clamp-2">
                                    <InlineMarkdown text={run.goal} />
                                </span>
                            )}
                        </button>
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit (batched — see final commit step).**

---

### Task 4b: Align RunWorkerCard corner radius with AgentRow (#4)

`RunWorkerCard` uses `rounded-lg` (`runworkercard.tsx:45`); the canonical agent card `AgentRow` uses
`rounded-[13px]` (`agentrow.tsx:335`). Match it so a dispatched worker reads as the same card family. No
unit test; verified by CDP.

**Files:**
- Modify: `frontend/app/view/agents/runworkercard.tsx:45`

**Interfaces:**
- Consumes: nothing new. Produces: nothing.

- [ ] **Step 1: Change the card radius**

At `runworkercard.tsx:45`, change:
```tsx
        <div className={cn("overflow-hidden rounded-lg border border-edge-mid bg-lane", fill && "flex min-h-0 flex-1 flex-col")}>
```
to:
```tsx
        <div className={cn("overflow-hidden rounded-[13px] border border-edge-mid bg-lane", fill && "flex min-h-0 flex-1 flex-col")}>
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit (batched — see final commit step).**

---

### Task 4c: Align the dispatched subagent row dot (#4)

The bare "Dispatched" subagent rows use a small `h-[6px] w-[6px]` plain `bg-current` dot with no motion
(`runbody.tsx:504`), unlike the `StatusDot` used on every worker/agent card (`h-2 w-2`, pulse while
working). Match the dot's *look* (size + pulse-on-working) while keeping the subagent tone colors
(`working`→accent, `success`→green, `failure`→red, `done`→muted) — those carry state `StatusDot`'s
3-state enum does not, so `StatusDot` is intentionally not reused here. No unit test; verified by CDP.

**Files:**
- Modify: `frontend/app/view/agents/runbody.tsx:504`

**Interfaces:**
- Consumes: existing `SUB_TONE_CLASS` (`runbody.tsx:456-461`), `s.state`. Produces: nothing.

- [ ] **Step 1: Upgrade the dot**

At `runbody.tsx:504`, change:
```tsx
                            <span className={"h-[6px] w-[6px] flex-none rounded-full bg-current " + tone} />
```
to (size matches `StatusDot`; pulse only while `working`):
```tsx
                            <span
                                className={
                                    "h-2 w-2 flex-none rounded-full bg-current " +
                                    tone +
                                    (s.state === "working" ? " animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none" : "")
                                }
                            />
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit (batched — see final commit step).**

---

## Verification & Commit

- [ ] **Frontend tests + typecheck**

Run: `npx vitest run frontend/app/view/agents/` and `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: existing suites pass (no new unit tests added — these are layout/visual/CSS changes); tsc exit 0.

- [ ] **Backend tests**

Run: `go test ./pkg/jarvis/ ./cmd/wsh/...`
Expected: PASS.

- [ ] **Live CDP verification (dev app)**

Start the dev app (stdin-EOF workaround): `tail -f /dev/null | task dev` (background), then use
`node scripts/cdp-shot.mjs` + `Input.dispatchKeyEvent` on `:9222`. Confirm:
  1. Typing multiple lines (Shift+Enter) in the channel composer grows the box up to ~160px, then scrolls (#1).
  2. As a run appends content, the surface auto-scrolls so the newest card clears the composer; scrolling up shows the "↓ Latest" pill; clicking it re-pins (#2).
  3. A pipeline run advances brainstorm→plan and surfaces the plan `ReviewGateCard` (the accept affordance). If a full worker run isn't feasible, drive `AdvanceRunCommand{action:"complete"}` and confirm the rail transitions + gate card renders (#3).
  4. The run header goal renders formatted (inline markdown), expands on click; `RunWorkerCard` matches the agent card radius; dispatched subagent dots match the StatusDot look (#4).

- [ ] **Self-review the diff**

`git diff` — confirm only the intended files/regions changed, no leftover debug, no touching of the
in-flight cancel-run hunks.

- [ ] **Single feature commit (after user approval)**

Stage the code files + the spec (`docs/superpowers/specs/2026-07-14-channels-runs-ux-batch-design.md`) +
this plan. One commit; spec/plan fold in per the git rule. Do NOT push without approval.
```bash
git add frontend/app/view/agents/channelcomposers.tsx frontend/app/view/agents/runbody.tsx \
  frontend/app/view/agents/runworkercard.tsx cmd/wsh/cmd/wshcmd-jarvis.go pkg/jarvis/run.go \
  pkg/jarvis/run_test.go pkg/jarvis/runexec_test.go \
  docs/superpowers/specs/2026-07-14-channels-runs-ux-batch-design.md \
  docs/superpowers/plans/2026-07-14-channels-runs-ux-batch.md
git commit -m "fix(channels): multiline composer, auto-scroll, pipeline self-report, dispatched-UI parity"
```
