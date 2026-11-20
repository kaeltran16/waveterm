// Scenario `workspace-pane`: the Rendered view's workspace pane shell (Task 2 of
// docs/superpowers/plans/2026-11-17-workspace-pane.md; boards Main, Expanded and Closed). The roster is a fixture of
// two claude agents backed by real tabs with no controller, A and B, each with a short transcript, in the Rendered
// view. No transcript card opens a tab yet (later tasks wire them), so the steps open tabs through the workspace
// store, as those cards will. The width preference, the default view and the rail toggle are saved in arrange and put
// back in teardown; the run tab's ask is injected into the page's ask map and removed with it. A's block names a temp
// repo with one uncommitted long line, for the Changes tab's wrap.
//
// Scenario `workspace-pane-canvas` (end of file): the Canvas tab's board rows and edge states, the canvas window and the transcript's
// one-row Mockup card (docs/superpowers/plans/2026-11-18-workspace-pane-polish.md), on RBS_KIT's fixture agent with a
// canvas and no brainstorm.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    agentPage,
    assistantText,
    closeTabs,
    editCall,
    focusAgent,
    makeTab,
    pinDefaultView,
    restoreRoster,
    setRoster,
    toolResult,
    toolUse,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { dragMarkBox } from "./scenarios-agent.mjs";
import { createProject } from "./scenarios-boards-workspace.mjs";
import { RBS_KIT } from "./scenarios-rendered-brainstorm.mjs";
import { git, polishNap, polishWaitFor, RAIL_VISIBLE_KEY, restoreLocalStorage, VIEW_DEFAULT_KEY } from "./scenarios-shared.mjs";

