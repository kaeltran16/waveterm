// Scenario `workspace-brainstorm-canvas`: the workspace pane's Brainstorm and Canvas tabs (Task 8 of
// docs/superpowers/plans/2026-11-17-workspace-pane.md; the Brainstorm and Canvas boards). One fixture claude agent in
// the Rendered view (scenarios-rendered-brainstorm.mjs's kit arranges it), first with a brainstorm whose file the steps
// rewrite, then with only a canvas. In Rendered the cards' open links open a tab beside the transcript; in Terminal the
// tree's chips still take over the center. The viewport and the agent's tabs are put back in teardown.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assistantText, toolResult, toolUse } from "./agent-page-fixtures.mjs";
import { RBS_KIT } from "./scenarios-rendered-brainstorm.mjs";
import { BS_HISTORY, BS_Q4, bsFile, bsParts } from "./scenarios-shared.mjs";

const NAME = "workspace-brainstorm-canvas";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const PANE_PX = 600;
const { scenario, agentPage, polishWaitFor, polishNap, writeFile, waitCard, recordSends, waitSent, HOST, RV, WAIT_MS } =
    RBS_KIT;
// longer than a tab's entrance and the pane's reveal
const SETTLE_MS = 700;
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;

const WORKING = bsFile({
    working: "Writing “When it pages” from your answer.",
    parts: bsParts({ intent: "yours", goals: "yours", anti: "yours", constraints: "guess", thresholds: "asked" }),
    history: BS_HISTORY,
});
const FOURTH = { label: "When an analyst reports stale enrichment", detail: "The people who notice decide, at the cost of noticing late." };
const ASKING = { ...WORKING, working: null, question: { ...BS_Q4, options: [...BS_Q4.options, FOURTH] } };
const CANVAS_BOARDS = ["Main.dc.html", "States.dc.html"];

const ASIDE = `document.querySelector('aside[aria-label="Workspace"]')`;
const TAB = (key) => `${ASIDE}?.querySelector('[data-workspace-tab="${key}"]')`;
const BS_IN_TAB = `${ASIDE}?.querySelector("[data-brainstorm-pane]")`;
const CANVAS_IN_TAB = `${ASIDE}?.querySelector("[data-canvas-tab]")`;
const CENTER = `document.querySelector("[data-agent-center]")`;
const MOCKUP = `${RV}?.querySelector("[data-rendered-mockup]")`;
const KEY = {
    b: { key: "b", code: "KeyB", keyCode: 66, text: "b" },
    m: { key: "m", code: "KeyM", keyCode: 77, text: "m" },
    next: { key: "]", code: "BracketRight", keyCode: 221, text: "]" },
    four: { key: "4", code: "Digit4", keyCode: 52, text: "4" },
    Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
};
const C_WIN = `document.querySelector("[data-canvas-window]")`;
// the picked board's frame: in marking, the mark layer over its iframe
const WIN_BOARD = `${C_WIN}?.querySelector("[data-canvas-board]")`;
const CENTER_BOARD = `${CENTER}?.querySelector("[data-canvas-pane] [data-canvas-board]")`;

// a real key press; CDP takes Enter's text as a carriage return
async function press(h, { key, code, keyCode, text }) {
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, text, windowsVirtualKeyCode: keyCode });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
}

// keys reach the surface's bindings only from outside a field: the Rendered view hands focus to its composer
const focusSurface = (h) =>
    h.ev(`(() => {
        document.activeElement?.blur?.();
        document.querySelector("[data-cockpit-surface-wrap]")?.focus();
        return true;
    })()`);

// what the pane draws: its tabs, which is active, the asking dot, and whether anything in it scrolls sideways
const readPane = (h) =>
    h.ev(`(() => {
        const aside = ${ASIDE};
        const sideways = aside == null ? [] : [aside, ...aside.querySelectorAll("*")].filter((el) => {
            const ox = getComputedStyle(el).overflowX;
            return (ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1;
        });
        return {
            shape: aside?.getAttribute("data-workspace-pane") ?? null,
            width: aside ? Math.round(aside.getBoundingClientRect().width) : null,
            tabs: [...(aside?.querySelectorAll("[data-workspace-tab]") ?? [])].map((t) => t.getAttribute("data-workspace-tab")),
            active: aside?.querySelector('[role="tab"][aria-selected="true"]')?.closest("[data-workspace-tab]")?.getAttribute("data-workspace-tab") ?? null,
            label: aside?.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
            asking: !!${TAB("brainstorm")}?.querySelector("[data-workspace-tab-waiting]"),
            sideways: sideways.length,
            transcript: ${RV} != null,
            brainstorm: ${BS_IN_TAB} != null,
            canvas: ${CANVAS_IN_TAB} != null,
        };
    })()`);

