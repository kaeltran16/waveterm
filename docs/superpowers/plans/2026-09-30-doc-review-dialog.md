# Spec and plan review dialog Implementation Plan

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/jarvis/... ./pkg/orchestrate/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/jarvis/... ./pkg/orchestrate/...`
**Final:** `node scripts/cdp/final-verify.mjs doc-review surface-smoke`
**Prototype:** .superpowers/design/doc-review-panel/project/Main.dc.html

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A lead's `Spec review` ask, and its round-2 `Plan review` ask, open as one review dialog: the document rendered on the left, what the lead asks you to accept on the right, Approve / Request changes at the bottom. Today both render as flat text everywhere except the Cockpit lead card, and not at all on the Agent surface, where only Claude Code's own picker shows.

**Architecture:** A pure parser (`docreview.ts`, replacing `specreview.ts`) recognizes the two asks. A `DocReviewDialog` on `ModalShell` is mounted once in `CockpitShell`, so it opens over any surface and any focused agent; which agent's ask it shows is one jotai atom. Entry points: the lead's row in the Agent tree (a `review` tag), the Agent header (a chip), `r` on the Agent surface, auto-open once on the lead itself, and a Review button in the shared answer card (Cockpit, Brief, run sheet). Answering goes through the existing `model.toggleAnswer` / `setAnswerText` / `submitAnswer`. The Go side only pins the header and layout of the round-2 ask in the lead's instructions.

**Tech Stack:** React 19 + jotai + Tailwind 4, vitest, Go (`pkg/jarvis`, `pkg/orchestrate`), CDP scenario harness.

**The mockup is the visual spec** (gitignored, so read it by absolute path):
`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\doc-review-panel\project\Main.dc.html`. Its `kind` tweak switches spec/plan, its `where` tweak switches "on another agent" / "on the lead". Where this plan and the mockup disagree on a look, the mockup wins.

## Behaviour

- **Recognized asks.** A doc review is an ask with exactly one question whose header is `Spec review` or `Plan review` (case-insensitive, trimmed), and whose question's first non-empty line is a `.md` path (backticks stripped). The other lines split into `intro` (lines before the first `- ` line) and `items` (each `- ` line, prefix dropped). Anything else is an ordinary ask and renders as today.
- **Options.** `requestIndex` is the option whose cleaned label starts with `Request changes` (-1 if none); `approveIndex` is the first other option. Approve sends that option. Request changes needs a non-empty note and sends it as the question's free text (`setAnswerText`), which is how a typed answer already reaches the harness.
- **Opening.** `docReviewAtom: string | null` holds the asking agent's id. The dialog renders only while that agent's current ask parses as a doc review; otherwise it renders nothing and clears the atom (the ask was answered or cleared).
- **Auto-open.** On the Agent surface only, when the focused agent's ask is a doc review, its `askId` has not auto-opened before (session-only set), and focus is not in an editable target (`isEditableTarget(document.activeElement)`, which covers the xterm textarea): open once. Never from another agent, another surface, or while typing.
- **Esc / close** hides the dialog; the ask stays open and the tag, chip and `r` reopen it. `Ctrl Enter` is Approve (ModalShell's `onSubmit`). The dialog counts as a modal in `deriveKeyContext`, so no binding underneath fires and nothing reaches the terminal.
- **After sending**, the footer shows `Sent: <choice>` (AnswerBar's sent state, keyed by `askSentKey`) until the ask clears, then the dialog closes by the rule above.
- **Unreadable document:** the left pane says `Couldn't read <file>` with the path; the right pane and the answer controls still work.

## Global Constraints

- Colours are `@theme` tokens only (`frontend/tailwindsetup.css`); follow `DESIGN.md`. No new tokens.
- Reuse: `frontend/app/modals/modalshell.tsx` (variant `dialog`, `align="center"`), `MarkdownMessage`, `openFileInCode` (`frontend/app/cockpit/openfilestore.ts`), the app bar's button classes, AgentHeader's `ICON_BTN`.
- Locate code by symbol, not line number.
- Never hand-edit generated files. This plan changes no wshrpc/waveobj type, so `task generate` is not needed.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes). tsconfig is not strict: an `{ok:true}|{ok:false;reason}` union does not narrow on `.ok`.
- Prettier/eslint only on files you touched; never `--write` the tree, never prettier `scripts/*.mjs`.