const NAME = "workspace-pane";
const WIDTH_KEY = "agent.workspace.width";
const BOARD_WIDTH_KEY = "agent.workspace.boardwidth";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const NARROW_VIEWPORT = { ...VIEWPORT, width: 1000 };
// the transcript keeps this much beside a board tab's pane (MIN_TRANSCRIPT_PX); a pane never goes under it either
const TRANSCRIPT_MIN_PX = 360;
const BOARD_PROJECT = "workspace-pane-board-fx";
const BOARD_NAME = "Pane width";
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
                boardWidth: localStorage.getItem(${JSON.stringify(BOARD_WIDTH_KEY)}),
                view: localStorage.getItem(${JSON.stringify(VIEW_DEFAULT_KEY)}),
                rail: localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)}),
            })`);
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            const path = (n, calls = []) =>
                writeTranscript(ctx.dir, `workspace-${n}-${tag}`, [
                    userText(`Summarise the ${n} package.`),
                    ...calls,
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
                // A's own Edit makes the long line, so its Changes tab lists the file
                rosterAgent(
                    a.tabId,
                    a.blockId,
                    `workspace-a-${tag}`,
                    path("stats", editCall("tu-wp-long", join(repo, REPO_FILE), "notes\n", `notes\n${LONG_LINE}\n`, { cwd: repo }))
                ),
                rosterAgent(b.tabId, b.blockId, `workspace-b-${tag}`, path("dedupe")),
            ];
            // a fresh profile: no stored width, the rail closed
            await h.ev(
                `localStorage.removeItem(${JSON.stringify(WIDTH_KEY)}); localStorage.removeItem(${JSON.stringify(BOARD_WIDTH_KEY)}); localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "false")`
            );
            // a real board with no question (so no drawer runs), in a throwaway project: the board tab's fixture
            ctx.project = BOARD_PROJECT;
            mkdirSync(join(ctx.dir, "project"));
            ctx.channelId = (await createProject(h, BOARD_PROJECT, join(ctx.dir, "project"))).oid;
            await h.reload();
            await arrangeRoster(h, ctx);
            const board = await page(
                h,
                `const { RpcApi } = await mod("app/store/wshclientapi.ts");
                const { TabRpcClient } = await mod("app/store/wshrpcutil.ts");
                return await RpcApi.BoardStartCommand(TabRpcClient, {
                    channelid: ${JSON.stringify(ctx.channelId)}, name: ${JSON.stringify(BOARD_NAME)}, about: { kind: "project", ref: "", title: "" },
                });`
            );
            Object.assign(ctx, { boardId: board.id, boardDir: dirname(board.path) });
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

        // the Changes tab wraps: the long line is one diff row of several visual lines, each inside the row's added tint
        // and edge, the line's number on the first of them, and a sideways wheel moving nothing
        await step("the Changes tab's diff wraps a long line, its band, edge and number kept, with no sideways scroll", async () => {
            const ROW = `[...document.querySelectorAll("[data-workspace-changes] [data-diff-line]")].find((r) => r.textContent.includes("word0")) ?? null`;
            const SCROLLER = `document.querySelector("[data-workspace-changes-scroll]")`;
            // the tab opens with every file collapsed: open the file through its header
            const FILE = `document.querySelector('[data-workspace-changes] [data-changes-file="${REPO_FILE}"]')`;
            await polishWaitFor(h, `(${FILE}) != null`, GIT_WAIT_MS);
            await h.ev(`(() => { const f = ${FILE}; if (f?.dataset.changesOpen == null) f?.querySelector("[data-changes-toggle]")?.click(); return true; })()`);
            const shown = await polishWaitFor(h, `(${ROW}) != null`, GIT_WAIT_MS);
            await polishNap(SETTLE_MS);
            const measure = `(() => {
                const row = ${ROW};
                const scroller = ${SCROLLER};
                if (row == null || scroller == null) return null;
                const box = (b) => ({ top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) });
                const no = row.querySelector("[data-diff-no]");
                const code = no?.nextElementSibling;
                const range = document.createRange();
                range.selectNodeContents(code);
                // one visual line per distinct top among the text's fragments
                const lines = [...range.getClientRects()].map(box).filter((b) => b.right > b.left);
                const tops = [...new Set(lines.map((b) => b.top))].sort((a, b) => a - b);
                const rowBox = box(row.getBoundingClientRect());
                const css = getComputedStyle(row);
                return {
                    lines: tops.length,
                    joined: code.textContent.replace(/\\s+/g, " ").trim() === ${JSON.stringify(LONG_LINE)},
                    added: row.classList.contains("diff-line-added"),
                    tinted: css.backgroundColor !== "rgba(0, 0, 0, 0)" && css.backgroundColor !== "transparent",
                    edge: css.boxShadow.includes("inset"),
                    // the row's box, which carries the tint and the edge, holds every visual line
                    spans: lines.every((b) => b.top >= rowBox.top - 1 && b.bottom <= rowBox.bottom + 1 && b.right <= rowBox.right + 1),
                    number: flat(no) === "2" && tops.length > 0 && Math.abs(Math.round(no.getBoundingClientRect().top) - tops[0]) <= 2,
                    sideways: scroller.scrollWidth > scroller.clientWidth,
                    scrollLeft: scroller.scrollLeft,
                    left: rowBox.left,
                };
            })()`;
            const flatDef = `const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();`;
            const r = await h.ev(`(() => { ${flatDef} return ${measure}; })()`);
            await h.shot("cdp-shots/workspace-pane-changes-wrap.png");
            // a real sideways wheel over the row is what shows nothing can scroll sideways
            const at = await centreOf(h, ROW);
            if (at != null) await h.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 600, deltaY: 0 });
            await polishNap(SETTLE_MS);
            const after = await h.ev(`(() => { ${flatDef} return ${measure}; })()`);
            const unmoved = at != null && after != null && after.left === r?.left && after.scrollLeft === 0;
            const ok =
                shown &&
                r != null &&
                r.lines > 1 &&
                r.joined &&
                r.added &&
                r.tinted &&
                r.edge &&
                r.spans &&
                r.number &&
                !r.sideways &&
                unmoved;
            return [ok, { shown, ...r, afterWheel: after && { left: after.left, scrollLeft: after.scrollLeft }, unmoved }];
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

        // a board tab widens the pane to all of the row but the transcript's 360px; its own drag is kept apart from the
        // width the other tabs share. The tabs it adds are closed again, so the last-tab step below still ends the pane
        const BOARD_KEY = `board:${ctx.boardId}`;
        const boardTab = { kind: "board", channelId: ctx.channelId, boardId: ctx.boardId };
        const showTab = async (key) => {
            await page(h, `W.activateWorkspaceTab(${A}, ${JSON.stringify(key)}); return true;`);
            await polishNap(SETTLE_MS);
        };
        const stored = (key) => h.ev(`localStorage.getItem(${JSON.stringify(key)})`);
        const widest = (f) => Math.max(TRANSCRIPT_MIN_PX, f.rowW - TRANSCRIPT_MIN_PX);
        const dragHandle = async (dx) => {
            const at = await centreOf(h, "document.querySelector('[data-workspace-resize]')");
            if (at == null) return false;
            await mouse(h, "mouseMoved", at.x, at.y);
            await mouse(h, "mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 1 });
            for (let i = 1; i <= 6; i++) await mouse(h, "mouseMoved", at.x + (dx * i) / 6, at.y, { button: "left", buttons: 1 });
            await mouse(h, "mouseReleased", at.x + dx, at.y, { button: "left", buttons: 0, clickCount: 1 });
            await polishNap(SETTLE_MS);
            return true;
        };
        const hadChanges = (await facts()).tabs.includes("changes");

        await step("a board tab shown in the open pane widens it to the row less 360px", async () => {
            if (!hadChanges) await openTab(h, ctx.aId, { kind: "changes", selected: null });
            const before = await facts();
            await openTab(h, ctx.aId, boardTab);
            const canvas = await polishWaitFor(h, `document.querySelector('aside[aria-label="Workspace"] [data-board-tab] .excalidraw') != null`, WAIT_MS * 2);
            await polishNap(SETTLE_MS);
            const f = await facts();
            await h.shot("cdp-shots/workspace-pane-board-widest.png");
            const title = await h.ev(`document.querySelector('[data-workspace-resize]')?.title`);
            const ok =
                canvas &&
                f.active === BOARD_KEY &&
                f.pane === "open" &&
                before.paneW === DEFAULT_PX &&
                f.paneW === widest(f) &&
                f.paneW > DEFAULT_PX &&
                title === "Drag to resize · double-click resets to full width";
            return [ok, { canvas, before: before.paneW, paneW: f.paneW, rowW: f.rowW, title }];
        });

        await step("showing the Changes tab returns the pane to the stored width, and back to the board widens it again", async () => {
            await showTab("changes");
            const changes = await facts();
            const title = await h.ev(`document.querySelector('[data-workspace-resize]')?.title`);
            await showTab(BOARD_KEY);
            const board = await facts();
            const ok =
                changes.paneW === DEFAULT_PX &&
                title === "Drag to resize · double-click resets to 600px" &&
                board.paneW === widest(board);
            return [ok, { changes: changes.paneW, title, board: board.paneW }];
        });

        await step("expanded and strip are unchanged with a board shown", async () => {
            await h.ev(`document.querySelector("[data-workspace-expand]").click()`);
            await polishNap(SETTLE_MS);
            const expanded = await facts();
            await h.ev(`document.querySelector("[data-workspace-expand]").click()`);
            await polishNap(SETTLE_MS);
            await h.ev(`document.querySelector("[data-workspace-collapse]").click()`);
            await polishNap(SETTLE_MS);
            const strip = await facts();
            await h.ev(`document.querySelector("[data-workspace-strip]").click()`);
            await polishNap(SETTLE_MS);
            const back = await facts();
            const ok =
                expanded.pane === "expanded" &&
                expanded.paneW === expanded.rowW &&
                strip.pane === "strip" &&
                strip.paneW === STRIP_PX &&
                back.pane === "open" &&
                back.paneW === widest(back);
            return [ok, { expanded: [expanded.pane, expanded.paneW], strip: [strip.pane, strip.paneW], back: [back.pane, back.paneW] }];
        });

        await step("a drag on a board tab writes the board width alone, and holds across a switch away and back", async () => {
            const widthBefore = await stored(WIDTH_KEY);
            const start = await facts();
            // the board is at its widest, so the drag goes right, which narrows the pane
            if (!(await dragHandle(DRAG_PX))) return [false, "no resize handle"];
            const dragged = await facts();
            const boardStored = await stored(BOARD_WIDTH_KEY);
            await showTab("changes");
            const changes = await facts();
            await showTab(BOARD_KEY);
            const back = await facts();
            const want = start.paneW - DRAG_PX;
            const ok =
                dragged.paneW === want &&
                Number(boardStored) === want &&
                (await stored(WIDTH_KEY)) === widthBefore &&
                changes.paneW === DEFAULT_PX &&
                back.paneW === want;
            return [ok, { start: start.paneW, dragged: dragged.paneW, boardStored, widthBefore, changes: changes.paneW, back: back.paneW }];
        });

        await step("double-clicking a board tab's edge returns it to the widest", async () => {
            const at = await centreOf(h, "document.querySelector('[data-workspace-resize]')");
            if (at == null) return [false, "no resize handle"];
            // the drag above left the pane narrower than the widest, so a reset has something to undo
            const before = await facts();
            await mouse(h, "mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 1 });
            await mouse(h, "mouseReleased", at.x, at.y, { button: "left", buttons: 0, clickCount: 1 });
            await mouse(h, "mousePressed", at.x, at.y, { button: "left", buttons: 1, clickCount: 2 });
            await mouse(h, "mouseReleased", at.x, at.y, { button: "left", buttons: 0, clickCount: 2 });
            await polishNap(SETTLE_MS);
            const f = await facts();
            const boardStored = await stored(BOARD_WIDTH_KEY);
            const ok = before.paneW < widest(before) && f.paneW === widest(f) && (boardStored == null || boardStored === "null");
            return [ok, { before: before.paneW, paneW: f.paneW, boardStored }];
        });

        await step("at a 1000px window with the tree hidden the board tab's pane is the row less 360px", async () => {
            await h.cdp("Emulation.setDeviceMetricsOverride", NARROW_VIEWPORT);
            await polishNap(SETTLE_MS);
            // with the tree open the 1000px row is 674px and the pane sits on the 360px floor; hiding it gives the design's ~922px row
            await press(h, KEY.f);
            const f = await facts();
            await h.shot("cdp-shots/workspace-pane-board-narrow.png");
            await press(h, KEY.f);
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            await polishNap(SETTLE_MS);
            return [f.paneW === f.rowW - TRANSCRIPT_MIN_PX && f.paneW > TRANSCRIPT_MIN_PX, { paneW: f.paneW, rowW: f.rowW }];
        });

        await page(
            h,
            `W.closeWorkspaceTab(${A}, ${JSON.stringify(BOARD_KEY)});
            ${hadChanges ? "" : `W.closeWorkspaceTab(${A}, "changes");`}
            return true;`
        );
        await polishNap(SETTLE_MS);

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
                    for (const t of [...ws(id).tabs]) W.closeWorkspaceTab(id, t.kind === "run" ? "run:" + t.runId : t.kind === "file" ? "file:" + t.path : t.kind === "board" ? "board:" + t.boardId : t.kind);
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
                        restoreLocalStorage(BOARD_WIDTH_KEY, ctx.prev.boardWidth),
                        restoreLocalStorage(VIEW_DEFAULT_KEY, ctx.prev.view),
                        restoreLocalStorage(RAIL_VISIBLE_KEY, ctx.prev.rail),
                    ].join("; ")
                )
            );
            await step("reload onto the restored preferences", () => h.reload());
        }
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        if (ctx.boardDir) await step("remove the board", () => rmSync(ctx.boardDir, { recursive: true, force: true }));
        if (ctx.project) await step("delete the board project", () => h.rpc("deleteproject", { name: ctx.project }));
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
        await step("go home", () => h.goto("cockpit"));
    },
};

// --- workspace-pane-canvas ------------------------------------------------------------------------------------------
// The fixture agent's canvas is written under its project and attached in the page, as rendered-bs-mockup does; the
// attached canvas draws the Mockup card on the transcript's reveal row. Six boards of mixed sizes, one with no title;
// then canvas.json rewritten (one board added, one removed), to the first two, to twelve, to none, and last the
// project folder deleted.

const CANVAS_NAME = "workspace-pane-canvas";
const CANVAS_BOARDS = ["Main.dc.html", "States.dc.html", "Empty.dc.html", "Error.dc.html", "Phone.dc.html", "Long.dc.html"];
const TWO_BOARDS = CANVAS_BOARDS.slice(0, 2);
// enough tabs that the window's head cannot fit them beside its controls, and more rows than the tab's list shows
const MANY_BOARDS = Array.from({ length: 12 }, (_, i) => `Board${String(i + 1).padStart(2, "0")}.dc.html`);
// the rewrite that adds one board and removes another
const ADDED_BOARD = "Added.dc.html";
const REMOVED_BOARD = CANVAS_BOARDS[2];
const REFLOWED_BOARDS = [CANVAS_BOARDS[0], ADDED_BOARD, ...CANVAS_BOARDS.filter((b, i) => i > 0 && b !== REMOVED_BOARD)];
const BOARD_W = 1440;
const BOARD_H = 900;
// canvas.json's entries: a tall phone board and a long page beside the default size, and Error with no title
const BOARD_SPEC = {
    "Main.dc.html": { w: 1280, h: 800, title: "The run graph's Final node, as it is today" },
    "States.dc.html": { w: BOARD_W, h: BOARD_H, title: "All six states side by side: queued, running, passed, failed, skipped and cancelled, each with its own badge" },
    "Empty.dc.html": { w: BOARD_W, h: BOARD_H, title: "No run yet" },
    "Error.dc.html": { w: BOARD_W, h: BOARD_H },
    "Phone.dc.html": { w: 400, h: 800, title: "The node on a phone" },
    "Long.dc.html": { w: 1440, h: 2500, title: "The full run page, scrolled" },
    [ADDED_BOARD]: { w: BOARD_W, h: BOARD_H, title: "A board the agent added" },
};
// the row's preview box (workspacecanvastab.tsx)
const PREVIEW_BOX = { w: 112, h: 70 };
const KEY_M = { key: "m", code: "KeyM", keyCode: 77 };
// ModalShell's p-10 around the window
const WINDOW_INSET_PX = 40;
const MARK_HINT = "Click the part of the board that should change";
const ESC = { key: "Escape", code: "Escape", keyCode: 27 };
const NEXT = { key: "]", code: "BracketRight", keyCode: 221 };
const CANVAS_SHOT = (n, what) => `cdp-shots/${CANVAS_NAME}-${n}-${what}.png`;

const C_TAB = `document.querySelector('aside[aria-label="Workspace"] [data-canvas-tab]')`;
const C_WIN = `document.querySelector("[data-canvas-window]")`;
const C_CARD = `${RBS_KIT.RV}?.querySelector("[data-rendered-mockup]")`;
const CANVAS_TOPIC = `wp-canvas-${Date.now().toString(36)}`;
const CANVAS_TRANSCRIPT = [
    userText("Mock up the six states of the run graph's Final node."),
    toolUse("toolu_wp_canvas_reveal", "Bash", { command: `wsh ui reveal canvas:${CANVAS_TOPIC}`, description: "Show the mockup" }),
    toolResult("toolu_wp_canvas_reveal", ""),
    assistantText("Six boards are up."),
];

const boardLabel = (name) => name.replace(/\.dc\.html$/, "");

const canvasProject = (ctx) => join(ctx.cwd, ".superpowers", "design", ctx.topic, "project");

function writeCanvasJson(ctx, names) {
    writeFileSync(
        join(canvasProject(ctx), "canvas.json"),
        JSON.stringify({ boards: Object.fromEntries(names.map((b) => [b, BOARD_SPEC[b] ?? { w: BOARD_W, h: BOARD_H }])), order: names })
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
        return { canvas: c != null, window: globalStore.get(C.canvasWindowAtom), board: c?.board ?? null, all: c?.all ?? null, marking: c?.marking ?? null, mark: c?.mark != null, boards: c?.boards.length ?? 0, reloadKey: c?.reloadKey ?? null };`
    );

