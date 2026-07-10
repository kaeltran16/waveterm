# CDP Verification Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the repo's five-plus one-off CDP scripts into a single `node scripts/cdp/verify.mjs` runner that arranges known state, screenshots each surface, asserts against backend RPC state and the rendered DOM, and exits nonzero on failure — so "verify before done" is one repeatable command.

**Architecture:** Three ES-module files under `scripts/cdp/`: `attach.mjs` (shared CDP transport — the extraction of the duplicated `pickTarget`+websocket wrapper), `report.mjs` (pure, unit-testable result formatting), and `scenarios.mjs` (a declarative manifest of `{name, surface, arrange, assert, teardown}` entries). `verify.mjs` wires them together. Navigation is a nav-rail button click (`globalStore` is not exposed on `window`); asserts are RPC-based or DOM-based. Two exemplars ship: `runs-lifecycle` (behavioral, reparented from `cdp-e2e-runs.mjs`) and `surface-smoke` (visual + DOM across surfaces).

**Tech Stack:** Node 21+ (global `WebSocket`/`fetch`; repo runs Node 24), Chrome DevTools Protocol 1.3 over WebView2's `:9222`, Vitest for the pure module, Task for the `verify:ui` wrapper.

**Spec:** `docs/superpowers/specs/2026-07-10-cdp-verification-harness-design.md`

---

## Git policy (overrides the skill's per-task commit template)

The repo owner's standing rule: **never commit without explicit approval; batch into ONE commit at the end.** So tasks below end at "run and verify" — there are **no** per-task commits. The single commit is Task 6, gated on approval. The spec + this plan fold into that same feature commit (repo convention: spec/plan docs are not committed on their own).

## File structure

| File | Responsibility | Created / Modified |
|---|---|---|
| `scripts/cdp/report.mjs` | Pure result → text/HTML/exit-code. No CDP/DOM deps. | Create |
| `scripts/cdp/report.test.mjs` | Vitest unit tests for `report.mjs`. | Create |
| `scripts/cdp/attach.mjs` | Shared CDP transport: attach, `ev`, `rpc`, `goto`, `activeSurfaceLabel`, `shot`, `close`. | Create |
| `scripts/cdp/scenarios.mjs` | The scenario manifest + the two exemplars. | Create |
| `scripts/cdp/verify.mjs` | The runner: arrange→goto→shot→assert→teardown, report, exit. | Create |
| `Taskfile.yml` | Add the `verify:ui` task. | Modify |

`cdp-shots/` is already gitignored (line 26) — no change needed; the runner writes PNGs + `index.html` there.

---

### Task 1: `report.mjs` — pure result formatting (TDD)

This is the only piece with a deterministic contract and no live-app dependency, so it is built test-first.

**Files:**
- Create: `scripts/cdp/report.mjs`
- Test: `scripts/cdp/report.test.mjs`

A "scenario result" is `{ name: string, steps: Array<{ step, ok, detail? }>, error?: string }`.

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp/report.test.mjs`:

```js
import { describe, expect, it } from "vitest";
import { contactSheetHtml, exitCode, formatResults } from "./report.mjs";

const pass = { name: "s1", steps: [{ step: "a", ok: true, detail: "d" }] };
const fail = { name: "s2", steps: [{ step: "b", ok: false, detail: "boom" }] };
const errored = { name: "s3", steps: [], error: "attach failed" };

describe("exitCode", () => {
    it("is 0 when every step of every scenario passes", () => {
        expect(exitCode([pass, { name: "s1b", steps: [{ step: "x", ok: true }] }])).toBe(0);
    });
    it("is 1 when any step fails", () => {
        expect(exitCode([pass, fail])).toBe(1);
    });
    it("is 1 when a scenario errored", () => {
        expect(exitCode([pass, errored])).toBe(1);
    });
});

describe("formatResults", () => {
    it("labels PASS/FAIL per step and prints a summary", () => {
        const out = formatResults([pass, fail]);
        expect(out).toContain("PASS  a");
        expect(out).toContain("FAIL  b");
        expect(out).toContain("1/2 steps passed");
    });
    it("surfaces a scenario error", () => {
        expect(formatResults([errored])).toContain("ERROR: attach failed");
    });
});

