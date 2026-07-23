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
const SMOKE_SURFACES = ["cockpit", "jarvis", "channels", "radar", "usage", "memory", "files", "settings"];

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

// --- jarvis: render every surface state via the dev fixture bar --------------------------------
// The bar is DEV-only and clickable (globalStore is not on window, so we drive by button text like nav).
// Each fixture is screenshotted; we assert the conversation region rendered non-empty text.
const jarvisStates = {
    name: "jarvis-states",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("jarvis");
        const states = ["empty", "active", "grounded", "working", "weak", "notfound", "stale", "contextual", "narrow"];
        for (const s of states) {
            const clicked = await h.ev(`(() => {
                const b = [...document.querySelectorAll('[data-testid="jarvis-fixture-bar"] button')]
                    .find((x) => x.getAttribute('data-fixture') === ${JSON.stringify(s)});
                if (!b) return false;
                b.click();
                return true;
            })()`);
            // small settle for the width-reveal animation before shooting
            await h.ev("new Promise((r) => setTimeout(r, 300))");
            const contentLen = await h.ev(
                `(() => { const n=document.querySelector('nav'); const c=n&&n.nextElementSibling; return c?(c.textContent||'').trim().length:0; })()`
            );
            steps.push({
                step: `jarvis fixture "${s}" -> bar present + content non-empty`,
                ok: clicked === true && contentLen > 0,
                detail: `clicked=${clicked} contentLen=${contentLen}`,
            });
            await h.shot(`cdp-shots/jarvis-${s}.png`);
        }
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- jarvis fleet mode: the migrated fleet manager (Plan 3) ------------------------------------
// Create a channel so Fleet mode has one to manage, switch to Jarvis > Fleet, select the channel via
// Fleet mode's own selector, and assert the autonomy toggle + roster region render. No worker is
// dispatched — the roster's empty-state is a valid render assertion and keeps the run light. Channel +
// temp dir are cleaned up in teardown (mirrors runs-lifecycle).
//
// NOTE (Plan 3): this also covers the Fleet-side landing of the @jarvis summary handoff — runSummary
// renders into the same region the handoff drives. The full composer->handoff->Fleet E2E is deferred to
// Plan 4: nothing sends @jarvis-classified text yet (the Launch composer routes @jarvis to a run;
// mentionCandidates' @jarvis token is wired to no composer), so the reroute's trigger has no live entry
// point until Plan 4 adds the Ctrl+P ask-jarvis group. The reroute's decision (dispatch vs summary) is
// covered by channelmessages.test.ts.
const jarvisFleet = {
    name: "jarvis-fleet",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-fleet-"));
        const ch = await h.rpc("createchannel", { name: "verify-fleet", projectpath: cwd });
        return { cwd, channelId: ch.oid };
    },
    async assert(h, ctx) {
        const steps = [];
        await h.goto("jarvis");
        // switch to Fleet mode — the header toggle button's textContent is the lowercase mode name.
        const toFleet = await h.ev(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'fleet');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 800))"); // settle loadChannels + render
        const hasSelector = await h.ev(
            `(() => { const t = document.body.innerText || ''; return t.includes('Fleet') && !!document.querySelector('select'); })()`
        );
        steps.push({
            step: `switch to Fleet mode -> "Fleet" label + channel selector present`,
            ok: toFleet === true && hasSelector === true,
            detail: `clicked=${toFleet} selector=${hasSelector}`,
        });
        // select the created channel through Fleet mode's own <select> (React-controlled value setter + a
        // bubbling change event — the standard programmatic-change pattern for a controlled select).
        const selected = await h.ev(`(() => {
            const sel = document.querySelector('select');
            if (!sel) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            setter.call(sel, ${JSON.stringify(ctx.channelId)});
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 900))"); // settle selectChannel + roster derive
        const rendered = await h.ev(`(() => {
            const t = document.body.innerText || '';
            return {
                autonomy: t.includes('Handling asks') || t.includes('Observing'),
                roster: t.includes('No workers dispatched') && t.includes('working'),
            };
        })()`);
        steps.push({
            step: `select channel -> autonomy toggle + roster region render`,
            ok: selected === true && rendered.autonomy === true && rendered.roster === true,
            detail: JSON.stringify(rendered),
        });
        await h.shot("cdp-shots/jarvis-fleet.png");
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit"); // leave the app where a human expects it
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

const jarvisMultiturn = {
    name: "jarvis-multiturn",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("jarvis");
        const asked = await h.ev(`(() => {
            const input = document.querySelector('input[placeholder="Ask Jarvis…"]');
            if (!input) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, 'what changed in the worktree work');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return true;
        })()`);
        await h.ev("new Promise((resolve) => setTimeout(resolve, 4000))");
        const firstTurn = await h.ev(
            `(() => (document.body.innerText || '').includes('what changed in the worktree work'))()`
        );
        steps.push({
            step: "first question renders as a user turn",
            ok: asked === true && firstTurn === true,
            detail: `asked=${asked} firstTurn=${firstTurn}`,
        });

        await h.ev("location.reload()");
        await h.ev("new Promise((resolve) => setTimeout(resolve, 2500))");
        await h.goto("jarvis");
        const persisted = await h.ev(
            `(() => (document.body.innerText || '').includes('what changed in the worktree work'))()`
        );
        steps.push({
            step: "conversation persists across reload in the history rail",
            ok: persisted === true,
            detail: `persisted=${persisted}`,
        });

        await h.shot("cdp-shots/jarvis-multiturn.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

export const SCENARIOS = [runsLifecycle, surfaceSmoke, jarvisStates, jarvisFleet, jarvisMultiturn];