### Task 1: Lead instructions pin the Plan review ask
**Depends on:** none

Files: `pkg/jarvis/leadprompt.go`, `pkg/jarvis/leadprompt_test.go`, `pkg/orchestrate/planreview.go`, `pkg/orchestrate/queue.go`, `pkg/orchestrate/planreview_test.go`.

- [ ] In `proceedPastPlanReview` (planreview.go) and the `- plan review failed:` line of `OrchestrationRules` (leadprompt.go), say how to put it to the human: an ask with the header `Plan review`, the plan's absolute path as the question's first line, one line saying what the lead proposes, then one `- ` line per finding it would accept; options `Accept all and proceed` and `Request changes`. Keep the existing amend-then-accept instruction.
- [ ] `planReviewFailedWake` and `planReviewLostWake` (queue.go) embed `proceedPastPlanReview` on the last round already; check they still read as one line.
- [ ] Tests: extend `TestOrchestrationRulesNameRunSpecPlanAndCommands` (leadprompt_test.go) to require "header `Plan review`" in `OrchestrationRules(...)`; `planreview_test.go`'s "Put it to the human; " + `proceedPastPlanReview` assertion must still pass.
- [ ] `go test ./pkg/jarvis/... ./pkg/orchestrate/...`.

### Task 2: The doc-review model
**Depends on:** none

Files: `frontend/app/view/agents/docreview.ts` (new, from `specreview.ts` via `git mv`), `docreview.test.ts` (from `specreview.test.ts`), `frontend/app/view/agents/leadcard.tsx` (import only).

