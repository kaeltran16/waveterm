// Agent scenario `agent-workers`: agents started by another agent nest under it in the Agent tree. A parent with a
// working worker, a stopped worker and a done worker whose block carries a worktree commit stamp, and the stopped
// worker's own stopped worker one level further down. The
// roster is a page fixture over real tabs with no controller (a fake block id would fail its terminal's resync and
// read "failed to start"), each worker tab carrying agent:parenttab as the backend stamps it. The stopped worker's
// transcript lives in a temp dir teardown removes.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
    pinDefaultView,
    restoreDefaultView,
    restoreRoster,
    setRoster,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "agent-workers";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const PROJECT = "waveterm";
const PARENT = "workers parent";
const WORKING = "worker working";
const STOPPED = "worker stopped";
const GRAND = "worker of worker";
const COMMITTED = "worker committed";
const BRANCH = "feat/verify-worker-branch";
const BRANCH_TITLE = `Done, committed on ${BRANCH}`;
const ANSWER = "The tree nests every worker under the agent that started it.";
const LOAD_WAIT_MS = 10_000;

const HEADER_PILL = `document.querySelector("[data-agent-header] [data-agent-state-pill]")`;
const flatOf = (expr) => `((${expr})?.textContent ?? "").replace(/\\s+/g, " ").trim()`;

// the color a CSS value resolves to, as the browser computes it
const colorOf = (cssValue) => `(() => {
    const probe = document.createElement("span");
    probe.style.color = ${JSON.stringify(cssValue)};
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
})()`;

// the fixture rows in the tree's order, each with its leading padding and the state word it shows
const treeRows = (ids) => `(() => {
    const ids = ${JSON.stringify(ids)};
    const muted = ${colorOf("var(--color-muted)")};
    return [...document.querySelectorAll("[data-agent-tree] [data-tree-agent]")]
        .filter((el) => ids.includes(el.getAttribute("data-tree-agent")))
        .map((el) => {
            const stopped = el.querySelector("[data-tree-stopped]");
            return {
                id: el.getAttribute("data-tree-agent"),
                pad: parseFloat(getComputedStyle(el).paddingLeft),
                stopped: stopped?.textContent.trim() ?? null,
                stoppedMuted: stopped ? getComputedStyle(stopped).color === muted : null,
            };
        });
})()`;

// Scenario `agent-workers-live`: a live worker, not a fixture roster row, so the stopped mark comes from the backend.
// Its block is armed on a command that exits at once; a forced resync runs it, and the worker's exit path
// disarms the block. The tree must mark it stopped with no reload, and after a reload still name it by its task.
const LIVE_NAME = "agent-workers-live";
const SHOT_LIVE = (n, what) => `cdp-shots/${LIVE_NAME}-${n}-${what}.png`;
const LIVE_PARENT = "live workers parent";
const LIVE_TASK = "Run the parser tests and report";

// the rows in the tree's order, each with its padding, its name and the stopped mark it shows
const liveRows = (ids) => `(() => {
    const ids = ${JSON.stringify(ids)};
    return [...document.querySelectorAll("[data-agent-tree] [data-tree-agent]")]
        .filter((el) => ids.includes(el.getAttribute("data-tree-agent")))
        .map((el) => ({
            id: el.getAttribute("data-tree-agent"),
            pad: parseFloat(getComputedStyle(el).paddingLeft),
            name: el.querySelector(".truncate")?.textContent.trim() ?? null,
            stopped: el.querySelector("[data-tree-stopped]")?.textContent.trim() ?? null,
        }));
})()`;

// an idle agent:status as the hook publishes it: retained, so a reloaded page still lists the agent, and with a ts past
// every earlier one or the server drops it as stale
async function publishIdle(h, ctx, blockId) {
    const ts = Math.max(Date.now(), (ctx.lastTs ?? 0) + 1);
    ctx.lastTs = ts;
    const oref = `block:${blockId}`;
    await h.rpc("eventpublish", {
        event: "agent:status",
        scopes: [oref],
        persist: 1,
        data: { oref, agent: "claude", state: "idle", ts },
    });
}

