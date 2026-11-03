# Arc phone app remote control: round 1 fixes

Fixes two issues the run's tasks found and left: a code block in the phone chat wraps Go code early, and a test file the run changed fails `prettier --check`.

**Spec:** C:\Users\kael02\AppData\Local\arc-wt\2ce13736\docs\superpowers\specs\2026-11-03-arc-pwa-more-design.md

Decisions:
- Tab width 4 for the phone's reply code blocks. Gofmt'd Go indents with tabs, and the browser's default of 8 columns per tab wraps nested lines on a 390 px phone (shot `remote-phone-9-chat-working`). 4 keeps the indentation legible and matches the width most editors use. 2 is too tight to read nesting.
- The prettier fix is a format-only change to one test file the run already edited. The import-order failure was already there before the run, but the run touched the file, so it is fixed here rather than left.

### Task 1: Phone reply code tab width, and the bindings test format

**Depends on:** none

**Files:** `pkg/remotemode/web/static/phone.css`, `frontend/app/store/keybindings/bindings.test.ts`

**Work:**
- Add `tab-size: 4;` to the `.reply-code` rule in `phone.css`. Change nothing else in the rule.
- Run `npx prettier --write frontend/app/store/keybindings/bindings.test.ts` on that one file only, never on the tree. The diff must change only the format: it must not add, remove or change any test or assertion.

**Acceptance:**
- `grep -n "tab-size: 4" pkg/remotemode/web/static/phone.css` shows the declaration inside `.reply-code`.
- `npx prettier --check frontend/app/store/keybindings/bindings.test.ts` passes.
- `npx vitest run frontend/app/store/keybindings/bindings.test.ts` passes.
- In the `remote-phone` scenario, Final runs step 9, which has the shot `remote-phone-9-chat-working`. In that shot, the Go code block's indented lines no longer wrap at the tab indent. The worker does not start a dev app.
