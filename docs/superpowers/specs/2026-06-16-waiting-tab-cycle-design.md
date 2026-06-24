# Ctrl-based tab navigation: waiting-session cycle + absolute tab switch

- Date: 2026-06-16
- Status: Approved (design); pending implementation plan
- Scope: small, single implementation plan

## Problem

On Windows, Wave's tab/session navigation lives under the `Alt` modifier (the
codebase maps the `Cmd` token to `Alt` on non-macOS via `keyutil.ts`). Two
frictions for this user's workflow:

1. Absolute tab switching is `Alt+1`–`Alt+9`; the user wants the universal
   Windows/browser/VS Code convention of `Ctrl+1`–`Ctrl+9`.
2. There is no fast, dedicated key to bounce between the sessions that currently
   need attention. The sidebar already tracks a `"waiting"` status, and
   `jumpToNeedsYou` (`Alt+Shift+N`) jumps forward to the next waiting session,
   but it is forward-only and not on a memorable key.

## Decisions

| Binding | Action |
| --- | --- |
| `Ctrl+1` … `Ctrl+9` | Switch to tab N (replaces `Alt+1`–`Alt+9`) |
| `Ctrl+Tab` | Jump to next `"waiting"` session, wrapping |
| `Ctrl+Shift+Tab` | Jump to previous `"waiting"` session, wrapping |

Rationale for the key choices (terminal-safety):

- `Ctrl`+letter is never used here — every `Ctrl`+letter is an ASCII control
  code the shell owns (`Ctrl+C/D/E/R`...), so those stay with the terminal.
- `Ctrl`+digit produces no control code except the niche `Ctrl+2` (NUL) and
  `Ctrl+6` (`Ctrl-^`); accepted, matching Windows Terminal's trade-off.
- `Ctrl+Tab` has no defined terminal sequence (plain `Tab` is `0x09`, but
  `Ctrl+Tab` is not), which is why browsers/VS Code/Windows Terminal use it.
  It is also not in `keyutil.ts`'s `inputKeyMap`, so claiming it does not
  disturb Tab-to-complete or terminal Tab input.

`Ctrl+Tab` intentionally drives the **waiting-only** filter rather than an
all-tabs cycle. When 0 sessions are waiting it is a no-op; with 1 it jumps then
holds; with 2+ it cycles. This is acceptable because `Ctrl+number` covers direct
navigation to any specific tab.

## Behavior

The waiting cycle scans from the active session in the sidebar's visual order
(pinned rows first, then each group top-to-bottom — i.e. `flattenVisualOrder`)
for the next/previous row whose `status === "waiting"`, wrapping around. If no
row is waiting, it returns nothing and the active session does not change.

This generalizes the existing forward-only `needsYouTarget` into a directional
scan parameterized by `offset` (`+1` next, `-1` previous).

## Implementation

### 1. `frontend/app/tab/sessionsidebar/sessionviewmodel.ts`

Generalize `needsYouTarget` into a directional pure function:

```ts
/** Pure: the next/prev waiting session relative to the active one in visual order, wrapping. */
export function waitingTarget(vm: SidebarViewModel, offset: number): string | undefined {
    const order = flattenVisualOrder(vm);
    if (order.length === 0) {
        return undefined;
    }
    const activeIdx = order.findIndex((r) => r.active);
    for (let i = 1; i <= order.length; i++) {
        // normalize any integer (offset may be negative) into [0, len)
        const idx = (((activeIdx + offset * i) % order.length) + order.length) % order.length;
        if (order[idx].status === "waiting") {
            return order[idx].tabId;
        }
    }
    return undefined;
}

/** Forward wrapper — preserves the existing jump-to-needs-you behavior. */
export function needsYouTarget(vm: SidebarViewModel): string | undefined {
    return waitingTarget(vm, 1);
}
```

`needsYouTarget` is kept so `jumpToNeedsYou` / `Alt+Shift+N` is unchanged.

### 2. `frontend/app/tab/sessionsidebar/sessionsidebarmodel.ts`

Add a cycle action mirroring `cycleSession`:

```ts
export function cycleWaiting(offset: number) {
    const vm = globalStore.get(sessionSidebarViewModelAtom);
    const target = waitingTarget(vm, offset);
    if (target != null) {
        setActiveTab(target);
    }
}
```

Import `waitingTarget` alongside the existing `needsYouTarget`/`cycleTarget`.

### 3. `frontend/app/store/keymodel.ts`

- Import `cycleWaiting` from the sidebar model (next to the existing
  `cycleSession`, `jumpToNeedsYou` imports).
- In the absolute-tab loop, change the descriptor from `Cmd:${idx}` to
  `Ctrl:${idx}`:

```ts
for (let idx = 1; idx <= 9; idx++) {
    globalKeyMap.set(`Ctrl:${idx}`, () => {
        switchTabAbs(idx);
        return true;
    });
    // ... existing Ctrl:Shift:c{Digit/Numpad} block-number bindings unchanged ...
}
```

- Add the waiting-cycle bindings in `registerGlobalKeys`:

```ts
globalKeyMap.set("Ctrl:Tab", () => {
    cycleWaiting(1);
    return true;
});
globalKeyMap.set("Ctrl:Shift:Tab", () => {
    cycleWaiting(-1);
    return true;
});
```

### 4. `frontend/app/tab/sessionsidebar/sessionviewmodel.test.ts`

Add cases for `waitingTarget`:

- forward finds the next waiting row after active, wrapping past the end;
- backward finds the previous waiting row, wrapping past the start;
- 0 waiting rows → `undefined`;
- exactly 1 waiting row → returns it for both directions;
- no active row (`activeIdx === -1`) behaves deterministically (does not throw).

### 5. `docs/docs/keybindings.mdx` (optional)

Update the Global Keybindings table: tab-number switch is now `Ctrl+1-9`, and
add `Ctrl+Tab` / `Ctrl+Shift+Tab` for the waiting-session cycle.

## Cross-platform note

Changing `Cmd:${idx}` to `Ctrl:${idx}` applies to all platforms: on macOS the
absolute tab switch moves from `Cmd+number` to `Ctrl+number`. Accepted — this is
a personal Windows-focused fork. `Ctrl+Tab` / `Ctrl+Shift+Tab` are identical on
both platforms.

## Not changing

- `Alt+Shift+J` / `Alt+Shift+K` — cycle all sessions.
- `Alt+Shift+N` — jump to next waiting session (kept deliberately as a second
  entry point; now redundant with `Ctrl+Tab` forward, by choice).
- `Alt+[` / `Alt+]` — switch tab left/right.

## Testing

- Unit: `waitingTarget` cases above (pure function, no runtime deps — the
  sidebar view-model file is React/Wave-free).
- Manual: with ≥2 waiting sessions, `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle among
  them both directions and wrap; `Ctrl+1`–`9` jump to the Nth tab; confirm
  `Ctrl+D` still sends EOF to a shell (i.e., we did not steal it).
