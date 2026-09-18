# Cockpit UI API for runtime workers — design

Date: 2026-09-18. Status: design approved in chat; spec pending review.

## Problem

The only way an agent can drive the cockpit today is raw CDP (`scripts/cdp/attach.mjs`): click nav
buttons by aria-label, scrape the DOM with selectors, call `window.TabRpcClient.wshRpcCall`. It cannot
read jotai state (`globalStore` is not on `window`), and CDP is compiled out of release builds
(`#[cfg(debug_assertions)]` in `src-tauri/src/main.rs`). So a worker Arc launches (claude, pi) has no way
to act on the cockpit for the user — "show me the diff", "open that run", "close that session".

Workers can already change *data* through `wsh` / wshrpc (runs, efforts, the jarvis DAG, meta). What is
FE-only is *view state*: which surface is up, what is selected, focus, and the keyboard actions that act
on them. That is the gap.

## Goal

A worker running inside Arc, in a packaged build, can:

1. read what the cockpit is showing (`state`),
2. point it at an entity (`reveal <address>`),
3. run any cockpit action the keyboard/palette can (`do <action-id>`),

without CDP, and without yanking the view out from under the user or doing something irreversible
unseen.

Non-goals (YAGNI): an MCP wrapper (a later thin layer over these RPCs if skill discovery proves weak);
the palette's chordless extras (new project, theme presets); Diff-surface file selection; screenshots or
arbitrary DOM reads; multi-window. CDP stays the *test* tool — it just stops being the worker interface.

## Design

### 1. Transport and wire contract

The frontend registers a second, fixed route `cockpit` beside its `tab:<bootTabId>` route. Workers each
run in their own tab, and `WAVETERM_TABID` names a tab the FE does not listen on, so a stable address is
required. The FE websocket link is trusted, and the Go router lets a trusted link bind any route that is
not a control or `link:` route (`wshrouter.go` bind check), so no router change is needed. Dev and
packaged builds run separate wavesrv processes, so the fixed name cannot collide across them; a worker's
`wsh` reaches the wavesrv that spawned it.

Go constant `RouteId_Cockpit = "cockpit"` in `pkg/wshutil/wshrouter.go`; the FE mirrors it as
`COCKPIT_ROUTE_ID`.

New per-domain file `pkg/wshrpc/wshrpctypes_ui.go`, composed into `WshRpcInterface`. FE-implemented only
— wshserver gets no methods, exactly like `SetBlockFocusCommand` today.

```go
type UiCommands interface {
    UiStateCommand(ctx context.Context) (*UiState, error)
    UiRevealCommand(ctx context.Context, data CommandUiRevealData) (string, error) // notice on success
    UiInvokeCommand(ctx context.Context, data CommandUiInvokeData) (string, error) // notice on success
}

type UiState struct {
    Surface   string     `json:"surface"`
    Busy      bool       `json:"busy"`      // user typed within USER_IDLE_MS, or a modal is open
    ModalOpen bool       `json:"modalopen"`
    Selection []string   `json:"selection"` // cockpit addresses, see section 2
    Actions   []UiAction `json:"actions"`   // applicable right now
}

type UiAction struct {
    Id          string `json:"id"`
    Label       string `json:"label"`
    Group       string `json:"group"`
    Destructive bool   `json:"destructive,omitempty"`
}

type CommandUiRevealData struct {
    Address       string `json:"address"`
    Anchor        string `json:"anchor,omitempty"`
    CallerBlockId string `json:"callerblockid,omitempty"`
}

type CommandUiInvokeData struct {
    ActionId      string `json:"actionid"`
    CallerBlockId string `json:"callerblockid,omitempty"`
}
```

Failures are RPC errors with a
human message — the caller is an LLM reading stderr, so it needs text, not status codes to branch on.
`task generate` produces the client and TS types.

