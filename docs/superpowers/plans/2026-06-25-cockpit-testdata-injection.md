# Cockpit Test-Data Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the cockpit two dev-only ways to be populated with fake agents — a runtime FE mock (write a fixture file → reload) and a live-pipeline injector (drive real blocks via `wsh`) — both driven by one shared set of scenarios.

**Architecture:** A single source of fake rosters lives in `scripts/cockpit-fixtures/scenarios.mjs` (each scenario is a `(now) => record[]` function). A generator script writes a chosen scenario to `public/cockpit-fixtures/active.json`; the cockpit, in dev only, fetches that file on boot and uses it as the roster instead of the live one. A second script creates real terminal blocks with `wsh createblock`, drives them with `wsh agentstatus`/`wsh ask`, and writes fake transcript JSONL so the live rendering path animates them.

**Tech Stack:** Node ESM (`.mjs`, repo is `"type":"module"`), Vitest (node environment), jotai, Vite (serves `public/` at `/`), the `wsh` CLI.

---

## ⚠️ Concurrency note (read first)

A parallel agent is implementing the **handoff-parity** spec in this same working tree (it touches the cockpit chrome, `navrail.tsx`, `cockpitsurface.tsx`, `agentrow.tsx`, and possibly `agents.tsx`). To minimize conflicts, **all of this plan's frontend changes are confined to new files plus exactly one edited file: `agents.tsx`** (and only its mock-roster import + the two constructor lines). The dev-mock loader is invoked from the model constructor — **not** from `cockpit-root.tsx` or `main.tsx`, which the parity agent is editing. Before committing, re-check `git status`/branch per the user's shared-tree rule and rebase/merge `agents.tsx` carefully.

**Git rule (user override):** do NOT commit without explicit approval; batch into as few commits as the user approves. The `Commit` steps below are checkpoints — **stage the files, show the diff + a `type(scope): subject` message, and ask for approval** rather than committing autonomously. Spec/plan docs fold into the feature commit they describe (no docs-only commit).

## Scope / phasing

Two independent subsystems share one foundation. The plan is phased so each later phase is independently shippable:

- **Phase 1 — Scenarios + validator** (shared foundation). Pure node; the only unit-tested code.
- **Phase 2 — Runtime FE mock** (depends on Phase 1). The high-value path that unblocks the parity agent's visual verification. Shippable on its own.
- **Phase 3 — Live-pipeline injector** (depends on Phase 1). Independently shippable; can be deferred to a later session without affecting Phases 1–2.

## File structure

| File | Responsibility | Phase |
|---|---|---|
| `scripts/cockpit-fixtures/validate.mjs` | `validateScenario(records)` — runtime shape check shared by the test + generator | 1 |
| `scripts/cockpit-fixtures/scenarios.mjs` | `SCENARIOS` map; each entry `(now) => record[]`. Single source for both mechanisms | 1 |
| `scripts/cockpit-fixtures/scenarios.test.mjs` | Vitest: every scenario validates; per-scenario invariants | 1 |
| `frontend/app/view/agents/devmock.ts` | `devMockAgentsAtom`, `devRosterAtom`, `loadDevMockRoster()` — dev-only runtime roster source | 2 |
| `frontend/types/media.d.ts` | **edit**: augment `ImportMeta` with `env` so `import.meta.env.DEV` typechecks | 2 |
| `frontend/app/view/agents/agents.tsx` | **edit**: select `devRosterAtom` in dev + kick the loader; drop the dead `USE_MOCK_AGENTS` path | 2 |
| `frontend/app/view/agents/mockagents.ts` | **delete**: roster content moves into the `mixed` scenario | 2 |
| `scripts/gen-cockpit-fixtures.mjs` | CLI: write a scenario to `public/cockpit-fixtures/active.json`, or clear it | 2 |
| `.gitignore` | **edit**: ignore `public/cockpit-fixtures/active.json` | 2 |
| `package.json` | **edit**: add a `cockpit:fixtures` script alias | 2 |
| `scripts/inject-live-agents.mjs` | CLI: create blocks via `wsh`, drive status/ask, write fake transcripts; `--clear` tears down | 3 |

---

## Phase 1 — Scenarios + validator

### Task 1: Scenario validator

**Files:**
- Create: `scripts/cockpit-fixtures/validate.mjs`
- Test: `scripts/cockpit-fixtures/scenarios.test.mjs` (the failing test in this task targets the validator directly)

- [ ] **Step 1: Write the failing test**

Create `scripts/cockpit-fixtures/scenarios.test.mjs`:

```js
import { describe, expect, test } from "vitest";
import { validateScenario } from "./validate.mjs";

describe("validateScenario", () => {
    test("accepts a minimal valid roster", () => {
        const r = validateScenario([{ id: "a", name: "alpha", state: "working" }]);
        expect(r.ok).toBe(true);
        expect(r.errors).toEqual([]);
    });

    test("rejects a bad state, missing id, and duplicate id", () => {
        const r = validateScenario([
            { id: "a", name: "alpha", state: "nope" },
            { name: "no-id", state: "idle" },
            { id: "a", name: "dupe", state: "idle" },
        ]);
        expect(r.ok).toBe(false);
        expect(r.errors.length).toBeGreaterThanOrEqual(3);
    });

    test("rejects an asking agent whose ask has an empty questions array", () => {
        const r = validateScenario([{ id: "a", name: "alpha", state: "asking", ask: { questions: [] } }]);
        expect(r.ok).toBe(false);
    });

    test("allows an asking agent with no ask (plain-text question)", () => {
        const r = validateScenario([{ id: "a", name: "alpha", state: "asking" }]);
        expect(r.ok).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/cockpit-fixtures/scenarios.test.mjs`
Expected: FAIL — `Failed to resolve import "./validate.mjs"` (file does not exist yet).

- [ ] **Step 3: Write the validator**

Create `scripts/cockpit-fixtures/validate.mjs`:

```js
// Runtime shape check for fixture rosters. Shared by the scenario test and the generator so a
// malformed fixture can never be written/served. Mirrors the fields the cockpit grid relies on
// (frontend/app/view/agents/agentsviewmodel.ts: AgentVM). No type imports — plain runtime checks.

const STATES = new Set(["asking", "working", "idle"]);

export function validateScenario(records) {
    if (!Array.isArray(records)) {
        return { ok: false, errors: ["scenario is not an array"] };
    }
    const errors = [];
    const seen = new Set();
    records.forEach((r, i) => {
        const at = `[${i}]`;
        if (typeof r?.id !== "string" || r.id === "") {
            errors.push(`${at} id must be a non-empty string`);
        } else if (seen.has(r.id)) {
            errors.push(`${at} duplicate id ${r.id}`);
        } else {
            seen.add(r.id);
        }
        if (typeof r?.name !== "string" || r.name === "") {
            errors.push(`${at} name must be a non-empty string`);
        }
        if (!STATES.has(r?.state)) {
            errors.push(`${at} state must be asking|working|idle (got ${JSON.stringify(r?.state)})`);
        }
        // ask is optional even for asking agents (plain-text questions); validate shape only if present
        if (r?.ask !== undefined) {
            const qs = r.ask?.questions;
            if (!Array.isArray(qs) || qs.length === 0) {
                errors.push(`${at} ask.questions must be a non-empty array`);
            } else {
                qs.forEach((q, qi) => {
                    if (typeof q?.question !== "string" || q.question === "") {
                        errors.push(`${at}.questions[${qi}] question must be a non-empty string`);
                    }
                    if (q?.options !== undefined) {
                        if (!Array.isArray(q.options)) {
                            errors.push(`${at}.questions[${qi}] options must be an array`);
                        } else {
                            q.options.forEach((o, oi) => {
                                if (typeof o?.label !== "string" || o.label === "") {
                                    errors.push(`${at}.questions[${qi}].options[${oi}] label must be a non-empty string`);
                                }
                            });
                        }
                    }
                });
            }
        }
    });
    return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/cockpit-fixtures/scenarios.test.mjs`