const store = (h, ctx, body) =>
    agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        const S = await mod("app/view/agents/brainstormstore.ts");
        const C = await mod("app/view/agents/canvasstore.ts");
        const id = ${JSON.stringify(ctx.agentId)};
        ${body}`
    );

// the header's Terminal | Rendered toggle, to the view asked for
async function setView(h, rendered) {
    await h.ev(`(() => {
        const b = document.querySelector("[data-cockpit-surface-wrap] button[data-view-toggle]");
        if (b && (b.getAttribute("aria-pressed") === "true") !== ${rendered}) b.click();
        return true;
    })()`);
    return polishWaitFor(h, rendered ? `${RV} != null` : `${RV} == null`, WAIT_MS);
}

// a real mouse click at an element's center, the kind that moves focus into a board's iframe
async function mouseClick(h, el) {
    const at = await h.ev(`(() => {
        const r = (${el})?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    })()`);
    if (at == null) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
        await h.cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    }
    return true;
}

// where the keys go: a key pressed while the page lacks focus never arrives, so a step reads this before pressing
const focusFacts = (h, frame) =>
    h.ev(`(() => ({
        page: document.hasFocus(),
        board: document.activeElement != null && document.activeElement === (${frame})?.querySelector("iframe"),
        active: document.activeElement?.tagName ?? null,
    }))()`);

// the board's page has loaded (BoardIframe fades in on load), so its key relay is listening
const boardLoaded = (h, frame) =>
    polishWaitFor(h, `(() => { const f = (${frame})?.querySelector("iframe"); return f != null && getComputedStyle(f).opacity === "1"; })()`, WAIT_MS);

const canvasFacts = (h, ctx) =>
    store(
        h,
        ctx,
        `const M = await mod("app/view/agents/canvaswindowmodel.ts");
        const c = C.getCanvas(id);
        return { window: globalStore.get(C.canvasWindowAtom), board: c?.board ?? null, all: c?.all ?? null, marking: c?.marking ?? null, mark: c?.mark != null, escape: c ? M.canvasEscape(c) : null };`
    );

// the canvas state once ok(it) holds, or at WAIT_MS as it is then
async function waitFacts(h, ctx, ok) {
    const deadline = Date.now() + WAIT_MS;
    let f = await canvasFacts(h, ctx);
    while (!ok(f) && Date.now() < deadline) {
        await polishNap(100);
        f = await canvasFacts(h, ctx);
    }
    return f;
}

// the tree row's brainstorm or canvas chip
const clickChip = (h, label) =>
    h.ev(`(() => {
        const chip = [...document.querySelectorAll("[data-cockpit-surface-wrap] button[aria-pressed]")].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
        chip?.click();
        return chip != null;
    })()`);

function writeCanvas(ctx, topic) {
    const project = join(ctx.cwd, ".superpowers", "design", topic, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(
        join(project, "canvas.json"),
        JSON.stringify({ boards: Object.fromEntries(CANVAS_BOARDS.map((b) => [b, { w: 1440, h: 900 }])), order: CANVAS_BOARDS })
    );
    for (const b of CANVAS_BOARDS) {
        writeFileSync(join(project, b), `<!doctype html><title>${b}</title><h1 style="font:64px sans-serif;color:#e6e9ed">${b}</h1>`);
    }
    return join(ctx.cwd, ".superpowers", "design", topic);
}

const base = scenario(NAME, { file: WORKING }, async (h, ctx, step) => {
    await store(h, ctx, `globalStore.set(W.workspaceWidthAtom, ${PANE_PX}); return true;`);

    await step("the brainstorm card's Open brainstorm opens the Brainstorm tab beside the transcript, its dot on while it asks (Brainstorm board)", async () => {
        const before = await readPane(h);
        writeFile(ctx, ASKING);
        const card = await waitCard(h, "question");
        const clicked = await h.ev(`(() => { const b = ${HOST}?.querySelector("[data-rendered-bs-open]"); b?.click(); return b != null; })()`);
        const opened = await polishWaitFor(h, `${BS_IN_TAB}?.querySelector('[data-brainstorm-option="3"]') != null`, WAIT_MS);
        const dot = await polishWaitFor(h, `!!${TAB("brainstorm")}?.querySelector("[data-workspace-tab-waiting]")`, WAIT_MS);
        await polishNap(SETTLE_MS);
        const p = await readPane(h);
        await h.shot(SHOT(1, "brainstorm-tab"));
        return [
            before.shape == null &&
                card &&
                clicked &&
                opened &&
                dot &&
                p.shape === "open" &&
                p.width === PANE_PX &&
                p.active === "brainstorm" &&
                (p.label ?? "").startsWith("Brainstorm") &&
                p.transcript &&
                p.sideways === 0,
            { before: before.shape, card, clicked, opened, dot, ...p },
        ];
    });

    await step("4 focuses the fourth answer and Enter answers it, the pane stays open; the asking dot goes", async () => {
        await recordSends(h);
        await focusSurface(h);
        await press(h, KEY.four);
        const focused = await polishWaitFor(h, `document.activeElement === ${BS_IN_TAB}?.querySelector('[data-brainstorm-option="3"]')`, WAIT_MS);
        const stillOpen = (await readPane(h)).shape === "open";
        await press(h, KEY.Enter);
        const line = await waitSent(h, 0, WAIT_MS);
        const gone = await polishWaitFor(h, `!${TAB("brainstorm")}?.querySelector("[data-workspace-tab-waiting]")`, WAIT_MS);
        const openAfter = (await readPane(h)).shape === "open";
        await h.shot(SHOT(2, "answered"));
        return [
            focused && stillOpen && line != null && line.includes(FOURTH.label) && gone && openAfter,
            { focused, stillOpen, line, gone, openAfter },
        ];
    });

    await step("b closes the Brainstorm tab, the pane going with it, and b opens it again", async () => {
        // the agent took the answer and asks nothing
        writeFile(ctx, WORKING);
        await waitCard(h, "none");
        await focusSurface(h);
        await press(h, KEY.b);
        const closed = await polishWaitFor(h, `${ASIDE} == null && ${RV} != null`, WAIT_MS);
        await focusSurface(h);
        await press(h, KEY.b);
        const reopened = await polishWaitFor(h, `${BS_IN_TAB} != null`, WAIT_MS);
        const p = await readPane(h);
        return [closed && reopened && p.active === "brainstorm" && p.transcript, { closed, reopened, ...p }];
    });

    await step("in Terminal the tree's brainstorm chip takes over the center as before, and the tab is still there back in Rendered", async () => {
        const terminal = await setView(h, false);
        // the pane leaves through its exit animation
        const noPane = await polishWaitFor(h, `${ASIDE} == null`, WAIT_MS);
        const clicked = await clickChip(h, "brainstorm");
        const center = await polishWaitFor(h, `${CENTER}?.querySelector("[data-brainstorm-pane]") != null`, WAIT_MS);
        await h.shot(SHOT(3, "terminal-brainstorm"));
        await clickChip(h, "brainstorm");
        const left = await polishWaitFor(h, `${CENTER}?.querySelector("[data-brainstorm-pane]") == null`, WAIT_MS);
        const rendered = await setView(h, true);
        const kept = await polishWaitFor(h, `${BS_IN_TAB} != null`, WAIT_MS);
        return [terminal && noPane && clicked && center && left && rendered && kept, { terminal, noPane, clicked, center, left, rendered, kept }];
    });

    await step("the brainstorm detaching takes its tab with it, the pane going too, rather than leaving an empty tab", async () => {
        // the agent's brainstorm ends, so its canvas is the one shown next
        await store(
            h,
            ctx,
            `window.__cockpitRosterFixture?.patch(id, { brainstormFile: undefined });
            S.detachBrainstorm(id);
            return true;`
        );
        const gone = await polishWaitFor(h, `${ASIDE} == null && ${RV} != null`, WAIT_MS);
        const p = await readPane(h);
        return [gone && !p.tabs.includes("brainstorm"), { gone, ...p }];
    });

    await step("the canvas card's open link opens the Canvas tab listing every board stacked at the pane's width, with Mark, beside the transcript (Canvas board)", async () => {
        const topic = `${ctx.topic}-canvas`;
        const dir = writeCanvas(ctx, topic);
        // the card draws on the agent's reveal of the canvas
        const reveal = [
            toolUse("toolu_wbc_canvas_reveal", "Bash", { command: `wsh ui reveal canvas:${topic}`, description: "Show the mockup" }),
            toolResult("toolu_wbc_canvas_reveal", ""),
            assistantText("The canvas has two boards."),
        ];
        appendFileSync(ctx.transcript, reveal.join("\n") + "\n");
        await store(
            h,
            ctx,
            `C.attachCanvas(id, { topic: ${JSON.stringify(topic)}, dir: ${JSON.stringify(dir)}, projectDir: ${JSON.stringify(ctx.cwd)} }, Date.now());
            return true;`
        );
        const card = await polishWaitFor(h, `${MOCKUP}?.getAttribute("data-rendered-mockup") === "boards"`, RBS_KIT.BS_POLL_WAIT_MS);
        const clicked = await h.ev(`(() => { const b = ${MOCKUP}?.querySelector("[data-rendered-mockup-open]"); b?.click(); return b != null; })()`);
        const loaded = await polishWaitFor(
            h,
            `(${CANVAS_IN_TAB}?.querySelectorAll("[data-canvas-tab-preview] iframe").length ?? 0) === ${CANVAS_BOARDS.length}`,
            WAIT_MS
        );
        const mark = await h.ev(`[...(${CANVAS_IN_TAB}?.querySelectorAll("button") ?? [])].some((b) => b.textContent.trim() === "Mark")`);
        await polishNap(SETTLE_MS);
        // the previews in canvas order, one per row at the list's width, none of CanvasPane's board frames
        const list = await h.ev(`(() => {
            const tab = ${CANVAS_IN_TAB};
            const scroll = tab?.querySelector("[data-canvas-tab-scroll]");
            const inner = scroll ? scroll.clientWidth - parseFloat(getComputedStyle(scroll).paddingLeft) - parseFloat(getComputedStyle(scroll).paddingRight) : 0;
            const previews = [...(tab?.querySelectorAll("[data-canvas-tab-preview]") ?? [])].map((el) => {
                const r = el.getBoundingClientRect();
                return { name: el.getAttribute("data-canvas-tab-preview"), left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) };
            });
            return { inner: Math.round(inner), previews, paneFrames: tab?.querySelectorAll("[data-canvas-board], [data-canvas-frame]").length ?? -1 };
        })()`);
        const pv = list.previews;
        const stacked =
            JSON.stringify(pv.map((x) => x.name)) === JSON.stringify(CANVAS_BOARDS) &&
            pv.every((x, i) => i === 0 || (x.left === pv[0].left && x.top > pv[i - 1].bottom)) &&
            pv.every((x) => Math.abs(x.width - list.inner) <= 2) &&
            list.paneFrames === 0;
        const p = await readPane(h);
        await h.shot(SHOT(4, "canvas-tab"));
        return [
            card && clicked && loaded && stacked && mark && p.active === "canvas" && (p.label ?? "").startsWith("Canvas") && p.transcript && p.sideways === 0 && p.width === PANE_PX,
            { card, clicked, loaded, stacked, list, mark, ...p },
        ];
    });

    await step("in Terminal the tree's canvas chip takes over the center as before", async () => {
        const terminal = await setView(h, false);
        const clicked = await clickChip(h, "canvas");
        const center = await polishWaitFor(h, `${CENTER}?.querySelector("[data-canvas-pane]") != null && ${ASIDE} == null`, WAIT_MS);
        await h.shot(SHOT(5, "terminal-canvas"));
        await clickChip(h, "canvas");
        const left = await polishWaitFor(h, `${CENTER}?.querySelector("[data-canvas-pane]") == null`, WAIT_MS);
        const rendered = await setView(h, true);
        const kept = await polishWaitFor(h, `${CANVAS_IN_TAB} != null`, WAIT_MS);
        return [terminal && clicked && center && left && rendered && kept, { terminal, clicked, center, left, rendered, kept }];
    });

    await step("after a click on its board the canvas window still closes on Esc, and in marking Esc still does what it does with no click", async () => {
        const row = `${CANVAS_IN_TAB}?.querySelector('[data-canvas-tab-preview="${CANVAS_BOARDS[0]}"]')`;
        const openWindow = async () => {
            const clicked = await h.ev(`(() => { const r = ${row}; r?.click(); return r != null; })()`);
            const shown = await polishWaitFor(h, `${WIN_BOARD} != null`, WAIT_MS);
            return clicked && shown && (await boardLoaded(h, WIN_BOARD));
        };
        // the board takes the click and the focus, so the host's window sees no keydown but the relayed one
        const opened = await openWindow();
        const onBoard = await mouseClick(h, WIN_BOARD);
        const focus = await focusFacts(h, WIN_BOARD);
        await h.shot(SHOT(6, "window-board-focused"));
        if (focus.page && focus.board) await press(h, KEY.Escape);
        const closed = await polishWaitFor(h, `${C_WIN} == null`, WAIT_MS);

        // marking: the mark layer is over the board, so the click draws nothing and Esc does what canvasEscape says
        const reopened = await openWindow();
        await press(h, KEY.m);
        const marking = (await waitFacts(h, ctx, (f) => f.marking)).marking;
        const onLayer = await mouseClick(h, WIN_BOARD);
        const before = await canvasFacts(h, ctx);
        const markFocus = await focusFacts(h, WIN_BOARD);
        if (markFocus.page) await press(h, KEY.Escape);
        const acted =
            before.escape === "close"
                ? await polishWaitFor(h, `${C_WIN} == null`, WAIT_MS)
                : await polishWaitFor(h, `${C_WIN} != null && ${WIN_BOARD}?.querySelector("[data-canvas-mark]") == null`, WAIT_MS);
        if (!acted) await store(h, ctx, `C.closeCanvasWindow(); return true;`);
        return [
            opened && onBoard && focus.page && focus.board && closed && reopened && marking && onLayer && markFocus.page && acted,
            { opened, onBoard, focus, closed, reopened, marking, onLayer, before, markFocus, acted },
        ];
    });

    await step("in Terminal, after a click on the canvas center's board, ] still steps to the next board", async () => {
        const terminal = await setView(h, false);
        const chip = await clickChip(h, "canvas");
        const center = await polishWaitFor(h, `${CENTER_BOARD} != null`, WAIT_MS);
        const loaded = center && (await boardLoaded(h, CENTER_BOARD));
        const onBoard = await mouseClick(h, CENTER_BOARD);
        const focus = await focusFacts(h, CENTER_BOARD);
        const before = await canvasFacts(h, ctx);
        if (focus.page && focus.board) await press(h, KEY.next);
        const after = await waitFacts(h, ctx, (f) => f.board !== before.board || f.all !== before.all);
        const stepped = after.board !== before.board || after.all !== before.all;
        await h.shot(SHOT(7, "terminal-center-key"));
        await clickChip(h, "canvas");
        const left = await polishWaitFor(h, `${CENTER}?.querySelector("[data-canvas-pane]") == null`, WAIT_MS);
        const rendered = await setView(h, true);
        return [
            terminal && chip && loaded && onBoard && focus.page && focus.board && stepped && left && rendered,
            { terminal, chip, loaded, onBoard, focus, before, after, left, rendered },
        ];
    });
});

export const workspaceBrainstormCanvas = {
    ...base,
    async arrange(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
        return base.arrange(h);
    },
    async teardown(h, ctx) {
        try {
            if (ctx.agentId) {
                await store(h, ctx, `for (const key of ["brainstorm", "canvas"]) W.closeWorkspaceTab(id, key); C.detachCanvas(id); return true;`);
            }
        } catch (e) {
            console.error(`${NAME} teardown: close the tabs failed: ${e?.message ?? e}`);
        }
        await base.teardown(h, ctx);
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
    },
};
