// Run scenarios: DAG lifecycle and peek, run sheet, Final stage, plan review, model picks, task detail.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
    COCKPIT_LEAD_CARD,
    FINAL_SHOTS_UICTX,
    FST_CHECK,
    FST_DETAIL,
    FST_UNVERIFIED,
    LOOK_LIB,
    MIN_FONT_PX,
    MODELS_PLAN,
    MODELS_VIEWPORT,
    NEW_RUN,
    NEW_RUN_FIELD,
    NEW_RUN_GOAL,
    NEW_RUN_LIST,
    OBS_NARROW,
    OBS_WIDE,
    PALETTE_INPUT,
    PALETTE_STATE,
    PEEKS_ESC,
    PROFILE_MODAL,
    RAIL_VISIBLE_KEY,
    RUN_SHEET,
    RUN_SHEET_POLISH_TASKS,
    TREE_RAIL_FIXTURE,
    TREE_RAIL_LEAD_ID,
    UI_ROUTE,
    arrangeFixtureRun,
    arrangeSheetDagRun,
    bsPublishStatus,
    bsReveal,
    bsShowPane,
    channelRuns,
    clickByText,
    closeProfile,
    deleteChannelWorkerBlocks,
    flatText,
    floorDetail,
    floorOk,
    floorStep,
    fstShow,
    fstWriteRun,
    holdRpc,
    lookEval,
    lookOpen,
    lookPlaceholders,
    lookShot,
    openPalette,
    openProfileOn,
    paintEval,
    paletteKey,
    paletteStateWhen,
    placeholderStep,
    polishNap,
    polishReload,
    polishWaitFor,
    releaseRpc,
    reloadApp,
    restoreLocalStorage,
    seedDag,
    seedFinalShots,
    setInputExpr,
    teardownFixtureRun,
    treeRailRoster,
    waitForDispatch,
    waitForProjectInConfig,
    waveService,
} from "./scenarios-shared.mjs";

const workerOf = (phase) => phase && phase.workerorefs && phase.workerorefs[0];

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
        return steps;
    },
    async teardown(h, ctx) {
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

// the root engine trees live under, as pkg/orchestrate/worktreeroot.go resolves it from os.UserCacheDir
function arcWorktreeRoot() {
    const cache =
        process.platform === "win32"
            ? process.env.LOCALAPPDATA
            : process.platform === "darwin"
              ? join(homedir(), "Library", "Caches")
              : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    return join(cache, "arc-wt");
}

// The lead card's merge gate (effort 4d24005d): a finished lane tip the engine has not landed reads live, toned wait,
// with how long it has waited, opens its ended worker, and stays out of the cancel count. The run lands in the
// checkout of a temp repository whose index holds a staged file, so the engine holds every merge and the tip stays
// ready. Both tasks point at deferred quick runs that never start; marking t-1's run done lets the engine move the
// task to done itself, which writes the task-done event the gate's age is read from. t-2 stays running.
const MERGE_GATE_LEAD = "merge-gate lead";
const MERGE_GATE_LABEL = "merge gate lane";
const MERGE_GATE_LIVE_LABEL = "running lane";
const MERGE_GATE_TASKS = [
    ["t-1", MERGE_GATE_LABEL],
    ["t-2", MERGE_GATE_LIVE_LABEL],
].map(([id, label]) => ({ id, label, description: "do nothing, stop immediately", deps: [], state: "" }));
// the engine ticks a dag at most every 30 seconds, and the card then waits on the run's digest
const MERGE_GATE_WAIT_MS = 90_000;
const mergeGateRow = (label) =>
    `[...(${COCKPIT_LEAD_CARD}?.querySelectorAll("[data-row-key]") ?? [])]` +
    `.find((r) => r.textContent.includes(${JSON.stringify(label)}))`;
// the row's dot, tag and the card's cancel panel text, as the assertions read them
const MERGE_GATE_READ = `(() => {
    const row = ${mergeGateRow(MERGE_GATE_LABEL)};
    const grid = row?.firstElementChild;
    return {
        row: row != null,
        dot: grid?.children[0]?.className ?? null,
        tag: grid?.children[2]?.textContent.trim() ?? null,
        live: ${mergeGateRow(MERGE_GATE_LIVE_LABEL)} != null,
    };
})()`;

// a deferred quick run in the fixture's channel: a task's child run that never starts a session
async function mergeGateStandIn(h, ctx, taskId) {
    const wslist = await h.rpc("workspacelist", null);
    const created = await h.rpc("createrun", {
        channelid: ctx.channelId,
        workspaceid: wslist[0].workspacedata.oid,
        goal: `verify merge-gate: stand-in child run of ${taskId}`,
        runtime: "claude",
        mode: "quick",
        deferstart: true,
    });
    return created.run.id;
}

export const leadCardMergeGate = {
    name: "lead-card-merge-gate",
    surface: "cockpit",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-merge-gate-"));
        const ctx = { cwd };
        try {
            fstGitInit(cwd);
            // a staged file: the engine will not squash a lane over it, so it holds the merge
            writeFileSync(join(cwd, "held.txt"), "staged by the merge-gate fixture\n");
            execFileSync("git", ["add", "held.txt"], { cwd, stdio: "pipe" });
            await arrangeFixtureRun(h, ctx, "merge-gate", MERGE_GATE_LEAD, undefined, { landing: "checkout" });
            ctx.gateRun = await mergeGateStandIn(h, ctx, "t-1");
            ctx.liveRun = await mergeGateStandIn(h, ctx, "t-2");
            await h.rpc("dagsubmit", {
                channelid: ctx.channelId,
                runid: ctx.runId,
                title: "verify merge-gate",
                parallelism: 1,
                tasks: MERGE_GATE_TASKS,
            });
            ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.oid;
            // over whatever the engine dispatched first: teardown deletes a real worker's block with the channel's
            const runOf = { "t-1": ctx.gateRun, "t-2": ctx.liveRun };
            await seedDag(
                h,
                ctx,
                (dag) => ({
                    ...dag,
                    mergerequired: true,
                    tasks: dag.tasks.map((t) => ({ ...t, state: "running", runid: runOf[t.id] })),
                }),
                (dag) => JSON.stringify([dag?.mergerequired, (dag?.tasks ?? []).map((t) => [t.id, t.state, t.runid])])
            );
            await fstWriteRun(h, ctx.gateRun, (r) => ({ ...r, status: "done", completedts: Date.now() }));
            // the merge gate needs t-1 done by the engine (its task-done event) and the merge held
            const start = Date.now();
            while (Date.now() - start < MERGE_GATE_WAIT_MS) {
                const group = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
                ctx.gateState = group?.tasks?.find((t) => t.id === "t-1")?.state;
                if (ctx.gateState === "done") break;
                await new Promise((r) => setTimeout(r, 1000));
            }
            ctx.doneMs = Date.now() - start;
            // the fixture roster is read once at boot
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
            await h.goto("cockpit");
            ctx.shown = await h.ev(`(async () => {
                for (let i = 0; i < ${MERGE_GATE_WAIT_MS / 500}; i++) {
                    const r = ${MERGE_GATE_READ};
                    if (r.row && /^merge waiting \\d/.test(r.tag ?? "")) return r;
                    await new Promise((res) => setTimeout(res, 500));
                }
                return ${MERGE_GATE_READ};
            })()`);
            // let the card's enter motion settle
            await new Promise((r) => setTimeout(r, 800));
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const shown = ctx.shown ?? {};
        rec(
            "0. the engine finishes t-1 and the lead card draws its row",
            ctx.arrangeError == null && ctx.gateState === "done" && shown.row === true,
            ctx.arrangeError ?? `t-1 ${ctx.gateState} after ${ctx.doneMs}ms; ${JSON.stringify(shown)}`
        );
        await h.shot("cdp-shots/lead-card-merge-gate.png");
        rec(
            "1. the merge-ready row is tagged with the gate's age",
            /^merge waiting \d+(s|m|h\d+m)$/.test(shown.tag ?? ""),
            `tag=${JSON.stringify(shown.tag)}`
        );
        rec(
            "2. its dot is the hollow wait dot, not the pulsing run dot",
            (shown.dot ?? "").includes("--color-muted") && !(shown.dot ?? "").includes("pulse-dot"),
            `dot=${shown.dot}`
        );

        // the cancel panel counts the running row and leaves the gate out
        const cancel = await h.ev(`(async () => {
            const card = ${COCKPIT_LEAD_CARD};
            const btn = card && [...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel run");
            if (!btn) return { error: "no Cancel run button on the card" };
            btn.click();
            await new Promise((r) => setTimeout(r, 400));
            const text = [...card.querySelectorAll("span")].map((s) => s.textContent).find((t) => t.startsWith("Stop "));
            return { text: text ?? null };
        })()`);
        await h.shot("cdp-shots/lead-card-merge-gate-cancel.png");
        rec(
            "3. the cancel panel counts only the running task",
            shown.live === true && /^Stop 1 running tasks/.test(cancel.text ?? ""),
            JSON.stringify({ live: shown.live, ...cancel })
        );
        await h.ev(`(() => {
            const card = ${COCKPIT_LEAD_CARD};
            [...(card?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Keep running")?.click();
        })()`);

        // focusing the row offers Open, which lands on the ended worker's transcript on the Agent surface
        const opened = await h.ev(`(async () => {
            const row = ${mergeGateRow(MERGE_GATE_LABEL)};
            if (!row) return { error: "no merge-ready row" };
            row.click();
            await new Promise((r) => setTimeout(r, 400));
            const sub = row.querySelector(":scope > div:nth-child(2) > div")?.textContent.trim() ?? null;
            const open = [...row.querySelectorAll("button")].find((b) => b.textContent.includes("Open"));
            if (!open) return { sub, error: "no Open button on the focused row" };
            open.click();
            await new Promise((r) => setTimeout(r, 1200));
            return { sub };
        })()`);
        const surface = await h.activeSurfaceLabel();
        const header = await h.ev(`document.body.innerText.includes(${JSON.stringify(MERGE_GATE_LABEL)})`);
        await h.shot("cdp-shots/lead-card-merge-gate-open.png");
        rec(
            "4. Open on the merge-ready row shows its ended worker on the Agent surface",
            opened.error == null &&
                /merge ready$/.test(opened.sub ?? "") &&
                surface === SURFACE_LABEL.agent &&
                header === true,
            JSON.stringify({ ...opened, surface, header })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "lead-card-merge-gate");
    },
};

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
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "run-sheet-polish");
    },
};

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

// A finished orchestrator run's dock carries its configuration forward: a Ran with row over the dock's buttons
// whose Use for new runs writes the project's Profile override, then links to that Profile. The run is cancelled
// first, which stops its dag and the t-1 worker, then stored as done so the sheet draws the finished dock. Its dir
// is registered as a project, as a real run's is, or the Profile the confirmation opens has no project to show.
const RUN_CARRY_PROJECT = "verify-run-sheet-carry";
const RUN_CARRY_ROW = `document.querySelector("[data-run-sheet] [data-run-sheet-carry]")`;

export const runSheetCarryScenario = {
    name: "run-sheet-carry",
    surface: "jarvis",
    async arrange(h) {
        const ctx = await arrangeSheetDagRun(h, "run-sheet-carry", RUN_SHEET_POLISH_TASKS);
        if (ctx.arrangeError != null) return ctx;
        try {
            await h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.runId });
            await h.rpc("createproject", { name: RUN_CARRY_PROJECT, path: ctx.cwd });
            ctx.projectMade = true;
            await waitForProjectInConfig(h, RUN_CARRY_PROJECT);
            const oref = `run:${ctx.runId}`;
            const stored = await waveService(h, "object", "GetObject", [oref]);
            await waveService(
                h,
                "object",
                "UpdateObject",
                [{ ...stored, otype: "run", status: "done" }, false],
                FINAL_SHOTS_UICTX
            );
            // the Brief reads a boot-primed snapshot, so the done status and the project need a reload and a reopen
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
            await h.goto("jarvis");
            ctx.opened = await h.ev(`(async () => {
                for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                return window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)});
            })()`);
            ctx.rowShown = await h.ev(`(async () => {
                for (let i = 0; i < 60 && !${RUN_CARRY_ROW}; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                return !!${RUN_CARRY_ROW};
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
            "0. the finished run's sheet shows the Ran with row in its dock",
            ctx.arrangeError == null && ctx.opened?.ok === true && ctx.rowShown === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, opened: ctx.opened, row: ctx.rowShown })
        );
        if (ctx.arrangeError != null || ctx.rowShown !== true) return steps;

        const read = () =>
            h.ev(`(() => {
                const row = ${RUN_CARRY_ROW};
                const btn = row?.querySelector("button");
                const dock = row?.parentElement;
                return {
                    text: row?.innerText ?? "",
                    button: btn?.textContent.trim() ?? null,
                    title: btn?.getAttribute("title") ?? null,
                    dockButtons: [
                        ...(dock?.querySelectorAll(":scope > div:not([data-run-sheet-carry]) button") ?? []),
                    ].map((b) => b.textContent.trim()),
                };
            })()`);
        const before = await read();
        rec(
            "1. the row names the run's settings and offers Use for new runs, pointing at the Profile",
            before.text.includes("Ran with") &&
                before.text.includes("orchestrator") &&
                before.text.includes("parallelism 1") &&
                before.button === "Use for new runs" &&
                (before.title ?? "").includes("Profile"),
            JSON.stringify(before)
        );
        rec(
            "2. the dock's button row no longer carries the save",
            before.dockButtons.includes("Open DAG") && !before.dockButtons.some((t) => /project defaults|new runs/i.test(t)),
            JSON.stringify(before.dockButtons)
        );
        await h.shot("cdp-shots/run-sheet-carry-1-idle.png");

        await h.ev(`${RUN_CARRY_ROW}.querySelector("button").click()`);
        const saved = await h.ev(`(async () => {
            for (let i = 0; i < 40; i++) {
                const t = ${RUN_CARRY_ROW}?.querySelector("button")?.textContent.trim();
                if (t === "Saved to this project's Profile") return t;
                await new Promise((r) => setTimeout(r, 250));
            }
            return ${RUN_CARRY_ROW}?.innerText ?? null;
        })()`);
        const profile = await h.rpc("getjarvisprofile", { channelid: ctx.channelId });
        const o = profile?.override ?? {};
        rec(
            "3. a click saves: the row confirms and the project's override holds the run's shape and parallelism",
            saved === "Saved to this project's Profile" && o.defaultmode === "orchestrator" && o.parallelism === 1,
            JSON.stringify({ saved, override: o })
        );
        await h.shot("cdp-shots/run-sheet-carry-2-saved.png");

        await h.ev(`${RUN_CARRY_ROW}.querySelector("button").click()`);
        const modal = await h.ev(`(async () => {
            for (let i = 0; i < 20; i++) {
                const m = document.querySelector('[data-jarvis-brief-modal="profile"]');
                if (m) return { scope: m.getAttribute("data-jarvis-profile-scope") };
                await new Promise((r) => setTimeout(r, 250));
            }
            return null;
        })()`);
        rec("4. the confirmation opens this project's Profile", modal?.scope === "project", JSON.stringify(modal));
        await h.shot("cdp-shots/run-sheet-carry-3-profile.png");
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(
            h,
            ctx,
            "run-sheet-carry",
            ctx.projectMade
                ? { what: "remove the project", fn: () => h.rpc("deleteproject", { name: RUN_CARRY_PROJECT }) }
                : undefined
        );
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
            const line = () =>
                [...(document.querySelector("[data-dag-modal-kind]")?.querySelectorAll("div") ?? [])].find(
                    (d) => d.children.length === 0 && text(d).startsWith("parallelism")
                );
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
            what: "restore the rail's visibility",
            fn: () => h.ev(restoreLocalStorage(RAIL_VISIBLE_KEY, ctx.prevRail)),
        });
    },
};
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
            const nextEl = [...root.querySelectorAll("div")].find(
                (d) => d.children.length === 1 && d.firstElementChild.textContent === "next: "
            );
            return {
                strip: root.querySelector("[role=img]")?.getAttribute("aria-label") ?? null,
                rows: root.querySelectorAll("[data-run-sheet-row]").length,
                verb: root.querySelector("[data-run-sheet-verb]")?.textContent.trim() ?? null,
                next: nextEl ? nextEl.textContent.slice("next: ".length).trim() : null,
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
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "dag-observability");
    },
};

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
const DAG_PEEK_MODAL = `document.querySelector("[data-dag-modal-kind]")`;
const dagPeekTaskSel = (id) => `[data-dag-task-peek="${id}"]`;
const DAG_PEEK_FINAL_SEL = "[data-dag-final-peek]";
const dagPeekCard = (sel) => `${DAG_PEEK_MODAL}?.querySelector(${JSON.stringify(sel)})`;
const dagPeekClickNode = (id) => `${DAG_PEEK_MODAL}?.querySelector('[data-dag-node="${id}"]')?.click()`;
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
const DAG_PEEK_RAIL = `${DAG_PEEK_MODAL}?.querySelector("[data-timeline-rail]")`;
// the rail's history has loaded: a run:event published before that is overwritten by the load
const DAG_PEEK_RAIL_LIVE = `(${DAG_PEEK_RAIL}?.textContent ?? "").includes("● live")`;
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

async function dagPeekOpen(h, sel, nodeId) {
    if (!(await h.ev(`!!${dagPeekCard(sel)}`))) await h.ev(dagPeekClickNode(nodeId));
    return polishWaitFor(h, `!!${dagPeekCard(sel)}`, 4000);
}

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

async function dagPeekPublish(h, ctx, events) {
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
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "dag-motion");
    },
};

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

        // the tagged card: its chip passes the floor on one line, and the card keeps an untagged card's height
        const chip = await paintEval(h, `
            const card = (id) => ${DAG_PEEK_MODAL}?.querySelector('[data-dag-node="' + id + '"]');
            const tag = [...(card("t-4")?.querySelectorAll("span") ?? [])].find((s) => /pinned$/.test((s.textContent || "").trim()));
            return {
                tag: tag?.textContent.trim() ?? null,
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
            "m. a tagged card's chip passes the floor on one line, and the card is as tall as an untagged one",
            () => chip.tag != null && chip.lines === 1 && chip.fits && floorOk(chip.floor) && chip.heights[0] != null && chip.heights[0] === chip.heights[1],
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
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "dag-peek", {
            what: "restore RpcApi.DagActionCommand",
            fn: () => h.ev(DAG_PEEK_RESTORE),
        });
    },
};

