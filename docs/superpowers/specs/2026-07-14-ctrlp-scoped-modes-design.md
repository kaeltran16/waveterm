# Ctrl+P Scoped Modes (sigil scopes)

Date: 2026-07-14
Status: Design approved, pending implementation plan.

## Problem

The command palette (`Ctrl+P`) is a strong launcher and navigator, but every query
searches all groups at once (Commands, Agents, Sessions) plus the leading launch group.
When the roster or session history is large, finding one agent or one session means
wading through unrelated kinds. There is no way to say "I only want channels" or "act on
this specific channel" without switching surfaces first.

## Goal

Add VS Code / Slack-style **scoped modes** driven by a leading sigil, so the user can
narrow intent in one keystroke — while leaving today's default behavior (launch group +
fuzzy-search-everything) exactly as-is.

Scopes:

| Sigil | Scope    | Enter action |
|-------|----------|--------------|
| `>`   | Commands | run the command (surface nav, New agent/project, shortcuts) |
| `@`   | Agents   | `openTerminal(agentId)` |
| `/`   | Sessions | resume (`launchAgent` with the session's resume command) |
| `#`   | Channels | navigate to the channel, **or** launch a goal into a picked channel |

Non-goals: per-agent action sub-menus (interrupt/close), recency/frecency ranking, scope
chips / Tab-cycling, theme commands. These were considered and deferred (see Deferred).

## Decisions (locked during brainstorming)

1. **Default mode unchanged.** Plain text (no leading sigil) keeps today's behavior: the
   launch group when a target channel is active, plus fuzzy search across Commands /
   Agents / Sessions. Sigils only *narrow*.
2. **Lean scope UI.** The sigil stays in the input and is parsed as a prefix (VS Code
   style). No scope pill, no Tab-cycle. Discovery is a footer sigil legend + placeholder
   hint.
3. **`#` navigates and launches.** `#` lists channels to navigate to; `#<channel> <goal>`
   launches the goal into the picked channel (not just the active one).

## Design

Implementation approach **A**: one small pure parse module + a branch in the existing
`command-palette.tsx`. Reuses the existing fuzzy matcher (`palette-match.ts`), launch
builder (`palette-launch.ts`), and group rendering. No Go, no generated types.

### 1. Parsing — `palette-scope.ts` (new, pure)

`parseScope(query)` inspects `query[0]`:

- `>` → `command`, `@` → `agent`, `/` → `session`, `#` → `channel`. `sub` = the remainder
  after the sigil (leading whitespace trimmed for matching; internal spaces preserved).
- Any other first char → `default`.

The sigil only triggers at position 0, so a launch goal like `fix #123 bug` is unaffected.
A goal that *literally starts* with `# @ / >` is shadowed by its scope — a rare,
documented tradeoff. `@` is safe because the launch flow synthesizes `@runtime` internally
and the user never types a leading `@`.

Return shape (illustrative):

```ts
type ParsedScope =
  | { scope: "default" }
  | { scope: "command" | "agent" | "session"; sub: string }
  | { scope: "channel"; sub: string; channelLaunch: { token: string; goal: string } | null };
```

For `channel`, the split between picker and launch is one rule — **does `sub` contain a
space followed by a non-empty goal?**

- **No** → `channelLaunch: null` → picker mode. Filter channels fuzzy on `sub`.
- **Yes** → `channelLaunch = { token, goal }` where `token` is the first whitespace token
  and `goal` is the trimmed remainder → launch mode into the channel `token` resolves to.

`resolveChannelToken(token, channels)` (also in `palette-scope.ts`, pure): exact
case-insensitive name match first, else best fuzzy match via the existing matcher, else
`undefined`.

### 2. Per-scope rendering + Enter (in `command-palette.tsx`)

- **default** — unchanged. Launch group (when a target channel exists and a goal is typed)
  + ranked Commands / Agents / Sessions.
- **`>` / `@` / `/`** — a single group of that kind, fuzzy-ranked on `sub` with the
  existing `rankPaletteItems`. Empty `sub` → all items of that kind in natural order. Enter
  runs the existing per-kind action (nav / `openTerminal` / resume). No launch group.
- **`#` picker** — a new "Channels" group listing channels matched on `sub`. Item: title
  `#<name>`, subtitle = project label. Enter → `selectChannel(oid)` + set
  `surfaceAtom = "channels"` + close.
- **`#` launch** — resolve `token` → target channel. If resolved, render the launch group
  (header "Launch in #<name>") built from `goal`. If unresolved, show
  "No channel matches '<token>'".

### 3. Launch generalization (DRY)

Today the launch deps and the Jarvis-profile prefetch close over the **active** channel.
Introduce a single `targetChannel`:

- `#`-launch mode with a resolved token → the picked channel.
- Otherwise → the active channel (`activeChannelAtom`).

The deps-builder (`dispatch`/`run`/`consult` over `sendChannelMessage` / `createRun`) and
the profile-prefetch effect both key on `targetChannel`, so the default path and the
`#`-launch path share one code path. The picked channel resolves its own Run-strategy label
through the same prefetch effect (keyed on `targetChannel?.oid`); before it loads, the Run
row shows the existing "resolving channel strategy…" fallback and `createRun` receives the
current defaults — identical to today's pre-load behavior on the active channel.

### 4. Footer + placeholder

- Footer shows a sigil legend — `> commands   @ agents   # channels   / sessions` —
  whenever there is no launch echo to show. The launch-echo footer (selected launch row)
  is unchanged and still wins.
- Placeholder becomes `Search, or type > @ # / to scope…`.

### 5. Edge cases

- **No channels** → `#` shows an empty "No channels." state; default launch group is absent
  when there is no active channel (unchanged today).
- **`#<token>` resolves to nothing** (launch mode) → "No channel matches '<token>'".
- **Sigil alone** (`>`, `@`, `#`, `/` with empty `sub`) → all items of that kind, natural
  order; `#` shows the full channel list.
- **Trailing space, empty goal** (`#backend `) → still picker mode (goal is empty), so the
  matched channel stays selectable until a real goal char is typed.
- **Selection reset** — changing the query resets selection to 0 (unchanged).

## Files

- **New** `frontend/app/cockpit/palette-scope.ts` — `parseScope`, `resolveChannelToken`
  (pure).
- **New** `frontend/app/cockpit/palette-scope.test.ts` — parse cases per sigil, default,
  `#` picker-vs-launch split, token resolution (exact / fuzzy / none), sigil-not-at-0,
  empty/whitespace `sub`.
- **Edit** `frontend/app/cockpit/command-palette.tsx` — add channel items + "channel"
  `PaletteKind`, branch on `parseScope`, generalize launch to `targetChannel`, footer
  legend, placeholder. Import `channelsAtom` / `selectChannel` from `channelsstore`.

No Go changes, no `task generate`.

## Testing

- Unit (vitest): `palette-scope.test.ts` covers all parse + resolution branches. Existing
  `palette-launch.test.ts` and `palette-match.test.ts` stay green.
- Manual / CDP at implementation time: screenshot each scope (`>`, `@`, `/`, `#` picker,
  `#<channel> <goal>` launch) in the live dev app per repo norms.

## Deferred

- Per-agent action sub-menu (interrupt / close / jump) — the "act on an agent" direction.
- Recency / frecency ranking and a Recent section on empty query.
- Visible scope chips + Tab/Shift+Tab cycling (chose the lean typed-sigil model instead).
- Theme / appearance and channel-management (create/rename/delete) commands.
