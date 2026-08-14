# Jarvis S3 — proactive card deep-link (click-to-open the cited vault node)

**Date:** 2026-08-14
**Status:** Design approved; not implemented.
**Type:** Follow-on slice to the [S3 proactive resurfacing spec](2026-07-24-jarvis-s3-proactive-resurfacing-design.md).

## Why this slice

S3 shipped the proactive card as **informational + dismissible**: one "related prior work"
suggestion on the run, carrying the cited node's id, type, title, and snippet — but clicking it
does nothing. The S3 spec's §4 Navigation ("clicking the card navigates to the cited vault node via
the existing grounding-nav convention") was deferred with the other S3 follow-ons
(`docs/deferred.md` §S3): the deep-link target did not exist yet. U2 (Tasks) and U3 (Graph) have
since landed, so the targets exist and this is the natural next increment.

## What the card carries today

The suggestion persists in `run.Meta[MetaKeyProactive]` as `ProactiveSuggestion`
(`pkg/jarvisproactive/suggestion.go`): `Status` (`pending|hit|none`), `NodeID`, `SourceType`,
`Title`, `Snippet`, `Why`. `readProactiveSuggestion` (`frontend/app/view/agents/proactive.ts`)
already decodes it into a `ProactiveVM { nodeId, sourceType, title, snippet, why }`.

- `nodeId` is the bare vault node id (frontmatter `id` → `name` → basename; `wavevault/parse.go`).
- `sourceType` is `"dossier" | "decision" | "memory"` (`sourceTypeFor`, `gate.go`).

No backend or wire change is needed for this slice: the payload already has everything.

## The navigation convention

`frontend/app/view/jarvis/openref.ts` is the single home of oref navigation:

- `orefNavPlan(oref)` — pure, total: classifies `channel:|run:|task:|agent:|memnote:` refs into
  nav plans; everything else is `unsupported` (deliberate no-op, never an error).
- `openORef(model, oref, anchor?)` — `task:<id>` selects the dossier subject on the Jarvis surface;
  `memnote:<id>` selects the note on the Memory surface; `run:`/`channel:`/`agent:` open their own
  surfaces.

The briefing already navigates ledger refs through `openORef`. It normalizes `vault:<id>` →
`task:<id>` as a one-off alias (`normalizeBriefingNav`, `briefingmodel.ts:81`) and explicitly does
**not** make `vault:` a global alias. This slice follows that: the card maps by the `sourceType`
it already carries, never by a bare-id guess.

## Design

### 1. Pure mapping — `frontend/app/view/agents/proactive.ts`

```ts
export function proactiveNavOref(vm: ProactiveVM): string | null {
    if (vm == null || vm.nodeId === "") return null;
    switch (vm.sourceType) {
        case "dossier": return `task:${vm.nodeId}`;
        case "memory":  return `memnote:${vm.nodeId}`;
        default:        return null; // decision (no open path yet) + unknown types
    }
}
```

- `dossier` → Jarvis surface, dossier subject (same path briefing sources use).
- `memory` → Memory surface, selected note (full surface switch — user decision; consistent with
  briefing sources; the card lives on the Jarvis ambient rail, so this is a cross-surface jump).
- `decision` → `null`. Decisions have no open path today (no `decision:` nav kind; not a Stage
  subject). The live corpus has zero decisions, so this cannot fire; it is an honest no-op, not an
  error.

### 2. Component — `proactiveviews.tsx` + the shared shell

- `AmbientCard` (`frontend/app/view/agents/ambientcard.tsx`) gains one optional prop,
  `onClick?: () => void`. When present, the inner content wrapper (eyebrow + children) renders as a
  real `<button type="button">` — free Enter/Space keyboard support, `cursor-pointer`, restrained
  hover. When absent, renders exactly as today, so the other two AmbientCard consumers (`ResumeCard`,
  `RelevantDecisions`) are untouched. The dismiss × stays a sibling button — no nested buttons, no
  stopPropagation needed.
- `ProactiveCard` gains a `model: AgentsViewModel` prop. The render site
  (`frontend/app/view/jarvis/ambientrailview.tsx` `ambientSection`) already has the model in scope.
  The card computes `const oref = proactiveNavOref(vm)` and passes
  `onClick={oref ? () => void openORef(model, oref) : undefined}`. A non-navigable card renders with
  no click handler — no cursor, unchanged appearance.

### 3. Degradation

- Missing `nodeId`, unknown `sourceType` → `null` → card not clickable, dismissal unchanged.
- A memory note that the Memory surface cannot resolve: `selectNote` sets the selected id and opens
  the rail; an unresolvable id renders the surface's own empty state. Acceptable — the note was
  indexed from the vault whose `memory/` is a scan root, so it should resolve.

## Testing

- **Pure unit tests** (extend `frontend/app/view/agents/proactive.test.ts`): dossier →
  `task:<id>`; memory → `memnote:<id>`; decision → `null`; empty `nodeId` → `null`; unknown
  `sourceType` → `null`.
- **CDP** (`scripts/cdp/scenarios.mjs`, the existing `jarvis-proactive` scenario): its seeded
  suggestion is a *decision* hit — with this mapping that is the non-clickable path. Adjust the
  fixture to a dossier hit so the scenario can assert the click → Jarvis-surface subject switch
  (wiring verified live; no jsdom per the standing decision).

## Out of scope

- An "Ask Jarvis about this" card action — the run body already renders `AskJarvisButton` beside
  the card (`runbody.tsx`).
- Rendering the card's `why` line (spec'd in S3 §4, shipped without it; unrelated to navigation).
- A `decision:` nav kind or decision-as-subject (needs a product decision; zero decisions in the
  corpus — YAGNI).
- A `vault:` global alias in `orefNavPlan` (the briefing explicitly declined one; `sourceType`
  makes it unnecessary).