// --- dag-reviewer-session: the task peek's reviewer box ---------------------------------------------------------
// t-1 is seeded reviewing, its worker and reviewer stand-in runs each recording a tab that the fixture roster holds,
// so the peek resolves both sessions as a live review would. The dag is seeded done so no tick touches the seed:
// a seeded DAG proves the UI, not the engine.
const DRS_TASKS = [{ id: "t-1", label: "hello", description: "do nothing, stop immediately", deps: [], state: "" }];
const DRS_LEAD = "drs lead";
// tab ids are object ids: cancelling the run parses each recorded worker oref
const DRS_WORKER = { id: "0d5e2c11-6f0a-4c8e-9a51-7b2f3e1d0a01", name: "drs worker" };
const DRS_REVIEWER = { id: "0d5e2c11-6f0a-4c8e-9a51-7b2f3e1d0a02", name: "drs reviewer" };
const DRS_MODAL = `document.querySelector("[data-dag-modal-kind]")`;
const DRS_PEEK = `${DRS_MODAL}?.querySelector('[data-dag-task-peek="t-1"]')`;
const drsBox = (role) => `${DRS_PEEK}?.querySelector('[data-dag-peek-session="${role}"]')`;
const drsText = (role) => `(${drsBox(role)}?.innerText ?? "").replace(/\\s+/g, " ").trim()`;
const DRS_HEADER = `(document.querySelector("[data-agent-header]")?.textContent ?? "").trim()`;

// a deferred quick run whose running phase records the stand-in's tab, as a spawned worker's does
async function drsStandIn(h, ctx, agent) {
    const created = await h.rpc("createrun", {
        channelid: ctx.channelId,
        workspaceid: (await h.rpc("workspacelist", null))[0].workspacedata.oid,
        goal: `verify dag-reviewer-session: stand-in run of ${agent.name}`,
        runtime: "claude",
        mode: "quick",
        deferstart: true,
    });
    const phase = { kind: "quick", state: "running", startedts: Date.now(), workerorefs: [`tab:${agent.id}`] };
    await fstWriteRun(h, created.run.id, (run) => ({ ...run, phases: [phase] }));
    return created.run.id;
}

const drsAgent = (a, runId, task) => ({
    ...a,
    project: "waveterm",
    task,
    state: "working",
    agent: "claude",
    model: "opus",
    activeMs: 60_000,
    runId,
    blockId: `fx-blk-${a.id}`,
});

