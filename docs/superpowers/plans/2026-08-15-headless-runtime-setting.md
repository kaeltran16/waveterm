# Headless Runtime Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `headless:runtime` setting that lets the user choose which engine (openrouter or an installed harness: pi, claude, codex, opencode) powers all background AI consults, with a compact Settings UI.

**Architecture:** One persisted setting read by a new resolver in `pkg/consult` (`HeadlessRuntime` / `HeadlessSpecForTier` / `HeadlessCorpusSpec`); every background consult call site routes through it instead of hardcoding `openrouter`. The Settings → Headless AI section gains a runtime selector with installation state, locks the OpenRouter-only model fields for harness runtimes, and collapses to a summary row.

**Tech Stack:** Go (wavesrv), React 19 + Tailwind 4 + jotai (frontend), generated TS/Go bindings via `task generate`.

**Spec:** `docs/superpowers/specs/2026-08-15-headless-runtime-setting-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- Unknown/empty `headless:runtime` must resolve to `openrouter` (unattended features never silently disable) — spec "Error Handling".
- Embeddings (`jarvisembed`) are out of scope — never touch `jarvis:embedbaseurl`/`jarvis:embedmodel` or the secret key — spec "Non-goals".
- `headless:runtime` is a wconfig type → run `task generate` after changing `pkg/wconfig`; never hand-edit generated files (`schema/settings.json`, `frontend/types/gotypes.d.ts`, `pkg/wconfig/metaconsts.go` is generated too).
- Tier→model mapping stays as `SpecForTier` already defines it: openrouter = configured tier IDs, claude = `--model` flags, pi/codex/opencode = no override.
- Corpus model selection uses `CorpusEscalationBytes` (400KB) and the pinned dated constants for claude — never substitute a floating alias.
- UI tokens only (`@theme` classes); no raw hex in components.
- Frontend typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (plain `npx tsc` stack-overflows).
- Go tests on this machine need `CGO_ENABLED=1 CC="zig cc" CGO_CFLAGS="-I<repo>/pkg/jarvisembed/csrc -fno-sanitize=undefined"` (no gcc installed; zig cc needs the sanitizer flag or the cgo link fails on `__ubsan_handle_*`).
- Commit rule: spec + plan docs fold into the feature commit they describe (AGENTS.md) — one final commit carries the collapsible UI + both docs.

---

### Task 1: Config key + schema (DONE — commit `6ae566a4`)

**Files:**
- Modify: `pkg/wconfig/metaconsts.go` (generated, via `task generate`)
- Modify: `pkg/wconfig/settingsconfig.go`
- Generated: `schema/settings.json`, `frontend/types/gotypes.d.ts`

**Evidence:** `ConfigKey_HeadlessRuntime = "headless:runtime"`; `SettingsType.HeadlessRuntime string json:"headless:runtime,omitempty"`; `schema/settings.json` and `gotypes.d.ts` carry `headless:runtime` after `task generate`; `TestSettingsKeysInSync` passes.

### Task 2: Resolver + call sites (DONE — commit `6ae566a4`)

**Files:**
- Modify: `pkg/consult/consult.go` (add `log` + `wconfig` imports; add `HeadlessRuntime`, `resolveHeadlessRuntime`, `HeadlessSpecForTier`, `HeadlessCorpusSpec` after `CorpusModel`)
- Modify: `pkg/consult/consult_test.go` (add `TestResolveHeadlessRuntime`, `TestHeadlessSpecForTier_defaultsToOpenRouter`, `TestHeadlessCorpusSpec_defaultsToOpenRouterCorpusModel`)
- Modify (one-line call-site swaps): `pkg/jarvis/classify.go`, `pkg/jarvis/decompose.go`, `pkg/jarviscontinuity/continuity.go`, `pkg/jarvisproactive/proactive.go`, `pkg/jarvisrecall/judge.go`, `pkg/jarvisrecall/recall.go`, `pkg/jarvisvolunteer/judge.go`, `pkg/memdistill/coordinator.go`, `pkg/memgarden/gardener.go` (uses `HeadlessCorpusSpec`), `pkg/reporadar/synth.go`, `pkg/wshrpc/wshserver/pititle.go`
- Modify: error strings in `pkg/jarviscontinuity/continuity.go`, `pkg/jarvisproactive/proactive.go`, `pkg/jarvisrecall/judge.go` + `recall.go` (var `errNoSynthesize`), `pkg/jarvisvolunteer/judge.go` (var `errNoRuntime`), `pkg/reporadar/synth.go` ("headless runtime not available"), plus `pkg/jarvisvolunteer/volunteer_test.go` (renamed var)

**Evidence:** `go test ./pkg/consult/ ./pkg/jarvis/ ./pkg/jarviscontinuity/ ./pkg/jarvisproactive/ ./pkg/jarvisrecall/ ./pkg/jarvisvolunteer/ ./pkg/memdistill/ ./pkg/memgarden/ ./pkg/reporadar/ ./pkg/wconfig/ ./pkg/wshrpc/wshserver/` — all ok.

### Task 3: Runtime selector UI (DONE — commit `6ae566a4`)

**Files:**
- Modify: `frontend/app/view/agents/settingssurface.tsx` — `HeadlessAISection` rewrite: radio-card runtime rows (openrouter pinned first with `default · key stored/missing` from the secret-store probe; harness rows via `harnessPickerItems(harnesses, effectiveRuntime, "consult")` from `./harnesspicker`, uninstalled rows disabled); `ConfigField`/`TextInput`/`SaveButton` gained optional `disabled` (Save replaced by an `openrouter only` tag when disabled); key warning gated on openrouter.

**Evidence:** tsc 0 errors, eslint clean, prettier clean, vitest `frontend/app/view/agents/` 1301 pass.

---

### Task 4: Collapsible section (IN PROGRESS — uncommitted)

**Files:**
- Modify: `frontend/app/view/agents/settingssurface.tsx` — `HeadlessAISection`
- Delete: `.ui-design/generated/compact.html` (stale scratch copy of the pre-collapsible preview; `index.html` remains the committed design artifact and is still accurate — it shows the expanded state)

**Interfaces:**
- Consumes: existing section state (`runtime`, `hasKey`, `harnesses`, `options`, `effectiveRuntime`), `ChevronRight` from `lucide-react`
- Produces: `HeadlessAISection` whose body is hidden behind a header button with `aria-expanded`, default collapsed; header right-aligned summary string from the `options` derivation

- [ ] **Step 1: Re-verify the current uncommitted state compiles**

The collapsible edit is already in `settingssurface.tsx` (header button with `ChevronRight` rotate-90 on open, `aria-expanded`, `summary` from the `options` derivation, body wrapped in `{open ? (...) : null}`). Run:

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
npx eslint frontend/app/view/agents/settingssurface.tsx
npx prettier --check frontend/app/view/agents/settingssurface.tsx
```

