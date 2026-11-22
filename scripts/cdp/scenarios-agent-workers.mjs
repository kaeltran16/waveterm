// Agent scenario `agent-workers`: agents started by another agent nest under it in the Agent tree. A parent with a
// working worker and a stopped worker, and the stopped worker's own stopped worker one level further down. The
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
                    ctx.ids = {
                        parent: parent.tabId,
                        working: working.tabId,
                        stopped: stopped.tabId,
                        grand: grand.tabId,
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
                const { parent, working, stopped, grand } = ctx.ids;
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
    ];
}
