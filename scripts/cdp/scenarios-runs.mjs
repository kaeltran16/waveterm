// Run scenarios: run sheet, timing, cost, autonomous runs.
// Also the run helpers that the dag, final and plan-review modules share.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pinDefaultView, restoreDefaultView } from "./agent-page-fixtures.mjs";
import { SURFACE_LABEL } from "./attach.mjs";
import {
    ATTN_TICK_SETTLE_MS,
    BS_HANDOFF_ANSWERED,
    BS_PANE,
    BS_POLL_WAIT_MS,
    BS_SPEC,
    BS_SWITCH,
    CANVAS_PANE,
    CANVAS_TABS_WAIT_MS,
    FINAL_SHOTS_UICTX,
    LOOK_LIB,
    MODELS_VIEWPORT,
    NEW_RUN,
    NEW_RUN_FIELD,
    NEW_RUN_GOAL,
    NEW_RUN_LIST,
    OBS_WIDE,
    PALETTE_INPUT,
    PALETTE_STATE,
    PEEKS_ESC,
    PROFILE_MODAL,
    RAIL_VISIBLE_KEY,
    RUN_SHEET,
    RUN_SHEET_POLISH_TASKS,
    TREE_RAIL_FIXTURE,
    UI_ROUTE,
    arrangeSheetDagRun,
    bsPublishStatus,
    bsReveal,
    bsShowPane,
    channelRuns,
    clickByText,
    closeProfile,
    flatText,
    floorStep,
    fstWriteRun,
    lookEval,
    lookPlaceholders,
    lookShot,
    openAddressExpr,
    openPalette,
    openProfileOn,
    paletteKey,
    paletteStateWhen,
    placeholderStep,
    polishNap,
    polishReload,
    polishWaitFor,
    restoreLocalStorage,
    setInputExpr,
    teardownFixtureRun,
    waitForDispatch,
    waitForProjectInConfig,
    waveService,
} from "./scenarios-shared.mjs";

// --- the run view's live-pass fixes (docs/superpowers/specs/2026-11-06-run-view-review-fixes-design.md) --------
// Shared by the F-numbered steps in the scenarios below, each run at the size its finding broke at.
export const RV_WIDE = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
export const RV_MODAL = `document.querySelector("[data-dag-modal-kind]")`;
export const RV_OPEN_DAG = `document.querySelector("[data-run-sheet] [data-run-sheet-open-dag]")`;
const RV_CLOSE = `[...(${RV_MODAL}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Close · Esc")`;
// a card's fact without the separator the card draws before it
export const rvFact = (nodeExpr) =>
    `(${nodeExpr}?.querySelector("[data-dag-node-fact]")?.textContent ?? "").replace(/\\s+/g, " ").replace(/^\\s*·\\s*/, "").trim()`;

// opens the run's sheet, then its DAG from the dock; true once the graph shows a card
export async function rvOpenDag(h, runId) {
    if ((await h.activeSurfaceLabel()) !== SURFACE_LABEL.jarvis) await h.goto("jarvis");
    await h.ev(openAddressExpr(`run:${runId}`));
    const sheet = await polishWaitFor(h, `!!${RV_OPEN_DAG}`, 15000);
    if (sheet) await h.ev(`${RV_OPEN_DAG}.click()`);
    return sheet && (await polishWaitFor(h, `!!${RV_MODAL}?.querySelector("[data-dag-node]")`, 10000));
}

export async function rvCloseDag(h) {
    await h.ev(`${RV_CLOSE}?.click()`);
    return polishWaitFor(h, `!${RV_MODAL}`, 3000);
}

// Page-only: the run's dag in the page takes `fields` (its own top-level fields, such as status or final) and
// `tasks` (fields per task id; an id it lacks is added) at `ahead` versions past
// the one it holds (one by default), and the dag status RPC answers that version with `digest` (fields per task row, added likewise):
// the merge gate's held state and a task's actions are digest fields no RPC writes; `next`, when given, replaces the
// digest's next step (the sheet's next: line). undoPageDag puts the RPC back
// and reloads the stored dag, whose own version brings the real digest back. WOS drops a pushed update whose
// version is not newer, so a large `ahead` keeps the page copy until undoPageDag for a scenario whose run is live
// and still writing its dag.
export const injectPageDag = (h, runId, { tasks = {}, digest = {}, next, fields = {}, ahead = 1 }) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const WOS = await mod("app/store/wos.ts");
        const runId = ${JSON.stringify(runId)};
        const ref = WOS.makeORef("dag", WOS.getObjectValue(WOS.makeORef("run", runId))?.dagoref);
        const dag = WOS.getObjectValue(ref);
        if (!dag) return "no dag in the page";
        const merge = (rows, key, patch) =>
            [...rows, ...Object.keys(patch).filter((id) => !rows.some((r) => r[key] === id)).map((id) => ({ [key]: id }))]
                .map((r) => (patch[r[key]] ? { ...r, ...patch[r[key]] } : r));
        const version = dag.version + ${JSON.stringify(ahead)};
        const saved = (window.__pageDag ??= { orig: RpcApi.DagStatusCommand });
        RpcApi.DagStatusCommand = async (client, data, opts) => {
            const rtn = await saved.orig.call(RpcApi, client, data, opts);
            if (data?.runid !== runId || rtn?.digest == null) return rtn;
            const tasks = merge(rtn.digest.tasks ?? [], "taskid", ${JSON.stringify(digest)});
            return { ...rtn, digest: { ...rtn.digest, dagversion: version, tasks${next ? `, next: ${JSON.stringify(next)}` : ""} } };
        };
        WOS.setObjectValue({ ...dag, ...${JSON.stringify(fields)}, version, tasks: merge(dag.tasks ?? [], "id", ${JSON.stringify(tasks)}) });
        return "ok";`);
export const undoPageDag = (h, runId) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const WOS = await mod("app/store/wos.ts");
        if (window.__pageDag) RpcApi.DagStatusCommand = window.__pageDag.orig;
        delete window.__pageDag;
        await WOS.reloadWaveObject(WOS.makeORef("dag", WOS.getObjectValue(WOS.makeORef("run", ${JSON.stringify(runId)}))?.dagoref));
        return "ok";`);

// The live-run review's phase 3 Hub findings (Q4, Q6, Q8) at 1600: t-1 skipped, t-2 a lane tip held behind t-3's
// Verify, and a page-only t-4 failed with the engine's actions, so the attention list has a chip to read.
async function runSheetPhase3(h, ctx, rec) {
    await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
    await polishNap(500);
    const injected = await injectPageDag(h, ctx.runId, {
        tasks: {
            "t-1": { state: "skipped" },
            "t-2": { state: "done" },
            "t-3": { state: "verifying" },
            "t-4": { label: "noop 4", description: "do nothing", deps: [], state: "failed", lastfailurekind: "exit 1" },
        },
        digest: {
            "t-2": { waitreason: "", mergestate: "held", mergeheldby: "t-3", cleanupstate: "" },
            "t-4": { waitreason: "failure", mergestate: "", cleanupstate: "", humanactions: ["retry", "skip", "escalate"] },
        },
    });
    const read = await lookEval(h, `
        const meta = (id) => flat(document.querySelector('[data-run-sheet-row="' + id + '"]')?.children[1]?.children[1]);
        const chip = () => flat(document.querySelector('[data-run-sheet-attention="t-4"]')?.lastElementChild);
        await until(() => meta("t-1") === "skipped" && chip() !== "" && /^merge ready/.test(meta("t-2")), 8000);
        return {
            skipped: meta("t-1"),
            chip: chip(),
            held: meta("t-2"),
            heldAttention: !!document.querySelector('[data-run-sheet-attention="t-2"]'),
        };`);
    await h.shot("cdp-shots/run-sheet-polish-p3.png");
    await undoPageDag(h, ctx.runId);
    rec("10. Q4: a skipped task's meta reads skipped, naming no actor", injected === "ok" && read.skipped === "skipped", JSON.stringify({ injected, ...read }));
    rec("11. Q8: an attention chip reads its actions as words, retry / skip / escalate", read.chip === "retry / skip / escalate", JSON.stringify(read));
    rec(
        "12. Q6: a held tip has no attention row and its meta reads merge ready · waits on t-3's Verify",
        !read.heldAttention && read.held === "merge ready · waits on t-3's Verify",
        JSON.stringify(read)
    );
}

// The memory gate's hold and pause on the task rows: t-1 pending and t-3 running, each with a digest memory state
// no RPC writes (the engine sets it from the gate's run events), so the rows read them from a page-only digest.
const GIB = 1024 ** 3;
async function runSheetMemory(h, ctx, rec) {
    await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
    await polishNap(500);
    const row = (state, free, need) => ({ waitreason: "", mergestate: "", cleanupstate: "", memory: { state, role: "worker", free, need, ts: Date.now() } });
    const injected = await injectPageDag(h, ctx.runId, {
        tasks: { "t-1": { state: "pending" }, "t-3": { state: "running" } },
        digest: { "t-1": row("waiting", Math.round(2.1 * GIB), Math.round(3.5 * GIB)), "t-3": row("paused", Math.round(1.2 * GIB), 3 * GIB) },
    });
    const read = await lookEval(h, `
        const cell = (id, i) => document.querySelector('[data-run-sheet-row="' + id + '"]')?.children[i];
        const meta = (id) => flat(cell(id, 1)?.children[1]);
        const state = (id) => flat(cell(id, 2)?.firstElementChild);
        await until(() => /^waiting for memory/.test(meta("t-1")) && /^paused: memory/.test(meta("t-3")), 8000);
        return { waiting: meta("t-1"), waitingState: state("t-1"), paused: meta("t-3"), pausedState: state("t-3") };`);
    await h.shot("cdp-shots/run-sheet-polish-memory.png");
    await undoPageDag(h, ctx.runId);
    rec(
        "13. a pending task held at the memory gate reads waiting, meta waiting for memory · 2.1 GB free, 3.5 GB needed",
        injected === "ok" && read.waitingState === "waiting" && read.waiting === "waiting for memory · 2.1 GB free, 3.5 GB needed",
        JSON.stringify({ injected, ...read })
    );
    rec(
        "14. a running task the gate paused reads paused, meta paused: memory · 1.2 GB free, 3.0 GB needed",
        read.pausedState === "paused" && read.paused === "paused: memory · 1.2 GB free, 3.0 GB needed",
        JSON.stringify(read)
    );
}