**CLI** — `cmd/wsh/cmd/wshcmd-ui.go`, a `ui` cobra command with four subcommands. All send to
`RouteId_Cockpit` with a 15s timeout (the busy wait plus a landing's loads can exceed the 5s default).
`CallerBlockId` comes from `WAVETERM_BLOCKID`.

```
wsh ui state                       # UiState as indented JSON
wsh ui actions                     # one "<id>\t<label>[\tdestructive]" line per action
wsh ui reveal <address> [--anchor] # prints the notice, if any
wsh ui do <action-id>              # prints the notice, if any
```

A missing `cockpit` route (app closed, or cockpit not mounted yet) surfaces as
`the cockpit is not running`, not the router's raw error.

**Trust.** Any authenticated `wsh` can already call any wshrpc command, including FE-routed ones
(`wsh focusblock`). This adds verbs, not a new trust boundary.

### 2. Reveal and selection — the address dialect

Reveal does not invent entity kinds. The cockpit already has one address dialect (`view/jarvis/address.ts`,
"the one place a string becomes a destination"; Go emits the canonical form) and one router
(`view/jarvis/openref.ts`, `openAddress`). Reveal calls it:

| Address | Lands on |
|---|---|
| `run:<id>` / `channel:<id>` | Jarvis brief sheet, on that run / channel |
| `agent:<tabId>` (`tab:` alias) | Agent surface, that terminal |
| `task:<id>` | record peek |
| `memnote:<id>` (`memory:` alias) | Vault memory detail |
| `effort:<id>` | initiative sheet |
| `radarreport:<id>` (+ `--anchor <findingId>`) | Radar, that report / finding |
| `surface:<key>` | plain navigation (UI handler only, below) |

- The handler calls `openAddress(model, address, { anchor }, report)` with a **capturing** `report`, not
  the default toast: a failed reveal ("That run no longer exists") goes back to the worker as an error and
  never pops at the user. `superseded` (the user clicked something while the landing loaded) is an error
  too: "superseded by a newer navigation".
- `surface:<key>` is handled in the UI handler before `openAddress`: validated against `SurfaceKey`
  (`SURFACE_ORDER` plus `settings`), then `surfaceAtom` is set. It stays out of the shared router because
  this is its only caller.
- Files are not duplicated: `wsh view|edit <path>` already routes into the Code surface
  (`cockpit/openfilestore.ts`).

**Selection** is reported in the same dialect, so anything `state` reports can go straight back into
`reveal`. Derived per current surface from a plain snapshot of atom values:

| Surface | Source | Addresses |
|---|---|---|
| agent | `model.focusIdAtom` | `agent:<id>` |
| jarvis | `activeSubjectAtom` + `activeRunIdAtom[channelId]`; `briefPeekRecordAtom` | `channel:<id>`, `run:<id>`; `effort:<id>`; `task:<id>` for a `dossier` subject or an open peek |
| radar | `currentReportIdAtom` | `radarreport:<id>` |
| vault | `vaultTabAtom` = `records` → `vaultRecordIdAtom`; = `memory` → `memSelectedIdAtom` | `task:<id>`; `memnote:<id>` |
| everything else | — | `[]` |

`conversation` / `briefing` subjects have no address and are omitted.

### 3. Actions

**Catalog.** `Actions` = `buildCommandItems(bindingsAtom, postCloseContext(surface))`
(`cockpit/palette-commands.ts`) — the exact function the palette uses: same `when` gating, same
dedup-by-label, `paletteHidden` posture keys (`list:next-j`, …) excluded. The palette and workers can never
disagree about what exists. `CommandItem` gains `destructive?: boolean`, passed through from `Binding`.

**Invoke.** Resolve `ActionId` within that same list. Not found — misspelled, another surface's, hidden,
or guarded off by `when` — is one error, because the worker's next move is the same in every case:
`"<id>" is not an available action on <surface> right now; see wsh ui actions`. Then run it (after the
busy guard, below) against `postCloseContext(surface)`. A `run` that returns `false` did not act (its
target is absent, e.g. no cursor row) → `"<id>" did nothing here`. `CommandItem.run` returns the binding's
result so the handler can see it; the palette ignores it.

Bindings act on whatever the cursor/focus is on, so the worker flow is
`wsh ui reveal agent:<tab>` → `wsh ui actions` → `wsh ui do agent:fullscreen`.

Surface bindings register from inside their surface component (`useKeybindings`), so the catalog is
naturally "what the current surface offers" and changes after a reveal.

### 4. Guards

**Busy guard.** The dispatcher's window-capture keydown listener (`store/keybindings/dispatcher.ts`)
already sees every key; it also records the last keydown time. Before any reveal or invoke, the handler
waits until the user has been keyboard-idle for `USER_IDLE_MS` (1500) with no modal open, polling every
`BUSY_POLL_MS` (200). Not idle within `BUSY_WAIT_MS` (4000) → error
`the user is busy (typing or in a dialog); retry shortly`.

It keys off recent keystrokes, not "focus is in an editable field": the Agent surface's xterm textarea
holds focus nearly all the time, so an editable-focus rule would block workers forever. Modal-open is
`deriveKeyContext().modalOpen` (palette, new-agent, new-project, new-memory, Code finder, `modalsModel`).

**Destructive actions.** Audited 2026-09-18 against `bindings.ts`:

- The remote catalog excludes `paletteHidden` bindings, which already removes the keyboard-only
  irreversible gestures: `close-agent` (a double-press whose first press deliberately does nothing and
  returns `false`), the ask answer digits and `channels:submit`. Workers cannot close sessions or answer
  asks through this API.
- Of the palette-visible bindings, `code:delete` already confirms (`confirmDelete` →
  `ConfirmModal({ destructive: true })`). A remote invoke simply opens that modal. The handler compares the
  `modalsModel.modalsAtom` length before and after `run`; if it grew, the notice is
  `waiting on the user's confirmation`. (A `run` that opens a modal asynchronously is not detected; the
  modal still appears, only the notice is missing.)
- `vault:queue-dismiss` (hard-deletes a pending candidate via `MemoryDeleteCommand`) and `code:save`
  (overwrites the file on disk) are irreversible and do not confirm. They get `destructive: true` on
  `Binding` (`keybindings/types.ts`). A remote invoke wraps them in the same `ConfirmModal`, titled
  `<agent> wants to: <label>`, and returns the same notice. Keyboard behavior is unchanged.
  `vault:queue-keep` is not flagged: an accepted note can be archived.

Invoke never blocks on the user's answer — the worker learns the outcome from a later `state`.

**Trail.** Every successful remote reveal/invoke pushes an info toast `<agent>: <label | address>`, so a
view change is never unexplained — except when the invoke left a confirmation modal open, which is its own
trail. `<agent>` is the roster name for `CallerBlockId` (agents then terminals,
matched on `blockId`), falling back to `An agent`.

### 5. Discovery

A `cockpit-ui` skill in the canonical skills root (`memroots.SkillsRoot()`, beside `effort-tracking`),
which agentsync projects into claude and pi at every launch (`AgentSyncApplyCommand` in `launchAgent`).
It lives outside the repo like its sibling, so its full text is recorded here. `wsh ui --help` is the
in-band reference.

```markdown
---
name: cockpit-ui
description: Use when you want to show the user something in the Arc cockpit (a run, an agent terminal, a record, a memory note, a radar finding, a surface), read what they're looking at, or run a cockpit action for them — via `wsh ui`.
---

# Driving the Arc cockpit

You run inside Arc. `wsh ui` lets you see and steer the cockpit the user is looking at.

- `wsh ui state` — JSON: current surface, `busy`, `selection` (addresses), and the `actions` available now.
- `wsh ui reveal <address>` — take the user to an entity. Addresses: `run:<id>`, `channel:<id>`,
  `agent:<tabId>`, `task:<id>`, `memnote:<id>`, `effort:<id>`, `radarreport:<id> [--anchor <findingId>]`,
  `surface:<cockpit|jarvis|agent|radar|sessions|files|vault|usage|code|settings>`.
  Your own terminal is `agent:$WAVETERM_TABID`. Files: use `wsh view <path>` instead.
- `wsh ui actions` — the actions available right now (they depend on the surface and selection).
- `wsh ui do <action-id>` — run one, exactly as if the user pressed its key.

Rules:
- Read `state` before `do`: actions act on the current selection, so `reveal` the target first.
- Prefer `reveal` to show the user something; only `do` what they asked for.
- "the user is busy" means they are typing or in a dialog — wait and retry; never loop tightly.
- "waiting on the user's confirmation" means they must approve it; check `state` later, don't re-issue.
- Closing sessions and answering asks are not available here (use `wsh ask` for your own questions).
- Every successful call shows the user a toast naming you, so keep calls purposeful.
```

## Files

Go
- `pkg/wshrpc/wshrpctypes_ui.go` (new) — `UiCommands` + types; add `UiCommands` to `WshRpcInterface`.
- `pkg/wshutil/wshrouter.go` — `RouteId_Cockpit`.
- `cmd/wsh/cmd/wshcmd-ui.go` (new) — the four subcommands.
- Generated by `task generate`: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`,
  `frontend/types/gotypes.d.ts`.

Frontend
- `frontend/app/cockpit/uiapi.ts` (new, pure) — `selectionFor(surface, snapshot)`, `resolveAction(items,
  id, surface)`, `parseSurfaceAddress`, `isBusy(now, lastKeyTs, modalOpen)`, the timing constants.
- `frontend/app/cockpit/uiapi.test.ts` (new).
- `frontend/app/cockpit/uiclient.ts` (new, wiring) — a `WshClient` subclass with `handle_uistate`,
  `handle_uireveal`, `handle_uiinvoke`; reads atoms into the snapshot, runs the busy wait, calls
  `openAddress` / the binding / `ConfirmModal`, pushes the trail toast. `setupUiClient(model)` registers
  `COCKPIT_ROUTE_ID` on `DefaultRouter` and returns the unregister.
- `frontend/app/cockpit/cockpit-root.tsx` — `useEffect(() => setupUiClient(model), [model])` beside the
  existing subscriptions.
- `frontend/app/cockpit/palette-commands.ts` — `CommandItem.destructive` passthrough; `CommandItem.run`
  returns the binding's result (+ test).
- `frontend/app/store/keybindings/types.ts` — `Binding.destructive?`.
- `frontend/app/store/keybindings/bindings.ts` — `destructive: true` on `vault:queue-dismiss` and
  `code:save`.
- `frontend/app/store/keybindings/dispatcher.ts` — record and export the last keydown time.

Other
- `scripts/cdp/attach.mjs` — `h.rpc(command, data, opts)` forwards `opts` (for `{ route: "cockpit" }`).
- `scripts/cdp/scenarios.mjs` — `ui-api` scenario.
- `<SkillsRoot>/cockpit-ui/SKILL.md` — outside the repo (text above).

## Testing

Unit (vitest, pure — no render tests, per repo convention):
- `selectionFor`: each surface row of the table, incl. jarvis channel+run, dossier subject, open peek,
  vault records vs memory, and `[]` for unaddressed subjects/surfaces.
- `resolveAction`: found id; id not in the list.
- `toUiActions`: wire shape, `destructive` carried through only when set.
- `callerName`: known block, unknown block, no block.
- `parseSurfaceAddress`: valid key, unknown key, non-`surface:` address.
- `isBusy`: just inside / just outside `USER_IDLE_MS`, modal open.
- `buildCommandItems`: `destructive` passes through.

Live (`task verify:ui -- ui-api`, CDP calls the real handlers on the `cockpit` route; the FE router
delivers a same-window call locally, so the Go-router hop is covered by the manual `wsh` smoke instead):
1. `uistate` reports the surface the scenario navigated to, with actions.
2. `uireveal surface:usage` lands Usage (nav rail active label).
3. `uireveal run:<bogus>` errors to the caller and pushes no toast.
4. `uiinvoke go:cockpit` from Usage lands Cockpit; the trail toast appears. (`go:cockpit`, not
   `surface:back-home`: the latter's guard reads nine overlay atoms, the former only `navigate`.)
5. `uiinvoke` of an unavailable id errors with the `see wsh ui actions` hint.
6. A keystroke (`Input.dispatchKeyEvent`) followed immediately by `uireveal` waits out the idle window.

Manual smoke: from a terminal inside the dev app, `wsh ui state` and `wsh ui reveal agent:$WAVETERM_TABID`.

## Open risks

- `when` guards read live atoms beyond `KeyContext`, so an action listed by `state` can become
  unavailable by the time `do` runs; `do` re-resolves and errors cleanly.
- A worker that ignores "busy" and retries tightly produces toast noise only when it succeeds; failed
  calls toast nothing.