export const dagReviewerSession = {
    name: "dag-reviewer-session",
    surface: "jarvis",
    async arrange(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", DAG_PEEK_VIEWPORT);
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-dag-reviewer-session-")) };
        try {
            await arrangeFixtureRun(h, ctx, "dag-reviewer-session", DRS_LEAD);
            const workerRun = await drsStandIn(h, ctx, DRS_WORKER);
            const reviewRun = await drsStandIn(h, ctx, DRS_REVIEWER);
            await h.rpc("dagsubmit", {
                channelid: ctx.channelId,
                runid: ctx.runId,
                title: "verify dag-reviewer-session",
                parallelism: 1,
                tasks: DRS_TASKS,
            });
            ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.oid;
            await seedDag(
                h,
                ctx,
                (dag) => ({
                    ...dag,
                    status: "done",
                    tasks: dag.tasks.map((t) => ({ ...t, state: "reviewing", runid: workerRun, reviewrunid: reviewRun })),
                }),
                (dag) => JSON.stringify([dag?.status, dag?.tasks?.[0]?.state, dag?.tasks?.[0]?.reviewrunid])
            );
            // the roster is read at boot, so the stand-ins join it before the reload
            const roster = [
                ...treeRailRoster(ctx.runId, Date.now(), DRS_LEAD),
                drsAgent(DRS_WORKER, workerRun, "hello"),
                drsAgent(DRS_REVIEWER, reviewRun, "review t-1"),
            ];
            writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(roster, null, 2));
            await h.ev("location.reload()");
            await polishWaitFor(h, `!!document.querySelector("nav button")`, 30_000);
            await h.cdp("Emulation.setDeviceMetricsOverride", DAG_PEEK_VIEWPORT);
            await h.goto("jarvis");
            ctx.opened = await h.ev(`(async () => {
                for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                if (typeof window.__openAddress !== "function") return { ok: false, why: "no __openAddress hook" };
                return window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)});
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const openDag = `[...(document.querySelector("[data-run-sheet]")?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Open DAG")`;
        const sheet = await polishWaitFor(h, `!!${openDag}`, 15000);
        if (sheet) await h.ev(`${openDag}.click()`);
        const graph = await polishWaitFor(h, `!!${DRS_MODAL}?.querySelector('[data-dag-node="t-1"]')`, 10000);
        // a click before the graph has laid out opens nothing, so it is repeated until the peek shows
        const shown =
            graph &&
            (await polishWaitFor(
                h,
                `${drsText("Reviewer")}.includes("Open in Agent") || (${DRS_PEEK} == null && void ${DRS_MODAL}.querySelector('[data-dag-node="t-1"]').click())`,
                10000
            ));
        const worker = await h.ev(drsText("Worker"));
        const reviewer = await h.ev(drsText("Reviewer"));
        await h.shot("cdp-shots/dag-reviewer-session.png");
        steps.push({
            step: "1. t-1 reviewing: the peek shows the worker's session and, under it, the reviewer's, each its own agent",
            ok:
                ctx.arrangeError == null &&
                sheet &&
                graph &&
                shown &&
                worker.includes(DRS_WORKER.name) &&
                reviewer.includes(DRS_REVIEWER.name),
            detail: JSON.stringify({ arrangeError: ctx.arrangeError, sheet, graph, worker, reviewer }),
        });

        await h.ev(`[...(${drsBox("Reviewer")}?.querySelectorAll("button") ?? [])].find((b) => /open in agent/i.test(b.innerText || ""))?.click()`);
        const focused = await polishWaitFor(h, `${DRS_HEADER}.includes(${JSON.stringify(DRS_REVIEWER.name)})`, 5000);
        const landed = await h.ev(`({ modalGone: ${DRS_MODAL} == null, header: ${DRS_HEADER} })`);
        await h.shot("cdp-shots/dag-reviewer-session-opened.png");
        steps.push({
            step: "2. the reviewer's Open in Agent closes the DAG and focuses the reviewer, not the worker",
            ok: focused && landed.modalGone,
            detail: JSON.stringify(landed),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "dag-reviewer-session");
    },
};
// --- final-shots: the Final check row, dock button and viewer (.superpowers/design/final-shots) ------------
// A deferred run's dag is rewritten through object.UpdateObject with a Final command, a failed round 1 kept in
// pastfinals and an unverified round 2, both carrying the Viewer board's manifest. Their out dirs are temp dirs of
// PNGs captured from the app itself, with round 1's jarvis-peek-narrow left off disk. The dag is then re-seeded for
// the States board's rows. Nothing touches its tasks or status, so it is never finalizing and the engine never
// starts a final stage on it; the chained plan dispatches t-1, which teardown's run cancel stops.
const FINAL_SHOTS_MISSING = "jarvis-peek-narrow";
// the fix round's row counts one shot more than round 1 had (States board: 16 shots)
const FINAL_SHOTS_EXTRA = { "surface-smoke": ["surface-agent"] };
const FINAL_SHOTS_PLAIN = ["checkout-empty", "checkout-filled", "receipt"];
// the fixture PNGs, by the surface each is captured on. Never through h.shot, which records evidence shots
const FINAL_SHOTS_CAPTURES = {
    cockpit: ["surface-smoke", "surface-cockpit"],
    jarvis: [
        "surface-jarvis",
        "brief-peek",
        "peek-ctrl-click",
        "jarvis-peek",
        "jarvis-peek-narrow",
        "jarvis-peek-busy",
        "jarvis-peek-empty",
        "resource-linking",
    ],
    usage: ["surface-usage", "checkout-filled"],
    files: ["surface-files", "receipt"],
    settings: ["surface-settings", "checkout-empty"],
    code: ["surface-code"],
    setup: ["surface-setup"],
    agent: ["surface-agent"],
};
// crops, so the shots differ in size the way real ones do; the rest are the whole viewport
const FINAL_SHOTS_CLIPS = {
    "brief-peek": { x: 800, y: 0, width: 800, height: 950 },
    "peek-ctrl-click": { x: 520, y: 150, width: 560, height: 640 },
    "jarvis-peek-narrow": { x: 1160, y: 530, width: 440, height: 420 },
    "jarvis-peek-busy": { x: 0, y: 0, width: 1200, height: 760 },
    receipt: { x: 400, y: 100, width: 800, height: 600 },
};
const FS_P = "pass";
const FS_F = "fail";
const FS_S = "skip";
// the Viewer board's five scenarios; round 2 passed the two jarvis-peek steps the fix round fixed
const FINAL_SHOTS_BOARD = [
    {
        name: "surface-smoke",
        shots: ["surface-smoke", "surface-cockpit", "surface-jarvis", "surface-usage", "surface-files", "surface-settings", "surface-code", "surface-setup"],
        steps: [
            [FS_P, 'goto cockpit -> active nav "Cockpit", content non-empty', "active=Cockpit contentLen=1643"],
            [FS_P, 'goto jarvis -> active nav "Jarvis", content non-empty', "active=Jarvis contentLen=1378"],
            [FS_P, 'goto usage -> active nav "Usage", content non-empty', "active=Usage contentLen=1909"],
            [FS_P, 'goto files -> active nav "Diff", content non-empty', "active=Diff contentLen=1349"],
            [FS_P, 'goto settings -> active nav "Settings", content non-empty', "active=Settings contentLen=2036"],
            [FS_P, 'goto code -> active nav "Code", content non-empty', "active=Code contentLen=1377"],
            [FS_P, 'goto setup -> active nav "Setup", content non-empty', "active=Setup contentLen=2123"],
            [FS_P, "wsh notify -> the avatar says it once, with no toast, and the bubble leaves", "bubble=true toast=false gone=true"],
            [FS_S, "steer input visible on a pi session card", "no pi session focused in this run - focus one before reading this as a pass (the manual round-trip covers it)"],
        ],
    },
    {
        name: "brief-peek",
        shots: ["brief-peek"],
        steps: [
            [FS_P, "1. the Brief is showing and no peek is open yet"],
            [FS_P, "2. a record row in the palette opens the peek, with its updated stamp and status toggle"],
            [FS_P, "2b. the peek names the record's fleet or says it has none"],
            [FS_P, "3. the peek's attributed run opens the run's sheet, resolved rather than pending"],
            [FS_P, "4. the status picker offers only legal transitions, and the current status is a label"],
            [FS_P, "5. Escape closes the peek and leaves the Brief behind it"],
        ],
    },
    {
        name: "peek-ctrl-click",
        shots: ["peek-ctrl-click"],
        steps: [
            [FS_P, "1. the Brief shows a peekable run row"],
            [FS_P, "2. Ctrl+click opens a ready run item view in the 560px popup"],
            [FS_P, "3. the host surface, subject, sheet flag and scroll are unchanged while the peek is up"],
            [FS_P, "4. Escape closes the popup and the host's state still matches"],
        ],
    },
    {
        name: "jarvis-peek",
        shots: ["jarvis-peek", "jarvis-peek-narrow", "jarvis-peek-busy", "jarvis-peek-empty"],
        steps: [
            [FS_P, "1. keyboard open renders a labelled dialog of header/queue/composer and focuses its container"],
            [FS_P, "2. Tab starts at Full view and reverse traversal stays inside the dialog"],
            [FS_P, "3. the quiet card states queue absence once, and the composer is live wherever there is a destination"],
            [FS_F, "4. the narrow panel stays bounded with a pinned header, no horizontal overflow, and an unclipped harness picker"],
            [FS_F, "5. attention expands the card and keyboard navigation moves the cursor then focuses the composer"],
            [FS_P, "6. Escape, close, and backdrop dismiss only the peek and return focus to the creature"],
            [FS_P, "7. dismissing the global peek stays on the current surface"],
        ],
    },
    {
        name: "resource-linking",
        shots: ["resource-linking"],
        steps: [
            [FS_P, "1. the DEV hook that opens an address is installed on the Brief"],
            [FS_P, "2. a record address opens the record's peek"],
            [FS_S, "3. a decision address opens its record's peek"],
            [FS_P, "4. a memory address opens nothing and leaves the surface where it was"],
            [FS_P, "5. an address nothing can open shows the toast and leaves the surface where it was"],
        ],
    },
];

function finalShotsManifest(round, extra = {}) {
    return FINAL_SHOTS_BOARD.map((sc) => ({
        name: sc.name,
        files: [...sc.shots, ...(extra[sc.name] ?? [])].map((f) => `cdp-shots/${f}.png`),
        steps: sc.steps.map(([state, step, detail]) => ({
            step,
            state: round === 2 && state === FS_F ? FS_P : state,
            ...(detail ? { detail } : {}),
        })),
    }));
}

async function captureFinalShotsFixture(h) {
    const pngs = {};
    for (const [surface, names] of Object.entries(FINAL_SHOTS_CAPTURES)) {
        await h.goto(surface);
        for (const name of names) {
            const clip = FINAL_SHOTS_CLIPS[name];
            const { data } = await h.cdp("Page.captureScreenshot", {
                format: "png",
                ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
            });
            pngs[name] = Buffer.from(data, "base64");
        }
    }
    return pngs;
}

// the out dirs the engine would have made: <out>/<round>/cdp-shots/*.png, and the plain listing's PNGs at its top
function writeFinalShotsFixture(out, pngs) {
    for (const round of [1, 2]) {
        mkdirSync(join(out, String(round), "cdp-shots"), { recursive: true });
        for (const sc of finalShotsManifest(round, FINAL_SHOTS_EXTRA)) {
            for (const file of sc.files) {
                const name = file.slice("cdp-shots/".length, -".png".length);
                if (round === 1 && name === FINAL_SHOTS_MISSING) continue;
                writeFileSync(join(out, String(round), file), pngs[name]);
            }
        }
    }
    mkdirSync(join(out, "plain"), { recursive: true });
    for (const name of FINAL_SHOTS_PLAIN) writeFileSync(join(out, "plain", `${name}.png`), pngs[name]);
    mkdirSync(join(out, "empty"), { recursive: true });
}

// the stages of every seed, by the board row each one draws
function finalShotsStages(out) {
    const dir = (sub) => `${out.replace(/\\/g, "/")}/${sub}`;
    const round1 = (extra) => ({
        state: "failed",
        round: 1,
        outdir: dir(1),
        shots: finalShotsManifest(1, extra),
        shotsmanifest: true,
    });
    return {
        main: {
            final: { state: "unverified", round: 2, outdir: dir(2), shots: finalShotsManifest(2), shotsmanifest: true },
            pastfinals: [round1()],
        },
        fixing: { final: { state: "", round: 2 }, pastfinals: [round1(FINAL_SHOTS_EXTRA)] },
        passed: {
            final: { state: "passed", round: 1, outdir: dir(2), shots: finalShotsManifest(2), shotsmanifest: true },
            pastfinals: [],
        },
        empty: { final: { state: "unverified", round: 1, outdir: dir("empty"), shotsmanifest: false }, pastfinals: [] },
        plain: {
            final: {
                state: "passed",
                round: 1,
                outdir: dir("plain"),
                shots: FINAL_SHOTS_PLAIN.map((name) => ({ name, files: [`${name}.png`] })),
                shotsmanifest: false,
            },
            pastfinals: [],
        },
    };
}

const FS_ROW = `document.querySelector("[data-run-sheet] [data-run-sheet-final-shots]")`;
const FS_DOCK = `document.querySelector("[data-run-sheet] [data-run-sheet-final-shots-dock]")`;
const FS_VIEWER = `document.querySelector("[data-final-shots-viewer]")`;
// the viewer is portaled to body, so it is read on its own, not inside the run sheet
const FS_READ = `(() => {
    const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
    const row = ${FS_ROW};
    const header = row?.querySelector(":scope > button[aria-expanded]");
    const dock = ${FS_DOCK};
    const v = ${FS_VIEWER};
    let viewer = null;
    if (v) {
        const film = [...v.querySelectorAll('button[aria-pressed][aria-label$=".png"]')];
        const zoom = [...v.querySelectorAll("button[aria-pressed]")].find((b) => /^(Fit|Actual size)$/.test(flat(b)));
        const steps = v.querySelector("button[aria-expanded]");
        const drawer = v.querySelector('aside[aria-label="Steps"]');
        const img = v.querySelector("img[alt]:not([alt=''])");
        viewer = {
            text: flat(v.firstElementChild),
            rounds: [...v.querySelectorAll('[role="group"][aria-label="Round"] button')].map((b) => ({
                text: flat(b),
                on: b.getAttribute("aria-pressed") === "true",
            })),
            tabs: [...v.querySelectorAll('[role="tab"]')].map((t) => ({
                text: flat(t),
                on: t.getAttribute("aria-selected") === "true",
                hollow: t.querySelector("span.border-muted") != null,
            })),
            film: film.map((b) => ({ name: b.getAttribute("aria-label"), on: b.getAttribute("aria-pressed") === "true" })),
            path: film[0]?.parentElement?.querySelector(":scope > span")?.textContent ?? null,
            zoom: zoom ? { text: flat(zoom), on: zoom.getAttribute("aria-pressed") === "true" } : null,
            steps: steps ? { text: flat(steps), expanded: steps.getAttribute("aria-expanded") } : null,
            drawer: drawer ? { fails: [...drawer.querySelectorAll("span")].filter((s) => s.textContent === "FAIL").length } : null,
            img: img ? { loaded: img.complete && img.naturalWidth > 0, alt: img.alt } : null,
            missing: flat(v.querySelector("[data-final-shots-missing]")) || null,
        };
    }
    const link = row ? [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Open the viewer") : null;
    return {
        sheet: document.querySelector("[data-run-sheet]") != null,
        row: header ? { expanded: header.getAttribute("aria-expanded"), text: flat(header) } : null,
        thumbs: row
            ? [...row.querySelectorAll('button[aria-label^="Open "]')].map((b) => ({
                  name: b.getAttribute("aria-label").slice("Open ".length),
                  img: b.querySelector("img") != null,
              }))
            : [],
        caption: link ? flat(link.parentElement) : null,
        dock: dock
            ? {
                  text: flat(dock),
                  disabled: dock.disabled,
                  accent: dock.classList.contains("border-accent"),
                  focused: document.activeElement === dock,
              }
            : null,
        viewer,
    };
})()`;
// what the Jarvis surface under the viewer has selected: its list cursor and the run its sheet shows
const FS_JARVIS = `(() => ({
    cursor: document.querySelector("[data-jarvis-brief-cursor]")?.textContent.trim().slice(0, 80) ?? null,
    sheet: (document.querySelector("[data-jarvis-brief-sheet] > header")?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 160),
}))()`;
const FS_KEYS = {
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowRight: "ArrowRight",
    z: "KeyZ",
    s: "KeyS",
    Escape: "Escape",
};
const FS_WAIT_MS = 8000;

// polls the run sheet and viewer until ok holds or the wait runs out, and returns the last read either way
async function finalShotsUntil(h, ok, ms = FS_WAIT_MS) {
    for (let waited = 0; ; waited += 250) {
        const s = await h.ev(FS_READ).catch(() => null);
        if ((s != null && ok(s)) || waited >= ms) return s;
        await polishNap(250);
    }
}

const finalShotsClick = (h, expr) =>
    h.ev(`(() => {
        const el = ${expr};
        if (!el) return false;
        // a real click focuses its button, and the viewer hands focus back to whatever held it
        el.focus();
        el.click();
        return true;
    })()`);

// a DOM key event at the focused element: CDP's Input.dispatchKeyEvent often never reaches the WebView, and the
// keybinding dispatcher and the run sheet's Escape both listen on window, which this reaches the same way
const finalShotsKey = (h, key) =>
    h.ev(`(() => {
        const target = document.activeElement ?? document.body;
        const init = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(FS_KEYS[key])}, bubbles: true, cancelable: true };
        const down = new KeyboardEvent("keydown", init);
        target.dispatchEvent(down);
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        return down.defaultPrevented;
    })()`);

const FS_BOARD_ORDER = ["surface-smoke", "brief-peek", "peek-ctrl-click", "jarvis-peek", "resource-linking"];

export const finalShotsScenario = {
    name: "final-shots",
    surface: "jarvis",
    async arrange(h) {
        const out = mkdtempSync(join(tmpdir(), "verify-final-shots-out-"));
        let pngs;
        try {
            // before the run exists: arrangeSheetDagRun ends on the Brief with the sheet open
            pngs = await captureFinalShotsFixture(h);
            writeFinalShotsFixture(out, pngs);
        } catch (e) {
            return { out, arrangeError: String(e?.message ?? e) };
        }
        const ctx = await arrangeSheetDagRun(h, "final-shots", RUN_SHEET_POLISH_TASKS);
        ctx.out = out;
        ctx.stages = finalShotsStages(out);
        if (ctx.arrangeError != null) return ctx;
        try {
            ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.oid;
            if (!ctx.dagId) throw new Error("the run has no dag");
            await seedFinalShots(h, ctx, ctx.stages.main);
            ctx.rowShown = (await finalShotsUntil(h, (s) => s.row != null, 15_000))?.row != null;
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec(
            "0. the run's sheet opened on a dag seeded with two finished rounds",
            ctx.arrangeError == null && ctx.opened?.ok === true && ctx.rowShown === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, dagId: ctx.dagId, opened: ctx.opened })
        );
        if (ctx.arrangeError != null) return steps;

        let s = await finalShotsUntil(h, (x) => x.row?.text.includes("15 shots") && x.dock != null);
        rec(
            "1. the row is collapsed with unverified · 5 scenarios and 15 shots · 2 rounds; the dock reads Screenshots · 15",
            s?.row?.expanded === "false" &&
                s.row.text.includes("unverified · 5 scenarios") &&
                s.row.text.includes("15 shots · 2 rounds") &&
                s.dock?.text === "Screenshots · 15" &&
                !s.dock.disabled &&
                !s.dock.accent,
            JSON.stringify({ row: s?.row, dock: s?.dock })
        );
        await h.shot("cdp-shots/final-shots-1-row-closed.png");

        await finalShotsClick(h, `${FS_ROW}?.querySelector(":scope > button[aria-expanded]")`);
        s = await finalShotsUntil(h, (x) => x.row?.expanded === "true" && x.thumbs.length > 0 && x.thumbs.every((t) => t.img));
        rec(
            "2. the opened row shows one thumbnail per scenario and the round-1 caption",
            s?.row?.expanded === "true" &&
                JSON.stringify(s.thumbs.map((t) => t.name)) === JSON.stringify(FS_BOARD_ORDER) &&
                s.thumbs.every((t) => t.img) &&
                (s.caption ?? "").includes("Round 1 failed on jarvis-peek steps 4 and 5."),
            JSON.stringify({ thumbs: s?.thumbs, caption: s?.caption })
        );
        await h.shot("cdp-shots/final-shots-2-row-open.png");
        // the States rows below are drawn collapsed
        await finalShotsClick(h, `${FS_ROW}?.querySelector(":scope > button[aria-expanded]")`);

        await finalShotsClick(h, FS_DOCK);
        s = await finalShotsUntil(h, (x) => x.viewer?.img?.loaded === true && x.viewer.film.length > 0);
        let v = s?.viewer;
        rec(
            "3. the dock opens the viewer on round 2: tabs, shot, filmstrip and path, the drawer closed on a passing scenario",
            v != null &&
                v.rounds.length === 2 &&
                v.rounds.find((r) => r.on)?.text === "Round 2 unverified" &&
                v.tabs.length === 5 &&
                v.tabs[0].on &&
                v.tabs[0].text.startsWith("surface-smoke") &&
                v.img?.loaded === true &&
                v.film.length === 8 &&
                v.film[0].on &&
                (v.path ?? "").endsWith("/2/cdp-shots/surface-smoke.png") &&
                v.steps?.expanded === "false" &&
                v.drawer == null,
            JSON.stringify(v)
        );
        await h.shot("cdp-shots/final-shots-3-viewer.png");

        await finalShotsClick(
            h,
            `[...(${FS_VIEWER}?.querySelectorAll('[role="group"][aria-label="Round"] button') ?? [])].find((b) => b.innerText.trim().startsWith("Round 1"))`
        );
        s = await finalShotsUntil(
            h,
            (x) => x.viewer?.tabs[0]?.text.startsWith("jarvis-peek") && x.viewer.drawer != null && x.viewer.img?.loaded === true
        );
        v = s?.viewer;
        rec(
            "4. round 1 puts jarvis-peek first with the drawer open on its two failing steps",
            v != null &&
                v.rounds.find((r) => r.on)?.text === "Round 1 failed" &&
                v.tabs[0].on &&
                v.tabs[0].text.startsWith("jarvis-peek") &&
                v.steps?.expanded === "true" &&
                v.drawer?.fails === 2,
            JSON.stringify({ rounds: v?.rounds, tab: v?.tabs[0], steps: v?.steps, drawer: v?.drawer })
        );
        await h.shot("cdp-shots/final-shots-4-round-1.png");

        // ArrowUp/Down are the Jarvis list's keys too, and with the sheet open they would open the next run
        const before = await h.ev(FS_JARVIS);
        const keys = {};
        await finalShotsKey(h, "ArrowDown");
        keys.down = (await finalShotsUntil(h, (x) => x.viewer?.tabs[1]?.on === true, 2000))?.viewer?.tabs.findIndex((t) => t.on);
        await finalShotsKey(h, "ArrowUp");
        keys.up = (await finalShotsUntil(h, (x) => x.viewer?.tabs[0]?.on === true, 2000))?.viewer?.tabs.findIndex((t) => t.on);
        await finalShotsKey(h, "z");
        keys.zoom = (await finalShotsUntil(h, (x) => x.viewer?.zoom?.on === true, 2000))?.viewer?.zoom;
        await finalShotsKey(h, "s");
        s = await finalShotsUntil(h, (x) => x.viewer?.steps?.expanded === "false" && x.viewer.drawer == null, 2000);
        keys.steps = { steps: s?.viewer?.steps, drawer: s?.viewer?.drawer };
        await h.shot("cdp-shots/final-shots-5-keys.png");
        await finalShotsKey(h, "z");
        keys.fit = (await finalShotsUntil(h, (x) => x.viewer?.zoom?.on === false, 2000))?.viewer?.zoom;
        await finalShotsKey(h, "ArrowRight");
        s = await finalShotsUntil(h, (x) => x.viewer?.film[1]?.on === true, 2000);
        keys.right = s?.viewer?.film.findIndex((f) => f.on);
        const after = await h.ev(FS_JARVIS);
        rec(
            "5. ArrowRight moves the filmstrip, z toggles Actual size, s toggles the drawer, and the Jarvis selection stays put",
            keys.down === 1 &&
                keys.up === 0 &&
                keys.zoom?.text === "Actual size" &&
                keys.steps.steps?.expanded === "false" &&
                keys.steps.drawer == null &&
                keys.fit?.text === "Fit" &&
                keys.right === 1 &&
                JSON.stringify(after) === JSON.stringify(before),
            JSON.stringify({ keys, before, after })
        );

        s = await finalShotsUntil(h, (x) => x.viewer?.missing != null);
        rec(
            "6. the file left off disk shows No longer on disk with its path",
            (s?.viewer?.missing ?? "").includes("No longer on disk") &&
                s.viewer.missing.includes(`/1/cdp-shots/${FINAL_SHOTS_MISSING}.png`),
            JSON.stringify({ missing: s?.viewer?.missing })
        );
        await h.shot("cdp-shots/final-shots-6-missing.png");
        await finalShotsClick(h, `${FS_VIEWER}?.querySelector('button[aria-label="Close"]')`);
        await finalShotsUntil(h, (x) => x.viewer == null, 3000);

        await seedFinalShots(h, ctx, ctx.stages.fixing);
        s = await finalShotsUntil(h, (x) => x.row?.text.includes("16 shots") === true);
        rec(
            "7. failed during the fix round: failed · jarvis-peek 2 steps, 16 shots · round 1, an accent dock",
            s?.row?.text.includes("failed · jarvis-peek 2 steps") &&
                s.row.text.includes("16 shots · round 1") &&
                s.dock?.text === "Screenshots · 16" &&
                s.dock.accent &&
                !s.dock.disabled,
            JSON.stringify({ row: s?.row, dock: s?.dock })
        );
        await h.shot("cdp-shots/final-shots-7-fixing.png");

        await seedFinalShots(h, ctx, ctx.stages.passed);
        s = await finalShotsUntil(h, (x) => x.row?.text.includes("passed · 5 scenarios") === true);
        rec(
            "8a. passed: passed · 5 scenarios, 15 shots, a plain dock",
            s?.row?.text.includes("passed · 5 scenarios") &&
                s.row.text.endsWith("15 shots") &&
                s.dock?.text === "Screenshots · 15" &&
                !s.dock.accent &&
                !s.dock.disabled,
            JSON.stringify({ row: s?.row, dock: s?.dock })
        );
        await h.shot("cdp-shots/final-shots-8a-passed.png");

        await seedFinalShots(h, ctx, ctx.stages.empty);
        s = await finalShotsUntil(h, (x) => x.row?.text.includes("no screenshots") === true);
        rec(
            "8b. unverified with no shots: unverified · no screenshots, the dock disabled at 0",
            s?.row?.text.includes("unverified · no screenshots") && s.dock?.text === "Screenshots · 0" && s.dock.disabled === true,
            JSON.stringify({ row: s?.row, dock: s?.dock })
        );
        await h.shot("cdp-shots/final-shots-8b-empty.png");

        await seedFinalShots(h, ctx, ctx.stages.plain);
        s = await finalShotsUntil(h, (x) => x.row?.text.includes("passed · 3 screenshots") === true);
        const plainRow = { row: s?.row, dock: s?.dock };
        await finalShotsClick(h, FS_DOCK);
        s = await finalShotsUntil(h, (x) => x.viewer?.img?.loaded === true);
        v = s?.viewer;
        rec(
            "8c. a plain PNG listing: passed · 3 screenshots, hollow-dot entries in the viewer, no Steps button",
            plainRow.row?.text.includes("passed · 3 screenshots") &&
                plainRow.row.text.includes("3 shots") &&
                plainRow.dock?.text === "Screenshots · 3" &&
                v != null &&
                JSON.stringify(v.tabs.map((t) => t.text)) === JSON.stringify(FINAL_SHOTS_PLAIN.map((n) => `${n}.png`)) &&
                v.tabs.every((t) => t.hollow) &&
                v.steps == null &&
                v.drawer == null &&
                v.rounds.length === 0 &&
                v.text.includes("Round 1 passed"),
            JSON.stringify({ ...plainRow, viewer: v })
        );
        await h.shot("cdp-shots/final-shots-8c-plain.png");

        await finalShotsKey(h, "Escape");
        await finalShotsUntil(h, (x) => x.viewer == null, 3000);
        // the run sheet's own Escape would close it a beat later, so the check waits past that
        await polishNap(600);
        s = await h.ev(FS_READ);
        rec(
            "9. Esc closes the viewer, leaves the run sheet open and hands focus back to the dock button",
            s?.viewer == null && s.sheet === true && s.dock?.focused === true,
            JSON.stringify({ viewer: s?.viewer != null, sheet: s?.sheet, dock: s?.dock })
        );
        await h.shot("cdp-shots/final-shots-9-closed.png");
        return steps;
    },
    async teardown(h, ctx) {
        if (ctx.cwd) await teardownFixtureRun(h, ctx, "final-shots");
        rmSync(ctx.out, { recursive: true, force: true });
    },
};

// --- final-rerun: a failed final stage runs again from the run sheet ------------------------------------------
// The dag is seeded with a failed round 1 while t-1 is still at work, so the engine leaves the stage alone. The
// rerun resets it to round 1 not started, which the same busy dag then keeps.

const FR_BTN = `document.querySelector("[data-run-sheet] [data-final-rerun]")`;
const finalRerunSeed = {
    state: "failed",
    round: 1,
    detail: "Check `docker info` failed (exit 1):\ndocker is not running",
};
const finalRerunPrint = (dag) => JSON.stringify([dag?.final?.state ?? null, dag?.final?.round ?? null]);

export const finalRerunScenario = {
    name: "final-rerun",
    surface: "jarvis",
    async arrange(h) {
        const ctx = await arrangeSheetDagRun(h, "final-rerun", RUN_SHEET_POLISH_TASKS);
        if (ctx.arrangeError != null) return ctx;
        try {
            ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.oid;
            if (!ctx.dagId) throw new Error("the run has no dag");
            await seedDag(h, ctx, (dag) => ({ ...dag, final: finalRerunSeed }), finalRerunPrint);
            ctx.shown = await polishWaitFor(h, `${FR_BTN} != null`, 15_000);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec(
            "0. the run's sheet opened on a dag seeded with a failed final stage",
            ctx.arrangeError == null && ctx.opened?.ok === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, dagId: ctx.dagId, opened: ctx.opened })
        );
        if (ctx.arrangeError != null) return steps;
        const label = await h.ev(`${FR_BTN}?.textContent.trim() ?? null`);
        rec("1. the dock offers Rerun final stage", ctx.shown === true && label === "Rerun final stage", JSON.stringify({ label }));
        await h.shot("cdp-shots/final-rerun-1-offered.png");

        await h.ev(`${FR_BTN}?.click()`);
        const gone = await polishWaitFor(h, `${FR_BTN} == null`, 15_000);
        const dag = await waveService(h, "object", "GetObject", [`dag:${ctx.dagId}`]);
        rec(
            "2. the click reruns the stage: round 1 not started, and the button is gone",
            gone && dag?.final?.state === "" && dag?.final?.round === 1 && (dag?.final?.detail ?? "") === "",
            JSON.stringify({ gone, final: dag?.final })
        );
        const error = await h.ev(`document.querySelector("[data-run-sheet] .text-error")?.textContent ?? null`);
        rec("3. the engine refused nothing", error == null, JSON.stringify({ error }));
        await h.shot("cdp-shots/final-rerun-2-rerun.png");
        return steps;
    },
    async teardown(h, ctx) {
        if (ctx.cwd) await teardownFixtureRun(h, ctx, "final-rerun");
    },
};

// --- final-stage: the final stage's tree row, pane, rail block and DAG node ---------------------------------
// Two parts on one run (docs/reference/cdp-run-fixtures.md, "A run with a final stage"). Part B comes first: the
// States board's rows, seeded on a dag the engine leaves alone because t-1 is still at work, with each round's
// final-step events published to the page. Part A is last, since it ends the run: every task is seeded done and
// merged, so the engine itself starts round 1, runs Tree and then a Verify that outlasts the scenario, and the
// stage is ended from its pane. The fixture's temp dir is a git repository, which the stage's tree needs.
const FST_VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const FST_LEAD = "final-stage lead";
const FST_VERIFIER = "final-stage verifier";
const FST_VERIFIER_ID = "fx-final-verifier";
// t-1 fans out to two sinks, so the final node takes two edges; at parallelism 1 only t-1 dispatches
const FST_TASKS = [
    { id: "t-1", label: "noop", description: "do nothing, stop immediately", deps: [], state: "" },
    { id: "t-2", label: "noop 2", description: "do nothing, stop immediately", deps: ["t-1"], state: "" },
    { id: "t-3", label: "noop 3", description: "do nothing, stop immediately", deps: ["t-1"], state: "" },
];
const FST_SINK_EDGES = ["t-2>final", "t-3>final"];
// Part A's commands run. Verify writes three lines and then one every 3s for 15 minutes: the engine publishes the
// tail from the command's own writes, the first one at once and then at most every 10s
const FST_MARK = "final-stage verify";
const FST_LIVE_VERIFY = `printf '${FST_MARK} 1\\n${FST_MARK} 2\\n${FST_MARK} 3\\n'; for i in $(seq 1 300); do sleep 3; echo "${FST_MARK} still running $i"; done`;
const FST_LIVE_FINAL = "true";
const FST_KEPT_MARK = "final-stage kept check output";
const FST_REASON =
    "the Verify loop of the final-stage scenario never ends on its own, so the scenario ends the stage here and records why";
const FST_VERIFIER_MS = 180_000;
const FST_STEP_TEXT = ["passed 22s", "passed 41s", "passed 7m 11s", "passed 3m 08s", "passed 3m 00s"];
const FST_TOTAL = "14m 22s";
const FST_WAIT_MS = 8000;
// a watchdog tick starts the stage (every 30s), then the Tree step and Verify's second publish
const FST_ENGINE_WAIT_MS = 90_000;

const fstHolds = (fn) => {
    try {
        return fn() === true;
    } catch {
        return false;
    }
};
const fstStates = (steps) => (steps ?? []).map((s) => s.state);
const fstRepeat = (state, n) => Array(n).fill(state);
const fstSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fstFlat = (text) => text.replace(/\s+/g, " ").trim();
const fstButton = (rootExpr, text) =>
    `[...(${rootExpr}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;

// page-side readers shared by the two reads below; every element comes through the selectors the plan fixes
const FST_LIB = `
    const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const stepsOf = (root) =>
        [...(root?.querySelectorAll("[data-final-step]") ?? [])].map((s) => ({
            key: s.getAttribute("data-final-step"),
            state: s.getAttribute("data-final-step-state"),
            text: flat(s.querySelector("span.whitespace-nowrap")),
            command: s.querySelector("span[title]")?.getAttribute("title") ?? null,
        }));
    const pastOf = (root) =>
        [...(root?.querySelectorAll("[data-final-past-round]") ?? [])].map((p) => ({
            round: p.getAttribute("data-final-past-round"),
            text: flat(p),
        }));
    const outputOf = (root) => root?.querySelector("[data-final-output]")?.textContent ?? null;
    const shotsOf = (root) => flat(root?.querySelector("[data-final-shots-link]")) || null;
`;
const FST_TREE = `document.querySelector("[data-agent-tree]")`;
const FST_RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
const FST_ROW = `${FST_TREE}?.querySelector("[data-final-row]")`;
const FST_PANE = `document.querySelector("[data-final-pane]")`;
const FST_MODAL = `document.querySelector("[data-dag-modal-kind]")`;
const FST_NODE = `${FST_MODAL}?.querySelector('[data-dag-node="final"]')`;
const FST_DAG_PEEK = `${FST_MODAL}?.querySelector("[data-dag-final-peek]")`;
const FST_SHEET = `document.querySelector("[data-run-sheet]")`;
const FST_FOLD = `[...(${FST_TREE}?.querySelectorAll("div.cursor-pointer") ?? [])].find((d) => /^\\d+ (done|reviews?)/.test(d.textContent.trim()))`;
const FST_LEAD_ROW = `(() => {
    const name = [...(${FST_TREE}?.querySelectorAll("div") ?? [])].find(
        (d) => d.children.length === 0 && d.textContent.trim() === ${JSON.stringify(FST_LEAD)}
    );
    return name ? name.closest(".cursor-pointer") : null;
})()`;
// the Agent surface: the tree's row and slot, the stage's pane, and in the details rail the lead's block or the
// stage's own section
const FST_AGENT = `(() => {
    ${FST_LIB}
    const tree = ${FST_TREE};
    const rail = ${FST_RAIL};
    const pane = ${FST_PANE};
    const stage = rail?.querySelector("[data-final-rail]");
    const slot = tree?.querySelector("[data-final-slot]");
    const status = [...(rail?.querySelectorAll("span.font-semibold") ?? [])].find((s) => flat(s) === "Verifying");
    const fold = ${FST_FOLD};
    return {
        rows: [...(tree?.querySelectorAll("[data-final-row]") ?? [])].map((r) => ({
            tone: r.getAttribute("data-final-tone"),
            title: flat(r.querySelector(".truncate")),
            sub: flat(r.querySelector(".font-mono")),
            selected: r.classList.contains("bg-accentbg"),
        })),
        slot: slot?.getAttribute("data-final-slot") ?? null,
        strip: slot?.parentElement?.getAttribute("aria-label") ?? null,
        fold: fold ? flat(fold) : null,
        pane: pane
            ? {
                  text: flat(pane),
                  steps: stepsOf(pane),
                  output: outputOf(pane),
                  end: pane.querySelector("[data-final-end]") != null,
                  form: pane.querySelector("[data-run-sheet-end-final]") != null,
                  past: pastOf(pane),
                  shots: shotsOf(pane),
              }
            : null,
        railSteps: rail?.querySelectorAll("[data-final-step]").length ?? 0,
        stage: stage ? { text: flat(stage), steps: stepsOf(stage), past: pastOf(stage), shots: shotsOf(stage) } : null,
        status: status ? flat(status.parentElement) : null,
        viewer: document.querySelector("[data-final-shots-viewer]") != null,
    };
})()`;
// the DAG modal: the final node, the edges into it, the stage line, and the node's peek card
const FST_DAG = `(() => {
    ${FST_LIB}
    const modal = ${FST_MODAL};
    if (!modal) return null;
    const card = ${FST_NODE};
    const peek = ${FST_DAG_PEEK};
    const route = [...modal.querySelectorAll("span")].find((s) => s.textContent.trim().startsWith("Run route ·"));
    return {
        cards: [...modal.querySelectorAll("[data-dag-node]")].map((c) => c.getAttribute("data-dag-node")),
        edges: [...modal.querySelectorAll(".react-flow__edge")].map((e) => e.getAttribute("data-id") ?? "").sort(),
        stageLine: route ? flat(route.parentElement) : null,
        node: card
            ? {
                  pressed: card.getAttribute("aria-pressed"),
                  meta: flat(card.querySelector(":scope > span:not([role])")),
                  under: flat(card.parentElement?.querySelector(":scope > span")),
                  strip: stepsOf(card).map((s) => s.state),
              }
            : null,
        peek: peek
            ? {
                  text: flat(peek),
                  steps: stepsOf(peek),
                  output: outputOf(peek),
                  end: peek.querySelector("[data-final-end]") != null,
                  past: pastOf(peek),
                  shots: shotsOf(peek),
                  open: [...peek.querySelectorAll("button")].some((b) => /open in agent/i.test(b.textContent)),
              }
            : null,
        viewer: document.querySelector("[data-final-shots-viewer]") != null,
    };
})()`;

// reads expr until ok holds or the wait runs out, and returns the last read either way. nudge runs every 2s:
// an event published before the run's history loaded is replaced by that load, so it is published again
async function fstUntil(h, expr, ok, { ms = FST_WAIT_MS, nudge } = {}) {
    for (let i = 0; ; i++) {
        const s = await h.ev(expr).catch(() => null);
        if (fstHolds(() => ok(s)) || i * 250 >= ms) return s;
        if (nudge && i % 8 === 7) await nudge();
        await polishNap(250);
    }
}

async function fstAgent(h, ok, opts) {
    if ((await h.activeSurfaceLabel()) !== SURFACE_LABEL.agent) await h.goto("agent");
    return fstUntil(h, FST_AGENT, ok, opts);
}

// the run's graph with the final node selected: the modal belongs to the run's sheet on the Jarvis surface
async function fstDag(h, ctx, ok, opts) {
    if (!(await h.ev(`${FST_MODAL} != null`))) {
        await h.goto("jarvis");
        await polishWaitFor(h, `typeof window.__openAddress === "function"`, 5000);
        await h.ev(`window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)})`);
        const openDag = fstButton(FST_SHEET, "Open DAG");
        await polishWaitFor(h, `!!${openDag}`, 10_000);
        // a modal the last visit left open comes back with the surface
        if (!(await h.ev(`${FST_MODAL} != null`))) await finalShotsClick(h, openDag);
    }
    await polishWaitFor(h, `!!${FST_NODE}`, 10_000);
    await h.ev(`(() => {
        const card = ${FST_NODE};
        if (card && card.getAttribute("aria-pressed") !== "true") card.click();
    })()`);
    return fstUntil(h, FST_DAG, (d) => d.node.pressed === "true" && d.peek != null && ok(d), opts);
}
// what Part A's seed must keep: the engine owns the dag's status and its final from the first tick on
const fstLivePrint = (dag) =>
    JSON.stringify([dag?.verify ?? "", dag?.finalcmd ?? "", (dag?.tasks ?? []).map((t) => [t.state, t.merged === true])]);

function fstGitInit(cwd) {
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

// The roster is read once at boot: the lead alone, or with the tab of the verifier's session. Reloads onto it,
// which also drops every event published to the page, and focuses the lead, whose rail reads the run's events.
async function fstBoot(h, ctx, withVerifier) {
    const roster = treeRailRoster(ctx.runId, Date.now(), FST_LEAD).filter((a) => a.id === TREE_RAIL_LEAD_ID);
    if (withVerifier) {
        roster.push({
            id: FST_VERIFIER_ID,
            name: FST_VERIFIER,
            project: "waveterm",
            task: "judge the merged result",
            state: "working",
            agent: "claude",
            model: "opus",
            activeMs: 60_000,
            runId: ctx.verifierRunId,
            blockId: "fx-blk-final-verifier",
        });
    }
    writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(roster, null, 2));
    await h.ev("location.reload()");
    await polishWaitFor(h, `!!document.querySelector("nav button")`, 30_000);
    await h.cdp("Emulation.setDeviceMetricsOverride", FST_VIEWPORT);
    await h.goto("agent");
    return fstFocusLead(h);
}

async function fstFocusLead(h) {
    if (!(await polishWaitFor(h, `!!${FST_LEAD_ROW}`, 15_000))) return false;
    await finalShotsClick(h, FST_LEAD_ROW);
    return polishWaitFor(h, `[...(${FST_RAIL}?.querySelectorAll("h3") ?? [])].some((el) => el.textContent.trim() === "Run")`, 15_000);
}

// Part A's seed: every task done and merged with no child run to derive a state from, a Final command so no
// verifier is tended while the commands run, and no final at all, so the next tick starts round 1 itself.
// Waits for what that tick does: the Tree step, then Verify with its three opening lines published.
async function fstStartLive(h, ctx) {
    await seedDag(
        h,
        ctx,
        (dag) => {
            const { final: _final, pastfinals: _past, check: _check, setup: _setup, ...rest } = dag;
            return {
                ...rest,
                status: "finalizing",
                verify: FST_LIVE_VERIFY,
                finalcmd: FST_LIVE_FINAL,
                tasks: dag.tasks.map(({ runid: _run, reviewrunid: _review, ...t }) => ({ ...t, state: "done", merged: true })),
            };
        },
        fstLivePrint
    );
    const start = Date.now();
    let group = null;
    while (Date.now() - start < FST_ENGINE_WAIT_MS) {
        group = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
        if (group?.final?.step === "verify" && (group.final.output ?? "").includes(`${FST_MARK} 3`)) break;
        await polishNap(500);
    }
    const f = group?.final;
    return {
        status: group?.status,
        state: f?.state,
        step: f?.step,
        tree: f?.tree ?? "",
        verifierrunid: f?.verifierrunid ?? "",
        output: f?.output ?? "",
        waitedMs: Date.now() - start,
    };
}

async function arrangeFinalStage(h, ctx) {
    await h.cdp("Emulation.setDeviceMetricsOverride", FST_VIEWPORT);
    // before the run exists, as final-shots does: the captures walk every surface
    writeFinalShotsFixture(ctx.out, await captureFinalShotsFixture(h));
    ctx.shotsRound1 = finalShotsStages(ctx.out).fixing.pastfinals[0];
    fstGitInit(ctx.cwd);
    await arrangeFixtureRun(h, ctx, "final-stage", FST_LEAD);
    await h.rpc("dagsubmit", {
        channelid: ctx.channelId,
        runid: ctx.runId,
        title: "verify final-stage",
        parallelism: 1,
        tasks: FST_TASKS,
    });
    // a seed written while t-1 is still being dispatched would be overwritten by that tick
    await waitForDispatch(h, ctx, "t-1");
    ctx.dagId = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.oid;
    if (!ctx.dagId) throw new Error("the run has no dag");
    // the verifier's session is seeded, never spawned: a deferred quick run that carries the stage's role
    const wslist = await h.rpc("workspacelist", null);
    const created = await h.rpc("createrun", {
        channelid: ctx.channelId,
        workspaceid: wslist[0].workspacedata.oid,
        goal: "verify final-stage: the verifier's seeded run",
        runtime: "claude",
        mode: "quick",
        deferstart: true,
    });
    ctx.verifierRunId = created.run.id;
    ctx.verifierStart = Date.now() - 20 * 60_000;
    const verifierRun = await fstWriteRun(h, ctx.verifierRunId, (run) => ({ ...run, stagerole: "verifier", dagoref: ctx.dagId }));
    ctx.verifierSeeded = verifierRun?.stagerole === "verifier" && verifierRun.dagoref === ctx.dagId && !verifierRun.completedts;
    await h.ev(`localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "true")`);
    await fstShow(h, ctx, "waiting");
    ctx.leadFocused = await fstBoot(h, ctx, false);
}

export const finalStageScenario = {
    name: "final-stage",
    surface: "agent",
    async arrange(h) {
        const ctx = {
            out: mkdtempSync(join(tmpdir(), "verify-final-stage-out-")),
            cwd: mkdtempSync(join(tmpdir(), "verify-final-stage-")),
            prevRail: await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`),
        };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await arrangeFinalStage(h, ctx);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: fstHolds(ok), detail: JSON.stringify(detail) });
        const shot = (name) => h.shot(`cdp-shots/final-stage-${name}.png`);
        const clickRow = () => finalShotsClick(h, FST_ROW);
        const closeViewer = async () => {
            await finalShotsClick(h, `document.querySelector("[data-final-shots-viewer]")?.querySelector('button[aria-label="Close"]')`);
            await polishWaitFor(h, `document.querySelector("[data-final-shots-viewer]") == null`, 3000);
        };
        rec(
            "0. a git project's run with a dispatched t-1, a seeded verifier run, and the lead focused with its rail open",
            () => ctx.arrangeError == null && ctx.dispatched && ctx.verifierSeeded && ctx.leadFocused,
            ctx.arrangeError ?? {
                runId: ctx.runId,
                dagId: ctx.dagId,
                verifierRunId: ctx.verifierRunId,
                dispatched: ctx.dispatched,
                dispatchMs: ctx.dispatchMs,
                verifierSeeded: ctx.verifierSeeded,
                leadFocused: ctx.leadFocused,
            }
        );
        if (ctx.arrangeError != null) return steps;
        const wtRoot = arcWorktreeRoot();
        rec(
            "0b. the run's landing tree is under the user cache dir's arc-wt root, named by its run id's first 8 chars (or the whole id), not in the temp dir",
            () =>
                !!ctx.landPath &&
                existsSync(ctx.landPath) &&
                [ctx.runId.slice(0, 8), ctx.runId].includes(relative(wtRoot, ctx.landPath)),
            { landPath: ctx.landPath, root: wtRoot, cwd: ctx.cwd }
        );

        // --- Part B: the States rows, on a dag the engine leaves alone ---
        let a = await fstAgent(h, (s) => s.rows.length === 0 && s.railSteps === 0);
        let d = await fstDag(h, ctx, (s) => s.node.meta === "waits on every task");
        rec(
            "B1. tasks still running: no tree row and no slot; the last node reads waits on every task over five waiting segments",
            () =>
                a.rows.length === 0 &&
                a.slot == null &&
                d.cards[d.cards.length - 1] === "final" &&
                d.node.meta === "waits on every task" &&
                d.node.under === "on the merged result" &&
                fstSame(d.node.strip, fstRepeat("waiting", 5)),
            { rows: a?.rows, slot: a?.slot, cards: d?.cards, node: d?.node }
        );
        await shot("b1-waiting-dag");

        await fstShow(h, ctx, "tree");
        a = await fstAgent(h, (s) => s.rows.length === 1 && s.rows[0].sub.startsWith("Tree"));
        await clickRow();
        a = await fstUntil(h, FST_AGENT, (s) => s.rows[0].selected && s.pane != null && s.stage != null);
        await shot("b2-tree-pane");
        d = await fstDag(h, ctx, (s) => s.node.meta.startsWith("round 1 · Tree"));
        rec(
            "B2. preparing the tree: Tree · <time> · step 1 of 5, the step list with Tree running, no output box, and End final stage",
            () =>
                a.rows.length === 1 &&
                a.rows[0].title === "Final verification" &&
                /^Tree · \d+s · step 1 of 5$/.test(a.rows[0].sub) &&
                a.rows[0].tone === "run" &&
                a.slot === "run" &&
                fstSame(fstStates(a.pane.steps), ["running", ...fstRepeat("waiting", 4)]) &&
                a.pane.output == null &&
                a.pane.end &&
                fstSame(fstStates(a.stage.steps), ["running", ...fstRepeat("waiting", 4)]) &&
                /^round 1 · Tree · \d+s$/.test(d.node.meta) &&
                fstSame(d.node.strip, ["running", ...fstRepeat("waiting", 4)]) &&
                d.peek.output == null &&
                d.peek.steps[0].command === "prepares the tree the stage runs in" &&
                d.peek.steps[1].command === FST_CHECK,
            { row: a?.rows, slot: a?.slot, pane: a?.pane, node: d?.node, peek: d?.peek?.steps }
        );
        await shot("b2-tree-dag");

        let wait = await fstShow(h, ctx, "alongside");
        a = await fstAgent(h, (s) => s.rows[0].sub.startsWith("Check") && s.pane.steps[0].text === "passed 22s", wait);
        await shot("b3-alongside-pane");
        d = await fstDag(h, ctx, (s) => s.node.meta === "round 1 · Check · verifier");
        rec(
            "B3. verifier alongside (no Final command): four steps, the Verifier running beside Check, Tree's time from its event",
            () =>
                /^Check · \d+s · verifier alongside$/.test(a.rows[0].sub) &&
                a.rows[0].tone === "run" &&
                fstSame(fstStates(a.pane.steps), ["passed", "running", "waiting", "running"]) &&
                fstSame(a.pane.steps.map((s) => s.key), ["tree", "check", "verify", "verifier"]) &&
                a.pane.steps[0].text === "passed 22s" &&
                d.node.meta === "round 1 · Check · verifier" &&
                fstSame(d.node.strip, ["passed", "running", "waiting", "running"]),
            { row: a?.rows, pane: a?.pane?.steps, node: d?.node }
        );
        await shot("b3-alongside-dag");

        wait = await fstShow(h, ctx, "reviewing");
        a = await fstAgent(h, (s) => s.rows[0].sub.startsWith("verifier reviewing") && s.pane.steps[3].state === "passed", wait);
        await shot("b4-reviewing-pane");
        d = await fstDag(h, ctx, (s) => s.node.meta.startsWith("round 2 · verifier"));
        rec(
            "B4. verifier reviewing with its tab gone: the row is the stage's own, every command passed, the Verifier running, round 1 one line",
            () =>
                a.rows.length === 1 &&
                a.rows[0].selected &&
                a.pane != null &&
                /^verifier reviewing · 4m \d\ds$/.test(a.rows[0].sub) &&
                fstSame(fstStates(a.pane.steps), [...fstRepeat("passed", 4), "running"]) &&
                a.pane.output == null &&
                fstSame(a.stage.past, [{ round: "1", text: "round 1 · failed at Final" }]) &&
                /^round 2 · verifier · 4m \d\ds$/.test(d.node.meta) &&
                fstSame(d.node.strip, [...fstRepeat("passed", 4), "running"]) &&
                d.peek.open === false,
            { row: a?.rows, pane: a?.pane?.steps, past: a?.stage?.past, node: d?.node, open: d?.peek?.open }
        );
        await shot("b4-reviewing-dag");

        wait = await fstShow(h, ctx, "failed");
        a = await fstAgent(h, (s) => s.rows[0].tone === "fail" && s.pane.steps[3].state === "failed", wait);
        await shot("b5-failed-pane");
        await finalShotsClick(h, `${FST_PANE}?.querySelector("[data-final-shots-link]")`);
        const paneViewer = (await fstUntil(h, FST_AGENT, (s) => s.viewer))?.viewer;
        await closeViewer();
        d = await fstDag(h, ctx, (s) => s.node.meta === "round 1 · failed at Final");
        await shot("b5-failed-dag");
        await finalShotsClick(h, `${FST_DAG_PEEK}?.querySelector("[data-final-shots-link]")`);
        const peekViewer = (await fstUntil(h, FST_DAG, (s) => s.viewer))?.viewer;
        await shot("b5-failed-viewer");
        await closeViewer();
        rec(
            "B5. failed at Final in round 1: the detail whole, the Verifier not run, the lead has it, and the screenshots open the viewer from the pane and the DAG peek card",
            () =>
                a.rows[0].sub === "failed at Final · round 1" &&
                a.rows[0].tone === "fail" &&
                a.slot === "fail" &&
                fstSame(fstStates(a.pane.steps), [...fstRepeat("passed", 3), "failed", "notrun"]) &&
                a.pane.text.includes(fstFlat(FST_DETAIL)) &&
                a.pane.text.includes("The lead has this failure") &&
                !a.pane.end &&
                a.pane.shots != null &&
                paneViewer &&
                d.node.meta === "round 1 · failed at Final" &&
                fstSame(d.node.strip, [...fstRepeat("passed", 3), "failed", "notrun"]) &&
                d.peek.text.includes(fstFlat(FST_DETAIL)) &&
                d.peek.shots != null &&
                peekViewer,
            { row: a?.rows, slot: a?.slot, pane: a?.pane, paneViewer, node: d?.node, peek: d?.peek, peekViewer }
        );

        // a step that ended kept its output beside the round's ARC_FINAL_OUT (finalStepsDir); only Check's is
        // written here, so Verify stands for a step whose output is gone
        const keptDir = join(ctx.out, "1-steps");
        mkdirSync(keptDir, { recursive: true });
        writeFileSync(join(keptDir, "check.txt"), `${FST_KEPT_MARK}\n`);
        await h.goto("agent");
        const paneCell = (key) => `${FST_PANE}?.querySelector('[data-final-step="${key}"]')`;
        const keptRead = `(() => ({
            pane: (${FST_PANE}?.textContent ?? "").replace(/\\s+/g, " ").trim(),
            pressed: [...(${FST_PANE}?.querySelectorAll('[data-final-step][aria-pressed="true"]') ?? [])].map((c) => c.getAttribute("data-final-step")),
            rail: (${FST_RAIL}?.querySelector("[data-final-rail]")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
        }))()`;
        await finalShotsClick(h, paneCell("check"));
        const keptCheck = await fstUntil(h, keptRead, (s) => s.pane.includes(FST_KEPT_MARK));
        await shot("b5b-kept-check");
        await finalShotsClick(h, paneCell("verify"));
        const keptGone = await fstUntil(h, keptRead, (s) => s.pane.includes("no output kept"));
        await finalShotsClick(h, paneCell("verify"));
        const keptClosed = await fstUntil(h, keptRead, (s) => s.pressed.length === 0);
        await finalShotsClick(h, `${FST_RAIL}?.querySelector('[data-final-rail] [data-final-step="check"]')`);
        const keptRail = await fstUntil(h, keptRead, (s) => s.rail.includes(FST_KEPT_MARK));
        await shot("b5b-kept-rail");
        await fstDag(h, ctx, (s) => s.node.meta === "round 1 · failed at Final");
        const dagCell = `${FST_DAG_PEEK}?.querySelector('[data-final-step="check"]')`;
        const dagRead = `(() => ({
            text: (${FST_DAG_PEEK}?.textContent ?? "").replace(/\\s+/g, " ").trim(),
            expanded: [...(${FST_DAG_PEEK}?.querySelectorAll('[data-final-step][aria-expanded="true"]') ?? [])].map((c) => c.getAttribute("data-final-step")),
        }))()`;
        await finalShotsClick(h, dagCell);
        const keptDag = await fstUntil(h, dagRead, (s) => s.text.includes(FST_KEPT_MARK));
        await shot("b5b-kept-dag");
        await finalShotsClick(h, dagCell);
        const keptDagClosed = await fstUntil(h, dagRead, (s) => s.expanded.length === 0);
        rec(
            "B5b. a step that ended opens the output it kept: Check's from the pane, the rail and the DAG peek card (under its row, the outcome still shown), Verify's says none was kept, and a second click returns to the outcome",
            () =>
                fstSame(keptCheck.pressed, ["check"]) &&
                keptCheck.pane.includes(`$ ${FST_CHECK}`) &&
                fstSame(keptGone.pressed, ["verify"]) &&
                !keptGone.pane.includes(FST_KEPT_MARK) &&
                keptClosed.pane.includes(fstFlat(FST_DETAIL)) &&
                keptRail.rail.includes(FST_KEPT_MARK) &&
                fstSame(keptDag.expanded, ["check"]) &&
                keptDag.text.includes(fstFlat(FST_DETAIL)) &&
                keptDagClosed.text.includes(fstFlat(FST_DETAIL)) &&
                !keptDagClosed.text.includes(FST_KEPT_MARK),
            { keptCheck, keptGone, keptClosed, keptRail, keptDag, keptDagClosed }
        );

        await fstShow(h, ctx, "fixing");
        a = await fstAgent(h, (s) => s.rows[0].sub.startsWith("round 2") && s.rows[0].tone === "wait");
        await shot("b6-fixing-pane");
        d = await fstDag(h, ctx, (s) => s.node.meta.startsWith("round 2 waits on"));
        rec(
            "B6. fix round under way: round 2 waits on the unfinished tasks, every step waiting, round 1 one past-round line",
            () =>
                a.rows[0].sub === "round 2 after 3 fix tasks" &&
                a.rows[0].tone === "wait" &&
                fstSame(fstStates(a.pane.steps), fstRepeat("waiting", 5)) &&
                fstSame(a.stage.past, [{ round: "1", text: "round 1 · failed at Final" }]) &&
                d.node.meta === "round 2 waits on t-1, t-2, t-3" &&
                fstSame(d.node.strip, fstRepeat("waiting", 5)) &&
                fstSame(d.peek.past, [{ round: "1", text: "round 1 · failed at Final" }]),
            { row: a?.rows, pane: a?.pane, past: a?.stage?.past, node: d?.node, peek: d?.peek }
        );
        await shot("b6-fixing-dag");

        // the verifier's tab joins the roster. Until the stage names its run, that tab is a stage row an earlier
        // round left, and the stage's row is its own
        await fstShow(h, ctx, "reviewing", { verifier: false });
        const rebooted = await fstBoot(h, ctx, true);
        await fstAgent(h, (s) => s.rows.length === 1);
        await clickRow();
        const own = await fstUntil(h, FST_AGENT, (s) => s.rows[0].selected && s.pane != null);
        wait = await fstShow(h, ctx, "reviewing");
        // the stage's own row leaves through the tree's exit animation, so one row is waited for, not read at once
        a = await fstUntil(h, FST_AGENT, (s) => s.pane == null && s.rows.length === 1 && s.rows[0].selected && s.stage.steps[3].state === "passed", wait);
        rec(
            "B7a. the row becomes the verifier's session: a focus on the stage's own row moves to the agent, one row, its rail keeps the step list",
            () =>
                rebooted &&
                own.rows.length === 1 &&
                own.rows[0].selected &&
                own.pane != null &&
                a.rows.length === 1 &&
                a.rows[0].selected &&
                a.pane == null &&
                a.rows[0].sub.startsWith("verifier reviewing") &&
                fstSame(fstStates(a.stage.steps), [...fstRepeat("passed", 4), "running"]),
            { rebooted, own: { rows: own?.rows, pane: own?.pane != null }, rows: a?.rows, pane: a?.pane != null, stage: a?.stage }
        );
        await shot("b7-session-agent");
        // away from the row, so landing on it is the Enter's doing
        await fstFocusLead(h);
        const away = await fstUntil(h, FST_AGENT, (s) => s.rows[0].selected === false);
        d = await fstDag(h, ctx, (s) => s.peek.open === true);
        await shot("b7-session-dag");
        const entered = await h.ev(`(() => {
            const node = ${FST_NODE}?.closest(".react-flow__node");
            if (!node) return false;
            // Enter on a focused button is the button's own
            node.focus({ preventScroll: true });
            const init = { key: "Enter", code: "Enter", bubbles: true, cancelable: true };
            (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", init));
            return true;
        })()`);
        const landed = await fstUntil(
            h,
            `({ modal: ${FST_MODAL} != null, agent: ${FST_AGENT} })`,
            (s) => !s.modal && s.agent.rows[0].selected
        );
        const onAgent = await h.activeSurfaceLabel();
        rec(
            "B7b. the final node's peek card has Open in Agent, and Enter on the node lands on the Agent surface with the verifier's session focused",
            () =>
                away.rows[0].selected === false &&
                d.peek.open === true &&
                entered &&
                !landed.modal &&
                onAgent === SURFACE_LABEL.agent &&
                landed.agent.rows.length === 1 &&
                landed.agent.rows[0].selected &&
                landed.agent.pane == null,
            { away: away?.rows, open: d?.peek?.open, entered, onAgent, modal: landed?.modal, rows: landed?.agent?.rows }
        );

        // the verifier gave its verdict: its run is over
        await fstWriteRun(h, ctx.verifierRunId, (run) => ({ ...run, completedts: ctx.verifierStart + FST_VERIFIER_MS }));
        wait = await fstShow(h, ctx, "unverified");
        a = await fstAgent(h, (s) => s.rows[0].tone === "warn" && s.stage.steps[4].state === "unverified", wait);
        await shot("b8-unverified-agent");
        d = await fstDag(h, ctx, (s) => s.node.meta === "round 2 · unverified");
        rec(
            "B8. unverified in round 2 on the verifier's verdict: unverified · 1 reason, the reason whole, the Verifier unverified, round 1 one line",
            () =>
                a.rows.length === 1 &&
                a.rows[0].sub === "unverified · 1 reason" &&
                a.rows[0].tone === "warn" &&
                a.slot === "warn" &&
                fstSame(fstStates(a.stage.steps), [...fstRepeat("passed", 4), "unverified"]) &&
                d.node.meta === "round 2 · unverified" &&
                fstSame(d.node.strip, [...fstRepeat("passed", 4), "unverified"]) &&
                d.peek.text.includes(FST_UNVERIFIED) &&
                !d.peek.end &&
                fstSame(d.peek.past, [{ round: "1", text: "round 1 · failed at Final" }]),
            { row: a?.rows, slot: a?.slot, stage: a?.stage, node: d?.node, peek: d?.peek }
        );
        await shot("b8-unverified-dag");

        wait = await fstShow(h, ctx, "passed");
        await h.goto("agent");
        // off the row, or the fold stays open under the reader
        await fstFocusLead(h);
        const folded = await fstUntil(h, FST_AGENT, (s) => s.rows.length === 0 && s.fold != null);
        await shot("b9-passed-folded");
        await finalShotsClick(h, FST_FOLD);
        await fstUntil(h, FST_AGENT, (s) => s.rows.length === 1);
        await clickRow();
        a = await fstUntil(h, FST_AGENT, (s) => s.rows[0].sub === `passed · ${FST_TOTAL}` && s.stage != null, wait);
        await shot("b9-passed-agent");
        d = await fstDag(h, ctx, (s) => s.node.meta === `round 2 · passed · ${FST_TOTAL}`);
        rec(
            "B9. passed in round 2: the row is inside the run's finished group, every step shows its time, and the row and the node show the total",
            () =>
                folded.rows.length === 0 &&
                /review/.test(folded.fold) &&
                a.rows.length === 1 &&
                a.rows[0].sub === `passed · ${FST_TOTAL}` &&
                a.rows[0].tone === "pass" &&
                a.slot === "pass" &&
                fstSame(a.stage.steps.map((s) => s.text), FST_STEP_TEXT) &&
                d.node.meta === `round 2 · passed · ${FST_TOTAL}` &&
                fstSame(d.node.strip, fstRepeat("passed", 5)) &&
                fstSame(d.peek.steps.map((s) => s.text), FST_STEP_TEXT),
            { folded: { rows: folded?.rows, fold: folded?.fold }, row: a?.rows, slot: a?.slot, stage: a?.stage, node: d?.node, peek: d?.peek?.steps }
        );
        await shot("b9-passed-dag");

        // a reload drops the published events; without Check's the stage has no total, and every state stands
        const reloaded = await fstBoot(h, ctx, true);
        wait = await fstShow(h, ctx, "passed", { skip: "check" });
        if (await h.ev(`${FST_ROW} == null && ${FST_FOLD} != null`)) await finalShotsClick(h, FST_FOLD);
        await fstUntil(h, FST_AGENT, (s) => s.rows.length === 1);
        await clickRow();
        a = await fstUntil(h, FST_AGENT, (s) => s.rows[0].sub === "passed" && s.stage.steps[0].text === "passed 22s", wait);
        await shot("b10-no-total-agent");
        d = await fstDag(h, ctx, (s) => s.node.meta === "round 2 · passed");
        rec(
            "B10. with one step's event gone: the total leaves the row and the node, that step shows no time, and every state stays passed",
            () =>
                reloaded &&
                a.rows[0].sub === "passed" &&
                a.rows[0].tone === "pass" &&
                fstSame(fstStates(a.stage.steps), fstRepeat("passed", 5)) &&
                fstSame(a.stage.steps.map((s) => s.text), FST_STEP_TEXT.map((t, i) => (i === 1 ? "passed" : t))) &&
                d.node.meta === "round 2 · passed" &&
                fstSame(d.node.strip, fstRepeat("passed", 5)),
            { reloaded, row: a?.rows, stage: a?.stage, node: d?.node }
        );
        await shot("b10-no-total-dag");

        // --- Part A: a dag really finalizing, run by the engine ---
        const live = await fstStartLive(h, ctx);
        const liveBoot = await fstBoot(h, ctx, false);
        rec(
            "A0. the engine started round 1 on the seeded dag: Verify running with output, no tree on the stage and no verifier",
            () =>
                liveBoot &&
                live.status === "finalizing" &&
                live.state === "checking" &&
                live.step === "verify" &&
                live.output.includes(`${FST_MARK} 3`) &&
                live.tree === "" &&
                live.verifierrunid === "",
            { liveBoot, ...live }
        );
        a = await fstAgent(h, (s) => s.rows.length === 1 && /step 2 of 4$/.test(s.rows[0].sub) && s.status != null, {
            ms: 20_000,
        });
        rec(
            "A1. the tree has one Final verification row naming the running step, and the run's strip has its final slot",
            () =>
                a.rows.length === 1 &&
                a.rows[0].title === "Final verification" &&
                /^Verify · \S.* · step 2 of 4$/.test(a.rows[0].sub) &&
                a.rows[0].tone === "run" &&
                a.slot === "run" &&
                /final verification/i.test(a.strip),
            { rows: a?.rows, slot: a?.slot, strip: a?.strip }
        );
        rec(
            "A2. the lead's rail draws no step of the stage, the tree's row carries it, and the Run status reads Verifying",
            () =>
                a.railSteps === 0 &&
                a.status.startsWith("Verifying") &&
                a.status.includes("next Final, then the verifier"),
            { railSteps: a?.railSteps, status: a?.status }
        );
        await shot("a1-row-and-lead-rail");

        // the form the run sheet shares with the pane, opened where it always was and left without ending
        await h.goto("jarvis");
        await polishWaitFor(h, `typeof window.__openAddress === "function"`, 5000);
        await h.ev(`window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)})`);
        const sheetEnd = fstButton(FST_SHEET, "End final stage");
        await polishWaitFor(h, `!!${sheetEnd}`, 10_000);
        await finalShotsClick(h, sheetEnd);
        const sheetFormExpr = `(() => {
            const form = ${FST_SHEET}?.querySelector("[data-run-sheet-end-final]");
            return form
                ? {
                      reason: form.querySelector("textarea") != null,
                      buttons: [...form.querySelectorAll("button")].map((b) => b.textContent.trim()),
                  }
                : null;
        })()`;
        const sheetForm = await fstUntil(h, sheetFormExpr, (s) => s.reason);
        await shot("a3-run-sheet-end-form");
        await finalShotsClick(h, fstButton(`${FST_SHEET}?.querySelector("[data-run-sheet-end-final]")`, "Keep running"));
        const sheetClosed = await polishWaitFor(h, `${FST_SHEET} != null && ${sheetFormExpr} == null`, 5000);
        const stillRunning = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.final?.state;
        rec(
            "A3. the run sheet's End final stage opens the shared form with its reason box and both outcomes, and Keep running closes it",
            () =>
                sheetForm.reason &&
                fstSame(sheetForm.buttons, ["Pass unverified", "Fail", "Keep running"]) &&
                sheetClosed &&
                stillRunning === "checking",
            { sheetForm, sheetClosed, stillRunning }
        );

        await h.goto("agent");
        await finalShotsClick(h, `${FST_TREE}?.querySelector("[data-final-row]")`);
        a = await fstUntil(h, FST_AGENT, (s) => s.rows[0].selected && s.pane.output != null && s.stage != null);
        rec(
            "A4. clicking the tree's row focuses it: the pipeline, the running command and its output, the stage's facts and step list once, and End final stage",
            () =>
                a.rows[0].selected &&
                a.railSteps === a.stage.steps.length &&
                fstSame(fstStates(a.pane.steps), ["passed", "running", "waiting", "waiting"]) &&
                a.pane.text.includes(`$ ${FST_LIVE_VERIFY}`) &&
                a.pane.output.includes(`${FST_MARK} 3`) &&
                a.pane.end &&
                fstSame(fstStates(a.stage.steps), ["passed", "running", "waiting", "waiting"]) &&
                ["Commit", "Tree", "Reviewers"].every((fact) => a.stage.text.includes(fact)) &&
                !a.stage.text.includes("Round"),
            { rows: a?.rows, pane: a?.pane, stage: a?.stage, railSteps: a?.railSteps }
        );
        await shot("a4-pane");

        d = await fstDag(h, ctx, (s) => s.peek.output != null);
        rec(
            "A5. the DAG's last node is the final stage, with an edge from each sink task, and the stage line has no final verify entry",
            () =>
                d.cards[d.cards.length - 1] === "final" &&
                fstSame(d.edges.filter((e) => e.endsWith(">final")), FST_SINK_EDGES) &&
                /^round 1 · Verify · /.test(d.node.meta) &&
                fstSame(d.node.strip, ["passed", "running", "waiting", "waiting"]) &&
                d.stageLine.startsWith("Run route ·") &&
                !/final verify/i.test(d.stageLine),
            { cards: d?.cards, edges: d?.edges, node: d?.node, stageLine: d?.stageLine }
        );
        rec(
            "A6. selecting the node opens its peek card: each step's command and state, the output tail and End final stage",
            () =>
                d.node.pressed === "true" &&
                fstSame(d.peek.steps.map((s) => s.command), [
                    "prepares the tree the stage runs in",
                    FST_LIVE_VERIFY,
                    FST_LIVE_FINAL,
                    "judges the merged result",
                ]) &&
                fstSame(fstStates(d.peek.steps), ["passed", "running", "waiting", "waiting"]) &&
                d.peek.output.includes(FST_MARK) &&
                d.peek.end,
            { node: d?.node, peek: d?.peek }
        );
        await shot("a6-dag-peek");

        // the form opens inside the card, whose height the placement bounds by the pane; nothing else measures it
        const PEEK_FORM = `document.querySelector("[data-dag-final-peek] [data-run-sheet-end-final]")`;
        await finalShotsClick(h, `document.querySelector("[data-dag-final-peek] [data-final-end]")`);
        await polishWaitFor(h, `${PEEK_FORM} != null`, 3000);
        const peekForm = await h.ev(`(() => {
            const form = ${PEEK_FORM};
            if (!form) return null;
            const box = form.parentElement.getBoundingClientRect();
            const card = form.closest("[data-dag-final-peek]");
            const c = card.getBoundingClientRect();
            const clippedBy = [];
            for (let el = form.parentElement.parentElement; el && el !== document.body; el = el.parentElement) {
                const cs = getComputedStyle(el);
                if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
                const r = el.getBoundingClientRect();
                if (box.top < r.top - 0.5 || box.bottom > r.bottom + 0.5 || box.left < r.left - 0.5 || box.right > r.right + 0.5) {
                    clippedBy.push((el.className || el.tagName).toString().slice(0, 60));
                }
            }
            // what sits on the form's bottom corners: the form itself unless something covers or cuts it
            const corner = (x, y) => form.parentElement.contains(document.elementFromPoint(x, y));
            return {
                box: { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) },
                card: { top: Math.round(c.top), bottom: Math.round(c.bottom) },
                inCard: card != null,
                cardCuts: box.top < c.top - 0.5 || box.bottom > c.bottom + 0.5 || box.left < c.left - 0.5 || box.right > c.right + 0.5,
                viewport: innerHeight,
                clippedBy,
                corners: corner(box.left + 4, box.bottom - 4) && corner(box.right - 4, box.bottom - 4),
            };
        })()`);
        await shot("a6-dag-peek-end-form");
        await finalShotsClick(h, fstButton(PEEK_FORM, "Keep running"));
        const peekFormClosed = await polishWaitFor(h, `${PEEK_FORM} == null`, 3000);
        rec(
            "A6b. End final stage in the DAG peek card opens its form whole inside the card: neither the card nor any clipping ancestor cuts it, nothing covers its bottom, and Keep running closes it",
            () =>
                peekForm != null &&
                peekForm.inCard &&
                !peekForm.cardCuts &&
                peekForm.clippedBy.length === 0 &&
                peekForm.corners &&
                peekForm.box.bottom <= peekForm.viewport &&
                peekFormClosed,
            { peekForm, peekFormClosed }
        );

        await h.goto("agent");
        await finalShotsClick(h, `${FST_PANE}?.querySelector("[data-final-end]")`);
        const paneForm = (await fstUntil(h, FST_AGENT, (s) => s.pane.form))?.pane?.form;
        const typed = await h.ev(`(() => {
            const box = ${FST_PANE}?.querySelector("[data-run-sheet-end-final] textarea");
            if (!box) return false;
            // a controlled input takes a value only through the native setter and an input event
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(box, ${JSON.stringify(FST_REASON)});
            box.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        })()`);
        const unverifiedBtn = fstButton(`${FST_PANE}?.querySelector("[data-run-sheet-end-final]")`, "Pass unverified");
        await polishWaitFor(h, `${unverifiedBtn}?.disabled === false`, 3000);
        await shot("a7-end-form");
        await finalShotsClick(h, unverifiedBtn);
        a = await fstUntil(h, FST_AGENT, (s) => s.rows[0].tone === "warn" && s.pane.steps[1].state === "stopped", { ms: 20_000 });
        await shot("a7-ended-pane");
        d = await fstDag(h, ctx, (s) => s.node.meta === "round 1 · unverified");
        rec(
            "A7. End final stage, as unverified with a reason: the row, the pane and the node read unverified, the reason is whole, and Verify reads stopped",
            () =>
                paneForm &&
                typed &&
                a.rows.length === 1 &&
                a.rows[0].sub === "unverified · 1 reason" &&
                a.rows[0].tone === "warn" &&
                a.slot === "warn" &&
                fstSame(fstStates(a.pane.steps), ["passed", "stopped", "notrun", "notrun"]) &&
                a.pane.text.includes(`ended by the human: ${FST_REASON}`) &&
                !a.pane.end &&
                d.node.meta === "round 1 · unverified" &&
                fstSame(d.node.strip, ["passed", "stopped", "notrun", "notrun"]) &&
                d.peek.text.includes(`ended by the human: ${FST_REASON}`) &&
                !d.peek.end,
            { paneForm, typed, rows: a?.rows, slot: a?.slot, pane: a?.pane, node: d?.node, peek: d?.peek }
        );
        await shot("a7-ended-dag");
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "final-stage", {
            what: "cancel the channel's other runs and restore the rail preference",
            fn: async () => {
                try {
                    // the verifier's seeded run, and t-1's child run, which Part A unlinked from its task with its
                    // worker still at work in the lane's tree
                    const runs = ctx.channelId ? await channelRuns(h, ctx.channelId) : [];
                    for (const run of runs) {
                        if (run.id === ctx.runId) {
                            // the engine completed the run when the stage was ended, and a finished run is not cancelled
                            if (run.status === "done") ctx.runId = null;
                        } else if (run.status !== "done" && run.status !== "cancelled") {
                            await h.rpc("cancelrun", { channelid: ctx.channelId, runid: run.id });
                        }
                    }
                } finally {
                    await h.ev(
                        ctx.prevRail == null
                            ? `localStorage.removeItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`
                            : `localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, ${JSON.stringify(ctx.prevRail)})`
                    );
                }
            },
        });
        rmSync(ctx.out, { recursive: true, force: true });
        // a worker that was just stopped holds its lane's tree for a moment, and a tree left behind fails the scenario
        rmSync(ctx.cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    },
};
// --- new-run-window, model-picks: a model per task (docs/superpowers/specs/2026-09-29-worker-reviewer-models-design.md)
// Both read one three-task plan of noops: Task 1 has a Model line, Tasks 2 and 3 are left to the plan reviewer.
const MODELS_RPC = { timeout: 30000 };