// the poller has listed n boards in the canvas state
async function waitBoardCount(h, ctx, n) {
    const deadline = Date.now() + RBS_KIT.BS_POLL_WAIT_MS;
    while ((await canvasFacts(h, ctx)).boards !== n && Date.now() < deadline) await polishNap(500);
}

// the Canvas tab's head and rows as drawn, colors compared through the theme's tokens
const rowFacts = (h) =>
    h.ev(`(() => {
        const tab = ${C_TAB};
        const scroll = tab?.querySelector("[data-canvas-tab-scroll]");
        const sv = scroll?.getBoundingClientRect();
        const token = (name, prop) => {
            const probe = document.createElement("span");
            probe.style[prop] = "var(--color-" + name + ")";
            document.body.appendChild(probe);
            const v = getComputedStyle(probe)[prop];
            probe.remove();
            return v;
        };
        const t = {
            accent: token("accent", "color"),
            accentSoft: token("accent-soft", "color"),
            accentbg: token("accentbg", "backgroundColor"),
            edgeMid: token("edge-mid", "color"),
            edgeStrong: token("edge-strong", "color"),
            hover: token("surface-hover", "backgroundColor"),
        };
        const head = tab?.firstElementChild;
        const rows = [...(tab?.querySelectorAll("[data-canvas-tab-preview]") ?? [])].map((el) => {
            const r = el.getBoundingClientRect();
            const box = el.querySelector("[data-canvas-tab-box]");
            const b = box?.getBoundingClientRect();
            const f = box?.querySelector("iframe")?.getBoundingClientRect();
            const name = el.querySelector("[data-canvas-tab-name]");
            const title = el.querySelector("[data-canvas-tab-title]");
            const tinted = [...el.children].some((c) => getComputedStyle(c).backgroundColor === t.accentbg);
            return {
                name: el.getAttribute("data-canvas-tab-preview"),
                top: Math.round(r.top),
                bottom: Math.round(r.bottom),
                label: name?.textContent ?? null,
                size: name?.nextElementSibling?.textContent ?? null,
                title: title?.textContent ?? null,
                titleTip: title?.getAttribute("title") ?? null,
                aria: el.getAttribute("aria-label"),
                tip: el.getAttribute("title"),
                selected: el.hasAttribute("data-selected"),
                tinted,
                nameAccent: name != null && getComputedStyle(name).color === t.accentSoft,
                hoverBg: getComputedStyle(el).backgroundColor === t.hover,
                box: b ? { w: Math.round(b.width), h: Math.round(b.height) } : null,
                border: box == null ? null : getComputedStyle(box).borderTopColor === t.accent ? "accent" : getComputedStyle(box).borderTopColor === t.edgeStrong ? "edge-strong" : getComputedStyle(box).borderTopColor === t.edgeMid ? "edge-mid" : getComputedStyle(box).borderTopColor,
                // the whole board drawn inside the box
                fitted: b != null && f != null && f.left >= b.left - 0.5 && f.top >= b.top - 0.5 && f.right <= b.right + 0.5 && f.bottom <= b.bottom + 0.5,
                open: Number(getComputedStyle(el.querySelector("[data-canvas-tab-open]")).opacity),
                inView: sv != null && r.top >= sv.top - 1 && r.bottom <= sv.bottom + 1,
            };
        });
        return {
            head: (head?.innerText ?? "").replace(/\\s+/g, " ").trim(),
            headButtons: [...(head?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim() || b.getAttribute("aria-label")),
            headH: Math.round(head?.getBoundingClientRect().height ?? 0),
            body: (tab?.innerText ?? "").replace(/\\s+/g, " ").trim(),
            scrollTop: scroll?.scrollTop ?? null,
            rows,
        };
    })()`);

