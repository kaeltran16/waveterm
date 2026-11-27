// DAG scenarios: the run's task graph lifecycle, observability, peek and motion.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    OBS_NARROW,
    OBS_WIDE,
    RUN_SHEET_POLISH_TASKS,
    arrangeSheetDagRun,
    channelRuns,
    clickByText,
    deleteChannelWorkerBlocks,
    flatText,
    floorDetail,
    floorOk,
    fstWriteRun,
    lookEval,
    lookShot,
    openAddressExpr,
    paintEval,
    polishNap,
    polishReload,
    polishWaitFor,
    seedDag,
    teardownFixtureRun,
    waitForDispatch,
} from "./scenarios-shared.mjs";
import {
    RV_WIDE,
    RV_MODAL,
    RV_OPEN_DAG,
    rvFact,
    rvOpenDag,
    rvCloseDag,
    injectPageDag,
    undoPageDag,
    DAG_PEEK_MODAL,
    dagPeekTaskSel,
    DAG_PEEK_FINAL_SEL,
    dagPeekCard,
    dagPeekClickNode,
    DAG_PEEK_RAIL,
    DAG_PEEK_RAIL_LIVE,
    dagPeekOpen,
    dagPeekPublish,
    FS_VIEWER,
    fstHolds,
    fstSame,
} from "./scenarios-runs.mjs";

const workerOf = (phase) => phase && phase.workerorefs && phase.workerorefs[0];

const RV_SHORT = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const RV_RAIL = `${RV_MODAL}?.querySelector("[data-timeline-rail]")`;
// the graph's selection: aria-pressed mirrors a card's selected border
const RV_PRESSED = `[...(${RV_MODAL}?.querySelectorAll("[data-dag-node][aria-pressed='true']") ?? [])].map((n) => n.getAttribute("data-dag-node"))`;
const RV_COUNT = `parseInt(${RV_RAIL}?.querySelector("[data-timeline-count]")?.textContent ?? "", 10)`;
const rvFilterCount = (id) =>
    `parseInt(${RV_RAIL}?.querySelector('[data-timeline-filter-count="${id}"]')?.textContent ?? "", 10)`;
// published run:events stand in for the engine's until the page's next reload; each is { kind, detail, ts }
async function rvPublish(h, ctx, tag, events) {
    for (const [i, e] of events.entries()) {
        const event = {
            id: `${tag}-${i}-${e.ts}`,
            runid: ctx.runId,
            channelid: ctx.channelId,
            ts: e.ts,
            kind: e.kind,
            detail: JSON.stringify(e.detail),
        };
        await h.rpc("eventpublish", {
            event: "run:event",
            scopes: [`run:${ctx.runId}`],
            data: { channelid: ctx.channelId, runid: ctx.runId, event },
        });
    }
}

// a DOM key event at the focused element, bubbling to the window listeners the graph and the viewer use: CDP's
// Input.dispatchKeyEvent often never reaches the WebView
const rvKey = (h, key, code) =>
    h.ev(`(() => {
        const target = document.activeElement ?? document.body;
        const init = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        return true;
    })()`);

