// Cockpit review scenarios: Events rail, hints bar and cheat sheet.
// F19: an asked event recorded before its question arrived takes the question. F11: a project scope narrows the
// rail. F20: the collapsed rail shows the unread count. F21: `?` opens the cheat sheet on the Cockpit group. F17: the
// hints bar is one line, the `?` chip never clips, and it lists space peek but no esc back. The fixture roster is read
// once at boot, so arrange writes it and reloads; state changes are patched into the loaded roster.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { MODELS_VIEWPORT, TREE_RAIL_FIXTURE, lookEval, polishNap, polishReload, polishWaitFor } from "./scenarios-shared.mjs";

const LATE_ID = "fx-rail-help-late";
const OTHER_ID = "fx-rail-help-other";
const LATE_PROJECT = "rail-help-a";
const OTHER_PROJECT = "rail-help-b";
const LATE_QUESTION = "Which port should the rail-help server listen on?";
const OTHER_QUESTION = "Keep the retry budget at three?";
const DEV_WINDOW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
// a cold scan of every transcript root outlasts one CDP command, so it runs in the page and is polled
const SESSIONS_SCAN_TIMEOUT_MS = 120_000;

// an agent with no transcript entries stays off the grid, and an empty grid shows no hints bar
const roster = (transcriptPath) => [
    { id: LATE_ID, name: "rail-help late", project: LATE_PROJECT, task: "pick a port", state: "working", agent: "claude", model: "opus", activeMs: 60_000, blockId: "fx-blk-rail-help-late", transcriptPath },
    { id: OTHER_ID, name: "rail-help other", project: OTHER_PROJECT, task: "tune retries", state: "working", agent: "claude", model: "opus", activeMs: 60_000, blockId: "fx-blk-rail-help-other", transcriptPath },
];

// a transcript the archive scan already lists (read, never written), so both agents have entries to show
async function borrowTranscript(h) {
    await h.ev(`void window.TabRpcClient.wshRpcCall("getsessionsactivity", { windowdays: 30, limit: 100 }, { timeout: ${SESSIONS_SCAN_TIMEOUT_MS} }).then(
        (r) => (window.__railHelpScan = { path: (r?.sessions ?? []).find((s) => s.transcriptpath)?.transcriptpath ?? null }),
        (e) => (window.__railHelpScan = { error: String(e?.message ?? e) })
    )`);
    await polishWaitFor(h, "window.__railHelpScan != null", SESSIONS_SCAN_TIMEOUT_MS);
    const scan = await h.ev("(() => { const s = window.__railHelpScan; delete window.__railHelpScan; return s ?? null; })()");
    if (scan?.error != null) throw new Error(`the sessions scan failed: ${scan.error}`);
    if (!scan?.path) throw new Error("no listed session has a transcript to borrow");
    return scan.path;
}
const ask = (id, question) => ({
    askId: `${id}-ask`,
    oref: `block:fx-blk-${id.replace(/^fx-/, "")}`,
    questions: [{ header: "Q", question, options: [{ label: "yes" }, { label: "no" }] }],
});

// the cockpit's model, found the way the other scenarios find it: on the nav rail's props
const MODEL = `(() => {
    const nav = document.querySelector('nav');
    const key = nav && Object.keys(nav).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? nav[key] : null; f != null; f = f.return) {
        if (f.memoizedProps?.model?.surfaceAtom != null) return f.memoizedProps.model;
    }
    return null;
})()`;
const RAIL = `document.querySelector('aside[aria-label="Events"]')`;
const HINTS = `document.querySelector('[data-cockpit-hints]')`;

