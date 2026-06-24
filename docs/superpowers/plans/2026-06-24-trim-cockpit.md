# Trim the Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut ~22.6 MB of editor/markdown machinery out of Wave's startup parse/eval path by deferring it to first use, and declutter the cockpit's default UI to the agent workflow.

**Architecture:** Three independent parts. (1a) Lazy-load the `streamdown` markdown renderer behind a `React.lazy` boundary so shiki/mermaid/cytoscape/katex leave the startup graph. (1b) Lazy-load `monaco` behind `React.lazy` at the `CodeEditor`/`DiffViewer` wrappers, plus convert two `typeof`-only `monaco-editor` imports to `import type`. (2) Config-only declutter of the repo default `widgets.json` + `settings.json`. Each load-time change is gated by a production build that asserts the heavy chunk no longer appears in `dist/frontend/index.html`.

**Tech Stack:** React 19 + TypeScript, electron-vite (Vite 6 / Rollup), Tailwind v4. No new dependencies.

**Source spec:** `docs/superpowers/specs/2026-06-24-trim-cockpit-design.md`

---

## Git policy for this plan

Per this repo's git rule: **do NOT commit without explicit user approval.** The "Stage" steps below run `git add` only. After all tasks pass their verification gates, present the full diff and the proposed single commit message, then commit only on approval (batched into one commit unless told otherwise).

## Why the verification is a build, not a unit test

Lazy-loading is a bundler concern, not runtime logic, so the pass/fail test for Tasks 1 and 2 is: run a production build and confirm the heavy chunk is no longer preloaded in `dist/frontend/index.html`. That file lists exactly the chunks the app evaluates at startup.

---

## Task 0: Record the startup baseline

**Files:** none (measurement only)

- [ ] **Step 1: Build the production renderer**

Run from the project root:
```bash
npm run build:prod
```
Expected: `✓ built in ...`. A `[vite-plugin-image-optimizer]` error about `sharp` is unrelated and harmless (logos skip optimization).

- [ ] **Step 2: Record which chunks load at startup**

Run:
```bash
grep -oE 'assets/[A-Za-z0-9._-]+\.js' dist/frontend/index.html | sort -u
```
Expected output includes (this is the baseline we will shrink):
```
assets/cytoscape-*.js
assets/index-*.js
assets/katex-*.js
assets/mermaid-*.js
assets/monaco-*.js
assets/shiki-*.js
```

- [ ] **Step 3: Record chunk sizes for the delta**

Run:
```bash
du -h dist/frontend/assets/*.js | sort -rh | head -12
```
Note the sizes of `shiki` (~9.4M), `monaco` (~7.8M), `mermaid` (~3.4M), `cytoscape` (~1.5M), `katex` (~0.47M). These are the bytes we are deferring.

---

## Task 1: Lazy-load `streamdown` (defer shiki + mermaid + cytoscape + katex, ~14.8 MB)

`frontend/app/element/streamdown.tsx` statically imports both `shiki/bundle/web` (line 9) and the `streamdown` package (line 10, which itself bundles mermaid/shiki/katex). The whole module must sit behind a lazy boundary. It is consumed via the `WaveStreamdown` export by exactly three callers; redirecting all three through a lazy wrapper removes the module from the eager graph.

**Files:**
- Modify: `frontend/app/element/streamdown.tsx` (export the props interface)
- Create: `frontend/app/element/streamdown-lazy.tsx`
- Modify: `frontend/app/aipanel/aimessage.tsx:4`
- Modify: `frontend/app/onboarding/fakechat.tsx:4`
- Modify: `frontend/app/onboarding/onboarding-layout.tsx:5`

- [ ] **Step 1: Confirm the full set of `WaveStreamdown` importers**

Run:
```bash
grep -rn "WaveStreamdown" frontend --include=*.tsx --include=*.ts | grep -i import
```
Expected: exactly three import sites — `aipanel/aimessage.tsx`, `onboarding/fakechat.tsx`, `onboarding/onboarding-layout.tsx`. If more appear, every one must be redirected in Step 4 (otherwise streamdown stays eager). Also confirm nothing imports the `Code` export eagerly:
```bash
grep -rn "from \"@/app/element/streamdown\"" frontend
```
Expected: only the three `WaveStreamdown` import lines. (If `Code` is imported elsewhere, that file would re-introduce shiki — stop and flag it.)

- [ ] **Step 2: Export the props interface from `streamdown.tsx`**

