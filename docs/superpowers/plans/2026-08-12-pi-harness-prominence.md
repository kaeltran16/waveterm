# Pi Harness Prominence Implementation Plan (Meta Part A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Pi the default and promoted harness across cockpit surfaces (catalog order, new-agent pre-selection, run launch default, usage ordering, launch shortcut) while preserving every existing user selection.

**Architecture:** The Go harness catalog stays the single source of truth for runtime identity and order; the frontend adds one pure helper (`resolveDefaultRuntime`) that picks the preferred runtime for launch paths when the user has no persisted preference, falling back to Pi (or the first installed harness). All changes are ordering/selection defaults — no harness behavior changes, no backend protocol changes. One new keyboard shortcut launches a Pi tab directly.

**Tech Stack:** Go (catalog), React 19 + jotai + Tailwind 4 (frontend), Vitest, Go tests.

**Spec:** [`docs/superpowers/specs/2026-08-11-pi-main-harness-meta-design.md`](../specs/2026-08-11-pi-main-harness-meta-design.md) Part A. Read it before starting.

## Global Constraints

- Every harness other than the ordering/preselection change must remain fully functional and unchanged.
- Defaults apply to **new sessions and fresh installs only**; existing user selections are preserved. Never overwrite a persisted `harness:preferredruntime`.
- Runtime IDs and executable names stay lowercase (`pi`, `claude`, ...). Visible labels stay `Pi`, `Claude Code`, etc.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows on this repo; baseline exit 0).
- Go tests for `pkg/harness/...` need no CGO workaround; `pkg/wshrpc/...` tests need the CGO_CFLAGS env from the Taskfile (`build:server:internal` sets it; see CLAUDE.md for the PowerShell one-liner).
- Git: no commits without explicit user approval. Checkpoints use `git status` / `git diff`. One batched commit at the end, only after approval.
- Go files must pass `gofmt -l` (zero output); run `gofmt -w` after writing.
- Colors come from `@theme` tokens (`frontend/tailwindsetup.css`), never raw hex in components.

---

## File Map

**Principal modified files**

- `pkg/harness/catalog.go` — reorder `pi` to the head of the catalog.
- `pkg/harness/catalog_test.go` — update order assertions.
- `frontend/app/view/agents/harnessstore.ts` — add `resolveDefaultRuntime` pure helper.
- `frontend/app/view/agents/harnessstore.test.ts` — tests for the helper.
- `frontend/app/view/agents/newagentmodal.tsx` — pre-select Pi on first open when no preference.
- `frontend/app/cockpit/command-palette.tsx` — run-launch default via `resolveDefaultRuntime`.
- `frontend/app/view/agents/usagesurface.tsx` — order usage harness filter options by catalog.
- `frontend/app/cockpit/cockpit-actions.ts` — add `launchPiTab(model)` helper.
- `frontend/app/store/keybindings/bindings.ts` — new `launch:pi` binding.

No new backend files. No generated-file edits.

---

### Task 1: Catalog order (Go)

**Files:**
- Modify: `pkg/harness/catalog.go:35-41` (the `specs` slice)
- Modify: `pkg/harness/catalog_test.go:26,39` (order assertions)
- Test: `pkg/harness/catalog_test.go`

**Interfaces:**
- Consumes: none.
- Produces: `harness.List()` returns Pi first. The FE derives its harness list order from this (via the existing probe command), so picker/chart ordering follows for free.

- [ ] **Step 1: Update the failing order assertions first**

