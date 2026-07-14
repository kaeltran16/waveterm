# Channels / Runs UX batch — design

Four independent defects on the Channels (runs-native) surface, batched. Root causes
established by driving a code trace of the composer, scroll, run-phase, and
dispatched-agent subsystems (2026-07-14).

Surface entry: `frontend/app/view/agents/channelssurface.tsx`. Run body:
`runbody.tsx`. Composer: `channelcomposers.tsx` + `composer-shell.tsx`. Run engine:
`pkg/jarvis/run.go`.

---

## 1. Multiline composer does not grow

**Cause.** `LaunchComposer` / `TalkComposer` (`channelcomposers.tsx:134-150`, `:197-211`)
pass their own textarea to `ComposerShell` via the `inputRegion` prop. `ComposerShell`'s
auto-grow effect is gated to the built-in path only (`composer-shell.tsx:43-49`,
`if (ta && inputRegion == null)`), so an injected textarea never gets sized. Both channel
textareas are `rows={1} resize-none overflow-y-auto max-h-[160px]` with no JS auto-grow, so
extra lines scroll inside a one-row box. Enter / Shift+Enter logic is correct; only height
is broken.

**Fix.** Auto-grow the injected textareas the same way the built-in path grows (clamp to
`max-h-[160px]`, min one row). Prefer the smallest change that stays DRY:
- Add `field-sizing-content` to the shared textarea class. WebView2 is Chromium/Edge (the
  only runtime we ship), which supports CSS `field-sizing`. This is a one-token,
  JS-free grow that also covers any future `inputRegion` caller. If `field-sizing` proves
  unreliable in the shipped WebView2 build, fall back to a shared `scrollHeight` effect.

Single source of truth: whichever mechanism is chosen is applied once to the shared
textarea class / `ComposerShell`, not duplicated per composer.

## 2. Newest text sits under the composer (no auto-scroll)

**Cause.** The surface scroll region (`runbody.tsx:755`, the pipeline body
`sc min-h-0 flex-1 overflow-y-auto ... pb-3`) has **no** stick-to-bottom; the composer is an
in-flow `flex-none` sibling below it (`channelssurface.tsx:350`) — not an overlay. New run
content appended at the bottom is not auto-followed, so the last line sits flush at the 12px
bottom padding, directly against the composer — reading as "tucked under." (The per-worker
transcript inside `RunWorkerCard` already sticks; the surface itself does not.)

**Fix.** Reuse the existing `useStickToBottom(entries)` hook + `JumpToLatestPill`
(`sticktobottom.tsx`; already used by `runworkercard.tsx`, `agentrow.tsx`,
`subagentinterior.tsx`) on the surface scroll region. When at bottom, new content auto-scrolls
so the newest line clears the composer; when scrolled up, the "↓ Latest" pill returns the user.
Keep the composer as a sibling (no layout refactor) — sticking the scroll region to its own
bottom is sufficient because the composer does not overlap. No new primitive.

## 3. Pipeline runs never advance / no accept affordance

**Cause.** The phase state machine is fully built and unit-tested backend-side
(`pkg/jarvis/run.go`: `CompletePhase` auto-starts a non-gated successor and halts a gated one;
`recomputeStatus` yields `awaiting-review` when a `Done` gated phase has a `pending` successor;
the frontend renders that as `ReviewGateCard` via `reviewGate` → `phaseThread.showGate`). What is
missing is the **completion trigger**: `BuildPhasePrompt` (`run.go:274`) tells the pipeline worker
only to "stop when the phase's deliverable is written" — never to report completion. Only
`BuildOrchestratePrompt` emits `wsh jarvis complete` (`run.go:303`). So in the default playbook
(brainstorm → plan[gate] → execute), phase 0 never completes → nothing transitions → the plan gate
never fires → no `ReviewGateCard` ever appears. This is both reported symptoms at once.

**Decision (user-chosen): auto-advance via worker self-report.** Mirror orchestrator mode: the
pipeline worker runs `wsh jarvis complete <deliverable-path>` when its phase deliverable is written.
Downstream is already correct — non-gated phases auto-start the successor; the gated **plan** phase
halts structurally and surfaces the existing `ReviewGateCard` ("Approve & execute" / "Send back") as
the human checkpoint. No per-phase manual button is added (user chose auto over hybrid). Self-report
is safe from premature completion: it is an explicit CLI call the worker makes only when done, not a
stop-hook — a worker that pauses to `AskUserQuestion` has not called `complete`.