In `frontend/app/element/streamdown.tsx`, change the declaration (currently around line 200) from:
```tsx
interface WaveStreamdownProps {
```
to:
```tsx
export interface WaveStreamdownProps {
```
(Exporting a type has no runtime effect.)

- [ ] **Step 3: Create the lazy wrapper**

Create `frontend/app/element/streamdown-lazy.tsx`:
```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import type { WaveStreamdownProps } from "./streamdown";

// the heavy markdown stack (streamdown -> mermaid/shiki/katex, plus shiki/bundle/web)
// only loads when markdown first renders, not at app startup
const WaveStreamdownInner = lazy(() =>
    import("./streamdown").then((m) => ({ default: m.WaveStreamdown }))
);

export const WaveStreamdown = (props: WaveStreamdownProps) => (
    <Suspense fallback={null}>
        <WaveStreamdownInner {...props} />
    </Suspense>
);
```

- [ ] **Step 4: Redirect all three callers to the lazy wrapper**

In each of these files, change the import path from `@/app/element/streamdown` to `@/app/element/streamdown-lazy` (the named import `WaveStreamdown` stays identical):

`frontend/app/aipanel/aimessage.tsx` line 4:
```tsx
import { WaveStreamdown } from "@/app/element/streamdown-lazy";
```
`frontend/app/onboarding/fakechat.tsx` line 4:
```tsx
import { WaveStreamdown } from "@/app/element/streamdown-lazy";
```
`frontend/app/onboarding/onboarding-layout.tsx` line 5:
```tsx
import { WaveStreamdown } from "@/app/element/streamdown-lazy";
```

- [ ] **Step 5: Verify no type/lint errors**

Confirm there are no TypeScript errors in the three modified callers, `streamdown.tsx`, and `streamdown-lazy.tsx` (VSCode Problems panel, or `npx tsc --noEmit` if quick). Expected: clean.

- [ ] **Step 6: Build and assert the chunks left the startup graph (the test)**

Run:
```bash
npm run build:prod && grep -oE 'assets/[A-Za-z0-9._-]+\.js' dist/frontend/index.html | sort -u
```
Expected: the output **no longer contains** `shiki`, `mermaid`, `cytoscape`, or `katex`. (`monaco` and `index` are still present — monaco is Task 2.) If any of the four remain, run the troubleshooting step in Task 2 with that chunk name as the target to find the leftover static importer.

- [ ] **Step 7: Sanity-check markdown still renders**

Run the dev app (`npm run dev`), open the AI panel, send a message that returns markdown with a code block. Expected: it renders (after a brief first-load), code is highlighted, no console error. Mermaid/math render if present.

- [ ] **Step 8: Stage**

```bash
git add frontend/app/element/streamdown.tsx frontend/app/element/streamdown-lazy.tsx frontend/app/aipanel/aimessage.tsx frontend/app/onboarding/fakechat.tsx frontend/app/onboarding/onboarding-layout.tsx
```
(Do not commit yet — see Git policy.)

---

## Task 2: Lazy-load `monaco` (defer ~7.8 MB)

Monaco reaches the eager graph through the `CodeEditor` and `DiffViewer` wrappers, which statically import `MonacoCodeEditor`/`MonacoDiffViewer` from `monaco-react.tsx` (which pulls `monaco-env.ts` → `monaco-editor` + workers). Two other `monaco-editor` imports (`codeeditor.tsx:8`, `preview-edit.tsx:11`) are used only in `typeof` positions and become `import type`. After these changes, `monaco-editor` is reachable only via dynamic import.

**Files:**
- Modify: `frontend/app/view/codeeditor/codeeditor.tsx`
- Modify: `frontend/app/view/codeeditor/diffviewer.tsx`
- Modify: `frontend/app/view/preview/preview-edit.tsx:11`

- [ ] **Step 1: Make `preview-edit.tsx`'s monaco import type-only**

In `frontend/app/view/preview/preview-edit.tsx`, change line 11 from:
```tsx
import * as monaco from "monaco-editor";
```
to:
```tsx
import type * as monaco from "monaco-editor";
```
(`monaco` is used only as `typeof monaco` at line 76, so this is safe and erases the runtime import.)

- [ ] **Step 2: In `codeeditor.tsx`, make `MonacoModule` type-only and `MonacoCodeEditor` lazy**

In `frontend/app/view/codeeditor/codeeditor.tsx`:

