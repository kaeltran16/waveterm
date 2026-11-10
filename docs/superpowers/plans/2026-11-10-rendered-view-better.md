# Rendered view: know what it is doing now Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-11-10-rendered-view-better-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentask`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs agent-rendered`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\rendered-view-better\project\NowLine.dc.html

**Goal:** Rendered mode answers "what is it doing now, and what has this turn done" with a now line above the
composer, fills the center with only prose at a reading measure, leaves a band above the composer, and gives
Rendered a writing-card composer with attach, Steer and Interrupt.

**Architecture:** Two pure modules (`spinnerrow.ts` parses Claude Code's spinner row off the screen,
`nowline.ts` derives the line from the transcript, the agent's state, the last hook and that parse) feed a thin
`nowline.tsx`. The screen comes from a tiny block-keyed registry of live xterm terminals (`termscreen.ts`) that
`TermWrap` fills. The composer's text/send logic moves into a hook shared by today's `AgentComposer` and a new
`RenderedComposer` card. Width and the band are class changes in `renderedview.tsx`.

**Tech Stack:** React 19, jotai, Tailwind 4, xterm 6, vitest, the CDP scenario harness (`scripts/cdp/`).

## Decisions beyond the spec, and why

1. **Turn time comes from the transcript.** `projectTranscript` adds `ts?: number` (the record's `timestamp`,
   parsed; omitted when absent or invalid) to `user`, `command` and `message` entries. The turn starts at the last
   `user`/`command` entry; a finished turn's length is its last `message` ts minus that start. No time is shown
   when either is missing, so the line never invents one. Why: entries carried no time, and the last hook alone
   loses the turn start after the first tool hook.
2. **Submit-to-transcript gap:** when the block's last hook is `UserPromptSubmit` and its ts is more than
   `TURN_SKEW_MS = 2000` after the transcript's latest turn start, the line treats it as a new turn not yet in the
   transcript (start = that hook ts, 0 tools). Why: between Send and Claude writing the user line, the previous
   turn's elapsed and tool count would otherwise read as this turn's (the anti-goal).
3. **No now-line atom.** Everything derives on each 1s tick of the existing `model.nowAtom` from entries, agent
   state, last hook and a fresh screen read, so nothing must survive an unmount. Why: KISS; the spec's per-agent
   atom is only needed for state that cannot be re-derived.
4. **Screen access:** a module-level `Map<blockId, Terminal>` in a new `frontend/app/view/term/termscreen.ts`,
   registered by the `TermWrap` constructor and removed by `dispose()` (only if the map still holds that same
   terminal). The read is the live screen (`buffer.active`, rows `baseY .. baseY + rows - 1`), not the viewport,
   so a hidden terminal scrolled up still reads current. Read once per tick only while the agent is `working`.
   Why: the term view model is created inside `CockpitFocusPane` and reachable from nowhere else.
5. **Spinner parse rule:** scan the screen rows bottom-up; the first row matching
   glyph (`·✢✳✶✻✽*`), whitespace, one capitalised word ending in `…` (U+2026), then optionally ` (…)` to the end
   of the row wins. The parenthesised part is split on ` · ` and key-hint segments (starting `esc `, `ctrl+`,
   `shift+`, case-insensitive) are dropped; the rest is shown verbatim. Why: Esc now lives on the Interrupt
   button; the single-word-plus-ellipsis rule rejects bullets like `* Reading the file…` in agent output.
6. **One "working" shape.** With no spinner parsed the left side reads `working · <elapsed>` (or `working` with
   no known start), and a running call still shows on the right. The tool count shows only when it is 1 or more
   (`1 tool`, `3 tools`). `asking` hides the line (the turn has not ended, and it is waiting on you).
7. **Running call** = the latest `action` entry in the turn with `pending: true`; its elapsed is
   `now - startedTs` (omitted without `startedTs`). Durations use the existing `fmtDuration`
   (`runcompletion.ts`: `42s`, `3m 10s`).
8. **Prose cap without touching `markdownmessage.tsx`:** the Rendered timeline column carries the Tailwind
   arbitrary variant `[&_.agent-md>:is(p,ul,ol,h1,h2,h3,h4,h5,h6,blockquote)]:max-w-[75ch]`. Only top-level text
   blocks of a markdown message are capped; code blocks, tables, chart and tool cards, insight callouts and diffs
   stay full width. `EndedTranscript` and Sessions are unchanged. `permissionband.tsx`'s own `max-w-[920px]` goes
   too, since it is a Rendered-only dock (its only importer is `renderedview.tsx`).
9. **Composer:** a hook `useAgentComposer` in `agentcomposer.tsx` owns text, autosize (per-use min/max), the
   double-send guard and Enter/Escape; `AgentComposer` keeps its exact look and props on it, and a new
   `RenderedComposer` (`renderedcomposer.tsx`) is the card. Card max height is `Math.round(window.innerHeight *
   0.4)` (window, not view: the view is nearly the window and this needs no observer). Min textarea height 42px.
10. **Attachments reach the agent as paths in the prompt text** through the existing `appendAttachments`, as the
    New run goal does: `CommandAgentPromptData` has only `blockid` and `text`, and `sendAgentText` already pastes
    multi-line text whole. Send waits on `attachmentBlocker` (uploading/failed). The native file dialog moves into
    a shared `pickFilePaths()` in `composerattachments.ts`, used by both the New run goal and the card. The card
    reuses `AttachButton` as it is (24px, bordered) rather than the prototype's borderless 28px icon: one attach
    control across the app.
11. **Scenario fixtures:** the now-line steps append a new turn to agent A's transcript (with chosen `ts`
    values), set A `working` through the fixture roster, and write a spinner row straight into A's hidden xterm
    via `termForBlock` (A has no controller, so nothing else writes there). The attachment is a synthetic paste of
    a PNG `File` (as `scenarios-palette.mjs` does), so it goes through the real `WriteTempFileCommand`; no DEV seam.

