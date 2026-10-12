# Record modal redesign (design A)

**Verify:** `node scripts/verify.mjs ./pkg/util/ds`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brief-peek brief-peeks-polish`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\record-modal\project\Main.dc.html

The canvas settles the design and there is no spec. Build board A (`Main.dc.html`) and its states (`States.dc.html`: loading, empty, the terminal-status confirm, archived). Ignore `Split.dc.html` and `RunsFirst.dc.html`, which were rejected.

This change is frontend only. `scripts/verify.mjs` requires a Go pattern, so `./pkg/util/ds` is a cheap placeholder. At each merge it scopes vitest to the changed files, and at the final stage it runs all of vitest.

Shared rules (every task):
- Colours come from `@theme` tokens in `frontend/tailwindsetup.css` only (DESIGN.md). Every canvas hex already maps onto a token: `#13171d` surface-raised / modalbg, `#0e1116` surface, `#0c0e11` background, `#171c22` surface-hover, `#1a222c` surface-selected, `#1c2128` border, `#161a20` edge-faint, `#20262e` edge-mid, `#2a313a` edge-strong, `#e6e9ed` primary, `#dfe4ea` ink-hi, `#cfd5db` secondary, `#9aa3ad` ink-mid, `#7f858b` muted, `#aebfff` accent-soft, `#54c79a` success, `#e6b450` warning, `#e0726c` error. Add no token.
- Keep these DOM hooks, which two scenarios read. `[data-jarvis-brief-band="peek"]` stays on BriefPeek's wrapper. On the body: `[data-jarvis-peek-title]`, `[data-jarvis-peek-body]`, `[data-jarvis-peek-body-toggle]`, `[data-jarvis-peek-row="run"]` with `[data-jarvis-peek-run=<runId>]`, `[data-jarvis-peek-open-graph]`, `[data-jarvis-peek-confirm=<status>]`. Hooks that change meaning: `[data-jarvis-peek-status-toggle]` now sits on the segmented group (`role="group"`, `aria-label="Record status"`). `[data-jarvis-peek-status=<status>]` sits on each segment: a `<span>` for the current status, a `<button>` for every other. New hooks:
  - `[data-jarvis-peek-record=<recordId>]` on RecordPeekBody's outermost element, in both hosts;
  - `[data-jarvis-peek-loading]` on the body's skeleton container;
  - `[data-jarvis-peek-error]` on the failed-read line;
  - `[data-jarvis-peek-pending=<status>]` on the segment whose terminal pick awaits confirmation.
