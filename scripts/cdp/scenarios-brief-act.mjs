// Brief act scenarios: acting on the brief and its inline initiative tracker.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    MIN_FONT_PX,
    MODELS_VIEWPORT,
    arrangeFixtureRun,
    failRpc,
    floorStep,
    holdRpc,
    lookEval,
    paintEval,
    releaseRpc,
    skipStep,
    teardownFixtureRun,
} from "./scenarios-shared.mjs";

// --- jarvis-motion: the structural facts the motion pass rests on -------------------------------
// The animations themselves are not assertable here — a tween is a sequence of transient computed
// styles, and reading one mid-flight is a race rather than a check. What IS assertable is the
// structure each moment depends on, which is also the half a later refactor can quietly break with
// nothing failing: the detail sheet's surface scoping, the freshness mark's presence and its cap, and
// the updates drawer's split between the element whose height animates and the inner scroller.
// --- the Brief's inline initiative tracker ------------------------------------------------------
// An initiative expands IN PLACE instead of opening the detail sheet, and its chunks join the Brief's
// own j/k list so one cursor walks rows and chunks alike. The chunk rows need the effort DETAIL, which
// the briefing fixture does not carry (it seeds summaries only) — so the plan-dependent steps SKIP when
// the dev store has no real initiative with chunks, rather than failing on an empty dev database.
// steps 11-12 read a live initiative of four chunks, one done and one skipped: its facts line counts three
const TRACKER_SKIPPED = "verify brief-inline-tracker skipped chunk";
const TRACKER_FOOTER = ["Rename", "Details", "Activity", "Pause", "Archive", "Delete"];

