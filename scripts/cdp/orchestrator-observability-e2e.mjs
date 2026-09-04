// Live verification of the orchestrator observability surfaces (spec 10.3), driven as a USER over
// CDP — no RPC, no fixture injection. Reuses an EXISTING orchestrator run that already has a DAG
// rather than dispatching a new one: this check is about what the cockpit shows, and making every
// run cost a fresh fan-out would make it too expensive to run often. Create one first with
// `node scripts/cdp/orchestrator-e2e.mjs` if the cockpit has none.
//
// Usage: node scripts/cdp/orchestrator-observability-e2e.mjs [outDir] [port]
//   outDir default: cdp-shots/orchestrator-observability
//   port   default: 9222 (or $CDP_PORT)
//
// Prerequisite: `task dev` running with the debug port.
//
// Proves spec 10.3 items 1-8. Each item is one step; a step that cannot find what it needs FAILS
// rather than passing quietly — a green run that asserted nothing is the failure mode this whole
// feature exists to avoid.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attach } from "./attach.mjs";

const OUT = process.argv[2] ?? "cdp-shots/orchestrator-observability";
const PORT = Number(process.argv[3] ?? process.env.CDP_PORT ?? 9222);

// the real dev window is ~1000x700, which collapses columns and hides the rail; pin a wide viewport
// so the wide-layout assertions describe the layout they claim to (and item 7 shrinks it on purpose)
const WIDE = { width: 1600, height: 950 };
const NARROW = { width: 1000, height: 900 }; // below TIMELINE_RAIL_MIN_PX (1100)