// A fast-track dag adds a `fast track` chip to the settings line, last before adjust. The flag is a page-only field
// on the dag: the engine sets it at submit, and the fixture's plan is not one it submitted.
async function runSheetFastTrack(h, ctx, rec) {
    await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
    await polishNap(500);
    const injected = await injectPageDag(h, ctx.runId, { fields: { fasttrack: true } });
    const read = await lookEval(h, `
        const cfg = () => document.querySelector('[data-run-sheet] [data-jarvis-brief-sheet-config="editable"]');
        const chip = () => cfg()?.querySelector('[data-jarvis-brief-sheet-fasttrack]');
        await until(() => chip() != null, 8000);
        const kids = [...(cfg()?.children ?? [])];
        const at = kids.indexOf(chip());
        return {
            chip: flat(chip()),
            beforeAdjust: at >= 0 && at === kids.length - 2 && flat(kids[kids.length - 1]) === "adjust",
            afterApprovals: at > 0 && kids[at - 1]?.hasAttribute("data-jarvis-brief-sheet-approvals"),
        };`);
    await h.shot("cdp-shots/run-sheet-polish-fasttrack.png");
    await undoPageDag(h, ctx.runId);
    const gone = await lookEval(h, `
        await until(() => !document.querySelector('[data-run-sheet] [data-jarvis-brief-sheet-fasttrack]'), 8000);
        return !document.querySelector('[data-run-sheet] [data-jarvis-brief-sheet-fasttrack]');`);
    rec(
        "15. a fast-track dag shows fast track as the last item before adjust on the settings line, after the approvals word, and a full-track dag shows none",
        injected === "ok" && read.chip === "fast track" && read.beforeAdjust === true && read.afterApprovals === true && gone === true,
        JSON.stringify({ injected, ...read, gone })
    );
}

