# Command palette: safe Enter, full reach, remembered order

**Date:** 2026-08-06
**Status:** design approved, no plan written yet
**Supersedes nothing.** Builds on the palette itself (`aaaa1393`), its launch group (`02e811a0`), its sigil scopes (`3b2abfd0`), the Jarvis ask entry (`e9ab8926`), and the chord routing that gave `Ctrl+P` to both palettes (`ccc90133`).

## Why

Three problems, one of them a footgun.

**Enter dispatches an agent when you meant to navigate.** The group assembler in `command-palette.tsx:320-358` prepends the launch block whenever a channel is active and the query is non-empty (`:348`), and the input's `onChange` resets the selection to index 0 on every keystroke (`:409-410`). So typing `usage` to reach the Usage surface leaves `Quick · claude` selected, and Enter spawns a worker whose goal is the letters you typed. The `Go to Usage` row it ranked correctly is sitting below the selection. Navigation is reversible; spawning an agent is not, and the palette currently defaults to the irreversible one.

**The palette can invoke eleven things.** Nine `Go to <surface>` rows built from the nav rail's `ITEMS` (`navrail.tsx:39-48`, imported at `command-palette.tsx:17`), plus New agent, New project, and Keyboard shortcuts. Meanwhile `bindingsAtom` — the registry the cheat sheet already renders (`shortcuts-cheatsheet.tsx:24`) — holds several dozen actions, each with a label, a chord, a group, a guard and a runner. The palette duplicates a slice of it by hand and shows no chords, so it cannot teach a shortcut. The gap is already visible: `GO_TARGETS` (`bindings.ts:35-44`) has ten entries including Settings, the nav rail has nine, and **Settings has a chord (`g ,`) but no palette row.**

**The result list has no memory and no manners.** Ranking is pure fuzzy score against static text with ties in input order (`palette-match.ts:64-77`); nothing recent floats. There is no cap, so an empty query renders every resumable session — the sibling file finder caps at 50 (`codefinderpalette.tsx:20`), this one caps at nothing. Arrow-keying past the visible rows moves the selection out of view, because the scroll container (`command-palette.tsx:419`) is never told to follow it. And `fuzzyScore` returns a number with no positions, so a row cannot bold what you typed.

## What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| Fuzzy subsequence scorer with contiguity and word-boundary bonuses | `palette-match.ts:20-57` | Shipped. Extended here with a positions-returning sibling; the scoring itself is unchanged. |
| Sigil scope parser (`>` `@` `/` `#`, plus `#chan goal`) | `palette-scope.ts` | Shipped. **Untouched.** Scoped queries already narrow to one group and are outside the ordering rule below. |
| Pure builders for the launch, ask and focus rows | `palette-launch.ts`, `palette-ask.ts`, `palette-focus.ts` | Shipped. Reused as-is; only where their output lands changes. |
| Live binding registry with label, chord, group, guard, runner | `bindingsAtom` (`keybindings/store.ts`), `Binding` (`keybindings/types.ts`) | Shipped. Gains one optional field. |
| Chord-to-key-chips renderer | `formatChord` (`util/keysym`), used at `shortcuts-cheatsheet.tsx:69` | Shipped. Reused verbatim for palette rows. |
| Persisted-atom convention | `atomWithStorage` under a `cockpit.*` key (`themestore.ts:14`) | Shipped. The recency list follows it. |
| Theme presets | `themes.ts` — six dark (Midnight, Slate, Carbon, Nocturne, One Dark, Monokai) plus Paper | Shipped. Paper is light and stays omitted, as the existing picker already omits it. |

## Resolved decisions

**1. The launch block leads only when the query matched nothing confident.** Rank the finder pool first — focus tasks, commands, agents, sessions. If it produced a confident match, those groups lead, the selection lands on the top-ranked row, and the launch and ask rows collapse into one trailing block labelled `Act on "<query>"`. If it did not, the query is prose: the launch block leads under `Launch in #<channel>` with its accent rail, exactly as today, and Enter dispatches. This makes Enter's default the reversible action in the common case without costing the fast-dispatch gesture a modifier.

**2. Confidence is a density ratio, not "matched at all."** This is the one tunable in the design and the one thing that cannot be validated without use. `fuzzyScore` is a permissive subsequence match with no floor, so a prose goal such as `fix the flaky projectname test` will often match *something* inside a long session task string. Gating on non-empty results would therefore break fast-dispatch unpredictably. Instead the pool's best score must clear half a reference score of six points per character of the trimmed query — one point for the match plus the contiguity bonus (`MATCH_POINT` and `CONTIGUOUS_BONUS`, `palette-match.ts:7-9`). Trimmed, because `fuzzyScore` trims before matching (`:21`) and a trailing space would otherwise inflate the reference and reject a match that is in fact exact. `usage` against `Go to Usage` scores 28 against a reference of 30. A scattered prose match lands far below. The reference is not a strict maximum — a query containing spaces can pick up word-boundary bonuses and slightly exceed it — which is harmless, because the test is a floor. Constant: `MIN_MATCH_DENSITY = 0.5`, defined in `palette-groups.ts` beside the rule it governs.

