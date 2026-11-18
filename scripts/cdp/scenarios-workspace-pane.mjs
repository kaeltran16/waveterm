// Scenario `workspace-pane`: the Rendered view's workspace pane shell (Task 2 of
// docs/superpowers/plans/2026-11-17-workspace-pane.md; boards Main, Expanded and Closed). The roster is a fixture of
// two claude agents backed by real tabs with no controller, A and B, each with a short transcript, in the Rendered
// view. No transcript card opens a tab yet (later tasks wire them), so the steps open tabs through the workspace
// store, as those cards will. The width preference, the default view and the rail toggle are saved in arrange and put
// back in teardown; the run tab's ask is injected into the page's ask map and removed with it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    agentPage,
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
    pinDefaultView,
    restoreRoster,
    setRoster,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { polishNap, polishWaitFor, RAIL_VISIBLE_KEY, restoreLocalStorage, VIEW_DEFAULT_KEY } from "./scenarios-shared.mjs";

const NAME = "workspace-pane";
const WIDTH_KEY = "agent.workspace.width";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
// longer than the pane's macro reveal (360ms), so a read after it sees the settled pane
const SETTLE_MS = 700;
const DEFAULT_PX = 600;
const STRIP_PX = 44;
const DRAG_PX = 120;
const RUN_ID = "fx-workspace-run";
const ASK = { taskid: "t-2", askid: "fx-workspace-ask", owner: "user", questions: [], blockoref: "", ts: 1 };
const KEY = {
    d: { key: "d", code: "KeyD", keyCode: 68 },
    f: { key: "f", code: "KeyF", keyCode: 70 },
};

const PANE = `document.querySelector('aside[aria-label="Workspace"]')`;
const RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
const TREE = `document.querySelector("[data-agent-tree]")`;
const CENTER = `document.querySelector("[data-agent-center]")`;
const FOOTER = `document.querySelector("[data-hints-footer]")`;
const tabSel = (key) => `[data-workspace-tab="${key}"]`;

// page helpers spliced into each evaluated body
const LIB = `
    const pane = () => ${PANE};
    const width = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
    const W = await mod("app/view/agents/workspacestore.ts");
    const ws = (id) => globalStore.get(W.workspaceAtom(id));
    // every distinct value read() takes, one read per frame, until stop()
    const sampleFrames = (read) => {
        const values = [];
        let on = true;
        const tick = () => {
            const v = read();
            if (v != null && v !== values.at(-1)) values.push(v);
            if (on) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return { values, stop: () => (on = false) };
    };
`;
const page = (h, body) => agentPage(h, `${LIB} ${body}`);

const rosterAgent = (id, blockId, name, transcriptPath) => ({
    id,
    name,
    project: "fx-workspace",
    task: "workspace pane fixture",
    state: "idle",
    agent: "claude",
    model: "claude-opus-5-5",
    blockId,
    transcriptPath,
});

async function press(h, k) {
    // the surface keys fire outside the composer and the terminal, so the wrapper takes focus first
    await h.ev(`document.querySelector("[data-cockpit-surface-wrap]")?.focus()`);
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k.key, code: k.code, text: k.key, windowsVirtualKeyCode: k.keyCode });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
    await polishNap(SETTLE_MS);
}

const mouse = (h, type, x, y, extra = {}) => h.cdp("Input.dispatchMouseEvent", { type, x, y, ...extra });

