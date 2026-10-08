# Arc's desktop popup for a waiting item

**Verify:** `node scripts/verify.mjs ./pkg/jarvis`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs attention-popup attention-cross-channel surface-smoke`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/attention-notification/project/Main.dc.html

## Goal

When a new "needs you" item arrives while Arc is not focused, the avatar's bubble appears in a small window of
its own at the bottom right of the desktop, above the taskbar. It takes no focus. One click on it brings Arc's
main window forward and opens that item. It leaves by itself.

The canvas on the Prototype line is the visual and wording spec. It is gitignored scaffolding outside the
checkout: read it at that absolute path, never copy or commit it. Its agent names, run names and question are
sample data; the Windows taskbar and the other app's window in it are context, not something to build.

## Decisions (approved by the user; every task is bound by them)

- **Arc's own window, no new dependency.** No Windows toast, no `tauri-plugin-notification`, no new npm or cargo
  package.
- **One window, created once.** A second Tauri window labelled `attention-popup`, declared in
  `src-tauri/tauri.conf.json`, hidden at start, shown and hidden for each popup, never rebuilt. It loads its own
  page, `frontend/tauri/popup.html`. That page opens no wavesrv connection: it draws what the main window sends.
- **One decision, two effects.** The taskbar flash (commit 37cef7ab) and the popup fire on the same condition:
  an item that was not in the previous list, while the main window is unfocused. Both read one predicate in
  `frontend/app/view/agents/attentionstore.ts`, and `AttentionPoller` (always mounted) acts on both. The flash
  must keep working exactly as it does.
- **The bubble's look has one source.** The card markup is extracted from
  `frontend/app/view/jarvis/petbubble.tsx` and drawn by both the in-app bubble and the popup page. 268px wide,
  label line, name line, text clamped to three lines, Arc's `@theme` tokens only (no raw hex). `BUBBLE_MS` is
  defined once, beside the card, and is the popup's lifetime too.
- **Three lines.** Label: `Asking you` for an item of kind `ask`, else the item's `action` word (Review, Decide,
  Acknowledge, Triage) as the server sent it. Every kind gets the accent dot, as the canvas draws. Name: the
  item's `source`, alone (the canvas's `waveterm` project suffix is not drawn: an attention item carries no
  project). Text: the item's `text`.
- **Several new items in one poll:** one bubble, for the new item the server ranks first (the list is already
  in rank order), with `+N more waiting` under the text, where N is the number of the *other items new in that
  same poll*, not everything already waiting. N = 0 draws no such line.
- **No reply input, no buttons, no close button.** The whole bubble is one click target.
- **It leaves** after `BUBBLE_MS`, and earlier when the main window gains focus (which a click also causes). A
  newer popup replaces the one showing and restarts the timer.
- **Placement:** the primary screen only, 16px in from the right edge of its work area and 16px above the
  work area's bottom (the work area already excludes the taskbar). The window is sized to the bubble, so no
  invisible area blocks clicks on the desktop.
- **It never takes focus** from the app the user is in.
- **Where a click lands,** in this order, always through the one router (`frontend/app/view/jarvis/openref.ts`):
  1. an `ask` whose agent is on the roster: that agent (`{ kind: "agent" }`), as the palette's needs list does;
  2. an item with an `oref` (radar triage): `parseAddress(item.oref)`, which is the Radar report;
  3. an item with a `runid`: `{ kind: "run", runId }`, the avatar's Open;
  4. an item with only a `channelid`: `{ kind: "channel", channelId }`;
  5. otherwise nothing to open: the click brings Arc forward and nothing more. In practice this is only an ask
     with no channel whose agent has left the roster.
- **Personal-use app:** no settings toggle, no off switch, no multi-monitor rules, no empty or error states
  beyond what is written here.

## The cross-window contract (owned by Task 1, used by Tasks 3, 4 and 5)

In `frontend/app/view/agents/attentionpopup.ts`, a pure module (types and functions only; no jotai, no Tauri
import, no rpc, and no runtime import of a module that has them), so the popup page can import it without
pulling in the cockpit:

- `POPUP_WINDOW_LABEL = "attention-popup"` (the Tauri window label; `tauri.conf.json` uses the same string)
- `POPUP_PAGE = "popup.html"`
- `POPUP_SHOW_EVENT = "attention-popup:show"`: main to popup, payload `PopupBubble`
- `POPUP_HIDE_EVENT = "attention-popup:hide"`: main to popup, no payload
- `POPUP_OPEN_EVENT = "attention-popup:open"`: popup to main, payload `{ key: string }`
- `type PopupBubble = { key: string; label: string; name: string; text: string; more: number }`
- `popupBubble(prev: AttentionItem[], next: AttentionItem[], focused: boolean): PopupBubble | null`
- `popupPlacement(workArea: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }): { x: number; y: number }`
  (all in one unit; the caller converts)

In `frontend/app/view/agents/attentionpopuptarget.ts`, used by the main window only (it may import cockpit
modules; the popup page never imports it):

- `popupTarget(item: AttentionItem, agents: AgentVM[]): OpenTarget | null`

Events travel with `@tauri-apps/api/event` (`emitTo` / `listen`), already a dependency.

## Repo rules every worker needs

- The worktree's `node_modules`, `src-tauri/target` and `dist/bin` are junctions into the main checkout
  (`.arc/setup`). Never run `task dev`, `task check:ts` or `npm install` in the worktree: they replace the
  junction with a real install. Typecheck with the Check line; run one test file with
  `node node_modules/vitest/vitest.mjs run <path>`.
- Never start, stop or kill a dev app: Final starts its own. Never kill `wave-tauri.exe` or `wavesrv.x64.exe`
  by image name.
- Colours come from `@theme` tokens in `frontend/tailwindsetup.css`; no new tokens, no raw hex or rgba.
- Testable logic lives in a pure `.ts` with a `.test.ts` beside it; the `.tsx` stays thin. There are no jsdom
  render tests.
- Comments say why, never what; lower case; only when needed. Prettier only on files you touched, never on
  `scripts/*.mjs`.
- The tsconfig is not strict: narrow a union with `"reason" in result`, not on an `ok` literal.

### Task 1: The shared decision, the bubble's content and the landing rule
**Depends on:** none
**Files:** `frontend/app/view/agents/attentionstore.ts`, `frontend/app/view/agents/attentionstore.test.ts`, `frontend/app/view/agents/attentionpopup.ts`, `frontend/app/view/agents/attentionpopup.test.ts`, `frontend/app/view/agents/attentionpopuptarget.ts`, `frontend/app/view/agents/attentionpopuptarget.test.ts`

Read `attentionstore.ts` (`taskbarSignal`), `frontend/app/cockpit/palette-needs.ts` (`askAgent`, `needsTarget`),
`frontend/app/view/jarvis/address.ts` (`OpenTarget`, `parseAddress`), `frontend/app/view/jarvis/petacts.ts`
(`actsForAttention`) and `pkg/jarvis/attention.go` (the kinds, keys and `Action` words) first.

Build:

- In `attentionstore.ts`, export `newAttention(prev, next): AttentionItem[]`: the items of `next` whose `key` is
  not in `prev`, in `next`'s order. `taskbarSignal` is rewritten to use it and keeps its exact behaviour; its
  existing tests stay green unchanged.
- `attentionpopup.ts` with everything listed under "The cross-window contract" for that file. It imports
  nothing but types: `newAttention` is defined here if importing it from `attentionstore.ts` would pull that
  file's rpc imports into the popup bundle, and `attentionstore.ts` then imports it from here. One definition
  either way.
- `popupBubble` returns null when `focused` is true or nothing is new; otherwise the bubble for the first new
  item: `label` is `Asking you` for kind `ask`, else `item.action`; `name` is `item.source`; `text` is
  `item.text`; `more` is the count of the other new items. It must agree with `taskbarSignal`: for any inputs,
  `popupBubble(...) != null` exactly when `taskbarSignal(...) === "flash"`.
- `popupTarget`, in `attentionpopuptarget.ts`, implements the five-step landing order in Decisions. Reuse
  `askAgent` from `palette-needs.ts` and `parseAddress` from `address.ts`; an `oref` that `parseAddress` calls
  unsupported falls through to the next step. This module is the main window's only: it may import what
  `palette-needs.ts` imports (jotai through `docreview.ts`), and `attentionpopup.ts` must not import it.
- `popupPlacement` returns the top-left that puts a window of `size` 16px in from the work area's right edge and
  16px above its bottom. The 16 is a named constant.

Acceptance, proven by `node node_modules/vitest/vitest.mjs run frontend/app/view/agents/attentionpopup.test.ts frontend/app/view/agents/attentionpopuptarget.test.ts frontend/app/view/agents/attentionstore.test.ts`:

- `newAttention`: keeps `next`'s order; empty when every key was already there; everything when `prev` is empty.
- `popupBubble`: null when focused; null when no item is new (the same unanswered ask on the next poll); an ask
  reads `Asking you`; a `dag-gate` reads `Review`, an `escalation` `Decide`, a `run-unverified` `Acknowledge`, a
  `radar-triage` `Triage` (the label is whatever `action` holds); three new items give the first one with
  `more: 2`; one new item beside two old ones gives that item with `more: 0`; the new item named is the first
  *new* one even when an older item ranks above it.
- A table test over focused/unfocused and old/new lists asserts `popupBubble != null` exactly when
  `taskbarSignal === "flash"`.
- `popupTarget` (in `attentionpopuptarget.test.ts`): an ask keyed `ask:block:<id>` whose block is on the roster
  gives that agent; a radar item with `oref: "radarreport:<id>"` gives `{ kind: "radar", reportId }`; a gate
  with a run id gives the run; an escalation with a channel and no run gives the channel; an ask with no
  channel whose agent is not on the roster gives null; an ask with a run id whose agent is gone gives the run.
- `popupPlacement`: a 1920x1040 work area at (0,0) and a 268x96 window give (1636, 928); a work area with a
  non-zero origin (taskbar on the left or top) is offset by that origin.

### Task 2: The popup window in the Tauri shell
**Depends on:** none
**Files:** `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/capabilities/attention-popup.json`, `src-tauri/src/main.rs`

Read `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json` and `src-tauri/src/main.rs` first.

Build:

- A second entry in `app.windows`: label `attention-popup`, url `popup.html` (Task 3 creates the page; in dev it
  resolves against `devUrl`), `visible: false`, `decorations: false`, `transparent: true`, `alwaysOnTop: true`,
  `skipTaskbar: true`, `focus: false`, `focusable: false`, `resizable: false`, `shadow: false` (the bubble draws
  its own shadow), no maximize or minimize buttons, and a small initial size (300x140; the page resizes it).
  `scripts/sync-tauri-version.mjs` rewrites this file with a text replace, so keep its hand formatting and
  change nothing else in it.
- `src-tauri/capabilities/attention-popup.json`: a capability for the window `attention-popup` only, with the
  narrowest permissions the popup page needs: events (`core:event:default`), and on its own window show, hide,
  set-size, set-position, and the reads is-visible, outer-position, outer-size, primary-monitor and
  scale-factor (Task 5's scenario reads visibility and position through them). No http, no dialog, no menu.
- `default.json` (the main window) gains `core:window:allow-set-focus`, `core:window:allow-unminimize`,
  `core:window:allow-show` and `core:window:allow-is-focused`. Its description line is updated to say what it
  now covers.
- `main.rs`: a hidden second window would keep the process, and wavesrv with it, alive after the main window
  closes. When the window labelled `main` is destroyed, exit the app (`AppHandle::exit(0)`), which still reaches
  the existing `RunEvent::Exit` branch that kills wavesrv. The label test is a small named function so it can
  be unit-tested; the comment on the handler says why it exists.

Tao 0.35.3 gives a non-focusable window `WS_EX_NOACTIVATE`, and Task 3 shows the window from the page with the
window API. If Task 5's "did not take focus" step later fails, the fix belongs here: a Tauri command that shows
the window with `SW_SHOWNOACTIVATE` (`windows-sys` is already a dependency). Do not build that command now.

Acceptance:

- `cargo test --manifest-path src-tauri/Cargo.toml` passes, including a new test that the exit predicate is true
  for `main` and false for `attention-popup`.
- `cargo check --manifest-path src-tauri/Cargo.toml` accepts the config and both capability files (Tauri's build
  script rejects an unknown window key or permission identifier). If the build rewrites a tracked file, say so
  in your report; `src-tauri/gen` is not tracked.
- The rendered result is shown by Task 5's scenario `attention-popup`: steps 2 and 3 (the popup window is
  shown and placed), step 4 (it did not take focus) and step 5 (the main window is focused after the click).
- Exit on the main window's destruction is checked in this run by the predicate's unit test only. Closing the
  running app is out of this run's scope: Final's harness stops its dev app by PID, and a scenario that closed
  the app would end the harness.

### Task 3: The bubble card and the popup page
**Depends on:** Task 1
**Files:** `frontend/app/view/jarvis/petbubble.tsx`, `frontend/app/view/jarvis/bubblecard.tsx`, `frontend/tauri/popup.html`, `frontend/tauri/popup.tsx`, `frontend/tauri/vite.config.ts`

Read `petbubble.tsx`, `frontend/tauri/index.html`, `frontend/tauri/main.tsx`, `frontend/tauri/vite.config.ts`,
`frontend/tauri/tailwind.css`, `frontend/app/view/agents/themestore.ts` and the canvas first.

Build:

- `bubblecard.tsx`: the card extracted from `PetBubble`: the 268px rounded bordered raised surface and, inside
  it, the one button holding the label line (dot plus uppercase mono words), the name line, the three-line
  clamped text through `InlineMarkdown` with `plainLinks`, and an optional last line `+N more waiting` in the
  canvas's style (mono, 10px, muted). It takes plain props (label, dot class or null, label tone class, name,
  optional project, text, optional more, onClick) and knows nothing of `PetEvent` or attention items.
  `PetBubble` renders it inside its `PopoverReveal` and looks and behaves exactly as before, including its
  `data-pet-bubble*` attributes, which existing CDP scenarios query. `BUBBLE_MS` is defined and exported in
  `bubblecard.tsx`; `petbubble.tsx` imports it from there and re-exports it, so there is one definition.
  `bubblecard.tsx` must import nothing that connects to wavesrv at module load; if `InlineMarkdown`'s import of
  `@/app/store/global` does, give the card a plain-text path for the popup instead and say so in your report.
- `popup.html`: a page like `index.html` but with a transparent `html` and `body` (no `#1a1a1a` background), no
  Font Awesome links, and `popup.tsx` as its module.
- `popup.tsx`: the page. It imports `./tailwind.css`, loads the fonts as `main.tsx` does, applies the theme
  with `useApplyCockpitTheme` (the two windows share localStorage, and jotai's storage atom follows a change
  made in the other window, so a theme switch reaches the popup without a reload), and holds one piece of
  state: the `PopupBubble` showing, or none. On `POPUP_SHOW_EVENT` it draws the bubble, measures it, sizes the
  window to it plus room for the shadow, places it with `popupPlacement` on the primary monitor's work area
  (converting between physical and logical pixels with the monitor's scale factor), shows the window, and
  starts a `BUBBLE_MS` timer that hides it; a second show while one is up replaces it and restarts the timer.
  On `POPUP_HIDE_EVENT`, on click, and when the timer fires, it hides the window and clears the bubble state,
  so a hidden popup holds no card (Task 5 asserts both the window's visibility and the missing card); the click
  first emits `POPUP_OPEN_EVENT` with the bubble's `key` to the main window. It never calls `setFocus` and never
  calls `get_init` or any rpc. A failed window call is logged with `console.error` and context, never
  swallowed. The card carries `data-attention-popup` and the more line `data-attention-popup-more`, for Task 5.
  `popup.tsx` imports `BUBBLE_MS` and the card from `bubblecard.tsx`, never from `petbubble.tsx`, which would
  pull floating-ui, the pet's models and the cockpit store into the popup page.
- `vite.config.ts`: the build takes both pages as inputs (`index.html` and `popup.html`), so the packaged app
  ships the popup page. The dev server already serves `/popup.html` from the same root.

Keep `popup.tsx` thin: placement is `popupPlacement`, content is the payload. Nothing else needs a model.

Acceptance:

- The Check line passes, and `node node_modules/vite/bin/vite.js build --config frontend/tauri/vite.config.ts --outDir <a temp dir outside the repo>`
  emits both `index.html` and `popup.html` (do not build into `frontend/tauri/dist`).
- In that build, the chunks `popup.html` loads do not include `petbubble.tsx`'s imports: no `@floating-ui`, no
  `wshclientapi`. Check it by reading the build's output for the popup entry's imports and say what you found.
- `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis` still passes (the in-app bubble's models).
- The in-app bubble is unchanged: Task 5 runs the existing scenario `surface-smoke` in Final, and the scenarios
  that query `[data-pet-bubble]` keep their selectors.
- The popup's states are shown by Task 5's scenario `attention-popup`: step 3 (one gate: `Review`, the source,
  the text, and the window's place on the screen), step 7 (`+N more waiting`), step 9 (an ask: `Asking you`),
  step 6 (gone after a click) and step 8 (gone by itself after `BUBBLE_MS`).

### Task 4: The main window drives the popup and answers its click
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/attentionpoller.tsx`, `frontend/app/cockpit/cockpit-root.tsx`

Read `attentionpoller.tsx`, `frontend/app/cockpit/cockpit-root.tsx`, `frontend/app/view/jarvis/openref.ts`
(`openTarget`) and the contract above first.

Build, all in `AttentionPoller`, which now takes the cockpit's `model` (`cockpit-root.tsx` passes it):

- The effect that already computes `taskbarSignal(seen.current, attention, document.hasFocus())` reads focus
  once and also computes `popupBubble` from the same three values, before `seen.current` is replaced. A non-null
  bubble is sent to the popup window with `emitTo(POPUP_WINDOW_LABEL, POPUP_SHOW_EVENT, bubble)`. The flash call
  is untouched. Keep calling `document.hasFocus()` on the document at the moment of the effect: Task 5's
  scenario overrides that method to stand in for an unfocused window.
- When the main window gains focus it sends `POPUP_HIDE_EVENT`. Listen for the DOM `focus` event on `window`
  (as `cockpit-root.tsx` listens for `blur`), not Tauri's `onFocusChanged`: Task 5's scenario dispatches that
  DOM event to stand in for the window gaining focus.
- It listens for `POPUP_OPEN_EVENT`. On one: unminimize, show and focus the main window, then find the item
  with that key in the current `attentionAtom`, resolve it with `popupTarget(item, agents)` from
  `attentionpopuptarget.ts` (the roster is `model.agentsAtom`) and, when there is a target, open it with
  `openTarget(model, target)`. An item no longer in the list, or one with no target, only brings Arc forward.
  The router reports its own failures as a toast; do not add a second report.
- Tauri calls go through `fireAndForget`, as the flash does, so a rejection is logged and not swallowed.
  Listeners are removed on unmount.

No new pure logic belongs here: the decision and the landing rule are Task 1's. If you find yourself writing a
branch worth a test, say so in your report instead of editing Task 1's files.

Acceptance:

- The Check line passes.
- `node node_modules/vitest/vitest.mjs run frontend/app/view/agents/attentionstore.test.ts frontend/app/cockpit`
  still passes.
- The interaction is shown by Task 5's scenario `attention-popup`: step 2 (an item arriving while unfocused
  raises the popup), step 5 (the click opens the item's run on the main window and focuses it), step 6 (the
  popup is hidden after the click), step 10 (the popup is hidden when the main window gains focus) and step 11
  (no popup while the main window reports focus).

### Task 5: The CDP scenario, the harness's target picker and the docs
**Depends on:** Task 2, Task 3, Task 4
**Files:** `scripts/cdp/attach.mjs`, `scripts/cdp/scenarios.mjs`, `scripts/cdp-shot.mjs`, `AGENTS.md`, `docs/reference/architecture.md`

`cdp-shot.mjs` picks its target through `attach.mjs`; edit it only if the new picker needs it.

Read `scripts/cdp/attach.mjs`, `scripts/cdp/verify.mjs`, `scripts/cdp-shot.mjs`, `docs/reference/cdp-run-fixtures.md`
and, in `scripts/cdp/scenarios.mjs`, the scenario `attention-cross-channel` with its helpers
(`arrangeSheetDagRun`, `waitForDispatch`, `seedDag`, `teardownFixtureRun`) first. That scenario already parks a
run's DAG at a gate and waits for the 10s attention poll; this one reuses the same helpers.

Build:

- **Target picker.** The app now has two CDP page targets on the same origin. `pickTarget` in `attach.mjs` must
  never return the popup page as the main page: exclude a url ending in `popup.html` (and make `cdp-shot.mjs` do
  the same if it picks its own target). `attach` gains a way to reach a second page by url, and the harness
  object `h` gains `h.page(urlPart)`, returning a handle with `ev`, `cdp`, `shot` and `close` for that target,
  whose shots are recorded in `h.shots` so they reach the contact sheet and `shots.json`. It throws a clear
  error when no such target exists.
- **Scenario `attention-popup`** (surface `usage`, registered in `SCENARIOS`), with these numbered steps. Step
  names are what Final reports, so keep the numbers. "The popup window is visible" always means
  `window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "attention-popup" })` evaluated on the
  popup's own target, never the card's presence in the DOM: the card can exist in a hidden webview.
  1. A run holds a DAG whose first gated task is parked done and unreleased, and `getattention` reports it. Use
     four gated tasks with no dependencies between them; park only the first now.
  2. With the main page's `document.hasFocus` overridden to return false before the seed, a poll raises the
     popup: within 15s the popup page shows `[data-attention-popup]` and the popup window is visible. Reload the
     main page first so the poller starts from an empty list, then set the override, then seed.
  3. The popup's own target is screenshotted (`cdp-shots/attention-popup-gate.png`) and its card reads `Review`,
     the run's source line and the gate's text, with no more line; its computed background and text colours are
     not the page defaults (the theme reached it). The window is placed by the 16px rule: read
     `plugin:window|outer_position`, `plugin:window|outer_size` and `plugin:window|primary_monitor` on the popup's
     target and assert the window's right edge is 16 logical px inside the work area's right edge and its bottom
     edge 16 logical px above the work area's bottom (within 2 physical px, for rounding at the scale factor).
  4. The popup did not take focus: the popup page's `document.hasFocus()` is false while it is showing.
  5. A click on the card (through the popup's target) opens the item on the main window: the Jarvis surface is
     active with the run's sheet open on that run (assert it the way `attention-cross-channel` and the run-sheet
     scenarios read the open sheet), and the main window is focused:
     `plugin:window|is_focused` with `{ label: "main" }`, evaluated on the main page, resolves true.
  6. After the click the popup page shows no card and the popup window is not visible.
  7. With the override set again, the second and third gated tasks are parked done in one seed; the next poll
     raises one popup naming the first of them with `+1 more waiting` (`cdp-shots/attention-popup-more.png`), and
     the popup window is visible.
  8. It leaves by itself: nothing is clicked, and within `BUBBLE_MS` plus 3s of step 7's popup appearing the popup
     page shows no card and the popup window is not visible. The 6000 is restated in the scenario as a named
     constant with a comment naming `bubblecard.tsx` as its source.
  9. An ask raises `Asking you`: with the override set, raise an ask on a block that exists (the `ask` rpc, data
     `{ oref: "block:<id>", questions: [...] }`; the fixture run's worker block is one) and the next poll's popup
     reads `Asking you`, the asking worker's name and the question (`cdp-shots/attention-popup-ask.png`). Clear
     the ask in teardown (`agentaskclear`).
  10. It leaves when Arc gains focus: at once after step 9's shot, dispatch `window.dispatchEvent(new Event("focus"))`
      on the main page; within 2s (well inside `BUBBLE_MS`, so the timer cannot be what hid it) the popup page
      shows no card and the popup window is not visible. Record the elapsed time since the popup appeared in the
      step's detail.
  11. With the override removed and the main page reporting focus, parking the fourth gated task raises no popup
      within one poll (wait until `getattention` reports the fourth gate, then 12s more: no card, window not
      visible). If the dev app's window cannot be made to report focus under the harness, enable
      `Emulation.setFocusEmulationEnabled` for this step and turn it off after.
  12. The taskbar flash request is accepted in the dev app: collect console errors on the main page across
      steps 2 to 9 and assert none mentions `request_user_attention` or a permission rejection, and assert a
      direct `window.__TAURI_INTERNALS__.invoke("plugin:window|request_user_attention", ...)` from the main page
      resolves. The step's detail says plainly that CDP cannot see the taskbar button itself.
  Teardown restores `document.hasFocus`, clears the ask, hides any popup still showing, closes the popup handle
  and runs `teardownFixtureRun`. A failed arrange is recorded as step 1 failing, as `attention-cross-channel` does.
  Scope every DOM query to a `data-*` container; a document-wide button query hits the app bar. If the popup's
  target cannot be reached over CDP at all, the scenario fails step 2 with that as its detail: do not skip it.
- **Docs.** `AGENTS.md`: in the Architecture section's Tauri shell bullet and the Visual verification section,
  say that there is a second window (`attention-popup`, page `popup.html`, its own capability), that the app
  exits when the main window is destroyed, that the CDP port serves two page targets, and that `h.page("popup.html")`
  reaches the popup. `docs/reference/architecture.md`: the same facts where it describes the shell and the
  frontend entry (`main.tsx` is no longer the sole entry).

Acceptance:

- `node --check scripts/cdp/attach.mjs && node --check scripts/cdp/scenarios.mjs` pass, and
  `node node_modules/vitest/vitest.mjs run scripts/cdp-shot.test.mjs scripts/cdp/report.test.mjs` still passes.
- `node scripts/cdp/verify.mjs no-such-scenario` lists `attention-popup` among the available scenarios (it exits
  2 without needing a dev app).
- Final runs `attention-popup`, `attention-cross-channel` and `surface-smoke` against the merged app. Do not
  start a dev app yourself to run them.