**3. Commands derive from the binding registry; the palette stops hand-writing them.** `buildCommandItems(bindings, ctx)` filters, dedupes and projects `Binding[]` into palette rows carrying the chord. This makes the registry the single source of truth for what the cockpit can do and what it is called, and every derived row teaches its shortcut for free. The `ITEMS as SURFACE_ITEMS` import at `command-palette.tsx:17` and the hand-written command array at `:133-174` both go away.

**4. Guards are evaluated against a synthesized post-close context.** `Binding.when` takes a `KeyContext`, and while the palette is open that context has `modalOpen: true` and `editable: true` — the search input holds focus. Evaluating guards against the live context would reject nearly everything, including `navigate`-guarded bindings, which is most of the useful ones. So applicability is tested against the context that will exist a frame after the palette closes: `{surface, editable: false, modalOpen: false, leader: null}`. Inapplicable rows are omitted rather than shown disabled — a row you cannot run is noise in a list you are scanning by eye.

**5. Postures and stateful gestures opt out; genuine duplicates collapse by label.** `Binding` gains `paletteHidden?: boolean`, set next to the binding it describes. Three kinds of entry take it:

- **Postures** — keys you press while looking at the screen, not actions you would search by name: the nine `channels:answer-N` rows, `channels:submit`, the five `list:*` rows, and `jarvis:blur-composer`.
- **A stateful gesture** — `close-agent` is labelled "Close agent (press twice)". A two-press confirmation cannot be expressed as one palette row, and a row that silently fires only the first press is worse than no row.
- **Numeric surface jumps** — the `Ctrl+1..9` `surface:<key>` bindings are exact duplicates of the `g`-leader go-targets, and their generated labels (`Jump to usage`, the raw surface key in lowercase) are the worse of the two phrasings.

Everything that survives is deduped by label, which collapses the genuine triples — "Next agent" is registered three times (`cycle-agent-next`, `agent:next`, `agent:next-j`) with identical labels. The surviving row shows the most deliberate chord: prefer a leader sequence, else a chord with a modifier, else the first registered. So surfaces show `g u` and Next agent shows its modifier chord rather than the bare `j`.

**6. One surface, one name.** Deriving labels from bindings surfaces a pre-existing inconsistency: the go-target for the diff surface is labelled `Files` (`bindings.ts:41`) while the nav rail labels the same surface `Diff` (`navrail.tsx:45`). Today the two lists never meet, so nobody noticed. The binding label is renamed to match the rail. The remaining go-target parentheticals — `Cockpit (home)`, `Jarvis (channels, records, recall)`, `Code (browse source)` — are kept: they read fine as palette rows and their extra words are searchable, so typing `recall` finds Jarvis.

**7. Chordless extras stay an explicit list, and it is short.** After derivation only three things need hand-writing, which is itself evidence the derivation is carrying its weight: **New project**, **New memory**, and six **Switch theme → <preset>** rows. Their shape matches a derived row minus the chord, so both flow through one renderer.

**8. New memory must set the surface before the atom.** `memNewOpenAtom` is consumed only inside `memorysurface.tsx:544`, and every surface except Agent unmounts when off-screen — so the consumer is not mounted when the palette fires from elsewhere. The row sets `surfaceAtom` to `memory` first and the open atom second; the Memory surface then mounts and reads it. The unmount cleanup at `memorysurface.tsx:548` resets the atom on teardown only, so it does not race the mount. New project needs no such ordering — its modal is hosted by the always-mounted shell, which is why the palette can already open it from anywhere.

**9. Recency is a most-recently-used list, not a frecency score.** The last twenty chosen item keys, most recent first, in an `atomWithStorage` under `cockpit.palette.mru`. Two effects, one constant. An empty query leads with a `Recent` group of up to five rows resolved against the current pool, dropping keys whose item no longer exists. And the pool is pre-sorted by MRU position *before* ranking, so that `Array.prototype.sort` being stable is what makes the more recent row win among equal scores — no weighting term, no decay curve, no constants to guess. Launch and ask rows are not recorded: their keys are generic (`launch:quick`), they never enter the ranked pool, and floating them would mean nothing.

**10. Highlighting matches the title, not the search text.** `fuzzyMatch` returns `{score, positions}`, and `fuzzyScore` becomes a wrapper over it so existing callers are untouched. Positions index the string that was matched, and `item.search` is not the string a row displays — for an agent it is `name + task + project` while the title is `name — task`. Rather than restructure every `search` field to be title-prefixed, which would be a fragile invariant with no compiler behind it, the row highlights `fuzzyMatch(query, title)`. A query that hit only keywords renders unhighlighted, which is honest; the alternative bolds the wrong characters.

