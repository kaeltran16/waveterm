# Trim the Cockpit — Startup Weight + UI Declutter

> Captured 2026-06-24. Status: design approved, pending spec review → implementation plan.

## Context

Wave felt "bloated — features I'd never use." We pressure-tested whether to switch
foundations (Ghostty/WezTerm/Zellij/Tauri) and decided **no**: the triage's original
conclusion holds — the Electron foundation is the hard, undifferentiated base the agent
cockpit is built on, and switching means rebuilding it (lighter via Tauri, or as a TUI via
Zellij). We stay on Wave and trim it.

Two findings reshaped the work:

1. **Hiding ≠ unloading.** `blockregistry.ts` statically imports all 15 view models, and the
   app has no view-level code-splitting. Config-hiding a widget removes only the UI entry
   point; the module and its heavy deps still parse/evaluate at startup.

2. **The startup JS payload is dominated by deferrable machinery.** A production renderer
   build (`npm run build:prod`) showed `index.html` eagerly preloads these chunks:

   | Eager chunk | Size (uncompressed) | Needed at boot for the cockpit? |
   |---|---|---|
   | `index` (app) | 5.7 MB | yes |
   | `shiki` | 9.4 MB | no — markdown syntax highlighting |
   | `monaco` | 7.8 MB | no — editor/diff/settings only |
   | `mermaid` | 3.4 MB | no — diagrams only |
   | `cytoscape` | 1.5 MB | no — mermaid dependency |
   | `katex` | 0.47 MB | no — math only |

   ~23 MB of the ~28 MB eager payload is editor/markdown machinery not needed at first paint.
   (Monaco's language workers — `ts.worker` 13 MB, etc. — already load on editor mount, so
   they are not in the boot path.)

**Root cause (verified).** `streamdown` (the AI-markdown renderer) lists `mermaid`, `shiki`,
and `katex` as direct dependencies and statically imports them. `frontend/app/element/streamdown.tsx`
imports `streamdown` statically; `WaveStreamdown` is statically imported by the AI panel
(`aimessage.tsx`) and onboarding — both in the eager app graph. That single static import
chain drags **four** of the five heavy chunks (shiki + mermaid + cytoscape + katex) into
startup. Monaco is a separate, independent eager pull from the editor/preview/diff/settings views.

The agents cockpit view uses its **own** markdown renderer (`view/agents/markdownmessage.tsx`
/ `element/markdown.tsx`, via `rehype-highlight`), not streamdown — so deferring streamdown
does not touch the cockpit's primary markdown.

## Goals

- Remove ~22.6 MB of editor/markdown machinery from the startup parse/eval path by deferring
  it to first use.
- Declutter the cockpit's default UI to the surfaces the agent workflow actually uses.
- Verify the load-time win by evidence (chunk absent from `index.html`), not assertion.

## Non-goals

- Switching terminal foundation (Ghostty/WezTerm/Zellij/Tauri) — explicitly rejected.
- Removing any block type or capability — everything stays, just loads on demand.
- A toggleable "focus mode" product feature — YAGNI for now.
- Shrinking Electron/Chromium's own fixed boot cost.

## Design

### Part 1 — Defer heavy chunks out of startup

The mechanism throughout: convert a **static** import of a heavy module into a **dynamic**
(`React.lazy` / `import()`) boundary so its chunk leaves the entry's static graph. `manualChunks`
already splits these into separate files; making the import dynamic is what actually defers them.

**1a. Lazy-load `streamdown`** (reclaims ~14.8 MB — shiki + mermaid + cytoscape + katex).

- In `frontend/app/element/streamdown.tsx`, replace `import { Streamdown } from "streamdown"`
  with `const Streamdown = React.lazy(() => import("streamdown"))` and render it inside a
  `<Suspense>` with a lightweight fallback.
- Effect: the four chunks load on first AI-panel / onboarding markdown render instead of at boot.
- Low risk: streamdown is only on the AI-panel and onboarding paths, neither needed at first
  paint; the agents cockpit markdown is a different renderer. No other module statically
  imports shiki/katex/mermaid (verified by grep), so they fully leave the eager graph.

**1b. Lazy-load `monaco`** (reclaims ~7.8 MB).

- Introduce a dynamic boundary so `monaco-editor` is imported only when an editor/diff surface
  mounts. Two static entry points must move behind the boundary:
  - `frontend/app/monaco/monaco-react.tsx` — `import * as monaco from "monaco-editor"`
    (used by `MonacoCodeEditor` / `MonacoDiffViewer`).
  - `frontend/app/view/preview/preview-edit.tsx` — its own `import * as monaco`.
- Callers (`codeeditor.tsx`, `diffviewer.tsx`, `preview-edit.tsx`, `waveconfig`) render the
  editor via `React.lazy` + `<Suspense>`.
- `preview-model.tsx` already imports monaco as `type` only (erased at build) — no change there.

**Verification gate (per change):** run `npm run build:prod`, then grep `dist/frontend/index.html`
for the deferred chunk's name (e.g. `shiki`, `monaco`) and assert it is absent — it must no
longer be preloaded. This is the pass/fail test. Optionally capture real before/after startup ms
via devtools for the hard number; the byte evidence already justifies the work.

### Part 2 — Declutter the UI (config only)

The block-creation surface is the config-driven widget launcher (sidebar + launcher view both
read `widgets.json` and honor `display:hidden`); the block header context menu has no type
picker. So this is pure config in `pkg/wconfig/defaultconfig/` — no code.

- `widgets.json`: curate the default set to the cockpit workflow —
  **terminal, files, agents, loom**. Drop `web`, `sysinfo`, `processviewer` from the defaults.
  Add `defwidget@agents` with `blockdef.meta = { "view": "agents", "controller": null, "cmd:cwd": null }`.
  (`aifilediff` is opened contextually by diff review, not a manual launcher — no widget needed.)
- `settings.json`: `app:hideaibutton: true`, `widget:showhelp: false`.

These edit repo defaults so the cockpit ships minimal out of the box (its product identity),
not just a personal override.

## Risks & mitigations

- **Suspense flicker on first markdown/editor render.** `React.lazy` suspends once, then caches;
  use an unobtrusive fallback (skeleton/spinner) sized to the container. Acceptable for surfaces
  that are not first-paint.
- **Streaming markdown re-suspend.** The AI panel streams; ensure the lazy boundary wraps the
  component once (stable identity) so streaming updates don't re-trigger Suspense.
- **A deferred chunk turns out to be statically pulled elsewhere.** The verification gate catches
  this — if the chunk stays in `index.html`, trace the remaining static importer with the
  `whoImportsTarget` plugin already present in `electron.vite.config.ts`.
- **Declutter hides a surface still wanted.** Reversible: it is default config; a user can re-add
  any widget. Keep the change to defaults small and named.

## Out of scope / follow-ups

- Lazy-loading other eager view modules beyond monaco/streamdown (measure first if pursued).
- The `sharp` image-optimizer build warning (unrelated; logos just skip optimization).

## Approved decisions

- Stay on Wave; do not switch foundation.
- Full scope: 1a (streamdown) + 1b (monaco) + Part 2 declutter.
- Declutter edits repo default config (`pkg/wconfig/defaultconfig/`).