12. **Verify names `./pkg/agentask`** only because `scripts/verify.mjs` requires a Go pattern; this plan changes
    no Go, so at each merge it runs the vitest files the changed paths reach, and the final stage runs all vitest.

## Prototype boards → scenario steps (all in `agent-rendered`)

The canvas folder holds only the five chosen boards; the rejected options were moved to
`.superpowers/design/rendered-view-better/rejected/`.

| Board | Step |
|---|---|
| `NowLine.dc.html` | `rendered: now line call` |
| `NowLineStates.dc.html` | `rendered: now line starting`, `rendered: now line call`, `rendered: now line between`, `rendered: now line done`, and the hidden checks in `rendered: ask dock` / `rendered: permission band` |
| `WidthFill.dc.html` | `rendered: timeline fills` (narrow and wide) |
| `GapRoomy.dc.html` | `rendered: band above composer` |
| `ComposerWriting.dc.html` | `rendered: composer idle`, `rendered: composer attach`, `rendered: composer working`, `rendered: composer steer` |

## Global Constraints

- Colors only from the `@theme` tokens in `frontend/tailwindsetup.css`; no new tokens; Tailwind, no new SCSS.
  Spinner glyph+verb `text-provider-claude`; its detail and the tool count `text-muted`; the done line
  `text-ink-faint`; card `rounded-lg bg-surface-raised border-edge-strong`, `border-accent/60` while focused or
  non-empty.
- `tsconfig.json` is `strict: false`: narrow ok-unions with `"reason" in result`.
- `[data-rendered-composer] textarea` must keep matching the composer's textarea (`agentsurface.tsx` focuses it;
  existing scenario steps type into it). `[data-rendered-ask]`, `[data-permission-band]` keep their names.
- Composer copy, verbatim: placeholder idle `Message the agent`; working
  `Steer the agent; it reads this before its next step`; buttons `Send`, `Steer`, `Interrupt` with an `Esc` key
  chip; footer hints `/` commands, `⇧ ↵` new line, `pickers open the terminal`.