In `pkg/harness/catalog_test.go`, change the probe-order list at line 26 and the expected order at line 39 from `{"claude", "codex", "opencode", "pi", "antigravity"}` to `{"pi", "claude", "codex", "opencode", "antigravity"}`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/harness/...`
Expected: FAIL — order mismatch (catalog still lists claude first).

- [ ] **Step 3: Reorder the catalog**

In `pkg/harness/catalog.go`, move the `pi` entry to the head of the `specs` slice:

```go
var specs = []Spec{
	{Runtime: "pi", Bin: "pi", Label: "Pi", ConsultCapable: true, RunWorkerCapable: true},
	{Runtime: "claude", Bin: "claude", Label: "Claude Code", ConsultCapable: true, RunWorkerCapable: true},
	{Runtime: "codex", Bin: "codex", Label: "Codex", ConsultCapable: true, RunWorkerCapable: true},
	{Runtime: "opencode", Bin: "opencode", Label: "OpenCode", ConsultCapable: true, RunWorkerCapable: true},
	{Runtime: "antigravity", Bin: "agy", Label: "Antigravity", ConsultCapable: true, RunWorkerCapable: true},
}
```

Also update the package doc comment (line 4-7) to list Pi first: "…(Claude Code, Codex, OpenCode, Antigravity)" → "…(Pi, Claude Code, Codex, OpenCode, Antigravity)".

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/harness/...`
Expected: PASS. Also `gofmt -l pkg/harness/` → zero output.

- [ ] **Step 5: Checkpoint**

Run: `git status` and `git diff --stat` and stop for review.

---

### Task 2: `resolveDefaultRuntime` helper (frontend, pure)

**Files:**
- Modify: `frontend/app/view/agents/harnessstore.ts`
- Test: `frontend/app/view/agents/harnessstore.test.ts`

**Interfaces:**
- Consumes: `HarnessInfo` (shape already imported in `harnessstore.ts`: has `runtime`, `installed`, `runworkercapable`), `harnessPreferenceAtom`.
- Produces:

```ts
// pick the runtime to pre-select for launch paths: an explicit preference wins when its harness
// is installed and run-worker-capable; otherwise pi if installed; otherwise the first installed
// run-worker-capable harness; otherwise "" (caller blocks, mirroring today's guard).
export function resolveDefaultRuntime(pref: string, harnesses: HarnessInfo[]): string
```

- [ ] **Step 1: Write the failing tests**

Append to `frontend/app/view/agents/harnessstore.test.ts`:

```ts
import { resolveDefaultRuntime } from "./harnessstore";

const h = (runtime: string, installed = true, runworkercapable = true): HarnessInfo =>
    ({ runtime, installed, runworkercapable }) as HarnessInfo;

describe("resolveDefaultRuntime", () => {
    const harnesses = [h("claude"), h("codex"), h("pi"), h("opencode"), h("antigravity")];

    it("prefers an explicit installed preference", () => {
        expect(resolveDefaultRuntime("codex", harnesses)).toBe("codex");
    });

    it("falls back to pi when no preference exists", () => {
        expect(resolveDefaultRuntime("", harnesses)).toBe("pi");
    });

    it("ignores a preference whose harness is not installed", () => {
        expect(resolveDefaultRuntime("pi", [h("claude"), h("codex")])).toBe("claude");
    });

    it("returns the first installed harness when pi is absent", () => {
        expect(resolveDefaultRuntime("", [h("claude"), h("codex")])).toBe("claude");
    });

    it("returns empty when nothing is installed", () => {
        expect(resolveDefaultRuntime("", [h("pi", false)])).toBe("");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/harnessstore.test.ts`
Expected: FAIL — `resolveDefaultRuntime` is not exported.

- [ ] **Step 3: Implement the helper**

In `frontend/app/view/agents/harnessstore.ts`, add after `harnessesAtom`:

```ts
// resolveDefaultRuntime picks the runtime to pre-select for launch paths. An explicit preference
// wins when its harness is installed and run-worker-capable; otherwise pi when installed; otherwise
// the first installed run-worker-capable harness; otherwise "" so the caller blocks (mirrors the
// current "no valid harness" guard).
export function resolveDefaultRuntime(pref: string, harnesses: HarnessInfo[]): string {
    if (pref && harnesses.some((h) => h.runtime === pref && h.installed && h.runworkercapable)) {
        return pref;
    }
    const first = harnesses.find((h) => h.installed && h.runworkercapable);
    return first ? first.runtime : "";
}
```

Note: `first` is pi whenever pi is installed (catalog order, Task 1), which is exactly the meta's fallback: an explicit preference wins, else pi, else the first installed harness.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/harnessstore.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Checkpoint**

Run: `git status` and stop for review.

---

### Task 3: New-agent modal pre-selects Pi

**Files:**
- Modify: `frontend/app/view/agents/newagentmodal.tsx`