describe("contactSheetHtml", () => {
    it("renders one img per entry with the png src", () => {
        const html = contactSheetHtml([
            { name: "cockpit", png: "cockpit.png" },
            { name: "channels", png: "channels.png" },
        ]);
        expect(html).toContain('src="cockpit.png"');
        expect(html).toContain('src="channels.png"');
    });
    it("emits a doctype even when empty", () => {
        expect(contactSheetHtml([])).toContain("<!doctype html>");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/cdp/report.test.mjs`
Expected: FAIL — `Failed to resolve import "./report.mjs"` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/cdp/report.mjs`:

```js
// Pure result formatting for the verification runner. No CDP/DOM/browser deps, so it is unit-testable
// without a live app. A scenario result is { name, steps: [{ step, ok, detail? }], error? }.

export function exitCode(scenarioResults) {
    const allPass = scenarioResults.every((s) => !s.error && s.steps.every((st) => st.ok));
    return allPass ? 0 : 1;
}

export function formatResults(scenarioResults) {
    const lines = [];
    let pass = 0;
    let total = 0;
    for (const s of scenarioResults) {
        lines.push(`\n# ${s.name}`);
        if (s.error) lines.push(`  ERROR: ${s.error}`);
        for (const st of s.steps) {
            total++;
            if (st.ok) pass++;
            lines.push(`  ${st.ok ? "PASS" : "FAIL"}  ${st.step}`);
            if (st.detail) lines.push(`        ${st.detail}`);
        }
    }
    lines.push(`\n${pass}/${total} steps passed`);
    return lines.join("\n");
}

export function contactSheetHtml(entries) {
    // entries: [{ name, png }] where png is a path relative to the html file (same dir).
    const cards = entries
        .map((e) => `<figure><figcaption>${e.name}</figcaption><img src="${e.png}" alt="${e.name}"></figure>`)
        .join("\n");
    return `<!doctype html><meta charset="utf-8"><title>verify contact sheet</title>
<style>body{background:#111;color:#eee;font:13px system-ui;margin:16px}
figure{margin:0 0 24px}figcaption{margin-bottom:6px;color:#9ab}
img{max-width:100%;border:1px solid #333}</style>
${cards}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/cdp/report.test.mjs`
Expected: PASS — 3 test files' worth of `describe` blocks, all green (7 assertions).

---

### Task 2: `attach.mjs` — shared CDP transport

Extraction of the duplicated `pickTarget` + websocket wrapper from `cdp-shot.mjs` / `cdp-e2e-runs.mjs` / `cdp-goto-channels.mjs`. This layer needs a live app on `:9222`, so it has **no unit test** — it is exercised by the acceptance run in Task 4. That limitation is by design (per spec §Testing).

**Files:**
- Create: `scripts/cdp/attach.mjs`

- [ ] **Step 1: Write the module**

Create `scripts/cdp/attach.mjs`:

```js
// Shared CDP transport for the verification harness. Extracted from the duplicated pickTarget +
// websocket wrappers in cdp-shot.mjs / cdp-e2e-runs.mjs / cdp-goto-channels.mjs. Requires the dev
// app running with the debug flag (dev-only in src-tauri/src/main.rs): --remote-debugging-port=9222.
// Node 21+ (global WebSocket + fetch; the repo runs Node 24).
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

// SurfaceKey -> nav-rail label, mirrored from frontend/app/view/agents/navrail.tsx ITEMS. goto clicks
// the nav button by label because globalStore/the agents model are NOT exposed on window (boot-core
// exposes only globalAtoms/globalWS/TabRpcClient) — the nav click is the proven, app-change-free way
// to switch surfaces (see cdp-goto-channels.mjs). Note: the "files" surface is labelled "Diff".
export const SURFACE_LABEL = {
    cockpit: "Cockpit",
    agent: "Agent",
    activity: "Activity",
    channels: "Channels",
    sessions: "Sessions",
    files: "Diff",
    memory: "Memory",
    usage: "Usage",
    settings: "Settings",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        ws.addEventListener("open", () =>
            resolve({
                send: (method, params = {}) => {
                    const msgId = ++id;
                    ws.send(JSON.stringify({ id: msgId, method, params }));
                    return new Promise((res) => pending.set(msgId, res));
                },
                close: () => ws.close(),
            })
        );
        ws.addEventListener("error", reject);
        ws.addEventListener("message", (e) => {
            const msg = JSON.parse(e.data);
            if (msg.id && pending.has(msg.id)) {
                pending.get(msg.id)(msg.result);
                pending.delete(msg.id);
            }
        });
    });
}

async function pickTarget(port) {
    const res = await fetch(`http://localhost:${port}/json/list`);
    const targets = await res.json();
    return (
        targets.find((t) => t.type === "page" && /localhost:5174|wave|arc/i.test(t.url ?? "")) ??
        targets.find((t) => t.type === "page")
    );
}

export async function attach(port = 9222) {
    const target = await pickTarget(port);
    if (!target) {
        throw new Error(
            `no page target on :${port} — is the dev app running with the debug flag? ` +
                `(task dev; the flag is dev-only in src-tauri/src/main.rs)`
        );
    }
    const client = await connect(target.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    await client.send("Page.enable");

    async function ev(expr) {
        const x = await client.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
        if (x.exceptionDetails) {
            throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text);
        }
        return x.result?.value;
    }

    const shots = [];

    return {
        url: target.url,
        shots,
        ev,
        rpc: (command, data) =>
            ev(`window.TabRpcClient.wshRpcCall(${JSON.stringify(command)}, ${JSON.stringify(data ?? null)}, {})`),
        async goto(surface) {
            const label = SURFACE_LABEL[surface];
            if (!label) throw new Error(`unknown surface "${surface}"`);
            const clicked = await ev(`(() => {
                const b = [...document.querySelectorAll('nav button')]
                    .find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
                if (!b) return false;
                b.click();
                return true;
            })()`);
            if (!clicked) throw new Error(`nav button "${label}" not found for surface "${surface}"`);
            await sleep(800); // settle before asserting/screenshotting (matches cdp-goto-channels.mjs)
        },
        activeSurfaceLabel: () =>
            ev(`(() => {
                const b = [...document.querySelectorAll('nav button')]
                    .find((x) => (x.className || '').includes('text-accent-soft'));
                return b ? (b.textContent || '').trim() : null;
            })()`),
        async shot(outPath) {
            const { data } = await client.send("Page.captureScreenshot", { format: "png" });
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, Buffer.from(data, "base64"));
            const png = basename(outPath);
            shots.push({ name: png.replace(/\.png$/, ""), png });
        },
        close: () => client.close(),
    };
}
```

- [ ] **Step 2: Sanity-check it parses**

Run: `node --check scripts/cdp/attach.mjs`
Expected: no output, exit 0 (syntax valid). Full behavior is verified in Task 4.

---

### Task 3: `scenarios.mjs` — the manifest + two exemplars

**Files:**
- Create: `scripts/cdp/scenarios.mjs`

Scenario functions run in Node and may both do Node fs work (temp dirs) and drive the browser via the handle `h`. Asserts return `[{ step, ok, detail }]`.

- [ ] **Step 1: Write the module**

Create `scripts/cdp/scenarios.mjs`:

```js
// Verification scenario manifest. Each entry: { name, surface, arrange(h)->ctx, assert(h,ctx)->steps,
// teardown(h,ctx) }. arrange/assert/teardown run in Node and drive the browser via h (see attach.mjs).
// Asserts are RPC-based (backend state) or DOM-based (h.ev) — NOT jotai atom reads (globalStore is not
// exposed on window). steps are { step, ok, detail }.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SURFACE_LABEL } from "./attach.mjs";

// --- exemplar 1: behavioral (reparented from cdp-e2e-runs.mjs) ---------------------------------
// Drives the real CreateRun/AdvanceRun/CancelRun RPCs, which spawn REAL claude worker tabs. Blast
// radius is contained: the worker cwd is an isolated temp dir, spawned worker blocks are killed in
// teardown (deleteblock -> ShellProc.Close kills claude in ~1s), and the channel is deleted at the end.
const workerOf = (phase) => phase && phase.workerorefs && phase.workerorefs[0];

const runsLifecycle = {
    name: "runs-lifecycle",
    surface: "channels",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-runs-"));
        const wslist = await h.rpc("workspacelist", null);
        const workspaceId = wslist[0].workspacedata.oid;
        const ch = await h.rpc("createchannel", { name: "verify-runs", projectpath: cwd });
        return { cwd, workspaceId, channelId: ch.oid, workers: [] };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const getRun = async (runId) => {
            const res = await h.rpc("getchannels", null);
            const cc = (res.channels || []).find((x) => x.oid === ctx.channelId) || {};
            return (cc.runs || []).find((x) => x.id === runId);
        };
        const track = (oref) => {
            if (oref) ctx.workers.push(oref);
        };

        const created = await h.rpc("createrun", {
            channelid: ctx.channelId,
            workspaceid: ctx.workspaceId,
            goal: "spawn-test only: do nothing, make no file changes, stop immediately",
        });
        const run = created.run;
        const runId = run.id;
        track(workerOf(run.phases[0]));
        rec(
            "1. CreateRun -> 3 phases, p0 running + worker, status planning",
            run.phases.length === 3 && run.phases[0].state === "running" && !!workerOf(run.phases[0]) && run.status === "planning",
            JSON.stringify({ status: run.status, states: run.phases.map((p) => p.state) })
        );

        await h.rpc("advancerun", { channelid: ctx.channelId, runid: runId, phaseidx: 0, action: "complete", artifacts: ["docs/spec.md"] });
        const r2 = await getRun(runId);
        track(workerOf(r2.phases[1]));
        rec(
            "2. Advance complete p0 -> p1 running + worker, status planning",
            r2.phases[0].state === "done" && r2.phases[1].state === "running" && !!workerOf(r2.phases[1]) && r2.status === "planning",
            JSON.stringify({ status: r2.status, states: r2.phases.map((p) => p.state) })
        );

        await h.rpc("advancerun", { channelid: ctx.channelId, runid: runId, phaseidx: 1, action: "complete", artifacts: ["docs/plan.md"] });
        const r3 = await getRun(runId);
        rec(
            "3. Advance complete p1 -> awaiting-review, p2 pending, NO new worker",
            r3.phases[1].state === "done" && r3.phases[2].state === "pending" && !workerOf(r3.phases[2]) && r3.status === "awaiting-review",
            JSON.stringify({ status: r3.status, states: r3.phases.map((p) => p.state) })
        );

        await h.rpc("advancerun", { channelid: ctx.channelId, runid: runId, action: "approve" });
        const r4 = await getRun(runId);
        track(workerOf(r4.phases[2]));
        rec(
            "4. Approve gate -> p2 running + worker, status executing",
            r4.phases[2].state === "running" && !!workerOf(r4.phases[2]) && r4.status === "executing",
            JSON.stringify({ status: r4.status, states: r4.phases.map((p) => p.state) })
        );

        await h.rpc("cancelrun", { channelid: ctx.channelId, runid: runId });
        const r5 = await getRun(runId);
        rec(
            "5. Cancel -> status cancelled, p2 skipped",
            r5.status === "cancelled" && r5.phases[2].state === "skipped",
            JSON.stringify({ status: r5.status, states: r5.phases.map((p) => p.state) })
        );

        return steps;
    },
    async teardown(h, ctx) {
        for (const oref of ctx.workers) {
            try {
                const tab = await h.rpc("gettab", oref.slice(4));
                const bid = tab && tab.blockids && tab.blockids[0];
                if (bid) await h.rpc("deleteblock", { blockid: bid });
            } catch {
                // best-effort cleanup
            }
        }
        try {
            await h.rpc("deletechannel", { channelid: ctx.channelId });
        } catch {
            // best-effort cleanup
        }
        try {
            rmSync(ctx.cwd, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
    },
};

// --- exemplar 2: visual + DOM ------------------------------------------------------------------
// Navigate each key surface, screenshot it, and assert (a) the active nav label matches and (b) the
// content region rendered non-empty text — which catches a surface that blanks out on render. No
// arrange needed; a populated-roster visual still relies on the manual inject-live-agents path.
const SMOKE_SURFACES = ["cockpit", "channels", "usage", "memory", "activity", "files", "settings"];

const surfaceSmoke = {
    name: "surface-smoke",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        for (const surface of SMOKE_SURFACES) {
            await h.goto(surface);
            const active = await h.activeSurfaceLabel();
            const contentLen = await h.ev(
                `(() => { const n=document.querySelector('nav'); const c=n&&n.nextElementSibling; return c?(c.textContent||'').trim().length:0; })()`
            );
            const expected = SURFACE_LABEL[surface];
            steps.push({
                step: `goto ${surface} -> active nav "${expected}", content non-empty`,
                ok: active === expected && contentLen > 0,
                detail: `active=${active} contentLen=${contentLen}`,
            });
            await h.shot(`cdp-shots/surface-${surface}.png`);
        }
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};

export const SCENARIOS = [runsLifecycle, surfaceSmoke];
```

- [ ] **Step 2: Sanity-check it parses**

Run: `node --check scripts/cdp/scenarios.mjs`
Expected: no output, exit 0.

---

### Task 4: `verify.mjs` — the runner + acceptance run

**Files:**
- Create: `scripts/cdp/verify.mjs`

- [ ] **Step 1: Write the runner**

Create `scripts/cdp/verify.mjs`:

```js
// One-command verification runner. Attaches to the running dev app over CDP, runs each scenario
// (arrange -> goto -> shot -> assert -> teardown), prints a PASS/FAIL table, writes a contact sheet,
// and exits nonzero on any failure. Usage: node scripts/cdp/verify.mjs [name...]
import { mkdirSync, writeFileSync } from "node:fs";
import { attach } from "./attach.mjs";
import { contactSheetHtml, exitCode, formatResults } from "./report.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const chosen = only.length ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
if (!chosen.length) {
    console.error(`no scenarios matched ${JSON.stringify(only)}. available: ${SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(2);
}

const h = await attach();
console.log(`attached to ${h.url}`);

const results = [];
for (const scenario of chosen) {
    let ctx;
    try {
        ctx = await scenario.arrange(h);
        await h.goto(scenario.surface);
        await h.shot(`cdp-shots/${scenario.name}.png`);
        const steps = await scenario.assert(h, ctx);
        results.push({ name: scenario.name, steps });
    } catch (e) {
        results.push({ name: scenario.name, steps: [], error: String(e?.message ?? e) });
    } finally {
        try {
            if (ctx !== undefined) await scenario.teardown?.(h, ctx);
        } catch (e) {
            console.error(`teardown failed for ${scenario.name}: ${e?.message ?? e}`);
        }
    }
}
h.close();

console.log(formatResults(results));
mkdirSync("cdp-shots", { recursive: true });
writeFileSync("cdp-shots/index.html", contactSheetHtml(h.shots));
console.log(`\ncontact sheet: cdp-shots/index.html`);
process.exit(exitCode(results));
```

- [ ] **Step 2: Sanity-check it parses**

Run: `node --check scripts/cdp/verify.mjs`
Expected: no output, exit 0.

- [ ] **Step 3: Acceptance run against the live dev app**

Prereq: the dev app is running with the debug flag. In a terminal: `task dev` (headless: `tail -f /dev/null | task dev`). Wait for the window and confirm `:9222` responds: `curl -s http://localhost:9222/json/list | head -c 200` (should be JSON, not a connection error).

Run the smoke scenario first (no worker spawning, fastest):

Run: `node scripts/cdp/verify.mjs surface-smoke`
Expected: `attached to http://localhost:5174/…`, then 7 `PASS` lines (one per surface), `7/7 steps passed`, and `cdp-shots/index.html` written. Exit 0.

- [ ] **Step 4: Acceptance run of the behavioral exemplar**

Run: `node scripts/cdp/verify.mjs runs-lifecycle`
Expected: 5 `PASS` lines (CreateRun, advance, gate, approve, cancel), `5/5 steps passed`, exit 0. Confirm cleanup: the temp channel is gone and no orphan `claude` worker processes remain (Windows: `Get-Process claude -ErrorAction SilentlyContinue` should show none you didn't start).

- [ ] **Step 5: Full run + eyeball the contact sheet**

Run: `node scripts/cdp/verify.mjs`
Expected: both scenarios, `12/12 steps passed`, exit 0. Open `cdp-shots/index.html` in a browser and confirm each surface screenshot rendered (no blank panes, no error overlay). This is the manual visual gate the spec calls for — it is not skipped.

---

### Task 5: `Taskfile.yml` — the `verify:ui` wrapper

**Files:**
- Modify: `Taskfile.yml` (add a task next to `preview` / `build:preview`, around line 34-47)

- [ ] **Step 1: Add the task**

Insert this task block after the `build:preview` task:

```yaml
    verify:ui:
        desc: Run the CDP verification harness against the running dev app (scripts/cdp/). Pass scenario names after --, e.g. `task verify:ui -- surface-smoke`.
        cmd: node scripts/cdp/verify.mjs {{.CLI_ARGS}}
```

- [ ] **Step 2: Verify the task is registered**

Run: `task --list | grep verify:ui`
Expected: one line — `* verify:ui:    Run the CDP verification harness …`.

- [ ] **Step 3: Verify it forwards args (dev app still running)**

Run: `task verify:ui -- surface-smoke`
Expected: same output as Task 4 Step 3 (7/7), proving the `{{.CLI_ARGS}}` passthrough works.

---

### Task 6: Final verification + single commit (gated on approval)

**Files:** none new. Confirms the whole change is clean, then makes the one commit (spec + plan + harness together).

- [ ] **Step 1: Re-run the unit tests**

Run: `npx vitest run scripts/cdp/report.test.mjs`
Expected: PASS (all green).

- [ ] **Step 2: Confirm the TS baseline is untouched**

The change adds only `.mjs` scripts + a Taskfile task — no TypeScript touched. Confirm the baseline is still clean:
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (unchanged baseline).

- [ ] **Step 3: Review the diff and request approval**

Run: `git status --short` and `git --no-pager diff --stat`
Expected files: `scripts/cdp/{attach,report,scenarios,verify}.mjs`, `scripts/cdp/report.test.mjs`, `Taskfile.yml`, `docs/superpowers/specs/2026-07-10-cdp-verification-harness-design.md`, `docs/superpowers/plans/2026-07-10-cdp-verification-harness.md`.

Present the file list + the proposed message below and ask: "Awaiting approval. Proceed? (yes/no)". **Do not commit without a yes.**

- [ ] **Step 4: Commit (only after approval)**

```bash
git add scripts/cdp/ Taskfile.yml docs/superpowers/specs/2026-07-10-cdp-verification-harness-design.md docs/superpowers/plans/2026-07-10-cdp-verification-harness.md
git commit -m "feat(scripts): one-command CDP verification harness

Consolidate the ad-hoc one-off CDP scripts into scripts/cdp/: a shared
attach transport, a pure report module, a scenario manifest, and a
verify.mjs runner (task verify:ui). Ships two exemplars: runs-lifecycle
(behavioral) and surface-smoke (visual + DOM). Makes 'verify before done'
one repeatable command so features stop shipping CDP-unverified."
```

---

## Self-Review

**1. Spec coverage** (each spec element → task):
- `attach.mjs` transport (ev/rpc/goto/activeSurfaceLabel/shot/close, nav-click nav, no reload) → Task 2. ✓
- `scenarios.mjs` manifest shape → Task 3. ✓
- `verify.mjs` runner (arrange→goto→shot→assert→teardown in `finally`, PASS/FAIL table, contact sheet, exit code) → Task 4. ✓
- `runs-lifecycle` exemplar (RPC-arrange, behavioral assert, safe teardown) → Task 3 + acceptance Task 4 Step 4. ✓
- `surface-smoke` exemplar (goto/shot/DOM-assert across surfaces) → Task 3 + acceptance Task 4 Step 3. ✓
- Pure unit tests (formatter, contact sheet, exit code) → Task 1. ✓
- `task verify:ui` wrapper → Task 5. ✓
- Non-goals (no pixel-diff, no jsdom, no CI, no atom reads, no script migration) → respected; nothing implements them. ✓
- Prereqs/gotchas (debug flag, headless `tail -f`, never reload) → Task 4 Step 3. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every run step shows the exact command + expected output. ✓

**3. Type consistency:** `SURFACE_LABEL` exported from `attach.mjs` and imported in `scenarios.mjs` (same name). Scenario result shape `{ name, steps:[{step,ok,detail}], error? }` is identical across `report.mjs`, its test, and `verify.mjs`. `h.shots` produced in `attach.mjs`, consumed in `verify.mjs`. `workerOf`, `track`, `getRun` are local to `runsLifecycle`. Consistent. ✓
