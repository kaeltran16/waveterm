# Usage surface motion — design

Part of the app-wide animation revamp (`docs/superpowers/animation-revamp-tracker.md`).
Feel = Fluid / calm. Reuse the shipped moment vocabulary; add nothing new except one
CSS custom property the donut sweep requires.

## Goal

Make the Usage surface's value changes legible through motion, without decorative
animation. Every candidate must pass the rejection test: *does it make a state change
more legible?* Usage is the most data-viz-dense surface, so this discipline is the
whole point — bars and rings move only when their underlying number moves.

## The legible state changes

The surface (`frontend/app/view/agents/usagesurface.tsx`) recomputes its marks on three
triggers, plus one truly live value:

- **Toggle recompute** — `7 days ↔ All time` and `Tokens ↔ Spend` re-derive every bar.
  Tweening old→new magnitude shows the shift instead of a hard cut. Strongest case.
- **60s refresh** — `loadUsage` refreshes the window; values change under the user.
- **Live quota climb** — the 5-hour / weekly donut rings rise as a Claude agent runs.
  This is the only value on the surface that changes on its own; a ring that sweeps up
  makes the climb legible.

## Moment mapping (reuse only)

| Element | State change | Moment | Tool |
|---|---|---|---|
| Split bars ×2, per-model bars | recompute on window toggle + refresh | m7 value transition | CSS `width` |
| Daily-chart bars | recompute on metric toggle + refresh | m7 value transition | CSS `height` |
| Live donut rings (5h / weekly) | live quota climb + refresh | m7 value transition | `@property --usage-arc` sweep |
| Live-limit card | first quota reading appears (`donuts` 0→N) | m1 entrance | Framer `cardVariants` |
| Historical section | history first arrives (`hasHistory` false→true) | m1 one-shot load reveal | Framer, latched |

Existing `pulseDot` on the Live-limits indicator stays as-is (m7 status pulse).

### Explicitly rejected as decorative

- **StatCard number count-up** — on first load there is no prior state to make legible;
  it is motion for its own sake. Numbers update instantly.
- **Per-card entrance cascade on mount** — violates the no-cascade north star. The view
  mounts populated; only the single Historical container reveal (one element) is allowed,
  and only on first data arrival, not on every tab switch.

## Techniques

### Bars — the Files precedent, verbatim

Files Review already animates its progress bar with a plain CSS transition on the
inline-styled fill div (`reviewsurface.tsx:99`):

```
style={{ width: `${pct}%`, transition: `width ${MOTION.durMacro}s ${easeFluidCss}` }}
```

Reuse this for the split bars (`SplitBar`), per-model bars (`ModelGroup`), and the
daily-chart bars (`DailyChart`, transitioning `height`). No markup change beyond adding
the transition to divs that already carry an inline `width`/`height`. `MOTION.durMacro`
and `easeFluidCss` come from `motiontokens.ts` — the single value source, unchanged.

Note on the daily chart: a `7d↔all` window toggle swaps the *set* of day-bars (7 vs 30),
so those bars mount fresh rather than tweening — that is correct (elements are replaced,
not re-valued). The height tween applies on the `tokens↔spend` metric toggle and on
refresh, where the same bars change value.

### Donut — `@property` arc sweep

The rings are `conic-gradient`, whose gradient stops are not CSS-transitionable. Keep the
existing MiniDonut markup and inner-circle mask; make the sweep animatable by routing the
percentage through a registered custom property.

`frontend/tailwindsetup.css` (the CSS-motion home per the foundation table):

```css
@property --usage-arc {
    syntax: "<percentage>";
    inherits: false;
    initial-value: 0%;
}
```

MiniDonut:
- `conic-gradient(<ringcolor> 0 var(--usage-arc), var(--color-edge-strong) 0)`
- `style={{ "--usage-arc": pct + "%", transition: `--usage-arc ${MOTION.durMacro}s ${easeFluidCss}` }}`

WebView2 is Chromium/Edge, so `@property` is supported. The ring **color** (ok / warn /
hot via `usageLevel`) stays an instant switch at thresholds — only the arc angle sweeps.
The donut visual identity is unchanged; only the transition is added.