const rowNames = (facts) => JSON.stringify(facts.rows.map((r) => r.name));
const sizeOf = (name) => `${BOARD_SPEC[name].w}×${BOARD_SPEC[name].h}`;

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

const canvasBase = RBS_KIT.scenario(CANVAS_NAME, { noBrainstorm: true, topic: CANVAS_TOPIC, transcript: CANVAS_TRANSCRIPT }, async (h, ctx, step) => {
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

    await step("the Canvas tab lists one row per board in canvas order: a same-size preview, name, size and title; the selected row tinted; a hover shows the open icon (Main board)", async () => {
        await h.ev(`${C_CARD}?.querySelector("[data-rendered-mockup-open]")?.click()`);
        const loaded = await polishWaitFor(
            h,
            `(${C_TAB}?.querySelectorAll("[data-canvas-tab-preview] iframe").length ?? 0) === ${CANVAS_BOARDS.length}`,
            WAIT_MS
        );
        await polishNap(SETTLE_MS);
        const list = await rowFacts(h);
        const paneW = await h.ev(`Math.round(document.querySelector('aside[aria-label="Workspace"]')?.getBoundingClientRect().width ?? 0)`);
        // a real hover over a row other than the selected one
        const hoveredName = CANVAS_BOARDS[1];
        const at = await centreOf(h, previewSel(hoveredName));
        if (at != null) await mouse(h, "mouseMoved", at.x, at.y);
        await polishNap(400);
        const hovered = await rowFacts(h);
        await h.shot(CANVAS_SHOT(2, "rows-hover"));
        await mouse(h, "mouseMoved", 0, 0);
        ctx.rowsHeadH = list.headH;
        const rowsOk = list.rows.every((r) => {
            const spec = BOARD_SPEC[r.name];
            const label = boardLabel(r.name);
            const named =
                r.label === label && r.size === sizeOf(r.name) && r.aria === `Open ${label} in a window` && r.tip === r.aria;
            const titled = spec.title != null ? r.title === spec.title && r.titleTip === spec.title : r.title == null;
            return named && titled && r.box?.w === PREVIEW_BOX.w && r.box?.h === PREVIEW_BOX.h && r.fitted;
        });
        const selected = list.rows.filter((r) => r.selected);
        const others = hovered.rows.filter((r) => r.name !== hoveredName);
        const hov = hovered.rows.find((r) => r.name === hoveredName);
        const ok =
            loaded &&
            paneW === DEFAULT_PX &&
            rowNames(list) === JSON.stringify(CANVAS_BOARDS) &&
            list.rows.every((r, i) => i === 0 || r.top >= list.rows[i - 1].bottom) &&
            rowsOk &&
            selected.length === 1 &&
            selected[0].name === CANVAS_BOARDS[0] &&
            selected[0].tinted &&
            selected[0].nameAccent &&
            list.rows.filter((r) => r.tinted || r.nameAccent).length === 1 &&
            list.rows.every((r) => r.border === "edge-mid") &&
            list.head.startsWith(`${CANVAS_BOARDS.length} boards · updated `) &&
            !list.head.includes("%") &&
            hov?.open === 1 &&
            hov.border === "edge-strong" &&
            hov.hoverBg &&
            others.every((r) => r.open === 0 && r.border === "edge-mid");
        return [ok, { loaded, paneW, head: list.head, rows: list.rows, hovered: hov, others }];
    });

    // twelve boards, so the list scrolls: ] picks the row just below the fold
    await step("] moves the tinted selection down a row and scrolls only the list to keep it in view; the window stays closed", async () => {
        writeCanvasJson(ctx, MANY_BOARDS);
        await waitBoardCount(h, ctx, MANY_BOARDS.length);
        await polishWaitFor(h, `(${C_TAB}?.querySelectorAll("[data-canvas-tab-preview]").length ?? 0) === ${MANY_BOARDS.length}`, WAIT_MS);
        await canvasStore(h, ctx, `C.selectCanvasBoard(id, ${JSON.stringify(MANY_BOARDS[0])}); return true;`);
        await h.ev(`(() => { const s = ${C_TAB}?.querySelector("[data-canvas-tab-scroll]"); if (s) s.scrollTop = 0; return true; })()`);
        await polishNap(SETTLE_MS);
        // the last row wholly in view, picked, so ] goes to the first one past the fold
        const top = await rowFacts(h);
        const fold = top.rows.findIndex((r) => !r.inView);
        const from = MANY_BOARDS[fold - 1];
        const to = MANY_BOARDS[fold];
        await canvasStore(h, ctx, `C.selectCanvasBoard(id, ${JSON.stringify(from)}); return true;`);
        await polishNap(SETTLE_MS);
        const before = await rowFacts(h);
        const outer = () =>
            h.ev(`({ pane: ${PANE}?.scrollTop ?? null, body: ${PANE}?.querySelector("[data-canvas-tab]")?.parentElement?.scrollTop ?? null, doc: document.scrollingElement?.scrollTop ?? null })`);
        const outerBefore = await outer();
        await focusSurfaceWrap(h);
        await pressKey(h, NEXT);
        await polishNap(SETTLE_MS);
        const after = await rowFacts(h);
        const outerAfter = await outer();
        const facts = await canvasFacts(h, ctx);
        await h.shot(CANVAS_SHOT(3, "rows-next"));
        const was = before.rows.find((r) => r.selected);
        const now = after.rows.filter((r) => r.selected);
        const ok =
            fold > 0 &&
            was?.name === from &&
            was.inView &&
            now.length === 1 &&
            now[0].name === to &&
            now[0].tinted &&
            after.rows.filter((r) => r.tinted).length === 1 &&
            now[0].inView &&
            after.scrollTop > before.scrollTop &&
            JSON.stringify(outerAfter) === JSON.stringify(outerBefore) &&
            facts.board === to &&
            facts.window == null;
        // back to the six boards, the first selected at the top, for the steps after
        writeCanvasJson(ctx, CANVAS_BOARDS);
        await waitBoardCount(h, ctx, CANVAS_BOARDS.length);
        await canvasStore(h, ctx, `C.selectCanvasBoard(id, ${JSON.stringify(CANVAS_BOARDS[0])}); return true;`);
        await polishWaitFor(h, `(${C_TAB}?.querySelectorAll("[data-canvas-tab-preview] iframe").length ?? 0) === ${CANVAS_BOARDS.length}`, WAIT_MS);
        await h.ev(`(() => { const s = ${C_TAB}?.querySelector("[data-canvas-tab-scroll]"); if (s) s.scrollTop = 0; return true; })()`);
        await polishNap(SETTLE_MS);
        return [ok, { fold, from, to, was, now, scroll: [before.scrollTop, after.scrollTop], outerBefore, outerAfter, facts }];
    });

    await step("a row click opens the canvas window on its board: board tabs with All in rows of 3, Mark, Open in browser, Build this; a redraw keeps it open; Esc drops a drawn mark, then closes it", async () => {
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
        await h.shot(CANVAS_SHOT(4, "window"));
        const allTab = await clickByText(h, `${C_WIN}?.querySelector('[role="tablist"]')`, "All");
        await polishWaitFor(h, `(${C_WIN}?.querySelectorAll("[data-canvas-frame] iframe").length ?? 0) === ${CANVAS_BOARDS.length}`, WAIT_MS);
        await polishNap(SETTLE_MS);
        const rows = await windowRows(h);
        await h.shot(CANVAS_SHOT(5, "window-all"));

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
        await h.shot(CANVAS_SHOT(6, "window-mark"));
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

    await step("canvas.json rewritten with one board added and one removed: the added row enters, the removed one leaves, the list ends in the new order", async () => {
        // sampled every frame from before the rewrite: an animated entrance and exit are caught partway
        await h.ev(`(() => {
            const seen = { addedMin: 1, removedMin: 1, together: false, done: false };
            window.__canvasTabReflow = seen;
            const opacity = (name) => {
                const row = ${C_TAB}?.querySelector('[data-canvas-tab-preview="' + name + '"]');
                return row ? Number(getComputedStyle(row.parentElement).opacity) : null;
            };
            const tick = () => {
                const added = opacity(${JSON.stringify(ADDED_BOARD)});
                const removed = opacity(${JSON.stringify(REMOVED_BOARD)});
                if (added != null) seen.addedMin = Math.min(seen.addedMin, added);
                if (added != null && removed != null) {
                    seen.together = true;
                    seen.removedMin = Math.min(seen.removedMin, removed);
                }
                if (!seen.done) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            return true;
        })()`);
        writeCanvasBoard(ctx, ADDED_BOARD);
        writeCanvasJson(ctx, REFLOWED_BOARDS);
        const settled = await polishWaitFor(
            h,
            `JSON.stringify([...(${C_TAB}?.querySelectorAll("[data-canvas-tab-preview]") ?? [])].map((el) => el.getAttribute("data-canvas-tab-preview"))) === ${JSON.stringify(JSON.stringify(REFLOWED_BOARDS))}`,
            RBS_KIT.BS_POLL_WAIT_MS
        );
        await polishNap(SETTLE_MS);
        const seen = await h.ev(`(() => { const s = window.__canvasTabReflow; s.done = true; delete window.__canvasTabReflow; return s; })()`);
        const list = await rowFacts(h);
        await h.shot(CANVAS_SHOT(7, "rows-reflow"));
        const ok =
            settled &&
            rowNames(list) === JSON.stringify(REFLOWED_BOARDS) &&
            list.rows.every((r, i) => i === 0 || r.top >= list.rows[i - 1].bottom) &&
            seen.addedMin < 1 &&
            seen.together &&
            seen.removedMin < 1;
        return [ok, { settled, seen, rows: list.rows.map((r) => r.name) }];
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

    await step("with 12 boards the window's head stays one row: the tabs scroll under an edge fade, the picked tab in view, Close at the right end", async () => {
        writeCanvasJson(ctx, MANY_BOARDS);
        const last = MANY_BOARDS.at(-1);
        // the poller has to list all twelve before the window can open on the last one
        await waitBoardCount(h, ctx, MANY_BOARDS.length);
        await canvasStore(h, ctx, `C.openCanvasWindow(id, { board: ${JSON.stringify(last)} }); return true;`);
        const drawn = await polishWaitFor(
            h,
            `${C_WIN}?.querySelectorAll('[role="tablist"] [role="tab"]').length === ${MANY_BOARDS.length + 1}`,
            RBS_KIT.BS_POLL_WAIT_MS
        );
        await polishNap(SETTLE_MS);
        const head = await h.ev(`(() => {
            const win = ${C_WIN};
            const head = win?.querySelector("[data-canvas-pane]")?.firstElementChild;
            const scroller = win?.querySelector('[role="tablist"]')?.parentElement;
            const picked = win?.querySelector('[role="tablist"] [aria-selected="true"]');
            if (!head || !scroller || !picked) return null;
            const kids = [...head.children].map((el) => el.getBoundingClientRect());
            const centres = kids.map((r) => r.top + r.height / 2);
            const hs = getComputedStyle(head);
            const sc = scroller.getBoundingClientRect();
            const pk = picked.getBoundingClientRect();
            const close = head.lastElementChild;
            const mask = getComputedStyle(scroller).maskImage || getComputedStyle(scroller).webkitMaskImage;
            return {
                kids: kids.length,
                spread: Math.round(Math.max(...centres) - Math.min(...centres)),
                height: Math.round(head.getBoundingClientRect().height),
                rowMax: Math.round(Math.max(...kids.map((r) => r.height))),
                padBorder: parseFloat(hs.paddingTop) + parseFloat(hs.paddingBottom) + parseFloat(hs.borderBottomWidth),
                scrollWidth: scroller.scrollWidth,
                clientWidth: scroller.clientWidth,
                masked: mask != null && mask !== "none",
                pickedLabel: picked.textContent.trim(),
                pickedInside: pk.left >= sc.left - 1 && pk.right <= sc.right + 1,
                closeIsLast: close?.getAttribute("aria-label") === "Close",
                closeGap: Math.round(head.getBoundingClientRect().right - parseFloat(hs.paddingRight) - close.getBoundingClientRect().right),
            };
        })()`);
        await h.shot(CANVAS_SHOT(9, "window-many"));
        // back as found: the two boards, the window closed
        writeCanvasJson(ctx, TWO_BOARDS);
        await h.ev(`${C_WIN}?.querySelector('button[aria-label="Close"]')?.click()`);
        const closed = await polishWaitFor(h, `${C_WIN} == null`, WAIT_MS);
        await waitBoardCount(h, ctx, TWO_BOARDS.length);
        const ok =
            drawn &&
            head != null &&
            head.spread <= 2 &&
            head.height <= head.rowMax + head.padBorder + 2 &&
            head.scrollWidth > head.clientWidth &&
            head.masked &&
            head.pickedLabel === boardLabel(MANY_BOARDS.at(-1)) &&
            head.pickedInside &&
            head.closeIsLast &&
            Math.abs(head.closeGap) <= 2 &&
            closed;
        return [ok, { drawn, head, closed }];
    });

    await step("Mark in the pane opens the window with marking on and the header hint", async () => {
        const clicked = await clickByText(h, C_TAB, "Mark");
        const opened = await polishWaitFor(h, `(${C_WIN}?.textContent ?? "").includes(${JSON.stringify(MARK_HINT)})`, WAIT_MS);
        await polishNap(SETTLE_MS);
        const at = await canvasFacts(h, ctx);
        await h.shot(CANVAS_SHOT(10, "pane-mark"));
        await canvasStore(h, ctx, `C.closeCanvasWindow(); return true;`);
        return [clicked && opened && at.window === ctx.agentId && at.marking && !at.mark, { clicked, opened, ...at }];
    });

    // the States board's two edge states run last: no boards, then the folder gone, which ends the canvas
    await step("canvas.json listing no boards and no Main board shows No boards yet, a head with no actions, and m and ] stand down (States board, left)", async () => {
        // the control: ] reaches the list while boards are listed, so the keys below are not dead
        await focusSurfaceWrap(h);
        await pressKey(h, NEXT);
        const control = await canvasFacts(h, ctx);
        writeFileSync(join(canvasProject(ctx), "canvas.json"), JSON.stringify({ boards: {} }));
        rmSync(join(canvasProject(ctx), CANVAS_BOARDS[0]), { force: true });
        const shown = await polishWaitFor(h, `(${C_TAB}?.innerText ?? "").includes("No boards yet")`, RBS_KIT.BS_POLL_WAIT_MS);
        await polishNap(SETTLE_MS);
        const list = await rowFacts(h);
        await h.shot(CANVAS_SHOT(11, "no-boards"));
        await focusSurfaceWrap(h);
        await pressKey(h, KEY_M);
        await pressKey(h, NEXT);
        await polishNap(SETTLE_MS);
        const after = await canvasFacts(h, ctx);
        const ok =
            control.board === TWO_BOARDS[1] &&
            shown &&
            list.body.includes("No boards yet canvas.json lists no boards. They show here as the agent writes them.") &&
            list.head.startsWith("No boards") &&
            list.headButtons.length === 0 &&
            list.headH === ctx.rowsHeadH &&
            list.rows.length === 0 &&
            after.boards === 0 &&
            after.window == null &&
            after.board === control.board;
        return [ok, { control, shown, head: list.head, headButtons: list.headButtons, headH: [list.headH, ctx.rowsHeadH], after }];
    });

    await step("the canvas's folder deleted shows it removed with Close the tab and an empty head; Close the tab detaches the canvas and closes the tab (States board, right)", async () => {
        rmSync(canvasProject(ctx), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        const shown = await polishWaitFor(h, `(${C_TAB}?.innerText ?? "").includes("was removed")`, RBS_KIT.BS_POLL_WAIT_MS);
        await polishNap(SETTLE_MS);
        const list = await rowFacts(h);
        await h.shot(CANVAS_SHOT(12, "removed"));
        const closeBtn = await h.ev(`[...(${C_TAB}?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim())`);
        const clicked = await clickByText(h, C_TAB, "Close the tab");
        const closed = await polishWaitFor(h, `${C_TAB} == null && document.querySelector('${tabSel("canvas")}') == null`, WAIT_MS);
        const after = await canvasFacts(h, ctx);
        const ok =
            shown &&
            list.body.includes(`${ctx.topic} was removed`) &&
            !list.body.includes("swap control") &&
            JSON.stringify(closeBtn) === JSON.stringify(["Close the tab"]) &&
            list.head === "" &&
            list.headButtons.length === 0 &&
            list.headH === ctx.rowsHeadH &&
            clicked &&
            closed &&
            !after.canvas;
        return [ok, { shown, body: list.body, head: list.head, headH: [list.headH, ctx.rowsHeadH], closeBtn, clicked, closed, after }];
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
