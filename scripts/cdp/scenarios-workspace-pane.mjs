// Scenario `workspace-pane`: the Rendered view's workspace pane shell (Task 2 of
// docs/superpowers/plans/2026-11-17-workspace-pane.md; boards Main, Expanded and Closed). The roster is a fixture of
// two claude agents backed by real tabs with no controller, A and B, each with a short transcript, in the Rendered
// view. No transcript card opens a tab yet (later tasks wire them), so the steps open tabs through the workspace
// store, as those cards will. The width preference, the default view and the rail toggle are saved in arrange and put
// back in teardown; the run tab's ask is injected into the page's ask map and removed with it. A's block names a temp
// repo with one uncommitted long line, for the Changes tab's wrap.
//
// Scenario `workspace-pane-canvas` (end of file): the Canvas tab's stacked list, the canvas window and the transcript's
// one-row Mockup card (docs/superpowers/plans/2026-11-18-workspace-pane-polish.md), on RBS_KIT's fixture agent with a
// canvas and no brainstorm.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { dragMarkBox } from "./scenarios-agent.mjs";
import { RBS_KIT } from "./scenarios-rendered-brainstorm.mjs";
import { git, polishNap, polishWaitFor, RAIL_VISIBLE_KEY, restoreLocalStorage, VIEW_DEFAULT_KEY } from "./scenarios-shared.mjs";