- Now line copy, verbatim shapes: `done · 3m 10s · 12 tools`, `working · 2s`, `42s · 3 tools`.
- `AgentComposer` in `agentrow.tsx`, `leadcard.tsx`, `idlesection.tsx` looks and behaves exactly as today.

## Review Focus

- Send pressed, state flips to `working`, transcript has not yet written the new user line: the line must read
  a fresh turn (`working · 0s`, no tools), not the previous turn's time and count. Test in Task 3.
- The agent's own output on screen contains a spinner-like line (`* Reading the file…`, `· done`): no false
  spinner. Test in Task 3.
- The turn ends but the spinner row is still on screen for a moment: state `idle` wins, the line reads done.
  Test in Task 3.
- Two calls pending at once, or a call pending because it waits on a permission prompt: the latest pending
  shows; with the permission band docked the line hides. Test in Task 3 (latest) and Task 5 (hidden).
- Send pressed while a pasted file is still uploading or failed: Send/Steer stays disabled. Test in Task 4.

---

### Task 1: Transcript entries carry their time
**Depends on:** none
**Files:** `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/agentsviewmodel.ts`

Decision 1. In `AgentEntry` (`agentsviewmodel.ts`) the `user`, `command` and `message` members gain
`ts?: number` (UnixMilli). `projectTranscript` sets it from the record's `timestamp` when `Date.parse` gives a
finite number and leaves the key off otherwise (so existing `toEqual` assertions on timestamp-less fixtures stay
valid). Other projectors (codex, pi, opencode) are not changed.

- [ ] Write failing tests in `transcriptprojection.test.ts`:
  `it("stamps user, command and message entries with the record time")` — a user text record, a slash-command
  record and an assistant text record with `timestamp: "2026-07-08T00:00:00.000Z"` (and `:05`, `:09`) project to
  entries whose `ts` equal `Date.parse` of each;
  `it("leaves ts off when the record has no valid timestamp")` — no `timestamp`, and `timestamp: "nope"`:
  `"ts" in entry` is false.
- [ ] Run `npx vitest run frontend/app/view/agents/transcriptprojection.test.ts` — the two new tests fail.
- [ ] Implement; rerun — the whole file passes.

### Task 2: Read a block's terminal screen
**Depends on:** none
**Files:** `frontend/app/view/term/termscreen.ts`, `frontend/app/view/term/termscreen.test.ts`, `frontend/app/view/term/termwrap.ts`

Decision 4. `termscreen.ts` imports nothing from `view/agents` and types the terminal structurally (only what it
reads), so the agents surface can import it without pulling in `termwrap.ts`.

Produces:
- `registerTermScreen(blockId: string, term: Terminal): () => void` — returns the unregister, which deletes the
  entry only while it still holds `term`.
- `termForBlock(blockId: string): Terminal | undefined` — the scenario writes a spinner row through it.
- `screenRows(blockId: string): string[] | null` — the live screen's rows, `translateToString(true)` each; `null`
  when no terminal is registered for the block.

`TermWrap`'s constructor registers `this.terminal` under `this.blockId`; `dispose()` calls the unregister before
`terminal.dispose()`.

- [ ] Failing tests in `termscreen.test.ts` with a fake terminal (`rows`, `buffer.active.{baseY, getLine}`):
  `it("returns the live screen rows, not scrollback")` — 3 rows, `baseY` 5: returns lines 5..7 trimmed;
  `it("returns null for a block with no terminal")`;
  `it("a stale unregister leaves a newer terminal in place")` — register A then B for one block, call A's
  unregister: `termForBlock` is still B.
- [ ] Run `npx vitest run frontend/app/view/term/termscreen.test.ts` — fails; implement; passes.

### Task 3: Now line model
**Depends on:** Task 1 (reads the `ts` it adds to user, command and message entries)
**Files:** `frontend/app/view/agents/spinnerrow.ts`, `frontend/app/view/agents/spinnerrow.test.ts`, `frontend/app/view/agents/nowline.ts`, `frontend/app/view/agents/nowline.test.ts`