export const runSheetPolish = {
    name: "run-sheet-polish",
    surface: "jarvis",
    async arrange(h) {
        const ctx = await arrangeSheetDagRun(h, "run-sheet-polish", RUN_SHEET_POLISH_TASKS);
        if (ctx.arrangeError != null) return ctx;
        try {
            ctx.timelineOpened = await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector('[data-run-sheet] [role="img"]'); i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                for (let i = 0; i < 40; i++) {
                    const toggle = [...document.querySelectorAll("[data-run-sheet] button[aria-expanded]")].find((b) =>
                        (b.textContent || "").trim().startsWith("timeline")
                    );
                    if (toggle) {
                        if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
                        return true;
                    }
                    await new Promise((r) => setTimeout(r, 250));
                }
                return false;
            })()`);
            await new Promise((r) => setTimeout(r, 600));
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec(
            "0. the run's sheet opened on the Brief",
            ctx.arrangeError == null && ctx.opened?.ok === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, opened: ctx.opened })
        );

        steps.push(
            await floorStep(
                h,
                "1. no visible text on the run sheet or its header is under 10.5px",
                RUN_SHEET,
                `document.querySelector("[data-jarvis-brief-sheet] > header")`
            )
        );

        const bar = await h.ev(`document.querySelector("[data-run-sheet] [role=img]")?.getAttribute("aria-label") ?? null`);
        rec(
            "2. the task strip under the verb carries its done/total label",
            typeof bar === "string" && /^\d+ of \d+ tasks done/.test(bar),
            `aria-label=${JSON.stringify(bar)}`
        );

        const timeline = await h.ev(`!!document.querySelector("[data-run-sheet-timeline]")`);
        rec(
            "3. the compact timeline opened from the tasks heading",
            timeline === true,
            JSON.stringify({ toggled: ctx.timelineOpened, timeline })
        );

        // the loading frames: the run's task graph read back to loading, then the channel's
        // the header's "reading the plan" line is a loading state too, with no placeholder in it
        const LOADING = (sheet) =>
            `([...document.querySelectorAll('${sheet} [data-jarvis-brief-sheet-state="loading"]')].find((e) => e.querySelector(".animate-pulse")) ?? null)`;
        const dagOref = `dag:${(await waveService(h, "object", "GetObject", [`run:${ctx.runId}`]))?.dagoref}`;
        await holdObject(h, dagOref);
        const tasks = await lookPlaceholders(h, LOADING("[data-run-sheet]"));
        await h.shot(lookShot("run-sheet-tasks-loading"));
        await releaseObject(h, dagOref);
        steps.push(placeholderStep("4. while the task graph loads, the tasks list holds its first 30px bar", tasks, { height: 30, radius: "8px" }));
        steps.push(placeholderStep("4b. and its second, at 72% width", tasks, { height: 30, radius: "8px", share: 72 }, 1));
        const channelOref = `channel:${ctx.channelId}`;
        await holdObject(h, channelOref);
        const project = await lookPlaceholders(h, LOADING("[data-jarvis-brief-sheet]"));
        await h.shot(lookShot("run-sheet-channel-loading"));
        await releaseObject(h, channelOref);
        steps.push(placeholderStep("5. while the run's channel loads, the sheet holds its 32px Reading this project bar", project, { height: 32, radius: "8px" }));

        // F4: the collapsed heading is the run's title, its report's H1 or else the goal's lead sentence
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
        await polishNap(500);
        const titleWhen = (want) =>
            h.ev(`(async () => {
                let text = "";
                for (let i = 0; i < 20; i++) {
                    text = (document.querySelector('[data-run-sheet] [data-run-sheet-title="title"]')?.innerText ?? "").trim();
                    if (text === ${JSON.stringify(want)}) break;
                    await new Promise((r) => setTimeout(r, 250));
                }
                return text;
            })()`);
        let seeded = null;
        try {
            await seedSheetRun(h, ctx, (r) => ({ ...r, goal: RUN_SHEET_TITLE_GOAL }), (r) => r?.goal === RUN_SHEET_TITLE_GOAL);
        } catch (e) {
            seeded = String(e?.message ?? e);
        }
        const plain = await titleWhen(RUN_SHEET_TITLE_LEAD);
        rec(
            "6. F4: with no report the collapsed heading is the goal's lead sentence, not cut at its ;",
            seeded == null && plain === RUN_SHEET_TITLE_LEAD && !plain.endsWith(";"),
            seeded ?? JSON.stringify({ plain })
        );
        seeded = null;
        try {
            await seedSheetRun(
                h,
                ctx,
                (r) => ({ ...r, evidence: { ...(r.evidence ?? {}), summary: RUN_SHEET_REPORT } }),
                (r) => r?.evidence?.summary === RUN_SHEET_REPORT
            );
        } catch (e) {
            seeded = String(e?.message ?? e);
        }
        const titled = await titleWhen(RUN_SHEET_REPORT_TITLE);
        rec(
            "7. F4: with a report the collapsed heading is the report's H1, its Run report: prefix dropped",
            seeded == null && titled === RUN_SHEET_REPORT_TITLE,
            seeded ?? JSON.stringify({ titled })
        );

        // F7: at 950px the head and dock stay pinned around a scrolling body; under 800px the column scrolls
        // as one and only the composer stays pinned
        const MEASURE = `
            const sheet = document.querySelector("[data-run-sheet]");
            const body = sheet?.querySelector("[data-run-sheet-body]");
            const reading = sheet?.querySelector("[data-run-sheet-reading]");
            const dock = sheet?.querySelector('[data-jarvis-brief-sheet-face="settings"]');
            const composer = sheet?.querySelector("[data-run-sheet-composer]");
            if (!body || !reading || !dock || !composer) return { error: "the sheet's body, reading, dock or composer is missing" };
            const box = (e) => {
                const b = e.getBoundingClientRect();
                return [Math.round(b.top), Math.round(b.bottom)];
            };
            const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            const read = () => ({
                reading: box(reading),
                dock: box(dock),
                composerGap: Math.round(sheet.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom),
            });`;
        const pinned = await h.ev(`(async () => {
            ${MEASURE}
            const before = read();
            body.scrollTop = 300;
            await frame();
            const after = read();
            const scrolled = body.scrollTop;
            body.scrollTop = 0;
            return { before, after, scrolled, sheetScrolls: getComputedStyle(sheet).overflowY, bodyScrolls: getComputedStyle(body).overflowY };
        })()`);
        rec(
            "8. F7: at 1600x950 scrolling the body leaves the Reading head and the dock where they were",
            pinned.error == null &&
                pinned.sheetScrolls === "visible" &&
                pinned.bodyScrolls === "auto" &&
                JSON.stringify(pinned.before.reading) === JSON.stringify(pinned.after.reading) &&
                JSON.stringify(pinned.before.dock) === JSON.stringify(pinned.after.dock),
            JSON.stringify(pinned)
        );

        await h.cdp("Emulation.setDeviceMetricsOverride", RUN_SHEET_SHORT);
        await polishNap(500);
        const short = await h.ev(`(async () => {
            ${MEASURE}
            const before = read();
            sheet.scrollTop = 300;
            await frame();
            const after = read();
            const scrolled = sheet.scrollTop;
            sheet.scrollTop = 0;
            return { height: sheet.clientHeight, scrolls: getComputedStyle(sheet).overflowY, scrolled, before, after };
        })()`);
        rec(
            "9. F7: at 1000x700 the sheet scrolls as one, at least 400px tall: the Reading head scrolls away, the composer stays at its bottom",
            short.error == null &&
                short.height >= 400 &&
                short.scrolls === "auto" &&
                short.after.reading[0] < short.before.reading[0] &&
                Math.abs(short.before.composerGap) <= 2 &&
                Math.abs(short.after.composerGap) <= 2,
            JSON.stringify(short)
        );
        await runSheetPhase3(h, ctx, rec);
        await runSheetMemory(h, ctx, rec);
        await runSheetFastTrack(h, ctx, rec);
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        await undoPageDag(h, ctx.runId).catch((e) => {
            console.error(`run-sheet-polish teardown: undo the page dag failed: ${e?.message ?? e}`);
        });
        await teardownFixtureRun(h, ctx, "run-sheet-polish");
    },
};

const RUN_SHEET_SHORT = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const RUN_SHEET_TITLE_LEAD = "Fix all findings in C:\\a\\report.md (read it by that path; its shots sit beside it).";
const RUN_SHEET_TITLE_GOAL = `${RUN_SHEET_TITLE_LEAD} Then land.\n\nMore detail.`;
const RUN_SHEET_REPORT_TITLE = "Run sheet polish fixture";
const RUN_SHEET_REPORT = `# Run report: ${RUN_SHEET_REPORT_TITLE}\n\nDAG 1: 0/3 tasks done.\n\n## Landed\n- none`;

// writes a live run: an engine write that read the run before this one puts its own copy back, hence the retries
async function seedSheetRun(h, ctx, change, kept) {
    const oref = `run:${ctx.runId}`;
    let stored = null;
    for (let i = 0; i < 3 && !kept(stored); i++) {
        await fstWriteRun(h, ctx.runId, change);
        await polishNap(300);
        stored = await waveService(h, "object", "GetObject", [oref]);
    }
    if (!kept(stored)) throw new Error(`the run did not keep its seed: stored ${JSON.stringify({ goal: stored?.goal, evidence: stored?.evidence })}`);
}

// The run sheet's Timing section (docs/superpowers/plans/2026-10-01-run-timing.md) on a live orchestrator run:
// collapsed with an elapsed header, then expanded to the per-activity bars. Planning is the one activity a
// freshly submitted plan always has; the live overlap sentence depends on dispatch timing, so only the
// always-present note is asserted.
const RUN_TIMING_SECTION = `document.querySelector("[data-run-sheet] [data-run-timing]")`;
const RUN_TIMING_NOTE = "Elapsed since launch. Activities overlap; do not add these rows.";

export const runTimingScenario = {
    name: "run-timing",
    surface: "jarvis",
    async arrange(h) {
        const ctx = await arrangeSheetDagRun(h, "run-timing", RUN_SHEET_POLISH_TASKS);
        if (ctx.arrangeError != null) return ctx;
        try {
            ctx.sectionShown = await h.ev(`(async () => {
                for (let i = 0; i < 60 && !${RUN_TIMING_SECTION}?.querySelector("button[aria-expanded]"); i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                return !!${RUN_TIMING_SECTION};
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec(
            "0. the run's sheet opened on the Brief with a Timing section",
            ctx.arrangeError == null && ctx.opened?.ok === true && ctx.sectionShown === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, opened: ctx.opened, section: ctx.sectionShown })
        );

        const collapsed = await h.ev(`(() => {
            const btn = ${RUN_TIMING_SECTION}?.querySelector("button[aria-expanded]");
            if (!btn) return null;
            const spans = btn.querySelectorAll("span");
            return {
                expanded: btn.getAttribute("aria-expanded"),
                label: spans[0]?.textContent.trim() ?? null,
                header: spans[spans.length - 1]?.textContent.trim() ?? null,
            };
        })()`);
        rec(
            "1. the live run's Timing toggle is collapsed with an elapsed header",
            collapsed?.expanded === "false" && collapsed.label === "Timing" && /elapsed$/.test(collapsed.header ?? ""),
            JSON.stringify(collapsed)
        );

        const expanded = await h.ev(`(async () => {
            const section = ${RUN_TIMING_SECTION};
            const btn = section?.querySelector("button[aria-expanded]");
            if (!btn) return null;
            btn.click();
            for (let i = 0; i < 20 && !section.querySelector('[data-run-timing-row="planning"]'); i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            const row = section.querySelector('[data-run-timing-row="planning"]');
            const bar = row?.querySelector(":scope > div > span");
            const cells = row ? row.querySelectorAll(":scope > span") : [];
            section.scrollIntoView({ block: "start" });
            return {
                expanded: btn.getAttribute("aria-expanded"),
                rows: [...section.querySelectorAll("[data-run-timing-row]")].map((r) => r.getAttribute("data-run-timing-row")),
                barWidth: bar ? bar.getBoundingClientRect().width : null,
                duration: cells.length > 0 ? cells[cells.length - 1].textContent.trim() : null,
                note: (section.innerText || "").includes(${JSON.stringify(RUN_TIMING_NOTE)}),
            };
        })()`);
        rec(
            "2. a click expands it: aria-expanded flips to true",
            expanded?.expanded === "true",
            JSON.stringify({ expanded: expanded?.expanded })
        );
        rec(
            "3. a planning row draws a bar of nonzero width and a duration",
            expanded != null && expanded.rows.includes("planning") && expanded.barWidth > 0 && !!expanded.duration,
            JSON.stringify(expanded)
        );
        rec("4. the always-present overlap note shows", expanded?.note === true, JSON.stringify({ note: expanded?.note }));
        await new Promise((r) => setTimeout(r, 300));
        await h.shot("cdp-shots/run-timing-expanded.png");
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "run-timing");
    },
};

// --- run-cost: the API-equivalent estimate of a run's tokens on the run surfaces ------------------------
// The run sheet, the DAG header, the run peek and the details rail's Task section each price the same usage rows
// (docs/superpowers/specs/2026-10-08-usage-attribution-design.md). The rows are seeded as the run's sealed
// evidence, which RunUsageCommand returns as it stands. A deferred run has no lead, so the rail is reached
// through t-1's dispatched worker.
const RUN_COST_TASK = "t-1";
// At the bundled prices (usagepricing.ts) opus-5-5 is $4 in, $20 out, $0.20 cache read and $5 cache write per
// million tokens; sonnet-5 is $2, $10, $0.20 and $2.50. The lead row prices to $3.10, the worker's to $1.20 and
// the reviewer's to $0.50.
const RUN_COST_USAGE = [
    { role: "lead", model: "claude-opus-5-5", input: 200_000, output: 50_000, cacheread: 4_000_000, cachewrite: 100_000, cachewrite1h: 0, msgs: 40 },
    { role: "worker", taskid: RUN_COST_TASK, model: "claude-sonnet-5-5", input: 100_000, output: 40_000, cacheread: 2_000_000, cachewrite: 80_000, cachewrite1h: 0, msgs: 30 },
    { role: "reviewer", taskid: RUN_COST_TASK, model: "claude-opus-5-5", input: 50_000, output: 10_000, cacheread: 500_000, cachewrite: 0, cachewrite1h: 0, msgs: 8 },
];
const RUN_COST_RUN_USD = "$4.80";
const RUN_COST_TASK_USD = "$1.70";
const RUN_COST_SPEND = new RegExp(`^[\\d.]+[kM]? tok · ≈ \\${RUN_COST_RUN_USD}$`);
const RUN_COST_WAIT_MS = 20_000;
const RUN_COST_RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
const RUN_COST_LIB = `
    const text = (el) => (el?.textContent || "").replace(/\\s+/g, " ").trim();
    const until = async (ok, ms = ${RUN_COST_WAIT_MS}) => {
        for (let waited = 0; waited < ms && !ok(); waited += 250) {
            await new Promise((r) => setTimeout(r, 250));
        }
        return !!ok();
    };
`;

// Writes the rows as the run's evidence and reads them back, again if a write of the engine's landed over them:
// it writes a live run, and one that read the run before this write puts its own copy back.
async function seedRunUsage(h, ctx, usage) {
    const oref = `run:${ctx.runId}`;
    const kept = (run) => JSON.stringify(run?.evidence?.usage ?? null) === JSON.stringify(usage);
    let stored = await waveService(h, "object", "GetObject", [oref]);
    for (let i = 0; i < 3 && !kept(stored); i++) {
        const evidence = { capturedts: Date.now(), hash: "", addtotal: 0, deltotal: 0, runtimems: 0, durationms: 0, usage };
        await waveService(h, "object", "UpdateObject", [{ ...stored, otype: "run", evidence }, false], FINAL_SHOTS_UICTX);
        stored = await waveService(h, "object", "GetObject", [oref]);
    }
    if (!kept(stored)) {
        throw new Error(`the run did not keep its seeded usage: stored ${JSON.stringify(stored?.evidence?.usage ?? null)}`);
    }
}

export const runCost = {
    name: "run-cost",
    surface: "jarvis",
    async arrange(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
        const prevRail = await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`);
        const ctx = await arrangeSheetDagRun(h, "run-cost", RUN_SHEET_POLISH_TASKS);
        ctx.prevRail = prevRail;
        if (ctx.arrangeError != null) return ctx;
        try {
            // the dispatching tick holds the run for as long as the spawn takes and would land over a seed made under it
            await waitForDispatch(h, ctx, RUN_COST_TASK);
            if (!ctx.dispatched) throw new Error(`${RUN_COST_TASK} did not dispatch in ${ctx.dispatchMs}ms`);
            const group = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
            ctx.workerRunId = group?.tasks?.find((t) => t.id === RUN_COST_TASK)?.runid;
            await seedRunUsage(h, ctx, RUN_COST_USAGE);
            // a write the worker's first events started can outlast the seed's own read-back
            await new Promise((r) => setTimeout(r, ATTN_TICK_SETTLE_MS));
            await seedRunUsage(h, ctx, RUN_COST_USAGE);
            // the rail is off by default and persisted; and a run's usage loads when a surface showing it mounts,
            // then once a minute, so the page is reloaded and the run reopened to read the seed
            await h.ev(`localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "true")`);
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
            // the rail under test shows in the Terminal view; the Rendered view has the workspace pane in its place; pinned after the reload, which would drop the pin's saved value
            await pinDefaultView(h, "terminal");
            await h.goto("jarvis");
            ctx.opened = await h.ev(`(async () => {
                for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                if (typeof window.__openAddress !== "function") return { ok: false, why: "no __openAddress hook" };
                return window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)});
            })()`);
            ctx.usageShown = await h.ev(`(async () => {
                ${RUN_COST_LIB}
                return until(() => text(document.querySelector("[data-run-sheet] [data-run-sheet-usage]")).includes("≈"));
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec(
            "0. the run's sheet opened, t-1 dispatched, and the sheet shows the seeded usage",
            ctx.arrangeError == null && ctx.opened?.ok === true && ctx.dispatched === true && ctx.usageShown === true,
            ctx.arrangeError ??
                JSON.stringify({ runId: ctx.runId, worker: ctx.workerRunId, opened: ctx.opened, dispatchMs: ctx.dispatchMs, usageShown: ctx.usageShown })
        );
        if (ctx.arrangeError != null) return steps;

        const sheet = await h.ev(`(() => {
            ${RUN_COST_LIB}
            return text(document.querySelector("[data-run-sheet] [data-run-sheet-usage]"));
        })()`);
        rec(
            `1. the run sheet's meta reads "<n> tok · ≈ ${RUN_COST_RUN_USD}", every seeded row priced`,
            RUN_COST_SPEND.test(sheet),
            JSON.stringify(sheet)
        );
        await h.shot("cdp-shots/run-cost-sheet.png");

        const header = await h.ev(`(async () => {
            ${RUN_COST_LIB}
            const open = [...(document.querySelector("[data-run-sheet]")?.querySelectorAll("button") ?? [])].find(
                (b) => text(b) === "Open DAG"
            );
            if (!open) return { opened: false };
            open.click();
            const line = () => document.querySelector("[data-dag-modal-kind] [data-dag-progress]")?.parentElement ?? null;
            const shown = await until(() => text(line()).includes("≈"));
            return { opened: !!document.querySelector("[data-dag-modal-kind]"), shown, line: text(line()) };
        })()`);
        rec(
            `2. the DAG header's usage text ends "· ≈ ${RUN_COST_RUN_USD}"`,
            header.opened === true && (header.line ?? "").endsWith(`· ≈ ${RUN_COST_RUN_USD}`),
            JSON.stringify(header)
        );
        await h.shot("cdp-shots/run-cost-dag-header.png");
        const modalClosed = await h.ev(`(async () => {
            ${RUN_COST_LIB}
            const close = [...(document.querySelector("[data-dag-modal-kind]")?.querySelectorAll("button") ?? [])].find(
                (b) => text(b).startsWith("Close")
            );
            close?.click();
            return until(() => !document.querySelector("[data-dag-modal-kind]"), 5000);
        })()`);

        const peek = await h.ev(`(async () => {
            ${RUN_COST_LIB}
            if (!(await until(() => typeof window.__peekAddress === "function", 5000))) return { hook: false };
            const result = await window.__peekAddress(${JSON.stringify(`run:${ctx.runId}`)});
            const body = () =>
                document.querySelector('[data-pet-peek-item="run"][data-pet-peek-status="ready"] [data-pet-peek-body]');
            const meta = () => [...(body()?.querySelectorAll("span") ?? [])].map(text).find((t) => / tok · ≈ /.test(t));
            const shown = await until(() => meta() != null);
            return { hook: true, result, shown, meta: meta() ?? null };
        })()`);
        rec(
            `3. the run peek's meta holds "tok · ≈ ${RUN_COST_RUN_USD}"`,
            modalClosed === true && peek.hook === true && RUN_COST_SPEND.test(peek.meta ?? ""),
            JSON.stringify({ modalClosed, ...peek })
        );
        await h.shot("cdp-shots/run-cost-peek.png");
        const peekClosed = await h.ev(`(async () => {
            ${RUN_COST_LIB}
            document.querySelector('[data-pet-peek] button[aria-label="Close Jarvis panel"]')?.click();
            return until(() => !document.querySelector("[data-pet-peek]"), 5000);
        })()`);

        await h.goto("agent");
        // the task's row is titled by its label; the rail is the worker's once its Task section prices the task
        const taskLabel = RUN_SHEET_POLISH_TASKS.find((t) => t.id === RUN_COST_TASK).label;
        const rail = await h.ev(`(async () => {
            ${RUN_COST_LIB}
            const rail = () => ${RUN_COST_RAIL};
            const cost = () => text(rail()?.querySelector("[data-run-cost]"));
            const rows = () =>
                [...(document.querySelector("[data-agent-tree]")?.querySelectorAll("div") ?? [])]
                    .filter((d) => d.children.length === 0 && text(d) === ${JSON.stringify(taskLabel)})
                    .map((d) => d.closest(".cursor-pointer"))
                    .filter((row) => row != null && text(row).includes(${JSON.stringify(RUN_COST_TASK)}));
            if (!(await until(() => rows().length > 0))) return { rows: 0 };
            // another run's ${RUN_COST_TASK} would carry the same label, so a row counts once its rail prices this task
            let selected = false;
            for (const row of rows()) {
                row.click();
                selected = await until(() => cost().includes(${JSON.stringify(RUN_COST_TASK_USD)}), 5000);
                if (selected) break;
            }
            const fact = (label) => {
                const name = [...(rail()?.querySelectorAll("span") ?? [])].find(
                    (s) => s.children.length === 0 && text(s) === label
                );
                return name ? text(name.nextElementSibling) : null;
            };
            return {
                rows: rows().length,
                selected,
                headings: [...(rail()?.querySelectorAll("h3") ?? [])].map(text),
                tokens: fact("Tokens"),
                cost: cost(),
            };
        })()`);
        rec(
            `4. the worker's Task section has a Tokens row with no estimate and a Cost row of ≈ ${RUN_COST_TASK_USD} API-equiv`,
            peekClosed === true &&
                rail.selected === true &&
                rail.headings.includes("Task") &&
                / tok · \d+% cached/.test(rail.tokens ?? "") &&
                !(rail.tokens ?? "").includes("≈") &&
                rail.cost === `≈ ${RUN_COST_TASK_USD} API-equiv`,
            JSON.stringify({ peekClosed, ...rail })
        );
        await h.shot("cdp-shots/run-cost-rail.png");
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "run-cost", {
            what: "restore the rail's visibility and the default view",
            fn: async () => {
                await h.ev(restoreLocalStorage(RAIL_VISIBLE_KEY, ctx.prevRail));
                await restoreDefaultView(h);
            },
        });
    },
};
export const DAG_PEEK_MODAL = `document.querySelector("[data-dag-modal-kind]")`;
export const dagPeekTaskSel = (id) => `[data-dag-task-peek="${id}"]`;
export const DAG_PEEK_FINAL_SEL = "[data-dag-final-peek]";
export const dagPeekCard = (sel) => `${DAG_PEEK_MODAL}?.querySelector(${JSON.stringify(sel)})`;
export const dagPeekClickNode = (id) => `${DAG_PEEK_MODAL}?.querySelector('[data-dag-node="${id}"]')?.click()`;
export const DAG_PEEK_RAIL = `${DAG_PEEK_MODAL}?.querySelector("[data-timeline-rail]")`;
// the rail's history has loaded: a run:event published before that is overwritten by the load
export const DAG_PEEK_RAIL_LIVE = `(${DAG_PEEK_RAIL}?.textContent ?? "").includes("● live")`;
export async function dagPeekOpen(h, sel, nodeId) {
    if (!(await h.ev(`!!${dagPeekCard(sel)}`))) await h.ev(dagPeekClickNode(nodeId));
    return polishWaitFor(h, `!!${dagPeekCard(sel)}`, 4000);
}

export async function dagPeekPublish(h, ctx, events) {
    const now = Date.now();
    for (const [i, [kind, detail, ago]] of events.entries()) {
        const event = {
            id: `dag-peek-${kind}-${i}-${now}`,
            runid: ctx.runId,
            channelid: ctx.channelId,
            ts: now - ago,
            kind,
            detail: JSON.stringify(detail),
        };
        await h.rpc("eventpublish", {
            event: "run:event",
            scopes: [`run:${ctx.runId}`],
            data: { channelid: ctx.channelId, runid: ctx.runId, event },
        });
    }
}

export const FS_VIEWER = `document.querySelector("[data-final-shots-viewer]")`;
export const fstHolds = (fn) => {
    try {
        return fn() === true;
    } catch {
        return false;
    }
};
export const fstSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function fstGitInit(cwd) {
    const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.name", "verify");
    git("config", "user.email", "verify@example.invalid");
    git("config", "commit.gpgsign", "false");
    // the engine's trees live under the project only in the legacy layout, used when there is no user cache dir
    writeFileSync(join(cwd, ".gitignore"), ".waveterm/\n");
    writeFileSync(join(cwd, "README.md"), "final-stage fixture\n");
    git("add", ".");
    git("commit", "-q", "-m", "final-stage fixture");
}

// --- autonomous-runs: the Approvals setting on each of its boards (docs/orchestrator-guide.md, Autonomous runs)
// One project with one orchestrator run held by deferstart. Its lead is a seeded tab, linked as the lead by a tab oref
// on the running phase, whose block runs a stdin sink: the server's switch finds the lead's Plan review question
// there deterministically, and the answer it types lands somewhere harmless. The fixture roster names that tab as the
// lead asking Plan review, which is how the sheet and the palette learn of the question; no live agent runs.
const AUTONOMOUS_PROJECT = "verify-autonomous-runs";
export const AUTONOMOUS_LEAD_ASK = {
    header: "Plan review",
    question: "The plan review failed twice. Proceed with the plan as it stands?",
    options: [{ label: "Accept all and proceed" }, { label: "Request changes" }],
};
const AUTONOMOUS_PROFILE_NOTE =
    "The lead takes the option it would recommend at each of those points and records why in its report. If the final stage still fails after the last round, the land stays held for you.";
export const AUTONOMOUS_RESOLVED =
    "The lead is carrying the plan review's findings into the tasks and going on. It answers everything from here on; each call it makes goes in its report.";
export const AUTONOMOUS_BACK_TO_ASK = "The lead asks you again from its next decision. Calls it already made stand.";
// typing the ON answer takes 60ms a rune, so the question leaves the registry well inside this
export const AUTONOMOUS_ANSWER_WAIT_MS = 20_000;
const SHEET_APPROVALS = `${RUN_SHEET}?.querySelector('[role="group"][aria-label="Approvals"]')`;
const flatOf = (elExpr) => `((${elExpr})?.textContent ?? '').replace(/\\s+/g, ' ').trim()`;

// the Approvals row of the open profile: what is pressed, its source cell and the note under the control
const PROFILE_APPROVALS = `(() => {
    const group = ${PROFILE_MODAL}?.querySelector('[role="group"][aria-label="Approvals"]');
    const row = group?.closest('.grid');
    if (!row) return null;
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    return {
        pressed: [...group.querySelectorAll('button[aria-pressed="true"]')].map(flat),
        source: flat(row.lastElementChild),
        reset: !!row.querySelector('button[aria-label="Reset approvals to global"]'),
        note: flat(group.nextElementSibling),
    };
})()`;

// the run sheet's Approvals: the dial, the line under it, the saved line, the resolved note and the config word
const SHEET_STATE = `(() => {
    const s = ${RUN_SHEET};
    if (!s) return null;
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const group = s.querySelector('[role="group"][aria-label="Approvals"]');
    return {
        pressed: [...(group?.querySelectorAll('button[aria-pressed="true"]') ?? [])].map(flat),
        line: [...(group?.parentElement.querySelectorAll(':scope > span') ?? [])].map(flat).slice(1).join(' '),
        saved: flat(s.querySelector('[data-jarvis-brief-sheet-state="saved"]')),
        error: flat(s.querySelector('[data-jarvis-brief-sheet-state="error"]')),
        resolved: flat(s.querySelector('[data-jarvis-brief-sheet-resolved]')),
        word: flat(s.querySelector('[data-jarvis-brief-sheet-approvals]')),
    };
})()`;

// the lead's own pending question, as the server holds it
export async function autonomousLeadAsk(h, ctx) {
    return (await h.rpc("runasks", { channelid: ctx.channelId, runid: ctx.runId }))?.asks?.[0] ?? null;
}

export async function raiseLeadAsk(h, ctx) {
    await h.rpc("ask", { oref: `block:${ctx.leadBlockId}`, questions: [AUTONOMOUS_LEAD_ASK] });
    ctx.askRaised = true;
}

// the fixture lead's face: asking Plan review, or working once its question is answered
export const patchFixtureLead = (h, ctx, asking) =>
    h.ev(
        `window.__cockpitRosterFixture?.patch(${JSON.stringify(ctx.leadTabId)}, ${
            asking
                ? JSON.stringify({ state: "asking", ask: { questions: [AUTONOMOUS_LEAD_ASK], oref: `block:${ctx.leadBlockId}` } })
                : "{ state: 'working', ask: undefined }"
        })`
    );

// The lead's tab, in the page's own workspace. Its block runs a node process that reads and drops stdin: a shell
// would run the typed answer, and the picker's arrow keys would recall its history first.
export async function seedAutonomousLead(h, ctx) {
    const bootTab = String(await h.ev("window.TabRpcClient.routeId")).replace(/^tab:/, "");
    const wslist = await h.rpc("workspacelist", null);
    const ws = wslist.find((w) => (w.workspacedata?.tabids ?? []).includes(bootTab)) ?? wslist[0];
    ctx.workspaceId = ws.workspacedata.oid;
    ctx.leadTabId = await waveService(h, "workspace", "CreateTab", [ctx.workspaceId, "verify-autonomous-lead", false]);
    const tab = await waveService(h, "object", "GetObject", [`tab:${ctx.leadTabId}`]);
    ctx.leadBlockId = tab?.blockids?.[0];
    if (!ctx.leadBlockId) throw new Error("the lead's tab has no block");
    const sink = join(ctx.cwd, "lead-sink.mjs");
    writeFileSync(sink, "process.stdin.resume();\n");
    // the cwd is ~, not the temp dir, which the process would keep locked past teardown
    await h.rpc("setmeta", {
        oref: `block:${ctx.leadBlockId}`,
        meta: { view: "term", controller: "cmd", cmd: `node '${sink}'`, "cmd:cwd": "~" },
    });
    await h.rpc("controllerresync", { tabid: ctx.leadTabId, blockid: ctx.leadBlockId, forcerestart: true });
    // readLeadState takes the lead from the first tab oref on the run's phases
    await fstWriteRun(h, ctx.runId, (run) => ({
        ...run,
        phases: run.phases.map((p, i) => (i === 0 ? { ...p, workerorefs: [`tab:${ctx.leadTabId}`] } : p)),
    }));
    mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
    writeFileSync(
        TREE_RAIL_FIXTURE,
        JSON.stringify(
            [
                {
                    id: ctx.leadTabId,
                    name: "autonomous lead",
                    project: AUTONOMOUS_PROJECT,
                    task: "verify autonomous-runs",
                    state: "asking",
                    agent: "claude",
                    model: "opus",
                    blockedMs: 60_000,
                    runId: ctx.runId,
                    blockId: ctx.leadBlockId,
                    ask: { questions: [AUTONOMOUS_LEAD_ASK], oref: `block:${ctx.leadBlockId}` },
                },
            ],
            null,
            2
        )
    );
    ctx.wroteFixture = true;
}

// the Run actions of ctx's run, with the toggle row selected
async function openRunToggle(h, ctx, title) {
    if (!(await openPalette(h))) return { opened: false };
    await h.ev(setInputExpr(PALETTE_INPUT, "r:"));
    await paletteStateWhen(h, (s) => s.token === "Runs", 2000);
    await h.ev(setInputExpr(PALETTE_INPUT, ctx.stamp));
    await paletteStateWhen(h, (s) => (s.selected ?? "").includes(ctx.stamp) && s.chip, 8000);
    await h.ev(paletteKey("ArrowRight"));
    let state = await paletteStateWhen(h, (s) => s.drill != null && s.groups.some((g) => g.rows.some((r) => r.startsWith(title))), 8000);
    for (let i = 0; i < 20 && state != null && !(state.selected ?? "").startsWith(title); i++) {
        await h.ev(paletteKey("ArrowDown"));
        state = await h.ev(PALETTE_STATE);
    }
    return { opened: true, state };
}

export const autonomousRuns = {
    name: "autonomous-runs",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-autonomous-runs-"));
        const stamp = `autoruns${Date.now() % 100000}`;
        const ctx = { cwd, stamp };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.rpc("createproject", { name: AUTONOMOUS_PROJECT, path: cwd });
            ctx.project = AUTONOMOUS_PROJECT;
            await waitForProjectInConfig(h, AUTONOMOUS_PROJECT);
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: AUTONOMOUS_PROJECT, projectpath: cwd });
            ctx.channelId = ch.oid;
            // made before the profile turns autonomous, so the run starts on Ask me
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: `verify ${stamp}: do nothing, make no file changes, stop immediately`,
                runtime: "claude",
                mode: "orchestrator",
                // no width, so the run is stored at 0 until submit: the Approvals saves below must leave it there
                deferstart: true,
            });
            ctx.runId = created.run.id;
            ctx.landPath = created.run.landpath;
            await seedAutonomousLead(h, ctx);
            // the fixture roster and the channel list are both read at boot
            await polishReload(h);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. a project, its channel, a planning run and its seeded lead were made", false, ctx.arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await h.goto("jarvis");

        // --- profile (Main board)
        const opened = await openProfileOn(h, AUTONOMOUS_PROJECT);
        await h.ev(clickByText(`${PROFILE_MODAL}?.querySelector('[role="group"][aria-label="Approvals"]')`, "button", "Autonomous"));
        await polishNap(200);
        await h.ev(clickByText(`${PROFILE_MODAL}?.querySelector('footer')`, "button", "Save profile"));
        const savedClosed = await polishWaitFor(h, `!${PROFILE_MODAL}`, 5000);
        const override = (await h.rpc("getjarvisprofile", { channelid: ctx.channelId }))?.override ?? {};
        ctx.profileSaved = override.autonomous === true;
        const reopened = await openProfileOn(h, AUTONOMOUS_PROJECT);
        const projectRow = await h.ev(PROFILE_APPROVALS);
        await h.shot("cdp-shots/autonomous-runs-1-profile.png");
        await h.ev(`${PROFILE_MODAL}?.querySelector('button[aria-label="Reset approvals to global"]')?.click()`);
        await polishNap(300);
        const resetRow = await h.ev(PROFILE_APPROVALS);
        // Cancel, not Save: the new-run step reads the saved Autonomous
        await closeProfile(h);
        rec(
            "profile 1. picking Autonomous and saving stores it on the project, and the row reads Project with Reset and the autonomous note",
            opened &&
                savedClosed &&
                ctx.profileSaved &&
                reopened &&
                projectRow?.pressed.join(",") === "Autonomous" &&
                projectRow.source.startsWith("Project") &&
                projectRow.reset === true &&
                projectRow.note === AUTONOMOUS_PROFILE_NOTE,
            JSON.stringify({ opened, savedClosed, override, reopened, row: projectRow })
        );
        rec(
            "profile 2. Reset puts the row back on Global",
            resetRow?.source === "Global" && resetRow.reset === false,
            JSON.stringify(resetRow)
        );

        // --- new-run (NewRun board)
        await h.ev(`document.querySelector('[data-new-run]')?.click()`);
        const windowOpen = await polishWaitFor(h, `!!${NEW_RUN}`, 5000);
        await h.ev(`${NEW_RUN_FIELD}?.click()`);
        await polishWaitFor(h, `!!${NEW_RUN_LIST}`, 3000);
        await h.ev(setInputExpr(`${NEW_RUN}?.querySelector('input[aria-label="Search projects"]')`, AUTONOMOUS_PROJECT));
        await polishNap(300);
        await h.ev(`${NEW_RUN_LIST}?.querySelector('[data-project-option="${AUTONOMOUS_PROJECT}"]')?.click()`);
        await polishNap(300);
        await h.ev(
            `[...(${NEW_RUN}?.querySelectorAll('button[aria-pressed]') ?? [])].find((b) => b.firstElementChild?.textContent.trim() === 'orchestrator')?.click()`
        );
        await polishNap(200);
        await h.ev(clickByText(`${NEW_RUN}?.querySelector('[role="group"][aria-label="Start from"]')`, "button", "Goal"));
        await h.ev(`(() => {
            const el = ${NEW_RUN_GOAL};
            if (!el) return false;
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(`verify ${ctx.stamp}: do nothing`)});
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        const NEW_RUN_APPROVALS = `${NEW_RUN}?.querySelector('[role="group"][aria-label="Approvals"]')`;
        await polishWaitFor(h, `${NEW_RUN_APPROVALS}?.querySelector('button[aria-pressed="true"]')?.textContent.trim() === 'Autonomous'`, 5000);
        const NEW_RUN_FOOTER = `${NEW_RUN}?.querySelector('[data-new-run-footer] > span')`;
        await polishWaitFor(h, `${flatOf(NEW_RUN_FOOTER)}.endsWith(' · autonomous')`, 3000);
        const orch = await h.ev(`(() => {
            const group = ${NEW_RUN_APPROVALS};
            const models = [...(${NEW_RUN}?.querySelectorAll('span') ?? [])].find((s) => s.textContent.trim() === 'Models')?.parentElement;
            return {
                pressed: [...(group?.querySelectorAll('button[aria-pressed="true"]') ?? [])].map((b) => b.textContent.trim()),
                underModels: models != null && group != null && !!models.nextElementSibling?.contains(group),
                footer: ${flatOf(NEW_RUN_FOOTER)},
            };
        })()`);
        await h.shot("cdp-shots/autonomous-runs-2-new-run.png");
        rec(
            "new-run 1. on orchestrator the Approvals field sits under Models with the profile's Autonomous selected, and the footer ends · autonomous",
            windowOpen && orch.pressed.join(",") === "Autonomous" && orch.underModels && orch.footer.endsWith(" · autonomous"),
            JSON.stringify({ windowOpen, ...orch })
        );
        await h.ev(
            `[...(${NEW_RUN}?.querySelectorAll('button[aria-pressed]') ?? [])].find((b) => b.firstElementChild?.textContent.trim() === 'quick')?.click()`
        );
        const gone = await polishWaitFor(h, `!${NEW_RUN_APPROVALS}`, 3000);
        const quickFooter = await h.ev(flatOf(NEW_RUN_FOOTER));
        rec(
            "new-run 2. on quick the Approvals field is gone, and so is the footer's autonomous",
            gone && quickFooter.startsWith("quick") && !quickFooter.endsWith(" · autonomous"),
            JSON.stringify({ gone, footer: quickFooter })
        );
        await h.ev(`${NEW_RUN}?.querySelector('[data-new-run-cancel]')?.click()`);
        await polishWaitFor(h, `!${NEW_RUN}`, 3000);

        // --- run-sheet (RunSheet board)
        await raiseLeadAsk(h, ctx);
        const askBefore = await autonomousLeadAsk(h, ctx);
        const sheetOpen = await h.ev(`(async () => {
            for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            return window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)});
        })()`);
        await polishWaitFor(h, `!!${RUN_SHEET}?.querySelector('[data-jarvis-brief-sheet-approvals]')`, 8000);
        await h.ev(clickByText(`${RUN_SHEET}?.querySelector('[data-jarvis-brief-sheet-config="editable"]')`, "button", "adjust"));
        await polishWaitFor(h, `!!${SHEET_APPROVALS}`, 3000);
        await h.ev(clickByText(SHEET_APPROVALS, "button", "Autonomous"));
        await polishNap(200);
        const warned = await h.ev(SHEET_STATE);
        rec(
            "run-sheet 1. picking Autonomous while the lead waits on Plan review warns that saving hands it back",
            askBefore?.questions?.[0]?.header === "Plan review" &&
                warned?.pressed.join(",") === "Autonomous" &&
                warned.line === "Saving hands the waiting Plan review back to the lead, and it answers everything from then on.",
            JSON.stringify({ opened: sheetOpen, ask: askBefore?.questions?.[0]?.header ?? null, ...warned })
        );

        await h.ev(clickByText(RUN_SHEET, "button", "Save settings"));
        await polishWaitFor(h, `${flatOf(`${RUN_SHEET}?.querySelector('[data-jarvis-brief-sheet-state="saved"]')`)} === 'Saved. The run is autonomous from now on.'`, 8000);
        const on = await h.ev(SHEET_STATE);
        rec(
            "run-sheet 2. Save: the saved line, the Plan review note that the lead decided, and the config reading autonomous",
            on?.saved === "Saved. The run is autonomous from now on." &&
                on.resolved.startsWith("Plan review: the lead decided") &&
                on.resolved.endsWith(AUTONOMOUS_RESOLVED) &&
                on.word === "autonomous",
            JSON.stringify(on)
        );
        // the answer is typed in the background, and the server takes the question out of its registry as it starts
        let askAfter = askBefore;
        for (const until = Date.now() + AUTONOMOUS_ANSWER_WAIT_MS; askAfter != null && Date.now() < until; ) {
            await polishNap(500);
            askAfter = await autonomousLeadAsk(h, ctx);
        }
        const runOn = (await channelRuns(h, ctx.channelId)).find((r) => r.id === ctx.runId);
        rec(
            "run-sheet 3. the lead's Plan review is answered, and the run is stored autonomous with its width still 0",
            askBefore != null && askAfter == null && runOn?.autonomous === true && (runOn?.parallelism ?? 0) === 0,
            JSON.stringify({
                pending: askAfter?.questions?.[0]?.header ?? null,
                autonomous: runOn?.autonomous ?? null,
                parallelism: runOn?.parallelism ?? null,
            })
        );
        // the lead has its answer, so it is working again
        await patchFixtureLead(h, ctx, false);
        await polishNap(300);
        await h.shot("cdp-shots/autonomous-runs-3-run-sheet.png");

        await h.ev(clickByText(SHEET_APPROVALS, "button", "Ask me"));
        await polishNap(200);
        const backToAsk = await h.ev(SHEET_STATE);
        await h.ev(clickByText(RUN_SHEET, "button", "Save settings"));
        await polishWaitFor(h, `${flatOf(`${RUN_SHEET}?.querySelector('[data-jarvis-brief-sheet-state="saved"]')`)} === 'Saved. The lead asks you from its next decision.'`, 8000);
        const off = await h.ev(SHEET_STATE);
        rec(
            "run-sheet 4. picking Ask me says the lead asks again and hides the saved line, and Save reads asks you",
            backToAsk?.pressed.join(",") === "Ask me" &&
                backToAsk.line === AUTONOMOUS_BACK_TO_ASK &&
                backToAsk.saved === "" &&
                off?.saved === "Saved. The lead asks you from its next decision." &&
                off.word === "asks you",
            JSON.stringify({ backToAsk, off })
        );

        // --- palette (RunActions board): the lead asks Plan review again, now that it asks the human
        await raiseLeadAsk(h, ctx);
        await patchFixtureLead(h, ctx, true);
        const offToggle = await openRunToggle(h, ctx, "Go autonomous");
        const offState = offToggle.state;
        await h.shot("cdp-shots/autonomous-runs-4-palette.png");
        const steer = offState?.groups.find((g) => g.label === "Steer");
        rec(
            "palette 1. the Steer group's toggle reads Go autonomous, asks you, Enter Go, and the off echo",
            offToggle.opened &&
                (steer?.rows ?? []).some((r) => r.startsWith("Go autonomous")) &&
                (offState.selected ?? "").startsWith("Go autonomousasks you") &&
                (offState.selected ?? "").includes("Go ⏎") &&
                offState.text.includes("The lead answers everything from now on, starting with the Plan review it is waiting on."),
            JSON.stringify({ opened: offToggle.opened, selected: offState?.selected, steer, footer: offState?.text.slice(-200) })
        );

        await h.ev(paletteKey("Enter"));
        let runAuto = null;
        let runWidth = null;
        for (let i = 0; i < 20 && runAuto !== true; i++) {
            await polishNap(250);
            const r = (await channelRuns(h, ctx.channelId)).find((r) => r.id === ctx.runId);
            runAuto = r?.autonomous ?? null;
            runWidth = r?.parallelism ?? 0;
        }
        const onToggle = await openRunToggle(h, ctx, "Ask me again");
        const onState = onToggle.state;
        await h.shot("cdp-shots/autonomous-runs-5-palette-on.png");
        rec(
            "palette 2. Enter turns the run autonomous with its width still 0, and its actions then read Ask me again, autonomous, Enter Ask me, and the on echo",
            runAuto === true &&
                runWidth === 0 &&
                onToggle.opened &&
                (onState?.selected ?? "").startsWith("Ask me againautonomous") &&
                (onState.selected ?? "").includes("Ask me ⏎") &&
                onState.text.includes(AUTONOMOUS_BACK_TO_ASK),
            JSON.stringify({ autonomous: runAuto, parallelism: runWidth, selected: onState?.selected, footer: onState?.text.slice(-200) })
        );
        await h.ev(PEEKS_ESC);
        return steps;
    },
    async teardown(h, ctx) {
        const undo = [
            ["close the palette", () => h.ev(PEEKS_ESC)],
            ["clear the lead's question", () => ctx.askRaised && h.rpc("agentaskclear", `block:${ctx.leadBlockId}`)],
        ];
        for (const [what, fn] of undo) {
            try {
                await fn();
            } catch (e) {
                console.error(`autonomous-runs teardown: ${what} failed: ${e?.message ?? e}`);
            }
        }
        // the lead's tab is a worker oref on the run, so this deletes its block and the tab with it; the channel
        // holds the profile override
        await teardownFixtureRun(h, ctx, "autonomous-runs", {
            what: "delete the project",
            fn: () => (ctx.project ? h.rpc("deleteproject", { name: ctx.project }) : null),
        });
    },
};

// --- run-sheet-designing: a run waiting on its design session (docs/superpowers/specs/2026-10-27-lead-plans-from-approved-design-design.md)
// Three real Design first runs, each with the session the server starts for it: step 3 closes one mock-up session's
// tab, so Build this… needs a second. The sessions are made roster agents by a published status, as the brainstorm
// scenarios make theirs, so the sheet's link does not wait on the agent's hooks. Approve and Build this… run the real
// attach, which starts a lead; the pane's prompts go to a recorder that sends nothing.
const RSD_PROJECT = "verify-run-sheet-designing";
const RSD_GOAL = "verify run-sheet-designing: ask nothing, make no changes, stop";
const RSD_TOPIC = "verify-run-sheet-designing";
// Design first spawns the session before CreateRun returns, and the route may resolve against a cold catalog
const RSD_CREATE_RPC = { timeout: 120_000 };
const RSD_SHEET_WAIT_MS = 15_000;
// the attach starts the lead before it replies
const RSD_ATTACH_WAIT_MS = 120_000;
const RSD_STATE = "__runSheetDesigning";
const RSD_INSTALL = `
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    const s = (window.${RSD_STATE} ??= { prompts: [] });
    if (!Object.prototype.hasOwnProperty.call(RpcApi, "AgentPromptCommand")) {
        RpcApi.AgentPromptCommand = (client, data) => {
            s.prompts.push({ block: data?.blockid, text: data?.text });
            return Promise.resolve();
        };
    }
    return true;