// --- autonomous-runs: the Approvals setting on each of its boards (docs/orchestrator-guide.md, Autonomous runs)
// One project with one orchestrator run held by deferstart. Its lead is a seeded tab, linked as the lead by a tab oref
// on the running phase, whose block runs a stdin sink: the server's switch finds the lead's Plan review question
// there deterministically, and the answer it types lands somewhere harmless. The fixture roster names that tab as the
// lead asking Plan review, which is how the sheet and the palette learn of the question; no live agent runs.
const AUTONOMOUS_PROJECT = "verify-autonomous-runs";
const AUTONOMOUS_LEAD_ASK = {
    header: "Plan review",
    question: "The plan review failed twice. Proceed with the plan as it stands?",
    options: [{ label: "Accept all and proceed" }, { label: "Request changes" }],
};
const AUTONOMOUS_PROFILE_NOTE =
    "The lead takes the option it would recommend at each of those points and records why in its report. If the final stage still fails after the last round, the land stays held for you.";
const AUTONOMOUS_RESOLVED =
    "The lead is carrying the plan review's findings into the tasks and going on. It answers everything from here on; each call it makes goes in its report.";
const AUTONOMOUS_BACK_TO_ASK = "The lead asks you again from its next decision. Calls it already made stand.";
// typing the ON answer takes 60ms a rune, so the question leaves the registry well inside this
const AUTONOMOUS_ANSWER_WAIT_MS = 20_000;
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
async function autonomousLeadAsk(h, ctx) {
    return (await h.rpc("runasks", { channelid: ctx.channelId, runid: ctx.runId }))?.asks?.[0] ?? null;
}