This registered property is the one and only addition to the shared foundation, per the
north star rule "add the primitive to the token/CSS module first, then use it."

### Historical load reveal — one-shot, edge-latched in the parent

Wrap the Historical block (the `hasHistory` true branch) in a single `motion.div` that
plays the `cardVariants` opacity+scale signature **once**, when history first arrives. One
container, never a per-card stagger.

The latch must live in `UsageSurface` (the parent), **not** in the wrapper. The wrapper
only exists inside the true-branch, so it is *born* with `hasHistory === true` and can
never observe the false→true edge itself. `UsageSurface`, by contrast, is mounted across
the transition. It runs an edge detector `useDidBecomeTrue(hasHistory)` — component-local
`useRef`, no timer, no module state — that returns `true` from the moment it observes a
false→true flip and passes that as the wrapper's `initial` selector
(`becameTrue ? "initial" : false`, `animate="animate"`).

Why this does **not** replay on tab switches, without any persistent "seen" flag:
`usageStatsAtom` is cached in jotai and survives unmount. So on first-ever load,
`UsageSurface` mounts with `hasHistory === false`, data arrives async, the flip is
observed → reveal plays. On re-entering the tab, the atom is already populated, so
`UsageSurface` remounts *born* with `hasHistory === true`; its ref initializes to `true`,
no edge is observed → reveal is suppressed. The behavior falls out of the data already
being loaded — exactly the "load reveal, not surface entrance" intent.

## Reduced motion

The codebase has no global `prefers-reduced-motion` rule; it honors reduced motion
per-primitive. Files' inline `width` transition has no guard — this design closes that gap
rather than copying it.

- `<MotionConfig reducedMotion="user">` at the `UsageSurface` root → the Framer load
  reveal and live-card entrance honor reduced motion for free (matches the Agent / Files
  surface roots).
- Inline CSS transitions (bars + `--usage-arc`) are gated with Framer's
  `useReducedMotion()`: when it returns true, the transition string is omitted so values
  snap instantly. This keeps `motiontokens` as the single value source **and** honors
  reduced motion — which an inline-shorthand-only approach cannot, since inline styles
  outrank a `motion-reduce:` utility class.

## Components / files touched

- **`frontend/app/view/agents/usagesurface.tsx`** — add bar transitions (gated), the
  donut `--usage-arc` var + transition, the Historical `motion.div` reveal wrapper, the
  live-card `cardVariants` entrance, and the root `<MotionConfig>`. Import `MOTION`,
  `easeFluidCss`, `cardVariants` from `motiontokens`; `motion`, `MotionConfig`,
  `useReducedMotion` from `motion/react`.
- **`frontend/tailwindsetup.css`** — the `@property --usage-arc` registration.
- **`frontend/app/element/motionhooks.ts`** — a `useDidBecomeTrue(flag)` edge-latch hook
  (sibling to `useSettle`) driving the load reveal: returns `true` from the render where
  `flag` is first observed to go false→true, `false` while mounted already-true.

No new `usagemotion.ts` module. Channels/Files/Sessions each needed one for a
list-cascade keying problem (`computeEntrances` / reflow props); Usage has no
id-keyed arrival list, so there is nothing to key. The only stateful helper is the
one-shot latch, which belongs next to `useSettle` (YAGNI — do not create a module for it).

## Testing

No jsdom/render harness exists for the cockpit.

- **Unit test the one-shot latch hook** (mirror `useSettle`'s test if a new hook is
  added): fires once on false→true, does not fire when mounted already-true, resets after
  the one render.
- **Token values** are already guarded by `motiontokens.test.ts`; no change there.
- **Visual verification** on the live dev app via `scripts/cdp-shot.mjs`: toggle
  `7d↔all` and `tokens↔spend` and confirm bars tween; inject a live agent
  (`scripts/inject-live-agents.mjs`) to confirm the donut ring sweeps and the live card
  enters; toggle OS reduced-motion and confirm everything snaps.

## Out of scope

- Cross-surface tab transition into/out of Usage (tracked separately).
- Any change to the usage data pipeline (`usagestore` / `ratelimitstore`) or the
  statusline usage bridge — this is presentation motion only.
- Codex live quota (not wired through the live roster yet; unchanged).
