# Cockpit Coherence Audit

> Generated per `docs/superpowers/specs/2026-07-16-cockpit-coherence-audit-design.md`.
> Read-only conformance audit of the navigable cockpit surfaces on five coherence dimensions.
> Every score cites `file:line` evidence. `N/A` = the dimension does not structurally apply to the
> surface (never a synonym for `Diverges`). Rubric: conformance ∈ {Conforms, Partial, Diverges, N/A};
> severity ∈ {High, Med, Low}; effort ∈ {S, M, L}.

## 1. Canon per dimension

The reference each column is scored against. Canon = the existing shared thing; conformance = adoption
of it. Where no shared reference exists, the gap is recorded, not invented.

### Interaction / keyboard — canon: `usecockpitkeyboard.ts`

The cockpit's local keyboard contract (`frontend/app/view/agents/usecockpitkeyboard.ts:58-152`):

- **Typing-guard** (`:59-61`): keys are ignored while an `INPUT`/`TEXTAREA`/`contentEditable` is focused.
- **Cursor nav** (`:83-88`): `j`/`ArrowDown` down, `k`/`ArrowUp` up, over a `navigableIds` list.
- **Surface switch** (`:64-81`): `]` next / `[` previous, in a fixed rail order.
- **Open / submit** (`:109-116`): `Enter` submits an answerable ask, else opens focus.
- **Dismiss** (`:133-137`): `Escape` closes the open overlay (help).
- **Which-key help** (`:138-140`): `?` toggles the help overlay (`cockpithelp.tsx`).
- **Action letters** (`:117-132`): `r` reply, `t` terminal, `b` background; `n` next-ask (`:98-108`);
  `1-9` answer selection (`:141-151`).

The alternative home for a shared contract is the global keybinding registry
(`frontend/app/store/keymodel.ts`). This audit records each surface's *mechanism* (local hook vs global
registry vs none); it does not decide where a unified contract should ultimately live.

### Chrome / tokens — canon: `surfacescaffold.tsx`

`frontend/app/view/agents/surfacescaffold.tsx`:

- **Root container** `SURFACE_ROOT` (`:15`): `flex h-full min-h-0 flex-col bg-background` — each surface
  sets its own `bg-background`.
- **Header** `SurfaceHeader` (`:17-47`): title `text-[25px] font-bold tracking-[-0.02em] text-primary`
  (`:39`), container `flex flex-none items-start justify-between gap-5 bg-background px-[28px] pb-4 pt-5`
  (`:33`), `border-b border-border` default on, subtitle `text-[13px] text-secondary` (`:42`).
- **Text scale**: `primary` (titles) / `secondary` (body) / `muted` (de-emphasized). The minority scale
  `ink-hi`/`ink-mid`/`ink-faint` is residue to be flagged and counted per surface subtree.

### State coverage — canon: `Skeleton` gate / `SurfaceEmptyState` / `SurfaceError`

- **Loading**: `Skeleton`/`SkeletonLine` (`frontend/app/element/skeleton.tsx:6-16`) gated by a
  `*LoadedAtom` (reference impls: usage, files, memory).
- **Empty**: `SurfaceEmptyState` (`surfacescaffold.tsx:49-98`).
- **Error**: `SurfaceError` (`surfacescaffold.tsx:100-115`); usage's `usageErrorAtom` is the reference
  wiring. Silent-failure patterns (`.catch(() => {})`, empty render on error) are flagged.
- Score each state **only where it applies**: a surface with no async load is `N/A` for loading/error.

### Motion — canon: `motiontokens.ts`

`frontend/app/element/motiontokens.ts` is the single source of motion:

- **Tokens** `MOTION` (`:9-14`): `durMacro 0.36` / `durMicro 0.14` / `durExit 0.28` / `easeFluid`.
- **Entrance/exit** `cardVariants` (`:18-22`, opacity+scale only, never x/y); `modalBackdrop`/`modalPanel`
  (`:26-33`); `composerReveal` (`:45-49`); `popoverReveal` (`:54-58`).
- **List reflow** helpers: `computeEntrances` (`:83-100`, no-cascade entrance), `reflowProps` (`:112-121`,
  chip-driven reflow), `shouldFadeEntry` (`:63-65`). Conformance = entrance/list motion via these vs
  bespoke `motion` config vs none-where-expected.

### Primitive reuse — canon: shared row / badge / section-header / status-dot primitives

Shared primitives that exist: `SectionHeader` (`frontend/app/view/agents/sectionheader.tsx:9-46`),
`StatusDot` (`frontend/app/view/agents/statusdot.tsx:14-37`), the agent list row (`agentrow.tsx`), and
the scaffold chrome. Score by *degree* of reuse (`Conforms` = shares them; `Partial`/`Diverges` =
reimplements some/most); enumerate each concrete duplication instance in the backlog.

## 2. Conformance grid

Legend: **Conf** = Conforms · **Part** = Partial · **Div** = Diverges · **N/A** = does not apply.