async function raiseLeadAsk(h, ctx) {
    await h.rpc("ask", { oref: `block:${ctx.leadBlockId}`, questions: [AUTONOMOUS_LEAD_ASK] });
    ctx.askRaised = true;
}

// the fixture lead's face: asking Plan review, or working once its question is answered
const patchFixtureLead = (h, ctx, asking) =>
    h.ev(
        `window.__cockpitRosterFixture?.patch(${JSON.stringify(ctx.leadTabId)}, ${
            asking
                ? JSON.stringify({ state: "asking", ask: { questions: [AUTONOMOUS_LEAD_ASK], oref: `block:${ctx.leadBlockId}` } })
                : "{ state: 'working', ask: undefined }"
        })`
    );

// The lead's tab, in the page's own workspace. Its block runs a node process that reads and drops stdin: a shell
// would run the typed answer, and the picker's arrow keys would recall its history first.
async function seedAutonomousLead(h, ctx) {
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
                underModels: models != null && models.nextElementSibling === group?.parentElement,
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
        await h.ev(clickByText(NEW_RUN, "button", "Cancel"));
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

const PICKS_BANNER = `document.querySelector('[data-dag-modal-kind] [data-model-picks-banner]')`;
// the pick row lives in the selected task's peek card, so only the selected task's row is ever on screen
const PICKS_PEEK = `[data-dag-modal-kind] [data-dag-task-peek]`;
const PICK_ROWS = `[...document.querySelectorAll('${PICKS_PEEK} [data-model-pick]')]`;
const pickRowExpr = (id) => `document.querySelector('${PICKS_PEEK} [data-model-pick="${id}"]')`;
const pickToggleExpr = (id, sonnet) =>
    `[...(${pickRowExpr(id)}?.querySelectorAll('[role="group"] button') ?? [])].find((b) => (b.textContent.trim() === 'sonnet') === ${sonnet})`;
const dagCardExpr = (id) => `document.querySelector('[data-dag-modal-kind] [data-dag-node="${id}"]')`;
// a card's model tag is its own span, `<model> · <source>`
const cardTagExpr = (id) =>
    `([...(${dagCardExpr(id)}?.querySelectorAll('span') ?? [])].map((s) => s.textContent.trim()).find((t) => / · (plan|review|you|escalated|pinned)$/.test(t)) ?? null)`;
// the peek card's Worker row carries the same route attribute as the nodes
const DAG_RAIL_ROUTE = `document.querySelector('${PICKS_PEEK} [data-dag-node-route]')`;
const peekRouteExpr = (id) => `document.querySelector('[data-dag-modal-kind] [data-dag-task-peek="${id}"] [data-dag-node-route]')`;
const railExpr = `({ route: ${DAG_RAIL_ROUTE}?.getAttribute('data-dag-node-route') ?? null, text: ${flatText(DAG_RAIL_ROUTE)} })`;
// Task 1's Model line leaves it off the picks; one sonnet pick and one lead pick make the banner "1 of 3"
const MODEL_PICKS = [
    { taskid: "t-2", model: "sonnet", reason: "a noop needs no deep reasoning" },
    { taskid: "t-3", model: "lead", reason: "kept on the lead, so its rail must show no pick" },
];

async function dagTask(h, ctx, id) {
    const g = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
    return (g?.tasks ?? []).find((t) => t.id === id) ?? null;
}

async function waitDagTask(h, ctx, id, ok) {
    let task = null;
    for (let waited = 0; waited < 8000; waited += 250) {
        task = await dagTask(h, ctx, id);
        if (task != null && ok(task)) break;
        await polishNap(250);
    }
    return task;
}

const taskFacts = (t) =>
    t && { state: t.state, modelsource: t.modelsource ?? "", runtime: t.runspec?.runtime ?? "", model: t.runspec?.model ?? "" };

// the plan review's reviewers are real sessions; haiku keeps a round's two cheap
const HAIKU_ROUTE = { runtime: "claude", model: "haiku" };
const ROUND_ONE_LENSES = ["full", "second"];
const LENS_TITLE = {
    full: "Full review",
    second: "Second pass",
    followup: "Round-2 follow-up",
};
const PLAN_REVIEWER_WAIT_MS = 90000;

const planReviewOf = async (h, ctx) =>
    (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.planreview ?? null;

// Waits for the round's reviewers to start, then records each one's verdict in its own name before it can send
// one, the reviewer that picks models last, so the round settles on it. verdicts maps a lens to
// { verdict, notes, picks? }, in the order they are sent.
async function recordPlanReviewRound(h, ctx, round, verdicts) {
    const lenses = Object.keys(verdicts);
    let pr = null;
    const started = () =>
        pr?.round === round &&
        (pr.reviewers ?? []).length === lenses.length &&
        pr.reviewers.every((r) => r.runid && lenses.includes(r.lens));
    for (let waited = 0; waited < PLAN_REVIEWER_WAIT_MS && !started(); waited += 1000) {
        pr = await planReviewOf(h, ctx);
        if (!started()) await polishNap(1000);
    }
    if (!started()) {
        throw new Error(`round ${round}: want reviewers ${lenses.join(", ")} with run ids, got ${JSON.stringify(pr?.reviewers ?? null)}`);
    }
    for (const lens of lenses) {
        const r = pr.reviewers.find((x) => x.lens === lens);
        if (r.state !== "reviewing") {
            throw new Error(`round ${round}: the ${lens} reviewer sent its own verdict (${r.state}) before the scenario could`);
        }
        const v = verdicts[lens];
        await h.rpc(
            "dagaction",
            {
                channelid: ctx.channelId,
                runid: r.runid,
                taskid: "",
                action: `planreview-${v.verdict}`,
                notes: v.notes,
                ...(v.picks ? { picks: v.picks } : {}),
            },
            MODELS_RPC
        );
    }
}

const PLAN_REVIEWER_CHIPS = `[...document.querySelectorAll('[data-dag-modal-kind] [data-plan-reviewer]')].map((c) => ({
    lens: c.getAttribute('data-plan-reviewer'),
    state: c.getAttribute('data-plan-reviewer-state'),
    line: (c.parentElement?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
}))`;
const DAG_RAIL = `document.querySelector('[data-dag-modal-kind] [data-timeline-rail]')`;

// Opens the timeline rail's group whose title starts with prefix, and reads the titles of its events and the
// plan reviewer sub-rows under them. One group is open at a time, so opening it closes any other.
const railGroupExpr = (prefix) => `(async () => {
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const rows = () => [...(${DAG_RAIL}?.querySelectorAll('[data-timeline-row]') ?? [])];
    const row = () => rows().find((b) => flat(b.querySelector('span > span')).startsWith(${JSON.stringify(prefix)}));
    for (let i = 0; i < 40 && !row(); i++) await new Promise((r) => setTimeout(r, 250));
    if (!row()) return { found: false, rows: rows().map((b) => flat(b.querySelector('span > span'))) };
    if (row().getAttribute('aria-expanded') !== 'true') row().click();
    for (let i = 0; i < 20 && !row().nextElementSibling; i++) await new Promise((r) => setTimeout(r, 100));
    const detail = row().nextElementSibling;
    return {
        found: true,
        titles: [...(detail?.querySelectorAll(':scope > div > div:first-child > span:nth-child(2)') ?? [])].map(flat),
        reviewers: [...(detail?.querySelectorAll('[data-plan-review-reviewer]') ?? [])].map((r) => ({
            lens: r.getAttribute('data-plan-review-reviewer'),
            text: flat(r),
        })),
    };
})()`;

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export const modelPicks = {
    name: "model-picks",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-model-picks-"));
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-model-picks", projectpath: cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: "verify model-picks: do nothing, make no file changes, stop immediately",
                runtime: "claude",
                mode: "orchestrator",
                deferstart: true,
                reviewerpicks: true,
                reviewerroute: HAIKU_ROUTE,
                lightreviewerroute: HAIKU_ROUTE,
                parallelism: 1,
            });
            ctx.runId = created.run.id;
            await h.rpc(
                "dagsubmit",
                { channelid: ctx.channelId, runid: ctx.runId, parallelism: 1, planpath: MODELS_PLAN },
                MODELS_RPC
            );
            // the two reviewers are real sessions, spawned after the submit returns: the second pass's pass, then
            // the full reviewer's with the picks
            const pass = { verdict: "pass", notes: "verify model-picks: three noops" };
            await recordPlanReviewRound(h, ctx, 1, {
                second: pass,
                full: { ...pass, picks: MODEL_PICKS },
            });
            // the Brief reads a boot-primed snapshot, so the RPC-created channel needs a reload
            await polishReload(h);
            ctx.opened = await h.ev(`(async () => {
                for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                if (typeof window.__openAddress !== "function") return { ok: false, why: "no __openAddress hook" };
                return window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)});
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. a Reviewer picks run passed its plan review with picks", false, ctx.arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        const openDag = `[...(document.querySelector('[data-jarvis-brief-sheet]')?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Open DAG')`;
        const sheet = await polishWaitFor(h, `!!${openDag}`, 15000);
        if (sheet) await h.ev(`${openDag}.click()`);
        const graph = await polishWaitFor(
            h,
            `!!document.querySelector('[data-dag-modal-kind="live"]') && document.querySelectorAll('[data-dag-modal-kind] [data-dag-node]:not([data-dag-node="final"])').length === 3`,
            10000
        );
        rec(
            "0. the run's graph opened with its 3 tasks",
            ctx.opened?.ok === true && sheet && graph,
            JSON.stringify({ runId: ctx.runId, opened: ctx.opened, sheet, graph })
        );
        if (!graph) return steps;

        await polishWaitFor(h, `!!${PICKS_BANNER}`, 5000);
        const banner = await h.ev(flatText(PICKS_BANNER));
        await h.shot("cdp-shots/model-picks-1-banner.png");
        rec("1. the banner reads `1 of 3 tasks on sonnet`", banner.includes("1 of 3 tasks on sonnet"), `banner=${JSON.stringify(banner)}`);

        await h.ev(`${dagCardExpr("t-3")}?.click()`);
        const leadCard = await polishWaitFor(h, `!!${peekRouteExpr("t-3")}`, 3000);
        const leadRows = await h.ev(`${PICK_ROWS}.map((r) => r.getAttribute('data-model-pick'))`);
        await h.ev(`${dagCardExpr("t-2")}?.click()`);
        await polishWaitFor(h, `!!${pickRowExpr("t-2")}`, 3000);
        const rail = await h.ev(`({
            rows: ${PICK_ROWS}.map((r) => r.getAttribute('data-model-pick')),
            pressed: ${pickRowExpr("t-2")}?.querySelector('[role="group"] button[aria-pressed="true"]')?.textContent.trim() ?? null,
            reason: ${flatText(pickRowExpr("t-2"))}.includes(${JSON.stringify(MODEL_PICKS[0].reason)}),
            outside: document.querySelectorAll('[data-dag-modal-kind] [data-model-pick]').length - ${PICK_ROWS}.length,
        })`);
        rec(
            "2. only the sonnet pick shows a model row in the task's peek card, on sonnet, with its reason",
            leadCard &&
                leadRows.length === 0 &&
                rail.rows.length === 1 &&
                rail.rows[0] === "t-2" &&
                rail.pressed === "sonnet" &&
                rail.reason &&
                rail.outside === 0,
            JSON.stringify({ leadCard, leadRows, ...rail })
        );

        const card = await h.ev(`(() => {
            const row = ${pickRowExpr("t-2")};
            const toggle = row?.querySelector('[role="group"]');
            return {
                inCard: row?.closest('[data-dag-task-peek]')?.getAttribute('data-dag-task-peek') ?? null,
                toggle: [...(toggle?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()),
                text: ${flatText(pickRowExpr("t-2"))},
            };
        })()`);
        await h.shot("cdp-shots/model-picks-1b-card.png");
        rec(
            "1b. the waiting t-2's card carries its model toggle, waiting, with the plan reviewer's reason",
            card.inCard === "t-2" && card.toggle.length === 2 && card.toggle.includes("sonnet") && card.text.includes("waiting") && card.text.includes("Plan reviewer:"),
            JSON.stringify(card)
        );

        const picked = await h.ev(`({
            t1: ${cardTagExpr("t-1")},
            t2: ${cardTagExpr("t-2")},
            t3: ${cardTagExpr("t-3")},
            rail: ${railExpr},
        })`);
        rec(
            "3. the cards tag the plan's and the reviewer's picks, and the peek card's Worker row names the reviewer",
            picked.t1 === "sonnet · plan" &&
                picked.t2 === "sonnet · review" &&
                picked.t3 == null &&
                picked.rail.route === "reviewer:claude:sonnet" &&
                picked.rail.text.includes("claude / sonnet") &&
                picked.rail.text.includes("reviewer's pick"),
            JSON.stringify(picked)
        );

        await h.ev(`${pickToggleExpr("t-2", false)}?.click()`);
        const onLead = await waitDagTask(h, ctx, "t-2", (t) => t.modelsource === "owner");
        await polishWaitFor(h, `${flatText(pickRowExpr("t-2"))}.includes('you changed it')`, 3000);
        const leadRow = await h.ev(flatText(pickRowExpr("t-2")));
        rec(
            "4. toggling the pick to the lead's model writes modelsource owner and clears the pin",
            onLead?.modelsource === "owner" && !onLead.runspec?.model && leadRow.includes("you changed it"),
            JSON.stringify({ task: taskFacts(onLead), row: leadRow })
        );

        await h.ev(`${pickToggleExpr("t-2", true)}?.click()`);
        const onSonnet = await waitDagTask(h, ctx, "t-2", (t) => t.modelsource === "owner" && t.runspec?.model === "sonnet");
        await polishWaitFor(h, `${cardTagExpr("t-2")} === 'sonnet · you'`, 3000);
        const yours = await h.ev(`({ tag: ${cardTagExpr("t-2")}, rail: ${railExpr} })`);
        await h.shot("cdp-shots/model-picks-2-yours.png");
        rec(
            "5. toggling it back to sonnet tags the node `sonnet · you` and the peek card's Worker row names your pick",
            onSonnet?.modelsource === "owner" &&
                onSonnet.runspec?.model === "sonnet" &&
                yours.tag === "sonnet · you" &&
                yours.rail.route === "owner:claude:sonnet" &&
                yours.rail.text.includes("your pick"),
            JSON.stringify({ task: taskFacts(onSonnet), ...yours })
        );

        const chips = await h.ev(PLAN_REVIEWER_CHIPS);
        await h.shot("cdp-shots/model-picks-3-reviewers.png");
        rec(
            "6. the graph's stage line shows two plan reviewers, each passed",
            sameSet(
                chips.map((c) => c.lens),
                ROUND_ONE_LENSES
            ) && chips.every((c) => c.state === "passed"),
            JSON.stringify(chips)
        );

        const reviewed = await h.ev(railGroupExpr("Plan reviewed"));
        await h.shot("cdp-shots/model-picks-4-plan-reviewed.png");
        rec(
            "7. the timeline's Plan reviewed row lists two reviewers",
            reviewed.found &&
                sameSet(
                    reviewed.reviewers.map((r) => r.lens),
                    ROUND_ONE_LENSES
                ) &&
                reviewed.reviewers.every((r) => r.text === `${LENS_TITLE[r.lens]} · passed`),
            JSON.stringify(reviewed)
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await teardownFixtureRun(h, ctx, "model-picks");
    },
};

// --- plan-review-rounds: round 1's two reviewers, the second pass failing, then round 2's follow-up on a resubmit
// (docs/superpowers/specs/2026-10-14-wider-plan-review-design.md). The failed round launches a real lead: its run
// is on haiku, and the finding it is woken with tells it to leave the plan alone, so the scenario's resubmit is the
// only one.
const ROUNDS_FINDING =
    "verify plan-review-rounds: a UI check drives this review; leave the plan as it is, do not resubmit it, and stop";
const ROUNDS_GOAL =
    "verify plan-review-rounds: a UI check drives this run; do nothing, make no file changes, submit no plan, and stop";
const PLAN_REVIEW_TITLE = "Plan review · ";

// the agent tree's plan-reviewer rows, with the run's finished reviews unfolded first: a stage with a verdict
// folds under "N reviews"
const PLAN_REVIEW_TREE_ROWS = `(async () => {
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const tree = () => document.querySelector('[data-agent-tree]');
    const folds = () => [...(tree()?.querySelectorAll('div.cursor-pointer') ?? [])].filter(
        (d) => /\\d+ reviews?$/.test(flat(d)) && d.querySelector('.lucide-chevron-right')
    );
    const titles = () => [...(tree()?.querySelectorAll('div') ?? [])].filter(
        (d) => d.children.length === 0 && flat(d).startsWith(${JSON.stringify(PLAN_REVIEW_TITLE)})
    );
    for (let i = 0; i < 40 && folds().length === 0 && titles().length < ${ROUND_ONE_LENSES.length}; i++) {
        await new Promise((r) => setTimeout(r, 250));
    }
    folds().forEach((f) => f.click());
    for (let i = 0; i < 20 && titles().length < ${ROUND_ONE_LENSES.length}; i++) await new Promise((r) => setTimeout(r, 250));
    return {
        tree: tree() != null,
        rows: titles().map((t) => ({ title: flat(t), sub: flat(t.nextElementSibling) })),
    };
})()`;

async function openRunGraph(h, ctx) {
    await polishReload(h);
    await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
    const opened = await h.ev(`(async () => {
        for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
            await new Promise((r) => setTimeout(r, 250));
        }
        if (typeof window.__openAddress !== "function") return { ok: false, why: "no __openAddress hook" };
        return window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)});
    })()`);
    const openDag = `[...(document.querySelector('[data-jarvis-brief-sheet]')?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Open DAG')`;
    const sheet = await polishWaitFor(h, `!!${openDag}`, 15000);
    if (sheet) await h.ev(`${openDag}.click()`);
    const graph = await polishWaitFor(
        h,
        `!!document.querySelector('[data-dag-modal-kind="live"]') && document.querySelectorAll('[data-dag-modal-kind] [data-dag-node]:not([data-dag-node="final"])').length === 3`,
        10000
    );
    return { ok: opened?.ok === true && sheet && graph, opened, sheet, graph };
}

export const planReviewRounds = {
    name: "plan-review-rounds",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-plan-review-rounds-"));
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            // the lead the failed round launches works in cwd, so it reads this copy rather than the repo's fixture
            ctx.planPath = join(cwd, "plan.md");
            writeFileSync(ctx.planPath, readFileSync(MODELS_PLAN));
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-plan-review-rounds", projectpath: cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: ROUNDS_GOAL,
                runtime: "claude",
                model: "haiku",
                mode: "orchestrator",
                deferstart: true,
                // owned here, so the profile cannot make the full reviewer's pass need picks
                reviewerpicks: false,
                reviewerroute: HAIKU_ROUTE,
                lightreviewerroute: HAIKU_ROUTE,
                parallelism: 1,
            });
            ctx.runId = created.run.id;
            ctx.landPath = created.run.landpath;
            await h.rpc(
                "dagsubmit",
                { channelid: ctx.channelId, runid: ctx.runId, parallelism: 1, planpath: ctx.planPath },
                MODELS_RPC
            );
            const pass = { verdict: "pass", notes: "verify plan-review-rounds: three noops" };
            await recordPlanReviewRound(h, ctx, 1, {
                second: { verdict: "fail", notes: ROUNDS_FINDING },
                full: pass,
            });
            ctx.graph = await openRunGraph(h, ctx);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. round 1's two reviewers recorded their verdicts, the second pass failing", false, ctx.arrangeError);
            return steps;
        }
        rec("0. the run's graph opened with its 3 tasks", ctx.graph.ok, JSON.stringify({ runId: ctx.runId, ...ctx.graph }));
        if (!ctx.graph.ok) return steps;

        await polishWaitFor(h, `${PLAN_REVIEWER_CHIPS}.filter((c) => c.state !== 'reviewing').length === ${ROUND_ONE_LENSES.length}`, 5000);
        const chips = await h.ev(PLAN_REVIEWER_CHIPS);
        await h.shot("cdp-shots/plan-review-rounds-1-chips.png");
        rec(
            "1. round 1: two chips, full passed and the second pass failed",
            sameSet(
                chips.map((c) => c.lens),
                ROUND_ONE_LENSES
            ) && chips.every((c) => c.state === (c.lens === "second" ? "failed" : "passed")),
            JSON.stringify(chips)
        );

        const reviewed = await h.ev(railGroupExpr("Plan reviewed"));
        const findings = (await planReviewOf(h, ctx))?.findings ?? "";
        await h.shot("cdp-shots/plan-review-rounds-2-plan-reviewed.png");
        rec(
            "2. the Plan reviewed row lists two reviewers, and the findings begin with [Second pass]",
            reviewed.found &&
                sameSet(
                    reviewed.reviewers.map((r) => r.lens),
                    ROUND_ONE_LENSES
                ) &&
                reviewed.reviewers.every((r) => r.text === `${LENS_TITLE[r.lens]} · ${r.lens === "second" ? "failed" : "passed"}`) &&
                findings.startsWith("[Second pass]"),
            JSON.stringify({ ...reviewed, findings: findings.slice(0, 200) })
        );

        const started = await h.ev(railGroupExpr("Plan reviewer started"));
        const want = ROUND_ONE_LENSES.map((l) => `Plan reviewer started · ${LENS_TITLE[l]}`);
        await h.shot("cdp-shots/plan-review-rounds-3-started.png");
        rec(
            "3. the timeline names each reviewer's lens in its started row",
            started.found && sameSet(started.titles, want),
            JSON.stringify(started)
        );

        await h.goto("agent");
        const tree = await h.ev(PLAN_REVIEW_TREE_ROWS);
        await h.shot("cdp-shots/plan-review-rounds-4-tree.png");
        const wantRows = ROUND_ONE_LENSES.map((l) => ({
            title: `${PLAN_REVIEW_TITLE}${LENS_TITLE[l]}`,
            verdict: l === "second" ? "failed" : "passed",
        }));
        rec(
            "4. the agent tree's plan-reviewer rows name their lens and verdict",
            tree.rows.length === ROUND_ONE_LENSES.length &&
                wantRows.every((w) => tree.rows.some((r) => r.title === w.title && r.sub.split(" · ")[0] === w.verdict)),
            tree.rows.length === 0
                ? `no plan-reviewer rows in the tree: the run's reviewer tabs were reaped or never joined the roster (${JSON.stringify(tree)})`
                : JSON.stringify(tree)
        );

        // the same plan again: the review failed and nothing dispatched, so it replaces the proposal and opens round 2
        await h.rpc(
            "dagsubmit",
            { channelid: ctx.channelId, runid: ctx.runId, parallelism: 1, planpath: ctx.planPath },
            MODELS_RPC
        );
        let round2 = null;
        for (let waited = 0; waited < PLAN_REVIEWER_WAIT_MS; waited += 1000) {
            round2 = await planReviewOf(h, ctx);
            if (round2?.round === 2 && round2.reviewers?.length === 1 && round2.reviewers[0].runid) break;
            await polishNap(1000);
        }
        const graph2 = await openRunGraph(h, ctx);
        await polishWaitFor(h, `${PLAN_REVIEWER_CHIPS}.length === 1`, 5000);
        const reviewing = await h.ev(PLAN_REVIEWER_CHIPS);
        await h.shot("cdp-shots/plan-review-rounds-5-round-2.png");
        rec(
            "5. round 2 shows one follow-up chip",
            graph2.ok &&
                reviewing.length === 1 &&
                reviewing[0].lens === "followup" &&
                reviewing[0].state === "reviewing" &&
                reviewing[0].line.includes("round 2"),
            JSON.stringify({ graph: graph2, chips: reviewing, reviewers: round2?.reviewers ?? null })
        );
        if (reviewing.length !== 1) return steps;

        let recorded = "ok";
        try {
            await recordPlanReviewRound(h, ctx, 2, { followup: { verdict: "pass", notes: "verify plan-review-rounds: the plan is unchanged" } });
        } catch (e) {
            recorded = String(e?.message ?? e);
        }
        await polishWaitFor(h, `${PLAN_REVIEWER_CHIPS}[0]?.state === 'passed'`, 5000);
        const passed = await h.ev(PLAN_REVIEWER_CHIPS);
        await h.shot("cdp-shots/plan-review-rounds-6-round-2-passed.png");
        rec(
            "6. the follow-up chip reads passed",
            recorded === "ok" && passed.length === 1 && passed[0].lens === "followup" && passed[0].state === "passed",
            JSON.stringify({ recorded, chips: passed })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await teardownFixtureRun(h, ctx, "plan-review-rounds");
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

// TaskDetail and its DecisionLog, in the run sheet's record band: a run with one attributed record that has
// decisions. The record is named by the goal's slug and lives in the vault across runs, so its decisions are
// appended once.
const LOOK_RECORD_GOAL = "verify task-detail: a record with decisions, do nothing";
// the goal's slug, cut at jarvisdossier's maxSlugLen (48)
const LOOK_RECORD = "verify-task-detail-a-record-with-decisions-do-no";
const LOOK_DECISIONS = [
    {
        summary: "Keep the band collapsed",
        rationale:
            "The band opens on e. Opening it by default pushed the thread a screenful down on every run switch, and the record is read far less often than the thread.",
    },
    {
        summary: "Status before fields",
        rationale: "Status is the one field scanned before anything else is read, so it carries the only colour on the record.",
    },
];
const LOOK_BAND = `document.querySelector("[data-jarvis-record-band]")`;

export const taskDetail = {
    name: "task-detail",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-task-detail-")) };
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-task-detail", projectpath: ctx.cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: LOOK_RECORD_GOAL,
                runtime: "claude",
                mode: "quick",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            ctx.runORef = `run:${ctx.runId}`;
            await h.rpc("acceptdossieredge", { dossierid: LOOK_RECORD, runoref: ctx.runORef });
            const have = ((await h.rpc("getdossier", { dossierid: LOOK_RECORD }))?.decisions ?? []).map((d) => d.rationale);
            for (const d of LOOK_DECISIONS.filter((d) => !have.includes(d.rationale))) {
                await h.rpc("appenddossierdecision", { dossierid: LOOK_RECORD, ...d });
            }
            // the decisions persist in the vault across runs, so the summaries drawn are the ones it holds
            const held = (await h.rpc("getdossier", { dossierid: LOOK_RECORD }))?.decisions ?? [];
            ctx.summaries = LOOK_DECISIONS.map((d) => held.find((x) => x.rationale === d.rationale)?.summary).filter(Boolean);
            // the Brief reads a boot-primed snapshot, so the RPC-created channel needs a reload
            await h.reload();
            await h.goto("jarvis");
            ctx.opened = await lookEval(h, `
                await until(() => typeof window.__openAddress === "function", 5000);
                return window.__openAddress(${JSON.stringify(ctx.runORef)});
            `);
            // the ambient re-read behind the band sweeps every record, hence the long wait (as record-band-detach-restore)
            ctx.expanded = await lookEval(h, `
                const toggle = () => ${LOOK_BAND}?.querySelector("[data-jarvis-band-toggle]");
                await until(() => toggle() != null, 25000);
                if (toggle()?.getAttribute("aria-expanded") !== "true") toggle()?.click();
                return until(() => /Where it stands/.test(flat(${LOOK_BAND})) && /No decisions yet|Add decision/.test(flat(${LOOK_BAND})), 8000);
            `);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        rec(
            "0. the run's record band opens onto the record",
            ctx.arrangeError == null && ctx.opened?.ok === true && ctx.expanded === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, opened: ctx.opened, expanded: ctx.expanded })
        );
        if (!ctx.expanded) return steps;
        await polishNap(500); // the disclosure's reveal
        const top = await lookEval(h, `
            const text = flat(${LOOK_BAND});
            const heads = [...${LOOK_BAND}.querySelectorAll("h3")];
            const title = ${LOOK_BAND}.querySelector("h2");
            return {
                status: ${LOOK_BAND}.querySelector("[data-record-status]")?.textContent ?? null,
                transitions: [...${LOOK_BAND}.querySelectorAll("button")].map(flat).filter((t) => t.startsWith("→")),
                titlePx: title ? parseFloat(getComputedStyle(title).fontSize) : null,
                heads: heads.map((x) => ({ text: flat(x), mono: /mono/i.test(getComputedStyle(x).fontFamily), px: getComputedStyle(x).fontSize })),
            };
        `);
        await h.shot(lookShot("task-detail"));
        rec("1. the record shows its status, its transitions and the fields that say where it stands", top.status != null && top.transitions.length > 0, JSON.stringify(top));
        rec(
            "1b. the record's title stays under the sheet's, and its sections are headed by the 10.5px mono eyebrow",
            top.titlePx != null && top.titlePx <= 15 && top.heads.length > 0 && top.heads.every((x) => x.mono && x.px === "10.5px"),
            JSON.stringify({ titlePx: top.titlePx, heads: top.heads })
        );

        const decisions = await lookEval(h, `
            const scroller = ${LOOK_BAND}.querySelector('[class*="max-h-[420px]"]');
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
            await nap(300);
            const text = flat(${LOOK_BAND});
            const titles = [...${LOOK_BAND}.querySelectorAll("h4")].map(flat);
            return {
                cards: ${JSON.stringify(LOOK_DECISIONS.map((d) => d.rationale.slice(0, 30)))}.filter((r) => text.includes(r)).length,
                titled: ${JSON.stringify(ctx.summaries ?? [])}.filter((t) => titles.includes(t)).length,
                isoDates: /\\b\\d{4}-\\d{2}-\\d{2}\\b/.test(text),
                ages: /(just now|\\d+[mhd] ago)/.test(text),
            };
        `);
        await h.shot(lookShot("task-detail-decisions"));
        rec("2. the decision log lists the record's decisions", decisions.cards === LOOK_DECISIONS.length, JSON.stringify(decisions));
        rec(
            "2b. each decision is titled by its summary and dated by age, not an ISO date",
            (ctx.summaries ?? []).length === LOOK_DECISIONS.length && decisions.titled === LOOK_DECISIONS.length && decisions.ages && !decisions.isoDates,
            JSON.stringify(decisions)
        );

        const form = await lookEval(h, `
            button(${LOOK_BAND}, /^\\+ Add decision$/)?.click();
            const input = () => [...${LOOK_BAND}.querySelectorAll("input")].find((i) => i.labels?.[0] && flat(i.labels[0]) === "Summary");
            const ok = await until(() => input() != null, 2000);
            const area = ${LOOK_BAND}.querySelector("textarea");
            const scroller = ${LOOK_BAND}.querySelector('[class*="max-h-[420px]"]');
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
            await nap(300);
            return {
                ok,
                addDisabled: button(${LOOK_BAND}, /^Add decision$/)?.disabled ?? null,
                rationaleLabel: area?.labels?.[0] ? flat(area.labels[0]) : null,
                placeholder: input()?.placeholder ?? null,
            };
        `);
        await h.shot(lookShot("task-detail-add-decision"));
        await lookEval(h, `button(${LOOK_BAND}, /^Cancel$/)?.click();`);
        rec("3. + Add decision opens the append form, its Add decision disabled while empty", form.ok && form.addDisabled === true, JSON.stringify(form));
        rec(
            "3b. the form's fields are labelled Summary and Rationale, and the summary's placeholder does not ask for a filename",
            form.ok && form.rationaleLabel === "Rationale" && form.placeholder != null && !/filename/i.test(form.placeholder),
            JSON.stringify(form)
        );

        const confirm = await lookEval(h, `
            const scroller = ${LOOK_BAND}.querySelector('[class*="max-h-[420px]"]');
            if (scroller) scroller.scrollTop = 0;
            button(${LOOK_BAND}, /^→ archived$/)?.click();
            const ok = await until(() => /Mark this task archived\\?/.test(flat(dialog())), 2000);
            await nap(400);
            return { ok, confirm: button(dialog(), /^Yes, archived/) != null, floor: floorWalk([dialog()]) };
        `);
        await h.shot(lookShot("task-detail-archive-confirm"));
        const cancelled = await lookEval(h, `
            button(dialog(), /^Cancel/)?.click();
            return until(() => !/Mark this task archived\\?/.test(flat(dialog())), 2000);
        `);
        const status = (await h.rpc("getdossier", { dossierid: LOOK_RECORD }))?.status ?? null;
        rec(
            "4. → archived asks first with a danger confirm, and Cancel leaves the record as it was",
            confirm.ok && confirm.confirm && cancelled === true && status === top.status,
            JSON.stringify({ ...confirm, floor: undefined, cancelled, status })
        );
        steps.push(await floorStep(h, `5. no visible text in the record band is under ${MIN_FONT_PX}px`, LOOK_BAND));
        rec(`5b. no visible text in the archive confirm is under ${MIN_FONT_PX}px`, floorOk(confirm.floor), floorDetail(confirm.floor));
        return steps;
    },
    async teardown(h, ctx) {
        // detached, so the record keeps one run ref across runs rather than growing one per run
        await teardownFixtureRun(h, ctx, "task-detail", {
            what: "detach the run from the record",
            fn: () => (ctx.runORef ? h.rpc("detachdossieredge", { dossierid: LOOK_RECORD, runoref: ctx.runORef }) : null),
        });
    },
};

