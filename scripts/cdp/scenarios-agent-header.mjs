// Agent review scenario `agent-header`: the header's state pill, menu and button titles. The roster is a fixture
// (two claude agents whose block ids are real tabs with no controller, so nothing runs) beside one real plain terminal
// tab. Nothing is written to disk; teardown closes the tabs and restores the roster.

import { randomUUID } from "node:crypto";
import {
    agentPage,
    closeTabs,
    focusAgent,
    makeTab,
    quietUntil,
    restoreRoster,
    setRoster,
} from "./agent-page-fixtures.mjs";
import { polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "agent-header";
const HEADER_WAIT_MS = 5_000;
const QUIET_MIN = 4;
// the pill fades its color over 140ms, so a computed color read mid-fade is not yet the tone
const PILL_FADE_MS = 400;

const HEADER = `document.querySelector("[data-agent-header]")`;
const headerState = `(() => {
    const hd = ${HEADER};
    if (!hd) return null;
    const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const pill = hd.querySelector("[data-agent-state-pill]");
    const probe = document.createElement("span");
    probe.style.color = "var(--color-warning)";
    document.body.appendChild(probe);
    const warning = getComputedStyle(probe).color;
    probe.remove();
    return {
        text: flat(hd),
        pill: pill ? flat(pill) : null,
        pillWarning: pill != null && getComputedStyle(pill).color === warning,
        closeTitle: hd.querySelector('button[title^="Close"]')?.getAttribute("title") ?? null,
        fullscreenTitle: hd.querySelector("button[aria-pressed][title*='ullscreen']")?.getAttribute("title") ?? null,
    };
})()`;

const rosterAgent = (id, blockId, name, state) => ({
    id,
    name,
    task: "header fixture",
    state,
    agent: "claude",
    model: "claude-opus-5-5",
    usage: { contextpct: 42, contextmax: 200_000 },
    project: name,
    blockId,
});

const NARROW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const WIDE = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
// the title keeps this much before the model and context chips give way (the component's min-w floor)
const TITLE_FLOOR_PX = 96;
// runtime, state, model and context: every chip the fixture agent has
const HEADER_CHIPS = 4;
// the title, then the runtime and state pills each on a line of their own when the column cannot hold both
const MAX_LINES = 3;

// where the title row's parts sit: the title, each chip after it, the column that clips them, the buttons beside it
const headerFit = `(() => {
    const hd = ${HEADER};
    const row = hd?.querySelector("[data-agent-title-row]");
    const actions = hd?.querySelector("[data-agent-actions]");
    if (!row || !actions) return null;
    const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
    };
    const [title, ...chips] = [...row.children];
    const col = box(row.parentElement);
    const act = box(actions);
    const parts = chips
        .map((el) => ({ text: (el.textContent ?? "").trim(), shown: getComputedStyle(el).display !== "none", ...box(el) }))
        .filter((p) => p.shown);
    return {
        headerWidth: box(hd).width,
        titleWidth: box(title).width,
        titleClipped: title.scrollWidth > title.clientWidth,
        // items on one line share a vertical center; another line sits a whole line lower
        lines: [title, ...chips]
            .filter((el) => getComputedStyle(el).display !== "none")
            .map((el) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2; })
            .sort((a, b) => a - b)
            .reduce((n, c, i, all) => (i > 0 && c - all[i - 1] > 6 ? n + 1 : n), 1),
        shown: parts.map((p) => p.text),
        outOfColumn: parts.filter((p) => p.right > col.right + 0.5).map((p) => p.text),
        underButtons: parts.filter((p) => p.right > act.left + 0.5).map((p) => p.text),
    };
})()`;

// the labels the header's right-click menu offers, read from the menu atom the host renders
const menuLabels = `(async () => {
    const hd = ${HEADER};
    const { contextMenuAtom, closeContextMenu } = await mod("app/store/contextmenu.ts");
    hd.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    await until(() => globalStore.get(contextMenuAtom) != null, 2000);
    const items = globalStore.get(contextMenuAtom)?.items ?? [];
    closeContextMenu();
    return items.map((i) => i.label).filter(Boolean);
})()`;

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const tag = randomUUID().slice(0, 8);
                const ctx = { tabIds: [] };
                await h.goto("agent");
                try {
                    const working = await makeTab(h, ctx, { label: `header-working-${tag}` });
                    const idle = await makeTab(h, ctx, { label: `header-idle-${tag}` });
                    const term = await makeTab(h, ctx, {
                        label: `header-term-${tag}`,
                        // the sidebar lists a tab as a session only once its term block names a cwd
                        blockMeta: { view: "term", "cmd:cwd": "~" },
                        tabMeta: { "session:agent": "terminal" },
                    });
                    Object.assign(ctx, {
                        workingId: working.tabId,
                        workingBlock: working.blockId,
                        idleId: idle.tabId,
                        termId: term.tabId,
                    });
                    await setRoster(h, [
                        rosterAgent(working.tabId, working.blockId, `header-working-${tag}`, "working"),
                        rosterAgent(idle.tabId, idle.blockId, `header-idle-${tag}`, "idle"),
                    ]);
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec("arrange the fixture", false, ctx.arrangeError);
                    return steps;
                }

                await focusAgent(h, ctx.termId);
                await polishWaitFor(h, `(${HEADER}?.textContent ?? "").includes("header-term-")`, HEADER_WAIT_MS);
                const term = await h.ev(headerState);
                await h.shot("cdp-shots/agent-header-1-terminal.png");
                rec(
                    "1. a terminal's header has no state pill and its close title reads Close terminal",
                    term != null && term.pill == null && term.closeTitle === "Close terminal",
                    JSON.stringify(term)
                );

                await focusAgent(h, ctx.idleId);
                await polishWaitFor(h, `(${HEADER}?.textContent ?? "").includes("header-idle-")`, HEADER_WAIT_MS);
                const idleMenu = await agentPage(h, `return ${menuLabels};`);
                await h.shot("cdp-shots/agent-header-2-idle.png");
                await focusAgent(h, ctx.workingId);
                await polishWaitFor(h, `(${HEADER}?.textContent ?? "").includes("header-working-")`, HEADER_WAIT_MS);
                const workingMenu = await agentPage(h, `return ${menuLabels};`);
                rec(
                    "2. the idle agent's menu has no Interrupt turn, the working agent's has it",
                    !idleMenu.includes("Interrupt turn") && workingMenu.includes("Interrupt turn"),
                    JSON.stringify({ idleMenu, workingMenu })
                );

                const attempts = await quietUntil(h, ctx.workingBlock, QUIET_MIN, () =>
                    polishWaitFor(
                        h,
                        `(${HEADER}?.querySelector("[data-agent-state-pill]")?.textContent ?? "").startsWith("quiet")`,
                        HEADER_WAIT_MS
                    )
                );
                await agentPage(h, `await nap(${PILL_FADE_MS}); return true;`);
                const quiet = await h.ev(headerState);
                await h.shot("cdp-shots/agent-header-3-quiet.png");
                rec(
                    `3. a working agent silent for ${QUIET_MIN} minutes reads quiet ${QUIET_MIN}m in the warning color`,
                    quiet != null && quiet.pill === `quiet ${QUIET_MIN}m` && quiet.pillWarning,
                    JSON.stringify({ ...quiet, attempts })
                );

                const before = quiet?.fullscreenTitle ?? "";
                await h.ev(`${HEADER}?.querySelector("button[aria-pressed][title*='ullscreen']")?.click()`);
                await polishWaitFor(
                    h,
                    `${HEADER}?.querySelector("button[aria-pressed][title*='ullscreen']")?.getAttribute("aria-pressed") === "true"`,
                    HEADER_WAIT_MS
                );
                const after = (await h.ev(headerState))?.fullscreenTitle ?? "";
                await h.shot("cdp-shots/agent-header-4-fullscreen.png");
                rec(
                    "4. the fullscreen button's titles name F11, before and after toggling",
                    before.includes("F11") && after.includes("F11") && before !== after,
                    JSON.stringify({ before, after })
                );

                // the rail and fullscreen are the page's own state: teardown puts the rail back
                await agentPage(
                    h,
                    `const R = await mod("app/view/agents/railstore.ts");
                    if (!("__headerRailPrev" in window)) window.__headerRailPrev = globalStore.get(R.railVisibleAtom);
                    globalStore.set(R.terminalFullscreenAtom, false);
                    globalStore.set(R.railVisibleAtom, true);
                    return true;`
                );
                try {
                    await h.cdp("Emulation.setDeviceMetricsOverride", NARROW);
                    await polishWaitFor(h, `${HEADER}?.getBoundingClientRect().width < ${NARROW.width}`, HEADER_WAIT_MS);
                    const narrow = await h.ev(headerFit);
                    await h.shot("cdp-shots/agent-header-5-narrow-rail.png");
                    rec(
                        `5. at 1000x700 with the rail open the title keeps ${TITLE_FLOOR_PX}px, only the runtime and state pills show, wrapped under it, and none reaches the buttons`,
                        narrow != null &&
                            narrow.titleWidth >= TITLE_FLOOR_PX &&
                            narrow.lines <= MAX_LINES &&
                            narrow.shown.length === HEADER_CHIPS - 2 &&
                            narrow.outOfColumn.length === 0 &&
                            narrow.underButtons.length === 0,
                        JSON.stringify(narrow)
                    );

                    await h.cdp("Emulation.setDeviceMetricsOverride", WIDE);
                    await polishWaitFor(h, `${HEADER}?.getBoundingClientRect().width > ${NARROW.width}`, HEADER_WAIT_MS);
                    const wide = await h.ev(headerFit);
                    await h.shot("cdp-shots/agent-header-6-wide-rail.png");
                    rec(
                        "6. at 1600x950 with the rail open the model pill and context readout still show",
                        wide != null &&
                            wide.shown.includes("claude-opus-5-5") &&
                            wide.shown.length === HEADER_CHIPS &&
                            wide.titleWidth >= TITLE_FLOOR_PX &&
                            wide.underButtons.length === 0,
                        JSON.stringify(wide)
                    );
                } finally {
                    await h.cdp("Emulation.clearDeviceMetricsOverride").catch(() => {});
                }
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
                await step("clear the viewport override", () => h.cdp("Emulation.clearDeviceMetricsOverride"));
                await step("put the rail back", () =>
                    agentPage(
                        h,
                        `const { railVisibleAtom } = await mod("app/view/agents/railstore.ts");
                        if ("__headerRailPrev" in window) {
                            globalStore.set(railVisibleAtom, window.__headerRailPrev);
                            delete window.__headerRailPrev;
                        }
                        return true;`
                    )
                );
                await step("leave fullscreen", () =>
                    agentPage(
                        h,
                        `const { terminalFullscreenAtom } = await mod("app/view/agents/railstore.ts");
                        globalStore.set(terminalFullscreenAtom, false);
                        return true;`
                    )
                );
                await step("clear the last-output stamp", () =>
                    agentPage(
                        h,
                        `const { getLastOutputAtom } = await mod("app/view/agents/agentcontrollerstore.ts");
                        globalStore.set(getLastOutputAtom(${JSON.stringify(ctx.workingBlock ?? "")}), undefined);
                        return true;`
                    )
                );
                await step("restore the roster", () => restoreRoster(h));
                await step("close the tabs", () => closeTabs(h, ctx));
                await step("go home", () => h.goto("cockpit"));
            },
        },
    ];
}