| Surface | Interaction | Chrome/tokens | State | Motion | Primitive reuse |
|---|---|---|---|---|---|
| cockpit | Conf | Part | Part | Conf | Part |
| agent | Part | Conf | Div | Part | Div |
| channels | Div | Part | Part | Div | Part |
| sessions | Div | Part | Div | Div | Div |
| files | Part | Div | Part | Conf | Div |
| memory | Div | Div | Part | Conf | Part |
| usage | Part | Part | Conf | Conf | Div |
| radar | Div | Conf | Part | Div | Part |
| settings | Part | Conf | Part | Part | Part |
| placeholder | N/A | Conf | Conf | Conf | Conf |

**Per-dimension tally** (worst first):
- **Interaction/keyboard** — 1 Conf, 4 Part, 4 Div. *Weakest dimension.* Only the cockpit (the canon's home) fully works; the contract does not leave it.
- **Primitive reuse** — 1 Conf, 5 Part, 4 Div. Divergent `StatusDot`/`SectionHeader`/composer/empty-state reimplementations everywhere.
- **State coverage** — 2 Conf, 6 Part, 2 Div. Loading/empty mostly OK; *error* is near-universally silent (only usage handles it).
- **Chrome/tokens** — 4 Conf, 4 Part, 2 Div. Headers largely migrated; the `ink-*` residue is the remaining gap.
- **Motion** — 5 Conf, 2 Part, 3 Div. Best-covered; the misses are named-consumer surfaces that never adopted `motiontokens`.

## 3. Findings backlog

Deduped across surfaces (one entry per root divergence, naming all affected surfaces), priority-sorted
(High + low-effort first). `Sev` = severity, `Eff` = effort.

| # | Dimension | Sev | Eff | Surfaces | Root divergence & fix | Evidence |
|---|---|---|---|---|---|---|
| **F1** | Interaction | **High** | M | channels, sessions, memory, files, usage | The `j/k` cursor-nav + `[`/`]` surface-switch live only in `useCockpitKeyboard`, mounted only in CockpitSurface — so on every other surface the contract is dead. Fix: lift surface-switch to a shell-level listener; add a shared list-cursor hook (mirroring `moveCursor`/typing-guard) each list surface adopts, and give usage's Segmented toggles a keyboard affordance. (Radar's switch-order gap is F2.) | `cockpitshell.tsx:66-88`; `cockpitsurface.tsx:293-297,358-361`; `channelssurface.tsx:269`; `sessionssurface.tsx`; `memorysurface.tsx:156-164`; `filessurface.tsx:174-198`; `usagesurface.tsx:82-107` |
| **F2** | Interaction | **High** | S | radar | Radar is omitted from `surfaceOrder`, so `[`/`]` cannot even reach it (independent of F1). One-line add. | `usecockpitkeyboard.ts:66-74` vs `agents.tsx:37-46` |
| **F3** | Chrome/tokens | **High** | M | memory(38), files(27), review(18), runcompletion(10), channels(9), cockpit/pendingband(7), sessions(2), usage(2) | ~130 `ink-hi`/`ink-mid`/`ink-faint` uses of the minority scale remain. Fix: mechanical swap `ink-hi`→`primary`, `ink-mid`→`secondary`, `ink-faint`→`muted`. Low-risk, high-volume. (review renders inside Files' review-mode; runcompletion inside Channels' RunBody — their residue is charged to those surfaces, not Radar.) | `filessurface.tsx:79,…`; `memorysurface.tsx:146,…`; `reviewsurface.tsx:59,74,103`; `runcompletionsurface.tsx:69,…`; `channelrail.tsx:216,…` |
| **F4** | Primitive reuse | Med | S | files, channels | `StatusDot` reimplemented as a local `STATE_DOT` map with a **different "working" color** (`success` vs canon `accent`) — a visible same-state/different-color inconsistency. Fix: use shared `StatusDot` (extend `AgentState` with `gone`). | `filessurface.tsx:31,75,105`; `channelsprimitives.tsx:24-29,156-159` vs `statusdot.tsx:8-12` |
| **F5** | State (error) | Med | S | files, channels, sessions, memory, radar, agent, settings | Load/scan failures are swallowed to console or coerced to empty — indistinguishable from genuinely-empty. Fix: per-surface `*ErrorAtom` + `SurfaceError` (usage's `usageErrorAtom` is the reference). | `filesstore.ts:63-67`; `channelsstore.ts:42-48`; `sessionsarchivestore.ts:31-33`; `memstore.ts:77-81`; `radarstore.ts:71-74`; `recentsessionsstore.ts:18-31` |
| **F6** | State (loading) | Med | S | channels, sessions, review, settings/profilepanel, agent | Bare inline "Loading…" text instead of the `Skeleton` + `*LoadedAtom` gate. Fix: adopt the Skeleton gate. | `channelssurface.tsx:405-408`; `sessionssurface.tsx:363`; `reviewsurface.tsx:59`; `profilepanel.tsx:502` |
| **F7** | Interaction | Med | M | agent (subagentinterior), review | Ad-hoc `window.addEventListener("keydown")` — a **third** keyboard mechanism (beyond the cockpit hook and the `keymodel.ts` registry) that bypasses the typing-guard. Fix: migrate into the shared registry gated by `ctx.editable`. Resolves the spec's "where does the contract live" question toward the registry. | `subagentinterior.tsx:24-32`; `reviewsurface.tsx:42-57` |
| **F8** | Motion | Med | S/M | channels, sessions, radar, agent, settings/profilepanel | No `motiontokens` adoption on surfaces the token file explicitly names as intended consumers; list-reflow/dropdown/mount transitions snap. Fix: wire `cardVariants`/`popoverReveal`/`reflowProps`/`computeEntrances`. | `channelcomposers.tsx:119-142`; `sessionssurface.tsx`; `radarfindingslist.tsx:44-50`; `agentsurface.tsx:105`; `profilepanel.tsx:496-526` |
| **F9** | Primitive reuse | Med | S/M | sessions(x3), memory, radar, channels, usage | `SectionHeader` reimplemented inline (label+count+divider). Fix: make its dot/pill props optional and consume it. | `sessionssurface.tsx:151-157,…`; `memorysurface.tsx:145-151`; `radarfindingslist.tsx:63-82`; `channelchrome.tsx:99-120` vs `sectionheader.tsx:9-46` |
| **F10** | Primitive reuse | Med | M | agent | `AgentComposer` reimplements the textarea+grow+send frame `ComposerShell` already owns. Fix: rebuild on `ComposerShell`. | `agentcomposer.tsx:57-84` vs `composer-shell.tsx:78-126` |
| **F11** | State/Primitive | Low-Med | S | cockpit, agent, radar, sessions | Empty states reimplement `SurfaceEmptyState` instead of composing it (cockpit `CockpitEmptyState`, agent `AgentLaunchHero`, radar `RadarScanStatePanel`, sessions bespoke text). Fix: compose `SurfaceEmptyState`. | `cockpitemptystate.tsx:10-77`; `agentlaunchhero.tsx:43-96`; `radarscanstatepanel.tsx:53-105` vs `surfacescaffold.tsx:49-98` |
| **F12** | Primitive reuse / Interaction | Med | S | settings | `TermThemeDropdown` hand-rolls open/dismiss + backdrop instead of the shared `Popover` (which wires floating-ui `useDismiss`: Escape + outside-click) — this is also the surface's Interaction-Partial gap (no Escape-dismiss). Fix: use `Popover`, which resolves both. | `settingssurface.tsx:515-545` vs `popover.tsx:80-82` |
| **F13** | Chrome/tokens | Low | S | cockpit, usage | `SURFACE_ROOT` has **zero call sites** — every surface hand-sets `bg-background` (usage's root omits it); cockpit overrides `SurfaceHeader`'s canonical padding. Fix: adopt `SURFACE_ROOT`; drop the padding override. | `cockpitsurface.tsx:365`; `usagesurface.tsx:503` vs `surfacescaffold.tsx:15,33` |
| **F14** | Structural | Low | S | placeholder | `PlaceholderSurface` is unreachable dead code (`SurfaceKey` is a closed 9-member union; the router covers all 9). Fix: delete, or wire a not-yet-handled key to it. | `cockpitshell.tsx:68-86`; `agents.tsx:25-34` |

## 4. Recommended sequencing

Findings cluster into six passes; a divergence and its fix rarely stand alone. Every High finding is in
Pass A or B. Passes A and B are independent and can run in parallel.

**Pass A — Interaction parity (High).** F1 + F2 + F7. Lift `[`/`]` surface-switch to a shell-level
listener; add one shared list-cursor hook adopted by channels/sessions/memory/radar/files; add radar to
the order; fold the two ad-hoc `window` keydown listeners into the shared registry. This is the headline
pass — it restores the keyboard-first promise on every surface and settles the "one contract, one home"
question. *Effort M–L.*

**Pass B — `ink-*` token deprecation (High, mechanical).** F3. Mechanical swap across ~130 sites
(memory, files, review, runcompletion, channels, pendingband, sessions, usage). Kills the second color
scale; low-risk, parallelizable with A. *Effort M (volume).*

**Pass C — State-coverage completion (Med).** F5 + F6 + F11. Per-surface `*ErrorAtom` + `SurfaceError`
(mirror `usageErrorAtom`) so failures stop masquerading as empty; `Skeleton` gates on the inline-"Loading…"
surfaces; route bespoke empty states through `SurfaceEmptyState`. *Effort M.*

**Pass D — Shared-primitive convergence (Med).** F4 + F9 + F10 + F12. Replace divergent `StatusDot`
maps, inline `SectionHeader`s, `AgentComposer`→`ComposerShell`, `TermThemeDropdown`→`Popover`. Single
source of truth for rows/badges/composers/popovers. *Effort M.*

**Pass E — Motion coverage (Med).** F8. Wire `motiontokens` into channels/sessions/radar/subagent-mount/
profilepanel, per the token file's own stated intent. *Effort M.*

**Pass F — Cleanup (Low).** F13 (`SURFACE_ROOT` adoption + cockpit padding), F14 (delete/wire
`PlaceholderSurface`). Trivial; fold into whichever adjacent pass touches those files. *Effort S.*

**Suggested first move:** Pass A (the headline coherence gap and the app's core promise) with Pass B
running alongside (mechanical, independent). Both are self-contained and each ships a visible coherence
win before the Med passes.

## Appendix: per-surface scorecards

#### cockpit

| Dimension | Score | Note | Evidence |
|---|---|---|---|
| Interaction/keyboard | Conforms | Cockpit *is* the canon — full dispatch (typing-guard, j/k nav, `[`/`]` switch, Enter, Escape, `?`, r/t/b, n, 1-9) wired via the hook | `usecockpitkeyboard.ts:58-152`; wired `cockpitsurface.tsx:293-297,361` |
| Chrome/tokens | Partial | `SurfaceHeader` used but wrapped in a bespoke sticky container with diverging padding (`px-[30px] pb-3 pt-4` vs canon `px-[28px] pb-4 pt-5`); root is bespoke flex-row, not `SURFACE_ROOT` (which has zero call sites anywhere) | `cockpitsurface.tsx:50,365,367-405` vs `surfacescaffold.tsx:15,33`; root `cockpitsurface.tsx:358-364` (ink-* count: 7 — all in `pendingband.tsx:28,38,63,67,69,70,83`; cockpit's other files: 0) |
| State coverage | Partial | loading: N/A (synchronous derived atom, no fetch) · empty: Partial (`CockpitEmptyState` reimplements `SurfaceEmptyState` near-verbatim) · error: N/A (no fetch boundary) | `liveagents.ts:76`; empty `cockpitemptystate.tsx:10-77` vs `surfacescaffold.tsx:49-98` |
| Motion | Conforms | Card/section/empty entrances use `cardVariants` (opacity+scale); corner-resize `resizeSpring`; composer `composerReveal` | `cockpitsurface.tsx:8,454`; `agentrow.tsx:9,233-236,325,540`; `cockpitemptystate.tsx:6,14` |
| Primitive reuse | Partial | Shares `SectionHeader` + `StatusDot`, is the source of canonical `AgentRow` — but reimplements the empty state instead of composing shared `SurfaceEmptyState` | `cockpitsurface.tsx:47,311,460-476`; `agentrow.tsx:31,360`; `cockpitemptystate.tsx:10-77` |

**Findings:**
- Chrome/tokens · Med · S · `cockpitsurface.tsx:365` vs `surfacescaffold.tsx:33` · Drop the bespoke sticky-header padding override; let `SurfaceHeader` own canonical `px-[28px] pb-4 pt-5`, reserve the wrapper for the sticky/chip-row bits it actually adds.
- State coverage · Low · S · `cockpitemptystate.tsx:10-77` · Replace hand-rolled empty-state JSX with `SurfaceEmptyState` (pass existing glyph/title/body/action as props) so the two copies can't drift.
- Primitive reuse · Low · S · `cockpitemptystate.tsx:10-77` vs `surfacescaffold.tsx:49-98` · Same fix — compose `SurfaceEmptyState` instead of a parallel duplicate.

#### agent

| Dimension | Score | Note | Evidence |
|---|---|---|---|
| Interaction/keyboard | Partial | Uses the REGISTRY mechanism (not the cockpit hook) with typing-guard via ctx.editable, but SubagentInterior's Escape is a third ungated window listener | `agentsurface.tsx:72-74` (registry via buildAgentBindings/useKeybindings); `keybindings/bindings.ts:138,153-165` (agentNav gate); `subagentinterior.tsx:24-32` (raw window keydown, no editable check) |
| Chrome/tokens | Conforms | Root sets bg-background per convention; 0 ink-*; page header correctly N/A (full-bleed TUI) | `agentsurface.tsx:82` (ink-* count: 0 across all 7 files) |
| State coverage | Diverges | loading: recent-sessions fetch no Skeleton gate · empty: agentlaunchhero fully bespoke, never SurfaceEmptyState · error: session-scan failure coerced to [] (silent-failure pattern) | `agentlaunchhero.tsx:43-96`; `recentsessionsstore.ts:18-31` (catch→[]) |
| Motion | Partial | Narration entries use MOTION/composerReveal/shouldFadeEntry (textbook), but the SubagentInterior mount/unmount over the terminal has no motion | `narrationtimeline.tsx:9,481-483,213`; `agentsurface.tsx:105` (bare conditional mount) |
| Primitive reuse | Diverges | AgentComposer reimplements ComposerShell's textarea+grow+send frame; AgentLaunchHero reimplements SurfaceEmptyState's role | `agentcomposer.tsx:57-84` vs `composer-shell.tsx:78-126`; `agentlaunchhero.tsx:43-96` vs `surfacescaffold.tsx:49-98` |

**Findings:**
- Interaction/keyboard · Med · S · `subagentinterior.tsx:24-32` · Register the subagent-interior Escape as a registry binding (gated by agentNav/ctx.editable) instead of a bare window listener, so it respects the typing-guard and lives in one mechanism.
- State coverage · Med · M · `agentlaunchhero.tsx:43-96` + `recentsessionsstore.ts:26-27` · Gate recent-sessions with Skeleton while null, surface failure via SurfaceError instead of coercing to [], rebuild hero on SurfaceEmptyState.
- Motion · Low · S · `agentsurface.tsx:105` · Wrap the SubagentInterior conditional mount in AnimatePresence with cardVariants/composerReveal.
- Primitive reuse · Med · M · `agentcomposer.tsx:57-84` + `agentlaunchhero.tsx:43-96` · Rebuild AgentComposer on ComposerShell and AgentLaunchHero on SurfaceEmptyState.

#### channels

| Dimension | Score | Note | Evidence |
|---|---|---|---|
| Interaction/keyboard | Diverges | Cockpit contract wired only inside CockpitSurface; Channels has zero access — not even surface-switch works here | `usecockpitkeyboard.ts:35-153` wired only `cockpitsurface.tsx:293,361`; `channelssurface.tsx:269` root has no onKeyDown; channelrail onKeyDowns are input-scoped rename/create (`:166,363`) |
| Chrome/tokens | Partial | Per-channel `ChannelHeader` hand-rolls its scale/spacing (title `text-[15px]`, `px-6 py-3`) instead of SurfaceHeader; lingering ink-mid | `channelchrome.tsx:15-83,27,30` vs `surfacescaffold.tsx:33,39` (ink-* count: 9 — channelrail x5, channelcomposers x2, channelchrome x1, channelsprimitives x1) |
| State coverage | Partial | loading: inline "Loading…" not Skeleton gate · empty: correctly reuses SurfaceEmptyState · error: swallowed to console + masqueraded as empty list, no SurfaceError | loading `channelssurface.tsx:405-408`; empty `:409-420`; error `channelsstore.ts:42-48` |
| Motion | Diverges | No motiontokens primitive used anywhere despite being a named intended consumer; dropdown + list-reflow render plain | only MotionConfig imported (`channelssurface.tsx:13,268`); autocomplete `channelcomposers.tsx:119-142` + run-tab list `channelchrome.tsx:184-225` have no variants; `motiontokens.ts:70-71` unused |
| Primitive reuse | Partial | AskRow reuses shared AnswerBar, but WorkerRow reimplements a status-dot (diff "working" color) and OverviewStrip hand-rolls a section-header | reuse `channelsprimitives.tsx:98-122`; dup `channelsprimitives.tsx:24-29,156-159` (STATE_DOT working=success) vs `statusdot.tsx:9`; `channelchrome.tsx:99-120` vs `sectionheader.tsx:9-46` |

**Findings:**
- Interaction/keyboard · High · M · `channelssurface.tsx:269` + `cockpitsurface.tsx:293,361` · Lift the `[`/`]` surface-switch dispatch out of useCockpitKeyboard into CockpitShell (top-level listener) so it fires regardless of active surface; add local j/k list-cursor to ChannelRail/RunStrip.
- Chrome/tokens · Med · S · `channelchrome.tsx:27,30` vs `surfacescaffold.tsx:33,39` · Route ChannelHeader through SurfaceHeader slots, or replace the 9 ink-mid with muted/secondary.
- State coverage · Med · S · `channelssurface.tsx:405-408` + `channelsstore.ts:42-48` · Gate initial load behind Skeleton; add channelsErrorAtom → SurfaceError instead of faking empty on failure.
- Motion · Med · M · `channelcomposers.tsx:119-142` + `channelchrome.tsx:184-225` · Wire popoverReveal for autocomplete + computeEntrances/reflowProps for the run-tab strip, per motiontokens' stated intent.
- Primitive reuse · Med · S · `channelsprimitives.tsx:24-29,156-159` vs `statusdot.tsx:9` · Replace local STATE_DOT with StatusDot (extend AgentState with `gone`); rebuild OverviewStrip on SectionHeader.

#### sessions

| Dimension | Score | Note | Evidence |
|---|---|---|---|
| Interaction/keyboard | Diverges | Separate render branch from CockpitSurface (the only useCockpitKeyboard mount) — j/k, [/], ?, Esc do nothing; mouse-only onClick | `cockpitshell.tsx:66-88`; `cockpitsurface.tsx:293-297,358-361`; `sessionssurface.tsx` (zero onKeyDown/tabIndex); `usecockpitkeyboard.ts:66-74` (surfaceOrder names sessions but nothing consumes it) |
| Chrome/tokens | Partial | SurfaceHeader adopted; scale mostly primary/secondary/muted but 2 residual ink-mid | `sessionssurface.tsx:86-114,106,349` (ink-* count: 2) |
| State coverage | Diverges | loading:Partial (list Skeleton conforms; transcript is plain "Loading transcript…") · empty:Partial (SurfaceEmptyState for list, bespoke text elsewhere) · error:Diverges (catch-and-swallow to empty, no SurfaceError) | `sessionssurface.tsx:138-143,363,144-147,229,365,278-282`; `sessionsarchivestore.ts:31-33` |
| Motion | Diverges | No motiontokens import; list/filter/detail-switch are instant DOM swaps despite reflowProps being designed for this list | `sessionssurface.tsx` (no motion import) vs `motiontokens.ts:102-105` ("shared by Sessions and Activity") |
| Primitive reuse | Diverges | Reimplements section header (x3) and status dot inline instead of reusing shared primitives | `sessionssurface.tsx:151-157,223-226,356-359,173` vs `sectionheader.tsx:9-46`, `statusdot.tsx:14-37` |

**Findings:**
- Interaction/keyboard · High · M · `cockpitshell.tsx:66-88` + `cockpitsurface.tsx:293-297,358-361` · Lift the keyboard contract above the per-surface switch so [/] and cursor nav reach every surface, incl. a j/k list-cursor for the session list.
- Chrome/tokens · Low · S · `sessionssurface.tsx:106,349` · Replace the 2 text-ink-mid with text-secondary/text-muted.
- State coverage · Med · S · `sessionssurface.tsx:363,365,229` + `sessionsarchivestore.ts:31-33` + `sessionssurface.tsx:278-282` · Gate transcript load with Skeleton, route empty branches through SurfaceEmptyState, surface failures via SurfaceError.
- Motion · Med · S · `sessionssurface.tsx` vs `motiontokens.ts:102-105` · Wire reflowProps/computeEntrances into the filter-chip reflow + session/detail switch.
- Primitive reuse · Med · M · `sessionssurface.tsx:151-157,223-226,356-359,173` vs `sectionheader.tsx:9-46`, `statusdot.tsx:14-37` · Replace the 3 inline section headers with SectionHeader and raw dots with StatusDot.

#### files

| Dimension | Score | Note | Evidence |
|---|---|---|---|
| Interaction/keyboard | Partial | Global hook covers surface-switch/typing-guard/help, but Files' own file list + mode toggle are mouse-only — no j/k row nav or Enter-to-open | `cockpitsurface.tsx:361` (global mount) vs `filessurface.tsx:174-198` (FileRow, onClick only) |
| Chrome/tokens | Diverges | Almost entirely on residue `ink-*` scale (27 hits) vs 1 canonical `text-muted`; header N/A (own sidebar header, by design) | `filessurface.tsx:79,194,213-214,237,374` (ink-* count: 27; filesstore 0; filesmotion 0) |
| State coverage | Partial | loading:Conforms (SkeletonLine gated) · empty:Partial (SurfaceEmptyState only for no-source; ad-hoc divs for "No changes"/"Not a git repo") · error:Diverges (RPC failure silently collapses to empty-like, no SurfaceError) | `filessurface.tsx:140-172,330-337,397,426,428`; `filesstore.ts:63-67,119-123` |
| Motion | Conforms | Built on shared motiontokens (MOTION, cardVariants, computeEntrances); filesmotion.ts is a thin key-derivation helper | `filessurface.tsx:16,301-306,430-439`; `filesmotion.ts:9-14` |
| Primitive reuse | Diverges | Reimplements StatusDot as local `STATE_DOT` with divergent "working" color (`bg-success` vs canon `var(--color-accent)`) | `filessurface.tsx:31,75,105` vs `statusdot.tsx:8-12` |

**Findings:**
- Interaction/keyboard · High · M · `filessurface.tsx:174-198` · Extend cockpit cursor-nav (or a local analog) to drive file-row selection + diff-open via keyboard, not just onClick.
- Chrome/tokens · High · S · `filessurface.tsx:79,194,213-214,237,374` · Mechanical swap `ink-hi`→`text-primary`, `ink-mid`→`text-secondary`, `ink-faint`→`text-muted` throughout.
- State coverage · Med · S · `filesstore.ts:63-67,119-123` · Add `filesErrorAtom` (mirroring `usageErrorAtom`) and render `SurfaceError` instead of silently downgrading to empty.
- Primitive reuse · Med · S · `filessurface.tsx:31,75,105` · Delete local `STATE_DOT`; render `<StatusDot/>` so "working" color has one source.

#### memory

| Dimension | Score | Note | Evidence |
|---|---|---|---|
| Interaction/keyboard | Diverges | Mouse-only; shared hook lives only in CockpitSurface (unmounts when Memory active); Memory wires no nav | `cockpitshell.tsx:63-88`; `memorysurface.tsx:156-164` (onClick-only rows); `memgraph.tsx:500-504` (onNodeClick mouse-only) |
| Chrome/tokens | Diverges | SurfaceHeader adopted for the shell, but nearly every body/detail text node still on legacy ink-* | `memorysurface.tsx:53,59` (SurfaceHeader) vs `:146,149,197,213-214,257,276,332,345` (ink-* count: 38 — memorysurface 20, memgraph 7, newmemorymodal 10, memtypes 1) |
| State coverage | Partial | loading:Conforms · empty:Conforms · error:Diverges (swallowed, no SurfaceError) | loading `memorysurface.tsx:455-487,554`; empty `:557-560`; error `memstore.ts:77-81` (catch → empty + loaded:true) |
| Motion | Conforms | List reflow uses canon reflowProps/cardVariants; graph completion cue reuses shared useSettle | `memorysurface.tsx:9,126-129,138-143,159-163`; `memgraph.tsx:13,145-146,476` + `motionhooks.ts:8-21` |
| Primitive reuse | Partial | Reuses CollapsibleRail/SurfaceHeader/SurfaceEmptyState, but scope-group header reimplements SectionHeader inline | reuse `memorysurface.tsx:8,452,53,59,557`; dup `memorysurface.tsx:145-151` vs `sectionheader.tsx:9-46` |

**Findings:**
- Interaction/keyboard · High · M · `cockpitshell.tsx:63-88` + `memorysurface.tsx:156-164` · Extract surface-switch to a shell-level listener so [/] works from any surface; give Memory a local nav hook over filtered/notes ids (mirroring moveCursor/typing-guard).
- Chrome/tokens · Low · S · `memorysurface.tsx:146,213-214,276` (representative) · Swap the 38 ink-* → primary/secondary/muted across memorysurface, memgraph, newmemorymodal.
- State coverage · Med · S · `memstore.ts:77-81` · A failed MemoryScanCommand renders as "No memory yet" — indistinguishable from an empty vault. Add memErrorAtom + SurfaceError (onRetry=loadMemory).
- Primitive reuse · Low · M · `memorysurface.tsx:145-151` vs `sectionheader.tsx:9-46` · Make SectionHeader's dot/pill optional and consume it for the scope-group header.

#### usage

| Dimension | Score | Note | Evidence |
|---|---|---|---|
| Interaction/keyboard | Partial | Focusable Segmented toggles with zero usecockpitkeyboard integration — native Tab/Enter only, no rail entry or letter/nav key | `usagesurface.tsx:82-107,517-524,322-329`; no useCockpitKeyboard import in the 5 files |
| Chrome/tokens | Partial | Header conforms via shared SurfaceHeader; root skips SURFACE_ROOT (`bg-background` missing); 1 ink-mid residue | `usagesurface.tsx:506-526` (SurfaceHeader), `:503` (root, no bg-background); `tokenusagesection.tsx:40` (ink-* count: 1) |
| State coverage | Conforms | loading: Skeleton gated by usageLoadedAtom · empty: present · error: usageErrorAtom IS the canon reference wiring | `usagestore.ts:31-32,57,48,54`; `usagesurface.tsx:458-459,527-529,583-586` |
| Motion | Conforms | MOTION tokens, cardVariants, easeFluidCss throughout; every custom tween checks reduced-motion | `usagesurface.tsx:12,78-80,180-182,588,353` |
| Primitive reuse | Diverges | Zero use of shared SectionHeader/StatusDot/agentrow; reimplements section-label, status-dot, stat-card from scratch | no SectionHeader/StatusDot/agentrow matches in 5 files; bespoke `tokenusagesection.tsx:39-41`, `usagesurface.tsx:188,236,309,389` |

**Findings:**
- Interaction/keyboard · Low · S · `usagesurface.tsx:82-107` · Wire the Segmented toggles into a keyboard affordance (visible focus / documented key) or note them native-tab-only in usecockpitkeyboard's scope comment so the gap is intentional.
- Chrome/tokens · Low · S · `usagesurface.tsx:503` + `tokenusagesection.tsx:40` · Apply SURFACE_ROOT (or add bg-background) to the scroll root; swap text-ink-mid for text-muted.
- Primitive reuse · Low · M · `usagesurface.tsx:188,236,309,389` · Extend SectionHeader/StatusDot with optional count/dot props for reuse, or record the dashboard-card family as an accepted local primitive set rather than ad-hoc duplication.

#### radar

| Dimension | Score | Note | Evidence |
|---|---|---|---|
| Interaction/keyboard | Diverges | No keyboard mechanism; excluded from the global `]`/`[` rail cycle entirely | `usecockpitkeyboard.ts:66-74` (surfaceOrder omits "radar") vs `agents.tsx:37-46` (SURFACE_ORDER includes it); radarsurface.tsx no keydown |
| Chrome/tokens | Conforms | Radar's own subtree is clean (SurfaceHeader adopted, 0 ink-*). The Review/RunCompletion residue is charged to those sub-surfaces, which render inside Files (review mode) and Channels (RunBody), not Radar | `radarsurface.tsx:27,140` (radar ink-* count: 0; reviewsurface 18, runcompletionsurface 10 — see F3) |
| State coverage | Partial | loading: conflated with "never-scanned" · empty: bespoke panel, not SurfaceEmptyState · error: model-failed covered but RPC failures swallowed, no SurfaceError | `radarmodel.ts:146-148`; `radarstore.ts:71-74,115-118`; `radarscanstatepanel.tsx:76-105` |
| Motion | Diverges | Zero motiontokens in the radar subtree; disclosure + scan-state transitions snap | `radarfindingslist.tsx:44-50,83`; `radarscanstatepanel.tsx:76-199` |
| Primitive reuse | Partial | Reuses SurfaceHeader chrome, but hand-rolls section-header + empty-state shapes | `radarfindingslist.tsx:63-82` vs `sectionheader.tsx:9-46`; `radarscanstatepanel.tsx:53-105` vs `surfacescaffold.tsx:49-98` |

**Findings:**
- Interaction/keyboard · High · S/M · `usecockpitkeyboard.ts:66-74` · Add "radar" to surfaceOrder so `]`/`[` reaches it at all (S); then wire RadarFindingsList/Detail into j/k select + Enter-open + Escape (M).
- Chrome/tokens · Med · S · `reviewsurface.tsx:59,74,103` (18) + `runcompletionsurface.tsx:69,93,113` (10) · Migrate ink-* → primary/secondary/muted; radar's own files already clean.
- State coverage · Med · M · `radarstore.ts:71-74,115-118` · Surface RPC failures via radarErrorAtom + SurfaceError; compose SurfaceEmptyState for never-scanned/no-findings panels.
- Motion · Med · S · `radarfindingslist.tsx:44-50,83`; `radarscanstatepanel.tsx:76-199` · Wrap disclosure + scan-state transitions in cardVariants/MOTION.
- Primitive reuse · Low · S · `radarfindingslist.tsx:63-82`; `radarscanstatepanel.tsx:53-105` · Compose SectionHeader + SurfaceEmptyState instead of inline shapes.
- (reviewsurface, inline) State coverage · Med · S · `reviewsurface.tsx:59` · Ad-hoc "Loading…"/"No changes to review" strings, no Skeleton gate, no SurfaceError.
- (reviewsurface, inline) Interaction/keyboard · Low · M · `reviewsurface.tsx:42-57` · Own bespoke `window.addEventListener("keydown")` (a/r/u/arrows/Enter) — a third keyboard mechanism widening the no-single-contract gap.
- (runcompletion, inline) Chrome/tokens · Low · S · `runcompletionsurface.tsx:66-80` · Hand-rolled header instead of SurfaceHeader + 10 ink-* uses.

#### settings

| Dimension | Score | Note | Evidence |
|---|---|---|---|
| Interaction/keyboard | Partial | Native button/select/input (tab/Enter/Space) but zero cockpit-contract adoption; TermThemeDropdown dismisses via backdrop-click only, never Escape | `settingssurface.tsx:515,537-545` (no keyboard handler in file) |
| Chrome/tokens | Conforms | SurfaceHeader (25px/bold) used with border={false}, same inline pattern as Usage; scale primary/secondary/muted throughout | `settingssurface.tsx:22,49-55` (ink-* count: 0) |
| State coverage | Partial | loading:N/A (static form) · empty:N/A · error: vault-path field validation surfaced, but folder-browse failure swallowed to console; ProfilePanel's async fetch uses plain "Loading…" not Skeleton | `settingssurface.tsx:717-719`; `profilepanel.tsx:502` |
| Motion | Partial | settingssurface itself exemplary (macro fade + per-tab micro fade via MOTION), but bundled ProfilePanel never imports motion — loaded body + scope switch snap in | `settingssurface.tsx:44-48,449-453`; `profilepanel.tsx:496-526` |
| Primitive reuse | Partial | Reuses SurfaceHeader + PopoverReveal, but TermThemeDropdown hand-rolls open/dismiss + full-viewport backdrop instead of the shared Popover (floating-ui useDismiss: Escape + outside-click) | `settingssurface.tsx:515-545` vs `popover.tsx:80-82` |

**Findings:**
- Interaction/keyboard · Med · S · `settingssurface.tsx:537-545` · Reuse Popover/useDismiss (or add Escape) so TermThemeDropdown dismisses on keyboard, not just backdrop click.
- State coverage · Low · S · `settingssurface.tsx:717-719` · Surface folder-picker failure via the existing error state instead of console-only; route ProfilePanel's loading text (`profilepanel.tsx:502`) through Skeleton.
- Motion · Low · S · `profilepanel.tsx:496-526` · Wrap loaded body / scope-toggle in cardVariants so it fades in instead of snapping.
- Primitive reuse · Med · S · `settingssurface.tsx:515-545` · Replace hand-rolled popover logic in TermThemeDropdown with the shared Popover component.

#### placeholder

| Dimension | Score | Note | Evidence |
|---|---|---|---|
| Interaction/keyboard | N/A | No focusable content — SurfaceEmptyState called with no action, nothing to govern | `placeholdersurface.tsx:12`; `surfacescaffold.tsx:75` |
| Chrome/tokens | Conforms | Pure SurfaceEmptyState — canonical 25px/bold title, muted body, no bespoke chrome | `placeholdersurface.tsx:4,12` (ink-* count: 0) |
| State coverage | Conforms | loading:N/A · error:N/A · empty:Conforms — textbook SurfaceEmptyState invocation | `placeholdersurface.tsx:12`; `surfacescaffold.tsx:49-98` |
| Motion | Conforms | Inherits SurfaceEmptyState's cardVariants entrance/exit; no override | `surfacescaffold.tsx:8,61-66` |
| Primitive reuse | Conforms | 2-line wrapper around SurfaceEmptyState; scaffold migration done | `placeholdersurface.tsx:1-13` |

**Findings:**
- (none — surface conforms)
- Structural (not a rubric dimension) · Low · S · `cockpitshell.tsx:68-86`; `agents.tsx:25-34` · PlaceholderSurface is unreachable dead code: SurfaceKey is a closed 9-member union and cockpitshell's if/else covers all 9, so the trailing else rendering PlaceholderSurface never executes. Either wire a not-yet-handled SurfaceKey to it or delete it.
