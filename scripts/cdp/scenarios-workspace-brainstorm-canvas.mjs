// Scenario `workspace-brainstorm-canvas`: the workspace pane's Brainstorm and Canvas tabs (Task 8 of
// docs/superpowers/plans/2026-11-17-workspace-pane.md; the Brainstorm and Canvas boards). One fixture claude agent in
// the Rendered view (scenarios-rendered-brainstorm.mjs's kit arranges it), first with a brainstorm whose file the steps
// rewrite, then with only a canvas. In Rendered the cards' open links open a tab beside the transcript; in Terminal the
// tree's chips still take over the center. The viewport and the agent's tabs are put back in teardown.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const CANVAS_IN_TAB = `${ASIDE}?.querySelector("[data-canvas-pane]")`;
const CENTER = `document.querySelector("[data-agent-center]")`;
const MOCKUP = `${HOST}?.querySelector("[data-rendered-mockup]")`;
const KEY = {
    b: { key: "b", code: "KeyB", keyCode: 66, text: "b" },
    d: { key: "d", code: "KeyD", keyCode: 68, text: "d" },
    Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
};

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

    await step("d picks the question's fourth answer in the tab rather than collapsing the pane, and Enter answers it; the asking dot goes", async () => {
        await recordSends(h);
        await focusSurface(h);
        await press(h, KEY.d);
        const focused = await polishWaitFor(h, `document.activeElement === ${BS_IN_TAB}?.querySelector('[data-brainstorm-option="3"]')`, WAIT_MS);
        const stillOpen = (await readPane(h)).shape === "open";
        await press(h, KEY.Enter);
        const line = await waitSent(h, 0, WAIT_MS);
        const gone = await polishWaitFor(h, `!${TAB("brainstorm")}?.querySelector("[data-workspace-tab-waiting]")`, WAIT_MS);
        await h.shot(SHOT(2, "answered"));
        return [
            focused && stillOpen && line != null && line.includes(FOURTH.label) && gone,
            { focused, stillOpen, line, gone },
        ];
    });

    await step("b closes the Brainstorm tab, the pane going with it, and b opens it again", async () => {
        // the agent took the answer and asks nothing, so b is the brainstorm's own key again
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

    await step("the canvas card's open link opens the Canvas tab with its boards and Mark, beside the transcript (Canvas board)", async () => {
        // the agent's brainstorm ends, so its canvas is the one shown
        await store(
            h,
            ctx,
            `W.closeWorkspaceTab(id, "brainstorm");
            window.__cockpitRosterFixture?.patch(id, { brainstormFile: undefined });
            S.detachBrainstorm(id);
            return true;`
        );
        const topic = `${ctx.topic}-canvas`;
        const dir = writeCanvas(ctx, topic);
        await store(
            h,
            ctx,
            `C.attachCanvas(id, { topic: ${JSON.stringify(topic)}, dir: ${JSON.stringify(dir)}, projectDir: ${JSON.stringify(ctx.cwd)} }, Date.now());
            return true;`
        );
        const card = await polishWaitFor(h, `${MOCKUP}?.getAttribute("data-rendered-mockup") === "boards"`, RBS_KIT.BS_POLL_WAIT_MS);
        const clicked = await h.ev(`(() => { const b = ${MOCKUP}?.querySelector("[data-rendered-mockup-open]"); b?.click(); return b != null; })()`);
        const board = await polishWaitFor(h, `${CANVAS_IN_TAB}?.querySelector("[data-canvas-board] iframe") != null`, WAIT_MS);
        const mark = await h.ev(`[...(${CANVAS_IN_TAB}?.querySelectorAll("button") ?? [])].some((b) => b.textContent.trim() === "Mark")`);
        await polishNap(SETTLE_MS);
        const p = await readPane(h);
        await h.shot(SHOT(4, "canvas-tab"));
        return [
            card && clicked && board && mark && p.active === "canvas" && (p.label ?? "").startsWith("Canvas") && p.transcript && p.sideways === 0 && p.width === PANE_PX,
            { card, clicked, board, mark, ...p },
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