**11. Capping is visible.** `MAX_PER_GROUP = 20` per group, with a muted `+N more — keep typing` line on any group that was cut. A silently truncated list reads as a complete one.

## 1. Modules

Four new files, all pure and unit-tested, following the `foo.ts` + `foo.test.ts` + thin `foo.tsx` convention already used across `view/agents`.

- **`palette-groups.ts`** — `assembleGroups({ranked, launchItems, askItems, scope, query})` returns the ordered groups. Owns `MIN_MATCH_DENSITY` and the confident/prose decision. This is the Enter fix, lifted out of `command-palette.tsx:320-358`.
- **`palette-commands.ts`** — `buildCommandItems(bindings, ctx)` (filter by `paletteHidden`, filter by `when(ctx)`, dedupe by label with chord preference, project to rows) and `CHORDLESS_COMMANDS` (New project, New memory, the six theme rows).
- **`palette-mru.ts`** — the persisted atom, `recordUse(key)`, and `sortByMru(items)`.
- **`palette-match.ts`** (existing, extended) — `fuzzyMatch` returning positions; `fuzzyScore` reduced to a wrapper; `rankPaletteItems` unchanged in signature.

`command-palette.tsx` consumes all four, adds the `data-idx` attribute and the `scrollIntoView({block: "nearest"})` effect, renders chord chips and highlight spans, and records MRU inside each row's `run`.

`keybindings/types.ts` gains the optional `paletteHidden` field; `keybindings/bindings.ts` sets it on the entries named in decision 5 and renames the one label in decision 6.

## 2. Testing

- **`palette-groups.test.ts`** — the confidence rule in both directions, which is the whole point of the change: `usage` with an active channel puts a command row at index 0 and the launch rows in a trailing block; `fix the flaky projectname test` against a pool seeded with a plausibly-colliding session task puts `Quick · claude` at index 0. Plus: empty query yields no launch block; a sigil scope bypasses the rule entirely; no active channel yields ask-only.
- **`palette-commands.test.ts`** — a guard written for `navigate` passes under the synthesized context and would fail under a live modal-open one; `paletteHidden` entries are absent; three identically-labelled bindings collapse to one; the surviving chord is the leader sequence.
- **`palette-mru.test.ts`** — recording moves a key to the front and caps the list at twenty; `sortByMru` puts recent first and leaves unrecorded items in input order; a recorded key whose item is gone is dropped from the Recent group.
- **`palette-match.test.ts`** (extended) — positions are the matched indices in order; a non-match still returns null; `fuzzyScore` results are unchanged for the existing cases.

No jsdom render tests, per the standing decision that "does it render" is covered by the CDP `surface-smoke` scenario.

## 3. Rollout order

The safety fix ships first and alone, so it is not entangled with the reach work if it needs adjusting.

1. `fuzzyMatch` with positions, `fuzzyScore` as a wrapper — no behavior change, tests only.
2. `palette-groups.ts` and its wiring — Enter stops dispatching on a confident match.
3. Scroll-into-view, per-group cap with the overflow line, highlight rendering.
4. `paletteHidden`, `palette-commands.ts`, the chordless extras — the palette's reach and its chord chips.
5. `palette-mru.ts` and the Recent group.

## Risks

- **`MIN_MATCH_DENSITY` is unvalidated.** Set too high, a real name typed sloppily is treated as prose and Enter dispatches — the current footgun, narrowed but not gone. Set too low, a prose goal gets navigated instead of dispatched, which is annoying but reversible. It is deliberately biased toward the reversible failure. Adjusting it means editing one constant with a test beside it.
- **A binding's `run` may assume the context its `when` was written for.** Guards are evaluated against a synthesized context, but a runner can read live atoms. `close-agent` is the known case and is excluded by name; another stateful gesture added later would need the same treatment, and nothing in the type system enforces that.
- **Deriving labels changes strings users have learned.** Row text moves from the palette's phrasings to the cheat sheet's. Decision 6 resolves the one outright conflict; the rest are longer but searchable.

## Out of scope

- **The chord itself.** `Ctrl+P` being consumed inside a focused terminal, where a readline shell wants `^P` for previous-command, is a known cost accepted in `ccc90133` and is not revisited here.
- **The Code file finder.** Its handoff on a leading `>` (`codefinderpalette.tsx:56-60`) is unchanged.
- **Searching anything not already in the frontend.** No repo-wide file search outside the Code surface, no querying Jarvis records, dossiers, memory or Radar findings from the palette. Every source here is an atom already in memory.
- **Secondary actions on a selected row** — no "Tab to drill in" for kill-agent, open-in-Code or copy-path.