**Fix (backend-centric).**
- `BuildPhasePrompt` (`run.go`): add a self-report line — when the deliverable is written, run
  `wsh jarvis complete <path>` to record the artifact and hand off. Pipeline needs `complete` only,
  never `hold` (the gate is structural, not lead-driven).
- Verify `wsh jarvis complete` accepts a deliverable path and records it as the phase artifact
  (`cmd/wsh/cmd/wshcmd-jarvis.go` → `ReportRunPhaseCommand` → `CompletePhase`, `Artifacts`); the
  recorded artifact flows to the next phase's `priorArtifacts`.
- Update `TestPhasePrompt_ModeAware` (`runexec_test.go:20-23`), which currently asserts a pipeline
  prompt must **not** contain `wsh jarvis`; it should now assert it contains `wsh jarvis complete`
  (and still not `wsh jarvis hold`).
- No new frontend action/flag: the existing `PhaseRail` / `ReviewGateCard` / `phaseThread` render the
  transitions and gate once the backend drives the state.

**Caveat.** Auto-advance depends on the headless worker reliably issuing `wsh jarvis complete` — the
same model-behavior dependency orchestrator mode already relies on. Flagged, not mitigated (YAGNI); a
manual accept button remains a clean follow-up if reliability proves poor.

## 4. Dispatched-agent cards diverge; instruction shown raw

**Cause.** Three independent renderings exist: `AgentRow` (canonical full card,
`agentrow.tsx:159`), `RunWorkerCard` (compact, `rounded-lg`, `runworkercard.tsx:28`), and the bare
"Dispatched" subagent rows (`runbody.tsx:468-515`) — the last uses a plain `bg-current` dot (not the
shared `StatusDot`), no runtime glyph, and raw text. The run instruction `run.goal` is dumped as a raw
string in `RunHeader` (`runbody.tsx:409`).

**Decision (user-chosen): visual-consistency pass, not full parity.** Make `RunWorkerCard` and the
bare Dispatched rows speak the same visual language as `AgentRow` by reusing the shared leaf
primitives, while staying compact (no composer footer / resize grip — those remain AgentRow-only).

**Fix.**
- Dispatched rows (`runbody.tsx:494-515`): replace the bare dot with the shared `StatusDot`, add the
  `runtimeMeta` glyph, and align spacing/typography with the agent visual language.
- `RunWorkerCard`: align border radius and status treatment with `AgentRow` (shared `StatusDot`,
  matching radius token) — reuse `statusdot.tsx` / `runtimemeta.ts`, no re-implementation.
- Instruction: render `run.goal` (`runbody.tsx:409`) with `InlineMarkdown` condensed to one line
  (`inlinemarkdown.tsx` + `condenseToLine`) — bold/code/links styled, whitespace collapsed — clamped
  with a click to expand the full formatted text. Keeps the header clean for long/multi-line goals.

---

## Scope & boundaries

- Each fix is independent and touches a distinct unit; they share only the reuse of existing
  primitives (`useStickToBottom`, `StatusDot`, `runtimeMeta`, `InlineMarkdown`, `ComposerShell`).
- **No new abstractions.** Every fix reuses an existing primitive or a one-line CSS/prompt change.
- **Out of scope:** the in-flight `cancel-run-stops-workers` work already on this branch
  (`runmodel.ts` / `runbody.tsx` / `runactions.ts` uncommitted) — preserved, not touched except where
  #3/#4 edits are additive and non-conflicting.
- **Verification:** Go unit tests for the prompt change; frontend build + typecheck; and CDP visual
  verification in the live dev app (composer grows, newest text clears composer, dispatched cards match,
  instruction formatted). A full pipeline-run end-to-end (real worker self-reporting) is the one flow
  that needs the live app and a spawned worker — verified if feasible, else the state-transition path is
  covered by the existing backend unit tests plus a driven `AdvanceRunCommand`.
