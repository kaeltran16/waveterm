// Brief polish scenarios: the initiatives and peeks polish sweeps.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    MIN_FONT_PX,
    MODELS_VIEWPORT,
    OBS_NARROW,
    PEEKS_ESC,
    floorStep,
    holdRpc,
    lookEval,
    lookPlaceholders,
    lookShot,
    paintEval,
    placeholderStep,
    polishNap,
    polishReload,
    polishWaitFor,
    releaseRpc,
    teardownFixtureRun,
} from "./scenarios-shared.mjs";

// --- brief-initiatives-polish: a staged and a flat initiative, their sidebar and activity ---------
// Two throwaway efforts made over RPC: one staged (with an unstaged tail), one flat whose feed holds a
// note-carrying status change, a bare one, and a long note. Every surface it opens is swept for text
// under MIN_FONT_PX.
const POLISH_STAGED = "verify initiatives polish · staged";
const POLISH_FLAT = "verify initiatives polish · flat";
const POLISH_ADDED = "F4 added by the scenario";
const polishRow = (title) =>
    `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => r.innerText.includes(${JSON.stringify(title)}))`;
const polishDetail = (title) => `${polishRow(title)}?.parentElement?.querySelector('[data-jarvis-initiative-detail="true"]')`;

// every element whose own text is under the floor; svg is drawn, not read
const polishSweep = (rootExpr) => `(() => {
    const root = ${rootExpr};
    if (!root) return null;
    const offenders = [];
    let seen = 0;
    for (const el of [root, ...root.querySelectorAll('*')]) {
        if (el.closest('svg')) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim() !== '');
        if (!own) continue;
        seen++;
        if (parseFloat(getComputedStyle(el).fontSize) < ${MIN_FONT_PX}) {
            const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join('').trim();
            offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80), text: text.slice(0, 40) });
        }
    }
    return { seen, offenders: offenders.slice(0, 5), count: offenders.length };
})()`;
const sweptOk = (s) => s != null && s.seen > 0 && s.count === 0;