// --- dag lifecycle: engine + graph surface ----------------------------------------------------
// Drives the real DagSubmit/DagAction/DagMerge RPCs through an orchestrator-mode run, then opens
// the graph surface and asserts the ReactFlow canvas renders the submitted nodes. Blast radius is
// contained: temp-dir project, worker blocks killed in teardown (deleteblock -> ShellProc.Close), channel deleted.
export const dagLifecycle = {
    name: "dag-lifecycle",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-dag-"));
        const wslist = await h.rpc("workspacelist", null);
        const workspaceId = wslist[0].workspacedata.oid;
        const ch = await h.rpc("createchannel", { name: "verify-dag", projectpath: cwd });
        return { cwd, workspaceId, channelId: ch.oid };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const getRun = async (runId) => (await channelRuns(h, ctx.channelId)).find((x) => x.id === runId);
        const getChannelRunCount = async () => (await channelRuns(h, ctx.channelId)).length;

        const clickRetry = (findJs, tries = 8) =>
            h.ev(`(async () => {
                for (let i = 0; i < ${tries}; i++) {
                    const b = ${findJs};
                    if (b) { b.click(); return true; }
                    await new Promise((r) => setTimeout(r, 500));
                }
                return false;
            })()`);

        // The draft-first DAG composer no longer exists: 4296d92d removed the draft modal and the
        // `kind: "draft"` state it was driven through, leaving the live modal as the only DAG UI. So a
        // DAG is created here the way the lead creates one — an orchestrator run held in planning by
        // DeferStart, then an explicit DagSubmit — and the DOM half below asserts only what survived.
        const beforePlanning = await getChannelRunCount();
        const parentGoal = "verify dag: do nothing, make no file changes, stop immediately";
        const dagTitle = "verify dag";
        const dagParallelism = 2;
        const dagTasks = [
            { id: "t-0", label: "noop", description: "do nothing, stop immediately", deps: [], state: "" },
            {
                id: "t-1",
                label: "review",
                description: "review only, make no changes",
                deps: ["t-0"],
                state: "",
            },
            {
                id: "t-2",
                label: "noop 2",
                description: "do nothing, stop immediately",
                deps: ["t-1"],
                state: "",
            },
        ];
        const createdParent = await h.rpc("createrun", {
            channelid: ctx.channelId,
            workspaceid: ctx.workspaceId,
            goal: parentGoal,
            runtime: "claude",
            mode: "orchestrator",
            deferstart: true,
        });
        const runId = createdParent.run.id;
        const afterPlanning = await getChannelRunCount();
        rec(
            "1. DeferStart -> one orchestrator Run held in planning, no phase worker spawned",
            createdParent.run.mode === "orchestrator" &&
                createdParent.run.status === "planning" &&
                afterPlanning === beforePlanning + 1 &&
                (createdParent.run.phases || []).every((p) => !workerOf(p)),
            JSON.stringify({
                beforePlanning,
                afterPlanning,
                mode: createdParent.run.mode,
                status: createdParent.run.status,
            })
        );

        await h.rpc("dagsubmit", {
            channelid: ctx.channelId,
            runid: runId,
            title: dagTitle,
            parallelism: dagParallelism,
            tasks: dagTasks,
        });

        // DagStatus returns { group, digest } since 5a863daa — the group is the snapshot this asserts.
        const g = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: runId })).group;
        // a JSON dag gets no plan gate: DagSubmit dispatches t-0 before it returns, so t-0 may already run
        const taskState = (group, id) => (group.tasks.find((t) => t.id === id) || {}).state;
        rec(
            "2. DagSubmit -> group with 3 tasks, no plan gate, t-1/t-2 pending",
            g.tasks.length === 3 &&
                g.status !== "awaiting-plan" &&
                g.status !== "plan-review" &&
                taskState(g, "t-1") === "pending" &&
                taskState(g, "t-2") === "pending",
            JSON.stringify({ id: g.id, status: g.status, tasks: g.tasks.map((t) => [t.id, t.state]) })
        );
        const rAfter = await getRun(runId);
        rec(
            "3. run.dagoref links the group",
            rAfter && rAfter.dagoref === g.id,
            JSON.stringify({ dagoref: rAfter && rAfter.dagoref })
        );

        const beforeRetryCount = await getChannelRunCount();
        const retry = await h.rpc("dagsubmit", {
            channelid: ctx.channelId,
            runid: runId,
            title: dagTitle,
            parallelism: dagParallelism,
            tasks: dagTasks,
        });
        const afterRetryCount = await getChannelRunCount();
        rec(
            "identical DagSubmit retry returns the same DAG without creating Runs",
            retry.id === g.id && retry.tasks.length === g.tasks.length && afterRetryCount === beforeRetryCount,
            JSON.stringify({ first: g.id, retry: retry.id, beforeRetryCount, afterRetryCount })
        );

        let st = null;
        for (let i = 0; i < 20; i++) {
            await h.ev("new Promise((r) => setTimeout(r, 700))");
            st = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: runId })).group;
            if (taskState(st, "t-0") !== "pending") break;
        }
        rec(
            "4. DagSubmit dispatches t-0 (running) or it already finished, t-1/t-2 pending",
            st != null &&
                (taskState(st, "t-0") === "running" || taskState(st, "t-0") === "done") &&
                taskState(st, "t-1") === "pending" &&
                taskState(st, "t-2") === "pending",
            JSON.stringify(st == null ? null : st.tasks.map((t) => ({ id: t.id, state: t.state })))
        );

        // graph surface: the run header has an Open DAG button. The Brief's Sessions region is how a
        // LIVE run is reached now — its row carries the run oref and opens the sheet on that run — so
        // there is no channel row to click first. Reload to pick up the RPC-created channel (the Brief
        // reads a boot-primed snapshot the same way the subjects column did), and open the region's
        // overflow first: Sessions caps at ACTIVE_CAP and this DAG adds a parent plus its children.
        await h.ev("location.reload()");
        await h.ev("new Promise((r) => setTimeout(r, 4500))");
        await h.goto("jarvis");
        // the overflow is expanded in the same loop as the row is looked for: on a loaded machine the region renders
        // after a separate short "more" retry gave up, and the run then sat past the cap for every try
        const runClicked = await h.ev(`(async () => {
            for (let i = 0; i < 30; i++) {
                const row = [...document.querySelectorAll('[data-jarvis-brief-row="session"]')]
                    .find((x) => (x.textContent || '').includes(${JSON.stringify(parentGoal)}));
                if (row) { row.click(); return true; }
                [...document.querySelectorAll('[data-jarvis-brief-more="more"]')]
                    .find((b) => b.closest('[data-jarvis-brief-region="sessions"]'))?.click();
                await new Promise((r) => setTimeout(r, 500));
            }
            return false;
        })()`);
        const sessionRows = await h.ev(
            `[...document.querySelectorAll('[data-jarvis-brief-row="session"]')].map((x) => (x.textContent || '').slice(0, 60))`
        );
        await h.ev("new Promise((r) => setTimeout(r, 1200))");
        // task 9 removed the cockpit takeover: Open DAG opens a surface-local modal (the Brief stays
        // mounted underneath) instead of replacing the fleet view.
        const openClicked = await clickRetry(
            `[...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Open DAG'))`
        );
        await h.ev("new Promise((r) => setTimeout(r, 1200))");
        const modalKindAfterOpen = await h.ev(
            `(() => (document.querySelector('[data-dag-modal-kind]') || {}).getAttribute?.('data-dag-modal-kind') || null)()`
        );
        const nodeCount = await h.ev(`(() => document.querySelectorAll('.react-flow__node').length)()`);
        const modalHeading = await h.ev(
            `(() => (document.querySelector('#dag-modal-heading') || {}).textContent || '')()`
        );
        const closeBtn = await h.ev(
            `(() => [...document.querySelectorAll('button')].some((x) => (x.textContent || '').includes('Close')))()`
        );
        rec(
            "5. Open DAG -> surface-local modal shows the live graph (3 nodes) with a heading",
            openClicked === true && modalKindAfterOpen === "live" && nodeCount >= 3 && modalHeading === "Route DAG",
            JSON.stringify({
                runClicked,
                sessionRows,
                openClicked,
                modalKind: modalKindAfterOpen,
                nodeCount,
                modalHeading,
                closeBtn,
            })
        );
        await h.shot("cdp-shots/dag-modal.png");

        // the graph column once had no min-w-0, so its header's min-content width shoved the rail past the
        // panel's clipped right edge
        const railFit = await h.ev(`(() => {
            const panel = document.querySelector('[data-dag-modal-kind] [role="dialog"]');
            const rail = document.querySelector('[data-dag-modal-kind] [data-timeline-rail]');
            if (!panel || !rail) return null;
            return { panelRight: panel.getBoundingClientRect().right, railRight: rail.getBoundingClientRect().right };
        })()`);
        rec(
            "5f. The timeline rail sits inside the modal panel",
            railFit != null && railFit.railRight <= railFit.panelRight + 1,
            JSON.stringify(railFit)
        );

        // spec D7: a native title inside a node opens over the hover peek
        const titledInNode = await h.ev(
            `(() => document.querySelectorAll('[data-dag-modal-kind] .react-flow__node [title]').length)()`
        );
        rec("5a. No node carries a native tooltip", titledInNode === 0, JSON.stringify({ titledInNode }));

        // the hover events the old hover peek opened on (its delay was 400ms); the peek now opens on a click only
        const hoverPeek = await h.ev(`(async () => {
            const card = document.querySelector('[data-dag-modal-kind] [data-dag-node]:not([data-dag-node="final"])');
            if (!card) return { card: null };
            for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
                const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent;
                card.dispatchEvent(new Ev(type, { bubbles: true }));
            }
            await new Promise((r) => setTimeout(r, 700));
            const taskPeek = !!document.querySelector('[data-dag-task-peek]');
            const oldPeek = !!document.querySelector('[data-dag-peek]');
            const titled = document.querySelectorAll('[data-dag-modal-kind] .react-flow__node [title]').length;
            for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) {
                const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent;
                card.dispatchEvent(new Ev(type, { bubbles: true }));
            }
            return { card: card.getAttribute('data-dag-node'), taskPeek, oldPeek, titled };
        })()`);
        rec(
            "5b. Hover opens nothing",
            hoverPeek.card != null && hoverPeek.taskPeek === false && hoverPeek.oldPeek === false && hoverPeek.titled === 0,
            JSON.stringify(hoverPeek)
        );

        const liveDag = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: runId })).group;
        const depPairs = liveDag.tasks.flatMap((t) => (t.deps || []).map((d) => [d, t.id]));
        const pairLefts = await h.ev(`(() => {
            const left = (id) => {
                const el = document.querySelector('[data-dag-modal-kind] [data-dag-node="' + CSS.escape(id) + '"]');
                return el ? el.getBoundingClientRect().left : null;
            };
            return ${JSON.stringify(depPairs)}.map(([dep, dependent]) => ({ dep, dependent, depLeft: left(dep), left: left(dependent) }));
        })()`);
        rec(
            "5c. Dependents sit to the right of their dependencies",
            pairLefts.length > 0 && pairLefts.every((p) => p.depLeft != null && p.left != null && p.left > p.depLeft),
            JSON.stringify(pairLefts)
        );

        // aria-pressed mirrors the card's selected border (DagCardNode)
        const escSelection = await h.ev(`(async () => {
            const pressed = () => document.querySelectorAll('[data-dag-modal-kind] [data-dag-node]:not([data-dag-node="final"])[aria-pressed="true"]').length;
            const card = document.querySelector('[data-dag-modal-kind] [data-dag-node]:not([data-dag-node="final"])');
            if (!card) return { card: null };
            const id = card.getAttribute('data-dag-node');
            const peek = () => !!document.querySelector('[data-dag-task-peek="' + CSS.escape(id) + '"]');
            card.click();
            // the peek is named only once floating-ui has placed it
            for (let i = 0; i < 20 && !peek(); i++) await new Promise((r) => setTimeout(r, 100));
            const selectedBefore = pressed();
            const peekBefore = peek();
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await new Promise((r) => setTimeout(r, 300));
            return {
                card: id,
                selectedBefore,
                peekBefore,
                selectedAfter: pressed(),
                peekAfter: !!document.querySelector('[data-dag-task-peek]'),
                modalOpen: !!document.querySelector('[data-dag-modal-kind]'),
            };
        })()`);
        rec(
            "5d. A click opens the node's peek, and Esc clears the selection and the peek before closing",
            escSelection.selectedBefore === 1 &&
                escSelection.peekBefore === true &&
                escSelection.selectedAfter === 0 &&
                escSelection.peekAfter === false &&
                escSelection.modalOpen === true,
            JSON.stringify(escSelection)
        );

        // a narrow window renders the rail as a drawer, collapsed until toggled
        const timeline = await h.ev(`(async () => {
            const rail = document.querySelector('[data-dag-modal-kind] [data-timeline-rail]');
            const layout = rail ? rail.getAttribute('data-timeline-rail') : null;
            if (layout === 'drawer') rail.querySelector('button[aria-expanded="false"]')?.click();
            let rows = 0;
            for (let i = 0; i < 10 && rows === 0; i++) {
                await new Promise((r) => setTimeout(r, 300));
                rows = document.querySelectorAll('[data-dag-modal-kind] [data-timeline-row]').length;
            }
            return { layout, rows };
        })()`);
        rec("5e. Timeline rows render", timeline.rows > 0, JSON.stringify(timeline));

        // the header's Adjust opens the Run settings modal over the graph; a saved width reaches the dag and the
        // header, and the modal's X closes only it
        const DAG_HEADER_ADJUST = `document.querySelector('[data-dag-modal-kind] [data-dag-adjust]')`;
        const RUN_SETTINGS = `document.querySelector('[data-run-settings-modal]')`;
        const RUN_SETTINGS_MORE = `${RUN_SETTINGS}?.querySelector('button[aria-label="More concurrent workers"]')`;
        const RUN_SETTINGS_SAVED = `document.querySelector('[data-run-settings-modal] [data-run-settings-status="saved"]')`;
        await h.ev(`${DAG_HEADER_ADJUST}?.click()`);
        const dialsShown = await polishWaitFor(h, `!!${RUN_SETTINGS_MORE}`, 3000);
        await h.ev(`${RUN_SETTINGS_MORE}?.click()`);
        await h.ev(clickByText(RUN_SETTINGS, "button", "Save settings"));
        const savedShown = await polishWaitFor(h, `!!${RUN_SETTINGS_SAVED}`, 8000);
        await h.shot("cdp-shots/dag-modal-adjust.png");
        const adjusted = {
            dialsShown,
            savedShown,
            saved: await h.ev(flatText(RUN_SETTINGS_SAVED)),
            header: await h.ev(flatText(`document.querySelector('[data-dag-modal-kind] [data-dag-progress]')?.parentElement`)),
            width: (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: runId })).group.parallelism,
        };
        await h.ev(`document.querySelector('[data-run-settings-close]')?.click()`);
        adjusted.settingsClosed = await polishWaitFor(h, `!${RUN_SETTINGS}`, 3000);
        adjusted.dagModalOpen = await h.ev(`!!document.querySelector('[data-dag-modal-kind]')`);
        rec(
            "5g. Adjust in the DAG header opens the Run settings modal, saves a new worker parallelism to the dag and the header reads it; its X closes only the Run settings modal",
            dialsShown &&
                adjusted.saved === "Saved. Applies to future dispatches." &&
                adjusted.width === dagParallelism + 1 &&
                adjusted.header.startsWith(`parallelism ${dagParallelism + 1}`) &&
                adjusted.settingsClosed &&
                adjusted.dagModalOpen,
            JSON.stringify(adjusted)
        );

        // escape dismisses the modal (the modal state machine refuses close while launching, which is
        // not in play here; the Close button and backdrop click share the same path)
        const esc = await h.ev(`(async () => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await new Promise((r) => setTimeout(r, 300));
            return true;
        })()`);
        const modalGone = await h.ev(`(() => !document.querySelector('[data-dag-modal-kind]'))()`);
        rec("6. Escape -> modal closes, no cockpit takeover", modalGone === true, JSON.stringify({ esc, modalGone }));

        // one DAG cancellation command owns the parent, children, and worker shutdown.
        await h.rpc("dagaction", { channelid: ctx.channelId, runid: runId, taskid: "", action: "cancel" });
        const cancelledRuns = await channelRuns(h, ctx.channelId);
        const cancelledOwner = cancelledRuns.find((run) => run.id === runId);
        const cancelledChildren = cancelledRuns.filter((run) => run.dagoref === g.id && run.id !== runId);
        const cancelledDag = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: runId })).group;
        const cascadeOk =
            cancelledOwner &&
            cancelledOwner.status === "cancelled" &&
            cancelledChildren.length > 0 &&
            cancelledChildren.every((run) => run.status === "cancelled") &&
            cancelledDag.status === "cancelled";
        rec(
            "7. DagAction cancel terminally cancels owner, children, and DAG",
            cascadeOk,
            JSON.stringify({
                owner: cancelledOwner && cancelledOwner.status,
                children: cancelledChildren.map((run) => ({ id: run.id, status: run.status })),
                dag: cancelledDag.status,
            })
        );

        await h.rpc("dagaction", { channelid: ctx.channelId, runid: runId, taskid: "", action: "cancel" });
        const repeatedDag = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: runId })).group;
        const repeatedOwner = await getRun(runId);
        rec(
            "8. repeated DAG cancellation is idempotent",
            repeatedDag.status === "cancelled" && repeatedOwner && repeatedOwner.status === "cancelled",
            JSON.stringify({ owner: repeatedOwner && repeatedOwner.status, dag: repeatedDag.status })
        );

        await dagLifecycleWaysIn(h, ctx, rec, runId, g.id);
        return steps;
    },
    async teardown(h, ctx) {
        // the stand-in runs; the channel delete below removes them
        for (const id of [ctx.standInId, ...(ctx.hiddenIds ?? [])].filter(Boolean)) {
            try {
                await h.rpc("cancelrun", { channelid: ctx.channelId, runid: id });
            } catch (e) {
                console.error(`dag-lifecycle teardown: cancel the stand-in run ${id} failed: ${e?.message ?? e}`);
            }
        }
        await h.cdp("Emulation.clearDeviceMetricsOverride").catch((e) => {
            console.error(`dag-lifecycle teardown: clear the viewport override failed: ${e?.message ?? e}`);
        });
        try {
            await deleteChannelWorkerBlocks(h, ctx.channelId);
        } catch (e) {
            console.error(`dag-lifecycle teardown: delete the worker blocks failed: ${e?.message ?? e}`);
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

// the line under the graph header naming the owner run's route
const RV_ROUTE = `(([...(${RV_MODAL}?.querySelectorAll("span") ?? [])].find((s) => s.textContent.trim().startsWith("Run route ·"))?.textContent) ?? "").replace(/\\s+/g, " ").trim()`;
const RV_MODAL_DAG = `
    const S = await mod("app/store/jotaiStore.ts");
    const D = await mod("app/view/orchestrate/dagmodalstate.ts");
    return S.globalStore.get(D.dagModalStateAtom)?.dagOref ?? null;
`;

// F25, F3, F14 on the cancelled dag above, at 1600x950: whichever way the modal opens, its owner and subtitle come
// off the dag. The stand-in worker run is on haiku, so a modal that took its opener for the owner would say haiku.
async function dagLifecycleWaysIn(h, ctx, rec, runId, dagId) {
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_WIDE);
    const owner = (await channelRuns(h, ctx.channelId)).find((r) => r.id === runId);
    const wantRoute = `Run route · ${owner?.runtime || "unavailable"} / ${owner?.model || "default"}`;
    const wantId = runId.slice(0, 8).toLowerCase();
    const created = await h.rpc("createrun", {
        channelid: ctx.channelId,
        workspaceid: ctx.workspaceId,
        goal: "verify dag-lifecycle: stand-in worker run of t-1",
        runtime: "claude",
        model: "haiku",
        mode: "quick",
        deferstart: true,
    });
    ctx.standInId = created.run.id;
    await fstWriteRun(h, ctx.standInId, (r) => ({ ...r, dagoref: dagId, taskid: "t-1" }));
    await polishReload(h);
    const opened = await h.ev(openAddressExpr(`run:${ctx.standInId}`));
    const sheet = await polishWaitFor(h, `!!${RV_OPEN_DAG}`, 15000);
    const label = await h.ev(`(${RV_OPEN_DAG}?.textContent ?? "").trim()`);
    if (sheet) await h.ev(`${RV_OPEN_DAG}.click()`);
    await polishWaitFor(h, `${RV_PRESSED}.length > 0 && ${RV_ROUTE} !== ""`, 10000);
    const modal = await h.ev(`(() => {
        const id = ${RV_MODAL}?.querySelector("[data-dag-modal-subtitle] [data-dag-modal-runid]");
        return {
            runid: (id?.textContent ?? "").trim(),
            transform: id ? getComputedStyle(id).textTransform : null,
            route: ${RV_ROUTE},
            pressed: ${RV_PRESSED},
        };
    })()`);
    await h.shot("cdp-shots/dag-lifecycle-worker-sheet-dag.png");
    rec(
        "9. F25: the modal subtitle's run id is the owner run's first 8 characters, lowercase, with no text transform",
        modal.runid === wantId && modal.transform === "none",
        JSON.stringify({ want: wantId, runid: modal.runid, transform: modal.transform })
    );
    rec(
        "10. F3: a worker run's sheet offers Open in the run's DAG, which opens the owner run's dag (its id and route) with the worker's t-1 selected",
        opened?.ok === true &&
            label === "Open in the run's DAG" &&
            modal.runid === wantId &&
            modal.route === wantRoute &&
            JSON.stringify(modal.pressed) === JSON.stringify(["t-1"]),
        JSON.stringify({ opened, standIn: ctx.standInId, label, wantRoute, ...modal })
    );

    await rvCloseDag(h);
    const byAddress = await h.ev(openAddressExpr(`dag:${dagId}#t-2`));
    const onT2 = await polishWaitFor(h, `JSON.stringify(${RV_PRESSED}) === '["t-2"]'`, 10000);
    const dagOref = await lookEval(h, RV_MODAL_DAG);
    // the address opens the sheet and the modal in one tick: j moving the selection proves the modal is on top
    await rvKey(h, "j", "KeyJ");
    const moved = await polishWaitFor(h, `${RV_PRESSED}.length === 1 && ${RV_PRESSED}[0] !== "t-2"`, 3000);
    const afterJ = await h.ev(RV_PRESSED);
    await h.shot("cdp-shots/dag-lifecycle-dag-address.png");
    rec(
        "11. F14: dag:<oid>#t-2 opens that dag's modal with t-2 selected, and j then moves the selection off t-2",
        byAddress?.ok === true && onT2 && dagOref === `dag:${dagId}` && moved,
        JSON.stringify({ byAddress, onT2, dagOref, want: `dag:${dagId}`, afterJ })
    );

    await rvCloseDag(h);
    const missingId = randomUUID();
    const missing = await h.ev(openAddressExpr(`dag:${missingId}`));
    await polishNap(1000);
    const modalAfter = await h.ev(`!!${RV_MODAL}`);
    rec(
        "12. F14: dag:<an id no dag has> opens no modal and reports that the DAG no longer exists",
        missing?.ok === false && /no longer exists/.test(missing?.message ?? "") && modalAfter === false,
        JSON.stringify({ missingId, missing, modalAfter })
    );

    await dagLifecycleHiddenRuns(h, ctx, rec, runId, dagId);
}

// the run id the detail sheet's header shows
const SHEET_RUN_ID = `(document.querySelector("[data-jarvis-brief-sheet] [data-run-id]")?.getAttribute("data-run-id") ?? null)`;
const HIDDEN_RUN_STATE = `
    const S = await mod("app/store/jotaiStore.ts");
    const J = await mod("app/view/jarvis/jarvissubjectstore.ts");
    const C = await mod("app/view/agents/channelsstore.ts");
    return {
        active: S.globalStore.get(J.activeRunIdAtom),
        listed: S.globalStore.get(C.activeChannelRunsAtom).map((r) => r.id),
    };
`;

// F4 at 1600x950: a run hidden from the lists, opened by run:<id>, lands on its owner's sheet, never another run's.
// A brainstorm judge is the kind that landed wrong: the channel's run list leaves it out, so the sheet fell back to
// the newest live run. It has no owner run, so it is refused. A verifier's owner is its dag's run.
async function dagLifecycleHiddenRuns(h, ctx, rec, runId, dagId) {
    const kinds = {
        verifier: { patch: { dagoref: dagId, stagerole: "verifier" } },
        judge: { patch: { stagerole: "brainstorm-judge" } },
    };
    ctx.hiddenIds = [];
    for (const [name, k] of Object.entries(kinds)) {
        const created = await h.rpc("createrun", {
            channelid: ctx.channelId,
            workspaceid: ctx.workspaceId,
            goal: `verify dag-lifecycle: stand-in ${name} run`,
            runtime: "claude",
            model: "haiku",
            mode: "quick",
            deferstart: true,
        });
        k.id = created.run.id;
        ctx.hiddenIds.push(k.id);
        await fstWriteRun(h, k.id, (r) => ({ ...r, ...k.patch }));
    }
    await polishReload(h);
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_WIDE);

    const verifierOpened = await h.ev(openAddressExpr(`run:${kinds.verifier.id}`));
    const onOwner = await polishWaitFor(h, `${SHEET_RUN_ID} === ${JSON.stringify(runId)}`, 10000);
    const verifier = { opened: verifierOpened, shown: await h.ev(SHEET_RUN_ID), ...(await lookEval(h, HIDDEN_RUN_STATE)) };
    await h.shot("cdp-shots/dag-lifecycle-verifier-owner-sheet.png");
    rec(
        "13. F4: run:<a verifier stage session> lands on its owner's sheet (the dag's run id), not its own or another run's",
        verifierOpened?.ok === true && onOwner && verifier.shown === runId,
        JSON.stringify({ owner: runId, verifier: kinds.verifier.id, ...verifier })
    );

    const judgeOpened = await h.ev(openAddressExpr(`run:${kinds.judge.id}`));
    // a refusal writes nothing, so give a wrong landing time to show
    await polishNap(1500);
    const judge = { opened: judgeOpened, shown: await h.ev(SHEET_RUN_ID), ...(await lookEval(h, HIDDEN_RUN_STATE)) };
    await h.shot("cdp-shots/dag-lifecycle-judge-refused.png");
    rec(
        "13a. F4: run:<a brainstorm judge>, which the channel's list leaves out, is refused as having no sheet of its own, and the sheet stays on the run it showed",
        judgeOpened?.ok === false &&
            judgeOpened?.message === "That run is part of another run and has no sheet of its own" &&
            judge.shown === runId &&
            judge.active?.[ctx.channelId] === runId,
        JSON.stringify({ owner: runId, judge: kinds.judge.id, ...judge })
    );
}