Decisions 2, 5, 6, 7. Pure, no React or jotai.

Produces (`spinnerrow.ts`):
```ts
export interface SpinnerRead { glyph: string; verb: string; detail?: string } // detail without the parens
export function parseSpinner(rows: string[]): SpinnerRead | null
```
Produces (`nowline.ts`):
```ts
export const TURN_SKEW_MS = 2000;
export interface TurnSummary { startTs?: number; endTs?: number; tools: number;
    running?: { verb: string; target: string; startedTs?: number } }
export function summarizeTurn(entries: AgentEntry[]): TurnSummary | null // null: no user/command entry
export type NowLine =
    | { kind: "hidden" }
    | { kind: "working"; spinner: SpinnerRead | null; elapsedMs?: number; tools: number;
        call?: { verb: string; target: string; elapsedMs?: number } }
    | { kind: "done"; durationMs?: number; tools: number };
export function nowLineState(input: { state: AgentState; docked: boolean; entries: AgentEntry[];
    spinner: SpinnerRead | null; lastHook: { hook: string; ts: number } | null; now: number }): NowLine
export function nowLineText(line: NowLine): { left: string; right: string } // the copy, for tests and the view
```
`summarizeTurn` counts `action` entries after the last `user`/`command` entry; `endTs` is the last `message` ts
in the turn. `elapsedMs` is `now - startTs`. `nowLineText` formats with `fmtDuration` and the copy in Global
Constraints; for `working` with a spinner, `left` is `"<glyph> <verb> (<detail>)"`.

- [ ] Failing tests, `spinnerrow.test.ts`:
  `"✻ Undulating… (58s · ↓ 4.5k tokens · thinking with high effort)"` → `{glyph:"✻", verb:"Undulating…",
  detail:"58s · ↓ 4.5k tokens · thinking with high effort"}`;
  `"✶ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)"` → detail `"12s · ↑ 1.2k tokens"`;
  `"· Thinking…"` → no detail; the spinner row above an input box and status rows is found (bottom-up);
  rejects `"* Reading the file…"`, `"✻ Worked for 3m 10s"`, `"- Undulating…"`, an empty screen.
- [ ] Failing tests, `nowline.test.ts`:
  working with spinner and no pending call → `kind:"working"`, no `call`, `tools` counts only this turn;
  working with a pending call (`startedTs` = now − 42000) → `call.elapsedMs` 42000, `nowLineText(...).right`
  `"42s · 3 tools"`; two pending calls → the later one;
  working, spinner null, turn start 2s ago → left `"working · 2s"`, right `""` with 0 tools;
  idle after a turn from :00 to 3m10s with 12 actions → `"done · 3m 10s · 12 tools"`; idle with no message ts →
  `"done · 12 tools"`; idle with a spinner still parsed → `done` (Review Focus);
  last hook `UserPromptSubmit` 10s after the transcript's latest turn start, working → `working`, `tools` 0,
  `elapsedMs` from the hook ts (Review Focus); within `TURN_SKEW_MS` → the transcript's turn;
  `docked: true` → hidden; `state:"asking"` → hidden; idle with no user entry → hidden; `1 tool` singular.
- [ ] Run `npx vitest run frontend/app/view/agents/spinnerrow.test.ts frontend/app/view/agents/nowline.test.ts`
  — fail; implement; pass.

### Task 4: Writing-card composer in Rendered
**Depends on:** none
**Files:** `frontend/app/view/agents/agentcomposer.tsx`, `frontend/app/view/agents/agentcomposer.test.ts`, `frontend/app/view/agents/renderedcomposer.tsx`, `frontend/app/view/agents/composerattachments.ts`, `frontend/app/view/jarvis/newruncontrol.tsx`, `frontend/app/view/agents/renderedview.tsx`, `scripts/cdp/scenarios-agent-rendered.mjs`