- [ ] `parseDocReview(ask: AgentAsk | undefined): DocReview | null`, with `DocReview = { kind: "spec" | "plan"; path: string; intro: string[]; items: string[]; approveIndex: number; requestIndex: number }`, following the Behaviour rules. Export `DOC_REVIEW_HEADERS`. Delete `parseSpecReview` and `SPEC_REVIEW_HEADER`; point `leadcard.tsx` at the new names (Task 4 replaces its block).
- [ ] `docReviewAtom` (`atom<string | null>(null)`) and `autoOpenedAskIdsAtom` (`atom<Set<string>>(new Set())`) in the same file or a `docreviewstore.ts` beside it.
- [ ] Pure `shouldAutoOpen(input: { surface: string; focusedId: string | undefined; agent: AgentVM | undefined; opened: Set<string>; editable: boolean }): boolean`.
- [ ] Tests: both headers; case/space-insensitive header; backticked path; a non-`.md` first line → null; a second question → null; intro vs items split (fixture: a round-2 ask shaped like run 07c2ce92's, a plan path, one intro line, four `- ` findings); `approveIndex`/`requestIndex` with and without a `Request changes` option and with a `(Recommended)` marker; `shouldAutoOpen` for each gate (other surface, other agent, already opened, editable, no ask).
- [ ] `npx vitest run frontend/app/view/agents/docreview.test.ts`.

### Task 3: The dialog
**Depends on:** Task 2

Files: `frontend/app/view/agents/docreviewdialog.tsx` (new), `frontend/app/view/agents/cockpitshell.tsx`, `frontend/app/store/keybindings/dispatcher.ts`, `frontend/app/view/agents/planpreview.tsx`, `frontend/app/view/agents/usefiletext.ts` (new).

- [ ] Extract `PlanPreview`'s read effect into `useFileText(path): { status: "loading" | "error" | "ok"; text: string; lines: number }` and use it from both.
- [ ] `DocReviewDialog({ model })`: reads `docReviewAtom`, finds the agent in `model.agentsAtom`, parses its ask; renders `ModalShell` (`variant="dialog"`, `align="center"`, `onClose` clears the atom, `onSubmit` approves). Layout per the mockup: header (amber dot, `SPEC REVIEW` / `PLAN REVIEW · ROUND 2 FAILED` eyebrow, "· waiting on you · <agent name>", close button, the title "Review the spec before I write the plan" / "The plan review failed twice. Proceed with these fixes?"); left pane (file row with Open in Code, the document through `useFileText` + `MarkdownMessage`, loading skeleton, `Couldn't read <file>`); right pane (`Decisions in it · N` / `Findings · N`, the intro lines, the items; inline code in items renders as code); footer (Approve with `Ctrl Enter` keycap, Request changes → labelled textarea + Send to the lead + Cancel, "Esc hides this; the question stays open"; sent state).
- [ ] Answers: Approve = `model.toggleAnswer(id, 0, approveIndex)` then `model.submitAnswer(id)`; Send = `model.setAnswerText(id, 0, note)` then `submitAnswer`. Read the sent state from `model.sentIdsAtom` + `askSentKey`.
- [ ] Mount `<DocReviewDialog model={model} />` once in `CockpitShell`, outside the surface switch.
- [ ] `deriveKeyContext`: `modalOpen` also true while `docReviewAtom` is non-null.
- [ ] Check (tsc) passes.

### Task 4: Entry points
**Depends on:** Task 3

Files: `frontend/app/view/agents/agenttree.tsx`, `agentheader.tsx`, `agentsurface.tsx`, `leadcard.tsx`, `answerbar.tsx`, `agentrow.tsx`, `frontend/app/store/keybindings/bindings.ts` (+ `bindings.test.ts`), `docs/keyboard-shortcuts.md`, `docs/orchestrator-guide.md`.

- [ ] Agent tree: where a row renders `asking`, a doc-review ask renders a `review ↗` tag button instead (mockup), `onClick` sets `docReviewAtom` to that agent's id and stops propagation, so the focused agent does not change.
- [ ] Agent header: the amber `Spec review` / `Plan review` chip, shown when the header's agent has a doc-review ask and the dialog is closed; click opens it.
- [ ] `agent:review` binding on `r` in `buildAgentBindings`, `when: agentNav` and the focused agent has a doc-review ask; label "Review". Add it to `docs/keyboard-shortcuts.md`. Confirm `assertNoConflicts` in `bindings.test.ts` still passes (`r` is free on the Agent surface; Jarvis, Diff and Code use it on their own surfaces).
- [ ] Auto-open: an effect in `AgentSurface` on `[surface, focused agent id, its askId]` that calls `shouldAutoOpen` with `isEditableTarget(document.activeElement)`, and on true sets `docReviewAtom` and adds the askId to `autoOpenedAskIdsAtom`.
- [ ] Shared card: `AnswerBar`, when the ask parses and `!hideQuestion`, renders a compact summary (kind label, file name, item count, a `Review` button opening the dialog) in place of the question text; the option buttons stay. `leadcard.tsx` replaces `SpecReviewBlock` with the same summary (delete `SpecReviewBlock`). `agentrow.tsx`'s asking banner shows the summary instead of the raw question text for a doc review.
- [ ] Plain questions keep their line breaks: `whitespace-pre-line` on the question text in `AnswerBar`, `leadcard.tsx` and the `agentrow.tsx` banner.
- [ ] `docs/orchestrator-guide.md` ("Answering the lead", "The plan review"): the review dialog, where it opens, and that it never opens by itself from another agent.
- [ ] Check (tsc) and `npx vitest run frontend/app/view/agents frontend/app/store/keybindings`.

### Task 5: CDP scenario `doc-review`
**Depends on:** Task 4

Files: `scripts/cdp/scenarios.mjs`.

- [ ] Follow `agent-tree-rail`: `arrangeFixtureRun`, then write a fixture roster to `public/cockpit-fixtures/active.json` with a lead (state `asking`, an `ask` whose single question has header `Spec review`, a first line pointing at a small spec `.md` the scenario writes into `ctx.cwd`, three `- ` decision lines, options `Approve` / `Request changes`) and a second, working agent. Reload, then:
  1. Focus the working agent on the Agent surface: no `[role=dialog]`; the lead's tree row has the `review` tag.
  2. Click the tag: the dialog is open over the working agent, the left pane shows the spec's first heading, the right pane lists 3 decisions, and the Agent header still names the working agent.
  3. Escape: the dialog is gone and the focused agent is unchanged.
  4. Focus the lead with no editable focus: the dialog opens by itself; Escape; refocus the lead: it does not reopen; the header chip is present and reopens it.
  Scope every query to a `data-*` container (`data-doc-review` on the dialog panel), never document-wide button text. Do not submit an answer (the fixture ask has no live block).
- [ ] Teardown removes the fixture roster, as `agent-tree-rail` does.
- [ ] Run it against the dev app: `task verify:ui -- doc-review`.