// --- dag-observability: what the run sheet and the DAG modal claim about a live DAG ------------------
// The orchestrator observability checks (spec 10.3, once scripts/cdp/orchestrator-observability-e2e.mjs) on
// today's surfaces: a run reads on the Jarvis run sheet, and the DAG opens from its dock. The chained plan
// dispatches only t-1, so t-3 is the undispatched task; teardown cancels the run and deletes t-1's worker.
// Open in Agent leaves the Brief, so it runs last.
const OBS_MODAL = `document.querySelector('[data-dag-modal-kind]')`;
const OBS_RAIL = `document.querySelector('[data-timeline-rail]')`;
const OBS_PEEK = (id) => `document.querySelector('[data-dag-modal-kind] [data-dag-task-peek="${id}"]')`;
// a row that renders its raw event kind means the projection is missing that kind's title
const OBS_RAW_KIND = /\b(task|dag|child|lead)-[a-z-]+\b/;

export const dagObservability = {
    name: "dag-observability",
    surface: "jarvis",
    async arrange(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
        const ctx = await arrangeSheetDagRun(h, "dag-observability", RUN_SHEET_POLISH_TASKS);
        if (ctx.arrangeError != null) return ctx;
        try {
            await waitForDispatch(h, ctx, "t-1");
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec(
            "0. the run's sheet opened and t-1 dispatched",
            ctx.arrangeError == null && ctx.opened?.ok === true && ctx.dispatched === true,
            ctx.arrangeError ??
                JSON.stringify({ runId: ctx.runId, opened: ctx.opened, dispatched: ctx.dispatched, dispatchMs: ctx.dispatchMs })
        );

        const sheet = await h.ev(`(async () => {
            for (let i = 0; i < 40 && !document.querySelector("[data-run-sheet] [data-run-sheet-row]"); i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            const root = document.querySelector("[data-run-sheet]");
            if (!root) return null;
            const nextEl = root.querySelector("[data-run-sheet-next]");
            return {
                strip: root.querySelector("[role=img]")?.getAttribute("aria-label") ?? null,
                rows: root.querySelectorAll("[data-run-sheet-row]").length,
                verb: root.querySelector("[data-run-sheet-verb]")?.textContent.trim() ?? null,
                next: nextEl ? nextEl.textContent.trim() : null,
            };
        })()`);
        rec(
            "1. the sheet reads the real task group: a done/total strip and one row per task",
            sheet != null && /^\d+ of 3 tasks done/.test(sheet.strip ?? "") && sheet.rows === 3,
            JSON.stringify(sheet)
        );
        const degraded = sheet?.verb === "Status is stale";
        rec(
            "2. the sheet states the engine's next move, and a stale read calls it unknown",
            sheet != null && !!sheet.next && (!degraded || sheet.next.startsWith("unknown")),
            JSON.stringify({ verb: sheet?.verb, next: sheet?.next })
        );

        const modalOpened = await h.ev(`(async () => {
            const btn = [...(document.querySelector("[data-run-sheet]")?.querySelectorAll("button") ?? [])].find(
                (b) => b.textContent.trim() === "Open DAG"
            );
            if (!btn) return false;
            btn.click();
            for (let i = 0; i < 20 && !document.querySelector("[data-dag-modal-kind] [data-dag-node]"); i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            return !!document.querySelector("[data-dag-modal-kind] [data-dag-node]");
        })()`);

        const history = await h.ev(`(async () => {
            for (let i = 0; i < 40 && !${OBS_RAIL}?.querySelector("[data-timeline-row][data-timeline-task]"); i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            const rail = ${OBS_RAIL};
            if (!rail) return null;
            const rows = [...rail.querySelectorAll("[data-timeline-row]")].map((b) => (b.innerText || "").trim());
            return { layout: rail.getAttribute("data-timeline-rail"), rows };
        })()`);
        const rawRows = (history?.rows ?? []).filter((r) => OBS_RAW_KIND.test(r));
        rec(
            "3. Open DAG shows the lifecycle as a rail of titled history rows",
            modalOpened === true &&
                history?.layout === "rail" &&
                history.rows.length > 0 &&
                rawRows.length === 0,
            JSON.stringify({ modalOpened, layout: history?.layout, rows: history?.rows.length, rawRows })
        );

        const deeplink = await h.ev(`(async () => {
            const row = ${OBS_RAIL}?.querySelector("[data-timeline-row][data-timeline-task]");
            if (!row) return null;
            const task = row.getAttribute("data-timeline-task");
            row.click();
            await new Promise((r) => setTimeout(r, 500));
            const chip = [...${OBS_RAIL}.querySelectorAll("button")].find((b) => /^Task/.test((b.innerText || "").trim()));
            return { task, chip: chip ? chip.innerText.trim() : null };
        })()`);
        rec(
            "4. a task-scoped event selects its task",
            deeplink != null && (deeplink.chip ?? "").includes(deeplink.task),
            JSON.stringify(deeplink)
        );

        // a click on the open node's own card would close it, and the step-4 deeplink may have opened it
        const explicit = await h.ev(`(async () => {
            const node = ${OBS_MODAL}?.querySelector('[data-dag-node="t-3"]');
            if (!node) return null;
            const peek = () => ${OBS_PEEK("t-3")};
            if (!peek()) node.click();
            for (let i = 0; i < 20 && !peek(); i++) await new Promise((r) => setTimeout(r, 250));
            const text = peek()?.innerText || "";
            const rail = ${OBS_RAIL}?.innerText || "";
            return {
                peek: !!peek(),
                pending: text.includes("Not dispatched yet"),
                live: rail.includes("● live"),
                failed: rail.includes("load failed"),
            };
        })()`);
        rec(
            "5. the undispatched t-3 says so, and the rail names its connection state",
            explicit != null && explicit.pending && (explicit.live || explicit.failed),
            JSON.stringify(explicit)
        );

        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_NARROW);
        await new Promise((r) => setTimeout(r, 900));
        const drawer = await h.ev(`(() => {
            const rail = ${OBS_RAIL};
            if (!rail) return null;
            const toggle = rail.querySelector('button[aria-label$="lifecycle"]');
            return { layout: rail.getAttribute("data-timeline-rail"), toggle: toggle?.getAttribute("aria-label") ?? null };
        })()`);
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
        await new Promise((r) => setTimeout(r, 900));
        rec(
            "6. a narrow window collapses the lifecycle into a drawer with an expand control",
            drawer != null && drawer.layout === "drawer" && drawer.toggle != null,
            JSON.stringify(drawer)
        );

        const worker = await h.ev(`(async () => {
            const node = ${OBS_MODAL}?.querySelector('[data-dag-node="t-1"]');
            if (!node) return null;
            const peek = () => ${OBS_PEEK("t-1")};
            if (!peek()) node.click();
            const openBtn = () => [...(peek()?.querySelectorAll("button") ?? [])].find((b) => /open in agent/i.test(b.innerText || ""));
            for (let i = 0; i < 40 && !openBtn(); i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            const text = peek()?.innerText || "";
            return {
                peek: !!peek(),
                openable: !!openBtn(),
                pending: text.includes("Not dispatched yet"),
                unavailable: text.includes("Worker session unavailable"),
            };
        })()`);
        rec(
            "7. the dispatched t-1 resolves its own worker, with Open in Agent",
            worker != null && worker.openable,
            JSON.stringify(worker)
        );

        const landed = await h.ev(`(async () => {
            const btn = [...(${OBS_PEEK("t-1")}?.querySelectorAll("button") ?? [])].find((b) => /open in agent/i.test(b.innerText || ""));
            if (!btn) return null;
            btn.click();
            await new Promise((r) => setTimeout(r, 1200));
            return {
                modalGone: ${OBS_MODAL} == null,
                onAgent: !!document.querySelector('nav button[aria-label="Agent"]')?.classList.contains("text-accent-soft"),
            };
        })()`);
        rec(
            "8. Open in Agent closes the modal and lands on the Agent surface",
            landed != null && landed.modalGone && landed.onAgent,
            JSON.stringify(landed)
        );

        await dagObservabilityRail(h, ctx, rec);
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.clearDeviceMetricsOverride").catch((e) => {
            console.error(`dag-observability teardown: clear the viewport override failed: ${e?.message ?? e}`);
        });
        await teardownFixtureRun(h, ctx, "dag-observability");
    },
};

// more than the 200 the live append once kept
const OBS_F1_EVENTS = 230;
const OBS_F1_KINDS = ["task-spawned", "task-verify-started", "task-verify-passed", "task-done"];
const OBS_WAKE_REASON = "dag-observability: the lead's pane is gone";
const OBS_WAKE_LINES = ["wake 1: no pane", "wake 2: no pane"];
const OBS_MONTH_TIME = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}/;
const OBS_DAY_MS = 24 * 60 * 60_000;
const OBS_HOUR_MS = 60 * 60_000;
const obsRow = (title) =>
    `[...(${RV_RAIL}?.querySelectorAll("[data-timeline-row]") ?? [])].find((b) => (b.firstElementChild?.firstElementChild?.textContent ?? "").trim() === ${JSON.stringify(title)})`;

// F1, F21, F5, F20 at 1600x950, on the DAG reopened from the run sheet after step 8 left for the Agent surface
async function dagObservabilityRail(h, ctx, rec) {
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_WIDE);
    const opened = await rvOpenDag(h, ctx.runId);
    // a run:event published before the history loads is overwritten by the load
    const live = await polishWaitFor(h, `${RV_RAIL}?.querySelector('[data-timeline-status="live"]') != null`, 15000);
    const before = await h.ev(RV_COUNT);
    const start = Date.now() - OBS_F1_EVENTS * 1000;
    await rvPublish(
        h,
        ctx,
        "obs-f1",
        Array.from({ length: OBS_F1_EVENTS }, (_, i) => ({
            kind: OBS_F1_KINDS[i % OBS_F1_KINDS.length],
            detail: { taskid: `t-${(i % 3) + 1}` },
            ts: start + i * 1000,
        }))
    );
    const grew = await polishWaitFor(h, `${RV_COUNT} >= ${before + OBS_F1_EVENTS}`, 20000);
    const f1 = await h.ev(`({ count: ${RV_COUNT}, all: ${rvFilterCount("all")} })`);
    await h.shot("cdp-shots/dag-observability-f1-count.png");
    rec(
        `9. F1: ${OBS_F1_EVENTS} published events all reach the rail: its header counts them, and the All chip counts the same`,
        opened && live && grew && f1.count >= before + OBS_F1_EVENTS && f1.all === f1.count,
        JSON.stringify({ opened, live, before, published: OBS_F1_EVENTS, ...f1 })
    );

    await h.ev(`${RV_MODAL}?.querySelector('[data-dag-node="t-1"]')?.click()`);
    await polishWaitFor(
        h,
        `!!${OBS_PEEK("t-1")}?.querySelector("[data-dag-peek-lifecycle-count]") && !Number.isNaN(${rvFilterCount("task")})`,
        5000
    );
    await polishNap(400);
    const f21 = await h.ev(`({
        chip: (${RV_RAIL}?.querySelector('[data-timeline-filter-count="task"]')?.closest("button")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
        task: ${rvFilterCount("task")},
        peek: (${OBS_PEEK("t-1")}?.querySelector("[data-dag-peek-lifecycle-count]")?.textContent ?? "").trim(),
    })`);
    rec(
        "10. F21: with t-1 selected, the Task · t-1 chip counts the events its peek's Lifecycle counts",
        f21.chip.startsWith("Task · t-1") && f21.task > 0 && f21.task === parseInt(f21.peek, 10),
        JSON.stringify(f21)
    );
    // the dag-level rows below show under All, which clearing the selection returns to
    await h.ev(`${OBS_PEEK("t-1")}?.querySelector('button[aria-label="Close task details"]')?.click()`);
    await polishWaitFor(h, `!${OBS_PEEK("t-1")}`, 3000);

    // a run that ended yesterday: its events span two days ending at noon yesterday
    const status = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
    ctx.dagId = status?.oid ?? status?.id;
    let seeded = "ok";
    try {
        await seedDag(h, ctx, (dag) => ({ ...dag, status: "done" }), (dag) => dag?.status ?? "");
    } catch (e) {
        seeded = String(e?.message ?? e);
    }
    const noon = new Date();
    noon.setDate(noon.getDate() - 1);
    noon.setHours(12, 0, 0, 0);
    const end = noon.getTime();
    await rvPublish(h, ctx, "obs-f5", [
        { kind: "task-spawned", detail: { taskid: "t-2" }, ts: end - OBS_DAY_MS - 2 * OBS_HOUR_MS },
        { kind: "task-done", detail: { taskid: "t-2" }, ts: end - OBS_DAY_MS - OBS_HOUR_MS },
        { kind: "task-spawned", detail: { taskid: "t-3" }, ts: end - OBS_HOUR_MS },
        { kind: "task-done", detail: { taskid: "t-3" }, ts: end },
    ]);
    await polishWaitFor(
        h,
        `(${RV_RAIL}?.querySelector("[data-timeline-strip-end]")?.textContent ?? "").startsWith("ended") && ${RV_RAIL}?.querySelector("[data-timeline-gap]") != null`,
        10000
    );
    const f5 = await h.ev(`(() => {
        const rail = ${RV_RAIL};
        const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
        return {
            end: flat(rail?.querySelector("[data-timeline-strip-end]")),
            now: rail?.querySelector("[data-timeline-now]") != null,
            status: rail?.querySelector("[data-timeline-status]")?.getAttribute("data-timeline-status") ?? null,
            times: [...(rail?.querySelectorAll("[data-timeline-row]") ?? [])].map((r) => flat(r.firstElementChild?.lastElementChild)),
            gaps: [...(rail?.querySelectorAll("[data-timeline-gap]") ?? [])].map(flat),
        };
    })()`);
    await h.shot("cdp-shots/dag-observability-f5-ended.png");
    const undated = f5.times.filter((t) => !OBS_MONTH_TIME.test(t));
    rec(
        "11. F5: a done run whose events span two days ending yesterday: the strip ends at ended HH:MM with no now marker or live pill, every row time carries its date, and quiet gaps read in h or d, never min",
        seeded === "ok" &&
            f5.end.startsWith("ended") &&
            !f5.now &&
            f5.status !== "live" &&
            f5.times.length > 0 &&
            undated.length === 0 &&
            f5.gaps.length > 0 &&
            f5.gaps.every((g) => !g.includes("min")) &&
            f5.gaps.some((g) => /^\d+(h\d+m|d) quiet$/.test(g)),
        JSON.stringify({ seeded, end: f5.end, now: f5.now, status: f5.status, rows: f5.times.length, undated, gaps: f5.gaps })
    );

    const now = Date.now();
    await rvPublish(h, ctx, "obs-f20", [
        { kind: "evidence-sealed", detail: {}, ts: now - 60_000 },
        { kind: "lead-wake-failed", detail: { reason: OBS_WAKE_REASON, lines: OBS_WAKE_LINES }, ts: now },
    ]);
    const rows = await polishWaitFor(h, `!!${obsRow("Lead wake failed")} && !!${obsRow("Evidence sealed")}`, 10000);
    const wake = await h.ev(`(async () => {
        const row = () => ${obsRow("Lead wake failed")};
        if (!row()) return null;
        const expand = row().getAttribute("aria-expanded");
        row().click();
        const detail = () => row()?.parentElement?.querySelector("[data-timeline-row-detail]");
        for (let i = 0; i < 20 && !detail(); i++) await new Promise((r) => setTimeout(r, 100));
        return { expand, detail: (detail()?.textContent ?? "").replace(/\\s+/g, " ").trim() || null };
    })()`);
    const evidence = await h.ev(`(() => {
        const row = ${obsRow("Evidence sealed")};
        return row ? { expand: row.hasAttribute("aria-expanded") } : null;
    })()`);
    await h.shot("cdp-shots/dag-observability-f20-rows.png");
    await h.ev(`${obsRow("Evidence sealed")}?.click()`);
    const closed = await polishWaitFor(h, `!document.querySelector("[data-dag-modal-subtitle]")`, 3000);
    rec(
        "12. F20: a lead-wake-failed row expands to its reason; the Evidence sealed row has no expand and its click closes the modal",
        rows &&
            wake?.expand === "false" &&
            (wake.detail ?? "").includes(OBS_WAKE_REASON) &&
            evidence?.expand === false &&
            closed,
        JSON.stringify({ rows, wake, evidence, closed })
    );
}

