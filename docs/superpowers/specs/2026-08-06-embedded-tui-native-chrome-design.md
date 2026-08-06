# The embedded TUI is cockpit chrome, not a guest window

**Date:** 2026-08-06
**Status:** design approved, no plan written yet
**Supersedes nothing.** Builds on the Agent (Focus) surface (`agentsurface.tsx`), the runtime theme engine (`themes.ts` + `themestore.ts`), and the central keybinding registry (`frontend/app/store/keybindings/`, spec `keyboard-operability-foundation`).

## 1. Why

The Agent surface's centre pane is the real Claude Code / Codex TUI, rendered as an xterm block (`agentsurface.tsx:96` → `CockpitFocusPane`). It is the most-looked-at rectangle in the product and the only one that does not behave like part of it. Two symptoms, two unrelated causes.

### 1.1 The terminal is on a different color system

Three separate mechanisms conspire:

- **The palette is upstream Wave Terminal's, not the cockpit's.** `computeTheme` (`termutil.ts:33-54`) resolves `fullConfig.termthemes[themeName]`, and `themeName` defaults to `DefaultTermTheme = "default-dark"` (`termutil.ts:4`, via `term-model.ts:256-260`). That entry lives in `pkg/wconfig/defaultconfig/termthemes.json`: foreground `#c1c1c1`, blue `#85aacb`, white `#c1c1c1`. The cockpit's default Midnight preset (`themes.ts:51-57`) is text `#e6e9ed`, accent `#7c95ff`. Claude Code paints its boxes, spinners and diffs through the 16 ANSI slots, so the TUI renders in a different product's colors.

- **The black seam is xterm's own stylesheet.** `computeTheme:52` deliberately forces `themeCopy.background = "#00000000"` and returns the real background separately as `bgcolor`, which upstream fed to the block frame. The cockpit does not render that frame — `CockpitFocusPane` (`focus-pane.tsx:26-32`) mounts the terminal view directly against a synthetic node model — so `blockBg` (`term-model.ts:267-276`) is **defined and read nowhere**. With xterm's own background transparent and no frame painting behind it, what shows through is xterm's stylesheet rule `.xterm .xterm-viewport { background-color: #000 }`. Pure black, inside a `#0c0e11` cockpit.

- **The theme picker cannot reach it.** `useApplyCockpitTheme` (`themestore.ts:27-33`) writes `buildThemeVars(...)` onto `document.documentElement` as `--color-*` custom properties. Nothing in that path touches xterm. All six presets leave the terminal byte-identical.

There is also a **duplicated palette**. `tailwindsetup.css:148-163` declares `--ansi-black` … `--ansi-brightwhite`, consumed by `ansiline.tsx:13,33` to render ANSI text inside cockpit surfaces. Those sixteen values are a byte-identical copy of `default-dark` from `termthemes.json`, and `themes.ts:10-12` explicitly excludes them from theming ("identity colors (avatar/mem/rt/ansi) are left at their tailwindsetup.css @theme defaults"). So the cockpit already has an ANSI vocabulary; it is a second hand-synced copy of the palette the terminal reads, and neither copy is theme-aware.

### 1.2 The guard that protects text fields also silences the cockpit

The dispatch mechanism is sound. `initKeybindingDispatcher` (`dispatcher.ts:107`) listens on `window` in **capture** phase, so it runs ahead of xterm's `attachCustomKeyEventHandler` (`termwrap.ts:269`) and ahead of `handleTerminalKeydown` (`term-model.ts:709`). Nothing is being swallowed by the terminal.

The cause is `deriveKeyContext` (`dispatcher.ts:39-56`), which sets `editable: true` whenever `document.activeElement` is an `INPUT`/`TEXTAREA`/`SELECT`/contenteditable (`isEditableTarget`, `:31-37`). xterm's input target is a hidden textarea, so **the TUI is permanently "editable"**. `types.ts:12` says so outright: "covers the terminal textarea".

Every binding gated by the shared `navigate` guard (`bindings.ts:48`, `!ctx.editable && !ctx.modalOpen`) is therefore dead while the TUI holds focus:

| Dead in the TUI | Where |
|---|---|
| all ten `g <letter>` surface teleports | `bindings.ts:35-46`, `:94-101` |
| `[` / `]` surface cycling | `bindings.ts:106-107` |
| `Shift+?` cheat sheet | `bindings.ts:186-193` |
| `Escape` → Cockpit | `bindings.ts:194-220` |
| `←` `→` `j` `k` switch agent, `d` rail, `f` fullscreen | `bindings.ts:523-542` via `agentNav` (`:474`) |

What survives is modifier-only: `Ctrl+1`–`Ctrl+9` (`:86-92`, no guard at all), `Ctrl+P` (`:108-126`, deliberately unguarded — the comment explains it also keeps WebView2's print dialog off the key, per `ccc90133`), `Ctrl+N`, `Ctrl+Tab` / `Ctrl+Shift+Tab`, `Ctrl+C` twice, and `Shift+Escape` (`:543-554`) — which exists precisely to hand focus back to the nav and is undiscoverable.

The footer already **documents** this rather than solving it. `hints-footer.tsx:4-8` describes three postures, one of which shows "only editable-surviving chords (dimmed) when focus is in the terminal", and `footerhints.ts:19-25` annotates the casualties inline: the `g`/go chip and the `?`/help chip both carry the comment "drops in the terminal". Clicking into the TUI visibly shortens the footer.

Nothing in the backend causes any of this. Both halves are frontend-only.

## 2. What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| Runtime theme engine: 6 dark presets → `--color-*` on `<html>` | `themes.ts`, `themestore.ts` (`useApplyCockpitTheme`) | Shipped. Gains a second consumer; the write path is unchanged. |
| Hex helpers (`mix` / `lighten` / `darken` / `rgba` / `parseHex`) | `themes.ts:140-166` | Shipped, dependency-free. Reused by the ANSI derivation. |
| Per-role custom color overrides + their persistence | `themeOverridesAtom` (`themestore.ts:18-21`), merged at `buildThemeVars:170` | Shipped. The terminal inherits overrides for free by deriving from the same merged palette. |
| Terminal theme application on change | `TermThemeUpdater` (`termtheme.ts:17-28`) | Shipped. Its inputs change; the effect does not. |
| Leader mode: entry, expiry, cancel, which-key rendering | `dispatcher.ts:19-29` (`setLeader`, `CHORD_TIMEOUT`), `matcher.ts:21-33`, `leaderatom.ts`, `hints-footer.tsx:47` | Shipped. The tree gains a second door; the machinery is untouched. |
| Footer chip filtering by live binding activity | `footer-visible.ts:24` | Shipped. A chip cannot advertise a key that would not fire — which is why the new entry needs a real registered binding, see decision 6. |
| Documentation-only bindings that never consume their key | `buildCockpitBindings` (`bindings.ts:451-472`, `run: () => false`) | Shipped. Precedent for the leader-entry chip. |
| Conflict assertion over the whole registry | `assertNoConflicts` (`bindings.test.ts`) | Shipped. Must still pass after the guard loosens. |
| Function-key support in the chord parser | `keyutil.ts:188-224`; uppercase-Shift inference is scoped to single-char keys (`:114-124`) | Shipped. `"F11"` is a valid descriptor with no modifiers, and no function key is bound anywhere today. |
| CDP scenario harness | `task verify:ui` → `scripts/cdp/verify.mjs`, `scripts/cdp/scenarios.mjs` | Shipped. Both halves get scenarios. |

## 3. Resolved decisions

**1. The palette object is the single source; nothing reads the DOM back.** The rejected alternative was to have the terminal resolve `--color-*` / `--ansi-*` off `document.documentElement` via `getComputedStyle`. That is a round trip through the DOM to recover values the cockpit itself just wrote from `ThemePalette`, it cannot be unit-tested without a browser, and it needs a separate signal to know when to re-read. Instead `ThemePalette` gains a second consumer beside `buildThemeVars`. One derivation, two outputs, both pure.

**2. The sixteen ANSI colors are derived, not hand-authored per theme.** Authoring them explicitly would be higher fidelity and would let each theme be tuned against Claude Code's actual diff backgrounds, at a cost of 96 values now and 16 for every future theme. Derivation keeps a seventh theme free. The legibility risk this accepts is answered by a measured contrast floor rather than by trust — see decision 5.

**3. One ANSI vocabulary, though its only live consumer will be the terminal.** Both branches call the same `deriveAnsi(palette)`, so the `--ansi-*` block in `tailwindsetup.css:148-163` stops being an independent copy of `termthemes.json` and becomes a fallback that `buildThemeVars` overrides on every theme application. The duplication named in §1.1 closes as a side effect of the main change rather than as separate cleanup.

*Correction to an earlier draft of this design, found while writing the implementation plan:* `ansiline.tsx` has **no importers** — it is orphaned upstream code, and `ANSI_TAILWIND_MAP` is exported to nobody. So the claim that theming `--ansi-*` makes cockpit ANSI text and the TUI "agree" overstates the benefit: there is no live cockpit ANSI text to agree with. Two consequences, one in each direction. The gain is narrower than it looked — a single source of truth, not two consumers reconciled. The cost is also narrower, and that is the more useful half: emitting `--ansi-*` from `buildThemeVars` is **visually inert** today, so the only observable effect of the whole palette change is inside the terminal. That shrinks the blast radius and is why the emission needs no separate visual verification of its own.

**4. The background becomes opaque and `term:transparency` goes away.** Translucency over a solid single-window background buys nothing, and it is the reason `computeTheme:52` forces the background transparent, which is the reason the black viewport rule shows through. Setting xterm's `theme.background` to the theme's own `--color-background` makes xterm paint over `.xterm-viewport`'s `#000`. `term:transparency` (`term-model.ts:261-266`, default 0.5) and the now-doubly-dead `blockBg` (`:267-276`) are deleted with it.

**5. Legibility is guarded by structural invariants plus a 3:1 floor — not by comparison with the old palette.**

*Correction to an earlier draft, found while writing the implementation plan by computing the actual numbers.* That draft proposed recording each `default-dark` color's contrast ratio against Midnight's background and asserting every derived color clears its own slot's baseline. **Measured, that rule fails on eleven of twelve slots** — Slate's yellow reaches 78% of the baseline, Slate's green 87%, Midnight's blue 88%. The failure is not a flaw in the derivation. Upstream Wave's ANSI set is washed-out pastel (`yellow: #cbca9b`, `blue: #85aacb`) and therefore very bright against a near-black background, while each cockpit theme's semantic roles are chosen for legibility against *that theme's own* background. Requiring the derived palette to match upstream's ratios would force every theme's terminal to be brighter than the theme itself, which defeats the point of deriving from it.

What replaces it is four theme-independent structural invariants — each catching a specific way the derivation can go wrong, none involving a tuned number — plus one absolute floor:

| Invariant | What it catches | Measured |
|---|---|---|
| all 16 slots present and parseable; background opaque | the seam regression, and a missing slot silently falling back to xterm's default | — |
| the grey ramp is strictly monotonic: `black` < `brightBlack` < `white` < `brightWhite` by luminance | One Dark defines `muted` **lighter** than `secondary`, so a naive `white ← secondary` mapping renders "bright black" lighter than "white" | holds in all 6 |
| `bright<X>` strictly lighter than `<X>`, all 8 pairs | a `lighten` factor too small to distinguish the pair | holds in all 6 |
| magenta's hue ∈ [280°, 320°], cyan's ∈ [170°, 200°] | the Carbon defect in decision 12 — an amber accent producing a green "magenta" | holds in all 6 |
| every slot ≥ 3:1 against its own theme background | a gross legibility regression | lowest is **3.51** (Nocturne's `black`) |

3:1 is WCAG's threshold for user-interface components and large text. Terminal glyphs at 12px are not large text, so this is a floor that catches gross regressions — it does **not** certify AA compliance, and the spec does not claim it does. Midnight's sixteen derived values are additionally pinned as a golden set, so any future palette edit that darkens the terminal surfaces as a reviewable diff rather than a silent change.

*Pre-existing condition, recorded so it is not later mistaken for a regression from this work:* Monokai's `error` (`#f92672`) reaches only 3.9:1 against Monokai's own background and One Dark's `error` (`#e06c75`) 4.4:1 — both below AA for normal text. Those are the shipped cockpit values, used today for error text on those themes. This design propagates them into ANSI red; it does not create them. Raising them is a theme-palette question, not a terminal question.

**6. Leader entry is a matcher alias, and separately a documentation-only binding.** The alias (`Ctrl+G` → leader `g`) must be checked against a constant map, **not** against the prefixes derived from `sequences` in `matchBinding:42`, because `sequences` is `when`-filtered and is empty inside the TUI — deriving the door from the filtered set would make it depend on the very thing it exists to open. The footer and cheat sheet, however, both render from registered `Binding`s (`footer-visible.ts:24`), so the chord additionally gets a registered binding whose `run` returns `false`, following the `buildCockpitBindings` precedent. The alias performs; the binding documents.

**7. Once a leader is active, `editable` is no longer a reason to stand down.** This is the load-bearing insight of the keyboard half. While `ctx.leader != null` the dispatcher consumes the keystroke and it never reaches the agent, so "focus is in a text field" has already been overridden by a deliberate chord. The guard becomes `(!ctx.editable || ctx.leader != null) && !ctx.modalOpen`. In the TUI with no leader active, `editable` is true and `leader` is null, so behavior is bit-for-bit what it is today.

**8. A leader continuation falls back to singles, but `Escape` cancels first.** `matchBinding:32` currently returns `{kind: "reset"}` when no sequence matches the continuation. Adding a `singles` pass before that reset makes `d`, `j`, `k`, `[`, `]` and `?` reachable under the leader without inventing six new `g <letter>` bindings — the surface-local vocabulary is reused rather than mirrored.

`Escape` must be handled *ahead* of both passes, because it is itself a registered single: `agent:back` (`bindings.ts:509-522`) navigates to the Cockpit and `subagent:back` (`:488-508`) returns to the parent agent, and the loosened guard makes both active during leader mode. Without an explicit rule, `Ctrl+G` then `Escape` would navigate instead of cancelling — which is the opposite of what every which-key interface means by Escape, and would strand the user on a surface they did not ask for. So the leader branch resets on `Escape` before matching anything. Cancelling a leader is the only meaning `Escape` has while the which-key bar is showing.

**9. Sequences beat singles under the leader, and fullscreen gets `F11`.** `GO_TARGETS` (`bindings.ts:35-46`) already binds `g f` to the Files surface, so with sequence precedence `f` under the leader means Files and the fullscreen toggle (`bindings.ts:535-542`) would be unreachable from inside the TUI. Checking all ten leader letters `{h a c r s f m u b ,}` against the singles the guard gates `{d f j k [ ] ? Escape ← →}`, `f` is the only collision. (`Escape` appears in that set because `agent:back` is gated the same way, but it never reaches the singles pass — decision 8 intercepts it.) Rather than retrain `g f` or leave fullscreen mouse-only, fullscreen gains `F11` as an always-live chord: it is the universal convention, it carries no editor muscle-memory (unlike `Ctrl+Shift+F`, which reads as find-in-files), and a function key is not something a TUI's text input consumes.

**10. Other surfaces' inline `editable` guards are untouched.** `buildJarvisBindings:317`, `buildFilesBindings:563`, `buildListNavBindings:227-232` and `buildCockpitBindings:452` each test `ctx.editable` directly. The leader will therefore **not** rescue keys on those surfaces when a composer or filter box holds focus. Stated explicitly so it is a scope boundary rather than a later-discovered inconsistency; those surfaces have no equivalent of a permanently-focused textarea, so the pressure that motivates this spec does not exist there.

**11. Every control that sets a terminal color is removed; the Go config stays.** With the cockpit theme as the source, anything else that sets a terminal color would fight it. There are **three** such controls, not one:

- the right-click submenu of seven upstream palettes, built at `term-model.ts:949-966`, which writes the per-block `term:theme` meta;
- the Settings surface's **Color scheme** row (`settingssurface.tsx:671-677`), a dropdown with three-swatch previews built from the backend `termthemes` map, whose description reads "ANSI palette used inside agent terminals" — a global `SetConfigCommand` write, not per-block meta;
- the Settings surface's **Transparency** slider (`settingssurface.tsx:653-670`), which sets the value decision 4 deletes.

*Correction to an earlier draft, found while writing the implementation plan:* the two Settings rows were missed entirely, and they matter more than the context submenu — they are labelled, discoverable, global, and after this change the Color scheme row's own description becomes false. Both rows come out of the `TerminalSection` card; its other five rows (font size, cursor style, cursor blink, scrollback, copy on select) are not color and stay. Colour now lives solely in `AppearanceSection`, whose Theme subtitle already reads "Base palette for every surface" — which this change makes literally true.

The "Magnify block" item (`term-model.ts:885-892`) comes out with the submenu, since it does nothing under the synthetic node model. `termthemes.json` and the generated `TermThemeType` are left in place: removing them touches the wconfig schema and regenerated bindings for no user-visible gain.

## 4. Palette: one derivation, two consumers

```
ThemePalette  (themes.ts — 6 presets, merged with themeOverridesAtom)
      |
      +-- buildThemeVars()   -> --color-*  +  --ansi-*   -> <html>  -> Tailwind utilities, ansiline.tsx
      |
      +-- deriveTermTheme()  -> xterm ITheme                        -> the live TUI
                \
                 +-- both call one pure deriveAnsi(palette)
```

### 4.1 `deriveAnsi(palette) → AnsiPalette`

Sixteen colors from roles the palette already defines. `lighten` is the existing helper at `themes.ts:156`.

| ANSI slot | Source | Bright variant |
|---|---|---|
| black | `inkFaint` | `muted` |
| red | `error` | `lighten(error, 0.25)` |
| green | `success` | `lighten(success, 0.25)` |
| yellow | `warning` | `lighten(warning, 0.25)` |
| blue | `accent` | `lighten(accent, 0.25)` |
| magenta | hue **302°**, saturation and lightness from `accent` (floored) | `lighten(magenta, 0.25)` |
| cyan | hue **186°**, saturation and lightness from `accent` (floored) | `lighten(cyan, 0.25)` |
| white | `text` | `lighten(text, 0.25)` |

`secondary` is deliberately unused: see the grey-ramp invariant in decision 5.

**12. Magenta and cyan take a canonical hue, not a rotated accent.** *Correction to an earlier draft, found while writing the implementation plan.* That draft rotated the accent's hue to invent magenta and cyan, justified by the claim that "every preset's accent is blue-ish". **That claim is false.** Carbon's accent is amber (`#d7a95c`) and Monokai's is cyan (`#66d9ef`). Measured, rotating Carbon's accent produced `#75d75c` for ANSI **magenta** — a green — and `#d75c6a` for ANSI **cyan** — a red. A TUI that colors a label cyan and gets red is worse than one that ignores the theme entirely.

So the hue is pinned to the slot's canonical position (302° for magenta, 186° for cyan) and only saturation and lightness come from the accent, which is what keeps them tonally in-family with the theme while remaining recognisably magenta and cyan. Both are floored — saturation at 55%, lightness clamped to [58%, 72%] — because a desaturated accent would otherwise yield a grey "magenta" and a dark one an illegible slot. `themes.ts` is currently dependency-free with hand-rolled hex helpers; HSL manipulation needs `colord`, already a project dependency used at `termutil.ts:9`.

### 4.2 `deriveTermTheme(palette, overrides) → ITheme`

Returns an xterm `ITheme` directly rather than the generated `TermThemeType`, since the wconfig shape carries fields xterm does not use (`gray`, `cmdtext`, `display:*`) and lacks `cursorAccent`.

| xterm field | Source |
|---|---|
| `background` | `bg` — opaque, per decision 4 |
| `foreground` | `text` |
| `cursor` | `accent` |
| `cursorAccent` | `bg` |
| `selectionBackground` | `surfaceSelected` |
| 16 ANSI slots | `deriveAnsi(palette)` |

Both live in `themes.ts` beside `buildThemeVars`, because all three are the same kind of thing: a pure mapping from one palette to one output. `computeTheme` (`termutil.ts:33`) becomes a thin adapter over `deriveTermTheme` and loses its `fullConfig` / `themeName` / `transparency` parameters.

### 4.3 Wiring

The theme reaches xterm by two paths today and both must move:

- **At construction** — `term.tsx:301` passes `theme: termTheme` into the `TermWrap` options.
- **On change** — `TermThemeUpdater` (`termtheme.ts:17-28`) assigns `terminal.options.theme` in an effect. Its inputs become `themePresetAtom` + `themeOverridesAtom` from `themestore.ts` in place of `atoms.fullConfigAtom` + `model.termThemeNameAtom` + `model.termTransparencyAtom`. The effect body is unchanged, so switching presets re-skins the live TUI with no remount.

**Import direction.** `view/term/termtheme.ts` → `view/agents/themestore.ts` → `view/agents/themes.ts`. `themestore.ts` imports only jotai, react and `themes.ts`; `themes.ts` imports nothing. So this introduces no cycle — worth stating given the documented `agents → focus-pane → blockregistry → agents` hazard that `agentsurface.tsx:8-12` exists to break. The theme engine living under `view/agents` despite being app-wide chrome is a pre-existing oddity; relocating it is out of scope.

**Belt and braces.** `.xterm .xterm-viewport`'s `background-color: #000` is overridden to `transparent` in `cockpit.scss` so no black gap can flash during a resize before xterm repaints.

## 5. Keyboard: the leader gets a second door

### 5.1 Four edits

1. **`matcher.ts`** — a `LEADER_ALIASES` constant (`{"Ctrl:g": "g"}`) consulted at the leader-entry step, against the map directly rather than against filtered `sequences` (decision 6).
2. **`matcher.ts`** — the leader-continuation branch tries `sequences`, then `singles`, then resets (decision 8).
3. **`bindings.ts:48`** — `navigate` becomes `(ctx) => (!ctx.editable || ctx.leader != null) && !ctx.modalOpen` (decision 7). `agentNav` (`:474`) inherits it.
4. **`bindings.ts`** — two new bindings: a documentation-only `leader:enter` on the alias chord, and `agent:fullscreen-chord` on `F11` guarded to the Agent surface only, matching how `close-agent` (`:158-185`) stays live while the terminal is focused.

Plus one entry in `GLOBAL_HINTS` (`footerhints.ts:19-25`) referencing `leader:enter`, and one in `SURFACE_HINTS.agent` referencing the `F11` binding.

### 5.2 Resulting contract inside the TUI

```
typing a prompt        d o c s          -> all four reach the agent, unchanged

Ctrl+G                                  -> which-key bar (footer swaps to continuations)
        a c h r s f m u b ,              -> surface teleports  (f = Files, per decision 9)
        d                                -> details rail
        j / k  or  arrow left / right    -> switch agent
        [ / ]                            -> cycle surfaces
        ?                                -> cheat sheet
        Escape                           -> cancel the leader
        (expires on CHORD_TIMEOUT)

always live, no leader:
  Ctrl+1..9  surfaces      Ctrl+P  palette        Ctrl+N   new agent
  Ctrl+Tab   cycle agents  Ctrl+C x2  close       F11      fullscreen
  Shift+Esc  hand focus back to the nav (then every bare key works as at rest)
```

Not one keystroke that reaches the agent today stops reaching it: the leader is entered only by a modifier chord the user pressed deliberately, and while it is active the dispatcher consumes the continuation so nothing leaks to the PTY.

### 5.3 Two chords needed a live collision check — both verified, both kept

Neither could be settled from this repo, and both are the failure mode `ccc90133` already recorded once (an unclaimed `Ctrl+P` reaching WebView2, which answered with a print dialog):

- **`Ctrl+G`** — `abort` in readline. Whether Claude Code's Ink-based input or the Codex TUI consumes it was unknown. Fallback `Alt+G` was named.
- **`F11`** — plausibly a WebView2 fullscreen default. The dispatcher's `preventDefault()` + `stopImmediatePropagation()` (`dispatcher.ts:102-105`) is what suppressed the print dialog and should suppress this too, but it had to be observed rather than assumed.

**Observed 2026-08-06 against the dev app over CDP, terminal focused (`document.activeElement` = `.xterm-helper-textarea`, so `editable` was true):**

| Chord | Result |
|---|---|
| `Ctrl+G` | Opens the which-key bar. Consumed by the dispatcher at window capture — it raises no event past the dispatcher and so cannot reach xterm's textarea handler or the PTY. **Kept; `Alt+G` fallback not needed.** |
| `F11` | Toggles terminal fullscreen and is consumed. No WebView2 default fired: `document.fullscreenElement` stayed `false` and the viewport stayed 1600×950 across the press. **Kept.** |

Two controls make those results non-vacuous rather than a silent no-op: an unclaimed `x` *was* observed reaching the terminal, and a bare `g` still reached the agent while opening no leader. A screenshot of the focused PowerShell session after the full probe sequence shows only the `x`/`g` control characters at the prompt — no `^G`, `]`, `c` or `F11` artifact.

How consumption is observed, since two more obvious probes do not work: a listener on the xterm textarea is useless (xterm's own handler is registered there first and stops immediate propagation, so a claimed key and an unclaimed one look identical), and a terminal-buffer diff is vacuous whenever the shell is idle — it reads "no leak" for every key, including one that leaked. What does work is a *sibling window-capture* listener registered after the dispatcher's: it fires only for keys the dispatcher did not claim. That ordering is guaranteed by reloading the page first, because a hot reload of a keybinding file re-registers the dispatcher behind the probe.

Recorded as scenarios `tui-leader` and `tui-fullscreen` in `scripts/cdp/scenarios.mjs`.

## 6. Testing

**Unit — palette (`themes.test.ts`)**

- every preset derives sixteen parseable hex colors, no `undefined` slot;
- each derived color clears its own slot's contrast baseline, where the baseline is `default-dark`'s ratio against Midnight's background, computed once and recorded (decision 5);
- `deriveTermTheme` returns an opaque `background` — the specific regression that produced the black seam;
- Midnight's derived set is pinned as a golden, so editing a palette role cannot silently change the terminal;
- a `themeOverridesAtom` accent override propagates into ANSI blue, proving the terminal inherits custom colors.

**Unit — keyboard (`matcher.test.ts`)**

- the alias enters leader mode while `editable: true` (the case that is impossible today);
- a continuation matching a sequence runs it;
- a continuation matching no sequence falls back to a single;
- `f` under the leader resolves to the Files sequence, not the fullscreen single (decision 9, asserted so a future reordering cannot silently flip it);
- `Escape` under the leader resets and does **not** run `agent:back` or `subagent:back` (decision 8) — the case where the singles fallback and the cancel gesture compete;
- a modifier during leader mode still cancels-and-reprocesses;
- an unmatched continuation resets;
- `bindings.test.ts` — `assertNoConflicts` still passes with the loosened guard; both new binding ids exist; `footerhints.test.ts` covers the new chips through its existing id-existence assertion.

**Integration — CDP scenarios (`scripts/cdp/scenarios.mjs`)**

- *terminal-theme*: Agent surface with a live TUI, screenshot under two presets; assert the sampled background pixel equals each theme's `--color-background` and differs between them. This is the assertion the contrast test cannot make.
- *tui-leader*: focus the TUI, send the alias chord, assert the footer shows the continuation bar; send `d`, assert the rail opened **and** that no character reached the terminal. The leak is the failure mode that matters — a passing rail toggle with a stray `d` in the agent's prompt is a failure, not a pass.
- *tui-fullscreen*: with the TUI focused, `F11` toggles fullscreen and no WebView2 default fires.

Note that `jarvis-ask` already fails 0/2 for an unrelated stale chord (it still sends `Ctrl+P` after `1b577a4a` moved the palette); do not read that as a regression from this work.

## 7. Files and scope

**Frontend, palette**

| File | Change |
|---|---|
| `frontend/app/view/agents/themes.ts` | add `deriveAnsi`, `deriveTermTheme`, `AnsiPalette`; `buildThemeVars` emits `--ansi-*` |
| `frontend/app/view/term/termutil.ts` | `computeTheme` becomes an adapter over `deriveTermTheme`; loses `fullConfig`/`themeName`/`transparency` |
| `frontend/app/view/term/termtheme.ts` | `TermThemeUpdater` reads the cockpit theme atoms |
| `frontend/app/view/term/term-model.ts` | delete `termThemeNameAtom`, `termTransparencyAtom`, `blockBg`; drop the theme submenu and the "Magnify block" item |
| `frontend/app/view/term/term.tsx` | construction-time `theme` from the new source |
| `frontend/app/view/agents/settingssurface.tsx` | drop the Color scheme and Transparency rows from `TerminalSection`, plus the now-dead `TermThemeDropdown`, `TermThemeOption`, `DEFAULT_TERM_THEME` and the `coerceTransparency` import (decision 11) |
| `frontend/app/cockpit/cockpit.scss` | neutralize `.xterm-viewport`'s black background |
| `frontend/tailwindsetup.css` | `--ansi-*` documented as the un-themed fallback |

**Frontend, keyboard**

| File | Change |
|---|---|
| `frontend/app/store/keybindings/matcher.ts` | `LEADER_ALIASES`; singles fallback in the leader branch |
| `frontend/app/store/keybindings/bindings.ts` | loosen `navigate`; add `leader:enter` and the `F11` fullscreen binding |
| `frontend/app/cockpit/footerhints.ts` | chips for both new bindings |

No Go, no Rust, no `task generate`, no migration. Appearance and keybindings are pure-frontend concerns, consistent with `themestore.ts:5-6` ("Pure-frontend appearance -> no wconfig / no task generate").

The two halves share no file and can ship independently, in either order — the palette work touches only `view/term` plus `themes.ts`, the keyboard work only `store/keybindings` plus `footerhints.ts`. The plan should sequence them as two slices so a live collision on `Ctrl+G` or `F11` (§5.3) cannot hold up the color fix.

## Risks

- **Derived ANSI red or green may read badly behind Claude Code's diff backgrounds.** The contrast baseline catches "less legible than today" but cannot judge a saturated `error` used as a *background* by the TUI. The *terminal-theme* CDP scenario must screenshot a real diff, not an idle prompt. **Still open:** the scenario's shots were taken against a live PowerShell session, because the dev app had no Claude Code agent running at verification time. The derived palette is confirmed applied and legible there; a real diff has not been judged.
- ~~**Both new chords may be claimed by something outside this repo**~~ — resolved 2026-08-06. Both verified consumed before reaching the PTY; see §5.3 for the measurements. `Alt+G` was not needed.
- **Loosening `navigate` widens the set of contexts in which surface keys can fire.** Reachable only by deliberately entering leader mode, cancellable by `Escape` and self-cancelling on `CHORD_TIMEOUT`. The exposure is one keystroke.
- **Deleting `term:transparency` changes behavior for anyone who set it.** Single-user fork, cockpit-only frontend, and the setting's visible effect today is a translucent terminal over nothing.
- **`assertNoConflicts` may surface a collision the manual audit in decision 9 missed.** It runs over the whole registry, so a miss fails the build rather than shipping — the audit is a design aid, the test is the authority.

## Out of scope

- **Relocating the theme engine** out of `frontend/app/view/agents/`. It is app-wide chrome sitting in a surface folder; tempting, unrelated.
- **Removing `termthemes.json` and `TermThemeType`** from the Go config (decision 11).
- **The other surfaces' inline `editable` guards** (decision 10).
- **Light mode.** Permanently off the table; `deriveAnsi` is authored against dark backgrounds only, and `ThemeDef.dark` (`themes.ts:40`) already encodes that assumption.
- **Everything else found in the Agent-tab audit that produced this spec**, each its own piece of work: a permission prompt renders as "busy" (`wsh agent-hook` emits `AgentState_Waiting` for the `Notification` event at `wshcmd-agenthook.go:49`, and `agentsviewmodel.ts:453` folds `waiting` into `working`); there is no way to answer a permission prompt from the cockpit, though `pkg/agentask/encode.go` proves the keystroke-injection path; nothing enumerates the agent's slash commands; the todo list already extracted by `transcriptprojection.extractTasks:280-296` is absent from the Focus rail; and Codex has no live status at all, its only seam being the single `notify` program slot in `~/.codex/config.toml`.