export const briefInlineTracker = {
    name: "brief-inline-tracker",
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        try {
            ctx.effortoid = (
                await h.rpc("effortcreate", {
                    title: TRACKER_SKIPPED,
                    chunks: [{ label: "sk-done" }, { label: "sk-skipped" }, { label: "sk-next" }, { label: "sk-last" }],
                })
            ).effortoid;
            await h.rpc("effortmutate", {
                effortoid: ctx.effortoid,
                author: "you",
                ops: [
                    { op: "setChunkStatus", chunk: "sk-done", status: "done" },
                    { op: "setChunkStatus", chunk: "sk-skipped", status: "skipped" },
                ],
            });
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        await h.goto("jarvis");
        await h.ev(`document.querySelector('[data-briefing-fixture="normal"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 900))");

        // 1. an initiative row no longer opens the modal sheet
        const row = `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')][0]`;
        const before = await h.ev(`(() => ({
            rows: document.querySelectorAll('[data-jarvis-brief-row="initiative"]').length,
            expanded: !!document.querySelector('[data-jarvis-initiative-detail]'),
        }))()`);
        await h.ev(`${row}?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 700))");
        const after = await h.ev(`(() => ({
            detail: !!document.querySelector('[data-jarvis-initiative-detail]'),
            sheet: !!document.querySelector('[data-jarvis-brief-sheet-face]'),
            aria: document.querySelector('[data-jarvis-brief-row="initiative"]')?.getAttribute('aria-expanded') ?? null,
        }))()`);
        steps.push({
            step: "1. clicking an initiative expands it in place and opens no sheet",
            ok: before.rows > 0 && after.detail === true && after.sheet === false && after.aria === "true",
            detail: JSON.stringify({ before, after }),
        });
        await h.shot("cdp-shots/brief-inline-tracker-expanded.png");
        const expandedFloor = await floorStep(
            h,
            `1b. no visible text in the expanded initiative is under ${MIN_FONT_PX}px`,
            `document.querySelector('[data-jarvis-initiative-detail]')`
        );
        let menuShadow = null;

        // 2. only the stage holding the next chunk starts open
        const stages = await h.ev(`[...document.querySelectorAll('[data-jarvis-tracker-stage]')].map((b) => b.getAttribute('aria-expanded'))`);
        const chunks = await h.ev(`[...document.querySelectorAll('[data-jarvis-tracker-chunk]')].length`);
        const hasPlan = Array.isArray(stages) && stages.length > 0;
        steps.push(
            hasPlan
                ? {
                      step: "2. exactly one stage starts expanded, and it is the only one contributing chunk rows",
                      ok: stages.filter((a) => a === "true").length === 1 && chunks > 0,
                      detail: JSON.stringify({ stages, chunks }),
                  }
                : skipStep(
                      "2. exactly one stage starts expanded, and it is the only one contributing chunk rows",
                      "no initiative with chunks in this dev store - the fixture seeds summaries only"
                  )
        );

        // 3. a chunk row takes the Brief's cursor and opens its Chunk sidebar
        let sidebar = { panel: false, cursorOnChunk: false };
        if (hasPlan && chunks > 0) {
            await h.ev(`[...document.querySelectorAll('[data-jarvis-tracker-chunk]')][0]?.click()`);
            await h.ev("new Promise((r) => setTimeout(r, 500))");
            sidebar = await h.ev(`(() => ({
                panel: !!document.querySelector('[data-jarvis-chunk-sidebar]'),
                cursorOnChunk: !!document.querySelector('[data-jarvis-tracker-chunk][aria-pressed="true"]'),
            }))()`);
        }
        steps.push(
            hasPlan && chunks > 0
                ? {
                      step: "3. selecting a chunk opens the Chunk sidebar and marks that row selected",
                      ok: sidebar.panel === true && sidebar.cursorOnChunk === true,
                      detail: JSON.stringify(sidebar),
                  }
                : skipStep(
                      "3. selecting a chunk opens the Chunk sidebar and marks that row selected",
                      "no chunk rows to select - seed an initiative carrying a plan"
                  )
        );
        await h.shot("cdp-shots/brief-inline-tracker-notes.png");

        // 4. Escape backs out one rung at a time and never leaves the surface while a note is open
        let esc = { afterFirst: null, surface: null };
        if (hasPlan && chunks > 0) {
            // real key events, not synthetic DOM ones: the binding registry listens on the window
            for (const type of ["keyDown", "keyUp"]) {
                await h.cdp("Input.dispatchKeyEvent", {
                    type,
                    key: "Escape",
                    code: "Escape",
                    windowsVirtualKeyCode: 27,
                });
            }
            await h.ev("new Promise((r) => setTimeout(r, 400))");
            esc = await h.ev(`(() => ({
                afterFirst: !!document.querySelector('[data-jarvis-chunk-sidebar]'),
                surface: !!document.querySelector('[data-jarvis-region="brief"]'),
            }))()`);
        }
        steps.push(
            hasPlan && chunks > 0
                ? {
                      step: "4. Escape closes the sidebar and stays on the Brief",
                      ok: esc.afterFirst === false && esc.surface === true,
                      detail: JSON.stringify(esc),
                  }
                : skipStep(
                      "4. Escape closes the sidebar and stays on the Brief",
                      "sidebar never opened - step 3 had no chunk row to select"
                  )
        );

        // 5-8. the editing layer. Every step asserts and none commits a write: the delete is taken back
        // with Undo inside its window, so no RPC is ever sent against the dev store.
        if (hasPlan && chunks > 0) {
            // 5. the status pill opens a menu with the six statuses
            await h.ev(`document.querySelector('[data-jarvis-chunk-status]')?.click()`);
            await h.ev("new Promise((r) => setTimeout(r, 200))");
            // each item leads with a glyph span, so read the label span rather than the whole button
            const menu = await h.ev(`(() => {
                const m = document.querySelector('[data-jarvis-tracker-menu]');
                return m ? [...m.querySelectorAll('button')].map((b) => b.querySelector('.flex-1')?.textContent.trim() ?? "") : null;
            })()`);
            await h.shot("cdp-shots/brief-inline-tracker-menu.png");
            menuShadow = await paintEval(h, `return shadowVs(document.querySelector("[data-jarvis-tracker-menu]"), "shadow-popover-md");`);
            // real keys again: the menu's Escape rung is a window-capture binding, and it must close the
            // menu without also backing out of the surface
            for (const type of ["keyDown", "keyUp"]) {
                await h.cdp("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
            }
            await h.ev("new Promise((r) => setTimeout(r, 300))");
            const afterEsc = await h.ev(`(() => ({
                menu: !!document.querySelector('[data-jarvis-tracker-menu]'),
                brief: !!document.querySelector('[data-jarvis-region="brief"]'),
                chunks: document.querySelectorAll('[data-jarvis-tracker-chunk]').length,
            }))()`);
            const six = ["pending", "active", "blocked", "deferred", "skipped", "done"];
            steps.push({
                step: "5. the status pill opens a menu listing all six statuses, and Escape closes only the menu",
                ok:
                    Array.isArray(menu) &&
                    six.every((s) => menu.includes(s)) &&
                    afterEsc.menu === false &&
                    afterEsc.brief === true &&
                    afterEsc.chunks === chunks,
                detail: JSON.stringify({ menu, afterEsc }),
            });

            // 6. double-click renames in place, and Escape leaves the label untouched
            await h.ev(`document.querySelector('[data-jarvis-tracker-chunk]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await h.ev("new Promise((r) => setTimeout(r, 200))");
            const renaming = await h.ev(`!!document.querySelector('[data-jarvis-rename-input]')`);
            steps.push({ step: "6. double-clicking a chunk opens its rename input", ok: renaming === true, detail: String(renaming) });
            await h.ev(`document.querySelector('[data-jarvis-rename-input]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
            await h.ev("new Promise((r) => setTimeout(r, 150))");

            // 7. delete hides the row at once, and Undo brings it back without a write
            const label = await h.ev(`document.querySelectorAll('[data-jarvis-tracker-chunk]').length > 1 ? document.querySelector('[data-jarvis-tracker-chunk]').getAttribute('data-jarvis-tracker-chunk') : null`);
            if (label != null) {
                const sel = `document.querySelector('[data-jarvis-tracker-chunk="' + CSS.escape(${JSON.stringify(label)}) + '"]')`;
                await h.ev(`document.querySelector('[data-jarvis-chunk-status]')?.click()`);
                await h.ev("new Promise((r) => setTimeout(r, 200))");
                await h.ev(`[...document.querySelectorAll('[data-jarvis-tracker-menu] button')].find((b) => b.textContent.trim() === 'Delete chunk')?.click()`);
                await h.ev("new Promise((r) => setTimeout(r, 200))");
                const gone = await h.ev(`!${sel} && !!document.querySelector('[data-jarvis-toast-undo]')`);
                await h.ev(`document.querySelector('[data-jarvis-toast-undo]')?.click()`);
                await h.ev("new Promise((r) => setTimeout(r, 300))");
                const back = await h.ev(`!!${sel}`);
                steps.push({
                    step: "7. delete hides the chunk behind an Undo toast, and Undo restores it",
                    ok: gone === true && back === true,
                    detail: JSON.stringify({ label, gone, back }),
                });
            } else {
                steps.push(skipStep("7. delete hides the chunk behind an Undo toast, and Undo restores it", "the plan has one chunk"));
            }

            // 8. the footer's delete asks first
            await h.ev(`document.querySelector('[data-jarvis-initiative-action="delete"]')?.click()`);
            await h.ev("new Promise((r) => setTimeout(r, 200))");
            const confirm = await h.ev(`document.querySelector('[data-jarvis-delete-confirm]')?.textContent ?? null`);
            steps.push({
                step: "8. deleting an initiative asks for confirmation first",
                ok: typeof confirm === "string" && confirm.includes("Delete this initiative"),
                detail: String(confirm),
            });
            await h.shot("cdp-shots/brief-inline-tracker-confirm.png");
            await h.ev(`[...document.querySelectorAll('[data-jarvis-delete-confirm] button')].find((b) => b.textContent.trim() === 'Cancel')?.click()`);
            await h.ev("new Promise((r) => setTimeout(r, 150))");
        } else {
            steps.push(skipStep("5-8. the editing layer: status menu, rename, delete + undo, delete confirm", "no initiative with chunks in this dev store"));
        }

        // 9. collapsing removes the chunk rows again, so a stale cursor cannot survive on one
        await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')][0]?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const collapsed = await h.ev(`(() => ({
            detail: !!document.querySelector('[data-jarvis-initiative-detail]'),
            chunks: document.querySelectorAll('[data-jarvis-tracker-chunk]').length,
        }))()`);
        steps.push({
            step: "9. collapsing the initiative removes its plan rows",
            ok: collapsed.detail === false && collapsed.chunks === 0,
            detail: JSON.stringify(collapsed),
        });
        steps.push(expandedFloor);
        const menuStep = "10. the open tracker menu casts shadow-popover-md over no raw overlay";
        steps.push(
            menuShadow != null
                ? { step: menuStep, ok: menuShadow.ok === true, detail: JSON.stringify(menuShadow) }
                : skipStep(menuStep, "no initiative with chunks in this dev store - ui-drift renders the menu through the module")
        );

        // 11 + 12: the 11-05 Brief live pass, on the arranged initiative in live data at 1600x950. The filter finds
        // it past the Initiatives window, which leads with whatever blocked initiatives the store holds.
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await actFixture(h, null);
        await actFilter(h, TRACKER_SKIPPED);
        const f10 = await lookEval(h, `
            const row = () => ${actInitRow(TRACKER_SKIPPED)};
            const found = await until(() => row() != null, 25000);
            if (row() != null && row().getAttribute("aria-expanded") !== "true") row().click();
            const detail = () => document.querySelector('[data-jarvis-initiative-detail]');
            const facts = () => [...(detail()?.querySelectorAll("span") ?? [])].map(flat).find((t) => /^\\d+ chunks? · \\d+ done/.test(t)) ?? null;
            await until(() => facts() != null, 10000);
            return {
                found,
                facts: facts(),
                progress: [...(row()?.querySelectorAll("span") ?? [])].map(flat).find((t) => /^\\d+\\/\\d+$/.test(t)) ?? null,
            };
        `);
        await h.shot("cdp-shots/brief-inline-tracker-11-skipped.png");
        const counted = /^(\d+) chunks? · (\d+) done · 1 skipped, not counted$/.exec(f10.facts ?? "");
        const total = /^\d+\/(\d+)$/.exec(f10.progress ?? "")?.[1] ?? null;
        steps.push({
            step: "11. F10: at 1600x950 an initiative with a skipped chunk reads <n> chunks · <d> done · 1 skipped, not counted, its <n> the row's progress total",
            ok: ctx.arrangeError == null && counted != null && counted[1] === total && counted[1] === "3" && counted[2] === "1",
            detail: ctx.arrangeError ?? JSON.stringify(f10),
        });

        const f15 = await lookEval(h, `
            const detail = document.querySelector('[data-jarvis-initiative-detail]');
            const labels = [...(detail?.querySelectorAll('[data-jarvis-initiative-action]') ?? [])].map(flat);
            detail?.querySelector('[data-jarvis-initiative-action="delete"]')?.click();
            const confirm = () => document.querySelector('[data-jarvis-delete-confirm]');
            await until(() => confirm() != null, 3000);
            const confirmLabels = [...(confirm()?.querySelectorAll("button") ?? [])].map(flat);
            [...(confirm()?.querySelectorAll("button") ?? [])].find((b) => flat(b) === "Cancel")?.click();
            const closed = await until(() => confirm() == null, 3000);
            return { labels, confirmLabels, closed };
        `);
        await actFilter(h, "");
        steps.push({
            step: "12. F15: at 1600x950 every tracker footer action and the delete confirm's buttons start with a capital",
            ok:
                TRACKER_FOOTER.every((l) => f15.labels.includes(l)) &&
                [...f15.labels, ...f15.confirmLabels].every((l) => /^[A-Z]/.test(l)) &&
                JSON.stringify(f15.confirmLabels) === JSON.stringify(["Cancel", "Delete"]) &&
                f15.closed === true,
            detail: JSON.stringify(f15),
        });

        return steps;
    },
    async teardown(h, ctx) {
        await actFilter(h, "").catch(() => {});
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        if (ctx?.effortoid) {
            await h.rpc("effortdelete", { effortoid: ctx.effortoid }).catch((e) => {
                console.error(`brief-inline-tracker teardown: delete the initiative failed: ${e?.message ?? e}`);
            });
        }
    },
};

// --- brief-act: the Brief helps you act on what it shows ------------------------------------------------
// The 11-04 review's ten findings, one step each. A real initiative with two blocked chunks drives what writes:
// its waiting rows (needs, newer note, Unblock / Done with undo), the open that lands on the chunk, and Move to
// project. The "act" briefing fixture drives what only reads: ages and order, the filter past every fold, the
// quiet count, Behind you's grouping, Shipped's second line, the pet's room and the stale blocked runs.
const ACT_EFFORT = "verify brief-act blockers";
const ACT_PROJECT = "verify-brief-act";
// steps 28-34 make these two besides: a staged plan whose Beta stage starts folded (all done), and an archived one
const ACT_STAGED = "verify brief-act stages";
const ACT_ARCHIVED = "verify brief-act archived";
const actInitRow = (title) =>
    `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => (r.innerText || "").includes(${JSON.stringify(title)}))`;
const ACT_OPEN_INIT = `document.querySelector('[data-jarvis-brief-row="initiative"][aria-expanded="true"]')`;
// opens an initiative row's context menu and clicks one of its top-level items
async function actMenuClick(h, title, label) {
    return lookEval(h, `
        const row = ${actInitRow(title)};
        if (row == null) return { row: false, clicked: false };
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 40, clientY: r.top + 10 }));
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { contextMenuAtom, closeContextMenu } = await mod("app/store/contextmenu.ts");
        await until(() => globalStore.get(contextMenuAtom) != null, 3000);
        const item = globalStore.get(contextMenuAtom)?.items.find((i) => i.label === ${JSON.stringify(label)});
        item?.click?.();
        closeContextMenu();
        return { row: true, clicked: item != null };
    `);
}
// drops an initiative's plan from the detail cache, so the next open reads it again
const actUncache = (h, oref) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { effortDetailAtom } = await mod("app/view/jarvis/effortstore.ts");
        const cache = new Map(globalStore.get(effortDetailAtom));
        cache.delete(${JSON.stringify(oref)});
        globalStore.set(effortDetailAtom, cache);
    `);
const actClearToast = (h) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        globalStore.set((await mod("app/view/jarvis/briefundo.ts")).briefToastAtom, null);
    `);
const actQueueRow = (label) =>
    `[...document.querySelectorAll('[data-jarvis-brief-row="queue"]')].find((r) => (r.innerText || "").includes(${JSON.stringify(label)}))`;
const actText = (el) => `((${el})?.innerText || "").replace(/\\s+/g, " ").trim()`;

// lookEval prelude for steps 21-27: the store, the Brief's list-nav controller and the review fixture's roster. The
// roster is read at render, so swapping it and writing any atom the Brief reads re-renders on the same snapshot.
const ACT_BRIEF_LIB = `
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const { listNavAtom } = await mod("app/store/keybindings/listnav.ts");
    const { settledChunksAtom } = await mod("app/view/jarvis/briefundo.ts");
    const fx = (await mod("app/view/jarvis/briefingfixtures.ts")).BRIEFING_FIXTURES.review;
    const setAgents = async (agents) => {
        fx.agents = agents;
        globalStore.set(settledChunksAtom, new Map(globalStore.get(settledChunksAtom)));
        await nap(60);
    };
    const scroll = document.querySelector('[data-jarvis-brief-scroll]');
    const cursorRow = () => document.querySelector('[data-jarvis-brief-cursor="true"]');
`;

async function actFixture(h, name) {
    await lookEval(h, `
        const { briefingFixtureAtom } = await mod("app/view/jarvis/briefingstore.ts");
        (await mod("app/store/jotaiStore.ts")).globalStore.set(briefingFixtureAtom, ${JSON.stringify(name)});
    `);
    await h.ev("new Promise((r) => setTimeout(r, 700))");
}

// the review fixture's direct-agent ask (briefingfixtures.ts REVIEW_AGENT_ASK_TEXT)
const REVIEW_AGENT_ASK = "Can I rename the tenant table?";

// steps 41-45. The act fixture's shipped run: a goal past a tooltip's length, a report whose H1 is "Run report:
// Portfolio hero" (briefingfixtures.ts r-act-shipped).
const ACT_SHIPPED_TITLE = "Portfolio hero";
// a real run's goal, so CreateRun captures a record with it as the objective: a path full of dots and a ";"
// mid-sentence, the shape the old headline cut at the ";"
const ACT_RECORD_HEAD =
    "Verify record titles: fix the findings in C:/dev/review/report.md (gitignored, read it by that path; its shots sit beside it) and nothing else.";
const ACT_RECORD_GOAL = `${ACT_RECORD_HEAD} Then stop before landing anything.`;
const ACT_RECORD_H1 = "Record titles read whole";
// an initiative whose notes are the creation marker and one written note, with a blocked chunk so it waits
const ACT_PEEK_EFFORT = "verify brief-act peek objective";
const ACT_PEEK_CHUNK = "pk-wait";
const ACT_PEEK_NOTE = "Ship the record titles fix";
const ACT_RESUME_SUMMARY = "Picked up the record titles: Shipped rows now read their report's heading.";

// steps 35, 36 and 37-38 set the registry, the dev roster and the review queue page-side; these put them back, and
// are no-ops after
const actRestoreConfig = (h) =>
    lookEval(h, `
        if (window.__briefActCfg === undefined) return;
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { atoms } = await mod("app/store/global-atoms.ts");
        globalStore.set(atoms.fullConfigAtom, window.__briefActCfg);
        delete window.__briefActCfg;
    `);
const actRestoreRoster = (h) =>
    lookEval(h, `
        if (!("__briefActRoster" in window)) return;
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        globalStore.set((await mod("app/view/agents/devmock.ts")).devMockAgentsAtom, window.__briefActRoster);
        delete window.__briefActRoster;
    `);
const actRestoreAttention = (h) =>
    lookEval(h, `${ACT_BRIEF_LIB}
        if (window.__briefActAttention === undefined) return;
        fx.attention = window.__briefActAttention;
        delete window.__briefActAttention;
        await setAgents(fx.agents);
    `);

async function actFilter(h, q) {
    await h.ev(`(() => {
        const i = document.querySelector('[data-jarvis-brief-filter]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(q)});
        i.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await h.ev("new Promise((r) => setTimeout(r, 500))");
}

async function actChunk(h, effortoid, label) {
    const { effort } = (await h.rpc("effortget", { effortoid })) ?? {};
    return effort?.chunks?.find((c) => c.label === label) ?? null;
}

async function actWaitChunk(h, effortoid, label, status) {
    for (let i = 0; i < 40; i++) {
        const c = await actChunk(h, effortoid, label);
        if (c?.status === status) return c;
        await new Promise((r) => setTimeout(r, 250));
    }
    return actChunk(h, effortoid, label);
}

export const briefAct = {
    name: "brief-act",
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        try {
            ctx.effortoid = (
                await h.rpc("effortcreate", {
                    title: ACT_EFFORT,
                    project: ACT_PROJECT,
                    chunks: [{ label: "act-soak" }, { label: "act-label" }, { label: "act-settle" }],
                })
            ).effortoid;
            await h.rpc("effortmutate", {
                effortoid: ctx.effortoid,
                author: "you",
                ops: [
                    { op: "setChunkStatus", chunk: "act-soak", status: "blocked", note: "needs: a clean DEV soak" },
                    { op: "appendNote", chunk: "act-soak", note: "the empty-buffer blocker is gone on DEV" },
                    { op: "setChunkStatus", chunk: "act-label", status: "blocked", note: "needs: the G4 label" },
                    // F14's own (step 19): step 3 spends the other two
                    { op: "setChunkStatus", chunk: "act-settle", status: "blocked", note: "needs: a settle check" },
                ],
            });
            // a real run: its channel hosts the run sheet of step 24, and step 27 stops it
            ctx.cwd = mkdtempSync(join(tmpdir(), "verify-brief-act-"));
            await arrangeFixtureRun(h, ctx, "brief-act", "brief-act lead");
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.goto("jarvis");
        await actFixture(h, null);
        await actFilter(h, "");
        // a fresh store's first briefing load runs past one CDP evaluate's 30s, so it is waited out here
        for (let i = 0; i < 180 && (await h.ev(`document.querySelector('[data-jarvis-brief-state="loading"]') != null`)); i++) {
            await new Promise((r) => setTimeout(r, 1000));
        }

        // 1. live: the blocked chunk's row says what it needs and shows the note written after the block
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click()`);
        const live = await lookEval(h, `
            await until(() => ${actQueueRow("act-soak")} != null && ${actQueueRow("act-label")} != null, 30000);
            const row = ${actQueueRow("act-soak")};
            return {
                text: ${actText(actQueueRow("act-soak"))},
                latest: (row?.querySelector('[data-jarvis-queue-latest]')?.innerText || "").trim(),
                acts: [...(row?.querySelectorAll('[data-jarvis-queue-act]') ?? [])].map((b) => b.innerText.trim()),
                summary: ${actText(`document.querySelector('[data-jarvis-brief-attention-summary]')`)},
            };
        `);
        steps.push({
            step: "1. a blocked chunk's waiting row shows what it needs, its newer note, and Unblock / Done",
            ok:
                ctx.arrangeError == null &&
                live.text.includes("needs: a clean DEV soak") &&
                /the empty-buffer blocker is gone on DEV/.test(live.latest) &&
                JSON.stringify(live.acts) === JSON.stringify(["Unblock", "Done"]),
            detail: ctx.arrangeError ?? JSON.stringify(live),
        });
        await h.shot("cdp-shots/brief-act-waiting-live.png");

        // 2. opening the row lands on the chunk in its initiative's plan, notes open, no sheet
        await h.ev(`(${actQueueRow("act-label")})?.click()`);
        const landed = await lookEval(h, `
            await until(() => document.querySelector('[data-jarvis-chunk-sidebar]') != null, 6000);
            const side = document.querySelector('[data-jarvis-chunk-sidebar]');
            const chunk = document.querySelector('[data-jarvis-tracker-chunk="act-label"]');
            return {
                sidebar: (side?.innerText || "").includes("act-label"),
                reason: (side?.innerText || "").includes("needs: the G4 label"),
                pressed: chunk?.getAttribute("aria-pressed") ?? null,
                sheet: !!document.querySelector('[data-jarvis-brief-sheet]'),
            };
        `);
        steps.push({
            step: "2. opening a blocked chunk's row lands on that chunk with its notes, not the initiative's top",
            ok: landed.sidebar && landed.reason && landed.pressed === "true" && landed.sheet === false,
            detail: JSON.stringify(landed),
        });
        await h.shot("cdp-shots/brief-act-landed.png");
        await h.ev(`document.querySelector('[data-jarvis-brief-row="initiative"][aria-expanded="true"]')?.click()`);

        // 3. Unblock writes pending, its undo blocks it again with what it needs; Done finishes the other
        await h.ev(`(${actQueueRow("act-soak")})?.querySelector('[data-jarvis-queue-act="unblock-chunk"]')?.click()`);
        const unblocked = await actWaitChunk(h, ctx.effortoid, "act-soak", "pending");
        const toast = await h.ev(`(document.querySelector('[data-jarvis-brief-toast]')?.innerText || "").trim()`);
        await h.ev(`document.querySelector('[data-jarvis-toast-undo]')?.click()`);
        const reblocked = await actWaitChunk(h, ctx.effortoid, "act-soak", "blocked");
        await lookEval(h, `await until(() => ${actQueueRow("act-label")}?.querySelector('[data-jarvis-queue-act="done-chunk"]') != null, 15000);`);
        await h.ev(`(${actQueueRow("act-label")})?.querySelector('[data-jarvis-queue-act="done-chunk"]')?.click()`);
        const done = await actWaitChunk(h, ctx.effortoid, "act-label", "done");
        const newest = (c) => [...(c?.notes ?? [])].sort((a, b) => b.ts - a.ts)[0]?.text ?? "";
        steps.push({
            step: "3. Unblock and Done act from the row, and Unblock's undo blocks it again with its needs",
            ok:
                unblocked?.status === "pending" &&
                /Unblocked · act-soak/.test(toast) &&
                reblocked?.status === "blocked" &&
                newest(reblocked) === "marked blocked · needs: a clean DEV soak" &&
                done?.status === "done",
            detail: JSON.stringify({ unblocked: unblocked?.status, toast, reblocked: reblocked?.status, note: newest(reblocked), done: done?.status }),
        });

        // 4. Move to project from the initiative row's menu
        const menu = await lookEval(h, `
            await until(() => [...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].some((r) => (r.innerText || "").includes(${JSON.stringify(ACT_EFFORT)})), 15000);
            const row = [...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => (r.innerText || "").includes(${JSON.stringify(ACT_EFFORT)}));
            const r = row.getBoundingClientRect();
            row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 40, clientY: r.top + 10 }));
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { contextMenuAtom } = await mod("app/store/contextmenu.ts");
            await until(() => globalStore.get(contextMenuAtom) != null, 3000);
            const move = globalStore.get(contextMenuAtom)?.items.find((i) => i.label === "Move to project");
            const sub = (move?.submenu ?? []).map((i) => [i.label ?? i.type, i.checked ?? null]);
            const at = [...document.querySelectorAll("span.whitespace-nowrap")].find((s) => s.textContent === "Move to project")?.parentElement?.getBoundingClientRect();
            return { sub, at: at ? { x: Math.round(at.left + 40), y: Math.round(at.top + at.height / 2) } : null };
        `);
        if (menu.at) {
            await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: menu.at.x, y: menu.at.y });
            await h.ev("new Promise((r) => setTimeout(r, 500))");
        }
        await h.shot("cdp-shots/brief-act-move-menu.png");
        await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { contextMenuAtom, closeContextMenu } = await mod("app/store/contextmenu.ts");
            globalStore.get(contextMenuAtom)?.items.find((i) => i.label === "Move to project")?.submenu?.find((i) => i.label === "No project")?.click();
            closeContextMenu();
        `);
        let moved = null;
        for (let i = 0; i < 40 && moved !== ""; i++) {
            // an empty project is omitted on the wire
            const got = ((await h.rpc("effortget", { effortoid: ctx.effortoid })) ?? {}).effort;
            moved = got != null ? (got.project ?? "") : null;
            if (moved !== "") await new Promise((r) => setTimeout(r, 250));
        }
        steps.push({
            step: "4. an initiative's menu moves it to another project (here: to no project)",
            ok: menu.sub.some(([l, c]) => l === ACT_PROJECT && c === true) && menu.sub.some(([l]) => l === "No project") && moved === "",
            detail: JSON.stringify({ sub: menu.sub, moved }),
        });

        // the rest reads the act fixture
        await actFixture(h, "act");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const queue = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-jarvis-brief-row="queue"]')];
            return {
                summary: ${actText(`document.querySelector('[data-jarvis-brief-attention-summary]')?.parentElement`)},
                rows: rows.map((r) => (r.innerText || "").replace(/\\s+/g, " ").trim()),
            };
        })()`);
        const order = ["G10 validate", "S6 per-tenant", "P2 cut traffic"].map((t) => queue.rows.findIndex((r) => r.includes(t)));
        steps.push({
            step: "5. the queue counts blockers by kind and initiative, and lists them oldest first with their age",
            ok:
                /3 blocked · 2 initiatives · oldest 22d/.test(queue.summary) &&
                order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])) &&
                /22d/.test(queue.rows[order[0]] ?? "") &&
                /needs: the G4 label/.test(queue.rows[order[0]] ?? ""),
            detail: JSON.stringify({ summary: queue.summary, order, first: queue.rows[order[0]] }),
        });
        await h.shot("cdp-shots/brief-act-queue.png");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="true"]')?.click()`);

        // 6. the filter reaches rows behind Initiatives' and Behind you's folds
        await actFilter(h, "hypothesis tracker");
        const hitInit = await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].some((r) => (r.innerText || "").includes("Fold-hidden hypothesis tracker"))`);
        await actFilter(h, "dag-motion");
        const hitBehind = await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-row="delta"]')].some((r) => (r.innerText || "").includes("dag-motion easing settled"))`);
        await actFilter(h, "e2e quick run 2");
        const hitRuns = await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-region="sessions"] [data-jarvis-brief-row]')].some((r) => (r.innerText || "").includes("e2e quick run 2"))`);
        await actFilter(h, "");
        steps.push({
            step: "6. the filter finds rows behind the Initiatives, Behind you and Runs folds",
            ok: hitInit === true && hitBehind === true && hitRuns === true,
            detail: JSON.stringify({ hitInit, hitBehind, hitRuns }),
        });

        // 7. Initiatives counts the quiet ones instead of saying all moving
        const initMeta = await h.ev(`${actText(`document.querySelector('[data-jarvis-brief-region="initiatives"]')?.firstElementChild`)}`);
        steps.push({
            step: "7. the Initiatives head counts initiatives with no update in 7 days",
            ok: /2 quiet 7d\+/.test(initMeta) && !/all moving/.test(initMeta),
            detail: JSON.stringify(initMeta),
        });

        // 8 + 9. Behind you: an initiative's run folds into its digest, a goal reads as its first sentence with its
        // project, and Shipped's second line is prose with a project name, not report markdown on a cwd path
        const behind = await h.ev(`(() => {
            const rows = [...document.querySelectorAll('[data-jarvis-brief-region="behind"] [data-jarvis-brief-row]')];
            const t = (r) => (r.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                digest: t(rows.find((r) => t(r).includes("Anomaly-to-rule pipeline")) ?? {}),
                cancelled: t(rows.find((r) => t(r).includes("Clean up the cockpit")) ?? {}),
                attachedOwnRow: rows.some((r) => t(r).includes("Unblock the G10 label check")),
                shipped: t(rows.find((r) => r.dataset.jarvisBriefRow === "shipped") ?? {}),
            };
        })()`);
        steps.push({
            step: "8. Behind you folds an initiative's run into its digest and reads a goal as its first sentence",
            ok:
                /1 run/.test(behind.digest) &&
                !behind.attachedOwnRow &&
                behind.cancelled.includes("Clean up the cockpit's run list so a cancelled run reads plainly.") &&
                !behind.cancelled.includes("Read the run store first") &&
                behind.cancelled.includes("waveterm · cancelled"),
            detail: JSON.stringify(behind),
        });
        steps.push({
            step: "9. Shipped's second line is the project name and prose, no report markdown or cwd path",
            ok:
                behind.shipped.includes("portfolio-redesign · t-1: rebuilt the hero in hero.tsx") &&
                !/[#*`]|:\\/.test(behind.shipped),
            detail: JSON.stringify(behind.shipped),
        });
        await h.ev(`document.querySelector('[data-jarvis-brief-region="behind"]')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-behind.png");

        // 10. the pet: the rows end with its reach of room so the last row scrolls clear of it, and Where we
        // were closes once the rows are scrolled by hand (a wheel; a scroll alone no longer closes it, F20)
        const pet = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { petBubbleAtom } = await mod("app/view/jarvis/petstore.ts");
            const scroll = document.querySelector('[data-jarvis-brief-scroll]');
            scroll.scrollTop = scroll.scrollHeight;
            await nap(300);
            const rows = [...scroll.querySelectorAll('[data-jarvis-brief-row]')];
            const last = rows[rows.length - 1]?.getBoundingClientRect();
            const avatar = document.querySelector('[aria-label="Jarvis condition"]')?.getBoundingClientRect();
            globalStore.set(petBubbleAtom, { id: "resume:brief-act:1", at: 1, kind: "resume", text: "verify brief-act resume" });
            await nap(200);
            const shown = globalStore.get(petBubbleAtom) != null;
            scroll.scrollTop = 0;
            scroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
            await nap(200);
            return {
                pad: parseFloat(getComputedStyle(scroll).paddingBottom),
                rowsN: rows.length,
                lastBottom: last ? Math.round(last.bottom) : null,
                avatarTop: avatar ? Math.round(avatar.top) : null,
                shown,
                closed: globalStore.get(petBubbleAtom) == null,
            };
        `);
        steps.push({
            step: "10. F20: the Brief's last row scrolls clear of the pet, and Where we were closes on a wheel",
            ok:
                pet.pad >= 124 &&
                pet.lastBottom != null &&
                (pet.avatarTop == null || pet.lastBottom <= pet.avatarTop) &&
                pet.shown &&
                pet.closed,
            detail: JSON.stringify(pet),
        });

        // 11. blocked runs a month old fold as stale, so Runs' live count agrees with the header
        const runs = await h.ev(`(() => ({
            regions: [...document.querySelectorAll('[data-jarvis-brief-region]')].map((s) => s.dataset.jarvisBriefRegion),
            rows: document.querySelectorAll('[data-jarvis-brief-scroll] [data-jarvis-brief-row]').length,
            head: ${actText(`document.querySelector('[data-jarvis-brief-region="sessions"]')?.firstElementChild`)},
            stale: ${actText(`document.querySelector('[data-jarvis-brief-stale]')`)},
            fleet: ${actText(`document.querySelector('[data-jarvis-brief-band="fleet"]')`)},
        }))()`);
        steps.push({
            step: "11. week-old blocked runs fold as stale: Runs reads 0 live, as the header says nothing running",
            ok: /0 live/.test(runs.head) && /3/.test(runs.stale) && /nothing running/.test(runs.fleet),
            detail: JSON.stringify(runs),
        });
        await h.ev(`document.querySelector('[data-jarvis-brief-region="sessions"]')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-runs.png");

        // 12-18: the 11-05 code review's Waiting and Behind you findings, on the "review" fixture
        await actFixture(h, "review");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const rowActs = (label) => `[...((${actQueueRow(label)})?.querySelectorAll('[data-jarvis-queue-act]') ?? [])].map((b) => b.innerText.trim())`;
        const waiting = await h.ev(`(() => ({
            summary: ${actText(`document.querySelector('[data-jarvis-brief-attention-summary]')?.parentElement`)},
            unverified: ${actText(actQueueRow("review unverified one"))},
            held: ${actText(actQueueRow("review held land"))},
            heldActs: ${rowActs("review held land")},
            ask: ${actText(actQueueRow("Which tenant goes first?"))},
            askActs: ${rowActs("Which tenant goes first?")},
        }))()`);
        steps.push({
            step: "12. F7: an unverified run and a held land read by their own kind words, and the summary counts them",
            ok: /^unverified /.test(waiting.unverified) && /^land held /.test(waiting.held) && /2 unverified/.test(waiting.summary),
            detail: JSON.stringify({ summary: waiting.summary, unverified: waiting.unverified, held: waiting.held }),
        });
        await h.shot("cdp-shots/brief-act-12-kinds.png");

        // 13. the held land's row offers the pet's verbs; Dismiss acks with land: true (the ack is stubbed)
        await lookEval(h, `
            const { RpcApi } = await mod("app/store/wshclientapi.ts");
            (window.__heldRpc ??= {}).AckRunCommand ??= RpcApi.AckRunCommand;
            window.__briefActAcks = [];
            RpcApi.AckRunCommand = (_client, data) => {
                window.__briefActAcks.push(data);
                return Promise.resolve();
            };
        `);
        await h.ev(`(${actQueueRow("review held land")})?.querySelector('[data-jarvis-queue-act="dismiss-land"]')?.click()`);
        const dismissed = await lookEval(h, `
            await until(() => (window.__briefActAcks ?? []).length > 0, 3000);
            await until(() => document.querySelector('[data-jarvis-brief-toast]') != null, 3000);
            return {
                acks: window.__briefActAcks ?? [],
                toast: (document.querySelector('[data-jarvis-brief-toast]')?.innerText || "").replace(/\\s+/g, " ").trim(),
            };
        `);
        await h.shot("cdp-shots/brief-act-13-held-land.png");
        await releaseRpc(h, "AckRunCommand");
        steps.push({
            step: "13. F8: a held land offers Retry land and Dismiss, and Dismiss acks the land",
            ok:
                JSON.stringify(waiting.heldActs) === JSON.stringify(["Retry land", "Dismiss"]) &&
                dismissed.acks.length === 1 &&
                dismissed.acks[0].land === true &&
                dismissed.acks[0].runid === "r-review-held" &&
                /Dismissed · review held land/.test(dismissed.toast),
            detail: JSON.stringify({ acts: waiting.heldActs, ...dismissed }),
        });

        steps.push({
            step: "14. F9: an ask with no channel draws no button, not a dead Open",
            ok: waiting.ask.includes("Which tenant goes first?") && waiting.askActs.length === 0,
            detail: JSON.stringify({ ask: waiting.ask, acts: waiting.askActs }),
        });
        await h.ev(`(${actQueueRow("Which tenant goes first?")})?.scrollIntoView({ block: "center" })`);
        await h.shot("cdp-shots/brief-act-14-no-act.png");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="true"]')?.click()`);

        // 15 + 16. Behind you: newest first across projects, and the cap counts folded lines. Its window is
        // module state, so one left open by hand is closed first.
        await h.ev(`document.querySelector('[data-jarvis-brief-region="behind"] [data-jarvis-brief-more="less"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 300))");
        const behindRows = await h.ev(`(() => {
            const sec = document.querySelector('[data-jarvis-brief-region="behind"]');
            const t = (r) => (r?.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                rows: [...(sec?.querySelectorAll('[data-jarvis-brief-row="delta"]') ?? [])].map(t),
                more: t(sec?.querySelector('[data-jarvis-brief-more]')),
            };
        })()`);
        await h.ev(`document.querySelector('[data-jarvis-brief-region="behind"]')?.scrollIntoView({ block: "start" })`);
        steps.push({
            step: "15. F1: Behind you leads with today's newest line, not the decisions the server lists first",
            ok:
                behindRows.rows.length > 0 &&
                /Review notes initiative|Review run from today/.test(behindRows.rows[0]) &&
                !/review decision/.test(behindRows.rows[0]),
            detail: JSON.stringify(behindRows.rows.slice(0, 3)),
        });
        await h.shot("cdp-shots/brief-act-15-newest-first.png");
        const digest = behindRows.rows.find((r) => r.includes("Review notes initiative")) ?? "";
        // eight lines fold out of 47 events (the digest, the run, six decisions): the cap of 5 hides 3 lines
        steps.push({
            step: "16. F2: 40 notes fold to one digest, and +N more counts the folded lines it hides, not events",
            ok:
                /40 notes/.test(digest) &&
                behindRows.rows.filter((r) => r.includes("Review notes initiative")).length === 1 &&
                behindRows.rows.length === 5 &&
                behindRows.more === "+3 more",
            detail: JSON.stringify({ digest, drawn: behindRows.rows.length, more: behindRows.more }),
        });
        await h.shot("cdp-shots/brief-act-16-digest.png");

        // 17. a filter that matches nothing says so in the delta and in Shipped, and mark seen stays
        await actFilter(h, "zz-no-match");
        const noMatch = await h.ev(`(() => {
            const sec = document.querySelector('[data-jarvis-brief-region="behind"]');
            const text = (sec?.innerText || "").replace(/\\s+/g, " ");
            return {
                noMatch: text.split("Nothing here matches the filter.").length - 1,
                nothingNew: text.includes("Nothing new since you last looked."),
                markSeen: sec?.querySelector('[data-jarvis-brief-mark-seen]') != null,
            };
        })()`);
        await h.ev(`document.querySelector('[data-jarvis-brief-region="behind"]')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-17-no-match.png");
        await actFilter(h, "");
        steps.push({
            step: "17. F17: a filter matching nothing reads as no match in Behind you and in Shipped, and mark seen stays",
            ok: noMatch.noMatch === 2 && !noMatch.nothingNew && noMatch.markSeen,
            detail: JSON.stringify(noMatch),
        });

        // 18. Behind you's head shows only that region, and a second press shows all four
        const regions = `[...document.querySelectorAll('[data-jarvis-brief-region]')].map((s) => s.dataset.jarvisBriefRegion)`;
        const behindHead = `document.querySelector('[data-jarvis-brief-region="behind"] button[aria-pressed]')`;
        await h.ev(`${behindHead}?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const onlyBehind = await h.ev(regions);
        await h.shot("cdp-shots/brief-act-18-only-behind.png");
        await h.ev(`${behindHead}?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const allRegions = await h.ev(regions);
        steps.push({
            step: "18. F18: pressing Behind you's head shows only it, and pressing again shows all four regions",
            ok: JSON.stringify(onlyBehind) === JSON.stringify(["behind"]) && allRegions.length === 4,
            detail: JSON.stringify({ onlyBehind, allRegions }),
        });

        // 19. live: Unblock hides the row and drops the initiative's count at the click; Undo brings both back
        await actFixture(h, null);
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click()`);
        const initRow = `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => (r.innerText || "").includes(${JSON.stringify(ACT_EFFORT)}))`;
        const blockedN = `Number(/(\\d+) blocked/.exec((${initRow})?.innerText || "")?.[1] ?? 0)`;
        const settle = await lookEval(h, `
            await until(() => ${actQueueRow("act-settle")} != null && ${initRow} != null, 30000);
            const before = ${blockedN};
            ${actQueueRow("act-settle")}?.querySelector('[data-jarvis-queue-act="unblock-chunk"]')?.click();
            const t0 = Date.now();
            const gone = await until(() => ${actQueueRow("act-settle")} == null && ${blockedN} === before - 1, 1000);
            const goneMs = Date.now() - t0;
            const after = ${blockedN};
            return { before, gone, goneMs, after };
        `);
        await h.shot("cdp-shots/brief-act-19-settled.png");
        const restored = await lookEval(h, `
            await until(() => document.querySelector('[data-jarvis-toast-undo]') != null, 5000);
            document.querySelector('[data-jarvis-toast-undo]')?.click();
            const back = await until(() => ${actQueueRow("act-settle")} != null && ${blockedN} === ${settle.before}, 20000);
            return { back, n: ${blockedN} };
        `);
        const reblocked19 = await actWaitChunk(h, ctx.effortoid, "act-settle", "blocked");
        steps.push({
            step: "19. F14: Unblock removes its Waiting row and one of the initiative's N blocked at once; Undo brings both back",
            ok: settle.before > 0 && settle.gone && settle.after === settle.before - 1 && restored.back && reblocked19?.status === "blocked",
            detail: JSON.stringify({ ...settle, restored, chunk: reblocked19?.status }),
        });
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="true"]')?.click()`);

        // 20. live: mark seen empties Behind you at the click; its Undo brings the rows back
        const deltaN = `document.querySelectorAll('[data-jarvis-brief-region="behind"] [data-jarvis-brief-row="delta"]').length`;
        const seen = await lookEval(h, `
            await until(() => ${deltaN} > 0 && document.querySelector('[data-jarvis-brief-mark-seen]') != null, 20000);
            const before = ${deltaN};
            document.querySelector('[data-jarvis-brief-mark-seen]')?.click();
            const emptied = await until(() => ${deltaN} === 0, 1000);
            return { before, emptied, after: ${deltaN} };
        `);
        await h.ev(`document.querySelector('[data-jarvis-brief-region="behind"]')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-20-marked-seen.png");
        const unseen = await lookEval(h, `
            await until(() => document.querySelector('[data-jarvis-toast-undo]') != null, 5000);
            document.querySelector('[data-jarvis-toast-undo]')?.click();
            const back = await until(() => ${deltaN} > 0, 20000);
            return { back, n: ${deltaN} };
        `);
        steps.push({
            step: "20. F14: mark seen empties Behind you at the click, and its Undo restores the rows",
            ok: seen.before > 0 && seen.emptied && unseen.back,
            detail: JSON.stringify({ ...seen, unseen }),
        });

        // 21-27: the 11-05 code review's Runs, snapshot and pet findings. The review fixture's Runs: an asking direct
        // agent above two live quick runs and twelve week-quiet orchestrator runs, and Shipped past its cap.
        await actFixture(h, "review");
        await actFilter(h, "");
        const sessionRows = `[...document.querySelectorAll('[data-jarvis-brief-region="sessions"] [data-jarvis-brief-row="session"]')]`;
        const LIVE_RUN = "sessions:run:run:r-review-live-2";
        const f5 = await lookEval(h, `${ACT_BRIEF_LIB}
            window.__briefActAgents ??= fx.agents;
            await setAgents([]);
            await nap(400);
            globalStore.get(listNavAtom)?.setCursor(${JSON.stringify(LIVE_RUN)});
            await nap(400);
            const before = { cursor: flat(cursorRow()), top: scroll.scrollTop };
            await setAgents(window.__briefActAgents);
            // an entrance replay starts from opacity 0, so 60ms in it still reads below 1
            const row = cursorRow();
            const opacity = row != null ? Number(getComputedStyle(row.parentElement).opacity) : null;
            await nap(400);
            const names = ${sessionRows}.map(flat);
            return {
                before,
                after: { cursor: flat(cursorRow()), top: scroll.scrollTop },
                opacity,
                asker: names.findIndex((t) => t.includes("review asker")),
                live: names.findIndex((t) => t.includes("Review live quick run 2")),
            };
        `);
        steps.push({
            step: "21. F5: an asking agent arriving above a Runs row leaves the cursor and the scroll where they were, with no entrance replay",
            ok:
                f5.before.cursor.includes("Review live quick run 2") &&
                f5.after.cursor === f5.before.cursor &&
                f5.after.top === f5.before.top &&
                f5.opacity === 1 &&
                f5.asker >= 0 &&
                f5.asker < f5.live,
            detail: JSON.stringify(f5),
        });
        await h.shot("cdp-shots/brief-act-21-stable-key.png");

        // 22. the asking agent's Answer goes to the Agent surface on that agent; a run whose Run has not loaded keeps
        // its run badge
        const f6 = await lookEval(h, `${ACT_BRIEF_LIB}
            const brief = document.querySelector('[data-jarvis-region="brief"]');
            const fk = brief && Object.keys(brief).find((k) => k.startsWith("__reactFiber$"));
            let model = null;
            for (let f = fk ? brief[fk] : null; f && model == null; f = f.return) {
                if (f.memoizedProps?.model?.focusIdAtom) model = f.memoizedProps.model;
            }
            const rows = ${sessionRows};
            const asker = rows.find((r) => flat(r).includes("review asker"));
            const live = rows.find((r) => flat(r).includes("Review live quick run 1"));
            const liveBadge = flat([...(live?.querySelectorAll("span") ?? [])].find((s) => s.className.includes("rounded-[5px]")));
            button(asker, /^Answer$/)?.click();
            await until(() => model != null && globalStore.get(model.surfaceAtom) === "agent", 3000);
            return {
                model: model != null,
                answer: button(asker, /^Answer$/) != null || !document.contains(asker),
                liveBadge,
                focus: model != null ? globalStore.get(model.focusIdAtom) : null,
                surface: model != null ? globalStore.get(model.surfaceAtom) : null,
            };
        `);
        await h.shot("cdp-shots/brief-act-22-answer-agent.png");
        steps.push({
            step: "22. F6: an asking direct agent's Answer lands on the Agent surface with that agent focused; an unloaded run keeps its run badge",
            ok: f6.focus === "tab-review-asker" && f6.surface === "agent" && f6.liveBadge === "quick run",
            detail: JSON.stringify(f6),
        });
        await h.goto("jarvis");
        await h.ev("new Promise((r) => setTimeout(r, 700))");

        // 23. the kind chips count what the head's N live counts, not the week-quiet runs behind the fold
        const f15 = await h.ev(`(() => {
            const sec = document.querySelector('[data-jarvis-brief-region="sessions"]');
            const t = (el) => (el?.innerText || "").replace(/\\s+/g, " ").trim();
            const chip = (k) => t(sec?.querySelector('[data-jarvis-run-kind] [data-filter-option="' + k + '"]'));
            return { head: t(sec?.firstElementChild), all: chip("all"), orchestrator: chip("orchestrator"), quick: chip("quick") };
        })()`);
        const chipN = (s) => Number(/(\d+)\s*$/.exec(s ?? "")?.[1] ?? NaN);
        const liveN = Number(/(\d+) live/.exec(f15.head)?.[1] ?? NaN);
        steps.push({
            step: "23. F15: the all chip counts the runs the head's N live counts, not the 12 stale ones",
            ok: liveN === 3 && chipN(f15.all) === liveN && chipN(f15.orchestrator) === 0 && chipN(f15.quick) === 2,
            detail: JSON.stringify(f15),
        });
        await h.ev(`document.querySelector('[data-jarvis-brief-region="sessions"]')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-23-live-chips.png");

        // 24. a run sheet on a shipped run steps through all of Shipped: the fourth run opens Shipped's fold and sits
        // under the cursor. The fixture's runs exist only on this page, so they ride a real channel's run list, and
        // the scenario lands the sheet on each one as the router would.
        const SHIPPED_RUNS = ["r-review-shipped", ...Array.from({ length: 4 }, (_, i) => `r-review-shipped-${i + 1}`)];
        await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-shipped-more]')].find((b) => /show less/.test(b.innerText))?.click()`);
        const f16 = await lookEval(h, `${ACT_BRIEF_LIB}
            const ch = ${JSON.stringify(ctx.channelId ?? "")};
            const ids = ${JSON.stringify(SHIPPED_RUNS)};
            const { activeChannelIdAtom, activeChannelAtom, activeChannelRunsAtom } = await mod("app/view/agents/channelsstore.ts");
            const { activeSubjectAtom, activeRunIdAtom } = await mod("app/view/jarvis/jarvissubjectstore.ts");
            const { briefSheetOpenAtom, briefRunListAtom } = await mod("app/view/jarvis/jarvisstore.ts");
            globalStore.set(activeChannelIdAtom, ch);
            const loaded = await until(() => globalStore.get(activeChannelAtom) != null && globalStore.get(activeChannelRunsAtom).length > 0, 15000);
            const real = globalStore.get(activeChannelRunsAtom)[0];
            globalStore.set(activeChannelRunsAtom, ids.map((id) => ({ ...real, id, status: "done", mode: "quick" })));
            globalStore.set(activeRunIdAtom, { [ch]: ids[0] });
            globalStore.set(activeSubjectAtom, { kind: "channel", id: ch });
            globalStore.set(briefSheetOpenAtom, true);
            await nap(700);
            const behind = document.querySelector('[data-jarvis-brief-region="behind"]');
            const shippedHead = [...(behind?.querySelectorAll("div") ?? [])].find((d) => d.firstElementChild?.textContent === "Shipped · 7 days");
            const list = globalStore.get(briefRunListAtom);
            const navN = globalStore.get(listNavAtom)?.navigableIds.length ?? 0;
            const stepped = [];
            for (let i = 1; i <= 3; i++) {
                const c = globalStore.get(listNavAtom);
                const next = c.navigableIds[c.navigableIds.indexOf(c.cursorId) + 1];
                stepped.push(next);
                c.setCursor(next);
                globalStore.set(activeRunIdAtom, { [ch]: ids[i] });
                await nap(500);
            }
            const cur = cursorRow();
            return {
                loaded,
                list,
                head: flat(shippedHead?.children[1]),
                navN,
                stepped,
                cursor: flat(cur),
                cursorRow: cur?.dataset.jarvisBriefRow ?? null,
                fold: flat(behind?.querySelector('[data-jarvis-brief-shipped-more]')),
                drawn: behind?.querySelectorAll('[data-jarvis-brief-row="shipped"]').length ?? 0,
            };
        `);
        await h.ev(`document.querySelector('[data-jarvis-brief-cursor="true"]')?.scrollIntoView({ block: "center" })`);
        await h.shot("cdp-shots/brief-act-24-shipped-fold.png");
        await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { activeChannelIdAtom } = await mod("app/view/agents/channelsstore.ts");
            const { clearSubject } = await mod("app/view/jarvis/jarvissubjectstore.ts");
            const { briefSheetOpenAtom } = await mod("app/view/jarvis/jarvisstore.ts");
            globalStore.set(briefSheetOpenAtom, false);
            clearSubject();
            globalStore.set(activeChannelIdAtom, undefined);
            await nap(400);
        `);
        await h.ev(`[...document.querySelectorAll('[data-jarvis-brief-shipped-more]')].find((b) => /show less/.test(b.innerText))?.click()`);
        steps.push({
            step: "24. F16: a run sheet on a shipped run counts all of Shipped, and stepping to the fourth run opens Shipped's fold under the cursor",
            ok:
                ctx.arrangeError == null &&
                f16.loaded &&
                JSON.stringify(f16.list) === JSON.stringify(SHIPPED_RUNS) &&
                Number(f16.head) === SHIPPED_RUNS.length &&
                f16.navN === SHIPPED_RUNS.length &&
                f16.cursorRow === "shipped" &&
                f16.cursor.includes("Review shipped run 3") &&
                f16.fold === "show less" &&
                f16.drawn === SHIPPED_RUNS.length,
            detail: ctx.arrangeError ?? JSON.stringify(f16),
        });

        // 25. a partial snapshot says which legs it could not read, and the regions they feed say so instead of
        // claiming nothing is there
        await actFixture(h, "partial");
        const f10 = await h.ev(`(() => {
            const t = (s) => (document.querySelector(s)?.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                band: t('[data-jarvis-brief-band="partial"]'),
                retry: document.querySelector('[data-jarvis-brief-partial-retry]') != null,
                runs: t('[data-jarvis-brief-region="sessions"]'),
                behind: t('[data-jarvis-brief-region="behind"]'),
                initiatives: t('[data-jarvis-brief-region="initiatives"]'),
            };
        })()`);
        await h.shot("cdp-shots/brief-act-25-partial.png");
        steps.push({
            step: "25. F10: a partial snapshot shows a band naming Runs and Initiatives with Retry, and Runs, Shipped and Initiatives say they couldn't be read",
            ok:
                /Partial snapshot: couldn't read Runs, Initiatives\./.test(f10.band) &&
                /Retry/.test(f10.band) &&
                f10.retry &&
                /couldn't read runs/i.test(f10.runs) &&
                /couldn't read shipped runs/i.test(f10.behind) &&
                !/nothing shipped/i.test(f10.behind) &&
                /couldn't read initiatives/i.test(f10.initiatives) &&
                !/no initiative is active/i.test(f10.initiatives),
            detail: JSON.stringify(f10),
        });

        // 26. a cursor move that scrolls the rows is not the user moving on: Where we were stays open. The stale fold
        // is opened first so the last Runs row sits below the fold (Behind you's rows may sit in the right column, in view).
        await actFixture(h, "review");
        await h.ev(`document.querySelector('[data-jarvis-brief-stale][aria-expanded="false"]')?.click()`);
        const f20 = await lookEval(h, `${ACT_BRIEF_LIB}
            const { petBubbleAtom } = await mod("app/view/jarvis/petstore.ts");
            scroll.scrollTop = 0;
            await nap(300);
            globalStore.set(petBubbleAtom, { id: "resume:brief-act:2", at: 2, kind: "resume", text: "verify brief-act resume" });
            await nap(200);
            const shown = globalStore.get(petBubbleAtom) != null;
            const top0 = scroll.scrollTop;
            const ids = globalStore.get(listNavAtom)?.navigableIds ?? [];
            globalStore.get(listNavAtom)?.setCursor(ids.filter((id) => id.startsWith("sessions:")).pop());
            await nap(600);
            return { shown, top0, top: scroll.scrollTop, open: globalStore.get(petBubbleAtom) != null };
        `);
        await h.shot("cdp-shots/brief-act-26-bubble-stays.png");
        await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { petBubbleAtom } = await mod("app/view/jarvis/petstore.ts");
            globalStore.set(petBubbleAtom, null);
        `);
        await h.ev(`document.querySelector('[data-jarvis-brief-stale][aria-expanded="true"]')?.click()`);
        steps.push({
            step: "26. F20: a cursor move that scrolls the rows with no key or pointer event leaves Where we were open",
            ok: f20.shown && f20.top > f20.top0 && f20.open,
            detail: JSON.stringify(f20),
        });

        // 27. live: a Stop the server refuses shows the reason in an error toast, and the run still reads as before
        await actFixture(h, null);
        const stopRow = `[...document.querySelectorAll('[data-jarvis-brief-region="sessions"] [data-jarvis-brief-row="session"]')].find((r) => (r.innerText || "").includes("verify brief-act: do nothing"))`;
        const STOP_REFUSED = "verify: the cancel was refused";
        const f22before = await lookEval(h, `
            (await mod("app/view/jarvis/briefingstore.ts")).refreshBriefing();
            const found = await until(() => ${stopRow}?.querySelector('button[title="Stop this session"]') != null, 60000);
            return { found, text: flat(${stopRow}) };
        `);
        await failRpc(h, "CancelRunCommand", STOP_REFUSED);
        const f22 = await lookEval(h, `
            ${stopRow}?.querySelector('button[title="Stop this session"]')?.click();
            await nap(300);
            button(dialog(), /^Cancel run$/)?.click();
            await until(() => document.querySelector('[data-jarvis-brief-toast="error"]') != null, 5000);
            await nap(300);
            return {
                toast: flat(document.querySelector('[data-jarvis-brief-toast]')),
                error: document.querySelector('[data-jarvis-brief-toast="error"]') != null,
                text: flat(${stopRow}),
            };
        `);
        await h.shot("cdp-shots/brief-act-27-stop-refused.png");
        await releaseRpc(h, "CancelRunCommand");
        steps.push({
            step: "27. F22: a Stop the server refuses shows an error toast with its message, and the run row is unchanged",
            ok:
                ctx.arrangeError == null &&
                f22before.found &&
                f22.error &&
                f22.toast.includes(STOP_REFUSED) &&
                f22.text === f22before.text &&
                !/stopped/.test(f22.text),
            detail: ctx.arrangeError ?? JSON.stringify({ before: f22before, ...f22 }),
        });

        // 28-34: the 11-05 code review's Initiatives findings, live. Two more initiatives: a staged one and an
        // archived one, deleted in teardown; act-label is blocked again for the filter of step 28.
        try {
            ctx.stagedoid = (
                await h.rpc("effortcreate", {
                    title: ACT_STAGED,
                    chunks: [{ label: "st-a" }, { label: "st-b" }, { label: "st-c" }],
                })
            ).effortoid;
            await h.rpc("effortmutate", {
                effortoid: ctx.stagedoid,
                author: "you",
                ops: [
                    { op: "setChunkStage", chunk: "st-a", stage: "Alpha" },
                    { op: "setChunkStage", chunk: "st-b", stage: "Beta" },
                    { op: "setChunkStage", chunk: "st-c", stage: "Beta" },
                    { op: "setChunkStatus", chunk: "st-b", status: "done" },
                    { op: "setChunkStatus", chunk: "st-c", status: "done" },
                ],
            });
            ctx.archivedoid = (
                await h.rpc("effortcreate", { title: ACT_ARCHIVED, chunks: [{ label: "arch-one" }, { label: "arch-two" }] })
            ).effortoid;
            await h.rpc("effortmutate", { effortoid: ctx.archivedoid, author: "you", ops: [{ op: "setStatus", status: "archived" }] });
            await h.rpc("effortmutate", {
                effortoid: ctx.effortoid,
                author: "you",
                ops: [{ op: "setChunkStatus", chunk: "act-label", status: "blocked", note: "needs: the G4 label" }],
            });
        } catch (e) {
            ctx.initError = String(e?.message ?? e);
        }
        const stagedOref = `effort:${ctx.stagedoid}`;
        const archivedOref = `effort:${ctx.archivedoid}`;

        // 28. a filter matching a Waiting row's needs but not its initiative: opening the row lands on the chunk
        await actFilter(h, "G4 label");
        const f3 = await lookEval(h, `
            const found = await until(() => ${actQueueRow("act-label")} != null, 30000);
            ${actQueueRow("act-label")}?.click();
            const landed = await until(() => (document.querySelector('[data-jarvis-chunk-sidebar]')?.innerText || "").includes("act-label"), 6000);
            await nap(300);
            return {
                found,
                landed,
                filter: document.querySelector('[data-jarvis-brief-filter]')?.value ?? null,
                pressed: document.querySelector('[data-jarvis-tracker-chunk="act-label"]')?.getAttribute("aria-pressed") ?? null,
                open: flat(${ACT_OPEN_INIT}),
            };
        `);
        await h.shot("cdp-shots/brief-act-28-filter-landing.png");
        steps.push({
            step: "28. F3: with a filter that matches a Waiting row's needs but not its initiative, opening the row lands on its chunk and clears the filter",
            ok: ctx.initError == null && f3.found && f3.landed && f3.filter === "" && f3.pressed === "true" && f3.open.includes(ACT_EFFORT),
            detail: ctx.initError ?? JSON.stringify(f3),
        });
        await h.ev(`${ACT_OPEN_INIT}?.click()`);

        // 29. the ↳ reveal on an archived initiative turns Show archived on and opens its plan on the chunk
        await h.ev(`document.querySelector('[data-jarvis-brief-archived="hide"]')?.click()`);
        const f4 = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { loadArchivedEfforts } = await mod("app/view/jarvis/effortstore.ts");
            const { briefRevealChunkAtom } = await mod("app/view/jarvis/jarvisstore.ts");
            await loadArchivedEfforts();
            await nap(300);
            const hiddenBefore = document.querySelector('[data-jarvis-brief-archived="hide"]') == null && ${actInitRow(ACT_ARCHIVED)} == null;
            globalStore.get(briefRevealChunkAtom)?.(${JSON.stringify(archivedOref)}, "arch-two");
            const landed = await until(() => document.querySelector('[data-jarvis-tracker-chunk="arch-two"]')?.getAttribute("aria-pressed") === "true", 6000);
            await nap(300);
            return {
                hiddenBefore,
                landed,
                showing: document.querySelector('[data-jarvis-brief-archived="hide"]') != null,
                open: flat(${ACT_OPEN_INIT}),
            };
        `);
        await h.ev(`${ACT_OPEN_INIT}?.scrollIntoView({ block: "center" })`);
        await h.shot("cdp-shots/brief-act-29-archived-reveal.png");
        steps.push({
            step: "29. F4: the ↳ reveal on an archived initiative turns Show archived on and opens its plan on the chunk",
            ok: f4.hiddenBefore && f4.landed && f4.showing && f4.open.includes(ACT_ARCHIVED),
            detail: JSON.stringify(f4),
        });
        await h.ev(`${ACT_OPEN_INIT}?.click()`);
        await h.ev(`document.querySelector('[data-jarvis-brief-archived="hide"]')?.click()`);

        // 30. a plan whose first load fails shows the error and Retry in place of the loading line; Retry loads it
        const PLAN_REFUSED = "verify: the plan read was refused";
        await actFilter(h, ACT_STAGED);
        await actUncache(h, stagedOref);
        await failRpc(h, "EffortGetCommand", PLAN_REFUSED);
        const f13 = await lookEval(h, `
            await until(() => ${actInitRow(ACT_STAGED)} != null, 30000);
            ${actInitRow(ACT_STAGED)}?.click();
            const shown = await until(() => document.querySelector('[data-jarvis-initiative-detail="error"]') != null, 6000);
            return {
                shown,
                text: flat(document.querySelector('[data-jarvis-initiative-detail="error"]')),
                retry: document.querySelector('[data-jarvis-plan-retry]') != null,
                loading: document.querySelector('[data-jarvis-initiative-detail="loading"]') != null,
            };
        `);
        await h.shot("cdp-shots/brief-act-30-plan-error.png");
        await releaseRpc(h, "EffortGetCommand");
        // the retried read waits on a gate rather than holdRpc's never-settling promise, so the Retry's own load
        // is the one that draws the plan once the gate opens
        const retrying = await lookEval(h, `
            const { RpcApi } = await mod("app/store/wshclientapi.ts");
            const real = RpcApi.EffortGetCommand;
            let open;
            const gate = new Promise((r) => (open = r));
            window.__planRetryGate = () => { RpcApi.EffortGetCommand = real; open(); };
            RpcApi.EffortGetCommand = (...args) => gate.then(() => real.apply(RpcApi, args));
            document.querySelector('[data-jarvis-plan-retry]')?.click();
            const loading = await until(() => document.querySelector('[data-jarvis-initiative-detail="loading"]') != null, 6000);
            return { loading, error: document.querySelector('[data-jarvis-initiative-detail="error"]') != null };
        `);
        await h.shot("cdp-shots/brief-act-30-plan-retrying.png");
        const f13b = await lookEval(h, `
            window.__planRetryGate?.();
            delete window.__planRetryGate;
            const drawn = await until(() => document.querySelector('[data-jarvis-tracker-stage]') != null, 10000);
            return { drawn, error: document.querySelector('[data-jarvis-initiative-detail="error"]') != null };
        `);
        await h.shot("cdp-shots/brief-act-30-plan-retried.png");
        steps.push({
            step: "30. F13: an initiative whose plan fails to load shows the error with Retry, and Retry draws the plan, showing the plan loading while it retries",
            ok:
                f13.shown &&
                f13.text.includes(PLAN_REFUSED) &&
                f13.retry &&
                !f13.loading &&
                retrying.loading &&
                !retrying.error &&
                f13b.drawn &&
                !f13b.error,
            detail: JSON.stringify({ ...f13, retrying, retried: f13b }),
        });
        await h.ev(`${ACT_OPEN_INIT}?.click()`);

        // 31. Details asked of an unloaded initiative, which is then collapsed, does not open on the next one
        await actFilter(h, "verify brief-act");
        await actUncache(h, stagedOref);
        await holdRpc(h, "EffortGetCommand");
        const f19menu = await actMenuClick(h, ACT_STAGED, "Details");
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const f19loading = await h.ev(`document.querySelector('[data-jarvis-initiative-detail="loading"]') != null`);
        await h.ev(`${ACT_OPEN_INIT}?.click()`);
        await releaseRpc(h, "EffortGetCommand");
        const f19 = await lookEval(h, `
            await nap(400);
            ${actInitRow(ACT_EFFORT)}?.click();
            const drawn = await until(() => document.querySelector('[data-jarvis-tracker-chunk="act-soak"]') != null, 10000);
            await nap(600);
            return { drawn, open: flat(${ACT_OPEN_INIT}), form: document.querySelector('[data-effort-field]') != null };
        `);
        await h.shot("cdp-shots/brief-act-31-no-stray-details.png");
        steps.push({
            step: "31. F19: Details from the menu of an unloaded initiative, collapsed before it loads, does not show on the next initiative opened",
            ok: f19menu.clicked && f19loading && f19.drawn && f19.open.includes(ACT_EFFORT) && !f19.form,
            detail: JSON.stringify({ menu: f19menu, loading: f19loading, ...f19 }),
        });
        await h.ev(`${ACT_OPEN_INIT}?.click()`);
        await actFilter(h, "");

        // 32. with Alpha's only chunk waiting out its delete, landing on st-c unfolds Beta (folded: all done) under the
        // cursor. The delete is scheduled as the plan's Delete schedules it, then undone inside its window.
        const f21 = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { briefUndo, chunkKey } = await mod("app/view/jarvis/briefundo.ts");
            const { loadEffortDetail, removeChunks, effortChunkRows, effortDetailAtom } = await mod("app/view/jarvis/effortstore.ts");
            const { briefRevealChunkAtom } = await mod("app/view/jarvis/jarvisstore.ts");
            const oref = ${JSON.stringify(stagedOref)};
            await loadEffortDetail(oref);
            const plan = effortChunkRows(globalStore.get(effortDetailAtom).get(oref));
            briefUndo.schedule([chunkKey(oref, "st-a")], "Deleted “st-a”", () => removeChunks(oref, plan, ["st-a"]));
            globalStore.get(briefRevealChunkAtom)?.(oref, "st-c");
            const landed = await until(() => document.querySelector('[data-jarvis-tracker-chunk="st-c"]')?.getAttribute("aria-pressed") === "true", 3000);
            return {
                landed,
                beta: document.querySelector('[data-jarvis-tracker-stage="Beta"]')?.getAttribute("aria-expanded") ?? null,
                alpha: document.querySelector('[data-jarvis-tracker-stage="Alpha"]') != null,
            };
        `);
        await h.shot("cdp-shots/brief-act-32-pending-delete-landing.png");
        const f21undo = await lookEval(h, `
            document.querySelector('[data-jarvis-toast-undo]')?.click();
            const back = await until(() => document.querySelector('[data-jarvis-tracker-stage="Alpha"]') != null, 3000);
            return { back };
        `);
        const kept = await actChunk(h, ctx.stagedoid, "st-a");
        steps.push({
            step: "32. F21: with the first stage's only chunk pending delete, landing on a later stage's chunk unfolds that stage with the cursor on it; Undo keeps the chunk",
            ok: f21.landed && f21.beta === "true" && !f21.alpha && f21undo.back && kept != null,
            detail: JSON.stringify({ ...f21, undo: f21undo, kept: kept?.label ?? null }),
        });
        await h.ev(`${ACT_OPEN_INIT}?.click()`);

        // 33. a Pause the server refuses shows an error toast, and no "Paused"
        const MUTATE_REFUSED = "verify: the pause was refused";
        await actFilter(h, ACT_STAGED);
        await actClearToast(h);
        await failRpc(h, "EffortMutateCommand", MUTATE_REFUSED);
        const f11menu = await actMenuClick(h, ACT_STAGED, "Pause");
        const f11 = await lookEval(h, `
            const shown = await until(() => document.querySelector('[data-jarvis-brief-toast="error"]') != null, 5000);
            await nap(300);
            return { shown, toast: flat(document.querySelector('[data-jarvis-brief-toast]')) };
        `);
        await h.shot("cdp-shots/brief-act-33-pause-refused.png");
        await releaseRpc(h, "EffortMutateCommand");
        const stagedStatus = ((await h.rpc("effortget", { effortoid: ctx.stagedoid })) ?? {}).effort?.status ?? null;
        steps.push({
            step: "33. F11: a Pause from the menu that the server refuses shows an error toast with its reason, and no Paused toast",
            ok: f11menu.clicked && f11.shown && f11.toast.includes(MUTATE_REFUSED) && !/Paused/.test(f11.toast) && stagedStatus != null && stagedStatus !== "paused",
            detail: JSON.stringify({ menu: f11menu, ...f11, status: stagedStatus }),
        });
        await actFilter(h, "");

        // 34. a status change from the record peek that the server refuses names the reason in an error toast. The
        // refused write leaves whichever record it opens unchanged.
        const STATUS_REFUSED = "verify: the status write was refused";
        await actClearToast(h);
        await failRpc(h, "SetDossierStatusCommand", STATUS_REFUSED);
        const f12 = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { RpcApi } = await mod("app/store/wshclientapi.ts");
            const { TabRpcClient } = await mod("app/store/wshrpcutil.ts");
            const { briefPeekRecordAtom } = await mod("app/view/jarvis/jarvisstore.ts");
            const spaces = (await RpcApi.ListDossiersCommand(TabRpcClient))?.spaces ?? [];
            const record = (spaces.find((s) => s.id === "verify-brief-act-do-nothing") ?? spaces[0])?.id ?? null;
            if (record == null) return { record };
            globalStore.set(briefPeekRecordAtom, record);
            const band = '[data-jarvis-brief-band="peek"]';
            await until(() => document.querySelector(band + ' [data-jarvis-peek-status-toggle]') != null, 10000);
            const pick = [...document.querySelectorAll(band + ' button[data-jarvis-peek-status]')].find((b) => ["active", "paused"].includes(b.dataset.jarvisPeekStatus));
            const status = pick?.dataset.jarvisPeekStatus ?? null;
            pick?.click();
            const shown = await until(() => document.querySelector('[data-jarvis-brief-toast="error"]') != null, 5000);
            await nap(300);
            // the toast answers the open peek, so it must draw above the dialog scrim, not under it
            const el = document.querySelector("[data-jarvis-brief-toast]");
            const r = el?.getBoundingClientRect();
            const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
            const onTop = hit?.closest("[data-jarvis-brief-toast]") != null;
            return { record, status, shown, onTop, toast: flat(el) };
        `);
        await h.shot("cdp-shots/brief-act-34-status-refused.png");
        await releaseRpc(h, "SetDossierStatusCommand");
        await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            globalStore.set((await mod("app/view/jarvis/jarvisstore.ts")).briefPeekRecordAtom, null);
        `);
        steps.push({
            step: "34. F12: a status change from the record peek that the server refuses shows an error toast naming the reason, drawn above the peek",
            ok: f12.record != null && f12.status != null && f12.shown && f12.onTop === true && f12.toast.includes("Couldn't set the record's status") && f12.toast.includes(STATUS_REFUSED),
            detail: JSON.stringify(f12),
        });

        // 35-40: the 11-05 Brief live pass. The review fixture's work keys name one project by path and by name
        // beside a run worktree and "(none)"; the registry is set page-side to that one project (Final's has none)
        // and put back after the step.
        await actFixture(h, "review");
        const f1 = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { atoms } = await mod("app/store/global-atoms.ts");
            window.__briefActCfg ??= globalStore.get(atoms.fullConfigAtom);
            globalStore.set(atoms.fullConfigAtom, {
                ...window.__briefActCfg,
                projects: { waveterm: { path: "C:/Users/dev/IdeaProjects/waveterm" } },
            });
            const fact = '[data-jarvis-region="brief"] [data-jarvis-brief-band="projects"]';
            await until(() => /1 project$/.test(flat(document.querySelector(fact))), 3000);
            return { fact: flat(document.querySelector(fact)) };
        `);
        await h.shot("cdp-shots/brief-act-35-projects.png");
        await actRestoreConfig(h);
        steps.push({
            step: "35. F1: the header counts the registered projects the work spans, not its keys: one project by path and by name, a worktree and (none) read as all work · 1 project",
            ok: f1.fact === "all work · 1 project",
            detail: JSON.stringify(f1),
        });

        // 36. a direct agent's ask (no channel, its tab in the oref) names the agent and answers on the Agent surface.
        // The router opens a tab only when the live roster holds it, so the review asker joins the dev roster for the
        // step (devMockAgentsAtom, as sessions-detail-states does) and leaves it after.
        const f2 = await lookEval(h, `${ACT_BRIEF_LIB}
            if (window.__briefActAgents != null) await setAgents(window.__briefActAgents);
            const dm = await mod("app/view/agents/devmock.ts");
            if (!("__briefActRoster" in window)) window.__briefActRoster = globalStore.get(dm.devMockAgentsAtom);
            const asker = fx.agents.find((a) => a.id === "tab-review-asker");
            globalStore.set(dm.devMockAgentsAtom, [...globalStore.get(dm.devRosterAtom).filter((a) => a.id !== asker?.id), asker]);
            // step 22 left the focus on this agent, so it is moved off first: the step must see the open move it back
            const brief0 = document.querySelector('[data-jarvis-region="brief"]');
            const fk0 = brief0 && Object.keys(brief0).find((k) => k.startsWith("__reactFiber$"));
            for (let f = fk0 ? brief0[fk0] : null; f; f = f.return) {
                if (f.memoizedProps?.model?.focusIdAtom) {
                    globalStore.set(f.memoizedProps.model.focusIdAtom, undefined);
                    break;
                }
            }
            document.querySelector('[data-jarvis-brief-region="waiting"] [data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click();
            await until(() => ${actQueueRow(REVIEW_AGENT_ASK)} != null, 3000);
            await nap(300);
            const row = ${actQueueRow(REVIEW_AGENT_ASK)};
            const text = flat(row);
            const acts = [...(row?.querySelectorAll('[data-jarvis-queue-act]') ?? [])].map(flat);
            const brief = document.querySelector('[data-jarvis-region="brief"]');
            const fk = brief && Object.keys(brief).find((k) => k.startsWith("__reactFiber$"));
            let model = null;
            for (let f = fk ? brief[fk] : null; f && model == null; f = f.return) {
                if (f.memoizedProps?.model?.focusIdAtom) model = f.memoizedProps.model;
            }
            row?.querySelector('[data-jarvis-queue-act]')?.click();
            await until(() => model != null && globalStore.get(model.surfaceAtom) === "agent", 3000);
            return {
                text,
                acts,
                focus: model != null ? globalStore.get(model.focusIdAtom) : null,
                surface: model != null ? globalStore.get(model.surfaceAtom) : null,
            };
        `);
        await h.shot("cdp-shots/brief-act-36-agent-ask.png");
        await actRestoreRoster(h);
        steps.push({
            step: "36. F2: a direct agent's ask names the agent, offers one Answer, and Answer lands on the Agent surface with that agent focused",
            ok:
                f2.text.includes("review asker") &&
                !/\bworker\b/.test(f2.text) &&
                JSON.stringify(f2.acts) === JSON.stringify(["Answer"]) &&
                f2.focus === "tab-review-asker" &&
                f2.surface === "agent",
            detail: JSON.stringify(f2),
        });
        await h.goto("jarvis");
        await h.ev("new Promise((r) => setTimeout(r, 700))");

        // 37 + 38. the ask's age reads "just now" on one line at both sizes, and the summary counts a single ask.
        // The queue is narrowed page-side to that ask, made fresh, and put back after.
        const f14 = (size) =>
            lookEval(h, `${ACT_BRIEF_LIB}
                window.__briefActAttention ??= fx.attention;
                const ask = window.__briefActAttention.find((a) => a.key === "ask:review-agent");
                fx.attention = [{ ...ask, waitingsince: Date.now() }];
                await setAgents(fx.agents);
                const region = '[data-jarvis-brief-region="waiting"]';
                document.querySelector(region + ' [data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click();
                await until(() => document.querySelector(region + ' [data-jarvis-queue-age]') != null, 3000);
                await nap(400);
                const age = document.querySelector(region + ' [data-jarvis-queue-age]');
                const cs = age != null ? getComputedStyle(age) : null;
                const lineHeight = cs != null ? parseFloat(cs.lineHeight) : NaN;
                const fontSize = cs != null ? parseFloat(cs.fontSize) : NaN;
                const height = age?.getBoundingClientRect().height ?? 0;
                return {
                    size: ${JSON.stringify(size)},
                    text: flat(age),
                    height,
                    lineHeight,
                    oneLine: Number.isNaN(lineHeight) ? height < fontSize * 2 : Math.abs(height - lineHeight) < 1,
                    scrollWidth: age?.scrollWidth ?? 0,
                    clientWidth: age?.clientWidth ?? 0,
                    summary: flat(document.querySelector(region + ' [data-jarvis-brief-summary-detail]')),
                };
            `);
        const ageOk = (r) => r.text === "just now" && r.oneLine && r.scrollWidth <= r.clientWidth;
        const f14wide = await f14("1600x950");
        await h.shot("cdp-shots/brief-act-37-age-wide.png");
        steps.push({
            step: "37. F14: at 1600x950 the ask's age reads just now on one line, and the summary counts it as 1 ask",
            ok: ageOk(f14wide) && /(^| )1 ask( |$)/.test(f14wide.summary),
            detail: JSON.stringify(f14wide),
        });
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const f14narrow = await f14("1000x700");
        await h.shot("cdp-shots/brief-act-38-age-narrow.png");
        steps.push({
            step: "38. F14: at 1000x700 the ask's age cell does not wrap",
            ok: ageOk(f14narrow),
            detail: JSON.stringify(f14narrow),
        });
        await actRestoreAttention(h);
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });

        // 39. ten initiatives whose 8th and 9th by activity hold blocked work: both show without +N more, and the head
        // counts them. The window, the project pick and the filter are module state, so each starts from its default.
        await actFixture(h, "initiatives");
        await actFilter(h, "");
        const initRegion = '[data-jarvis-brief-region="initiatives"]';
        await h.ev(`document.querySelector('${initRegion} [data-jarvis-brief-more="less"]')?.click()`);
        await h.ev(`document.querySelector('${initRegion} [data-jarvis-initiative-project] [data-filter-option="all"][aria-pressed="false"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        const f8 = await h.ev(`(() => {
            const sec = document.querySelector('${initRegion}');
            const t = (el) => (el?.innerText || "").replace(/\\s+/g, " ").trim();
            return {
                rows: [...(sec?.querySelectorAll('[data-jarvis-brief-row="initiative"]') ?? [])].map(t),
                head: t(sec?.querySelector('button[aria-pressed]')),
                more: t(sec?.querySelector('[data-jarvis-brief-more]')),
            };
        })()`);
        await h.ev(`document.querySelector('${initRegion}')?.scrollIntoView({ block: "start" })`);
        await h.shot("cdp-shots/brief-act-39-blocked-initiatives.png");
        const shownInit = (c) => f8.rows.some((r) => r.includes(`Window initiative ${c}`));
        steps.push({
            step: "39. F8: the initiatives holding blocked work (8th and 9th by activity) show without +N more, and the head leads with 2 blocked",
            ok:
                shownInit("H") &&
                shownInit("I") &&
                !shownInit("E") &&
                f8.rows.length === 6 &&
                f8.more === "+4 more" &&
                /2 blocked/.test(f8.head),
            detail: JSON.stringify(f8),
        });

        // 40. a filter matching nothing reads 0 of N on Waiting's summary and head (unfiltered the head drops its count,
        // which the summary already says), Initiatives' all chip and Shipped's;
        // cleared, the counts read as before
        const f16Counts = () =>
            h.ev(`(() => {
                const t = (el) => (el?.textContent || "").replace(/\\s+/g, " ").trim();
                const chip = (sel) => t(document.querySelector(sel)?.querySelector("span"));
                return {
                    waiting: t(document.querySelector('[data-jarvis-brief-region="waiting"] [data-jarvis-brief-summary-title]')),
                    waitingHead: t(document.querySelector('[data-jarvis-brief-region="waiting"] [data-jarvis-brief-region-count]')),
                    initiatives: chip('${initRegion} [data-jarvis-initiative-project] [data-filter-option="all"]'),
                    shipped: chip('[data-jarvis-brief-region="behind"] [data-jarvis-run-kind] [data-filter-option="all"]'),
                };
            })()`);
        const f16before = await f16Counts();
        await actFilter(h, "zz-no-match");
        const f16during = await f16Counts();
        await h.shot("cdp-shots/brief-act-40-filtered-counts.png");
        await actFilter(h, "");
        const f16after = await f16Counts();
        const waitingN = /^(\d+) things? (?:is|are) waiting on you$/.exec(f16before.waiting)?.[1] ?? null;
        steps.push({
            step: "40. F16 + F14: a filter matching nothing reads 0 of N on the Waiting summary and head, the Initiatives all chip and the Shipped all chip; cleared, they read N again and the Waiting head has no count",
            ok:
                waitingN != null &&
                f16before.waitingHead === "" &&
                f16before.initiatives === "10" &&
                f16before.shipped === "3" &&
                f16during.waiting === `0 of ${waitingN} waiting match the filter` &&
                f16during.waitingHead === `0 of ${waitingN}` &&
                f16during.initiatives === "0 of 10" &&
                f16during.shipped === "0 of 3" &&
                JSON.stringify(f16after) === JSON.stringify(f16before),
            detail: JSON.stringify({ before: f16before, during: f16during, after: f16after }),
        });
        await actFixture(h, null);

        // 41-45: the 11-05 Brief live pass's titles and labels, at 1600x950.
        // 41. a Shipped row is titled by its report's H1, not its goal, so its tooltip is short too
        await actFixture(h, "act");
        await actFilter(h, "");
        const f4ship = await h.ev(`(() => {
            const title = document.querySelector('[data-jarvis-brief-region="behind"] [data-jarvis-brief-row="shipped"] span[title]');
            return { text: (title?.textContent || "").replace(/\\s+/g, " ").trim(), attr: title?.getAttribute("title") ?? null };
        })()`);
        await h.shot("cdp-shots/brief-act-41-shipped-title.png");
        await actFixture(h, null);
        steps.push({
            step: "41. F4: a Shipped row whose report has an H1 is titled by that H1, and its title attribute is under 200 characters",
            ok: f4ship.text === ACT_SHIPPED_TITLE && f4ship.attr === ACT_SHIPPED_TITLE && f4ship.attr.length < 200,
            detail: JSON.stringify(f4ship),
        });

        // 42 + 43. a record captured from a run's goal: its peek title is the goal's lead sentence whole, past the ";",
        // while the run has no report, then the report's H1 once it has one. No RPC writes a run's report, so the H1
        // is set on the loaded copy of the run the peek reads, and put back after.
        ctx.titled = { cwd: mkdtempSync(join(tmpdir(), "verify-brief-act-titled-")) };
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-brief-act-titled", projectpath: ctx.titled.cwd });
            ctx.titled.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.titled.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: ACT_RECORD_GOAL,
                runtime: "claude",
                mode: "quick",
                deferstart: true,
            });
            ctx.titled.runId = created.run.id;
            const found = ((await h.rpc("listtaskdossiers", null))?.dossiers ?? []).find(
                (d) => (d.objective ?? "").trim() === ACT_RECORD_GOAL
            );
            if (found == null) throw new Error("CreateRun captured no record for the titled goal");
            ctx.titled.recordId = found.id;
            // an earlier pass's record fails the capture, so the run is attached explicitly
            await h.rpc("acceptdossieredge", { dossierid: found.id, runoref: `run:${ctx.titled.runId}` });
        } catch (e) {
            ctx.titled.error = String(e?.message ?? e);
        }
        const f4rec =
            ctx.titled.error != null
                ? {}
                : await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { briefPeekRecordAtom } = await mod("app/view/jarvis/jarvisstore.ts");
            const { recordRunsAtom } = await mod("app/view/jarvis/jarvissubjectstore.ts");
            const id = ${JSON.stringify(ctx.titled.recordId)};
            const goal = ${JSON.stringify(ACT_RECORD_GOAL)};
            const h1 = ${JSON.stringify(ACT_RECORD_H1)};
            const peek = '[data-jarvis-brief-band="peek"]';
            globalStore.set(briefPeekRecordAtom, id);
            const runRow = peek + ' [data-jarvis-peek-run="' + ${JSON.stringify(ctx.titled.runId)} + '"]';
            const loaded = await until(() => document.querySelector(runRow) != null, 15000);
            const title = () => flat(document.querySelector(peek + " [data-jarvis-peek-title]"));
            const fallback = title();
            const runs = globalStore.get(recordRunsAtom)[id] ?? [];
            const reportOn = (r) =>
                (r.goal ?? "").trim() === goal
                    ? { ...r, evidence: { ...(r.evidence ?? {}), summary: "# Run report: " + h1 + "\\n\\n- t-1: changed nothing" } }
                    : r;
            globalStore.set(recordRunsAtom, { ...globalStore.get(recordRunsAtom), [id]: runs.map(reportOn) });
            await until(() => title() === h1, 3000);
            const reported = title();
            globalStore.set(recordRunsAtom, { ...globalStore.get(recordRunsAtom), [id]: runs });
            globalStore.set(briefPeekRecordAtom, null);
            return { loaded, fallback, reported, runs: runs.length };
        `);
        steps.push({
            step: "42. F4: a record whose objective has a ; mid-sentence titles its peek with the whole lead sentence, not cut at the ;",
            ok: ctx.titled.error == null && f4rec.loaded === true && f4rec.fallback === ACT_RECORD_HEAD && !f4rec.fallback.endsWith(";"),
            detail: ctx.titled.error ?? JSON.stringify({ record: ctx.titled.recordId, ...f4rec }),
        });
        steps.push({
            step: "43. F4: once the record's origin run has a report, the record peek's title is that report's H1",
            ok: ctx.titled.error == null && f4rec.reported === ACT_RECORD_H1,
            detail: ctx.titled.error ?? JSON.stringify(f4rec),
        });

        // 44. the resume bubble says the summary alone: its heading is already Where we were
        const f9 = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { petBubbleAtom } = await mod("app/view/jarvis/petstore.ts");
            const { eventFromResume } = await mod("app/view/jarvis/petjoin.ts");
            const summary = ${JSON.stringify(ACT_RESUME_SUMMARY)};
            const ev = eventFromResume({
                card: { taskId: "verify-brief-act-resume", summary, status: "active", updated: Date.now() },
                runoref: "run:verify-brief-act-resume",
            });
            globalStore.set(petBubbleAtom, ev);
            await until(() => document.querySelector("[data-pet-bubble]") != null, 3000);
            await nap(300);
            const text = flat(document.querySelector("[data-pet-bubble] .line-clamp-3"));
            globalStore.set(petBubbleAtom, null);
            return { summary, text };
        `);
        steps.push({
            step: "44. F9: the Where we were bubble's text is the resume summary alone, not prefixed with Where we were",
            ok: f9.text === f9.summary && !/^Where we were/.test(f9.text),
            detail: JSON.stringify(f9),
        });

        // 45. Ctrl-click on a Waiting row peeks its initiative: the objective line is the written note, never the
        // "effort created" marker every initiative's notes start with. setProject writes the one effort note, the
        // batch's note after it; the blocked chunk is what puts the initiative in Waiting.
        let peekNotes = null;
        try {
            ctx.peekoid = (await h.rpc("effortcreate", { title: ACT_PEEK_EFFORT, chunks: [{ label: ACT_PEEK_CHUNK }] })).effortoid;
            await h.rpc("effortmutate", {
                effortoid: ctx.peekoid,
                author: "you",
                ops: [{ op: "setChunkStatus", chunk: ACT_PEEK_CHUNK, status: "blocked", note: "needs: a written objective" }],
            });
            await h.rpc("effortmutate", {
                effortoid: ctx.peekoid,
                author: "you",
                note: ACT_PEEK_NOTE,
                ops: [{ op: "setProject", project: ACT_PROJECT }],
            });
            peekNotes = ((await h.rpc("effortget", { effortoid: ctx.peekoid }))?.effort?.notes ?? []).map((n) => n.text);
        } catch (e) {
            ctx.peekError = String(e?.message ?? e);
        }
        const peekF13 = await lookEval(h, `
            const region = '[data-jarvis-brief-region="waiting"]';
            const row = () => ${actQueueRow(ACT_PEEK_CHUNK)};
            const found = await until(() => {
                document.querySelector(region + ' [data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click();
                return row() != null;
            }, 20000);
            row()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
            const item = '[data-pet-peek-item="effort"][data-pet-peek-status="ready"]';
            const ready = await until(() => document.querySelector(item) != null, 6000);
            await nap(300);
            const text = flat(document.querySelector(item));
            document.querySelector('[data-pet-peek] button[aria-label="Close Jarvis panel"]')?.click();
            return { found, ready, text: text.slice(0, 300) };
        `);
        await h.shot("cdp-shots/brief-act-45-initiative-peek.png");
        steps.push({
            step: "45. F13: Ctrl-click on a Waiting row peeks its initiative with the written note as its objective, never effort created",
            ok:
                ctx.peekError == null &&
                peekNotes?.length === 2 &&
                peekNotes[0] === "effort created" &&
                peekF13.found === true &&
                peekF13.ready === true &&
                peekF13.text.includes(ACT_PEEK_NOTE) &&
                !peekF13.text.includes("effort created"),
            detail: ctx.peekError ?? JSON.stringify({ notes: peekNotes, ...peekF13 }),
        });

        // 46. a run row with no navtarget keeps its key, and the j/k cursor on it, when a second keyless row arrives
        // above it (the keyless-one and keyless-two fixtures). The row's key is its list-nav id.
        await actFixture(h, "keyless-one");
        const keyless = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { listNavAtom } = await mod("app/store/keybindings/listnav.ts");
            const { briefingFixtureAtom } = await mod("app/view/jarvis/briefingstore.ts");
            const { KEYLESS_RUN_GOAL } = await mod("app/view/jarvis/briefingfixtures.ts");
            const nav = () => globalStore.get(listNavAtom);
            const runIds = () => (nav()?.navigableIds ?? []).filter((id) => id.startsWith("sessions:run:"));
            const cursorRow = () => document.querySelector('[data-jarvis-brief-cursor="true"]');
            await until(() => runIds().length === 1, 5000);
            const before = { ids: runIds() };
            nav()?.setCursor(before.ids[0]);
            await nap(300);
            before.cursor = nav()?.cursorId ?? null;
            before.row = flat(cursorRow());
            globalStore.set(briefingFixtureAtom, "keyless-two");
            await until(() => runIds().length === 2, 5000);
            await nap(400);
            const after = { ids: runIds(), cursor: nav()?.cursorId ?? null, row: flat(cursorRow()) };
            return { goal: KEYLESS_RUN_GOAL, before, after };
        `);
        await h.shot("cdp-shots/brief-act-46-keyless-key.png");
        steps.push({
            step: "46. F11: a keyless run row keeps its key and the cursor on it when a second keyless row arrives above it",
            ok:
                keyless.before.ids.length === 1 &&
                keyless.before.cursor === keyless.before.ids[0] &&
                keyless.before.row.includes(keyless.goal) &&
                keyless.after.ids.length === 2 &&
                keyless.after.ids.includes(keyless.before.ids[0]) &&
                keyless.after.cursor === keyless.before.cursor &&
                keyless.after.row.includes(keyless.goal),
            detail: JSON.stringify(keyless),
        });
        await actFixture(h, null);

        // 47. the initiative Edit form's footer holds no empty element, and Cancel and Save stay at its right edge
        await actFilter(h, ACT_EFFORT);
        const footerMenu = await actMenuClick(h, ACT_EFFORT, "Details");
        const editFooter = await lookEval(h, `
            const save = () => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Save changes");
            const opened = await until(() => save() != null, 10000);
            await nap(300);
            const footer = save()?.parentElement;
            if (footer == null) return { opened, found: false };
            const kids = [...footer.children];
            const cancel = kids.find((b) => (b.textContent || "").trim() === "Cancel");
            const fr = footer.getBoundingClientRect();
            const sr = save().getBoundingClientRect();
            const cr = cancel?.getBoundingClientRect();
            const padRight = parseFloat(getComputedStyle(footer).paddingRight);
            return {
                opened,
                found: true,
                tags: kids.map((k) => k.tagName),
                empty: kids.filter((k) => (k.textContent || "").trim() === "").length,
                saveGap: Math.round(fr.right - padRight - sr.right),
                cancelBeforeSave: cr != null && cr.right <= sr.left,
                cancelRightHalf: cr != null && cr.left > fr.left + fr.width / 2,
            };
        `);
        await h.shot("cdp-shots/brief-act-47-edit-footer.png");
        steps.push({
            step: "47. F16: the initiative Edit footer has no empty span, and Cancel and Save stay right-aligned",
            ok:
                footerMenu.clicked &&
                editFooter.opened === true &&
                editFooter.found === true &&
                editFooter.empty === 0 &&
                !editFooter.tags.includes("SPAN") &&
                Math.abs(editFooter.saveGap) <= 1 &&
                editFooter.cancelBeforeSave &&
                editFooter.cancelRightHalf,
            detail: JSON.stringify({ menu: footerMenu, ...editFooter }),
        });
        await h.ev(`[...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Cancel")?.click()`);
        await actFilter(h, "");

        // 48. an orphaned worker's answer waits in the queue: kind word orphaned, its answer, and Acknowledge
        await actFixture(h, "act");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click()`);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const orphan = await h.ev(`(() => {
            const t = (el) => (el?.innerText || "").replace(/\\s+/g, " ").trim();
            const row = [...document.querySelectorAll('[data-jarvis-brief-row="queue"]')].find((r) => t(r).includes("Parent ended"));
            return {
                summary: t(document.querySelector('[data-jarvis-brief-attention-summary]')?.parentElement),
                row: t(row),
                acts: [...(row?.querySelectorAll("[data-jarvis-queue-act]") ?? [])].map((b) => [b.dataset.jarvisQueueAct, t(b)]),
            };
        })()`);
        await h.shot("cdp-shots/brief-act-48-orphan.png");
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="true"]')?.click()`);
        await actFixture(h, null);
        steps.push({
            step: "48. an orphaned worker's row reads orphaned with its Parent ended answer and one Acknowledge button",
            ok:
                /1 orphaned/.test(orphan.summary) &&
                /^orphaned /.test(orphan.row) &&
                orphan.row.includes("Parent ended · Fixed the login redirect") &&
                JSON.stringify(orphan.acts) === JSON.stringify([["ack-orphan", "Acknowledge"]]),
            detail: JSON.stringify(orphan),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await actRestoreConfig(h).catch(() => {});
        await actRestoreRoster(h).catch(() => {});
        await actRestoreAttention(h).catch(() => {});
        await releaseRpc(h, "AckRunCommand").catch(() => {});
        await releaseRpc(h, "CancelRunCommand").catch(() => {});
        for (const command of ["EffortGetCommand", "EffortMutateCommand", "SetDossierStatusCommand"]) {
            await releaseRpc(h, command).catch(() => {});
        }
        for (const effortoid of [ctx?.stagedoid, ctx?.archivedoid, ctx?.peekoid]) {
            if (effortoid) {
                await h.rpc("effortdelete", { effortoid }).catch((e) => {
                    console.error(`brief-act teardown: delete an initiative failed: ${e?.message ?? e}`);
                });
            }
        }
        await actFilter(h, "").catch(() => {});
        await actFixture(h, null).catch(() => {});
        await h.cdp("Emulation.clearDeviceMetricsOverride").catch(() => {});
        if (ctx?.effortoid) {
            await h.rpc("effortdelete", { effortoid: ctx.effortoid }).catch((e) => {
                console.error(`brief-act teardown: delete the initiative failed: ${e?.message ?? e}`);
            });
        }
        // detached, so the titled record keeps one run ref across passes rather than growing one per pass
        if (ctx?.titled?.cwd != null) {
            await teardownFixtureRun(h, ctx.titled, "brief-act (titled run)", {
                what: "detach the titled run from its record",
                fn: () =>
                    ctx.titled.recordId && ctx.titled.runId
                        ? h.rpc("detachdossieredge", { dossierid: ctx.titled.recordId, runoref: `run:${ctx.titled.runId}` })
                        : null,
            });
        }
        // the channel, its run and the temp dir; it reloads, which also drops the review fixture's swapped roster
        if (ctx?.cwd != null) await teardownFixtureRun(h, ctx, "brief-act");
    },
};