// --- dag-peek: the card a DAG node click opens beside the node (Main.dc.html, Final.dc.html) ------------------
// Four tasks at parallelism 1: only t-1 dispatches. One seed makes t-2 a done task and t-3 a failed task, and gives
// the dag its Check, Verify and Final commands with no final, so the final node is the waiting stage with five rows.
// The dag is not finalizing, so the engine leaves the stage alone. A seeded DAG proves the UI, not the engine.
// t-1 holds the one slot while its worker runs, so t-4, which waits on it, stays undispatched for step g.
const DAG_PEEK_VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const DAG_PEEK_DONE_WHEN = "Done when: `git status --porcelain` prints nothing";
const DAG_PEEK_BULLETS = ["make no file changes", "run no commands", "send no messages"];
const DAG_PEEK_TASKS = [
    {
        id: "t-1",
        label: "noop",
        description: [
            "Do nothing and stop immediately. This task only gives the DAG peek card a description with more than its lead.",
            "",
            ...DAG_PEEK_BULLETS.map((b) => `- ${b}`),
            "",
            DAG_PEEK_DONE_WHEN,
        ].join("\n"),
        deps: [],
        state: "",
    },
    { id: "t-2", label: "noop 2", description: "do nothing, stop immediately", deps: [], state: "" },
    { id: "t-3", label: "noop 3", description: "do nothing, stop immediately", deps: [], state: "" },
    { id: "t-4", label: "noop 4", description: "do nothing, stop immediately", deps: ["t-1"], state: "" },
];
const DAG_PEEK_CMDS = { check: "true", verify: "true", finalcmd: "true" };
const DAG_PEEK_TAG_MODEL = "haiku";
const DAG_PEEK_REFUSAL = "dag-peek refused this retry on the page";
// the old hover peek opened after 400ms
const DAG_PEEK_HOVER_MS = 700;
const DAG_PEEK_CATALOG_MS = 30_000;
// t-1's right edge within this of the pane's right edge leaves the card no room on its right
const DAG_PEEK_FLIP_PX = 200;
const DAG_PEEK_REFUSAL_KEY = "__dagPeekRefusal";
// published as the engine's run:events (a run's events cannot be written through an RPC): [kind, detail, ms ago]
const DAG_PEEK_T3_EVENTS = [
    ["task-spawned", { taskid: "t-3", worktreems: 1200, setupms: 4000, spawnms: 300 }, 6 * 60_000],
    ["task-done", { taskid: "t-3" }, 3 * 60_000],
    ["task-verify-started", { taskid: "t-3" }, 3 * 60_000 - 1000],
    ["task-verify-failed", { taskid: "t-3", reason: "exit 1", detail: "FAIL\tfrontend/app/view/orchestrate\t0.4s" }, 2 * 60_000],
    ["task-failed", { taskid: "t-3", attempts: 1, lastfailurekind: "test-failed" }, 2 * 60_000 - 1000],
];
const DAG_PEEK_T3_TITLES = ["Task failed", "Verify failed", "Verify started", "Task done", "Task spawned"];
// the plan reviewer's session is a stage session too, but not the final stage's: its Lifecycle leaves it out
const DAG_PEEK_FINAL_EVENTS = [
    ["stage-session-started", { role: "plan-reviewer", lens: "spec" }, 90_000],
    ["stage-session-started", { role: "verifier", runid: "dag-peek-verifier" }, 60_000],
    ["land-held", { reason: "dag-peek: the base has uncommitted changes" }, 30_000],
];
const DAG_PEEK_FINAL_TITLES = ["Land held", "Final verifier started"];
const DAG_PEEK_FINAL_EMPTY = "The final stage has not run yet";
// Type.dc.html: times 11.5px mono, titles 13px, detail 12px
const DAG_PEEK_ROW_SIZES = { time: "11.5px", title: "13px", detail: "12px" };

const dagPeekPrint = (dag) => {
    const t = (id) => (dag?.tasks ?? []).find((x) => x.id === id);
    return JSON.stringify([dag?.check ?? "", dag?.verify ?? "", dag?.finalcmd ?? "", dag?.final ?? null, t("t-2")?.state, t("t-3")?.state, t("t-3")?.escalations ?? 0]);
};
const dagPeekAnyCard = `!!document.querySelector("[data-dag-task-peek], [data-dag-final-peek], [data-dag-peek]")`;
// the card is a sibling of .react-flow inside the pane div, so .react-flow's parent is the pane
const DAG_PEEK_LIB = `
    const modal = ${DAG_PEEK_MODAL};
    const pane = modal?.querySelector(".react-flow")?.parentElement ?? null;
    const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
    };
    const inside = (a, b) => a != null && b != null && a.l >= b.l - 1 && a.t >= b.t - 1 && a.r <= b.r + 1 && a.b <= b.b + 1;
    const meets = (a, b) => a != null && b != null && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    const transform = () => modal?.querySelector(".react-flow__viewport")?.style.transform ?? null;
`;
// where the card sits against its node, the pane, the timeline rail and the graph's controls
const dagPeekGeom = (sel, nodeId) => `(() => {
    ${DAG_PEEK_LIB}
    const el = modal?.querySelector(${JSON.stringify(sel)});
    const card = box(el);
    const node = box(modal?.querySelector('[data-dag-node="${nodeId}"]'));
    const p = box(pane);
    const rail = box(modal?.querySelector("[data-timeline-rail]"));
    const controls = box(modal?.querySelector("[data-dag-controls]"));
    return {
        card,
        node,
        pane: p,
        rail,
        controls,
        transform: transform(),
        visible: el != null && getComputedStyle(el).visibility !== "hidden",
        beside: card && node ? (card.l >= node.r ? "right" : card.r <= node.l ? "left" : null) : null,
        inPane: inside(card, p),
        clearRail: rail != null && !meets(card, rail),
        clearControls: controls != null && !meets(card, controls),
    };
})()`;
const DAG_PEEK_FRAME = `(() => {
    ${DAG_PEEK_LIB}
    return { pane: box(pane), transform: transform() };
})()`;
// a point on the graph's empty background: a pan or a pane click starts there
const DAG_PEEK_EMPTY = `(() => {
    const bg = ${DAG_PEEK_MODAL}?.querySelector(".react-flow__pane");
    if (!bg) return null;
    const r = bg.getBoundingClientRect();
    for (let y = r.top + 40; y < r.bottom - 40; y += 24) {
        for (let x = r.left + 40; x < r.right - 40; x += 24) {
            if (document.elementFromPoint(x, y) === bg) return { x: Math.round(x), y: Math.round(y) };
        }
    }
    return null;
})()`;
// the rail's pressed filter and the task of each row it shows
const DAG_PEEK_RAIL_STATE = `(() => {
    const rail = ${DAG_PEEK_RAIL};
    return {
        pressed: [...(rail?.querySelectorAll("button[aria-pressed='true']") ?? [])].map((b) => (b.innerText || "").replace(/\\s+/g, " ").trim()),
        tasks: [...(rail?.querySelectorAll("[data-timeline-row]") ?? [])].map((r) => r.getAttribute("data-timeline-task") ?? ""),
    };
})()`;
// a popup's Lifecycle section: its count, each row's title and attention, and the type sizes of the first row with a detail
const dagPeekLifecycle = (sel) => `(() => {
    const lc = ${dagPeekCard(sel)}?.querySelector("[data-dag-peek-lifecycle]");
    const rows = [...(lc?.querySelectorAll("[data-dag-peek-lifecycle-row]") ?? [])];
    const size = (el) => (el ? getComputedStyle(el).fontSize : null);
    // a row without a detail line has nothing to measure it by
    const first = rows.find((r) => r.children[2]?.children[1] != null)?.children;
    return {
        present: lc != null,
        count: (lc?.querySelector("[data-dag-peek-lifecycle-count]")?.textContent ?? "").trim(),
        empty: (lc?.querySelector("[data-dag-peek-lifecycle-empty]")?.textContent ?? "").trim(),
        titles: rows.map((r) => (r.children[2]?.children[0]?.textContent ?? "").trim()),
        attention: rows.map((r) => r.getAttribute("data-dag-peek-lifecycle-row") === "attention"),
        sizes: first ? { time: size(first[0]), title: size(first[2]?.children[0]), detail: size(first[2]?.children[1]) } : null,
    };
})()`;
const dagPeekLifecycleRows = (sel, n) =>
    `(${dagPeekCard(sel)}?.querySelectorAll("[data-dag-peek-lifecycle-row]").length ?? 0) === ${n}`;

const dagPeekBar = (sel) => `[...(${dagPeekCard(sel)}?.querySelectorAll("[data-dag-peek-action]") ?? [])].map((b) => ({
    action: b.getAttribute("data-dag-peek-action"),
    label: b.textContent.trim(),
    primary: b.classList.contains("bg-accent"),
}))`;

// removes the page's refusal if it is still in place; the override deletes itself once it has refused
const DAG_PEEK_RESTORE = `(() => {
    const f = window.${DAG_PEEK_REFUSAL_KEY};
    if (!f) return "absent";
    if (Object.prototype.hasOwnProperty.call(f.RpcApi, "DagActionCommand")) delete f.RpcApi.DagActionCommand;
    delete window.${DAG_PEEK_REFUSAL_KEY};
    return "restored";
})()`;

// the viewport's transform, once two reads 300ms apart agree: the opening fit and a selection's pan animate
async function dagPeekSettled(h) {
    let last = null;
    for (let waited = 0; waited < 4000; waited += 300) {
        const now = await h.ev(DAG_PEEK_FRAME);
        if (last != null && JSON.stringify(now) === JSON.stringify(last)) return now;
        last = now;
        await polishNap(300);
    }
    return last;
}

async function dagPeekMouse(h, type, pt, buttons = 0) {
    await h.cdp("Input.dispatchMouseEvent", {
        type,
        x: pt.x,
        y: pt.y,
        button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
    });
}