Change line 4 from:
```tsx
import { MonacoCodeEditor } from "@/app/monaco/monaco-react";
```
to (delete that import and instead add, immediately after the existing `import React, { useMemo, useRef } from "react";` line):
```tsx
const MonacoCodeEditor = React.lazy(() =>
    import("@/app/monaco/monaco-react").then((m) => ({ default: m.MonacoCodeEditor }))
);
```

Change line 8 from:
```tsx
import * as MonacoModule from "monaco-editor";
```
to:
```tsx
import type * as MonacoModule from "monaco-editor";
```
(`MonacoModule` is used only as `typeof MonacoModule` at lines 39 and 76.)

Wrap the rendered editor (currently lines ~98-106) in a Suspense boundary:
```tsx
            <div className="flex flex-col h-full w-full" ref={divRef}>
                <React.Suspense fallback={null}>
                    <MonacoCodeEditor
                        readonly={readonly}
                        text={text}
                        options={editorOpts}
                        onChange={handleEditorChange}
                        onMount={handleEditorOnMount}
                        path={editorPath}
                        language={language}
                    />
                </React.Suspense>
            </div>
```

- [ ] **Step 3: In `diffviewer.tsx`, make `MonacoDiffViewer` lazy**

In `frontend/app/view/codeeditor/diffviewer.tsx`:

Change line 8 from:
```tsx
import { useMemo, useRef } from "react";
```
to:
```tsx
import { lazy, Suspense, useMemo, useRef } from "react";
```

Delete line 4:
```tsx
import { MonacoDiffViewer } from "@/app/monaco/monaco-react";
```
and add, after the imports:
```tsx
const MonacoDiffViewer = lazy(() =>
    import("@/app/monaco/monaco-react").then((m) => ({ default: m.MonacoDiffViewer }))
);
```

Wrap the rendered diff viewer (currently lines ~65-71) in Suspense:
```tsx
            <div className="flex flex-col h-full w-full">
                <Suspense fallback={null}>
                    <MonacoDiffViewer
                        path={editorPath}
                        original={original}
                        modified={modified}
                        options={editorOpts}
                        language={language}
                    />
                </Suspense>
            </div>
```

- [ ] **Step 4: Verify no type/lint errors**

Confirm clean TypeScript in `codeeditor.tsx`, `diffviewer.tsx`, `preview-edit.tsx`. Expected: no errors.

- [ ] **Step 5: Build and assert monaco left the startup graph (the test)**

Run:
```bash
npm run build:prod && grep -oE 'assets/[A-Za-z0-9._-]+\.js' dist/frontend/index.html | sort -u
```
Expected: the output **no longer contains** `monaco`. Combined with Task 1, the eager list should now be essentially just `index` (plus any small app chunks) — shiki/monaco/mermaid/cytoscape/katex all gone.

- [ ] **Step 6: Troubleshoot if monaco persists (only if Step 5 fails)**

A static importer is still reaching `monaco-editor`. Find it with the `whoImportsTarget` plugin already defined in `electron.vite.config.ts`: temporarily import `path` and add to the `renderer.plugins` array:
```ts
whoImportsTarget(path.resolve(__dirname, "node_modules/monaco-editor/esm/vs/editor/editor.api.js")),
```
Re-run `npm run build:prod` and read the printed "Importer chain" lines to locate the eager static import, convert it to `import type` (if type-only) or move it behind a `React.lazy`/`import()` boundary, then remove the plugin line and re-verify Step 5.

- [ ] **Step 7: Sanity-check the editor and diff viewer still work**

Run the dev app. Open a text file in Preview and press the edit shortcut (Monaco editor should load and edit). Open an AI file diff (Monaco diff viewer should render). Open Settings (waveconfig uses `CodeEditor`). Expected: each loads after a brief first-load with no console errors.

- [ ] **Step 8: Stage**

```bash
git add frontend/app/view/codeeditor/codeeditor.tsx frontend/app/view/codeeditor/diffviewer.tsx frontend/app/view/preview/preview-edit.tsx
```

---

## Task 3: Declutter the default UI (config only)

The block-creation surface is the config-driven widget launcher; there is no separate type picker. So this is pure config in `pkg/wconfig/defaultconfig/`. Curate the default widget set to the agent workflow and hide the AI button + help widget.

**Files:**
- Modify: `pkg/wconfig/defaultconfig/widgets.json`
- Modify: `pkg/wconfig/defaultconfig/settings.json`