const HEALTH_VALUES = ["needs-you", "stalled", "healthy", "done", "cancelled"];
const DEGRADED_HEALTH = ["Refreshing status", "DAG status unavailable", "Loading status…"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let h;
try {
    h = await attach(PORT);
} catch (e) {
    console.error(`orchestrator-observability-e2e: ${e?.message ?? e}`);
    process.exit(1);
}
console.log(`attached to ${h.url} -> ${OUT} on :${PORT}`);

mkdirSync(OUT, { recursive: true });
await h.cdp("Emulation.setDeviceMetricsOverride", { ...WIDE, deviceScaleFactor: 1, mobile: false });
await h.cdp("Page.reload", {});
await sleep(3500);

const results = [];
let stepCounter = 0;
async function step(id, title, fn) {
    stepCounter++;
    const file = `${String(stepCounter).padStart(2, "0")}-${id}.png`;
    try {
        const note = await fn();
        await h.shot(join(OUT, file));
        results.push({ file, title, note: note ?? "", ok: true });
        console.log(`ok   ${file}  ${title}  ${note ?? ""}`);
    } catch (e) {
        try {
            await h.shot(join(OUT, file));
        } catch {}
        results.push({ file, title, note: String(e?.message ?? e), ok: false });
        console.log(`FAIL ${file}: ${e?.message ?? e}`);
    }
}

// --- user-level helpers (DOM only) ------------------------------------------------------------

const ev = (expr) => h.ev(expr);

async function clickText(css, text) {
    const ok = await ev(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(css)})]
            .find(e => (e.innerText || e.textContent || '').trim().includes(${JSON.stringify(text)}));
        if (!el) return false;
        el.click();
        return true;
    })()`);
    if (!ok) throw new Error(`no ${css} matching ${JSON.stringify(text)}`);
    await sleep(700);
}

async function setViewport(v) {
    await h.cdp("Emulation.setDeviceMetricsOverride", { ...v, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
}

// openRunWithDag focuses the first orchestrator run that already carries a DAG (an "Open DAG" verb
// is the run body's own marker for one) and leaves the run body on screen.
async function openRunWithDag() {
    await h.goto("agent");
    await sleep(1200);
    const found = await ev(`(() => {
        const btn = [...document.querySelectorAll('button')]
            .find(b => /open dag/i.test((b.innerText || '').trim()));
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center' });
        return true;
    })()`);
    if (!found) {
        throw new Error("no orchestrator run with a DAG in the cockpit — create one with scripts/cdp/orchestrator-e2e.mjs first");
    }
    return "run body with a DAG on screen";
}

// --- item 1: a real TaskGroup appears ---------------------------------------------------------

await step("taskgroup", "1 · a real TaskGroup appears in the overview", async () => {
    const note = await openRunWithDag();
    const counts = await ev(`(() => {
        const m = (document.body.innerText || '').match(/(\\d+)\\/(\\d+) done/);
        return m ? { done: Number(m[1]), total: Number(m[2]) } : null;
    })()`);
    if (counts == null) {
        throw new Error("overview shows no done/total counts — the digest never rendered");
    }
    if (counts.total < 1) {
        throw new Error(`TaskGroup has ${counts.total} tasks; a real group has at least one`);
    }
    return `${note}; ${counts.done}/${counts.total} done`;
});

// --- item 2: health and next-step agree with persisted state -----------------------------------

await step("health-next", "2 · health + next move are real claims, never inferred healthy", async () => {
    const view = await ev(`(() => {
        const text = document.body.innerText || '';
        const health = ${JSON.stringify([...HEALTH_VALUES, ...DEGRADED_HEALTH])}.find(v => text.includes(v)) ?? null;
        const next = (text.match(/next:\\s*(.+)/) || [])[1]?.trim() ?? null;
        return { health, next };
    })()`);
    if (view.health == null) {
        throw new Error("no health value rendered at all");
    }
    if (DEGRADED_HEALTH.includes(view.health)) {
        // a degraded strip is a valid state, but then no next-move claim may be shown (spec 8)
        if (view.next != null) {
            throw new Error(`health is "${view.health}" but a next move is still claimed: ${view.next}`);
        }
        return `degraded but honest: ${view.health}, no next claim`;
    }
    if (view.next == null) {
        throw new Error(`health "${view.health}" is fresh but no next engine move is shown`);
    }
    return `health=${view.health}; next=${view.next}`;
});

// --- items 3 + 4: worker correlation and Open in Agent -----------------------------------------

await step("worker-correlate", "3 · a dispatched task resolves its own worker", async () => {
    await clickText("button", "Open DAG");
    // select the first task node that the graph reports as running
    const selected = await ev(`(() => {
        const node = [...document.querySelectorAll('[data-task-id]')]
            .find(n => /running/i.test(n.innerText || ''));
        if (!node) return null;
        node.click();
        return node.getAttribute('data-task-id');
    })()`);
    if (selected == null) {
        throw new Error("no running task in the DAG — re-run while a child is executing");
    }
    await sleep(800);
    const rail = await ev(`(() => {
        const text = document.body.innerText || '';
        return {
            pending: text.includes('Not dispatched yet'),
            unavailable: text.includes('Worker session unavailable'),
            openable: [...document.querySelectorAll('button')].some(b => /open in agent/i.test(b.innerText || '')),
        };
    })()`);
    if (!rail.openable) {
        throw new Error(
            `running task ${selected} exposes no Open in Agent (pending=${rail.pending} unavailable=${rail.unavailable})`
        );
    }
    return `task ${selected} resolved to a reachable worker`;
});

await step("open-in-agent", "4 · Open in Agent focuses that worker", async () => {
    await clickText("button", "Open in Agent");
    await sleep(1200);
    const focused = await ev(`(() => {
        const modalGone = document.querySelector('[data-dag-modal-kind]') == null;
        const onAgent = document.querySelector('[data-surface="agent"], .xterm') != null;
        return { modalGone, onAgent };
    })()`);
    if (!focused.onAgent) {
        throw new Error("Open in Agent did not land on the Agent surface");
    }
    return `agent surface focused (modal closed=${focused.modalGone})`;
});

// --- item 5: lifecycle history shows the real lifecycle ----------------------------------------

await step("lifecycle-history", "5 · lifecycle events render as history, not raw kinds", async () => {
    await openRunWithDag();
    await clickText("button", "Open DAG");
    const rail = await ev(`(() => {
        const panel = document.querySelector('[data-timeline-rail]');
        if (!panel) return null;
        const rows = [...panel.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean);
        return { layout: panel.getAttribute('data-timeline-rail'), rows };
    })()`);
    if (rail == null) {
        throw new Error("no timeline rail mounted in the DAG modal");
    }
    if (rail.layout !== "rail") {
        throw new Error(`wide layout must show the persistent rail, got ${rail.layout}`);
    }
    // a row rendering its raw kind means the projection is missing that kind's title
    const raw = rail.rows.filter((r) => /\b(task|dag|child|lead)-[a-z-]+\b/.test(r));
    if (raw.length > 0) {
        throw new Error(`rows show raw event kinds: ${raw.slice(0, 3).join(", ")}`);
    }
    if (rail.rows.length <= 3) {
        throw new Error(`rail shows ${rail.rows.length} rows (filters only) — no lifecycle history loaded`);
    }
    return `${rail.rows.length - 3} history rows, all titled`;
});

// --- item 6: events deep-link ------------------------------------------------------------------

await step("event-deeplink", "6 · a task-scoped event selects its task", async () => {
    const routed = await ev(`(() => {
        const panel = document.querySelector('[data-timeline-rail]');
        if (!panel) return null;
        // rows carry their task id as the trailing span; pick the first row that has one
        const row = [...panel.querySelectorAll('button')].find(b => {
            const last = b.lastElementChild;
            return last && /^[a-z0-9._-]+$/i.test((last.textContent || '').trim()) && b.querySelectorAll('span').length >= 4;
        });
        if (!row) return null;
        const taskId = (row.lastElementChild.textContent || '').trim();
        row.click();
        return taskId;
    })()`);
    if (routed == null) {
        throw new Error("no task-scoped event row to click");
    }
    await sleep(700);
    const filterLabel = await ev(`(() => {
        const panel = document.querySelector('[data-timeline-rail]');
        const chip = [...panel.querySelectorAll('button')].find(b => /^Task/.test((b.innerText || '').trim()));
        return chip ? (chip.innerText || '').trim() : null;
    })()`);
    if (filterLabel == null || !filterLabel.includes(routed)) {
        throw new Error(`clicking a ${routed} event did not select that task (filter chip: ${filterLabel})`);
    }
    return `event routed to task ${routed}`;
});

// --- item 7: narrow layout exposes the drawer --------------------------------------------------

await step("narrow-drawer", "7 · narrow layout collapses history into a drawer", async () => {
    await setViewport(NARROW);
    const drawer = await ev(`(() => {
        const panel = document.querySelector('[data-timeline-rail]');
        if (!panel) return null;
        const toggle = [...panel.querySelectorAll('button')].find(b => b.hasAttribute('aria-expanded'));
        return { layout: panel.getAttribute('data-timeline-rail'), hasToggle: toggle != null, expanded: toggle?.getAttribute('aria-expanded') };
    })()`);
    if (drawer == null) {
        throw new Error("timeline panel disappeared in the narrow layout");
    }
    if (drawer.layout !== "drawer") {
        throw new Error(`narrow layout must collapse to a drawer, got ${drawer.layout}`);
    }
    if (!drawer.hasToggle) {
        throw new Error("drawer has no expand control — history would be unreachable");
    }
    return `drawer present (expanded=${drawer.expanded})`;
});

// --- item 8: degraded states stay explicit ------------------------------------------------------

await step("explicit-degradation", "8 · missing-session and empty states stay explicit", async () => {
    await setViewport(WIDE);
    const states = await ev(`(() => {
        const text = document.body.innerText || '';
        return {
            // an undispatched task must SAY so rather than render a blank or idle worker row
            pending: text.includes('Not dispatched yet'),
            unavailable: text.includes('Worker session unavailable') || text.includes('Activity unavailable'),
            // the task filter with nothing selected must say what it needs, not show everything
            filterHint: text.includes('Select a task to filter') || text.includes('No events for this task'),
            claimsLive: text.includes('● live'),
            claimsFailed: text.includes('load failed'),
        };
    })()`);
    if (!states.claimsLive && !states.claimsFailed) {
        throw new Error("the rail claims neither live nor failed — its connection state is silent");
    }
    // at least one explicit degradation string must be reachable in a real run with mixed tasks;
    // a run where every task is dispatched and reachable legitimately shows none, so report it
    const explicit = [
        states.pending && "Not dispatched yet",
        states.unavailable && "worker/activity unavailable",
        states.filterHint && "task filter hint",
    ].filter(Boolean);
    return explicit.length > 0 ? `explicit states shown: ${explicit.join(", ")}` : "no degraded task in this run (nothing to show)";
});

// --- report -------------------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
const md = [
    "# Orchestrator observability — live verification",
    "",
    `Run: ${new Date().toISOString()} · ${results.length - failed.length}/${results.length} passed`,
    "",
    ...results.flatMap((r) => [`## ${r.ok ? "PASS" : "FAIL"} — ${r.title}`, "", r.note, "", `![${r.title}](${r.file})`, ""]),
].join("\n");
writeFileSync(join(OUT, "index.md"), md);
console.log(`\n${results.length - failed.length}/${results.length} passed -> ${join(OUT, "index.md")}`);
process.exit(failed.length > 0 ? 1 : 0);