const TREE_ROW = (id) => `document.querySelector('[data-agent-tree] [data-tree-agent="${id}"]')`;
const CARD = (id) => `document.querySelector('[data-cockpit-surface] [data-agent-id="${id}"]')`;
const branchMark = (scope) => `(${scope})?.querySelector('[title=${JSON.stringify(BRANCH_TITLE)}] svg.lucide-git-branch')`;
// the branch mark and the commit tick a row or card shows
const markOf = (scope) => `({
    branch: !!${branchMark(scope)},
    tick: !!(${scope})?.querySelector('[title="Done, latest work committed"]'),
})`;

const STOPPED_LINE = "Stopped, a message resumes it";
// a card's stopped line, whether the fixture answer shows below it, and whether it reads waiting
const stoppedCard = (scope) => `(() => {
    const card = ${scope};
    const line = card?.querySelector("[data-card-stopped]");
    const answer = [...(card?.querySelectorAll("*") ?? [])].find(
        (el) => el.children.length === 0 && el.textContent.includes(${JSON.stringify(ANSWER)})
    );
    return {
        line: line?.textContent.trim() ?? null,
        answer: answer != null,
        lineAbove: !!(line && answer && line.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING),
        waiting: (card?.textContent ?? "").includes("Waiting in its terminal"),
    };
})()`;