- New dev hook `window.__recordPeekFor(id: string)`, installed in `frontend/app/view/jarvis/linkingdevhooks.ts` beside `__peekLoading`. It opens the Brief's record modal on any id, bypassing the router's existence check: `loadRecordDetail(id)`, then set `briefPeekRecordAtom` to `id`, then `landOn(model.surfaceAtom, "jarvis")`. The router (`openref.ts`'s `loadRecord`) refuses an id missing from the record list, so the failed-read state is otherwise unreachable in the app, the same reason `__peekLoading` exists.

### Task 1: Redesign RecordPeekBody and BriefPeek to board A
**Depends on:** none
**Files:** `frontend/app/view/jarvis/briefpeek.ts`, `frontend/app/view/jarvis/briefpeek.test.ts`, `frontend/app/view/jarvis/briefpeekview.tsx`, `frontend/app/view/jarvis/linkingdevhooks.ts`

`RecordPeekBody` (in `briefpeekview.tsx`) renders the body for both hosts: the Brief's modal (`BriefPeek`, place `"brief"`) and the avatar popup's record item (`peek/peekrecord.tsx`, place `"popup"`, not edited here). Derived data stays in `briefpeek.ts`, which is pure and tested in `briefpeek.test.ts`.

**Derivation (`briefpeek.ts`):**
- `PeekStatusRow.label` becomes sentence case ("Active", "Paused", "Completed", "Archived"). `status` stays the lowercase stored value.
- `RecordPeek` gains `titleIsId: boolean`, true when the record has no objective and `title` therefore falls back to the record id.
- `RecordPeek` gains `bodyIsAbsence: boolean`, true only when `body` is the stated absence "This record states no objective yet." It is false for an objective body and for the notes fallback.
- Nothing else in the module changes: notes, legal transitions, body clamp, fleet meta, run rows, log line.
- Tests (extend `briefpeek.test.ts` with Edit, never rewrite it):
  - labels are sentence case and statuses stay lowercase;
  - `titleIsId` is true for an empty objective and false otherwise;
  - `bodyIsAbsence` is true with no objective and no notes, and false with notes or with a multi-sentence objective;
  - from `archived`, the only rows are Active (control) and Archived (current). This is the board's "only reactivating is offered" case.

**View (`briefpeekview.tsx`):** match Main.dc.html and States.dc.html.
- **Header row:**
  - Padding `15px 12px 15px 18px`, `border-b border-border`, `items-start`, one row.
  - Title `<h2 data-jarvis-peek-title>`: 15px semibold `text-primary`, `leading-[1.4]`, wraps and never truncates. When `titleIsId` is true it renders in mono at 14px (States "Empty" board).
  - Right of the title, `updatedLabel` in mono 10.5px `text-muted`, `pt-[3px]`.
  - Then a close button copied from `newagentmodal.tsx`: `X` size 15, `h-7 w-7 rounded-[7px] text-muted hover:bg-surface-hover hover:text-primary`, `aria-label="Close"`, `-mt-1`.
  - The close renders only when the host passes a new optional prop `onClose?: () => void`. BriefPeek passes its close and the popup passes nothing, keeping its own header and close.
  - No uppercase RECORD label.
- **Status row** (`px-[18px] pt-[14px]`), built like `newruncontrol.tsx`'s `StartToggle`:
  - The group is `rounded-[8px] border border-border bg-surface p-0.5 gap-0.5`, with one segment per `statusPickerRows` row. Segments are `px-3 py-1 rounded-[6px] text-[11.5px] font-semibold`.
  - The current row is an inert `<span>` on `bg-surface-selected`, in its status colour (the existing `STATUS_FG` map), with a `Check` icon (11, stroke 2.4). It is not accent blue.
  - The other rows are `<button>`s in `text-ink-mid`, with a hover state and `aria-pressed={false}`.
  - Beside the group, the note (11px `text-muted`, `leading-[1.45]`, flex-1) shows the current row's note, or the pending pick's note while a confirm is open.
  - The dropdown picker, its chevron toggle and `StatusRow` are removed.
- **Terminal confirm:**
  - Picking a row with `terminal: true` opens the inline confirm under the status row in both hosts. The `onAskTerminal` prop, BriefPeek's `pendingStatus` state and its `ConfirmDialog` are removed (drop the import).
  - While it is open, the pending segment carries `data-jarvis-peek-pending`, `bg-surface-hover` and its own status colour.
  - The confirm box: `mx-[18px] mt-2.5 rounded-[8px] border border-edge-mid bg-surface px-3 py-2.5`, in one row.
    - On the left, the title "Mark this record <status>?" (12px semibold `text-ink-hi`) above the body "This sets the record's status to "<status>". You can reactivate it later." (11.5px `text-muted`).
    - On the right, "Yes, <status>" (`text-error` for archived, `text-warning` for completed) and "Cancel" (`text-secondary`), both `SMALL_BTN`-like (`rounded-[6px] border border-border bg-surface-raised px-[9px] py-[3px] text-[11px] font-semibold`).
  - Yes calls `setDossierStatus` and closes the confirm. Cancel closes it without writing. Opening a different record resets it.
  - Non-terminal picks write at once, as today.
- **Body** (`flex flex-col gap-4 px-[18px] pt-4 pb-[18px]`, scrolls):
  - Objective paragraph and show-more link are unchanged in behaviour and hooks. The paragraph is `text-ink-mid`, except `text-muted` when `bodyIsAbsence` (States "Empty" board).
  - **Runs section:**
    - A heading row: "Runs on this record" (12.5px semibold `text-secondary`), a spacer, then `fleetMeta` (mono 10.5px `text-muted`), `pb-2 px-0.5`.
    - Below it, a `rounded-[9px] border border-border bg-background overflow-hidden` table.
    - Each run is a `<button>` laid out as a grid, `grid-cols-[74px_minmax(0,1fr)_150px_118px] gap-3 px-3 py-2 items-center border-b border-edge-faint last:border-b-0 hover:bg-surface-hover text-left`. Its cells:
      - the short id (mono 10.5px semibold `text-accent-soft`);
      - the headline (12.5px `text-ink-hi`, truncated);
      - the meta (mono 10.5px `text-muted`, truncated);
      - the state, right-aligned (mono 10.5px semibold in `RUN_TONE[tone]`) after a 6px round dot `bg-current`.
    - With no runs, the table is replaced by the `runsAbsent` sentence in the same frame (mono 11px `text-muted`, `px-3 py-2.5`).
  - "Fleet · on this record" is gone.
- **Footer:**
  - `flex items-center gap-2 px-[18px] py-3 border-t border-border`, no fill, outside the scrolling body.
  - On the left, `logLine` as plain mono 10.5px `text-ink-mid` (no pill border).
  - On the right, the map button with the `Waypoints` icon, "Where it sits on the map", unchanged behaviour.
- **Loading:**
  - While `peek == null` and no read error is recorded for the id, the header shows a `SkeletonLine` title (`h-[14px] w-[300px]`) and the close.
  - The body shows `[data-jarvis-peek-loading]` containing:
    - a toggle-shaped block (`h-7 w-[290px] rounded-[8px]`);
    - three text lines (`h-2.5`, widths 100%, 92% and 60%);
    - a table block (`h-[110px] rounded-[9px]`).
  - Use `Skeleton` / `SkeletonLine` from `@/app/element/skeleton`.
- **Failed read:** when `recordDetailErrorAtom[recordId]` is set and there is no detail, the body shows `[data-jarvis-peek-error]` instead of the skeleton. The text is "Could not read this record: <error>" (12px `text-error`). It is never an endless skeleton.
- **Popup host:** the same body renders inside the avatar popup's panel, which is at most 560px wide. Keep the 4-column run grid there; the headline column (`minmax(0,1fr)`) truncates. No header close, because `peekrecord.tsx` passes no `onClose`.
- **Keep commit b088a4be's behaviour:** `openFromBrief` still closes the modal once a run opened from a row lands. It runs `passReturn("record", "sheet")` on a plain open and `forgetOrigin()` on a Ctrl+peek. `openFromPopup` closes the popup on success. Keep both functions as they are.
- Update the file header comment where it describes the hosts asking differently (both now ask in place).

**Acceptance:**
- `npx vitest run frontend/app/view/jarvis/briefpeek.test.ts frontend/app/view/jarvis/peek/peekrecordmodel.test.ts` passes, including the new tests above.
- Check passes.
- The rendered states are shown by the `brief-peek` scenario steps that Task 2 adds:
  - step 2a: loading skeleton;
  - step 4: toggle with legal transitions only and the current status inert with a check;
  - step 4b: the inline confirm, and Cancel writes nothing;
  - steps 4c and 4d: archived offers only Active, and reactivating works;
  - step 3b: the run lands in sight;
  - step 6: the popup host draws the toggle and a run row;
  - step 7: the failed read shows the error line through `__recordPeekFor`.
- The existing `brief-peeks-polish` record steps (title/body split, show-more toggle, map button) keep passing on the kept hooks.
- **Known gap:** the empty board is not reachable in the dev app, because no RPC creates an objective-less record, so no scenario renders it. `briefpeek.test.ts` covers its data: the stated-absence body with `bodyIsAbsence`, the runs-absent sentence, "no decisions yet", and `titleIsId`. Its rendering (mono id title, muted absence line) goes unverified in the running app.

### Task 2: brief-peek scenario reads the toggle and walks every reachable state
**Depends on:** Task 1
**Files:** `scripts/cdp/scenarios.mjs`

Edit only the `briefPeek` scenario (around `scripts/cdp/scenarios.mjs:823`). Do not run prettier on this file. It reads Task 1's hooks (shared rules above) and runs against Task 1's merged view. If a step fails because the view differs from this plan, fix the view's hook, not the assertion.

Changes:
- Every wait that polls for `[data-jarvis-brief-band="peek"] [data-jarvis-peek-status-toggle]` keeps working unchanged, because the hook moved to the group but still marks a loaded peek.
- **Step 2:** keep it, but read "Runs on this record" instead of `/fleet/i`. Rename `peek.fleet` to `peek.runsBand` and reword steps 2 and 2b ("names the record's runs or says it has none").
- **New step 2a, "the body draws skeleton lines while the record loads":**
  - Before the first palette row click in step 2, install a `MutationObserver` on `document.body` via `h.ev`. It sets `window.__briefPeekSawLoading = true` when any `[data-jarvis-brief-band="peek"] [data-jarvis-peek-loading]` appears.
  - After the toggle wait, assert the flag is true and that `[data-jarvis-peek-loading]` is gone. Disconnect the observer.
  - The record has not been opened earlier in the session, so its detail is uncached and the skeleton renders before the RPC returns.
- **Step 4** replaces the picker-click logic. No click is needed to see the options. Read `[data-jarvis-peek-status-toggle] [data-jarvis-peek-status]`. Pass when all of these hold:
  - at least 2 segments;
  - exactly one non-`BUTTON`, the current status, which contains an `svg`;
  - every status is in `active|paused|completed|archived`;
  - the segments' text is sentence case (`/^[A-Z][a-z]+$/`).
- **The status writes (4b to 4d) run only on the scenario's own record:** gate them on the band's `[data-jarvis-peek-record]` value equalling `BRIEF_PEEK_RECORD`. Otherwise push each step as failed, with the detail "the open record is <id>, not the seeded one; status writes skipped". User records are never written. Before writing, read the current status from the inert segment. If it is not `active`, first click the Active segment and wait for it to become current.
  - **4b, "a terminal pick asks inline; Cancel writes nothing":**
    - Click the Archived button and wait 300ms. Assert `[data-jarvis-peek-confirm="archived"]` is inside the band, its text contains "Mark this record archived?", and the Archived segment carries `data-jarvis-peek-pending`.
    - Take the shot `cdp-shots/brief-peek-confirm.png`.
    - Click its "Cancel" button. Assert the confirm is gone and the current segment is still `active`.
    - Also confirm through `h.rpc("getdossier", { dossierid: BRIEF_PEEK_RECORD })` that `.status === "active"`.
  - **4c, "Yes archives; only reactivating is offered":**
    - Click Archived, then the confirm's "Yes, archived".
    - Poll up to 5s for the current segment to be `archived`. Assert the segments are exactly `[active (button), archived (span)]`.
    - Take the shot `cdp-shots/brief-peek-archived.png`.
  - **4d, "reactivating writes at once, no confirm":**
    - Click Active. Poll up to 5s for current `active`. Assert no `[data-jarvis-peek-confirm]` appeared and `getdossier` reads `active`.
- Keep `await h.shot("cdp-shots/brief-peek.png")` after step 4. Keep step 3 and 3b (run lands in sight, peek closed) and step 5 (Escape) as they are.
- **New step 6, "the avatar popup's record item draws the same body":** add it after step 5.
  - Wait for `typeof window.__peekAddress === 'function'`, then call `window.__peekAddress('task:' + BRIEF_PEEK_RECORD)` and poll up to 6s for `[data-pet-peek-item="record"] [data-jarvis-peek-status-toggle]`.
  - Assert, inside `[data-pet-peek-item="record"]`, all of:
    - `[data-jarvis-peek-record]` equals `BRIEF_PEEK_RECORD`;
    - at least one `[data-jarvis-peek-run]` (poll up to 10s, as step 2c does);
    - no `[aria-label="Close"]` inside the body element (the popup keeps its own close).
  - Take the shot `cdp-shots/brief-peek-popup.png`.
  - Close the popup the way `peek-item-views` does (around `scripts/cdp/scenarios.mjs:1577`): click `[data-pet-peek] button[aria-label="Close Jarvis panel"]`. Then assert `[data-pet-peek-item]` is gone. Also close it in teardown, best-effort.
- **New step 7, "a record that cannot be read says so instead of loading forever":**
  - Wait for `typeof window.__recordPeekFor === 'function'`, then call `window.__recordPeekFor('verify-brief-peek-no-such-record')`.
  - Poll up to 6s for `[data-jarvis-brief-band="peek"] [data-jarvis-peek-error]`. Assert its text starts with "Could not read this record" and that no `[data-jarvis-peek-loading]` is in the band.
  - Take the shot `cdp-shots/brief-peek-error.png`.
  - Close with Escape and assert the band is gone.
- Teardown: add a best-effort `setdossierstatus` back to `active` for `BRIEF_PEEK_RECORD` before the detach, so a failure mid-4c never leaves it archived. Check the RPC's command name and payload in `frontend/app/store/wshclientapi.ts` (`SetDossierStatusCommand`, `GetDossierCommand`) and `frontend/types/gotypes.d.ts`.

**Acceptance:**
- `node --check scripts/cdp/scenarios.mjs` passes.
- `node scripts/cdp/final-verify.mjs brief-peek` passes every step on the merged result: 1, 2, 2a, 2b, 2c, 3, 3b, 4, 4b, 4c, 4d, 5, 6, 7.
- Final runs it with `brief-peeks-polish`.