Expected: PASS (4 tests). (The scenario-specific tests added in Task 2 will fail until then — that's expected; this task only asserts the validator.)

- [ ] **Step 5: Commit (checkpoint — stage + request approval)**

```bash
git add scripts/cockpit-fixtures/validate.mjs scripts/cockpit-fixtures/scenarios.test.mjs
# proposed: test(cockpit): add fixture-scenario validator
```

### Task 2: Scenario definitions

**Files:**
- Create: `scripts/cockpit-fixtures/scenarios.mjs`
- Modify: `scripts/cockpit-fixtures/scenarios.test.mjs` (add scenario-coverage tests)
- Source to port: `frontend/app/view/agents/mockagents.ts:56-269` (the `mockAgentsAtom` array literal)

- [ ] **Step 1: Add the failing scenario tests**

Append to `scripts/cockpit-fixtures/scenarios.test.mjs`:

```js
import { SCENARIOS } from "./scenarios.mjs";

const FIXED_NOW = 1_700_000_000_000;

describe("SCENARIOS", () => {
    test("every scenario produces a valid roster", () => {
        for (const [name, build] of Object.entries(SCENARIOS)) {
            const r = validateScenario(build(FIXED_NOW));
            expect(r.ok, `${name}: ${r.errors.join("; ")}`).toBe(true);
        }
    });

    test("mixed has all three states", () => {
        const states = new Set(SCENARIOS.mixed(FIXED_NOW).map((a) => a.state));
        expect(states.has("asking")).toBe(true);
        expect(states.has("working")).toBe(true);
        expect(states.has("idle")).toBe(true);
    });

    test("all-asking is non-empty and entirely asking", () => {
        const roster = SCENARIOS["all-asking"](FIXED_NOW);
        expect(roster.length).toBeGreaterThan(0);
        expect(roster.every((a) => a.state === "asking")).toBe(true);
    });

    test("empty is an empty array", () => {
        expect(SCENARIOS.empty(FIXED_NOW)).toEqual([]);
    });

    test("relative time fields resolve against now", () => {
        const idle = SCENARIOS.mixed(FIXED_NOW).find((a) => a.idleSince != null);
        expect(idle.idleSince).toBeLessThanOrEqual(FIXED_NOW);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/cockpit-fixtures/scenarios.test.mjs`
Expected: FAIL — `Failed to resolve import "./scenarios.mjs"`.

- [ ] **Step 3: Write the scenarios**

Create `scripts/cockpit-fixtures/scenarios.mjs`. Each scenario is a `(now) => record[]` function so time-relative fields (`idleSince`) resolve at generation time. Records are plain objects shaped like `AgentVM`.

**Port `mixed` from `mockagents.ts`:** copy the array literal currently at `mockagents.ts:56-269` into the body of `mixed(now)` below, then apply these transforms:
1. The module in `mockagents.ts` computes `const NOW = Date.now()` once. Here, use the `now` parameter instead — replace every `NOW` with `now`.
2. The `usage` field `fivehourreset`/`weekreset` use `Math.floor(NOW / 1000) + N` — change to `Math.floor(now / 1000) + N`.
3. `idleSince: NOW - 30_000` → `idleSince: now - 30_000` (and the `now - 600_000` one).
4. Add a `replySuggestions` array to one or two asking agents (the handoff-parity card chips read it), e.g. on `mock-ask-noopts` (which has no structured options): `ask: { questions: [{ question: "Implement the 3 stubbed scenarios now?", options: [] }] }` is **not** needed — instead give it `replySuggestions: ["Yes, implement them", "No, leave stubbed", "Show me the stubs first"]` at the top level of the record (the parity spec adds `replySuggestions?: string[]` to the card model; the validator ignores unknown fields).

The skeleton:

```js
// Single source of fake cockpit rosters. Consumed by both gen-cockpit-fixtures.mjs (FE mock)
// and inject-live-agents.mjs (live pipeline). Each scenario is (now) => record[]; records are
// AgentVM-shaped (frontend/app/view/agents/agentsviewmodel.ts). Kept in sync via validate.mjs.

function mixed(now) {
    return [
        // <-- paste the mockagents.ts:56-269 array literal here, with NOW -> now (see transforms above)
    ];
}

function allAsking(now) {
    const base = (id, name, project, question, options) => ({
        id,
        name,
        task: question,
        state: "asking",
        model: "sonnet",
        blockedMs: 60_000,
        blockId: `fake-blk-${id}`,
        previousInfo: [{ kind: "message", text: `Working in ${project}; need a decision.` }],
        ask: { askId: id, oref: `block:fake-blk-${id}`, questions: [{ question, options }] },
    });
    return [
        base("aa-1", "siem", "siem-platform", "Which detector to build next?", [
            { label: "DNS tunneling (Recommended)", description: "highest net-new value" },
            { label: "Beaconing" },
            { label: "Lateral movement" },
        ]),
        base("aa-2", "loom", "waveterm", "Run the full suite before merge?", [{ label: "Yes" }, { label: "No, unit only" }]),
        base("aa-3", "obsidian", "vault", "Keep local or remote note?", [{ label: "Local" }, { label: "Remote" }]),
        base("aa-4", "planner", "release", "Cut 0.15 now?", [{ label: "Cut now" }, { label: "Wait for tabbed asks" }]),
        base("aa-5", "migrator", "config", "Back up before migrating?", [{ label: "Snapshot first" }, { label: "In place" }]),
    ];
}

function heavy(now) {
    const states = ["working", "working", "asking", "idle"];
    const projects = ["waveterm", "siem-platform", "vault"];
    return Array.from({ length: 12 }, (_, i) => {
        const state = states[i % states.length];
        const id = `heavy-${i}`;
        const project = projects[i % projects.length];
        const rec = {
            id,
            name: `agent-${i}`,
            task: `Task ${i} in ${project}`,
            state,
            model: ["opus", "sonnet", "haiku"][i % 3],
            blockId: `fake-blk-${id}`,
            previousInfo: Array.from({ length: 6 }, (_, k) =>
                k % 2 === 0
                    ? { kind: "message", text: `Step ${k} of task ${i}: reasoning about the change.` }
                    : { kind: "action", verb: "ran", target: `go test ./pkg/x${k}/...`, outcome: k % 4 === 1 ? "fail" : "ok" }
            ),
        };
        if (state === "working") {
            rec.activeMs = 30_000 + i * 5_000;
        } else if (state === "idle") {
            rec.idleSince = now - (i + 1) * 60_000;
        } else {
            rec.blockedMs = 45_000;
            rec.ask = { askId: id, oref: `block:fake-blk-${id}`, questions: [{ question: `Proceed with task ${i}?`, options: [{ label: "Yes" }, { label: "No" }] }] };
        }
        return rec;
    });
}

function empty() {
    return [];
}

export const SCENARIOS = {
    mixed,
    "all-asking": allAsking,
    heavy,
    empty,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/cockpit-fixtures/scenarios.test.mjs`
Expected: PASS (all tests, including the Task 1 validator tests).

- [ ] **Step 5: Commit (checkpoint — stage + request approval)**

```bash
git add scripts/cockpit-fixtures/scenarios.mjs scripts/cockpit-fixtures/scenarios.test.mjs
# proposed: feat(cockpit): add shared fixture scenarios (mixed/all-asking/heavy/empty)
```

---

## Phase 2 — Runtime FE mock

### Task 3: Dev-mock roster source

**Files:**
- Create: `frontend/app/view/agents/devmock.ts`

`chooseRoster` is a one-line ternary (`devMock != null ? devMock : live`) — trivial by inspection, not separately unit-tested. The meaningful behavior (fetch + atom wiring) is verified by the Task 6 smoke test + tsc + vite build.

- [ ] **Step 1: Write the module**

Create `frontend/app/view/agents/devmock.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY runtime roster source. When public/cockpit-fixtures/active.json exists (written by
// scripts/gen-cockpit-fixtures.mjs), the cockpit uses it instead of the live roster. Reload the
// dev app to pick up a newly-written fixture. Never active in a production build: the only caller
// gates on import.meta.env.DEV, so this module tree-shakes out.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type Atom } from "jotai";
import type { AgentVM } from "./agentsviewmodel";
import { liveAgentsAtom } from "./liveagents";

const FIXTURE_URL = "/cockpit-fixtures/active.json";

// null = no fixture loaded -> fall through to the live roster. A non-null array (INCLUDING []) means
// a fixture is active and fully replaces the live roster, so the "empty" scenario renders the empty state.
export const devMockAgentsAtom = atom<AgentVM[] | null>(null);

export function chooseRoster(devMock: AgentVM[] | null, live: AgentVM[]): AgentVM[] {
    return devMock != null ? devMock : live;
}

export const devRosterAtom: Atom<AgentVM[]> = atom((get) => chooseRoster(get(devMockAgentsAtom), get(liveAgentsAtom)));

// Fetch the active fixture once at boot. Absent file / parse error / SPA fallback -> leave the atom
// null (live path). Safe to call unconditionally in dev; it no-ops when no fixture is present.
export async function loadDevMockRoster(): Promise<void> {
    try {
        const res = await fetch(FIXTURE_URL, { cache: "no-store" });
        if (!res.ok) {
            return;
        }
        const data = await res.json();
        if (Array.isArray(data)) {
            globalStore.set(devMockAgentsAtom, data as AgentVM[]);
        }
    } catch {
        // no fixture served (or the dev server returned index.html) -> stay on the live roster
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors (baseline is 3 pre-existing errors in `frontend/tauri/api.test.ts`).

- [ ] **Step 3: Commit (checkpoint — stage + request approval)**

```bash
git add frontend/app/view/agents/devmock.ts
# proposed: feat(cockpit): add dev-only runtime mock roster source
```

### Task 4: Wire the model to the runtime mock; remove the compile-time mock

**Files:**
- Modify: `frontend/types/media.d.ts` (type `import.meta.env`)
- Modify: `frontend/app/view/agents/agents.tsx` (imports + constructor)
- Delete: `frontend/app/view/agents/mockagents.ts`

> **Prerequisite:** Task 2 must be complete — it ports the `mixed` roster out of `mockagents.ts` before Step 3 deletes that file.

- [ ] **Step 1: Type `import.meta.env`**

`media.d.ts` augments `ImportMeta` with `glob` only, and tsconfig does not pull in `vite/client` — so `import.meta.env.DEV` would fail tsc with TS2339. Extend the existing `interface ImportMeta` augmentation in `frontend/types/media.d.ts` (the block near the bottom that already declares `glob<T>(...)`) by adding an `env` member:

```ts
    readonly env: {
        readonly DEV: boolean;
        readonly PROD: boolean;
        readonly MODE: string;
        readonly [key: string]: unknown;
    };
```

(Add it inside the existing `interface ImportMeta { ... }` block, alongside the `glob` overloads — do not create a second `ImportMeta` block.)

- [ ] **Step 2: Edit `agents.tsx` imports**

Remove these two lines:

```ts
import { getApi } from "@/app/store/global";
```
```ts
import { mockAgentsAtom, USE_MOCK_AGENTS } from "./mockagents";
```

(`getApi` was used only for the mock gate; confirm no other use remains in the file before deleting its import.) Add:

```ts
import { devRosterAtom, loadDevMockRoster } from "./devmock";
```

- [ ] **Step 3: Edit the constructor**

Replace the current line:

```ts
        // DEV-only: swap in the throwaway mock roster (see mockagents.ts). Never active in a prod build.
        this.agentsAtom = USE_MOCK_AGENTS && getApi().getIsDev() ? mockAgentsAtom : liveAgentsAtom;
```

with:

```ts
        // DEV-only: runtime mock roster from public/cockpit-fixtures/active.json (see devmock.ts +
        // scripts/gen-cockpit-fixtures.mjs). import.meta.env.DEV is build-time, so prod always uses live.
        if (import.meta.env.DEV) {
            void loadDevMockRoster();
            this.agentsAtom = devRosterAtom;
        } else {
            this.agentsAtom = liveAgentsAtom;
        }
```

- [ ] **Step 4: Delete the dead mock module**

```bash
git rm frontend/app/view/agents/mockagents.ts
```

- [ ] **Step 5: Typecheck and run the full FE test suite**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: 3 baseline errors only (no new errors; in particular no "mockagents" or "getApi" unresolved/unused errors).

Run: `npx vitest run`
Expected: PASS (existing suite + the Phase 1 scenario tests). No test imported `mockagents.ts` (verified: only `agents.tsx` did).

- [ ] **Step 6: Verify the import graph stays acyclic**

Run: `npx vite build --config frontend/tauri/vite.config.ts`
Expected: build succeeds (proves `devmock.ts` didn't introduce an import cycle).

- [ ] **Step 7: Commit (checkpoint — stage + request approval)**

```bash
git add frontend/types/media.d.ts frontend/app/view/agents/agents.tsx
# (the git rm of mockagents.ts is already staged)
# proposed: refactor(cockpit): replace compile-time mock with runtime dev roster
```

### Task 5: Fixture generator script

**Files:**
- Create: `scripts/gen-cockpit-fixtures.mjs`
- Modify: `.gitignore`
- Modify: `package.json` (script alias)

- [ ] **Step 1: Write the generator**

Create `scripts/gen-cockpit-fixtures.mjs`:

```js
// Write a fixture scenario to public/cockpit-fixtures/active.json (served by Vite at
// /cockpit-fixtures/active.json in dev). Reload the dev app to inject it. Run from the repo root:
//   node scripts/gen-cockpit-fixtures.mjs mixed      # inject the "mixed" roster
//   node scripts/gen-cockpit-fixtures.mjs --clear    # remove the fixture (back to live)
//   node scripts/gen-cockpit-fixtures.mjs            # list scenarios

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./cockpit-fixtures/scenarios.mjs";
import { validateScenario } from "./cockpit-fixtures/validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "cockpit-fixtures");
const outFile = join(outDir, "active.json");

const arg = process.argv[2];
const names = Object.keys(SCENARIOS);

if (arg === "--clear" || arg === "live") {
    if (existsSync(outFile)) {
        rmSync(outFile);
        console.log("cleared active.json — reload the dev app to return to the live roster");
    } else {
        console.log("no active.json to clear");
    }
    process.exit(0);
}

if (!arg || !names.includes(arg)) {
    console.log(`usage: node scripts/gen-cockpit-fixtures.mjs <scenario|--clear>`);
    console.log(`scenarios: ${names.join(", ")}`);
    process.exit(arg ? 1 : 0);
}

const roster = SCENARIOS[arg](Date.now());
const { ok, errors } = validateScenario(roster);
if (!ok) {
    console.error(`scenario "${arg}" is invalid:\n  ${errors.join("\n  ")}`);
    process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(roster, null, 2));
console.log(`wrote ${roster.length} agents (${arg}) -> public/cockpit-fixtures/active.json`);
console.log(`reload the dev app (Ctrl+R) to inject. clear with: node scripts/gen-cockpit-fixtures.mjs --clear`);
```

- [ ] **Step 2: Ignore the generated artifact**

Add to `.gitignore` (after the existing `out` entries, before the `# Yarn Modern` block):

```
public/cockpit-fixtures/active.json
```

- [ ] **Step 3: Add the npm alias**

In `package.json`, add to `"scripts"`:

```json
        "cockpit:fixtures": "node scripts/gen-cockpit-fixtures.mjs"
```

(Place it after `"build"`. Keep valid JSON — add the trailing comma on the preceding line.)

- [ ] **Step 4: Smoke-test the generator**

Run: `node scripts/gen-cockpit-fixtures.mjs`
Expected: prints `usage: …` and `scenarios: mixed, all-asking, heavy, empty`.

Run: `node scripts/gen-cockpit-fixtures.mjs mixed`
Expected: prints `wrote N agents (mixed) -> public/cockpit-fixtures/active.json`; the file exists and is valid JSON (`node -e "JSON.parse(require('fs').readFileSync('public/cockpit-fixtures/active.json','utf8'))"` exits 0).

Run: `node scripts/gen-cockpit-fixtures.mjs --clear`
Expected: prints `cleared active.json …`; the file is gone.

Run: `git status --porcelain public/cockpit-fixtures/active.json`
Expected: empty output even when the file exists (proves it's git-ignored). Test by regenerating `mixed` first, then running the status check.

- [ ] **Step 5: Commit (checkpoint — stage + request approval)**

```bash
git add scripts/gen-cockpit-fixtures.mjs .gitignore package.json
# proposed: feat(cockpit): add fixture generator + gitignore active.json
```

### Task 6: End-to-end verification of the runtime mock (manual)

**No code.** This proves Phase 2 works in the real app; it cannot be automated (the Tauri webview exposes no CDP endpoint).

- [ ] **Step 1: Inject a scenario**

Run: `node scripts/gen-cockpit-fixtures.mjs mixed`

- [ ] **Step 2: Run the app and observe**

Run: `task dev` (if not already running; a Vite-served fetch needs the dev server). Once the cockpit loads, **reload** (Ctrl+R).
Expected: the grid shows the `mixed` roster — asking agents (amber, with answer options), working agents, and idle agents. Switch scenarios with `node scripts/gen-cockpit-fixtures.mjs all-asking` / `heavy` / `empty` + reload; confirm `empty` shows the empty state (not the live roster).

- [ ] **Step 3: Confirm the live path still works**

Run: `node scripts/gen-cockpit-fixtures.mjs --clear`, reload.
Expected: the cockpit returns to the live roster (empty unless real agents are running).

---

## Phase 3 — Live-pipeline injector

> **Run context:** this script calls `wsh`, which only connects when it has the `WAVETERM` socket/token and `WAVETERM_TABID` env — i.e. it must run **from inside a Wave terminal** in the dev app (open a terminal via `+ New agent` or `t`, then run the script there). A bare external shell cannot authenticate `wsh`.

### Task 7: Probe — confirm a driven block appears as an agent

**No code.** De-risks the core assumption (a `wsh createblock` term block shows in the cockpit session sidebar and renders as an agent once it has status). Do this before building the full injector.

- [ ] **Step 1: From a Wave terminal, create a block and capture its id**

Run: `wsh createblock term`
Expected: prints `created block <oid>`. Record `<oid>`.

- [ ] **Step 2: Drive it to "working"**

Run: `wsh agentstatus -b block:<oid> --state working --agent claude --model claude-sonnet-4-6 --detail "probe: editing foo.go"`
Expected: prints `agentstatus working set`.

- [ ] **Step 3: Observe the cockpit**

Switch to the Cockpit surface.
Expected: an agent appears in the live grid (working, "probe: editing foo.go").
- **If it appears:** proceed to Task 8 as written.
- **If it does NOT appear:** the session sidebar doesn't surface bare `createblock` terminals. Fallback: in Task 8, instead of `wsh createblock`, the operator opens N sessions via the cockpit `+ New agent` button and the script discovers them with `wsh blocks list --view=term --json` (filter to the cockpit tab via `$WAVETERM_TABID`), driving those orefs. Note which path you took in the script's header comment.

- [ ] **Step 4: Clean up the probe**

Run: `wsh deleteblock -b block:<oid>`
Expected: the block is removed.

### Task 8: Live injector script

**Files:**
- Create: `scripts/inject-live-agents.mjs`

- [ ] **Step 1: Write the injector**

Create `scripts/inject-live-agents.mjs`:

```js
// DEV live-pipeline injector. Run from inside a Wave terminal (wsh must be authenticated). Creates
// one terminal block per fake agent, drives each with `wsh agentstatus` / `wsh ask`, and writes a
// fake Claude-Code transcript JSONL so the live narration path renders. Tears everything down with
// --clear (reads the state file it wrote on inject).
//
//   node scripts/inject-live-agents.mjs mixed     # create + drive the "mixed" roster
//   node scripts/inject-live-agents.mjs --clear   # delete created blocks + transcripts
//
// If Task 7's probe showed bare createblock terminals don't surface, switch createBlock() to read
// pre-opened sessions via `wsh blocks list --view=term --json` instead (see plan Task 7 fallback).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "./cockpit-fixtures/scenarios.mjs";
import { validateScenario } from "./cockpit-fixtures/validate.mjs";

const STATE_FILE = join(tmpdir(), "wave-fake-agents.json");

function wsh(args, input) {
    return execFileSync("wsh", args, { input, encoding: "utf8" });
}

// AgentEntry[] -> Claude-Code transcript JSONL (reverse of frontend transcriptprojection.ts).
const TOOL_BY_VERB = { ran: "Bash", edited: "Edit", wrote: "Write", read: "Read", grep: "Grep", glob: "Glob", spawned: "Task" };
function inputFor(tool, target) {
    if (tool === "Bash") return { command: target };
    if (tool === "Read" || tool === "Edit" || tool === "Write") return { file_path: target };
    if (tool === "Grep" || tool === "Glob") return { pattern: target };
    return { description: target };
}
function transcriptLines(task, entries) {
    const lines = [];
    if (task) lines.push(JSON.stringify({ type: "ai-title", aiTitle: task }));
    (entries ?? []).forEach((e, i) => {
        if (e.kind === "message") {
            lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: e.text }] } }));
        } else if (e.kind === "user") {
            lines.push(JSON.stringify({ type: "user", message: { content: e.text } }));
        } else if (e.kind === "action") {
            const tool = TOOL_BY_VERB[e.verb] ?? "Bash";
            const id = `t${i}`;
            lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: tool, input: inputFor(tool, e.target) }] } }));
            if (e.outcome) {
                lines.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: e.outcome === "fail" }] } }));
            }
        }
    });
    return lines.join("\n") + "\n";
}

const STATE_FLAG = { asking: "waiting", working: "working", idle: "idle" };

function inject(scenarioName) {
    const build = SCENARIOS[scenarioName];
    if (!build) {
        console.error(`unknown scenario "${scenarioName}". options: ${Object.keys(SCENARIOS).join(", ")}`);
        process.exit(1);
    }
    const roster = build(Date.now());
    const { ok, errors } = validateScenario(roster);
    if (!ok) {
        console.error(`scenario invalid:\n  ${errors.join("\n  ")}`);
        process.exit(1);
    }
    const tdir = mkdtempSync(join(tmpdir(), "wave-fake-"));
    const created = [];
    for (const a of roster) {
        const out = wsh(["createblock", "term"]);
        const oid = (out.match(/created block (\S+)/) ?? [])[1];
        if (!oid) {
            console.error(`could not parse block id from: ${out}`);
            continue;
        }
        const oref = `block:${oid}`;
        const tpath = join(tdir, `${oid}.jsonl`);
        writeFileSync(tpath, transcriptLines(a.task, a.previousInfo));
        const statusArgs = ["agentstatus", "-b", oref, "--state", STATE_FLAG[a.state], "--agent", a.agent || "claude", "--transcript", tpath];
        if (a.model) statusArgs.push("--model", a.model);
        if (a.task) statusArgs.push("--title", a.task);
        if (a.activity) statusArgs.push("--detail", a.activity);
        wsh(statusArgs);
        if (a.usage) {
            const u = a.usage;
            const usageArgs = ["agentstatus", "-b", oref, "--usage"];
            if (u.contextpct != null) usageArgs.push("--context-pct", String(u.contextpct));
            if (u.contextmax != null) usageArgs.push("--context-max", String(u.contextmax));
            if (u.costusd != null) usageArgs.push("--cost-usd", String(u.costusd));
            if (u.fivehourpct != null) usageArgs.push("--five-hour-pct", String(u.fivehourpct));
            if (u.fivehourreset != null) usageArgs.push("--five-hour-reset", String(u.fivehourreset));
            if (u.weekpct != null) usageArgs.push("--week-pct", String(u.weekpct));
            if (u.weekreset != null) usageArgs.push("--week-reset", String(u.weekreset));
            wsh(usageArgs);
        }
        if (a.state === "asking" && a.ask?.questions?.length) {
            const payload = JSON.stringify({
                questions: a.ask.questions.map((q) => ({
                    question: q.question,
                    header: q.header ?? "",
                    multiSelect: q.multiSelect ?? false,
                    options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })),
                })),
            });
            wsh(["ask", "-b", oref], payload);
        }
        created.push({ oid, oref, tpath });
        console.log(`+ ${a.name} (${a.state}) -> ${oref}`);
    }
    writeFileSync(STATE_FILE, JSON.stringify({ tdir, created }, null, 2));
    console.log(`injected ${created.length} agents. tear down with: node scripts/inject-live-agents.mjs --clear`);
}

function clear() {
    if (!existsSync(STATE_FILE)) {
        console.log("nothing to clear (no state file)");
        return;
    }
    const { tdir, created } = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    for (const { oref } of created) {
        try { wsh(["ask", "-b", oref, "--clear"]); } catch {}
        try { wsh(["deleteblock", "-b", oref]); } catch {}
        console.log(`- removed ${oref}`);
    }
    try { rmSync(tdir, { recursive: true, force: true }); } catch {}
    rmSync(STATE_FILE, { force: true });
    console.log("cleared.");
}

const arg = process.argv[2];
if (arg === "--clear") {
    clear();
} else if (arg) {
    inject(arg);
} else {
    console.log("usage: node scripts/inject-live-agents.mjs <scenario|--clear>");
    console.log(`scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
}
```

- [ ] **Step 2: Smoke-test inject (from a Wave terminal, dev app running)**

Run: `node scripts/inject-live-agents.mjs mixed`
Expected: prints `+ <name> (<state>) -> block:<oid>` per agent, then `injected N agents …`. The Cockpit surface shows the roster with **live narration** streaming in each card (the fake transcript), asking agents showing their questions, and usage in the rail.

- [ ] **Step 3: Smoke-test clear**

Run: `node scripts/inject-live-agents.mjs --clear`
Expected: prints `- removed block:<oid>` per agent then `cleared.`; the injected blocks disappear from the cockpit.

- [ ] **Step 4: Commit (checkpoint — stage + request approval)**

```bash
git add scripts/inject-live-agents.mjs
# proposed: feat(cockpit): add live-pipeline fake-agent injector
```

---

## Self-review

**Spec coverage:**
- Shared fixture scenarios (spec §"Shared fixture scenarios") → Tasks 1–2.
- Runtime FE mock: file-fetch switch + dev-gating + generator (spec §"Mechanism 1") → Tasks 3–6.
- Live injector: create/drive blocks, fake transcript, cleanup (spec §"Mechanism 2") → Tasks 7–8.
- D1 one scenario source → `scenarios.mjs` consumed by both scripts (Tasks 5, 8). D2 file-fetch switch → Task 3/5. D3 dev-only → Task 4 (`import.meta.env.DEV`, typed via the `media.d.ts` augmentation) + `.gitignore` (Task 5). D4 injector runs inside Wave → Task 7/8 run-context note. D5 migrate `mockagents.ts` + delete toggle → Task 4.
- Testing (spec §): scenario-validates-to-AgentVM node test → Tasks 1–2; scripts smoke-tested → Tasks 5, 8; static gates → Tasks 4–5.
- Open questions resolved: block-creation entry point = `wsh createblock` with the `+ New agent` fallback (Task 7); transcript schema = `transcriptLines()` mirroring `transcriptprojection.ts` (Task 8); D5 = port + delete (Task 4).

**Placeholder scan:** no TBD/TODO; the only "paste existing content" instruction (Task 2, `mixed`) names exact source lines + exact transforms, which is concrete, not a placeholder.

**Type/name consistency:** `validateScenario` (Tasks 1,2,5,8), `SCENARIOS` keys `mixed`/`all-asking`/`heavy`/`empty` (Tasks 2,5,8), `devMockAgentsAtom`/`devRosterAtom`/`loadDevMockRoster`/`chooseRoster` (Tasks 3,4), `active.json` path `public/cockpit-fixtures/active.json` (Tasks 3,5, gitignore) — all consistent across tasks.