// the centre of the element expr names, in viewport pixels
const centreOf = (h, expr) =>
    h.ev(`(() => { const r = (${expr})?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);

const openTab = (h, id, tab) => page(h, `W.openWorkspaceTab(${JSON.stringify(id)}, ${JSON.stringify(tab)}); return true;`);

async function arrangeRoster(h, ctx) {
    await h.goto("agent");
    await pinDefaultView(h, "rendered");
    await setRoster(h, ctx.roster);
    await focusAgent(h, ctx.aId);
    if (!(await polishWaitFor(h, `document.querySelector("[data-rendered-composer]") != null`, WAIT_MS))) {
        throw new Error("agent A never showed the Rendered view");
    }
}

export const workspacePane = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-workspace-pane-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            ctx.prev = await h.ev(`({
                width: localStorage.getItem(${JSON.stringify(WIDTH_KEY)}),
                view: localStorage.getItem(${JSON.stringify(VIEW_DEFAULT_KEY)}),
                rail: localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)}),
            })`);
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            const path = (n) =>
                writeTranscript(ctx.dir, `workspace-${n}-${tag}`, [
                    userText(`Summarise the ${n} package.`),
                    assistantText(`The ${n} package counts bookmarks per tag.`),
                ]);
            await h.goto("agent");
            const a = await makeTab(h, ctx, { label: `workspace-a-${tag}`, blockMeta: { view: "term", controller: null } });
            const b = await makeTab(h, ctx, { label: `workspace-b-${tag}`, blockMeta: { view: "term", controller: null } });
            Object.assign(ctx, { aId: a.tabId, bId: b.tabId, aBlock: a.blockId });
            ctx.roster = [
                rosterAgent(a.tabId, a.blockId, `workspace-a-${tag}`, path("stats")),
                rosterAgent(b.tabId, b.blockId, `workspace-b-${tag}`, path("dedupe")),
            ];
            // a fresh profile: no stored width, the rail closed
            await h.ev(`localStorage.removeItem(${JSON.stringify(WIDTH_KEY)}); localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "false")`);
            await h.reload();
            await arrangeRoster(h, ctx);
        } catch (err) {
            ctx.arrangeError = String(err?.message ?? err);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }
        // one throwing step is one FAIL, not the end of the run
        const step = async (name, fn) => {
            try {
                const [ok, detail] = await fn();
                rec(name, ok, detail);
            } catch (err) {
                rec(name, false, `threw: ${err?.message ?? err}`);
            }
        };
        const A = JSON.stringify(ctx.aId);
        const facts = () =>
            page(
                h,
                `const p = pane();
                const center = ${CENTER};
                const term = document.querySelector('[data-agent-terminal=${A}]')?.getBoundingClientRect();
                return {
                    pane: p?.dataset.workspacePane ?? null,
                    paneW: width(p),
                    rowW: width(p?.parentElement),
                    rail: ${RAIL} != null,
                    tree: ${TREE} != null,
                    centerVisible: center ? getComputedStyle(center).visibility : null,
                    termSize: term ? [Math.round(term.width), Math.round(term.height)] : null,
                    tabs: [...document.querySelectorAll("[data-workspace-tab]")].map((t) => t.dataset.workspaceTab),
                    active: document.querySelector('[role="tab"][aria-selected="true"]')?.closest("[data-workspace-tab]")?.dataset.workspaceTab ?? null,
                    state: ws(${A}),
                    railOpen: localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)}),
                    // each chip as "<key> <label>"
                    footer: [...(${FOOTER}?.querySelectorAll("[data-footer-chips] > span") ?? [])].map((c) => {
                        const key = c.firstElementChild?.textContent ?? "";
                        return key + " " + c.textContent.slice(key.length);
                    }),
                };`
            );

        // Main board: Rendered with no tabs has neither the pane nor the rail, and d changes nothing
        await step("Rendered with no tabs: no pane, no rail, and d changes nothing (Main board)", async () => {
            const before = await facts();
            await press(h, KEY.d);
            const after = await facts();
            const ok =
                before.pane == null &&
                !before.rail &&
                after.pane == null &&
                !after.rail &&
                after.state.tabs.length === 0 &&
                after.railOpen === before.railOpen &&
                !after.footer.includes("d rail") &&
                !after.footer.includes("d pane");
            return [ok, { before: { pane: before.pane, rail: before.rail }, after: { pane: after.pane, rail: after.rail, railOpen: after.railOpen } }];
        });
        await h.shot("cdp-shots/workspace-pane-main.png");

        // 6b: the pane opens from nothing to the stored width, through the frames between
        await step("opening a tab reveals the pane (6b) at 600px on a fresh profile", async () => {
            const r = await page(
                h,
                `const s = sampleFrames(() => width(pane()));
                W.openWorkspaceTab(${A}, { kind: "changes", selected: null });
                await nap(${SETTLE_MS});
                s.stop();
                return { widths: s.values, final: width(pane()) };`
            );
            const between = r.widths.filter((w) => w > 0 && w < DEFAULT_PX);
            return [r.final === DEFAULT_PX && between.length > 0, r];
        });

        await step("the d binding follows the tabs with no key event: the footer offers d for the pane", async () => {
            const f = await facts();
            return [f.footer.includes("d pane") && !f.footer.includes("d rail"), f.footer];
        });

        // 1: a tab added fades and scales in
        await step("a new tab enters (1)", async () => {
            const r = await page(
                h,
                `const pick = () => document.querySelector('${tabSel(`file:internal/stats/stats.go`)}');
                const s = sampleFrames(() => (pick() ? Number(getComputedStyle(pick()).opacity).toFixed(2) : null));
                W.openWorkspaceTab(${A}, { kind: "file", path: "internal/stats/stats.go", line: 17 });
                await nap(${SETTLE_MS});
                s.stop();
                return { opacities: s.values.map(Number), label: pick()?.textContent ?? null };`
            );
            const mid = r.opacities.some((o) => o > 0 && o < 1);
            return [mid && r.opacities.at(-1) === 1 && r.label?.includes("stats.go"), r];
        });

        // 9: the active tab's indicator slides from the file tab to the Changes tab
        await step("the active-tab indicator slides to the activated tab (9)", async () => {
            const r = await page(
                h,
                `const ind = () => document.querySelector("[data-workspace-tab-indicator]");
                const from = Math.round(ind().getBoundingClientRect().left);
                const s = sampleFrames(() => (ind() ? Math.round(ind().getBoundingClientRect().left) : null));
                document.querySelector('${tabSel("changes")} [role="tab"]').click();
                await nap(${SETTLE_MS});
                s.stop();
                return { from, lefts: s.values, to: Math.round(ind().getBoundingClientRect().left), active: ws(${A}).active };`
            );
            const lo = Math.min(r.from, r.to);
            const hi = Math.max(r.from, r.to);
            const between = r.lefts.filter((x) => x > lo && x < hi);
            return [r.active === "changes" && r.from !== r.to && between.length > 0, r];
        });

        // the edge drags the width, a reload keeps it, a double-click puts back 600
        await step("dragging the left edge resizes the pane", async () => {
            const at = await centreOf(h, "document.querySelector('[data-workspace-resize]')");
            if (at == null) return [false, "no resize handle"];
            await mouse(h, "mouseMoved", at.x, at.y);
            await mouse(h, "mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 1 });
            for (let i = 1; i <= 6; i++) {
                await mouse(h, "mouseMoved", at.x - (DRAG_PX * i) / 6, at.y, { button: "left", buttons: 1 });
            }
            await mouse(h, "mouseReleased", at.x - DRAG_PX, at.y, { button: "left", buttons: 0, clickCount: 1 });
            await polishNap(SETTLE_MS);
            const f = await facts();
            const stored = await h.ev(`localStorage.getItem(${JSON.stringify(WIDTH_KEY)})`);
            return [f.paneW === DEFAULT_PX + DRAG_PX && Number(stored) === DEFAULT_PX + DRAG_PX, { paneW: f.paneW, stored }];
        });

        await step("the dragged width survives a reload", async () => {
            await h.reload();
            await arrangeRoster(h, ctx);
            // tabs live in memory, so the reload dropped them: the next opened tab shows the stored width
            await openTab(h, ctx.aId, { kind: "changes", selected: null });
            await polishNap(SETTLE_MS);
            const f = await facts();
            return [f.paneW === DEFAULT_PX + DRAG_PX, { paneW: f.paneW }];
        });

        await step("double-clicking the edge resets the pane to 600", async () => {
            const at = await centreOf(h, "document.querySelector('[data-workspace-resize]')");
            if (at == null) return [false, "no resize handle"];
            await mouse(h, "mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 1 });
            await mouse(h, "mouseReleased", at.x, at.y, { button: "left", buttons: 0, clickCount: 1 });
            await mouse(h, "mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 2 });
            await mouse(h, "mouseReleased", at.x, at.y, { button: "left", buttons: 0, clickCount: 2 });
            await polishNap(SETTLE_MS);
            const f = await facts();
            const title = await h.ev(`document.querySelector('[data-workspace-resize]')?.title`);
            return [f.paneW === DEFAULT_PX && title === "Drag to resize · double-click resets to 600px", { paneW: f.paneW, title }];
        });

        // Expanded board
        await step("expand fills the surface with the pane, hides the transcript and keeps the terminal laid out", async () => {
            await openTab(h, ctx.aId, { kind: "run", runId: RUN_ID, view: "tasks" });
            await openTab(h, ctx.aId, { kind: "file", path: "internal/stats/stats.go", line: 17 });
            await h.ev(`document.querySelector("[data-workspace-expand]").click()`);
            await polishNap(SETTLE_MS);
            const f = await facts();
            const ok =
                f.pane === "expanded" &&
                f.paneW === f.rowW &&
                f.centerVisible === "hidden" &&
                f.termSize != null &&
                f.termSize[0] > 0 &&
                f.termSize[1] > 0;
            return [ok, { pane: f.pane, paneW: f.paneW, rowW: f.rowW, center: f.centerVisible, term: f.termSize }];
        });
        await h.shot("cdp-shots/workspace-pane-expanded.png");

        await step("restore brings the transcript back beside the pane", async () => {
            await h.ev(`document.querySelector("[data-workspace-expand]").click()`);
            await polishNap(SETTLE_MS);
            const f = await facts();
            return [f.pane === "open" && f.paneW === DEFAULT_PX && f.centerVisible === "visible", { pane: f.pane, paneW: f.paneW, center: f.centerVisible }];
        });

        // Closed board: the run tab's user-owned ask is the strip's needs-you badge and the tab's dot
        await step("collapse shows the 44px strip with the tab count and the needs-you badge (Closed board)", async () => {
            await page(
                h,
                `const C = await mod("app/view/agents/childaskstore.ts");
                globalStore.set(C.childAsksAtom, (prev) => ({ ...prev, ${JSON.stringify(RUN_ID)}: [${JSON.stringify(ASK)}] }));
                return true;`
            );
            ctx.askInjected = true;
            await polishWaitFor(h, `document.querySelector('${tabSel(`run:${RUN_ID}`)} [data-workspace-tab-waiting]') != null`, WAIT_MS);
            const dot = await h.ev(`document.querySelector('${tabSel(`run:${RUN_ID}`)} [data-workspace-tab-waiting]') != null`);
            const title = await h.ev(`document.querySelector("[data-workspace-collapse]")?.title`);
            await h.ev(`document.querySelector("[data-workspace-collapse]").click()`);
            await polishNap(SETTLE_MS);
            const f = await facts();
            const strip = await h.ev(`({
                count: document.querySelector("[data-workspace-strip-count]")?.textContent ?? null,
                needs: document.querySelector("[data-workspace-strip-needs]")?.textContent ?? null,
                title: document.querySelector("[data-workspace-strip]")?.title ?? null,
            })`);
            const ok = dot && title === "Collapse (d)" && f.pane === "strip" && f.paneW === STRIP_PX && strip.count === "3" && strip.needs === "1";
            return [ok, { dot, title, pane: f.pane, paneW: f.paneW, strip }];
        });
        await h.shot("cdp-shots/workspace-pane-closed.png");

        await step("d restores the collapsed pane and collapses it again", async () => {
            await press(h, KEY.d);
            const open = await facts();
            await press(h, KEY.d);
            const closed = await facts();
            return [open.pane === "open" && open.paneW === DEFAULT_PX && closed.pane === "strip", { open: open.pane, closed: closed.pane }];
        });

        await step("clicking the strip restores the pane", async () => {
            await h.ev(`document.querySelector("[data-workspace-strip]").click()`);
            await polishNap(SETTLE_MS);
            const f = await facts();
            return [f.pane === "open" && f.paneW === DEFAULT_PX, { pane: f.pane, paneW: f.paneW }];
        });

        // an inactive tab closes by its hover x and by middle-click; the active tab stays active
        await step("an inactive tab's x shows on hover and closes it (2), and the active tab stays active", async () => {
            const before = await facts();
            const target = `run:${RUN_ID}`;
            const hidden = await h.ev(`Number(getComputedStyle(document.querySelector('${tabSel(target)} [data-workspace-tab-close]')).opacity)`);
            const at = await centreOf(h, `document.querySelector('${tabSel(target)} [role="tab"]')`);
            await mouse(h, "mouseMoved", at.x, at.y);
            await polishNap(SETTLE_MS);
            const shown = await h.ev(`Number(getComputedStyle(document.querySelector('${tabSel(target)} [data-workspace-tab-close]')).opacity)`);
            const x = await centreOf(h, `document.querySelector('${tabSel(target)} [data-workspace-tab-close]')`);
            // the sampler outlives this evaluate, so the real click below lands while it runs
            await page(
                h,
                `const pick = () => document.querySelector('${tabSel(target)}');
                window.__workspaceExitSample = sampleFrames(() => (pick() ? Number(getComputedStyle(pick()).opacity).toFixed(2) : "gone"));
                return true;`
            );
            await mouse(h, "mousePressed", x.x, x.y, { button: "left", buttons: 1, clickCount: 1 });
            await mouse(h, "mouseReleased", x.x, x.y, { button: "left", buttons: 0, clickCount: 1 });
            await polishNap(SETTLE_MS);
            const seen = await h.ev(`(() => { const s = window.__workspaceExitSample; s.stop(); delete window.__workspaceExitSample; return s.values; })()`);
            const after = await facts();
            const fading = seen.some((v) => v !== "gone" && Number(v) > 0 && Number(v) < 1);
            const ok =
                hidden === 0 &&
                shown === 1 &&
                fading &&
                seen.at(-1) === "gone" &&
                !after.tabs.includes(target) &&
                after.active === before.active;
            return [ok, { hidden, shown, exit: seen, tabs: after.tabs, active: [before.active, after.active] }];
        });

        await step("middle-clicking an inactive tab closes it, and the active tab stays active", async () => {
            const before = await facts();
            const target = before.tabs.find((t) => t !== before.active);
            const at = await centreOf(h, `document.querySelector('${tabSel(target)} [role="tab"]')`);
            await mouse(h, "mousePressed", at.x, at.y, { button: "middle", buttons: 4, clickCount: 1 });
            await mouse(h, "mouseReleased", at.x, at.y, { button: "middle", buttons: 0, clickCount: 1 });
            await polishNap(SETTLE_MS);
            const after = await facts();
            return [!after.tabs.includes(target) && after.active === before.active && after.tabs.length === 1, { target, tabs: after.tabs, active: [before.active, after.active] }];
        });

        // tabs belong to the agent: they survive switching to another agent and back
        await step("tabs survive switching to another agent and back", async () => {
            const before = await facts();
            await focusAgent(h, ctx.bId);
            await polishNap(SETTLE_MS);
            const onB = await facts();
            await focusAgent(h, ctx.aId);
            await polishNap(SETTLE_MS);
            const back = await facts();
            const ok = onB.pane == null && back.pane === "open" && JSON.stringify(back.tabs) === JSON.stringify(before.tabs);
            return [ok, { before: before.tabs, onB: onB.pane, back: back.tabs }];
        });

        // the Terminal view keeps the rail and its d; the tabs wait for the return to Rendered
        await step("in Terminal the rail shows as today, the footer offers d for it, and d toggles it", async () => {
            const before = await facts();
            await page(h, `const R = await mod("app/view/agents/renderedmode.ts"); globalStore.set(R.viewModeAtom(${A}), "terminal"); return true;`);
            await polishNap(SETTLE_MS);
            // the flip hands focus to the terminal, where the footer shows only the keys that work inside it
            await h.ev(`document.querySelector("[data-cockpit-surface-wrap]")?.focus()`);
            await polishNap(SETTLE_MS);
            const term = await facts();
            const railW0 = await h.ev(`Math.round(${RAIL}?.getBoundingClientRect().width ?? 0)`);
            await press(h, KEY.d);
            const railW1 = await h.ev(`Math.round(${RAIL}?.getBoundingClientRect().width ?? 0)`);
            const toggled = await facts();
            await press(h, KEY.d);
            const ok =
                term.pane == null &&
                term.rail &&
                term.footer.includes("d rail") &&
                !term.footer.includes("d pane") &&
                toggled.railOpen !== before.railOpen &&
                railW0 !== railW1 &&
                toggled.state.collapsed === before.state.collapsed;
            return [ok, { pane: term.pane, rail: term.rail, railW: [railW0, railW1], railOpen: [before.railOpen, toggled.railOpen] }];
        });

        await step("tabs survive the flip to Terminal and back", async () => {
            await page(h, `const R = await mod("app/view/agents/renderedmode.ts"); globalStore.set(R.viewModeAtom(${A}), "rendered"); return true;`);
            await polishNap(SETTLE_MS);
            const f = await facts();
            return [f.pane === "open" && !f.rail && f.tabs.length === 1, { pane: f.pane, rail: f.rail, tabs: f.tabs }];
        });

        await step("f hides the tree and the pane stays", async () => {
            await press(h, KEY.f);
            const full = await facts();
            await press(h, KEY.f);
            const back = await facts();
            return [!full.tree && full.pane === "open" && back.tree && back.pane === "open", { full: [full.tree, full.pane], back: [back.tree, back.pane] }];
        });

        // closing the last tab removes the pane, which leaves rather than vanishing
        await step("closing the last tab removes the pane", async () => {
            const r = await page(
                h,
                `const s = sampleFrames(() => width(pane()) ?? "gone");
                document.querySelector('[data-workspace-tab] [data-workspace-tab-close]').click();
                await nap(${SETTLE_MS});
                s.stop();
                return { widths: s.values, state: ws(${A}) };`
            );
            const f = await facts();
            const leaving = r.widths.some((w) => w !== "gone" && w > 0 && w < DEFAULT_PX);
            return [f.pane == null && !f.rail && r.state.tabs.length === 0 && leaving && !f.footer.includes("d pane"), { widths: r.widths, pane: f.pane, footer: f.footer }];
        });

        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`${NAME} teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("close the workspace tabs", () =>
            page(
                h,
                `for (const id of ${JSON.stringify([ctx.aId, ctx.bId].filter(Boolean))}) {
                    for (const t of [...ws(id).tabs]) W.closeWorkspaceTab(id, t.kind === "run" ? "run:" + t.runId : t.kind === "file" ? "file:" + t.path : t.kind);
                    const R = await mod("app/view/agents/renderedmode.ts");
                    globalStore.set(R.viewModeAtom(id), "rendered");
                }
                return true;`
            )
        );
        if (ctx.askInjected) {
            await step("drop the injected ask", () =>
                agentPage(
                    h,
                    `const C = await mod("app/view/agents/childaskstore.ts");
                    globalStore.set(C.childAsksAtom, (prev) => { const next = { ...prev }; delete next[${JSON.stringify(RUN_ID)}]; return next; });
                    return true;`
                )
            );
        }
        await step("restore the roster", () => restoreRoster(h));
        await step("close the tabs", () => closeTabs(h, ctx));
        // the reloads dropped the in-page saved values, so the stored ones go back and a reload reads them
        if (ctx.prev) {
            await step("restore the stored preferences", () =>
                h.ev(
                    [
                        restoreLocalStorage(WIDTH_KEY, ctx.prev.width),
                        restoreLocalStorage(VIEW_DEFAULT_KEY, ctx.prev.view),
                        restoreLocalStorage(RAIL_VISIBLE_KEY, ctx.prev.rail),
                    ].join("; ")
                )
            );
            await step("reload onto the restored preferences", () => h.reload());
        }
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true }));
        await step("go home", () => h.goto("cockpit"));
    },
};