// --- dag-motion: a task finishing settles its card, and only live lifecycle rows fade in ----------------------
// t-1 dispatches; t-3 is seeded done before the DAG opens, so its card mounts finished and must stay still. With the
// modal open t-2 is seeded done (its card settles and its glyph cross-fades) and a run event is published (its new
// row fades in, no other row does). One in-page sampler watches every frame, since a CDP round trip per sample is
// slower than the micro fade it measures.
const DAG_MOTION_TASKS = [
    { id: "t-1", label: "noop", description: "do nothing, stop immediately", deps: [], state: "" },
    { id: "t-2", label: "noop 2", description: "do nothing, stop immediately", deps: ["t-1"], state: "" },
    { id: "t-3", label: "noop 3", description: "do nothing, stop immediately", deps: ["t-1"], state: "" },
];
const DAG_MOTION_LIVE_EVENT = [["task-verify-started", { taskid: "t-3" }, 0]];
const dagMotionPrint = (dag) => JSON.stringify((dag?.tasks ?? []).map((t) => [t.id, t.state]));
const dagMotionSeed = (doneIds) => (dag) => ({
    ...dag,
    tasks: dag.tasks.map((t) => (doneIds.includes(t.id) ? { ...t, state: "done" } : t)),
});
// every frame: which cards wore the settle class, which glyphs were caught mid-fade, which rows were seen below
// full opacity. A row's motion root is its button's grandparent (GroupRow).
const DAG_MOTION_SAMPLER = `(() => {
    const obs = { settle: {}, glyphFade: {}, rowFade: {}, frames: 0, on: true };
    window.__dagMotion = obs;
    const tick = () => {
        obs.frames++;
        for (const n of document.querySelectorAll('[data-dag-modal-kind] [data-dag-node]')) {
            const id = n.getAttribute('data-dag-node');
            if (/animate-\\[settle/.test(n.className)) obs.settle[id] = true;
            for (const s of n.querySelectorAll('[data-crossfade]')) {
                const o = parseFloat(getComputedStyle(s).opacity);
                if (o > 0.01 && o < 0.99) obs.glyphFade[id] = s.getAttribute('data-crossfade');
            }
        }
        for (const b of document.querySelectorAll('[data-dag-modal-kind] [data-timeline-row]')) {
            const root = b.parentElement?.parentElement;
            if (root && parseFloat(getComputedStyle(root).opacity) < 0.99) {
                obs.rowFade[(b.innerText || '').split('\\n')[0].trim()] = true;
            }
        }
        if (obs.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
})()`;
const DAG_MOTION_READ = `(() => {
    const o = window.__dagMotion;
    return o ? { settle: o.settle, glyphFade: o.glyphFade, rowFade: o.rowFade, frames: o.frames } : null;
})()`;
const DAG_MOTION_RESET = `(() => {
    const o = window.__dagMotion;
    if (o) { o.settle = {}; o.glyphFade = {}; o.rowFade = {}; }
    return !!o;
})()`;
const DAG_MOTION_ROWS = `[...document.querySelectorAll('[data-dag-modal-kind] [data-timeline-row]')].map((b) => (b.innerText || '').split('\\n')[0].trim())`;
// the glyph a card shows now: during a swap the leaving copy is popped out of flow ahead of the new one
const dagMotionGlyph = (id) =>
    `[...document.querySelectorAll('[data-dag-modal-kind] [data-dag-node="${id}"] [data-crossfade]')].at(-1)?.getAttribute('data-crossfade') ?? null`;

export const dagMotionScenario = {
    name: "dag-motion",
    surface: "jarvis",
    async arrange(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", DAG_PEEK_VIEWPORT);
        const ctx = await arrangeSheetDagRun(h, "dag-motion", DAG_MOTION_TASKS);
        if (ctx.arrangeError != null) return ctx;
        try {
            await waitForDispatch(h, ctx, "t-1");
            ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group.id;
            await seedDag(h, ctx, dagMotionSeed(["t-3"]), dagMotionPrint);
            ctx.seeded = true;
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: JSON.stringify(detail) });

        // the sampler starts before Open DAG, so the open itself is watched
        await h.ev(DAG_MOTION_SAMPLER);
        const openDag = `[...(document.querySelector("[data-run-sheet]")?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Open DAG")`;
        const sheet = await polishWaitFor(h, `!!${openDag}`, 15000);
        if (sheet) await h.ev(`${openDag}.click()`);
        const graph = await polishWaitFor(
            h,
            `document.querySelectorAll('[data-dag-modal-kind] [data-dag-node]').length >= 3 && document.querySelectorAll('[data-dag-modal-kind] [data-timeline-row]').length > 0`,
            15000
        );
        await polishNap(1500);
        const opened = await h.ev(DAG_MOTION_READ);
        const t3Glyph = await h.ev(dagMotionGlyph("t-3"));
        rec(
            "1. opening the DAG plays nothing: t-3, mounted done, does not settle, and no lifecycle row fades in",
            ctx.arrangeError == null &&
                ctx.seeded &&
                graph &&
                t3Glyph === "done" &&
                opened != null &&
                opened.frames > 10 &&
                Object.keys(opened.settle).length === 0 &&
                Object.keys(opened.glyphFade).length === 0 &&
                Object.keys(opened.rowFade).length === 0,
            ctx.arrangeError ?? { sheet, graph, t3Glyph, opened }
        );
        if (!graph) return steps;
        await h.shot("cdp-shots/dag-motion-open.png");

        // 2. t-2 finishes while the DAG is open
        await h.ev(DAG_MOTION_RESET);
        await seedDag(h, ctx, dagMotionSeed(["t-2", "t-3"]), dagMotionPrint);
        const t2Done = await polishWaitFor(h, `${dagMotionGlyph("t-2")} === "done"`, 10000);
        await polishNap(700);
        const flipped = await h.ev(DAG_MOTION_READ);
        const settleGone = await h.ev(
            `!/animate-\\[settle/.test(document.querySelector('[data-dag-modal-kind] [data-dag-node="t-2"]')?.className ?? '')`
        );
        rec(
            "2. t-2 turning done settles its card once and cross-fades its glyph; no other card moves",
            t2Done &&
                flipped?.settle["t-2"] === true &&
                flipped.glyphFade["t-2"] != null &&
                Object.keys(flipped.settle).every((id) => id === "t-2") &&
                settleGone,
            { t2Done, flipped, settleGone }
        );
        await h.shot("cdp-shots/dag-motion-settled.png");

        // 3. a lifecycle event arriving live
        const rowsBefore = await h.ev(DAG_MOTION_ROWS);
        await h.ev(DAG_MOTION_RESET);
        await dagPeekPublish(h, ctx, DAG_MOTION_LIVE_EVENT);
        const grew = await polishWaitFor(h, `${DAG_MOTION_ROWS}.length > ${rowsBefore.length}`, 10000);
        await polishNap(800);
        const live = await h.ev(DAG_MOTION_READ);
        const rowsAfter = await h.ev(DAG_MOTION_ROWS);
        const added = rowsAfter.filter((r) => !rowsBefore.includes(r));
        const faded = Object.keys(live?.rowFade ?? {});
        rec(
            "3. a live lifecycle event's new row fades in, and none of the rows already there does",
            grew && added.length > 0 && faded.length > 0 && faded.every((r) => added.includes(r)),
            { rowsBefore, rowsAfter, added, faded }
        );
        await h.shot("cdp-shots/dag-motion-live-row.png");

        // 4. switching the filter away and back re-renders every row without a cascade
        await h.ev(DAG_MOTION_RESET);
        await h.ev(`(async () => {
            const pick = (label) => [...document.querySelectorAll('[data-dag-modal-kind] [data-timeline-rail] button[aria-pressed]')]
                .find((b) => b.textContent.trim().startsWith(label))?.click();
            pick("Attention");
            await new Promise((r) => setTimeout(r, 400));
            pick("All");
            await new Promise((r) => setTimeout(r, 800));
        })()`);
        const refiltered = await h.ev(DAG_MOTION_READ);
        rec(
            "4. a filter change brings rows back without fading any in",
            refiltered != null && Object.keys(refiltered.rowFade).length === 0,
            refiltered
        );
        await h.ev(`window.__dagMotion && (window.__dagMotion.on = false)`);

        await dagMotionViewport(h, ctx, rec);
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.clearDeviceMetricsOverride").catch((e) => {
            console.error(`dag-motion teardown: clear the viewport override failed: ${e?.message ?? e}`);
        });
        await teardownFixtureRun(h, ctx, "dag-motion");
    },
};

// three lanes of six beside the scenario's three tasks: 21 in all, wider than the pane holds at ZOOM_FLOOR
const DAG_MOTION_LANES = 3;
const DAG_MOTION_LANE_LEN = 6;
// whole rows in view, not rows in the DOM: at 1000x700 the 487px body under a 125px graph header cannot hold a pane
// taller than the drawer and a drawer showing 3 rows (its header, filters and now line take ~105px, a row ~36px)
const DAG_MOTION_DRAWER_MIN_ROWS = 1;
// the drawer against the modal body, its header and the graph pane, and which cards the pane cuts through
const DAG_MOTION_DRAWER_READ = `(() => {
    ${DAG_PEEK_LIB}
    const rail = modal?.querySelector("[data-timeline-rail]");
    const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
    const p = box(pane);
    const nodes = [...(modal?.querySelectorAll("[data-dag-node]") ?? [])];
    const rows = [...(rail?.querySelectorAll("[data-timeline-row]") ?? [])];
    const clip = (el) => {
        for (let a = el.parentElement; a && a !== rail; a = a.parentElement) {
            if (/auto|scroll/.test(getComputedStyle(a).overflowY)) return a;
        }
        return rail;
    };
    return {
        layout: rail?.getAttribute("data-timeline-rail") ?? null,
        expanded: rail?.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") ?? null,
        strip: modal?.querySelector("[data-timeline-strip]") != null,
        bodyH: h(rail?.parentElement),
        modalHeaderH: h(modal?.querySelector("#dag-modal-heading")?.parentElement?.parentElement),
        // the graph column above its pane: the banner and the graph's own header
        graphHeaderH: pane && rail ? h(rail.previousElementSibling) - h(pane) : null,
        drawerH: h(rail),
        paneH: h(pane),
        rows: rows.length,
        rowsShown: rows.filter((r) => inside(box(r), box(clip(r)))).length,
        nodes: nodes.length,
        cut: nodes.filter((n) => !inside(box(n), p)).map((n) => n.getAttribute("data-dag-node")),
    };
})()`;
// the done dag F18 opens on: every task done, t-1 keeping its worker run so teardown's cancel still stops it
function dagMotionLanes(dag) {
    const { runid: _run, reviewrunid: _review, ...base } = dag.tasks.find((t) => t.id === "t-3");
    const lanes = [];
    for (let l = 0; l < DAG_MOTION_LANES; l++) {
        for (let s = 0; s < DAG_MOTION_LANE_LEN; s++) {
            const n = 4 + l * DAG_MOTION_LANE_LEN + s;
            lanes.push({ ...base, id: `t-${n}`, label: `lane ${l + 1} step ${s + 1}`, deps: s === 0 ? [] : [`t-${n - 1}`], state: "done" });
        }
    }
    const kept = dag.tasks.filter((t) => !lanes.some((x) => x.id === t.id)).map((t) => ({ ...t, state: "done" }));
    return { ...dag, status: "done", tasks: [...kept, ...lanes] };
}
const dagMotionLanesPrint = (dag) => `${dag?.status}|${(dag?.tasks ?? []).map((t) => `${t.id}:${t.state}`).join(",")}`;
const DAG_MOTION_TASK_COUNT = DAG_MOTION_TASKS.length + DAG_MOTION_LANES * DAG_MOTION_LANE_LEN;

// F17 at 1000x700, then F18 at 1600x950, on the scenario's open DAG
async function dagMotionViewport(h, ctx, rec) {
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_SHORT);
    const drawer = await polishWaitFor(h, `${RV_RAIL}?.getAttribute("data-timeline-rail") === "drawer"`, 5000);
    await polishNap(600);
    const collapsed = await h.ev(DAG_MOTION_DRAWER_READ);
    await h.ev(`${RV_RAIL}?.querySelector('button[aria-label="Expand lifecycle"]')?.click()`);
    await polishWaitFor(h, `(${RV_RAIL}?.querySelectorAll("[data-timeline-row]").length ?? 0) > 0`, 5000);
    // the drawer animates open, then the graph refits to the shorter pane
    await polishNap(900);
    await dagPeekSettled(h);
    const d = await h.ev(DAG_MOTION_DRAWER_READ);
    await h.shot("cdp-shots/dag-motion-f17-drawer.png");
    // the review's defect: the drawer outgrew the graph and cut cards through
    rec(
        "5. F17: at 1000x700 the opened Lifecycle drawer draws no activity strip, leaves the graph pane taller than itself with every card inside it, and shows a whole row",
        drawer &&
            d.layout === "drawer" &&
            d.expanded === "true" &&
            !d.strip &&
            d.paneH > d.drawerH &&
            d.nodes > 0 &&
            d.cut.length === 0 &&
            d.rowsShown >= DAG_MOTION_DRAWER_MIN_ROWS,
        { open: d, collapsed }
    );

    // opened wide, then narrowed with no pan or zoom: the opening view refits to the smaller pane
    await rvCloseDag(h);
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_WIDE);
    await polishNap(600);
    const wide = await rvOpenDag(h, ctx.runId);
    await dagPeekSettled(h);
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_SHORT);
    await polishNap(900);
    await dagPeekSettled(h);
    const refit = await h.ev(`(() => {
        ${DAG_PEEK_LIB}
        const final = box(modal?.querySelector('[data-dag-node="final"]'));
        return { final, pane: box(pane), inside: inside(final, box(pane)), innerWidth };
    })()`);
    await h.shot("cdp-shots/dag-motion-f17-refit.png");
    rec(
        "6. F17: the DAG opened at 1600x950 and narrowed to 1000x700 without a pan or zoom keeps the Final node inside the graph pane",
        wide && refit.innerWidth === RV_SHORT.width && refit.inside,
        { wide, ...refit }
    );

    await rvCloseDag(h);
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_WIDE);
    let seeded = "ok";
    try {
        await seedDag(h, ctx, dagMotionLanes, dagMotionLanesPrint);
    } catch (e) {
        seeded = String(e?.message ?? e);
    }
    const reopened = await rvOpenDag(h, ctx.runId);
    // the tasks and the final node
    await polishWaitFor(h, `(${RV_MODAL}?.querySelectorAll("[data-dag-node]").length ?? 0) === ${DAG_MOTION_TASK_COUNT + 1}`, 10000);
    await dagPeekSettled(h);
    const fit = await h.ev(`(() => {
        ${DAG_PEEK_LIB}
        const p = box(pane);
        const nodes = [...(modal?.querySelectorAll("[data-dag-node]") ?? [])].map((n) => ({ id: n.getAttribute("data-dag-node"), box: box(n) }));
        return { pane: p, count: nodes.length, outside: nodes.filter((n) => !inside(n.box, p)).map((n) => n.id) };
    })()`);
    await h.shot("cdp-shots/dag-motion-f18-fit.png");
    rec(
        `7. F18: a done ${DAG_MOTION_TASK_COUNT}-task dag in lanes opens at 1600x950 with every card inside the graph pane`,
        seeded === "ok" && reopened && fit.count === DAG_MOTION_TASK_COUNT + 1 && fit.pane != null && fit.outside.length === 0,
        { seeded, reopened, ...fit }
    );
}