const focusedView = `(() => {
    const pill = ${HEADER_PILL};
    const box = document.querySelector("[data-rendered-composer] textarea");
    return {
        pill: ${flatOf(HEADER_PILL)},
        pillMuted: pill ? getComputedStyle(pill).color === ${colorOf("var(--color-muted)")} : false,
        box: box != null,
        boxDisabled: box?.disabled ?? null,
        boxReadOnly: box?.readOnly ?? null,
        transcript: ${flatOf(`document.querySelector("[data-rendered-feed]")`)}.includes(${JSON.stringify(ANSWER)}),
    };
})()`;

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const ctx = { dir: mkdtempSync(join(tmpdir(), "verify-agent-workers-")) };
                // a throw past this point still returns ctx, so teardown undoes whatever was already set
                try {
                    ctx.stoppedPath = writeTranscript(ctx.dir, "stopped-worker", [
                        userText("[from agent workers parent] how does the tree place workers?"),
                        assistantText(ANSWER),
                    ]);
                    await h.goto("agent");
                    // the stopped worker's tab shows its transcript in the Rendered view, with the agent box under it
                    await pinDefaultView(h, "rendered");
                    const noController = { view: "term", controller: null };
                    const parent = await makeTab(h, ctx, { label: PARENT, blockMeta: noController });
                    const working = await makeTab(h, ctx, {
                        label: WORKING,
                        blockMeta: noController,
                        tabMeta: { "agent:parenttab": parent.tabId },
                    });
                    const stopped = await makeTab(h, ctx, {
                        label: STOPPED,
                        blockMeta: noController,
                        tabMeta: { "agent:parenttab": parent.tabId },
                    });
                    const grand = await makeTab(h, ctx, {
                        label: GRAND,
                        blockMeta: noController,
                        tabMeta: { "agent:parenttab": stopped.tabId },
                    });
                    // done, with a commit this turn made in a linked worktree, as `wsh agent-hook` stamps it
                    const committed = await makeTab(h, ctx, {
                        label: COMMITTED,
                        blockMeta: {
                            ...noController,
                            "agent:lastcommitts": Date.now(),
                            "agent:lastcommitbranch": BRANCH,
                        },
                        tabMeta: { "agent:parenttab": parent.tabId },
                    });
                    ctx.ids = {
                        parent: parent.tabId,
                        working: working.tabId,
                        stopped: stopped.tabId,
                        grand: grand.tabId,
                        committed: committed.tabId,
                    };
                    const now = Date.now();
                    const agent = (made, name, extra) => ({
                        id: made.tabId,
                        blockId: made.blockId,
                        name,
                        project: PROJECT,
                        task: name,
                        agent: "claude",
                        model: "opus",
                        ...extra,
                    });
                    // the roster's order puts each worker before its parent, so the nesting is the tree's own doing
                    await setRoster(h, [
                        agent(grand, GRAND, {
                            state: "idle",
                            idleSince: now - 60_000,
                            parentTabId: stopped.tabId,
                            stopped: true,
                        }),
                        agent(working, WORKING, { state: "working", activeMs: 20_000, parentTabId: parent.tabId }),
                        agent(stopped, STOPPED, {
                            state: "idle",
                            idleSince: now - 30_000,
                            parentTabId: parent.tabId,
                            stopped: true,
                            transcriptPath: ctx.stoppedPath,
                        }),
                        agent(committed, COMMITTED, { state: "idle", idleSince: now - 5_000, parentTabId: parent.tabId }),
                        agent(parent, PARENT, { state: "idle", idleSince: now - 10_000 }),
                    ]);
                    await focusAgent(h, parent.tabId);
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec("arrange the fixture agents", false, ctx.arrangeError);
                    return steps;
                }
                const { parent, working, stopped, grand, committed } = ctx.ids;
                const order = [parent, working, stopped, grand];

                await polishWaitFor(h, `${treeRows(order)}.length === 4`, LOAD_WAIT_MS);
                const rows = await h.ev(treeRows(order));
                await h.shot(SHOT(1, "tree"));
                const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
                const level = (id) => byId[id]?.pad;
                rec(
                    "1. the parent's working and stopped workers nest under it, and the stopped worker's own worker a level further; stopped rows read stopped, muted",
                    rows.map((r) => r.id).join() === order.join() &&
                        level(working) > level(parent) &&
                        level(stopped) === level(working) &&
                        level(grand) > level(stopped) &&
                        byId[parent].stopped == null &&
                        byId[working].stopped == null &&
                        byId[stopped].stopped === "stopped" &&
                        byId[stopped].stoppedMuted === true &&
                        byId[grand].stopped === "stopped",
                    JSON.stringify(rows)
                );

                await focusAgent(h, stopped);
                await polishWaitFor(h, `(${focusedView}).pill === "stopped" && (${focusedView}).transcript`, LOAD_WAIT_MS);
                const view = await h.ev(focusedView);
                await h.shot(SHOT(2, "stopped-focused"));
                rec(
                    "2. the stopped worker focused: its pill reads stopped in the muted tone, its transcript shows, and its agent box is enabled",
                    view.pill === "stopped" &&
                        view.pillMuted &&
                        view.transcript &&
                        view.box &&
                        view.boxDisabled === false &&
                        view.boxReadOnly === false,
                    JSON.stringify(view)
                );

                const treeMark = await polishWaitFor(h, `!!${branchMark(TREE_ROW(committed))}`, LOAD_WAIT_MS);
                const inTree = await h.ev(markOf(TREE_ROW(committed)));
                await h.shot(SHOT(3, "branch-tree"));
                await h.goto("cockpit");
                const cardMark = await polishWaitFor(h, `!!${branchMark(CARD(committed))}`, LOAD_WAIT_MS);
                const onCard = await h.ev(markOf(CARD(committed)));
                await h.shot(SHOT(4, "branch-card"));
                await h.goto("agent");
                rec(
                    "5. a done worker that committed in a worktree shows the branch icon titled with its branch, not the tick, on its tree row and its card",
                    treeMark && cardMark && [inTree, onCard].every((m) => m.branch && !m.tick),
                    JSON.stringify({ inTree, onCard })
                );

                await h.goto("cockpit");
                const stoppedShown = await polishWaitFor(
                    h,
                    `(${stoppedCard(CARD(stopped))}).answer && (${stoppedCard(CARD(grand))}).line != null`,
                    LOAD_WAIT_MS
                );
                const withTranscript = await h.ev(stoppedCard(CARD(stopped)));
                const without = await h.ev(stoppedCard(CARD(grand)));
                await h.shot(SHOT(6, "stopped-card"));
                await h.goto("agent");
                rec(
                    `6. a stopped worker's card reads "${STOPPED_LINE}" above its transcript's last answer, and one with no transcript reads it too; neither reads waiting`,
                    stoppedShown &&
                        withTranscript.line === STOPPED_LINE &&
                        withTranscript.answer &&
                        withTranscript.lineAbove &&
                        !withTranscript.waiting &&
                        without.line === STOPPED_LINE &&
                        !without.waiting,
                    JSON.stringify({ withTranscript, without })
                );
                return steps;
            },
            // best-effort, so one failed step does not strand the rest
            async teardown(h, ctx) {
                const step = async (what, fn) => {
                    try {
                        await fn();
                    } catch (e) {
                        console.error(`${NAME} teardown: ${what} failed: ${e?.message ?? e}`);
                    }
                };
                await step("restore the default view", () => restoreDefaultView(h));
                await step("restore the roster", () => restoreRoster(h));
                await step("close the fixture tabs", () => closeTabs(h, ctx));
                await step("remove the fixture transcript", () => rmSync(ctx.dir, { recursive: true, force: true }));
                await step("go home", () => h.goto("cockpit"));
            },
        },
        {
            name: LIVE_NAME,
            surface: "agent",
            async arrange(h) {
                const ctx = {};
                try {
                    await h.goto("agent");
                    // the live roster, not a fixture one: the stopped mark must come from the backend's write. A row is
                    // live only with a term block that names its cwd.
                    await setRoster(h, null);
                    const parent = await makeTab(h, ctx, {
                        label: LIVE_PARENT,
                        blockMeta: { view: "term", controller: null, "cmd:cwd": tmpdir() },
                        tabMeta: { "session:project": PROJECT },
                    });
                    // armed as a worker's block is, on a command that exits at once: a forced resync runs it, and
                    // the backend's exit path for a worker disarms it. runonstart false keeps any other resync idle.
                    const worker = await makeTab(h, ctx, {
                        label: LIVE_TASK,
                        blockMeta: {
                            view: "term",
                            controller: "cmd",
                            "cmd:cwd": tmpdir(),
                            cmd: "arc-verify-no-such-binary",
                            "cmd:args": [],
                            "cmd:shell": false,
                            "cmd:runonstart": false,
                            // as a worker's: its exit must not close the tab
                            "cmd:keeponexit": true,
                        },
                        tabMeta: {
                            "session:project": PROJECT,
                            "session:label": LIVE_TASK,
                            "agent:parenttab": parent.tabId,
                        },
                    });
                    ctx.ids = { parent: parent.tabId, worker: worker.tabId };
                    ctx.workerBlock = worker.blockId;
                    await publishIdle(h, ctx, parent.blockId);
                    await publishIdle(h, ctx, worker.blockId);
                    await focusAgent(h, parent.tabId);
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec("arrange the live agents", false, ctx.arrangeError);
                    return steps;
                }
                const { parent, worker } = ctx.ids;
                const order = [parent, worker];
                const rows = () => h.ev(liveRows(order));
                const nested = (r) => r.length === 2 && r[0].id === parent && r[1].id === worker && r[1].pad > r[0].pad;

                await polishWaitFor(h, `${liveRows(order)}.length === 2`, LOAD_WAIT_MS);
                const before = await rows();
                await h.rpc("controllerresync", { tabid: worker, blockid: ctx.workerBlock, forcerestart: true });
                const shown = await polishWaitFor(h, `${liveRows(order)}[1]?.stopped === "stopped"`, LOAD_WAIT_MS);
                const after = await rows();
                await h.shot(SHOT_LIVE(1, "stopped-live"));
                rec(
                    "3. a live worker named by its task, running, reads stopped once the backend stops it, with no reload",
                    nested(before) &&
                        before[1].name === LIVE_TASK &&
                        before[1].stopped == null &&
                        shown &&
                        nested(after) &&
                        after[1].stopped === "stopped",
                    JSON.stringify({ before, after })
                );

                await h.reload();
                await h.goto("agent");
                await setRoster(h, null);
                await focusAgent(h, parent);
                await polishWaitFor(h, `${liveRows(order)}.length === 2`, LOAD_WAIT_MS);
                const reloaded = await rows();
                await h.shot(SHOT_LIVE(2, "reloaded"));
                rec(
                    "4. after a reload the stopped worker still reads its task name, not its project's, nested under its parent",
                    nested(reloaded) && reloaded[1].name === LIVE_TASK && reloaded[1].stopped === "stopped",
                    JSON.stringify(reloaded)
                );
                return steps;
            },
            async teardown(h, ctx) {
                const step = async (what, fn) => {
                    try {
                        await fn();
                    } catch (e) {
                        console.error(`${LIVE_NAME} teardown: ${what} failed: ${e?.message ?? e}`);
                    }
                };
                await step("restore the roster", () => restoreRoster(h));
                await step("close the live tabs", () => closeTabs(h, ctx));
                await step("go home", () => h.goto("cockpit"));
            },
        },
    ];
}