// --- component looks, round two: what the 2026-10-17 drift scan found on the older idiom -------------------------
// The run sheet's done face, its cancel, survivor and ask cards, and the Code surface's stale bar had no step that
// shows them. Each scenario asserts only what the component says today; a polish task adds the step for what it
// changes. A run's state is written onto a deferred run, the way final-shots seeds one, since no engine reaches it
// on demand. Every run, the ones stored before slice 5c included, now opens in RunSheet; run-sheet-legacy shows it.

// writes the run, reads it back, and reloads: UpdateObject publishes nothing, and the Brief reads a boot snapshot
async function lookSeedRun(h, ctx, patch) {
    const oref = `run:${ctx.runId}`;
    const stored = await waveService(h, "object", "GetObject", [oref]);
    await waveService(h, "object", "UpdateObject", [{ ...stored, otype: "run", ...patch }, false], FINAL_SHOTS_UICTX);
    const back = await waveService(h, "object", "GetObject", [oref]);
    if (back?.status !== patch.status) throw new Error(`the run did not keep status ${patch.status}: ${back?.status}`);
    await reloadApp(h);
}

async function lookOpenRun(h, ctx) {
    await lookOpen(h, "jarvis");
    return lookEval(h, `
        await until(() => typeof window.__openAddress === "function", 5000);
        await window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)});
        return until(() => document.querySelector("[data-jarvis-brief-sheet]") != null, 8000);
    `);
}