`;
// the own property shadows the class's method, so deleting it puts the app's back
const RSD_RESTORE = `
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    if (Object.prototype.hasOwnProperty.call(RpcApi, "AgentPromptCommand")) delete RpcApi.AgentPromptCommand;
    delete window.${RSD_STATE};
    return true;
`;
const RSD_PROMPTS = `(window.${RSD_STATE}?.prompts ?? [])`;
const RSD_SHEET = `(() => {
    const root = document.querySelector("[data-run-sheet]");
    const verb = root?.querySelector("[data-run-sheet-verb]");
    return {
        verb: verb?.textContent.trim() ?? null,
        sub: verb?.nextElementSibling?.textContent.trim() ?? null,
        link: !!root?.querySelector("[data-run-sheet-design-link]"),
    };
})()`;
const rsdTermShown = (tabId) =>
    `(() => { const t = document.querySelector('[data-agent-terminal="${tabId}"]'); return !!t && !t.classList.contains("hidden"); })()`;
const RSD_BOARD = "Main.dc.html";
// the session's own row, since the other sessions' rows can carry a canvas tag too
const rsdCanvasTag = (tabId) =>
    `[...(document.querySelector('[data-tree-agent="${tabId}"]')?.querySelectorAll("button[aria-pressed]") ?? [])].find((b) => (b.textContent || "").trim().startsWith("canvas"))`;
const RSD_BUILD_BTN = `[...(${CANVAS_PANE}?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").trim() === "Build this…")`;
const rsdActiveRun = (channelId) => `(async () => { ${LOOK_LIB}
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const { activeRunIdAtom } = await mod("app/view/jarvis/jarvissubjectstore.ts");
    return globalStore.get(activeRunIdAtom)[${JSON.stringify(channelId)}] ?? null;
})()`;

// opens run's sheet on the Jarvis surface and reads it until ok holds; the last read either way
async function rsdSheet(h, runId, ok) {
    if ((await h.activeSurfaceLabel()) !== SURFACE_LABEL.jarvis) await h.goto("jarvis");
    await polishWaitFor(h, `typeof window.__openAddress === "function"`, 5000);
    await h.ev(`window.__openAddress(${JSON.stringify(`run:${runId}`)})`);
    let s = null;
    for (const start = Date.now(); Date.now() - start < RSD_SHEET_WAIT_MS; await polishNap(250)) {
        s = await h.ev(RSD_SHEET).catch(() => null);
        if (s != null && ok(s)) return { ...s, ok: true };
    }
    return { ...s, ok: false };
}

const rsdRun = async (h, ctx, runId) => (await channelRuns(h, ctx.channelId)).find((r) => r.id === runId) ?? null;

// a Design first run and the session it waits on: the session's block, its tab, and the run's workspace
async function rsdCreate(h, ctx, workspaceId, kind) {
    const created = await h.rpc(
        "createrun",
        { channelid: ctx.channelId, workspaceid: workspaceId, goal: RSD_GOAL, runtime: "claude", mode: "orchestrator", designfirst: kind },
        RSD_CREATE_RPC
    );
    const runId = created?.run?.id;
    if (!runId) throw new Error(`createrun (${kind}) returned no run`);
    const blockId = (await rsdRun(h, ctx, runId))?.design?.blockid;
    if (!blockId) throw new Error(`the ${kind} run waits on no design session`);
    const block = await waveService(h, "object", "GetObject", [`block:${blockId}`]);
    const tabId = String(block?.parentoref ?? "").replace(/^tab:/, "");
    if (!tabId) throw new Error(`the ${kind} session's block ${blockId} has no tab`);
    await bsPublishStatus(h, { blockId, cwd: ctx.cwd });
    return { runId, blockId, tabId, workspaceId };
}

export const runSheetDesigning = {
    name: "run-sheet-designing",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-run-sheet-designing-"));
        const ctx = { cwd, spec: join(cwd, ...BS_SPEC.split("/")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            mkdirSync(dirname(ctx.spec), { recursive: true });
            writeFileSync(ctx.spec, "# Consumer lag alerts\n\nverify run-sheet-designing: the approved spec.\n");
            // an orchestrator's lead works in an engine tree, cut from the project's history
            fstGitInit(cwd);
            await h.rpc("createproject", { name: RSD_PROJECT, path: cwd });
            ctx.project = RSD_PROJECT;
            await waitForProjectInConfig(h, RSD_PROJECT);
            const ch = await h.rpc("createchannel", { name: RSD_PROJECT, projectpath: cwd });
            ctx.channelId = ch.oid;
            const workspaceId = (await h.rpc("workspacelist", null))[0].workspacedata.oid;
            ctx.brainstorm = await rsdCreate(h, ctx, workspaceId, "brainstorm");
            ctx.canvas = await rsdCreate(h, ctx, workspaceId, "canvas");
            ctx.build = await rsdCreate(h, ctx, workspaceId, "canvas");
            await polishReload(h);
            ctx.installed = await lookEval(h, RSD_INSTALL);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        if (ctx.arrangeError != null || ctx.installed !== true) {
            rec("0. the project, three Design first runs, their sessions and the prompt recorder were made", false, ctx.arrangeError ?? "no recorder");
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        const { brainstorm, canvas, build } = ctx;

        const s1 = await rsdSheet(h, brainstorm.runId, (s) => s.verb === "Designing" && s.sub === "brainstorming with you" && s.link);
        await h.shot("cdp-shots/run-sheet-designing-1-brainstorm.png");
        rec("1. the brainstorm run's sheet reads Designing with the brainstorm sub", s1.ok, s1);

        await h.ev(`document.querySelector("[data-run-sheet] [data-run-sheet-design-link]")?.click()`);
        const shown = await polishWaitFor(h, rsdTermShown(brainstorm.tabId), RSD_SHEET_WAIT_MS);
        const surface = await h.activeSurfaceLabel();
        await h.shot("cdp-shots/run-sheet-designing-2-open-session.png");
        rec("2. Open session shows the session's tab on the Agent surface", s1.ok && shown && surface === SURFACE_LABEL.agent, {
            surface,
            sessionTab: brainstorm.tabId,
            shown,
        });

        const s3 = await rsdSheet(h, canvas.runId, (s) => s.verb === "Designing" && s.sub === "mocking it up with you" && s.link);
        await waveService(h, "workspace", "CloseTab", [canvas.workspaceId, canvas.tabId, false]);
        ctx.canvasClosed = true;
        const s3b = await rsdSheet(h, canvas.runId, (s) => s.verb === "Designing" && s.sub === "the design session's tab is closed" && !s.link);
        await h.shot("cdp-shots/run-sheet-designing-3-closed.png");
        rec(
            "3. the canvas run reads mocking it up with you; with its session tab deleted it reads the closed sub and has no Open session link",
            s3.ok && s3b.ok,
            { open: s3, closed: s3b }
        );

        // the session's brainstorm, approvable and naming the spec, shown in its pane on the Agent surface
        const file = join(ctx.cwd, ".superpowers", "brainstorm", RSD_TOPIC, "brainstorm.json");
        mkdirSync(dirname(file), { recursive: true });
        const { canvas: _board, ...approvable } = BS_HANDOFF_ANSWERED;
        writeFileSync(file, JSON.stringify(approvable, null, 2));
        const session = { blockId: brainstorm.blockId, cwd: ctx.cwd };
        let paneError = null;
        try {
            await bsPublishStatus(h, session);
            await bsReveal(h, session, RSD_TOPIC);
            await h.goto("agent");
            await h.ev(`window.__openAddress(${JSON.stringify(`agent:${brainstorm.tabId}`)})`);
            if (!(await polishWaitFor(h, `!!${BS_SWITCH}`, BS_POLL_WAIT_MS))) throw new Error("the reveal drew no brainstorm switcher");
            if (!(await bsShowPane(h))) throw new Error("the Brainstorm segment drew no pane");
        } catch (e) {
            paneError = String(e?.message ?? e);
        }
        const approve = `${BS_PANE}?.querySelector("[data-brainstorm-approve]")`;
        const enabled = paneError == null && (await polishWaitFor(h, `${approve}?.disabled === false`, BS_POLL_WAIT_MS));
        if (enabled) await h.ev(`${approve}.click()`);
        const runLine = `brainstorm: run ${brainstorm.runId}`;
        const told = enabled && (await polishWaitFor(h, `${RSD_PROMPTS}.some((p) => p.text === ${JSON.stringify(runLine)})`, RSD_ATTACH_WAIT_MS));
        const launcher = await h.ev(`!!${NEW_RUN}`);
        const paneSays = await h.ev(flatText(`${BS_PANE}?.querySelector("[data-brainstorm-approve-bar]")`)).catch(() => "");
        await h.shot("cdp-shots/run-sheet-designing-4-approved.png");
        const prompts = await h.ev(RSD_PROMPTS);
        const after = await rsdRun(h, ctx, brainstorm.runId);
        const s4 = await rsdSheet(h, brainstorm.runId, (s) => s.verb != null && s.verb !== "Designing");
        rec(
            "4. Approve in the brainstorm session's pane attaches: no New run window opens, the run leaves Designing, and the pane sends brainstorm: run <id>",
            told &&
                !launcher &&
                JSON.stringify(prompts) ===
                    JSON.stringify([
                        { block: brainstorm.blockId, text: "brainstorm: approved" },
                        { block: brainstorm.blockId, text: runLine },
                    ]) &&
                after?.design == null &&
                after?.designsession === brainstorm.blockId &&
                after?.spec === ctx.spec &&
                s4.ok,
            {
                paneError,
                enabled,
                told,
                launcher,
                prompts,
                paneSays: paneSays.slice(0, 200),
                run: after && { status: after.status, design: after.design, designsession: after.designsession, spec: after.spec },
                sheet: s4,
            }
        );

        // the second mock-up session's board, shown in its canvas pane on the Agent surface; Build this… hands the
        // board to the run, and the run's channel opens on it without a hand-made open
        const boardDir = join(ctx.cwd, ".superpowers", "design", RSD_TOPIC, "project");
        const board = join(boardDir, RSD_BOARD);
        mkdirSync(boardDir, { recursive: true });
        writeFileSync(join(boardDir, "canvas.json"), JSON.stringify({ boards: { [RSD_BOARD]: { w: 1440 } }, order: [RSD_BOARD] }));
        writeFileSync(board, "<!doctype html><title>verify run-sheet-designing</title><p>verify run-sheet-designing: the mock-up</p>");
        let canvasError = null;
        try {
            await bsPublishStatus(h, { blockId: build.blockId, cwd: ctx.cwd });
            await h.rpc("uireveal", { address: `canvas:${RSD_TOPIC}`, callerblockid: build.blockId, callercwd: ctx.cwd }, UI_ROUTE);
            await h.goto("agent");
            await h.ev(`window.__openAddress(${JSON.stringify(`agent:${build.tabId}`)})`);
            const tag = rsdCanvasTag(build.tabId);
            if (!(await polishWaitFor(h, `!!${tag}`, BS_POLL_WAIT_MS))) throw new Error("the reveal drew no canvas tag on the session's row");
            await h.ev(`${tag}.click()`);
            if (!(await polishWaitFor(h, `!!${RSD_BUILD_BTN}`, CANVAS_TABS_WAIT_MS))) throw new Error("the canvas pane drew no Build this…");
        } catch (e) {
            canvasError = String(e?.message ?? e);
        }
        const before = await h.ev(rsdActiveRun(ctx.channelId)).catch(() => null);
        if (canvasError == null) await h.ev(`${RSD_BUILD_BTN}.click()`);
        // the attach starts the lead before it replies, and only its reply opens the channel
        const opened =
            canvasError == null &&
            (await polishWaitFor(h, `(async () => (await ${rsdActiveRun(ctx.channelId)}) === ${JSON.stringify(build.runId)})()`, RSD_ATTACH_WAIT_MS));
        const surface5 = await h.activeSurfaceLabel();
        const launcher5 = await h.ev(`!!${NEW_RUN}`);
        const left = opened && (await polishWaitFor(h, `(() => { const s = ${RSD_SHEET}; return s.verb != null && s.verb !== "Designing"; })()`, RSD_SHEET_WAIT_MS));
        const sheet5 = await h.ev(RSD_SHEET).catch(() => null);
        await h.shot("cdp-shots/run-sheet-designing-5-build-this.png");
        const built = await rsdRun(h, ctx, build.runId);
        rec(
            "5. Build this… in the mock-up session's canvas pane attaches: no New run window opens, the run leaves Designing with the board as its prototype, and its channel opens",
            opened &&
                surface5 === SURFACE_LABEL.jarvis &&
                !launcher5 &&
                left &&
                built?.design == null &&
                built?.designsession === build.blockId &&
                built?.prototype === board,
            {
                canvasError,
                before,
                opened,
                surface: surface5,
                launcher: launcher5,
                sheet: sheet5,
                board,
                run: built && { status: built.status, design: built.design, designsession: built.designsession, prototype: built.prototype },
            }
        );
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`run-sheet-designing teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("close the New run window", () => h.ev(`${NEW_RUN} ? (${PEEKS_ESC}, true) : false`));
        await step("restore AgentPromptCommand", () => lookEval(h, RSD_RESTORE));
        // a cancel leaves a design session's tab alone, and the lead's is one of the run's workers
        ctx.runId = ctx.brainstorm?.runId;
        await teardownFixtureRun(h, ctx, "run-sheet-designing", {
            what: "cancel the canvas runs, close the session tabs and delete the project",
            fn: async () => {
                if (ctx.canvas) await step("cancel the canvas run", () => h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.canvas.runId }));
                // Build this… started this run's lead
                if (ctx.build) await step("cancel the built run", () => h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.build.runId }));
                for (const s of [ctx.brainstorm, ctx.canvasClosed ? null : ctx.canvas, ctx.build]) {
                    if (s) await step(`close session tab ${s.tabId}`, () => waveService(h, "workspace", "CloseTab", [s.workspaceId, s.tabId, false]));
                }
                if (ctx.project) await step("delete the project", () => h.rpc("deleteproject", { name: ctx.project }));
            },
        });
    },
};
// value undefined holds the object loading; a value (a page expression, which may read `current`) shows that copy
// of it instead. A live object is pushed again on each change, so the hold is put back after every push.
const holdObject = (h, oref, value) =>
    lookEval(h, `
        const WOS = await mod("app/store/wos.ts");
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const wov = WOS.getWaveObjectValue(${JSON.stringify(oref)});
        const current = globalStore.get(wov.dataAtom).value;
        const held = ${value === undefined ? `{ value: null, loading: true, error: false }` : `{ value: ${value}, loading: false, error: false }`};
        wov.pendingPromise = new Promise(() => {});
        globalStore.set(wov.dataAtom, held);
        (window.__heldObject ??= {})[${JSON.stringify(oref)}] = globalStore.sub(wov.dataAtom, () => {
            if (globalStore.get(wov.dataAtom) !== held) globalStore.set(wov.dataAtom, held);
        });
    `);
const releaseObject = (h, oref) =>
    lookEval(h, `
        const WOS = await mod("app/store/wos.ts");
        window.__heldObject?.[${JSON.stringify(oref)}]?.();
        delete window.__heldObject?.[${JSON.stringify(oref)}];
        WOS.getWaveObjectValue(${JSON.stringify(oref)}).pendingPromise = null;
        await WOS.reloadWaveObject(${JSON.stringify(oref)});
    `);