const patch = (h, id, fields) => h.ev(`window.__cockpitRosterFixture?.patch(${JSON.stringify(id)}, ${JSON.stringify(fields)})`);
const setAtom = (h, atomName, value) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const model = ${MODEL};
        if (!model) throw new Error("no cockpit model");
        globalStore.set(model.${atomName}, ${JSON.stringify(value)});
        await nap(400);
    `);
const railText = () => `(${RAIL}?.textContent ?? '').replace(/\\s+/g, ' ')`;

// the bar's geometry: its height, the hint row's line height, which hints show whole and which dropped, and where
// the ? chip sits against the bar and the window
const hintsGeometry = (h) =>
    h.ev(`(() => {
        const bar = ${HINTS};
        const row = bar?.querySelector('[data-cockpit-hints-row]');
        const help = bar?.querySelector('[data-cockpit-help]');
        if (!bar || !row || !help) return { missing: { bar: !!bar, row: !!row, help: !!help } };
        const b = bar.getBoundingClientRect(), r = row.getBoundingClientRect(), q = help.getBoundingClientRect();
        const hints = [...row.children].map((c) => {
            const x = c.getBoundingClientRect();
            return { text: c.textContent, shown: x.top >= r.top - 0.5 && x.bottom <= r.bottom + 0.5 && x.right <= r.right + 0.5, below: x.top >= r.bottom - 0.5 };
        });
        return {
            width: window.innerWidth,
            barHeight: Math.round(b.height),
            rowHeight: Math.round(r.height),
            shown: hints.filter((x) => x.shown).length,
            // a hint is either whole on the line or wrapped below it, never cut at the edge
            partial: hints.filter((x) => !x.shown && !x.below).map((x) => x.text),
            help: { left: Math.round(q.left), right: Math.round(q.right), width: Math.round(q.width), top: Math.round(q.top), bottom: Math.round(q.bottom) },
            helpInBar: q.width > 0 && q.left >= b.left && q.right <= b.right && q.right <= window.innerWidth && q.top >= b.top && q.bottom <= b.bottom,
        };
    })()`);

export const cockpitRailHelp = {
    name: "cockpit-rail-help",
    surface: "cockpit",
    async arrange(h) {
        const ctx = {};
        try {
            const transcriptPath = await borrowTranscript(h);
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(roster(transcriptPath), null, 2));
            ctx.wroteFixture = true;
            await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
            await polishReload(h);
            await h.goto("cockpit");
            const ready = await polishWaitFor(
                h,
                `(() => { const m = ${MODEL}; return !!m && !!${HINTS}?.querySelector('[data-cockpit-help]') && !!window.__cockpitRosterFixture; })()`,
                15_000
            );
            if (!ready) ctx.arrangeError = "the cockpit never came up with the fixture roster";
            // the rail records a transition only once it has seen the agent, so it must have seen both working
            await polishNap(800);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError) return [{ step: "cockpit-rail-help: arrange", ok: false, detail: ctx.arrangeError }];
        const steps = [];
        const run = async (step, fn) => {
            try {
                steps.push({ step, ...(await fn()) });
            } catch (e) {
                steps.push({ step, ok: false, detail: String(e?.message ?? e) });
            }
        };

        await run("an asked event whose question arrived late shows the question", async () => {
            await setAtom(h, "railOpenAtom", true);
            // the state change lands first, with no question yet: the rail records an empty asked event
            await patch(h, LATE_ID, { state: "asking", blockedMs: 0 });
            const empty = await polishWaitFor(h, `${railText()}.includes('rail-help late') && ${railText()}.includes('asked')`, 5000);
            await patch(h, LATE_ID, { ask: ask(LATE_ID, LATE_QUESTION) });
            const filled = await polishWaitFor(h, `${railText()}.includes(${JSON.stringify(LATE_QUESTION)})`, 5000);
            await h.shot("cdp-shots/cockpit-rail-help-late-question.png");
            return { ok: empty && filled, detail: JSON.stringify({ emptyEventShown: empty, questionFilled: filled }) };
        });

        await run("a project scope narrows the Events rail", async () => {
            await patch(h, OTHER_ID, { state: "asking", blockedMs: 0, ask: ask(OTHER_ID, OTHER_QUESTION) });
            const both = await polishWaitFor(h, `${railText()}.includes(${JSON.stringify(OTHER_QUESTION)})`, 5000);
            await setAtom(h, "projectFilterAtom", LATE_PROJECT);
            const scoped = await h.ev(`({ late: ${railText()}.includes(${JSON.stringify(LATE_QUESTION)}), other: ${railText()}.includes(${JSON.stringify(OTHER_QUESTION)}) })`);
            await h.shot("cdp-shots/cockpit-rail-help-scoped.png");
            await setAtom(h, "projectFilterAtom", "all");
            return { ok: both && scoped.late && !scoped.other, detail: JSON.stringify({ bothBeforeScope: both, ...scoped }) };
        });

        await run("the collapsed Events rail shows the unread count", async () => {
            const fresh = await h.ev(`(${RAIL}?.textContent ?? '').match(/New · (\\d+)/)?.[1] ?? null`);
            await setAtom(h, "railOpenAtom", false);
            await polishWaitFor(h, `!!${RAIL}?.querySelector('[data-rail-unread]')`, 3000);
            const badge = await h.ev(`${RAIL}?.querySelector('[data-rail-unread]')?.textContent ?? null`);
            await h.shot("cdp-shots/cockpit-rail-help-collapsed.png");
            await setAtom(h, "railOpenAtom", true);
            return { ok: fresh === "2" && badge === "2", detail: JSON.stringify({ newInOpenRail: fresh, badge }) };
        });

        await run("the ? chip opens the cheat sheet on the Cockpit group", async () => {
            const r = await lookEval(h, `
                ${HINTS}.querySelector('[data-cockpit-help]').click();
                await until(() => document.querySelector('[data-cheatsheet-group]') != null, 3000);
                await nap(300);
                return { first: document.querySelector('[data-cheatsheet-group]')?.getAttribute('data-cheatsheet-group') ?? null };
            `);
            await h.shot("cdp-shots/cockpit-rail-help-cheatsheet.png");
            await lookEval(h, `
                const { globalStore } = await mod("app/store/jotaiStore.ts");
                const { cheatsheetOpenAtom } = await mod("app/cockpit/shortcuts-cheatsheet.tsx");
                globalStore.set(cheatsheetOpenAtom, false);
                await nap(300);
            `);
            return { ok: r.first === "Cockpit", detail: JSON.stringify(r) };
        });

        await run("at 1600 wide with the rail open the hints bar is one line and the ? chip is visible", async () => {
            await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
            await setAtom(h, "railOpenAtom", true);
            await polishNap(600); // the rail's width slide
            const g = await hintsGeometry(h);
            await h.shot("cdp-shots/cockpit-rail-help-hints-1600.png");
            const ok = g.width === MODELS_VIEWPORT.width && g.rowHeight === 20 && g.barHeight <= 34 && g.shown > 0 && g.partial.length === 0 && g.helpInBar;
            return { ok, detail: JSON.stringify(g) };
        });

        await run("at 1000 wide the ? chip is visible", async () => {
            await h.cdp("Emulation.setDeviceMetricsOverride", DEV_WINDOW);
            await polishNap(600);
            const g = await hintsGeometry(h);
            await h.shot("cdp-shots/cockpit-rail-help-hints-1000.png");
            const ok = g.width === DEV_WINDOW.width && g.rowHeight === 20 && g.partial.length === 0 && g.helpInBar;
            return { ok, detail: JSON.stringify(g) };
        });

        await run("the hints show space peek and no esc back", async () => {
            const t = await h.ev(`[...(${HINTS}?.querySelector('[data-cockpit-hints-row]')?.children ?? [])].map((c) => c.textContent.replace(/\\s+/g, ' ').trim())`);
            const ok = t.includes("spacepeek") && !t.includes("escback") && t.indexOf("spacepeek") === t.indexOf("nnext ask") + 1;
            return { ok, detail: JSON.stringify(t) };
        });
        return steps;
    },
    async teardown(h, ctx) {
        if (ctx?.wroteFixture) rmSync(TREE_RAIL_FIXTURE, { force: true });
        await h.cdp("Emulation.clearDeviceMetricsOverride");
        // onto the live roster again, with the fixture's events gone with the page
        await polishReload(h);
        await h.goto("cockpit");
    },
};