const NAME = "workspace-pane";
const WIDTH_KEY = "agent.workspace.width";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
// longer than the pane's macro reveal (360ms), so a read after it sees the settled pane
const SETTLE_MS = 700;
const DEFAULT_PX = 600;
const STRIP_PX = 44;
const DRAG_PX = 120;
// the run is not in the store, so its tab shows the id as its title: a long one, so four tabs overflow the strip
const RUN_ID = "fx-workspace-run-nightly-bookmark-dedupe-and-tag-statistics";
const FILE_PATH = "internal/stats/bookmark_tag_frequency_stats.go";
// agent A's block cwd: a repo whose one uncommitted change adds a line far wider than the Changes tab's diff column
const REPO_FILE = "notes.md";
const LONG_LINE = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ") + " the end of the long line";
// a first git read in a new repo can take a while
const GIT_WAIT_MS = 20_000;
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
            const repo = join(ctx.dir, "repo");
            mkdirSync(repo);
            git(repo, "init", "-q", "--initial-branch=main");
            writeFileSync(join(repo, REPO_FILE), "notes\n");
            git(repo, "add", ".");
            git(repo, "commit", "-q", "-m", "seed");
            writeFileSync(join(repo, REPO_FILE), `notes\n${LONG_LINE}\n`);
            await h.goto("agent");
            // the Changes tab reads the block's cwd; no controller, so no shell stamps its own
            const a = await makeTab(h, ctx, {
                label: `workspace-a-${tag}`,
                blockMeta: { view: "term", controller: null, "cmd:cwd": repo },
            });
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

        // the Changes tab wraps (Task 2): the long line is several visual rows, each in its insert band, with the
        // line's number and + sign on the first row, and a sideways wheel moving nothing
        await step("the Changes tab's diff wraps a long line, its band, number and sign kept, with no sideways scroll", async () => {
            const ED = `(() => { const p = document.querySelector("[data-workspace-changes] [data-diff-pane]"); return p?.querySelector(".editor.modified .monaco-editor") ?? [...(p?.querySelectorAll(".monaco-editor") ?? [])].at(-1) ?? null; })()`;
            const shown = await polishWaitFor(
                h,
                `[...(${ED}?.querySelectorAll(".view-line") ?? [])].some((l) => l.textContent.includes("word0"))`,
                GIT_WAIT_MS
            );
            await polishNap(SETTLE_MS);
            const r = await h.ev(`(() => {
                const ed = ${ED};
                const long = ${JSON.stringify(LONG_LINE)};
                const box = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
                const text = (el) => el.textContent.replace(/\\u00a0/g, " ").trim();
                const rows = [...(ed?.querySelectorAll(".view-lines .view-line") ?? [])]
                    .filter((l) => text(l) !== "" && long.includes(text(l)))
                    .map((l) => ({ text: text(l), ...box(l) }))
                    .sort((a, b) => a.top - b.top);
                const bands = [...(ed?.querySelectorAll(".view-overlays .line-insert") ?? [])].map(box);
                const numbers = [...(ed?.querySelectorAll(".margin .line-numbers") ?? [])].filter((n) => text(n) === "2").map(box);
                const signs = [...(ed?.querySelectorAll(".margin [class*='diff-insert']") ?? [])].map(box);
                const first = rows[0];
                const near = (b) => first != null && Math.abs(b.top - first.top) <= 2;
                const edBox = ed ? box(ed) : null;
                return {
                    rows: rows.length,
                    joined: rows.map((x) => x.text).join(" ").replace(/\\s+/g, " ") === long,
                    banded: rows.every((x) => bands.some((b) => b.top <= x.top + 1 && b.bottom >= x.bottom - 1)),
                    bands: bands.length,
                    number: numbers.length === 1 && near(numbers[0]),
                    sign: signs.some(near),
                    signs: signs.length,
                    insideEditor: edBox != null && rows.every((x) => x.right <= edBox.right + 1),
                    lefts: rows.map((x) => x.left),
                };
            })()`);
            await h.shot("cdp-shots/workspace-pane-changes-wrap.png");
            // monaco draws its own scrollbars, so a real sideways wheel over the editor is what shows it cannot scroll
            const at = await centreOf(h, ED);
            if (at != null) await h.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 600, deltaY: 0 });
            await polishNap(SETTLE_MS);
            const lefts = await h.ev(`[...(${ED}?.querySelectorAll(".view-lines .view-line") ?? [])]
                .filter((l) => { const t = l.textContent.replace(/\\u00a0/g, " ").trim(); return t !== "" && ${JSON.stringify(LONG_LINE)}.includes(t); })
                .map((l) => Math.round(l.getBoundingClientRect().left))
                .sort((a, b) => a - b)`);
            const unmoved = at != null && JSON.stringify(lefts) === JSON.stringify([...r.lefts].sort((a, b) => a - b));
            const ok =
                shown &&
                r.rows > 1 &&
                r.joined &&
                r.banded &&
                r.number &&
                r.sign &&
                r.insideEditor &&
                unmoved;
            return [ok, { shown, ...r, afterWheel: lefts, unmoved }];
        });

        // 1: a tab added fades and scales in
        await step("a new tab enters (1)", async () => {
            const r = await page(
                h,
                `const pick = () => document.querySelector('${tabSel(`file:${FILE_PATH}`)}');
                const s = sampleFrames(() => (pick() ? Number(getComputedStyle(pick()).opacity).toFixed(2) : null));
                W.openWorkspaceTab(${A}, { kind: "file", path: ${JSON.stringify(FILE_PATH)}, line: 17 });
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
            await openTab(h, ctx.aId, { kind: "file", path: FILE_PATH, line: 17 });
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

        // Task 1: Run (long title, waiting), Changes, the file and Canvas at their full labels overflow the 600px strip,
        // so only the shown tab keeps its label. The Canvas tab it opens is closed again and the file tab re-shown
        await step("with more tabs than fit, every tab but the shown one drops to its icon, the Run tab's dot on the icon corner", async () => {
            const before = await facts();
            await openTab(h, ctx.aId, { kind: "canvas" });
            await polishNap(SETTLE_MS);
            const r = await h.ev(`(() => {
                const strip = document.querySelector('[role="tablist"][aria-label="Workspace tabs"]');
                const full = [...document.querySelectorAll("[data-workspace-tab-measure]")].reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
                const tabs = [...document.querySelectorAll("[data-workspace-tab]")].map((t) => {
                    const b = t.querySelector('[role="tab"]');
                    return { key: t.dataset.workspaceTab, active: b?.getAttribute("aria-selected") === "true", text: b?.textContent ?? "", label: b?.getAttribute("aria-label") ?? "" };
                });
                const run = document.querySelector('${tabSel(`run:${RUN_ID}`)} [role="tab"]');
                const icon = run?.querySelector("svg")?.getBoundingClientRect();
                const dotEl = run?.querySelector("[data-workspace-tab-waiting]");
                const dot = dotEl?.getBoundingClientRect();
                return {
                    room: strip ? Math.round(strip.clientWidth) : null,
                    full: Math.round(full),
                    tabs,
                    dotPosition: dotEl ? getComputedStyle(dotEl).position : null,
                    // the dot's box overlaps the icon's top-right quarter
                    dotOnIcon: icon != null && dot != null &&
                        dot.left < icon.right && dot.right > icon.left + icon.width / 2 &&
                        dot.top < icon.top + icon.height / 2 && dot.bottom > icon.top,
                };
            })()`);
            await h.shot("cdp-shots/workspace-pane-icon-tabs.png");
            const shownTab = r.tabs.find((t) => t.active);
            const hidden = r.tabs.filter((t) => !t.active);
            const ok =
                r.tabs.length === 4 &&
                r.full > r.room &&
                shownTab?.key === "canvas" &&
                shownTab.text === shownTab.label &&
                shownTab.label !== "" &&
                hidden.every((t) => t.text === "" && t.label !== "") &&
                hidden.some((t) => t.key === `run:${RUN_ID}`) &&
                r.dotPosition === "absolute" &&
                r.dotOnIcon;
            await page(h, `W.closeWorkspaceTab(${A}, "canvas"); W.activateWorkspaceTab(${A}, ${JSON.stringify(before.active)}); return true;`);
            await polishNap(SETTLE_MS);
            return [ok, r];
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
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
        await step("go home", () => h.goto("cockpit"));
    },
};

// --- workspace-pane-canvas ------------------------------------------------------------------------------------------
// The fixture agent's canvas is written under its project and attached in the page, as rendered-bs-mockup does; the
// attached canvas is what draws the Mockup card. Six boards, then canvas.json rewritten to the first two.

const CANVAS_NAME = "workspace-pane-canvas";
const CANVAS_BOARDS = ["Main.dc.html", "States.dc.html", "Empty.dc.html", "Error.dc.html", "Narrow.dc.html", "Wide.dc.html"];
const TWO_BOARDS = CANVAS_BOARDS.slice(0, 2);
const BOARD_W = 1440;
const BOARD_H = 900;
// ModalShell's p-10 around the window
const WINDOW_INSET_PX = 40;
const MARK_HINT = "Click the part of the board that should change";
const ESC = { key: "Escape", code: "Escape", keyCode: 27 };
const NEXT = { key: "]", code: "BracketRight", keyCode: 221 };
const CANVAS_SHOT = (n, what) => `cdp-shots/${CANVAS_NAME}-${n}-${what}.png`;

const C_TAB = `document.querySelector('aside[aria-label="Workspace"] [data-canvas-tab]')`;
const C_WIN = `document.querySelector("[data-canvas-window]")`;
const C_CARD = `${RBS_KIT.HOST}?.querySelector("[data-rendered-mockup]")`;

const boardLabel = (name) => name.replace(/\.dc\.html$/, "");

const canvasProject = (ctx) => join(ctx.cwd, ".superpowers", "design", ctx.topic, "project");

function writeCanvasJson(ctx, names) {
    writeFileSync(
        join(canvasProject(ctx), "canvas.json"),
        JSON.stringify({ boards: Object.fromEntries(names.map((b) => [b, { w: BOARD_W, h: BOARD_H }])), order: names })
    );
}

const writeCanvasBoard = (ctx, name, body = name) =>
    writeFileSync(
        join(canvasProject(ctx), name),
        `<!doctype html><title>${name}</title><h1 style="font:64px sans-serif;color:#e6e9ed">${body}</h1>`
    );

const canvasStore = (h, ctx, body) =>
    RBS_KIT.agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        const C = await mod("app/view/agents/canvasstore.ts");
        const id = ${JSON.stringify(ctx.agentId)};
        ${body}`
    );

// what the window and the canvas state say: open on whom, the board, All, marking and a drawn mark
const canvasFacts = (h, ctx) =>
    canvasStore(
        h,
        ctx,
        `const c = C.getCanvas(id);
        return { window: globalStore.get(C.canvasWindowAtom), board: c?.board ?? null, all: c?.all ?? null, marking: c?.marking ?? null, mark: c?.mark != null, boards: c?.boards.length ?? 0, reloadKey: c?.reloadKey ?? null };`
    );

// the Canvas tab's previews as drawn, against the list's inner width and the scroller's box
const listFacts = (h) =>
    h.ev(`(() => {
        const tab = ${C_TAB};
        const scroll = tab?.querySelector("[data-canvas-tab-scroll]");
        const cs = scroll ? getComputedStyle(scroll) : null;
        const inner = scroll ? scroll.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : 0;
        const sv = scroll?.getBoundingClientRect();
        const probe = document.createElement("span");
        probe.style.color = "var(--color-accent)";
        document.body.appendChild(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const previews = [...(tab?.querySelectorAll("[data-canvas-tab-preview]") ?? [])].map((el) => {
            const r = el.getBoundingClientRect();
            return {
                name: el.getAttribute("data-canvas-tab-preview"),
                left: Math.round(r.left),
                top: Math.round(r.top),
                bottom: Math.round(r.bottom),
                width: Math.round(r.width),
                selected: el.hasAttribute("data-selected"),
                accent: getComputedStyle(el).borderTopColor === accent,
                inView: sv != null && r.top >= sv.top - 1 && r.bottom <= sv.bottom + 1,
                iframe: el.querySelector("iframe") != null,
                pill: Number(getComputedStyle(el.querySelector("[data-canvas-tab-open]")).opacity),
            };
        });
        return { inner: Math.round(inner), previews };
    })()`);

// one column in canvas order, each preview at the list's width
const stackedAt = (list, names) =>
    JSON.stringify(list.previews.map((p) => p.name)) === JSON.stringify(names) &&
    list.previews.every((p, i) => i === 0 || (p.left === list.previews[0].left && p.top > list.previews[i - 1].bottom)) &&
    list.previews.every((p) => Math.abs(p.width - list.inner) <= 2);

// the window's frames grouped into rows by their top, in canvas order
const windowRows = (h) =>
    h.ev(`(() => {
        const frames = [...(${C_WIN}?.querySelectorAll("[data-canvas-frame]") ?? [])].map((el) => {
            const r = el.getBoundingClientRect();
            return { name: el.getAttribute("data-canvas-frame"), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) };
        });
        const rows = [];
        for (const f of frames) {
            const row = rows.find((r) => Math.abs(r[0].top - f.top) <= 1);
            row ? row.push(f) : rows.push([f]);
        }
        return rows.map((r) => r.map((f) => ({ name: f.name, left: f.left, right: f.right })));
    })()`);

// each row's frames left to right with room between them, the rows in canvas order
const rowsInOrder = (rows, names, perRow) =>
    rows.every((r) => r.every((f, i) => i === 0 || f.left > r[i - 1].right)) &&
    JSON.stringify(rows.map((r) => r.length)) === JSON.stringify(perRow) &&
    JSON.stringify(rows.flat().map((f) => f.name)) === JSON.stringify(names);

// a button inside root whose text (trimmed) is text
const clickByText = (h, root, text) =>
    h.ev(`(() => {
        const b = [...(${root}?.querySelectorAll("button") ?? [])].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
        b?.click();
        return b != null;
    })()`);

async function realClick(h, expr) {
    const at = await centreOf(h, expr);
    if (at == null) return false;
    await mouse(h, "mouseMoved", at.x, at.y);
    await mouse(h, "mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 1 });
    await mouse(h, "mouseReleased", at.x, at.y, { button: "left", buttons: 0, clickCount: 1 });
    return true;
}

async function pressKey(h, { key, code, keyCode }) {
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, text: key.length === 1 ? key : undefined, windowsVirtualKeyCode: keyCode });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    await polishNap(400);
}

// the surface's keys fire only from outside a field: the Rendered view hands focus to its composer
const focusSurfaceWrap = (h) =>
    h.ev(`(() => { document.activeElement?.blur?.(); document.querySelector("[data-cockpit-surface-wrap]")?.focus(); return true; })()`);

const previewSel = (name) => `${C_TAB}?.querySelector('[data-canvas-tab-preview="${name}"]')`;

const canvasBase = RBS_KIT.scenario(CANVAS_NAME, { noBrainstorm: true }, async (h, ctx, step) => {
    mkdirSync(canvasProject(ctx), { recursive: true });
    writeCanvasJson(ctx, CANVAS_BOARDS);
    for (const b of CANVAS_BOARDS) writeCanvasBoard(ctx, b);
    // the width preference, put back by teardown
    ctx.prevWidth = await canvasStore(
        h,
        ctx,
        `return { atom: globalStore.get(W.workspaceWidthAtom), stored: localStorage.getItem(${JSON.stringify(WIDTH_KEY)}) };`
    );
    await canvasStore(
        h,
        ctx,
        `globalStore.set(W.workspaceWidthAtom, ${DEFAULT_PX});
        C.attachCanvas(id, { topic: ${JSON.stringify(ctx.topic)}, dir: ${JSON.stringify(join(ctx.cwd, ".superpowers", "design", ctx.topic))}, projectDir: ${JSON.stringify(ctx.cwd)} }, Date.now());
        return true;`
    );

    await step("the transcript's Mockup card is one row: topic, boards, updated, Open canvas, Mark", async () => {
        const boards = await polishWaitFor(h, `${C_CARD}?.getAttribute("data-rendered-mockup") === "boards"`, RBS_KIT.BS_POLL_WAIT_MS);
        const s = await h.ev(`(() => {
            const card = ${C_CARD};
            const label = (sel) => (card?.querySelector(sel)?.textContent ?? "").trim();
            return {
                text: (card?.innerText ?? "").replace(/\\s+/g, " ").trim(),
                iframes: card?.querySelectorAll("iframe").length ?? -1,
                tabs: card?.querySelectorAll('[role="tab"]').length ?? -1,
                open: label("[data-rendered-mockup-open]"),
                mark: label("[data-rendered-mockup-mark]"),
            };
        })()`);
        await h.shot(CANVAS_SHOT(1, "mockup-row"));
        return [
            boards &&
                s.text.startsWith(`Mockup ${ctx.topic} ${CANVAS_BOARDS.length} boards updated`) &&
                s.text.endsWith("Open canvas Mark") &&
                s.open === "Open canvas" &&
                s.mark === "Mark" &&
                s.iframes === 0 &&
                s.tabs === 0,
            { boards, ...s },
        ];
    });

    await step("the Canvas tab lists every board stacked at the pane's width; the selected board wears the accent border, a hover shows Open in a window", async () => {
        await h.ev(`${C_CARD}?.querySelector("[data-rendered-mockup-open]")?.click()`);
        const loaded = await polishWaitFor(
            h,
            `(${C_TAB}?.querySelectorAll("[data-canvas-tab-preview] iframe").length ?? 0) === ${CANVAS_BOARDS.length}`,
            WAIT_MS
        );
        await polishNap(SETTLE_MS);
        const list = await listFacts(h);
        const paneW = await h.ev(`Math.round(document.querySelector('aside[aria-label="Workspace"]')?.getBoundingClientRect().width ?? 0)`);
        // a real hover over the first preview, which is in view at the top of the list
        const at = await centreOf(h, previewSel(CANVAS_BOARDS[0]));
        if (at != null) await mouse(h, "mouseMoved", at.x, at.y);
        await polishNap(400);
        const hovered = await listFacts(h);
        await h.shot(CANVAS_SHOT(2, "list-hover"));
        const selected = list.previews.filter((p) => p.selected);
        const accented = list.previews.filter((p) => p.accent);
        const pills = hovered.previews.map((p) => p.pill);
        const ok =
            loaded &&
            paneW === DEFAULT_PX &&
            stackedAt(list, CANVAS_BOARDS) &&
            selected.length === 1 &&
            selected[0].name === CANVAS_BOARDS[0] &&
            accented.length === 1 &&
            accented[0].name === CANVAS_BOARDS[0] &&
            pills[0] === 1 &&
            pills.slice(1).every((o) => o === 0);
        return [ok, { loaded, paneW, inner: list.inner, previews: list.previews, pills }];
    });

    // t-5's interactions: a label click only selects, and ] brings the selection into view
    await step("a board's label click only selects it, and ] moves the selection down the list into view", async () => {
        const third = CANVAS_BOARDS[2];
        const clicked = await h.ev(`(() => {
            const b = [...(${C_TAB}?.querySelectorAll("button") ?? [])].find((x) => x.textContent.trim().startsWith(${JSON.stringify(boardLabel(third))}));
            b?.click();
            return b != null;
        })()`);
        await polishNap(SETTLE_MS);
        const afterLabel = await listFacts(h);
        const labelFacts = await canvasFacts(h, ctx);
        await focusSurfaceWrap(h);
        for (let i = 3; i < CANVAS_BOARDS.length; i++) await pressKey(h, NEXT);
        await polishNap(SETTLE_MS);
        const afterKeys = await listFacts(h);
        const keyFacts = await canvasFacts(h, ctx);
        await h.shot(CANVAS_SHOT(3, "list-next"));
        const last = afterKeys.previews.at(-1);
        const ok =
            clicked &&
            afterLabel.previews.filter((p) => p.selected).map((p) => p.name).join() === third &&
            labelFacts.window == null &&
            keyFacts.window == null &&
            last?.selected === true &&
            last.inView &&
            afterKeys.previews.filter((p) => p.selected).length === 1;
        // back to the first board at the top, for the steps after
        await canvasStore(h, ctx, `C.selectCanvasBoard(id, ${JSON.stringify(CANVAS_BOARDS[0])}); return true;`);
        await h.ev(`(() => { const s = ${C_TAB}?.querySelector("[data-canvas-tab-scroll]"); if (s) s.scrollTop = 0; return true; })()`);
        await polishNap(SETTLE_MS);
        return [ok, { clicked, label: labelFacts, keys: keyFacts, last }];
    });

    await step("expanded, the list's boards grow to the pane's width", async () => {
        const before = await listFacts(h);
        await h.ev(`document.querySelector("[data-workspace-expand]")?.click()`);
        await polishNap(SETTLE_MS);
        const expanded = await listFacts(h);
        await h.shot(CANVAS_SHOT(4, "expanded"));
        await h.ev(`document.querySelector("[data-workspace-expand]")?.click()`);
        await polishNap(SETTLE_MS);
        const restored = await listFacts(h);
        const ok =
            stackedAt(expanded, CANVAS_BOARDS) &&
            expanded.previews.every((p, i) => p.width > before.previews[i].width) &&
            restored.previews.every((p, i) => p.width === before.previews[i].width);
        return [ok, { before: before.inner, expanded: expanded.inner, widths: expanded.previews.map((p) => p.width), restored: restored.inner }];
    });

    await step("a click on a board opens the canvas window: board tabs with All in rows of 3, Mark, Open in browser, Build this; a redraw keeps it open; Esc drops a drawn mark, then closes it", async () => {
        const target = CANVAS_BOARDS[1];
        await h.ev(`${previewSel(target)}?.scrollIntoView({ block: "center" })`);
        await polishNap(SETTLE_MS);
        const clicked = await realClick(h, previewSel(target));
        const opened = await polishWaitFor(h, `${C_WIN}?.querySelector("[data-canvas-board] iframe") != null`, WAIT_MS);
        await polishNap(SETTLE_MS);
        const onOpen = await canvasFacts(h, ctx);
        const frame = await h.ev(`(() => {
            const d = ${C_WIN}?.closest('[role="dialog"]')?.getBoundingClientRect();
            const btns = [...(${C_WIN}?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim());
            return {
                inset: d ? [Math.round(d.left), Math.round(d.top), Math.round(innerWidth - d.right), Math.round(innerHeight - d.bottom)] : null,
                tabs: [...(${C_WIN}?.querySelectorAll('[role="tablist"] [role="tab"]') ?? [])].map((t) => t.textContent.trim()),
                selectedTab: ${C_WIN}?.querySelector('[role="tablist"] [aria-selected="true"]')?.textContent.trim() ?? null,
                mark: btns.includes("Mark"),
                browser: btns.includes("Open in browser"),
                build: btns.includes("Build this…"),
                close: ${C_WIN}?.querySelector('button[aria-label="Close"]')?.title ?? null,
            };
        })()`);
        await h.shot(CANVAS_SHOT(5, "window"));
        const allTab = await clickByText(h, `${C_WIN}?.querySelector('[role="tablist"]')`, "All");
        await polishWaitFor(h, `(${C_WIN}?.querySelectorAll("[data-canvas-frame] iframe").length ?? 0) === ${CANVAS_BOARDS.length}`, WAIT_MS);
        await polishNap(SETTLE_MS);
        const rows = await windowRows(h);
        await h.shot(CANVAS_SHOT(6, "window-all"));

        // a redraw: one board file rewritten; the frames remount on the new reloadKey, the window stays
        await h.ev(`(() => { for (const f of ${C_WIN}?.querySelectorAll("iframe") ?? []) f.__beforeRedraw = true; return true; })()`);
        writeCanvasBoard(ctx, CANVAS_BOARDS[2], "Empty, redrawn");
        const reloaded = await polishWaitFor(
            h,
            `(() => { const fs = [...(${C_WIN}?.querySelectorAll("iframe") ?? [])]; return fs.length === ${CANVAS_BOARDS.length} && fs.every((f) => !f.__beforeRedraw); })()`,
            RBS_KIT.BS_POLL_WAIT_MS
        );
        const afterRedraw = await canvasFacts(h, ctx);

        // one board shown, marking on, a box dragged: Esc drops the mark and keeps the window, the next closes it
        await clickByText(h, `${C_WIN}?.querySelector('[role="tablist"]')`, boardLabel(target));
        await polishNap(SETTLE_MS);
        await clickByText(h, C_WIN, "Mark");
        await polishNap(SETTLE_MS);
        await dragMarkBox(h);
        const drawn = await canvasFacts(h, ctx);
        await h.shot(CANVAS_SHOT(7, "window-mark"));
        await pressKey(h, ESC);
        const firstEsc = await canvasFacts(h, ctx);
        const stillOpen = (await h.ev(`${C_WIN} != null`)) === true;
        await pressKey(h, ESC);
        const closed = await polishWaitFor(h, `${C_WIN} == null`, WAIT_MS);
        const secondEsc = await canvasFacts(h, ctx);
        const ok =
            clicked &&
            opened &&
            onOpen.window === ctx.agentId &&
            onOpen.board === target &&
            !onOpen.all &&
            frame.inset != null &&
            frame.inset.every((px) => Math.abs(px - WINDOW_INSET_PX) <= 2) &&
            JSON.stringify(frame.tabs) === JSON.stringify(["All", ...CANVAS_BOARDS.map(boardLabel)]) &&
            frame.selectedTab === boardLabel(target) &&
            frame.mark &&
            frame.browser &&
            frame.build &&
            frame.close === "Close (Esc)" &&
            allTab &&
            rows.length === 2 &&
            rowsInOrder(rows, CANVAS_BOARDS, [3, 3]) &&
            reloaded &&
            afterRedraw.window === ctx.agentId &&
            drawn.mark &&
            !firstEsc.mark &&
            stillOpen &&
            firstEsc.window === ctx.agentId &&
            closed &&
            secondEsc.window == null &&
            !secondEsc.marking;
        return [ok, { clicked, opened, onOpen, frame, rows, reloaded, afterRedraw, drawn, firstEsc, stillOpen, closed, secondEsc }];
    });

    await step("with 2 boards the window's All is one row of 2", async () => {
        await canvasStore(h, ctx, `C.openCanvasWindow(id, { board: ${JSON.stringify(CANVAS_BOARDS[0])} }); return true;`);
        await polishWaitFor(h, `${C_WIN} != null`, WAIT_MS);
        await polishNap(SETTLE_MS);
        await clickByText(h, `${C_WIN}?.querySelector('[role="tablist"]')`, "All");
        writeCanvasJson(ctx, TWO_BOARDS);
        const two = await polishWaitFor(
            h,
            `(${C_WIN}?.querySelectorAll("[data-canvas-frame] iframe").length ?? 0) === ${TWO_BOARDS.length}`,
            RBS_KIT.BS_POLL_WAIT_MS
        );
        await polishNap(SETTLE_MS);
        const rows = await windowRows(h);
        await h.shot(CANVAS_SHOT(8, "window-two"));
        const closeTitle = await h.ev(`${C_WIN}?.querySelector('button[aria-label="Close"]')?.title ?? null`);
        await h.ev(`${C_WIN}?.querySelector('button[aria-label="Close"]')?.click()`);
        const closed = await polishWaitFor(h, `${C_WIN} == null`, WAIT_MS);
        return [two && rows.length === 1 && rowsInOrder(rows, TWO_BOARDS, [2]) && closeTitle === "Close (Esc)" && closed, { two, rows, closed }];
    });

    await step("Mark in the pane opens the window with marking on and the header hint", async () => {
        const clicked = await clickByText(h, C_TAB, "Mark");
        const opened = await polishWaitFor(h, `(${C_WIN}?.textContent ?? "").includes(${JSON.stringify(MARK_HINT)})`, WAIT_MS);
        await polishNap(SETTLE_MS);
        const at = await canvasFacts(h, ctx);
        await h.shot(CANVAS_SHOT(9, "pane-mark"));
        await canvasStore(h, ctx, `C.closeCanvasWindow(); return true;`);
        return [clicked && opened && at.window === ctx.agentId && at.marking && !at.mark, { clicked, opened, ...at }];
    });
});

export const workspacePaneCanvas = {
    ...canvasBase,
    async arrange(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
        return canvasBase.arrange(h);
    },
    async teardown(h, ctx) {
        try {
            if (ctx.agentId) {
                await canvasStore(h, ctx, `C.closeCanvasWindow(); W.closeWorkspaceTab(id, "canvas"); C.detachCanvas(id); return true;`);
            }
            if (ctx.prevWidth != null) {
                await canvasStore(
                    h,
                    ctx,
                    `globalStore.set(W.workspaceWidthAtom, ${JSON.stringify(ctx.prevWidth.atom)});
                    ${restoreLocalStorage(WIDTH_KEY, ctx.prevWidth.stored)};
                    return true;`
                );
            }
        } catch (e) {
            console.error(`${CANVAS_NAME} teardown: close the canvas failed: ${e?.message ?? e}`);
        }
        await canvasBase.teardown(h, ctx);
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
    },
};