const LOOK_RUN_GOAL = "Raise the retry budget and add Submit";
const LOOK_RUN_VERIFS = [
    { cmd: "go test ./src/retry/...", result: "pass" },
    { cmd: "go vet ./src/retry/...", result: "pass" },
    { cmd: "golangci-lint run ./src/retry", result: "fail", detail: "policy.go:4: exported func Budget should have a comment" },
];
const LOOK_RUN_FILES = [
    { path: "src/retry/policy.go", stat: "M", add: 1, del: 1 },
    { path: "src/retry/submit.go", stat: "A", add: 5, del: 0 },
    { path: "src/retry/policy_test.go", stat: "M", add: 14, del: 2 },
];

export const runSheetDoneLook = {
    name: "run-sheet-done",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-run-sheet-done-")) };
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-run-sheet-done", projectpath: ctx.cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: LOOK_RUN_GOAL,
                runtime: "claude",
                mode: "orchestrator",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            const now = Date.now();
            await lookSeedRun(h, ctx, {
                status: "done",
                report: "",
                phases: [
                    { kind: "plan", state: "done", startedts: now - 655_000, donets: now - 520_000, artifacts: ["docs/plan.md"] },
                    { kind: "execute", state: "done", startedts: now - 520_000, donets: now - 30_000 },
                ],
                evidence: {
                    capturedts: now,
                    hash: "",
                    summary: "Raised the retry budget to 8 and added Submit, with a test for each.",
                    files: LOOK_RUN_FILES,
                    addtotal: 20,
                    deltotal: 3,
                    verifs: LOOK_RUN_VERIFS,
                    artifacts: [{ path: "docs/retry.md", kind: "doc", size: 2140 }],
                    runtimems: 412_000,
                    durationms: 655_000,
                },
            });
            ctx.runDone = true;
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError != null) return [{ step: "0. arrange", ok: false, detail: ctx.arrangeError }];
        const opened = await lookOpenRun(h, ctx);
        const s = await lookEval(h, `
            const sheet = () => document.querySelector('[data-run-sheet="done"]');
            await until(() => /Sealed evidence/i.test(flat(sheet())), 8000);
            await nap(600); // the evidence card's entrance
            const text = flat(sheet());
            return {
                done: sheet() != null,
                goal: text.includes(${JSON.stringify(LOOK_RUN_GOAL)}),
                files: ${JSON.stringify(LOOK_RUN_FILES.map((f) => f.path))}.filter((p) => !text.includes(p)),
                checks: /2 passed, 1 failed/.test(text),
                diffLink: button(sheet(), /open the repository diff/) != null,
            };
        `);
        await h.shot(lookShot("run-sheet-done"));
        const floor = await floorStep(h, `no visible text on the done run's sheet is under ${MIN_FONT_PX}px`, `document.querySelector('[data-run-sheet="done"]')`);

        // the evidence's loading frame: the run without its evidence, with the seal the sheet then asks for held
        const runOref = `run:${ctx.runId}`;
        await holdRpc(h, "SealRunEvidenceCommand");
        await holdObject(h, runOref, "{ ...current, evidence: undefined }");
        const sealing = await lookPlaceholders(h, `document.querySelector('[data-run-sheet="done"] [data-jarvis-brief-sheet-state="loading"]')`);
        await h.shot(lookShot("run-sheet-done-sealing"));
        await releaseObject(h, runOref);
        await releaseRpc(h, "SealRunEvidenceCommand");
        return [
            {
                step: "a done run with sealed evidence shows its goal, every landed file, the check tally and the diff link",
                ok: opened === true && s.done && s.goal && s.files.length === 0 && s.checks && s.diffLink,
                detail: JSON.stringify({ opened, ...s }),
            },
            floor,
            placeholderStep("while the evidence seals, the sheet holds its 30px bar", sealing, { height: 30, radius: "8px" }),
        ];
    },
    async teardown(h, ctx) {
        // a done run cannot be cancelled
        await teardownFixtureRun(h, ctx.runDone ? { ...ctx, runId: null } : ctx, "run-sheet-done");
    },
};