export const briefInitiativesPolish = {
    name: "brief-initiatives-polish",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { oids: [] };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            const staged = await h.rpc("effortcreate", {
                title: POLISH_STAGED,
                chunks: [{ label: "S1" }, { label: "S2" }, { label: "U1" }],
            });
            ctx.staged = staged.effortoid;
            ctx.oids.push(ctx.staged);
            await h.rpc("effortmutate", {
                effortoid: ctx.staged,
                author: "you",
                ops: [
                    { op: "setChunkStage", chunk: "S1", stage: "Stage one" },
                    { op: "setChunkStage", chunk: "S2", stage: "Stage one" },
                ],
            });
            const flat = await h.rpc("effortcreate", {
                title: POLISH_FLAT,
                chunks: [{ label: "F1" }, { label: "F2" }, { label: "F3" }],
            });
            ctx.flat = flat.effortoid;
            ctx.oids.push(ctx.flat);
            await h.rpc("effortmutate", {
                effortoid: ctx.flat,
                author: "you",
                ops: [
                    {
                        op: "setChunkStatus",
                        chunk: "F1",
                        status: "done",
                        note: "Landed the first slice. The rest waits on review. Nothing else moved.",
                    },
                    { op: "setChunkStatus", chunk: "F2", status: "active" },
                    {
                        op: "appendNote",
                        chunk: "F2",
                        note:
                            "Started on the second slice. " +
                            "It touches the feed model, the view and the scenario, and each of those reads the others. ".repeat(12),
                    },
                ],
            });
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. the two initiatives were made", false, ctx.arrangeError);
            return steps;
        }
        await h.goto("jarvis");
        // a briefing fixture another scenario left on hides the live data, and only a reload clears it
        const fixtureOn = await h.ev(
            `[...document.querySelectorAll('[data-briefing-fixture]')].some((b) => b.className.includes('bg-accentbg'))`
        );
        if (fixtureOn) await polishReload(h);
        const both = `!!${polishRow(POLISH_STAGED)} && !!${polishRow(POLISH_FLAT)}`;
        // the Brief may hold a snapshot from before the efforts existed; one reload picks them up
        if (!(await polishWaitFor(h, both, 8000))) {
            await polishReload(h);
        }
        const rows = await polishWaitFor(h, both, 15000);
        rec("0. both initiatives show on the Brief", rows, JSON.stringify({ staged: ctx.staged, flat: ctx.flat }));
        if (!rows) return steps;

        // 1. the staged plan keeps its stage header
        await h.ev(`${polishRow(POLISH_STAGED)}?.click()`);
        await polishWaitFor(h, `!!${polishDetail(POLISH_STAGED)}`, 3000);
        await polishNap(400);
        const stagedHeads = await h.ev(`${polishDetail(POLISH_STAGED)}?.querySelectorAll('[data-jarvis-tracker-stage]').length ?? 0`);
        const stagedSweep = await h.ev(polishSweep(polishDetail(POLISH_STAGED)));
        await h.shot("cdp-shots/brief-initiatives-polish-1-staged.png");
        rec(
            "1. a staged initiative draws a stage header, and nothing in it is under 10.5px",
            stagedHeads >= 1 && sweptOk(stagedSweep),
            JSON.stringify({ stagedHeads, sweep: stagedSweep })
        );

        // 2. the flat plan draws no header, every chunk, and "+ Add chunk" after the last one
        await h.ev(`${polishRow(POLISH_FLAT)}?.click()`);
        await polishWaitFor(h, `!!${polishDetail(POLISH_FLAT)}`, 3000);
        await polishNap(400);
        const flat = await h.ev(`(() => {
            const d = ${polishDetail(POLISH_FLAT)};
            if (!d) return null;
            const chunks = [...d.querySelectorAll('[data-jarvis-tracker-chunk]')];
            const add = d.querySelector('[data-jarvis-add-chunk]');
            const last = chunks[chunks.length - 1];
            return {
                stages: d.querySelectorAll('[data-jarvis-tracker-stage]').length,
                chunks: chunks.length,
                add: add != null,
                afterLast: add != null && last != null && !!(last.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING),
            };
        })()`);
        const flatSweep = await h.ev(polishSweep(polishDetail(POLISH_FLAT)));
        await h.shot("cdp-shots/brief-initiatives-polish-2-flat.png");
        rec(
            "2. a flat initiative draws no stage header, all 3 chunks and + Add chunk after the last, nothing under 10.5px",
            flat != null && flat.stages === 0 && flat.chunks === 3 && flat.add && flat.afterLast && sweptOk(flatSweep),
            JSON.stringify({ flat, sweep: flatSweep })
        );

        // 2b. that "+ Add chunk" adds to stage "" (the add is a real write on a throwaway effort)
        let added = null;
        if (flat?.add) {
            await h.ev(`${polishDetail(POLISH_FLAT)}?.querySelector('[data-jarvis-add-chunk]')?.click()`);
            await polishNap(200);
            await h.ev(`(() => {
                const input = ${polishDetail(POLISH_FLAT)}?.querySelector('input');
                if (!input) return false;
                const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                set.call(input, ${JSON.stringify(POLISH_ADDED)});
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                return true;
            })()`);
            for (let waited = 0; waited < 5000 && added == null; waited += 250) {
                await polishNap(250);
                const { effort } = (await h.rpc("effortget", { effortoid: ctx.flat })) ?? {};
                const chunks = effort?.chunks ?? [];
                const at = chunks.findIndex((c) => c.label === POLISH_ADDED);
                if (at >= 0) added = { at, of: chunks.length, stage: chunks[at].stage ?? "" };
            }
        }
        rec(
            "2b. + Add chunk on a flat initiative adds the chunk at the end, to stage \"\"",
            added != null && added.stage === "" && added.at === added.of - 1,
            JSON.stringify(added)
        );

        // 3. a flat chunk's sidebar names no stage
        await h.ev(
            `${polishDetail(POLISH_FLAT)}?.querySelector('[data-jarvis-tracker-chunk="F1"]')?.click()`
        );
        const sidebarUp = await polishWaitFor(h, `!!document.querySelector('[data-jarvis-chunk-sidebar]')`, 3000);
        await polishNap(300);
        const crumb = await h.ev(`document.querySelector('[data-jarvis-chunk-sidebar]')?.innerText ?? ''`);
        const sidebarSweep = await h.ev(polishSweep(`document.querySelector('[data-jarvis-chunk-sidebar]')`));
        await h.shot("cdp-shots/brief-initiatives-polish-3-sidebar.png");
        rec(
            "3. a flat chunk opens the Chunk sidebar with no \"unstaged\" crumb, nothing under 10.5px",
            sidebarUp && !/unstaged/i.test(crumb) && sweptOk(sidebarSweep),
            JSON.stringify({ sidebarUp, unstaged: /unstaged/i.test(crumb), sweep: sidebarSweep })
        );
        const SIDEBAR = `document.querySelector('[data-jarvis-chunk-sidebar]')`;
        steps.push(await floorStep(h, `3b. no visible text in the Chunk sidebar is under ${MIN_FONT_PX}px`, SIDEBAR));

        // 3c. under a 1280px container the sidebar overlays the content, on the side-sheet shadow
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_NARROW);
        await polishNap(500);
        const side = await paintEval(h, `return shadowVs(${SIDEBAR}, "@max-[1280px]:shadow-sheet-side", ${OBS_NARROW.width});`);
        await h.shot(lookShot("brief-initiatives-polish-sidebar-narrow"));
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await polishNap(300);
        rec("3c. at a 1000px window the Chunk sidebar casts shadow-sheet-side over no raw overlay", side.ok === true, JSON.stringify(side));

        // 4. its activity link opens the grouped feed
        await h.ev(
            `[...(document.querySelector('[data-jarvis-chunk-sidebar]')?.querySelectorAll('button') ?? [])].find((b) => /^activity/i.test(b.innerText.trim()) || /activity/i.test(b.getAttribute('aria-label') ?? ''))?.click()`
        );
        const SHEET = `document.querySelector('[data-jarvis-brief-sheet="effort"]')`;
        const sheetUp = await polishWaitFor(h, `!!${SHEET}?.querySelector('[data-jarvis-effort-note]')`, 5000);
        await polishNap(300);
        const feed = await h.ev(`(() => {
            const s = ${SHEET};
            return s
                ? {
                      today: s.textContent.includes('Today'),
                      notes: s.querySelectorAll('[data-jarvis-effort-note]').length,
                      next: !!s.querySelector('[data-jarvis-effort-section="next"]'),
                      bar: !!s.querySelector('[role="img"][aria-label*="done"]'),
                  }
                : null;
        })()`);
        const sheetSweep = await h.ev(polishSweep(SHEET));
        await h.shot("cdp-shots/brief-initiatives-polish-4-activity.png");
        rec(
            "4. the activity sheet opens on its progress bar, a Next card, a Today divider and note lines, nothing under 10.5px",
            sheetUp && feed != null && feed.today && feed.notes >= 1 && feed.next && feed.bar && sweptOk(sheetSweep),
            JSON.stringify({ feed, sweep: sheetSweep })
        );
        steps.push(await floorStep(h, `4b. no visible text in the initiative sheet is under ${MIN_FONT_PX}px`, SHEET));

        // 5. the sheet's loading frame: the initiative dropped from the detail cache, with its re-read held
        const oref = `effort:${ctx.flat}`;
        await holdRpc(h, "EffortGetCommand");
        await lookEval(h, `
            const { effortDetailAtom } = await mod("app/view/jarvis/effortstore.ts");
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const cache = new Map(globalStore.get(effortDetailAtom));
            window.__uiDriftEffort = cache.get(${JSON.stringify(oref)});
            cache.delete(${JSON.stringify(oref)});
            globalStore.set(effortDetailAtom, cache);
        `);
        const loading = await lookPlaceholders(h, SHEET);
        await h.shot(lookShot("brief-initiatives-polish-loading"));
        await lookEval(h, `
            const { effortDetailAtom } = await mod("app/view/jarvis/effortstore.ts");
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const cache = new Map(globalStore.get(effortDetailAtom));
            if (window.__uiDriftEffort != null) cache.set(${JSON.stringify(oref)}, window.__uiDriftEffort);
            delete window.__uiDriftEffort;
            globalStore.set(effortDetailAtom, cache);
        `);
        await releaseRpc(h, "EffortGetCommand");
        steps.push({
            ...placeholderStep("5. while the initiative loads, its sheet holds three 40px blocks", loading, { height: 40, radius: "10px" }),
            ok: loading.length === 3 && loading.every((_, i) => placeholderStep("", loading, { height: 40, radius: "10px" }, i).ok),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await h
            .ev(`document.querySelector('[data-jarvis-brief-sheet] button[aria-label="Close detail sheet"]')?.click()`)
            .catch(() => {});
        await h
            .ev(
                `[...(document.querySelector('[data-jarvis-chunk-sidebar]')?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === 'Close')?.click()`
            )
            .catch(() => {});
        for (const effortoid of ctx.oids ?? []) {
            await h.rpc("effortdelete", { effortoid }).catch(() => {});
        }
        await h.goto("cockpit");
    },
};

