// Scenario rendered-bs-mockup: the standalone Mockup card (CanvasEdge) for an agent with a canvas and no brainstorm,
// and the live-board block it draws. kit is scenarios-rendered-brainstorm.mjs's RBS_KIT.
//
// The fixture agent has no brainstorm, so the canvas is attached in the page as a reveal would; the canvas folder is
// the agent's side, written and deleted from here, and the poller draws what it finds.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dragMarkBox } from "./scenarios-agent.mjs";

const SHOT = (n, what) => `cdp-shots/rendered-bs-mockup-${n}-${what}.png`;
const BOARDS = ["Main.dc.html", "States.dc.html"];
const TITLES = { "Main.dc.html": "Run graph: Final queued behind another run", "States.dc.html": "The queued states" };
// a board's Last-Modified has whole seconds, so a rewrite meant to read as newer than a look waits past one
const PAST_A_SECOND_MS = 1200;
const MARK_NOTE = "make the chip wider";

export default (kit) => {
    const { scenario, agentPage, polishWaitFor, polishNap, HOST, RV, WAIT_MS, BS_POLL_WAIT_MS } = kit;
    const CARD = `${HOST}?.querySelector("[data-rendered-mockup]")`;
    const kindIs = (kind) => `${CARD}?.getAttribute("data-rendered-mockup") === ${JSON.stringify(kind)}`;
    const TAB = (b) => `${HOST}?.querySelector('[data-live-board-tab="${b}"]')`;
    const FRAME = `${HOST}?.querySelector("[data-live-board] iframe")`;

    const canvasDir = (ctx) => join(ctx.cwd, ".superpowers", "design", ctx.topic);
    const projectDir = (ctx) => join(canvasDir(ctx), "project");
    const writeCanvasJson = (ctx) =>
        writeFileSync(
            join(projectDir(ctx), "canvas.json"),
            JSON.stringify({
                boards: Object.fromEntries(BOARDS.map((b) => [b, { w: 1440, h: 900, title: TITLES[b] }])),
                order: BOARDS,
            })
        );
    const writeBoard = (ctx, name, body) =>
        writeFileSync(
            join(projectDir(ctx), name),
            `<!doctype html><title>${name}</title><h1 style="font:64px sans-serif;color:#e6e9ed">${body}</h1>`
        );
    const store = (h, ctx, body) =>
        agentPage(
            h,
            `const C = await mod("app/view/agents/canvasstore.ts");
            const id = ${JSON.stringify(ctx.agentId)};
            ${body}`
        );
    const flat = (h, sel) =>
        h.ev(`(() => { const el = ${sel}; return (el?.innerText ?? "").replace(/\\s+/g, " ").trim(); })()`);

    // wavesrv refusing to serve the design folder: canvasserve answers with an error until restored
    const blockServe = (h) =>
        h.ev(`(() => {
            const c = window.TabRpcClient;
            if (!c || c.__mockupServeOrig) return !!c;
            c.__mockupServeOrig = c.wshRpcCall;
            const call = c.wshRpcCall.bind(c);
            c.wshRpcCall = (command, data, opts) =>
                command === "canvasserve" ? Promise.reject(new Error("refused by the scenario")) : call(command, data, opts);
            return true;
        })()`);
    const unblockServe = (h) =>
        h.ev(`(() => {
            const c = window.TabRpcClient;
            if (c?.__mockupServeOrig) {
                c.wshRpcCall = c.__mockupServeOrig;
                delete c.__mockupServeOrig;
            }
            return true;
        })()`);

    const mockup = scenario("rendered-bs-mockup", { noBrainstorm: true }, async (h, ctx, step) => {
        await step("CanvasEdge: a canvas with no board file yet draws the Mockup card's no-boards state", async () => {
            mkdirSync(projectDir(ctx), { recursive: true });
            await store(
                h,
                ctx,
                `C.attachCanvas(id, { topic: ${JSON.stringify(ctx.topic)}, dir: ${JSON.stringify(canvasDir(ctx))}, projectDir: ${JSON.stringify(ctx.cwd)} }, Date.now());
                return true;`
            );
            const empty = await polishWaitFor(h, kindIs("empty"), BS_POLL_WAIT_MS);
            const text = await flat(h, CARD);
            await h.shot(SHOT(1, "no-boards"));
            return [
                empty && text.includes(`Mockup ${ctx.topic}`) && text.includes("No boards yet. They show here as the agent writes them."),
                { empty, text },
            ];
        });

        await step("a board file written swaps the card to the live board: tabs, the board scaled, its title and scale", async () => {
            writeCanvasJson(ctx);
            for (const b of BOARDS) writeBoard(ctx, b, b);
            const boards = await polishWaitFor(h, `${kindIs("boards")} && !!${FRAME}`, BS_POLL_WAIT_MS);
            const s = await h.ev(`(() => {
                const card = ${CARD};
                const frame = ${FRAME};
                const tabs = [...(card?.querySelectorAll('[role="tab"]') ?? [])].map((t) => t.textContent.trim());
                return {
                    text: (card?.innerText ?? "").replace(/\\s+/g, " ").trim(),
                    tabs,
                    selected: card?.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
                    scaled: frame != null && /scale\\(0\\.\\d+\\)/.test(frame.style.transform),
                    open: card?.querySelector("[data-live-board]")?.getAttribute("aria-label") ?? null,
                };
            })()`);
            await h.shot(SHOT(2, "boards"));
            return [
                boards &&
                    s.text.includes("2 boards") &&
                    s.tabs.join("|") === "Main|States" &&
                    s.selected === "Main" &&
                    s.scaled &&
                    s.open === "Open Main in the canvas" &&
                    s.text.includes(TITLES["Main.dc.html"]) &&
                    /\d+%/.test(s.text) &&
                    s.text.includes(`the agent's mockup · ${ctx.topic}`),
                { boards, ...s },
            ];
        });

        await step("a board file rewritten reloads the shown board and puts the unseen dot on the other tab", async () => {
            // States on screen once, then Main again, so States' last look is known and its rewrite comes after it
            await h.ev(`${TAB("States.dc.html")}?.click()`);
            await polishWaitFor(h, `${TAB("States.dc.html")}?.getAttribute("aria-selected") === "true"`, WAIT_MS);
            await h.ev(`${TAB("Main.dc.html")}?.click()`);
            await polishWaitFor(h, `${TAB("Main.dc.html")}?.getAttribute("aria-selected") === "true" && !!${FRAME}`, WAIT_MS);
            const before = await h.ev(`(() => { const f = ${FRAME}; if (f) f.__mockupOld = true; return !!f; })()`);
            // the dot leaves through its exit fade when States is shown, so under load it can still be in the DOM here
            const noDot = await polishWaitFor(h, `!${TAB("States.dc.html")}?.querySelector("[data-live-board-unseen]")`, WAIT_MS);
            await polishNap(PAST_A_SECOND_MS);
            writeBoard(ctx, "Main.dc.html", "Main, rewritten");
            writeBoard(ctx, "States.dc.html", "States, rewritten");
            const dot = await polishWaitFor(h, `!!${TAB("States.dc.html")}?.querySelector("[data-live-board-unseen]")`, BS_POLL_WAIT_MS);
            const reloaded = await polishWaitFor(h, `${FRAME} != null && !${FRAME}.__mockupOld`, BS_POLL_WAIT_MS);
            const ago = await flat(h, `${HOST}?.querySelector("[data-live-boards-ago]")`);
            const shownDot = await h.ev(`!!${TAB("Main.dc.html")}?.querySelector("[data-live-board-unseen]")`);
            await h.shot(SHOT(3, "updated"));
            // showing the changed tab clears its dot
            await h.ev(`${TAB("States.dc.html")}?.click()`);
            const cleared = await polishWaitFor(h, `!${TAB("States.dc.html")}?.querySelector("[data-live-board-unseen]")`, WAIT_MS);
            await h.ev(`${TAB("Main.dc.html")}?.click()`);
            return [
                before && noDot && dot && reloaded && !shownDot && /updated \d+s ago/.test(ago) && cleared,
                { before, noDot, dot, reloaded, shownDot, ago, cleared },
            ];
        });

        await step("Mark opens the canvas pane with marking on, and a sent mark comes back to Rendered", async () => {
            await kit.recordSends(h);
            await h.ev(`${HOST}?.querySelector("[data-live-boards-mark]")?.click()`);
            const pane = await polishWaitFor(h, `!!document.querySelector("[data-canvas-pane]")`, WAIT_MS);
            const marking = await polishWaitFor(
                h,
                `[...(document.querySelector("[data-canvas-pane]")?.querySelectorAll("button[aria-pressed]") ?? [])]
                    .some((b) => (b.textContent || "").trim() === "Mark" && b.getAttribute("aria-pressed") === "true")`,
                WAIT_MS
            );
            const rendered = await h.ev(`${RV} != null`);
            await polishWaitFor(h, `!!document.querySelector("[data-canvas-board] iframe")`, WAIT_MS);
            await h.shot(SHOT(4, "mark-pane"));
            const dragged = await dragMarkBox(h);
            const note = await polishWaitFor(h, `!!document.querySelector("[data-canvas-mark-note]")`, WAIT_MS);
            await store(h, ctx, `C.setMark(id, { ...C.getCanvas(id).mark, note: ${JSON.stringify(MARK_NOTE)} }); return true;`);
            await h.ev(`[...(document.querySelector("[data-canvas-mark-note]")?.querySelectorAll("button") ?? [])]
                .find((b) => (b.textContent || "").trim().startsWith("Send"))?.click()`);
            const line = await kit.waitSent(h, 0, WAIT_MS);
            const back = await polishWaitFor(h, `${RV} != null && !document.querySelector("[data-canvas-pane]")`, WAIT_MS);
            return [
                pane && marking && !rendered && dragged && note && line != null && line.includes(MARK_NOTE) && back,
                { pane, marking, rendered, dragged, note, line, back },
            ];
        });

        await step("the narrow column stacks the card's head and the block's actions", async () => {
            const narrowed = await kit.narrow(h);
            const s = await h.ev(`(() => {
                const card = ${CARD};
                const r = (sel) => card?.querySelector(sel)?.getBoundingClientRect();
                const label = r("[data-rendered-mockup-head] > span");
                const open = r("[data-rendered-mockup-open]");
                const tabs = r('[role="tablist"]');
                const actions = r("[data-live-boards-actions]");
                return {
                    headStacked: label != null && open != null && open.top >= label.bottom - 1,
                    barStacked: tabs != null && actions != null && actions.top >= tabs.bottom - 1,
                    compact: ${HOST}?.hasAttribute("data-compact") ?? false,
                };
            })()`);
            await h.shot(SHOT(5, "narrow"));
            const widened = await kit.widen(h);
            return [narrowed && s.compact && s.headStacked && s.barStacked && widened, { narrowed, ...s, widened }];
        });

        await step("Arc could not serve the canvas: the card says so with the pane's explanation", async () => {
            await blockServe(h);
            await store(h, ctx, `C.updateCanvas(id, (s) => ({ ...s, base: null })); return true;`);
            const down = await polishWaitFor(h, kindIs("server-down"), BS_POLL_WAIT_MS);
            const text = await flat(h, CARD);
            await h.shot(SHOT(6, "not-served"));
            await unblockServe(h);
            const back = await polishWaitFor(h, kindIs("boards"), BS_POLL_WAIT_MS);
            return [
                down &&
                    text.includes("Arc could not serve this canvas") &&
                    text.includes("Arc got no answer serving them") &&
                    text.includes("2 boards") &&
                    back,
                { down, text, back },
            ];
        });

        await step("the canvas folder deleted leaves an Opened in Arc row, removed", async () => {
            rmSync(canvasDir(ctx), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            const removed = await polishWaitFor(h, kindIs("removed"), BS_POLL_WAIT_MS);
            const text = await flat(h, CARD);
            await h.shot(SHOT(7, "removed"));
            await store(h, ctx, `C.detachCanvas(id); return true;`).catch(() => false);
            return [
                removed &&
                    text.includes(`Opened in Arc canvas:${ctx.topic}`) &&
                    text.includes("removed, usually because the feature shipped"),
                { removed, text },
            ];
        });
        await unblockServe(h).catch(() => false);
    });

    return [mockup];
};