const LOOK_LEAD = "look lead";
const LOOK_LEAD_OREF = `tab:${TREE_RAIL_LEAD_ID}`;

// one deferred run walked through three states of its sheet, each over the same fixture lead: working, cancelled with
// the lead still alive, and asking
export const runSheetCardsLook = {
    name: "run-sheet-cards",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-run-sheet-cards-")) };
        try {
            await arrangeFixtureRun(h, ctx, "run-sheet-cards", LOOK_LEAD, {});
            ctx.phases = [{ kind: "execute", state: "running", startedts: Date.now() - 240_000, workerorefs: [LOOK_LEAD_OREF] }];
            await lookSeedRun(h, ctx, { status: "executing", phases: ctx.phases });
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError != null) return [{ step: "0. arrange", ok: false, detail: ctx.arrangeError }];
        const steps = [];
        const sheetText = (waitFor) =>
            lookEval(h, `
                const sheet = () => document.querySelector("[data-jarvis-brief-sheet]");
                await until(() => ${waitFor}.test(flat(sheet())), 8000);
                await nap(500);
                return flat(sheet());
            `);

        const working = await lookOpenRun(h, ctx);
        const live = await lookEval(h, `
            const sheet = () => document.querySelector('[data-run-sheet="executing"]');
            await until(() => button(sheet(), /^Cancel run$/) != null, 8000);
            await nap(500);
            return { cancel: button(sheet(), /^Cancel run$/) != null, openLead: button(sheet(), /^Open lead/) != null };
        `);
        await h.shot(lookShot("run-sheet-live"));
        steps.push({
            step: "a live run whose lead is working offers Open lead and Cancel run",
            ok: working === true && live.cancel && live.openLead,
            detail: JSON.stringify({ working, ...live }),
        });

        await lookSeedRun(h, ctx, { status: "cancelled", phases: ctx.phases });
        await lookOpenRun(h, ctx);
        const survivors = await sheetText(/still running/);
        await h.shot(lookShot("run-sheet-survivors"));
        steps.push({
            step: "a cancelled run whose lead is still alive says so, with the survivors card",
            ok: /Cancelled · 1 worker still running/.test(survivors),
            detail: survivors.slice(0, 240),
        });

        writeFileSync(
            TREE_RAIL_FIXTURE,
            JSON.stringify(treeRailRoster(ctx.runId, Date.now(), LOOK_LEAD, { state: "asking", blockedMs: 90_000 }), null, 2)
        );
        await lookSeedRun(h, ctx, { status: "executing", phases: ctx.phases });
        await lookOpenRun(h, ctx);
        const ask = await sheetText(/Clarifying question/);
        await h.shot(lookShot("run-sheet-ask"));
        steps.push({
            step: "a live run whose lead is asking shows the clarifying-question card",
            ok: /Clarifying question/.test(ask),
            detail: ask.slice(0, 240),
        });
        steps.push(await floorStep(h, `no visible text on the asking run's sheet is under ${MIN_FONT_PX}px`, `document.querySelector("[data-jarvis-brief-sheet]")`));
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "run-sheet-cards");
    },
};

// the shapes the removed legacy route sent to the pipeline rail: a done run with no orchestration stamp, one parked at a
// plan gate, and a pipeline run. No run created today takes them (createrun stamps orchestration "engine"), so each is
// written onto a deferred run; every one must open in the run sheet and say its goal
export const runSheetLegacyLook = {
    name: "run-sheet-legacy",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-run-sheet-legacy-")) };
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-run-sheet-legacy", projectpath: ctx.cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: LOOK_RUN_GOAL,
                runtime: "claude",
                mode: "orchestrator",
                deferstart: true,
            });
            ctx.runId = created.run.id;
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError != null) return [{ step: "0. arrange", ok: false, detail: ctx.arrangeError }];
        const steps = [];
        const sheetRead = (done) =>
            lookEval(h, `
                const sheet = () => document.querySelector(${JSON.stringify(done ? '[data-run-sheet="done"]' : "[data-run-sheet]")});
                await until(() => sheet() != null, 8000);
                await nap(600);
                const text = flat(sheet());
                return {
                    sheet: sheet() != null,
                    goal: text.includes(${JSON.stringify(LOOK_RUN_GOAL)}),
                    files: ${JSON.stringify(LOOK_RUN_FILES.map((f) => f.path))}.filter((p) => !text.includes(p)),
                };
            `);
        const now = Date.now();
        await lookSeedRun(h, ctx, {
            status: "done",
            mode: "orchestrator",
            orchestration: "",
            runtime: "claude",
            report: "",
            phases: [
                { kind: "plan", state: "done", startedts: now - 655_000, donets: now - 520_000, artifacts: ["docs/plan.md"] },
                { kind: "execute", state: "done", startedts: now - 520_000, donets: now - 30_000 },
            ],
            evidence: {
                capturedts: now,
                hash: "",
                summary: "Raised the retry budget to 8 and added Submit, with a test for each.",
                files: LOOK_RUN_FILES,
                addtotal: 20,
                deltotal: 3,
                verifs: LOOK_RUN_VERIFS,
                artifacts: [{ path: "docs/retry.md", kind: "doc", size: 2140 }],
                runtimems: 412_000,
                durationms: 655_000,
            },
        });
        let opened = await lookOpenRun(h, ctx);
        let s = await sheetRead(true);
        await h.shot(lookShot("run-sheet-legacy-done"));
        steps.push({
            step: "a done run stored before slice 5c opens in the run sheet with its goal and landed files",
            ok: opened === true && s.sheet && s.goal && s.files.length === 0,
            detail: JSON.stringify({ opened, ...s }),
        });
        await lookSeedRun(h, ctx, { status: "awaiting-review", plangatepending: true });
        opened = await lookOpenRun(h, ctx);
        s = await sheetRead(false);
        await h.shot(lookShot("run-sheet-legacy-plan-gate"));
        steps.push({
            step: "a run parked at a plan gate opens in the run sheet with its goal",
            ok: opened === true && s.sheet && s.goal,
            detail: JSON.stringify({ opened, ...s }),
        });
        await lookSeedRun(h, ctx, { status: "executing", plangatepending: false, mode: "pipeline" });
        opened = await lookOpenRun(h, ctx);
        s = await sheetRead(false);
        await h.shot(lookShot("run-sheet-legacy-pipeline"));
        steps.push({
            step: "a pipeline run opens in the run sheet with its goal",
            ok: opened === true && s.sheet && s.goal,
            detail: JSON.stringify({ opened, ...s }),
        });
        return steps;
    },
    async teardown(h, ctx) {
        // the last seeded run is executing, so the ordinary teardown can cancel it
        await teardownFixtureRun(h, ctx, "run-sheet-legacy");
    },
};