export const dagPeekScenario = {
    name: "dag-peek",
    surface: "jarvis",
    async arrange(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", DAG_PEEK_VIEWPORT);
        const ctx = await arrangeSheetDagRun(h, "dag-peek", DAG_PEEK_TASKS);
        if (ctx.arrangeError != null) return ctx;
        try {
            await waitForDispatch(h, ctx, "t-1");
            ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group.id;
            await seedDag(
                h,
                ctx,
                (dag) => ({
                    ...dag,
                    ...DAG_PEEK_CMDS,
                    final: null,
                    // t-4 pinned to a model off the workers route, so its card carries a tag chip
                    tasks: dag.tasks.map((t) =>
                        t.id === "t-2"
                            ? { ...t, state: "done" }
                            : t.id === "t-3"
                              ? { ...t, state: "failed", escalations: 0 }
                              : t.id === "t-4"
                                ? { ...t, runspec: { ...t.runspec, model: DAG_PEEK_TAG_MODEL } }
                                : t
                    ),
                }),
                dagPeekPrint
            );
            ctx.seeded = true;
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: fstHolds(ok), detail: JSON.stringify(detail) });
        const group = async () => (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
        const stateOf = (g, id) => (g?.tasks ?? []).find((t) => t.id === id);

        const openDag = `[...(document.querySelector("[data-run-sheet]")?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Open DAG")`;
        const sheet = await polishWaitFor(h, `!!${openDag}`, 15000);
        if (sheet) await h.ev(`${openDag}.click()`);
        const graph = await polishWaitFor(
            h,
            `document.querySelectorAll('[data-dag-modal-kind] [data-dag-node]').length === 5 && !!${DAG_PEEK_MODAL}?.querySelector("[data-dag-controls]")`,
            10000
        );
        const seeded = await group();
        rec(
            "0. t-1 dispatched, t-2 a done gate and t-3 failed, and the DAG opened from the run sheet with four tasks and the final node",
            () =>
                ctx.arrangeError == null &&
                ctx.opened?.ok === true &&
                ctx.dispatched &&
                ctx.seeded &&
                sheet &&
                graph &&
                stateOf(seeded, "t-2")?.state === "done" &&
                stateOf(seeded, "t-3")?.state === "failed",
            ctx.arrangeError ?? {
                runId: ctx.runId,
                dagId: ctx.dagId,
                opened: ctx.opened,
                dispatched: ctx.dispatched,
                sheet,
                graph,
                tasks: (seeded?.tasks ?? []).map((t) => [t.id, t.state]),
            }
        );
        if (!graph) return steps;

        // a. t-1's card beside its node, inside the pane, and the open moves nothing
        const before = await dagPeekSettled(h);
        const t1 = dagPeekTaskSel("t-1");
        const openedT1 = await dagPeekOpen(h, t1, "t-1");
        await polishNap(600);
        const a = await h.ev(dagPeekGeom(t1, "t-1"));
        await h.shot("cdp-shots/dag-peek-running.png");
        rec(
            "a. clicking t-1 opens its card beside the node, inside the graph pane, clear of the timeline rail and the controls; the pane and the viewport do not move",
            () =>
                openedT1 &&
                a.visible &&
                a.beside != null &&
                a.inPane &&
                a.clearRail &&
                a.clearControls &&
                fstSame(a.pane, before.pane) &&
                a.transform === before.transform,
            { before, a }
        );

        // b. the full description opens inside the card
        const toggled = await h.ev(`(() => {
            const b = [...(${dagPeekCard(t1)}?.querySelectorAll("button[aria-expanded]") ?? [])].find((x) => x.textContent.trim() === "Read the full description");
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await polishWaitFor(h, `(${dagPeekCard(t1)}?.textContent ?? "").includes("Done when:")`, 3000);
        const b = await h.ev(`(() => {
            const card = ${dagPeekCard(t1)};
            const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
            return {
                bullets: [...(card?.querySelectorAll("li") ?? [])].map(flat),
                doneWhen: flat(card).includes(${JSON.stringify(DAG_PEEK_DONE_WHEN.replace(/`/g, ""))}),
                less: [...(card?.querySelectorAll("button[aria-expanded='true']") ?? [])].some((x) => x.textContent.trim() === "Show less"),
                frame: ${DAG_PEEK_FRAME},
            };
        })()`);
        await h.shot("cdp-shots/dag-peek-description.png");
        rec(
            "b. Read the full description expands the bullets and the Done when line inside the card; the pane and the viewport still do not move",
            () =>
                toggled &&
                fstSame(b.bullets, DAG_PEEK_BULLETS) &&
                b.doneWhen &&
                b.less &&
                fstSame(b.frame.pane, before.pane) &&
                b.frame.transform === before.transform,
            { toggled, b, before }
        );

        // c. a second click on the open node closes its card
        await h.ev(dagPeekClickNode("t-1"));
        const closedT1 = await polishWaitFor(h, `!${dagPeekCard(t1)}`, 3000);
        rec("c. a second click on t-1 closes the card", () => closedT1, { closedT1 });

        // d. a done task's card: nothing waits on the human for it
        const t2 = dagPeekTaskSel("t-2");
        const openedT2 = await dagPeekOpen(h, t2, "t-2");
        const d = await h.ev(`({ bar: ${dagPeekBar(t2)} })`);
        await h.shot("cdp-shots/dag-peek-done.png");
        rec(
            "d. clicking t-2 opens a done task's card, which offers no action",
            () => openedT2 && Array.isArray(d.bar) && d.bar.length === 0,
            { openedT2, d }
        );

        // e. the failed task's card and its escalate panel
        const t3 = dagPeekTaskSel("t-3");
        const openedT3 = await dagPeekOpen(h, t3, "t-3");
        const bar3 = await h.ev(dagPeekBar(t3));
        await h.ev(`${dagPeekCard(t3)}?.querySelector('[data-dag-peek-action="escalate"]')?.click()`);
        const ESC = `${dagPeekCard(t3)}?.querySelector("[data-dag-peek-escalate]")`;
        const requeue = `[...(${ESC}?.querySelectorAll("button") ?? [])].find((x) => x.textContent.trim() === "Re-queue on model")`;
        const panel = await polishWaitFor(h, `!!${ESC}`, 3000);
        const disabledFirst = await h.ev(`${requeue}?.disabled ?? null`);
        await h.ev(`${ESC}?.querySelector('[data-testid="route-picker"]')?.click()`);
        const OPTION = `[...document.querySelectorAll('[data-testid^="route-option-"]')].find((o) => !/-(inherit|extra)$/.test(o.getAttribute("data-testid")) && !o.hasAttribute("data-refused"))`;
        // a fresh app loads the model catalog on the picker's first open
        const listed = await polishWaitFor(h, `!!${OPTION}`, DAG_PEEK_CATALOG_MS);
        const route = await h.ev(`(() => {
            const o = ${OPTION};
            if (!o) return null;
            o.click();
            return o.getAttribute("data-testid");
        })()`);
        await polishWaitFor(h, `${requeue}?.disabled === false`, 3000);
        const enabledAfter = await h.ev(`${requeue}?.disabled === false`);
        await h.shot("cdp-shots/dag-peek-failed-escalate.png");
        await h.ev(`[...(${ESC}?.querySelectorAll("button") ?? [])].find((x) => x.textContent.trim() === "Cancel")?.click()`);
        const cancelled = await polishWaitFor(h, `!${ESC}`, 3000);
        const afterCancel = stateOf(await group(), "t-3");
        rec(
            "e. clicking t-3 opens its card with Retry (primary), Skip, Escalate…; Escalate… opens the panel with Re-queue on model disabled until a route is picked, and Cancel sends nothing",
            () =>
                openedT3 &&
                fstSame(bar3, [
                    { action: "retry", label: "Retry", primary: true },
                    { action: "skip", label: "Skip", primary: false },
                    { action: "escalate", label: "Escalate…", primary: false },
                ]) &&
                panel &&
                disabledFirst === true &&
                listed &&
                route != null &&
                enabledAfter &&
                cancelled &&
                afterCancel?.state === "failed" &&
                (afterCancel.escalations ?? 0) === 0,
            { openedT3, bar3, panel, disabledFirst, listed, route, enabledAfter, cancelled, t3: afterCancel && { state: afterCancel.state, escalations: afterCancel.escalations ?? 0 } }
        );

        // f. a refusal put in place on the page: the app's own RpcApi refuses the next DagActionCommand once, so no
        // retry reaches the engine. The module URL is the one the app loaded, so the import is its instance.
        const installed = await h.ev(`(async () => {
            const hits = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\\/wshclientapi\\.ts(\\?|$)/.test(n));
            const url = hits[hits.length - 1];
            if (!url) return { ok: false, why: "no wshclientapi module in the page's resources" };
            const { RpcApi } = await import(url);
            if (!RpcApi || typeof RpcApi.DagActionCommand !== "function") return { ok: false, why: "no RpcApi.DagActionCommand at " + url };
            const state = { calls: [] };
            RpcApi.DagActionCommand = function (client, data) {
                delete RpcApi.DagActionCommand;
                state.calls.push(data);
                return Promise.reject(new Error(${JSON.stringify(DAG_PEEK_REFUSAL)}));
            };
            window.${DAG_PEEK_REFUSAL_KEY} = { RpcApi, state };
            return { ok: true, url };
        })()`);
        await h.ev(`${dagPeekCard(t3)}?.querySelector('[data-dag-peek-action="retry"]')?.click()`);
        const ALERT = `${dagPeekCard(t3)}?.querySelector('[role="alert"]')`;
        await polishWaitFor(h, `!!${ALERT}`, 3000);
        const f = await h.ev(`({
            alert: (${ALERT}?.textContent ?? "").trim() || null,
            calls: window.${DAG_PEEK_REFUSAL_KEY}?.state.calls ?? null,
        })`);
        await h.shot("cdp-shots/dag-peek-action-error.png");
        const restored = await h.ev(DAG_PEEK_RESTORE);
        const afterRetry = stateOf(await group(), "t-3");
        rec(
            "f. a refused Retry on t-3 shows `retry t-3 failed: <reason>` on its card, the card having called the app's own RpcApi",
            () =>
                installed.ok &&
                f.alert === `retry t-3 failed: ${DAG_PEEK_REFUSAL}` &&
                f.calls?.length === 1 &&
                f.calls[0].action === "retry" &&
                f.calls[0].taskid === "t-3" &&
                restored === "restored" &&
                afterRetry?.state === "failed",
            { installed, f, restored, t3: afterRetry?.state }
        );

        // g. the waiting task
        const t4 = dagPeekTaskSel("t-4");
        const openedT4 = await dagPeekOpen(h, t4, "t-4");
        await polishWaitFor(h, `(${dagPeekCard(t4)}?.textContent ?? "").includes("Not dispatched yet")`, 3000);
        const g = await h.ev(`(${dagPeekCard(t4)}?.textContent ?? "").includes("Not dispatched yet")`);
        await h.shot("cdp-shots/dag-peek-waiting.png");
        rec("g. clicking t-4 opens the waiting card with Not dispatched yet", () => openedT4 && g, { openedT4, waiting: g });

        // h. panned against the pane's right edge, t-1's card flips to the node's left
        const reopened = await dagPeekOpen(h, t1, "t-1");
        await dagPeekSettled(h);
        const drags = [];
        let flip = await h.ev(dagPeekGeom(t1, "t-1"));
        for (let i = 0; i < 3 && flip.node && flip.pane && flip.pane.r - flip.node.r > DAG_PEEK_FLIP_PX; i++) {
            const from = await h.ev(DAG_PEEK_EMPTY);
            if (!from) break;
            const dx = flip.pane.r - DAG_PEEK_FLIP_PX / 2 - flip.node.r;
            drags.push({ from, dx });
            await dagPeekMouse(h, "mouseMoved", from);
            await dagPeekMouse(h, "mousePressed", from, 1);
            for (let s = 1; s <= 8; s++) {
                await dagPeekMouse(h, "mouseMoved", { x: Math.round(from.x + (dx * s) / 8), y: from.y }, 1);
            }
            await dagPeekMouse(h, "mouseReleased", { x: Math.round(from.x + dx), y: from.y });
            await polishNap(300);
            flip = await h.ev(dagPeekGeom(t1, "t-1"));
        }
        await polishNap(300);
        flip = await h.ev(dagPeekGeom(t1, "t-1"));
        await h.shot("cdp-shots/dag-peek-flipped.png");
        rec(
            "h. panned until t-1 is within 200px of the pane's right edge, its card sits left of the node, inside the pane and clear of the controls",
            () =>
                reopened &&
                flip.visible &&
                flip.pane.r - flip.node.r <= DAG_PEEK_FLIP_PX &&
                flip.card.r <= flip.node.l &&
                flip.inPane &&
                flip.clearControls,
            { reopened, drags, flip }
        );
        await h.ev(`${DAG_PEEK_MODAL}?.querySelector('[aria-label="Fit graph"]')?.click()`);
        await dagPeekSettled(h);

        // i. the final stage's card
        const openedFinal = await dagPeekOpen(h, DAG_PEEK_FINAL_SEL, "final");
        await polishNap(600);
        const iGeom = await h.ev(dagPeekGeom(DAG_PEEK_FINAL_SEL, "final"));
        const rows = await h.ev(`[...(${dagPeekCard(DAG_PEEK_FINAL_SEL)}?.querySelectorAll("[data-final-step]") ?? [])].map((s) => ({
            key: s.getAttribute("data-final-step"),
            command: s.querySelector("span[title]")?.getAttribute("title") ?? null,
        }))`);
        await h.shot("cdp-shots/dag-peek-final.png");
        rec(
            "i. clicking the final node opens its card with rows tree, check, verify, final, verifier, each with its command, inside the pane and clear of the rail and the controls",
            () =>
                openedFinal &&
                fstSame(rows.map((r) => r.key), ["tree", "check", "verify", "final", "verifier"]) &&
                rows.every((r) => r.command) &&
                iGeom.visible &&
                iGeom.inPane &&
                iGeom.clearRail &&
                iGeom.clearControls,
            { openedFinal, rows, geom: iGeom }
        );

        // i2. the final card's Lifecycle: empty while the stage has not run, then the stage's own events only
        const finalBefore = await h.ev(dagPeekLifecycle(DAG_PEEK_FINAL_SEL));
        const railLive = await polishWaitFor(h, DAG_PEEK_RAIL_LIVE, 10000);
        await dagPeekPublish(h, ctx, DAG_PEEK_FINAL_EVENTS);
        await polishWaitFor(h, dagPeekLifecycleRows(DAG_PEEK_FINAL_SEL, DAG_PEEK_FINAL_TITLES.length), 3000);
        const finalAfter = await h.ev(dagPeekLifecycle(DAG_PEEK_FINAL_SEL));
        await h.shot("cdp-shots/dag-peek-final-lifecycle.png");
        rec(
            "i2. the final card's Lifecycle says the stage has not run, then lists the verifier's session and the held land newest first, without the plan reviewer's session",
            () =>
                finalBefore.present &&
                finalBefore.empty === DAG_PEEK_FINAL_EMPTY &&
                railLive &&
                fstSame(finalAfter.titles, DAG_PEEK_FINAL_TITLES) &&
                finalAfter.count === `${DAG_PEEK_FINAL_TITLES.length} events`,
            { finalBefore, railLive, finalAfter }
        );

        // j. Esc closes the card before it closes the modal
        await h.ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
        const escClosed = await polishWaitFor(h, `!${dagPeekCard(DAG_PEEK_FINAL_SEL)}`, 3000);
        const modalStays = await h.ev(`${DAG_PEEK_MODAL} != null`);
        rec("j. Esc closes the card and leaves the modal open", () => escClosed && modalStays, { escClosed, modalStays });

        // k. a click on the graph's background closes the card
        const reopenedFinal = await dagPeekOpen(h, DAG_PEEK_FINAL_SEL, "final");
        const bgAt = await h.ev(DAG_PEEK_EMPTY);
        if (bgAt) {
            await dagPeekMouse(h, "mouseMoved", bgAt);
            await dagPeekMouse(h, "mousePressed", bgAt, 1);
            await dagPeekMouse(h, "mouseReleased", bgAt);
        }
        const paneClosed = await polishWaitFor(h, `!${dagPeekCard(DAG_PEEK_FINAL_SEL)}`, 3000);
        const modalAfterPane = await h.ev(`${DAG_PEEK_MODAL} != null`);
        rec(
            "k. reopened, the final card closes on a background click, and the modal stays",
            () => reopenedFinal && bgAt != null && paneClosed && modalAfterPane,
            { reopenedFinal, bgAt, paneClosed, modalAfterPane }
        );

        // l. hovering a node opens nothing
        const nodeAt = await h.ev(`(() => {
            const r = ${DAG_PEEK_MODAL}?.querySelector('[data-dag-node="t-3"]')?.getBoundingClientRect();
            return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
        })()`);
        if (nodeAt) await dagPeekMouse(h, "mouseMoved", nodeAt);
        await polishNap(DAG_PEEK_HOVER_MS);
        const hoverCard = await h.ev(dagPeekAnyCard);
        if (bgAt) await dagPeekMouse(h, "mouseMoved", bgAt);
        rec("l. hovering a node for 700ms opens nothing", () => nodeAt != null && hoverCard === false, { nodeAt, hoverCard });

        // the tagged card: its chip names the model only and passes the floor on one line, who pinned it is in the
        // card's aria-label, and the card keeps an untagged card's height
        const chip = await paintEval(h, `
            const card = (id) => ${DAG_PEEK_MODAL}?.querySelector('[data-dag-node="' + id + '"]');
            const tag = card("t-4")?.querySelector("[data-dag-node-tag]");
            return {
                tag: tag?.textContent.trim() ?? null,
                aria: card("t-4")?.getAttribute("aria-label") ?? null,
                lines: tag ? tag.getClientRects().length : null,
                // nothing clipped inside the chip, and the chip inside its card
                fits: tag
                    ? tag.scrollWidth <= tag.clientWidth &&
                      tag.scrollHeight <= tag.clientHeight &&
                      tag.getBoundingClientRect().bottom <= card("t-4").getBoundingClientRect().bottom &&
                      tag.getBoundingClientRect().right <= card("t-4").getBoundingClientRect().right
                    : null,
                floor: floorWalk([tag ?? null]),
                heights: [card("t-4"), card("t-1")].map((c) => c?.getBoundingClientRect().height ?? null),
            };
        `);
        await h.shot(lookShot("dag-peek-tag"));
        rec(
            "m. a tagged card's chip names the model only and passes the floor on one line, and the card is as tall as an untagged one",
            () =>
                chip.tag === DAG_PEEK_TAG_MODEL &&
                (chip.aria ?? "").endsWith(`, ${DAG_PEEK_TAG_MODEL}, pinned`) &&
                chip.lines === 1 &&
                chip.fits &&
                floorOk(chip.floor) &&
                chip.heights[0] != null &&
                chip.heights[0] === chip.heights[1],
            { ...chip, floor: floorDetail(chip.floor) }
        );

        // n. t-3's popup carries its own lifecycle, newest first, and the rail follows the selection to Task · t-3
        await polishWaitFor(h, DAG_PEEK_RAIL_LIVE, 10000);
        await dagPeekPublish(h, ctx, DAG_PEEK_T3_EVENTS);
        const openedLc = await dagPeekOpen(h, t3, "t-3");
        await polishWaitFor(h, dagPeekLifecycleRows(t3, DAG_PEEK_T3_TITLES.length), 4000);
        await polishNap(400);
        const lc = await h.ev(dagPeekLifecycle(t3));
        const railTask = await h.ev(DAG_PEEK_RAIL_STATE);
        // every text node in the popup and the rail: over the floor, and none in muted grey
        const read = await paintEval(h, `
            const probe = document.createElement("span");
            probe.className = "text-muted";
            document.body.append(probe);
            const muted = getComputedStyle(probe).color;
            probe.remove();
            const roots = [${dagPeekCard(t3)}, ${DAG_PEEK_RAIL}];
            const mutedText = [];
            for (const root of roots) {
                if (!root) continue;
                const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                    const text = n.data.trim();
                    if (text && n.parentElement.getClientRects().length > 0 && getComputedStyle(n.parentElement).color === muted) {
                        mutedText.push(text.slice(0, 40));
                    }
                }
            }
            return { floor: floorWalk(roots), mutedText };
        `);
        await h.shot("cdp-shots/dag-peek-lifecycle.png");
        await h.ev(dagPeekClickNode("t-3"));
        const closedLc = await polishWaitFor(h, `!${dagPeekCard(t3)}`, 3000);
        await polishNap(300);
        const railAll = await h.ev(DAG_PEEK_RAIL_STATE);
        rec(
            "n. t-3's card lists its five events newest first with the two failures amber, at 11.5/13/12px; the rail switches to Task · t-3 showing only t-3's rows, and back to All when the card closes; no text in either is muted or under the floor",
            () =>
                openedLc &&
                fstSame(lc.titles, DAG_PEEK_T3_TITLES) &&
                fstSame(lc.attention, [true, true, false, false, false]) &&
                lc.count === `${DAG_PEEK_T3_TITLES.length} events` &&
                fstSame(lc.sizes, DAG_PEEK_ROW_SIZES) &&
                railTask.pressed.length === 1 &&
                railTask.pressed[0].startsWith("Task · t-3") &&
                railTask.tasks.length > 0 &&
                railTask.tasks.every((t) => t === "t-3") &&
                floorOk(read.floor) &&
                read.mutedText.length === 0 &&
                closedLc &&
                railAll.pressed.length === 1 &&
                railAll.pressed[0].startsWith("All"),
            { openedLc, lc, railTask, floor: floorDetail(read.floor), mutedText: read.mutedText, closedLc, railAll }
        );

        await dagPeekFinishedTask(h, ctx, rec);
        await dagPeekCardsAndKeys(h, ctx, rec);
        await dagPeekPhase3(h, ctx, rec);
        await dagPeekEnded(h, ctx, rec);
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.clearDeviceMetricsOverride").catch((e) => {
            console.error(`dag-peek teardown: clear the viewport override failed: ${e?.message ?? e}`);
        });
        // t-2's stand-in run is one of the dag's task runs, so the run cancel below cancels it
        await undoPageDag(h, ctx.runId).catch((e) => {
            console.error(`dag-peek teardown: undo the page dag failed: ${e?.message ?? e}`);
        });
        await teardownFixtureRun(h, ctx, "dag-peek", {
            what: "restore RpcApi.DagActionCommand",
            fn: () => h.ev(DAG_PEEK_RESTORE),
        });
        if (ctx.shotsDir) rmSync(ctx.shotsDir, { recursive: true, force: true });
    },
};

// t-2 finished and merged: a review note far past three lines, 8 minutes of work, and Verify output stored with the
// colour escapes the engine used to keep. Its run is a deferred stand-in, so the merged task has a branch to forget.
const DAG_PEEK_NOTE_LINES = 30;
const DAG_PEEK_NOTE = Array.from(
    { length: DAG_PEEK_NOTE_LINES },
    (_, i) => `line ${i + 1}: dag-peek's review note runs long, so the card shows its first three lines`
).join("\n");
const DAG_PEEK_WORKED_MS = 8 * 60_000;
const DAG_PEEK_ANSI = "\x1b[2m > \x1b[22mok\x1b[32m ✓\x1b[39m";
const DAG_PEEK_NOTE_CLAMP = 3;
const dagPeekT2Print = (dag) => {
    const t = (dag?.tasks ?? []).find((x) => x.id === "t-2");
    return JSON.stringify([t?.state, t?.merged, t?.runid, (t?.reviewnote ?? "").length, t?.firstactivity, t?.lastactivity, t?.verifyoutput]);
};
const DAG_PEEK_SHOT = "dag-peek-shot";
// a crop of the app as the one screenshot the seeded Final round kept
const DAG_PEEK_SHOT_CLIP = { x: 0, y: 0, width: 480, height: 320, scale: 1 };
const DAG_PEEK_GRAPH_KEYS = [
    ["k", "KeyK"],
    ["j", "KeyJ"],
    ["f", "KeyF"],
    ["+", "Equal"],
];
const DAG_PEEK_STATE = (dag) => dag?.status ?? "";
const DAG_PEEK_SEED_TRIES = 3;
const DAG_PEEK_SHOTS_LINK = `${DAG_PEEK_MODAL}?.querySelector("[data-dag-final-peek] [data-final-shots-link]")`;

// F7, F8, F6 on t-2's card at 1600x950
async function dagPeekFinishedTask(h, ctx, rec) {
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_WIDE);
    let seeded = "ok";
    try {
        const created = await h.rpc("createrun", {
            channelid: ctx.channelId,
            workspaceid: (await h.rpc("workspacelist", null))[0].workspacedata.oid,
            goal: "verify dag-peek: stand-in run of the merged t-2",
            runtime: "claude",
            mode: "quick",
            deferstart: true,
        });
        ctx.t2RunId = created.run.id;
        const first = Date.now() - 2 * DAG_PEEK_WORKED_MS;
        await seedDag(
            h,
            ctx,
            (dag) => ({
                ...dag,
                tasks: dag.tasks.map((t) =>
                    t.id === "t-2"
                        ? {
                              ...t,
                              state: "done",
                              merged: true,
                              runid: ctx.t2RunId,
                              reviewverdict: "pass",
                              reviewnote: DAG_PEEK_NOTE,
                              firstactivity: first,
                              lastactivity: first + DAG_PEEK_WORKED_MS,
                              verifyoutput: DAG_PEEK_ANSI,
                          }
                        : t
                ),
            }),
            dagPeekT2Print
        );
    } catch (e) {
        seeded = String(e?.message ?? e);
    }
    const t2 = dagPeekTaskSel("t-2");
    const opened = await dagPeekOpen(h, t2, "t-2");
    await polishWaitFor(
        h,
        `!!${dagPeekCard(t2)}?.querySelector("[data-peek-review-note]") && !!${dagPeekCard(t2)}?.querySelector("[data-peek-verify-tail]")`,
        5000
    );
    await polishNap(400);
    const card = await h.ev(`(() => {
        const card = ${dagPeekCard(t2)};
        const note = card?.querySelector("[data-peek-review-note]");
        const body = note?.closest(".overflow-y-auto");
        const verify = card?.querySelector('[data-dag-peek-verify="t-2"]');
        const r = (el) => (el ? el.getBoundingClientRect() : null);
        const b = r(body);
        const v = r(verify);
        const c = r(card);
        const meta = card?.querySelector("[data-peek-meta]");
        return {
            noteH: note ? Math.round(note.getBoundingClientRect().height) : null,
            lineH: note ? parseFloat(getComputedStyle(note).lineHeight) : null,
            toggle: card?.querySelector("[data-peek-review-toggle]") != null,
            scrollTop: body?.scrollTop ?? null,
            verifyInView: !!(b && v && c && v.top >= b.top - 1 && v.bottom <= b.bottom + 1 && v.bottom <= c.bottom + 1),
            activity: (card?.querySelector("[data-peek-activity]")?.textContent ?? "").trim(),
            meta: meta ? meta.textContent.trim() : null,
            tail: card?.querySelector("[data-peek-verify-tail]")?.textContent ?? null,
        };
    })()`);
    await h.shot("cdp-shots/dag-peek-f7-review-note.png");
    await h.ev(`${dagPeekCard(t2)}?.querySelector("[data-peek-review-toggle]")?.click()`);
    const grew = await polishWaitFor(
        h,
        `(${dagPeekCard(t2)}?.querySelector("[data-peek-review-note]")?.getBoundingClientRect().height ?? 0) > ${(card.noteH ?? 0) + 1}`,
        3000
    );
    const grownH = await h.ev(`Math.round(${dagPeekCard(t2)}?.querySelector("[data-peek-review-note]")?.getBoundingClientRect().height ?? 0)`);
    // the clamp back, so the card is its usual size for the steps after
    await h.ev(`${dagPeekCard(t2)}?.querySelector("[data-peek-review-toggle]")?.click()`);
    rec(
        "o. F7: t-2's 30-line review note shows at most three lines with Verify in view and nothing scrolled; Show the whole note grows it",
        () =>
            seeded === "ok" &&
            opened &&
            card.noteH != null &&
            card.noteH <= DAG_PEEK_NOTE_CLAMP * card.lineH + 2 &&
            card.toggle &&
            card.scrollTop === 0 &&
            card.verifyInView &&
            grew,
        { seeded, opened, noteH: card.noteH, lineH: card.lineH, toggle: card.toggle, scrollTop: card.scrollTop, verifyInView: card.verifyInView, grownH }
    );
    rec(
        "p. F8: the merged t-2, 8 minutes between its first and last activity, says how long it worked with no ago, and names no branch",
        () => card.activity.startsWith("worked") && !card.activity.includes("ago") && (card.meta == null || card.meta === ""),
        { activity: card.activity, meta: card.meta, runid: ctx.t2RunId }
    );
    rec(
        "q. F6: t-2's Verify output, stored with colour escapes, shows none of them",
        () =>
            card.tail != null &&
            card.tail.includes("ok") &&
            !card.tail.includes("\x1b") &&
            !card.tail.includes("[2m") &&
            !card.tail.includes("[22m"),
        { tail: card.tail }
    );
}

// F9, F23, F2 at 1600x950
async function dagPeekCardsAndKeys(h, ctx, rec) {
    const word = await h.ev(`(() => {
        const card = ${DAG_PEEK_MODAL}?.querySelector('[data-dag-node="t-4"]');
        const word = card?.querySelector("[data-dag-node-word]");
        const tag = card?.querySelector("[data-dag-node-tag]");
        const r = (el) => (el ? el.getBoundingClientRect() : null);
        const w = r(word);
        const c = r(card);
        const t = r(tag);
        return {
            word: word ? word.textContent.replace(/\\s+/g, " ").trim() : null,
            tag: tag?.textContent.trim() ?? null,
            unclipped: word ? word.scrollWidth <= word.clientWidth : null,
            inCard: !!(w && c && w.left >= c.left - 1 && w.right <= c.right + 1 && w.top >= c.top - 1 && w.bottom <= c.bottom + 1),
            beforeTag: !!(w && t && w.right <= t.left + 1),
        };
    })()`);
    rec(
        "r. F9: the tagged t-4 card shows its id and state word whole, inside the card, before the tag",
        () => (word.word ?? "").startsWith("t-4 · ") && word.tag != null && word.unclipped && word.inCard && word.beforeTag,
        word
    );

    const t3 = dagPeekTaskSel("t-3");
    const openedT3 = await dagPeekOpen(h, t3, "t-3");
    await h.ev(`${dagPeekCard(t3)}?.querySelector('[data-dag-peek-action="escalate"]')?.click()`);
    const ESC = `${dagPeekCard(t3)}?.querySelector("[data-dag-peek-escalate]")`;
    await polishWaitFor(h, `!!${ESC}?.querySelector("[data-route-picker-empty]")`, 3000);
    const empty = await h.ev(`(${ESC}?.querySelector("[data-route-picker-empty]")?.textContent ?? "").trim()`);
    await h.shot("cdp-shots/dag-peek-f23-escalate.png");
    await h.ev(`[...(${ESC}?.querySelectorAll("button") ?? [])].find((x) => x.textContent.trim() === "Cancel")?.click()`);
    await polishWaitFor(h, `!${ESC}`, 3000);
    rec("s. F23: t-3's Escalate… picker reads Pick a model before a route is picked", () => openedT3 && empty === "Pick a model", {
        openedT3,
        empty,
    });

    // with nothing over the graph a key moves the selection, so the check below is not vacuous
    const t1 = dagPeekTaskSel("t-1");
    const openedT1 = await dagPeekOpen(h, t1, "t-1");
    await polishWaitFor(h, `JSON.stringify(${RV_PRESSED}) === '["t-1"]'`, 3000);
    await rvKey(h, "j", "KeyJ");
    const moved = await polishWaitFor(h, `${RV_PRESSED}.length === 1 && ${RV_PRESSED}[0] !== "t-1"`, 3000);
    const afterJ = await h.ev(RV_PRESSED);

    let seeded = "ok";
    try {
        ctx.shotsDir = mkdtempSync(join(tmpdir(), "verify-dag-peek-shots-"));
        const { data } = await h.cdp("Page.captureScreenshot", { format: "png", clip: DAG_PEEK_SHOT_CLIP });
        writeFileSync(join(ctx.shotsDir, `${DAG_PEEK_SHOT}.png`), Buffer.from(data, "base64"));
        const final = {
            state: "unverified",
            round: 1,
            outdir: ctx.shotsDir.replace(/\\/g, "/"),
            shots: [{ name: DAG_PEEK_SHOT, files: [`${DAG_PEEK_SHOT}.png`] }],
            shotsmanifest: false,
        };
        // the blocked dag's watchdog tick after seedDag read the seed back may still move it, so seed until it shows
        for (let i = 0; i < DAG_PEEK_SEED_TRIES; i++) {
            await seedDag(h, ctx, (dag) => ({ ...dag, final }), (dag) => JSON.stringify([dag?.final?.state ?? null, dag?.final?.shots?.length ?? 0]));
            await dagPeekOpen(h, DAG_PEEK_FINAL_SEL, "final");
            if (await polishWaitFor(h, `!!${DAG_PEEK_SHOTS_LINK}`, 5000)) break;
        }
    } catch (e) {
        seeded = String(e?.message ?? e);
    }
    const openedFinal = await dagPeekOpen(h, DAG_PEEK_FINAL_SEL, "final");
    const LINK = DAG_PEEK_SHOTS_LINK;
    await polishWaitFor(h, `!!${LINK}`, 5000);
    await h.ev(`${LINK}?.click()`);
    const viewer = await polishWaitFor(h, `!!${FS_VIEWER}`, 5000);
    await polishNap(400);
    const before = await h.ev(`({ pressed: ${RV_PRESSED}, frame: ${DAG_PEEK_FRAME} })`);
    for (const [key, code] of DAG_PEEK_GRAPH_KEYS) {
        await rvKey(h, key, code);
        await polishNap(150);
    }
    await polishNap(500);
    const after = await h.ev(`({ viewer: !!${FS_VIEWER}, pressed: ${RV_PRESSED}, frame: ${DAG_PEEK_FRAME} })`);
    await h.shot("cdp-shots/dag-peek-f2-viewer-keys.png");
    await h.ev(`${FS_VIEWER}?.querySelector('button[aria-label="Close"]')?.click()`);
    const viewerClosed = await polishWaitFor(h, `!${FS_VIEWER}`, 3000);
    rec(
        "t. F2: with nothing over the graph j moves the selection off t-1; with the Final screenshots viewer over it, k, j, f and + leave the viewer open, the Final node selected and the viewport still",
        () =>
            openedT1 &&
            moved &&
            seeded === "ok" &&
            openedFinal &&
            viewer &&
            fstSame(before.pressed, ["final"]) &&
            after.viewer &&
            fstSame(after.pressed, before.pressed) &&
            after.frame.transform === before.frame.transform &&
            viewerClosed,
        { openedT1, afterJ, seeded, openedFinal, viewer, before, after, viewerClosed }
    );
}

// F16 at 1000x700, then F4 and F26 at 1600x950
const DAG_PEEK_SETUP_DETAIL = "setup: exit 1: npm ci found no package-lock.json";
const dagPeekText = (sel) => `(${dagPeekCard(sel)}?.textContent ?? "").replace(/\\s+/g, " ")`;

// The live-run review's phase 3 peek findings (Q13, Q6/Q7, Q3) at 1600, all page-only: t-3, which never had a run,
// failed at Setup with the reason on its task-failed event; t-2 a lane tip held behind t-1's Verify (a digest field
// no RPC writes); and a human's skip of t-3 as the engine's run event. undoPageDag puts the dag and the RPC back.
async function dagPeekPhase3(h, ctx, rec) {
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_WIDE);
    await polishNap(600);
    const tasks = { "t-1": { state: "verifying" }, "t-3": { state: "failed", runid: "", lastfailurekind: "setup" } };
    const gate = (mergestate) =>
        injectPageDag(h, ctx.runId, {
            tasks,
            digest: { "t-2": { mergestate, mergeheldby: mergestate === "held" ? "t-1" : undefined } },
        });
    const injected = await gate("held");
    await dagPeekPublish(h, ctx, [["task-failed", { taskid: "t-3", lastfailurekind: "setup", attempts: 1, detail: DAG_PEEK_SETUP_DETAIL }, 0]]);

    const t3 = dagPeekTaskSel("t-3");
    const openedT3 = await dagPeekOpen(h, t3, "t-3");
    await polishWaitFor(h, `${dagPeekText(t3)}.includes("Never dispatched")`, 4000);
    const setup = await h.ev(`(() => {
        const text = ${dagPeekText(t3)};
        return {
            detail: text.includes(${JSON.stringify(`last failure: setup · ${DAG_PEEK_SETUP_DETAIL}`)}),
            session: (${dagPeekCard(t3)}?.querySelector('[data-dag-peek-session="Worker"]')?.textContent ?? "").trim(),
        };
    })()`);
    await h.shot("cdp-shots/dag-peek-p3-setup.png");
    rec(
        "x. Q13: t-3, failed at Setup before any worker, shows its task-failed detail on the last failure row and reads Never dispatched · failed at setup",
        () => injected === "ok" && openedT3 && setup.detail && setup.session === "Never dispatched · failed at setup",
        { injected, openedT3, setup }
    );
    await h.ev(dagPeekClickNode("t-3"));
    await polishWaitFor(h, `!${dagPeekCard(t3)}`, 3000);

    // a ready tip offers Merge, so the held tip's missing button is the gate's doing
    const t2 = dagPeekTaskSel("t-2");
    const readyInjected = await gate("ready");
    const openedReady = await dagPeekOpen(h, t2, "t-2");
    await polishWaitFor(h, `${dagPeekBar(t2)}.some((b) => b.action === "merge")`, 4000);
    const ready = await h.ev(dagPeekBar(t2));
    await gate("held");
    await polishWaitFor(h, `${dagPeekText(t2)}.includes("waits on t-1's Verify")`, 4000);
    const held = await h.ev(`({ bar: ${dagPeekBar(t2)}, text: ${dagPeekText(t2)} })`);
    await h.shot("cdp-shots/dag-peek-p3-held.png");
    rec(
        "y. Q6, Q7: the held tip t-2 offers no Merge (a ready one does) and its card reads merge ready · waits on t-1's Verify",
        () =>
            readyInjected === "ok" &&
            openedReady &&
            ready.some((b) => b.action === "merge") &&
            !held.bar.some((b) => b.action === "merge") &&
            held.text.includes("merge ready · waits on t-1's Verify"),
        { ready, held }
    );
    await h.ev(dagPeekClickNode("t-2"));
    await polishWaitFor(h, `!${dagPeekCard(t2)}`, 3000);

    await dagPeekPublish(h, ctx, [["task-skipped", { taskid: "t-3", by: "human" }, 0]]);
    const openedSkip = await dagPeekOpen(h, t3, "t-3");
    const skipRow = `[...(${dagPeekCard(t3)}?.querySelectorAll("[data-dag-peek-lifecycle-row]") ?? [])].map((r) => (r.textContent ?? "").replace(/\\s+/g, " ").trim()).find((t) => t.includes("Skipped")) ?? null`;
    await polishWaitFor(h, `${skipRow} != null`, 4000);
    const skipped = await h.ev(skipRow);
    await h.shot("cdp-shots/dag-peek-p3-skipped.png");
    rec(
        "z. Q3: after a human's task-skipped for t-3, its Lifecycle shows Skipped · you skipped t-3",
        () => openedSkip && skipped != null && skipped.includes("you skipped t-3"),
        { openedSkip, skipped }
    );
    await h.ev(dagPeekClickNode("t-3"));
    await polishWaitFor(h, `!${dagPeekCard(t3)}`, 3000);
    await undoPageDag(h, ctx.runId);
    await polishNap(600);
}

async function dagPeekEnded(h, ctx, rec) {
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_SHORT);
    await polishNap(900);
    const t4 = dagPeekTaskSel("t-4");
    const openedT4 = await dagPeekOpen(h, t4, "t-4");
    await dagPeekSettled(h);
    await polishNap(400);
    const geom = await h.ev(dagPeekGeom(t4, "t-4"));
    await h.shot("cdp-shots/dag-peek-f16-short.png");
    rec(
        "u. F16: at 1000x700 t-4's card stays clear of the zoom controls",
        () => openedT4 && geom.visible && geom.card != null && geom.controls != null && geom.clearControls,
        { openedT4, innerWidth: await h.ev("innerWidth"), ...geom }
    );
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_WIDE);
    await polishNap(900);

    let seeded = "ok";
    try {
        await seedDag(h, ctx, (dag) => ({ ...dag, status: "cancelled" }), DAG_PEEK_STATE);
    } catch (e) {
        seeded = String(e?.message ?? e);
    }
    const T3_NODE = `${DAG_PEEK_MODAL}?.querySelector('[data-dag-node="t-3"]')`;
    await polishWaitFor(h, `${rvFact(T3_NODE)} === "run cancelled"`, 10000);
    const t3 = dagPeekTaskSel("t-3");
    const openedT3 = await dagPeekOpen(h, t3, "t-3");
    await polishNap(300);
    const ended = await h.ev(`({
        bar: ${dagPeekBar(t3)},
        fact: ${rvFact(T3_NODE)},
        chips: [...(${DAG_PEEK_MODAL}?.querySelectorAll('button[title^="Select the next task that is"]') ?? [])].map((b) => b.textContent.trim()),
    })`);
    await h.shot("cdp-shots/dag-peek-f4-cancelled.png");
    rec(
        "v. F4: on a cancelled dag t-3's card offers no Retry, Skip or Escalate, its card's fact reads run cancelled, and no header chip says need you",
        () =>
            seeded === "ok" &&
            openedT3 &&
            !ended.bar.some((b) => ["retry", "skip", "escalate"].includes(b.action)) &&
            ended.fact === "run cancelled" &&
            ended.chips.length > 0 &&
            ended.chips.every((c) => !c.includes("need you")),
        { seeded, openedT3, ...ended }
    );

    const PET = `document.querySelector("[data-pet-sprite]")`;
    const sprite = `(${PET} ? getComputedStyle(${PET}).visibility : null)`;
    const overModal = await h.ev(sprite);
    const closed = await rvCloseDag(h);
    await polishWaitFor(h, `${sprite} === "visible"`, 3000);
    const afterClose = await h.ev(sprite);
    rec(
        "w. F26: the avatar's sprite is hidden while the DAG modal is open, and visible once it closes",
        () => overModal === "hidden" && closed && afterClose === "visible",
        { overModal, closed, afterClose }
    );
}