// --- brief-peeks-polish: the record peek and the graph peek on the brief scale ----------------------
// docs/superpowers/specs/2026-09-29-brief-peeks-polish-design.md. A record whose objective is over 400 characters:
// its peek titles by the first sentence and clamps the rest; the graph peek focused on it prints the objective
// neither in its header nor on the canvas, and keeps Open record on screen. A profile with no such record gets one
// from a deferred run (run creation captures a dossier from the goal); the dossier stays in the vault afterwards,
// as run-sheet-polish's does, since no RPC deletes one.
const PEEKS_LONG = 400;
const PEEKS_GOAL =
    "verify brief-peeks-polish: do nothing, make no file changes, stop immediately. " +
    "This goal is long on purpose, so the record it captures has an objective the peek must clamp. ".repeat(6);
const PEEKS_RECORD = `document.querySelector('[data-jarvis-brief-band="peek"]')`;
const PEEKS_GRAPH = `document.querySelector('[data-jarvis-graph-peek]')`;
const PEEKS_OPEN = `[...(${PEEKS_GRAPH}?.querySelectorAll('button') ?? [])].find((b) => /^open record$/i.test((b.innerText || '').trim()))`;

export const briefPeeksPolish = {
    name: "brief-peeks-polish",
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        const long = (d) => (d.objective ?? "").trim().length > PEEKS_LONG;
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            let found = ((await h.rpc("listtaskdossiers", null))?.dossiers ?? []).find(long);
            if (found == null) {
                ctx.cwd = mkdtempSync(join(tmpdir(), "verify-brief-peeks-polish-"));
                const wslist = await h.rpc("workspacelist", null);
                const ch = await h.rpc("createchannel", { name: "verify-brief-peeks-polish", projectpath: ctx.cwd });
                ctx.channelId = ch.oid;
                const created = await h.rpc("createrun", {
                    channelid: ctx.channelId,
                    workspaceid: wslist[0].workspacedata.oid,
                    goal: PEEKS_GOAL,
                    runtime: "claude",
                    mode: "orchestrator",
                    deferstart: true,
                });
                ctx.runId = created.run.id;
                found = ((await h.rpc("listtaskdossiers", null))?.dossiers ?? []).find(
                    (d) => (d.objective ?? "").trim() === PEEKS_GOAL.trim()
                );
            }
            if (found == null) throw new Error("no record has an objective over 400 characters, and seeding made none");
            ctx.recordId = found.id;
            ctx.objective = found.objective.trim();
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. a record with an objective over 400 characters", false, ctx.arrangeError);
            return steps;
        }
        // narrow columns defeat by-name clicks, and verify.mjs clears any earlier override
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.goto("jarvis");
        await h.ev(PEEKS_ESC);
        await polishNap(400);

        const opened = await h.ev(`(async () => {
            for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            if (typeof window.__openAddress !== "function") return "no __openAddress hook";
            await window.__openAddress(${JSON.stringify(`task:${ctx.recordId}`)});
            return "ok";
        })()`);
        const shown = await polishWaitFor(h, `!!${PEEKS_RECORD}?.querySelector('[data-jarvis-peek-body]')`, 6000);
        rec("1. the record peek opens on the long record, with a body", opened === "ok" && shown, `opened=${opened} record=${ctx.recordId}`);
        if (!shown) return steps;
        await h.shot("cdp-shots/brief-peeks-polish-1-record.png");

        const text = (sel) => `(${PEEKS_RECORD}?.querySelector('${sel}')?.innerText ?? '').replace(/\\s+/g, ' ').trim()`;
        const split = await h.ev(`({ title: ${text("[data-jarvis-peek-title]")}, body: ${text("[data-jarvis-peek-body]")} })`);
        rec(
            "2. the peek's title is not its body",
            split.title !== "" && split.title !== split.body,
            JSON.stringify({ title: split.title.slice(0, 80), body: split.body.slice(0, 80) })
        );
        const clamped = await h.ev(polishSweep(PEEKS_RECORD));
        rec("3. nothing in the record peek is under 10.5px", sweptOk(clamped), JSON.stringify(clamped));

        const toggled = await h.ev(`(() => {
            const b = ${PEEKS_RECORD}?.querySelector('[data-jarvis-peek-body-toggle]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await polishNap(300);
        const expanded = await h.ev(polishSweep(PEEKS_RECORD));
        rec(
            "4. the long objective has a show-full link, and nothing is under 10.5px with it open",
            toggled === true && sweptOk(expanded),
            JSON.stringify({ toggled, expanded })
        );

        await h.ev(`${PEEKS_RECORD}?.querySelector('[data-jarvis-peek-open-graph]')?.click()`);
        const focused = await polishWaitFor(h, `!!${PEEKS_OPEN}`, 8000);
        const panel = focused
            ? ""
            : await h.ev(`(${PEEKS_GRAPH}?.innerText ?? 'no graph peek').replace(/\\s+/g, ' ').slice(0, 160)`);
        rec("5. the map button opens the graph peek with the record selected", focused, panel);
        if (!focused) return steps;
        await polishNap(800);
        await h.shot("cdp-shots/brief-peeks-polish-2-graph.png");

        // the canvas element holds no text node, so the sweep passes over it
        const graphSweep = await h.ev(polishSweep(PEEKS_GRAPH));
        rec("6. nothing in the graph peek is under 10.5px", sweptOk(graphSweep), JSON.stringify(graphSweep));

        const probe = JSON.stringify(ctx.objective.replace(/\s+/g, " ").slice(0, 40));
        const graph = await h.ev(`(() => {
            const root = ${PEEKS_GRAPH};
            const flat = (el) => (el?.innerText ?? '').replace(/\\s+/g, ' ');
            const pane = root.querySelector('[data-jarvis-graph-canvas]');
            const r = ${PEEKS_OPEN}.getBoundingClientRect();
            return {
                header: flat(root.firstElementChild).includes(${probe}),
                pane: pane != null,
                card: flat(pane).includes(${probe}),
                openInView: r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight,
            };
        })()`);
        rec("7. the graph header prints no objective", graph.header === false, JSON.stringify(graph));
        rec("8. the side panel's Open record button is inside the viewport", graph.openInView === true, JSON.stringify(graph));
        rec("9. the canvas draws no selection card", graph.pane === true && graph.card === false, JSON.stringify(graph));
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await polishNap(300);
        await h.ev(PEEKS_ESC).catch(() => {});
        // cwd is made first, so a seed that threw before createrun returned still has its channel and dir removed
        if (ctx.cwd != null) await teardownFixtureRun(h, ctx, "brief-peeks-polish");
    },
};