**Interfaces:**
- Consumes: `resolveDefaultRuntime` (Task 2), `harnessPreferenceAtom` + `harnessesAtom` from `harnessstore.ts`, `runtimeStartupCommand` already imported from `./launch`.
- Produces: on first open with no preference, the modal's runtime (and its startup command) default to Pi instead of Claude.

- [ ] **Step 1: Add the imports and the first-open default effect**

In `newagentmodal.tsx`, add to the existing `harnessstore` import (the file already imports `naFlagsAtom` from `./naflagsstore`; check the top of the file for the current import line and extend it):

```ts
import { harnessPreferenceAtom, harnessesAtom, resolveDefaultRuntime } from "./harnessstore";
```

In the component body, after the `useRef` declarations (near line 50-51 where `const [runtime, setRuntime] = useState<Runtime>("claude");` and `const [startup, setStartup] = useState("claude");` live), add a first-open default effect. It must apply only once (the modal stays mounted; state survives close/reopen):

```ts
const defaultAppliedRef = useRef(false);
// Default the modal's runtime to the resolved harness preference on first open (Part A: Pi wins
// for fresh installs / new sessions). Later opens keep whatever the user last picked in this modal.
useEffect(() => {
    if (!open || defaultAppliedRef.current) {
        return;
    }
    defaultAppliedRef.current = true;
    const pref = globalStore.get(harnessPreferenceAtom).runtime;
    const chosen = resolveDefaultRuntime(pref, globalStore.get(harnessesAtom));
    if (chosen) {
        setRuntime(chosen as Runtime);
        setStartup(runtimeStartupCommand(chosen));
    }
}, [open]);
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Checkpoint**

Run: `git status` and stop for review.

---

### Task 4: Run-launch default in the command palette

**Files:**
- Modify: `frontend/app/cockpit/command-palette.tsx:286`

**Interfaces:**
- Consumes: `resolveDefaultRuntime` (Task 2).
- Produces: the palette's Quick/Run dispatch uses Pi (or the preference) instead of blocking with no preference.

- [ ] **Step 1: Replace the runtime guard**

In `command-palette.tsx`, the line

```ts
const runtime = pref.runtime && harnesses.some((h) => h.runtime === pref.runtime && h.installed && h.runworkercapable) ? pref.runtime : "";
```

becomes

```ts
const runtime = resolveDefaultRuntime(pref.runtime, harnesses);
```

Add the import at the top of the file (extend the existing `harnessstore` import or add a new one):

```ts
import { resolveDefaultRuntime } from "@/app/view/agents/harnessstore";
```

The `guarded` closure below still blocks when `runtime === ""` — unchanged.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Checkpoint**

Run: `git status` and stop for review.

---

### Task 5: Usage dashboard harness ordering

**Files:**
- Modify: `frontend/app/view/agents/usagesurface.tsx`

**Interfaces:**
- Consumes: `harnessesAtom` (`HarnessInfo[]`, catalog-ordered after Task 1).
- Produces: the usage harness filter/chart options are shown in catalog order (Pi first) instead of data-presence order.

- [ ] **Step 1: Add the catalog-order sort**

In `usagesurface.tsx`, the filter options and chart iterate `allStats.availableHarnesses` (see the `chartHarnesses` derivation at line 347 and the filter row at lines ~454-468). Derive one ordered list once, above the filter row:

```ts
const harnesses = useAtomValue(harnessesAtom);
// catalog order wins for display; keep pi first even before usage data exists
const orderedHarnesses = useMemo(() => {
    const cat = harnesses.map((h) => h.runtime);
    return [...allStats.availableHarnesses].sort(
        (a, b) => cat.indexOf(a) - cat.indexOf(b) || (a < b ? -1 : 1)
    );
}, [allStats.availableHarnesses, harnesses]);
```

Replace the two iterations over `allStats.availableHarnesses` (the chart at line 347 and the filter option list) with `orderedHarnesses`. `useMemo` and `useAtomValue` are already imported in this file; add `harnessesAtom` to the `harnessstore` import if not already present.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Checkpoint**

Run: `git status` and stop for review.

---

### Task 6: Launch-Pi shortcut

**Files:**
- Modify: `frontend/app/cockpit/cockpit-actions.ts`
- Modify: `frontend/app/store/keybindings/bindings.ts`

**Interfaces:**
- Consumes: `launchAgent(model, LaunchAgentOpts)` (already in `cockpit-actions.ts`), `resolveCwd` from `@/app/view/agents/agentcwdresolve`, `projectsAtom` + `LaunchCandidate` from `@/app/view/agents/projectsstore`, `runtimeStartupCommand` from `@/app/view/agents/launch`, `model.newAgentOpenAtom`.
- Produces: `launchPiTab(model: AgentsViewModel): Promise<void>` — launches a Pi tab at the focused agent's cwd (fallback: first registered project); opens the new-agent modal when no cwd can be resolved. Binding `launch:pi` on `Ctrl+Shift:n`.

- [ ] **Step 1: Implement `launchPiTab`**

In `cockpit-actions.ts`, add:

```ts
// launchPiTab launches a Pi tab at the focused agent's cwd (fallback: first registered project),
// mirroring the new-agent modal's launch shape. No resolvable cwd -> open the modal instead.
export async function launchPiTab(model: AgentsViewModel): Promise<void> {
    const focused = model.agentsAtom
        ? model.agents.find((a) => a.id === model.focusedAgentId) ?? null
        : null;
    let cwd: string | null = null;
    if (focused?.transcriptPath) {
        cwd = await resolveCwd(focused.transcriptPath, focused.blockId);
    }
    if (!cwd) {
        const projects = globalStore.get(projectsAtom);
        cwd = projects.find((p) => p.path)?.path ?? null;
    }
    if (!cwd) {
        globalStore.set(model.newAgentOpenAtom, true);
        return;
    }
    const projectName = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
    await launchAgent(model, {
        runtime: "pi",
        startupCommand: runtimeStartupCommand("pi"),
        task: "",
        projectPath: cwd,
        projectName,
    });
}
```

Check the roster entry type used by `model.agentsAtom` at implementation time (it is the same entry shape `sessionssurface.tsx` reads for `launchAgent`) and adjust the field names (`transcriptPath`, `blockId`, `focusedAgentId`) to the exact `AgentsViewModel` accessors — `railstore.ts` `loadRailForAgent` is the reference for `resolveCwd(transcriptPath, blockId)` usage.

- [ ] **Step 2: Add the binding**

In `bindings.ts`, next to the `new-agent` entry (around line 182):

```ts
{
    id: "launch:pi",
    keys: "Ctrl:Shift:n",
    group: "Global",
    label: "Launch Pi tab",
    run: () => void launchPiTab(model),
},
```

Add `launchPiTab` to the imports from `@/app/cockpit/cockpit-actions` (verify the existing import line — `confirmCloseSession` is imported from there today; extend it).

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Checkpoint**

Run: `git status` and stop for review.

---

## Self-Review (run after writing; fix inline)

- **Spec coverage (meta Part A):**
  - Catalog order → Task 1. Agent picker pre-selection → Task 3. Channel `@pi` unchanged (no code). Background worker default → Task 4 (run launch path) + note below. Consult default → Task 4 (consult shares the launch path: palette `consult:` action calls `sendText("ask @${runtime} ...")` where `runtime` now resolves to pi). Usage dashboard ordering → Task 5. Launch shortcut → Task 6.
  - **Backend legacy fallbacks intentionally unchanged:** `EnsureWorkers` (`pkg/jarvis/runexec.go`, empty legacy runtime → `"claude"`) and child-run default (`pkg/wshrpc/wshserver/wshserver_runs.go:353-354`, empty → `"claude"`) apply only to legacy runs created before the runtime field existed — not "new sessions", so the meta's "new sessions only" rule keeps them as-is. Documented here so no implementer "fixes" them.
- **Placeholder scan:** no TBD/TODO; all code blocks are complete.
- **Type consistency:** `resolveDefaultRuntime(pref: string, harnesses: HarnessInfo[])` is defined in Task 2 and consumed identically in Tasks 3, 4, 6. `launchPiTab(model)` defined in Task 6 Step 1, consumed in Step 2. No renamed identifiers across tasks.