Expected: tsc exit 0, eslint clean, prettier clean (run `npx prettier --write` on the file if the check flags it, then re-run tsc).

- [ ] **Step 2: Run the surface test suite**

Run: `npx vitest run frontend/app/view/agents/`
Expected: all files pass (1301 tests baseline).

- [ ] **Step 3: Delete the stale preview scratch copy**

```bash
rm .ui-design/generated/compact.html
```

(The served previews — canvas :8765, generated :8766 — are standalone via `node .ui-design/serve.mjs`; no restart needed for a deletion.)

- [ ] **Step 4: Verify the section behavior in the running app**

Run the dev app (`task dev`) and open Settings → Headless AI. Expected: the section is one row — chevron + `HEADLESS AI` + summary (`OpenRouter · key stored` when the key exists; harness label + `installed`/`not installed` when a harness runtime is set). Click expands to the full selector + model fields; `aria-expanded` flips. When a harness runtime is selected, the header summary shows the harness and the expanded Models group is locked with `openrouter only` tags.

### Task 5: Final verification + commit

- [ ] **Step 1: Full backend test pass**

Run (zig CC env, see Global Constraints):

```bash
go test ./pkg/consult/ ./pkg/jarvis/ ./pkg/jarviscontinuity/ ./pkg/jarvisproactive/ ./pkg/jarvisrecall/ ./pkg/jarvisvolunteer/ ./pkg/memdistill/ ./pkg/memgarden/ ./pkg/reporadar/ ./pkg/wconfig/ ./pkg/wshrpc/wshserver/
```

Expected: all ok.

- [ ] **Step 2: Frontend gate**

Run tsc, eslint, prettier (all clean), then `npx vitest run frontend/app/view/agents/` (all pass).

- [ ] **Step 3: Commit docs + UI in one commit** (AGENTS.md: spec/plan fold into the feature commit they describe)

```bash
git add docs/superpowers/specs/2026-08-15-headless-runtime-setting-design.md docs/superpowers/plans/2026-08-15-headless-runtime-setting.md frontend/app/view/agents/settingssurface.tsx
git commit -m "feat(headless): collapse Headless AI settings to a summary row" -m "The runtime selector and model fields made the section ~750px tall. The section now folds to a chevron header with a right-aligned state summary (runtime + key/installed status), default collapsed, one click to expand. Spec and plan for the headless:runtime feature land with the UI change they describe."
```

Do NOT `git add -A` — the working tree carries unrelated untracked files (`docs/orca-vs-waveterm-comparison.md`, `docs/prototype/briefing-redesign-v2.html`, `docs/superpowers/*/2026-08-15-code-theme-sync-*`, `.ui-design/generated/orchestrate-*.html`, `.ui-design/serve.mjs`) that belong to other work.