Decisions 9, 10. Spec "The composer" and `ComposerWriting.dc.html`.

Interfaces:
- `agentcomposer.tsx`: `canSendComposer(text: string, blockId?: string, attachments?: Attachment[]): boolean` —
  true when a block is set, `attachmentBlocker(attachments)` is null, and the text is non-blank or a ready
  attachment exists. Existing two-argument calls keep today's result.
- `useAgentComposer({ blockId, minH, maxH, onEscape?, onSubmitText?, compose?: (text) => string, onSent?: () => void })`
  returning `{ text, setText, taRef, send, onKeyDown }`. After a send lands, the typed text clears only if it is
  unchanged since the send, and `onSent` runs; a failed send keeps both (today's `submitComposer` behavior).
  `AgentComposer` keeps `ComposerMinH` 32 / `ComposerMaxH` 160 and its props and handle unchanged.
- `RenderedComposer` (forwardRef `AgentComposerHandle`): props `{ blockId?: string; working: boolean;
  onInterrupt: () => void; onSubmitText?: (text: string) => void }`. Text 13.5px / leading 1.55; textarea min
  42px. Attachment tray 16px under the text, above the footer. Footer: `AttachButton`, hints, then
  working ? `[data-composer-interrupt]` Interrupt (+ `Esc` chip) and `[data-composer-send]` Steer : 
  `[data-composer-send]` Send (up arrow, disabled per `canSendComposer`). Paste of files goes to
  `useComposerAttachments().onPaste`. Escape in the textarea still interrupts.
- `composerattachments.ts`: `useComposerAttachments()` gains `clear(): void` (revokes previews);
  `pickFilePaths(): Promise<string[]>` wraps the Tauri dialog (`[]` on cancel, throws on failure) and
  `newruncontrol.tsx`'s `pickFiles` uses it. The card toasts a picker failure with `pushToast`.
- `renderedview.tsx`: mounts `RenderedComposer` (`working = agent.state === "working"`,
  `onInterrupt = () => interruptAgent(agent.blockId)`) inside `[data-rendered-composer]`, which drops its
  `border-t`, `max-w-[920px]` and the `HINT` line (`[data-rendered-hint]` is gone) and pads `px-[22px] pb-4`.

- [ ] Failing tests in `agentcomposer.test.ts` (`canSendComposer`): text + uploading attachment → false; text +
  errored attachment → false (Review Focus); blank text + ready attachment → true; blank text + no attachments →
  false; no block → false.
- [ ] Run `npx vitest run frontend/app/view/agents/agentcomposer.test.ts` — fail; implement; pass, and
  `frontend/app/view/agents/composerattachments.test.ts` still passes.
- [ ] Add scenario steps to `scripts/cdp/scenarios-agent-rendered.mjs`, each with a shot, after
  `rendered: esc interrupt` (update that step to send Escape through the new textarea if needed):
  `rendered: composer idle` — focus A first (the step before it leaves P focused) and ensure Rendered: the card has 12px radius, 13.5px textarea font, height 85–110px,
  placeholder `Message the agent`, Send disabled, the three footer hints, no `[data-rendered-hint]`;
  `rendered: composer attach` — type two lines and paste a PNG `File`: a chip with its name shows between text
  and footer, Send enabled, card border is the accent;
  `rendered: composer working` — P set `working` in the fixture roster: placeholder is the Steer copy, Interrupt
  with `Esc` and Steer show; clicking Interrupt makes the probe log `1b`;
  `rendered: composer steer` — on P, type text, paste a file, press Steer: the probe's decoded input contains the
  text and the attachment's temp path, and the textarea and tray empty afterwards.
- [ ] Run the scenario against the dev app (`docs/reference/cdp-verification.md`) at a narrow (~900px center)
  and a wide (1400px+) window; every step passes, including the existing ones.

### Task 5: Full-width timeline, band above the composer, and the now line
**Depends on:** Task 2 (reads the screen through `screenRows`), Task 3 (renders `nowLineState` / `nowLineText`), Task 4
**Files:** `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/nowline.tsx`, `frontend/app/view/agents/permissionband.tsx`, `scripts/cdp/scenarios-agent-rendered.mjs`

Decisions 3, 6, 8. Spec "The now line", "Width", "Space above the composer".

- `renderedview.tsx`: the timeline column and `AskDock` drop `max-w-[920px]` (the column keeps
  `mx-auto flex min-h-full w-full flex-col`) and the column gets the prose-cap variant from Decision 8.
  `permissionband.tsx` drops its `max-w-[920px]` wrapper.
- `NowLine` (`nowline.tsx`), props `{ model: AgentsViewModel; agent: AgentVM; entries: AgentEntry[] }`: reads
  `model.nowAtom`, `getLastHookAtom("block:"+blockId)`, `getAgentPermissionsAtom("block:"+blockId)` and
  `hasAnswerableAsk` for `docked`, and calls `screenRows(blockId)` → `parseSpinner` on each tick only while
  `working`. It renders, between the scroll area and `AskDock`, `[data-now-band]` (`h-10 shrink-0 px-[22px]`, flex
  centered) holding `[data-now-line][data-now-kind="working|done"]`; nothing at all when `hidden` (the dock takes
  the slot). Left: spinner (`shrink-0 whitespace-nowrap`, glyph+verb `text-provider-claude` 11.5px mono, detail
  `text-muted` 11px) or `working · …`; right, after a flex spacer: call verb (VERB style), target
  (`min-w-0 truncate`, so it truncates first), then the elapsed/tool text. Done: one `text-ink-faint` 11px mono
  span. Stick-to-bottom needs no change: the band is outside the scroll area.
- Scenario (`scripts/cdp/scenarios-agent-rendered.mjs`), each with a shot:
  - Replace the `timeline — … no wider than 920px` step with `rendered: timeline fills` — at wide and narrow
    widths: the column spans the scroll area minus its 44px padding (±2px); the prose paragraph's width is at most
    its computed `max-width` and that is not `none`; the diff card is as wide as the column (±2px) and, at wide,
    wider than the paragraph.
  - `rendered: ask dock` and `rendered: permission band`: also assert `[data-now-band]` is absent while docked.
  - `rendered: band above composer` — A idle after its turn: `[data-now-band]` is 36–44px tall, its top is at or
    below the scroll area's bottom, its bottom at or above the composer's top, and the last timeline item's
    bottom is above the band.
  - Now-line steps, appended after `rendered: v key`, on A in Rendered: take one `t0 = Date.now()` and stamp
    every appended record from it. Append a turn to A's transcript (`userText` at t0−3m, a Read with result, a
    Bash `toolUse` with no result at t0−42s), set A `working`, then `publishStatus` A with
    `{ state: "working", hook: "PreToolUse" }`: the earlier `rendered: picker flip` step left A's last hook a
    `UserPromptSubmit` only seconds old, which Decision 2 would read as a fresh, untranscribed turn (0 tools, no
    call) and fail every step below:
    `rendered: now line starting` — no spinner on screen → left reads `working · ` + a duration;
    `rendered: now line call` — write `✻ Undulating… (3m 10s · ↓ 4.5k tokens · thinking with high effort)` into
    A's xterm via `termForBlock` → the spinner text, the Bash target and `· 2 tools` show (`NowLine.dc.html`);
    `rendered: now line between` — append the Bash result → no target, right reads `2 tools`;
    `rendered: now line done` — append an assistant message stamped t0+5s, set A idle → exactly
    `done · 3m 05s · 2 tools` in the faint color (start and end both come from t0, so the time does not depend
    on how long the steps took), and no spinner text although the row is still on the xterm.
- [ ] Implement, then run the full `agent-rendered` scenario against the dev app at a narrow (~900px center) and
  a wide (1400px+) window; every step passes. Then `npx vitest run frontend/app/view/agents/nowline.test.ts
  frontend/app/view/agents/spinnerrow.test.ts` still passes.