- [ ] **Step 1: Replace the default widget set**

Replace the entire contents of `pkg/wconfig/defaultconfig/widgets.json` with the cockpit set (terminal, files, agents, loom — dropping web/sysinfo/processes):
```json
{
    "defwidget@terminal": {
        "display:order": -5,
        "icon": "square-terminal",
        "label": "terminal",
        "blockdef": {
            "meta": {
                "view": "term",
                "controller": "shell"
            }
        }
    },
    "defwidget@files": {
        "display:order": -4,
        "icon": "folder",
        "label": "files",
        "blockdef": {
            "meta": {
                "view": "preview",
                "file": "~"
            }
        }
    },
    "defwidget@agents": {
        "display:order": -3,
        "icon": "robot",
        "label": "agents",
        "blockdef": {
            "meta": {
                "view": "agents",
                "controller": null,
                "cmd:cwd": null
            }
        }
    },
    "defwidget@loom": {
        "display:order": -2,
        "icon": "code-branch",
        "label": "loom",
        "blockdef": {
            "meta": {
                "app:loom": true
            }
        }
    }
}
```
(If the agents view registers a specific icon you prefer over `robot`, use that FontAwesome name instead — `robot` is a safe default.)

- [ ] **Step 2: Hide the AI button and help widget**

In `pkg/wconfig/defaultconfig/settings.json`, change:
```json
    "app:hideaibutton": false,
```
to:
```json
    "app:hideaibutton": true,
    "widget:showhelp": false,
```

- [ ] **Step 3: Validate both JSON files parse**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('pkg/wconfig/defaultconfig/widgets.json','utf8')); JSON.parse(require('fs').readFileSync('pkg/wconfig/defaultconfig/settings.json','utf8')); console.log('valid')"
```
Expected: `valid`.

- [ ] **Step 4: Sanity-check the cockpit surface**

Run the dev app with a fresh/default config. Expected: the sidebar widget bar shows only terminal, files, agents, loom; no Wave AI button; no help widget. (Existing user configs override defaults, so test with defaults.)

- [ ] **Step 5: Stage**

```bash
git add pkg/wconfig/defaultconfig/widgets.json pkg/wconfig/defaultconfig/settings.json
```

---

## Final: measure the win and commit

- [ ] **Step 1: Confirm the combined startup reduction**

After Tasks 1 and 2, compare `du -h dist/frontend/assets/*.js | sort -rh | head` and the `index.html` eager list against the Task 0 baseline. Expected: ~22.6 MB of chunks (shiki + monaco + mermaid + cytoscape + katex) no longer preloaded at startup.

- [ ] **Step 2: Optional — real startup ms**

If a hard number is wanted, launch the packaged/dev app with devtools Performance and compare time-to-interactive before/after. Bytes already justify the change; this is confirmation only.

- [ ] **Step 3: Present diff and commit on approval**

Show `git status` + `git diff --staged`, propose a single commit message (e.g. `perf(startup): lazy-load monaco + streamdown; trim default widgets`), and commit only after the user approves (per Git policy).

---

## Self-review

**Spec coverage:**
- Spec Part 1a (lazy-load streamdown, ~14.8 MB) → Task 1. ✓
- Spec Part 1b (lazy-load monaco, ~7.8 MB, two entry points) → Task 2 (covers `monaco-react` boundary via codeeditor/diffviewer + the `codeeditor.tsx:8` and `preview-edit.tsx:11` type-only fixes). ✓
- Spec verification gate (rebuild, assert chunk absent from `index.html`) → Task 0 baseline + Task 1 Step 6 + Task 2 Step 5, with whoImportsTarget fallback. ✓
- Spec Part 2 (config-only declutter: widgets.json cockpit set + `app:hideaibutton`/`widget:showhelp`) → Task 3. ✓
- Spec risk "deferred chunk statically pulled elsewhere" → Task 1 Step 1 (importer check) + Task 2 Step 6 (whoImportsTarget). ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact code and exact commands. ✓

**Type consistency:** `WaveStreamdownProps` exported in Task 1 Step 2 and consumed in Step 3. Lazy named-export pattern `import(...).then((m) => ({ default: m.X }))` used identically for `WaveStreamdown`, `MonacoCodeEditor`, `MonacoDiffViewer`. `import type` applied consistently to `typeof`-only usages. ✓
