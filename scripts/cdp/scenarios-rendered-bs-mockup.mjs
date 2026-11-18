// Scenario rendered-bs-mockup: the standalone Mockup card (CanvasEdge) for an agent with a canvas and no brainstorm,
// and the one row it draws once boards are served. kit is scenarios-rendered-brainstorm.mjs's RBS_KIT.
//
// The fixture agent revealed its canvas twice: the card draws on the second reveal's row, where the agent opened it,
// and the first stays a row with Open canvas; nothing is pinned after the agent's last reply. It has no brainstorm,
// so the canvas is attached in the page as the reveal would; the canvas folder is the agent's side, written and
// deleted from here, and the poller draws what it finds.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assistantText, toolResult, toolUse, userText } from "./agent-page-fixtures.mjs";

const SHOT = (n, what) => `cdp-shots/rendered-bs-mockup-${n}-${what}.png`;
const BOARDS = ["Main.dc.html", "States.dc.html"];
const TITLES = { "Main.dc.html": "Run graph: Final queued behind another run", "States.dc.html": "The queued states" };
// a board's Last-Modified has whole seconds, so a rewrite meant to read as newer than the last one waits past one
const PAST_A_SECOND_MS = 1200;
const TOPIC = `rbs-mockup-${Date.now().toString(36)}`;
const LAST_REPLY = "Both boards are up; mark anything that reads wrong.";
const revealCall = (id) => [
    toolUse(id, "Bash", { command: `wsh ui reveal canvas:${TOPIC}`, description: "Show the mockup" }),
    toolResult(id, ""),
];
const TRANSCRIPT = [
    userText("Mock up how a queued Final shows in the run graph."),
    ...revealCall("toolu_mockup_reveal_1"),
    assistantText("The first board is the graph with the Final queued."),
    userText("Add the queued states."),
    ...revealCall("toolu_mockup_reveal_2"),
    assistantText(LAST_REPLY),
];

export default (kit) => {
    const { scenario, agentPage, polishWaitFor, polishNap, HOST, RV, WAIT_MS, BS_POLL_WAIT_MS } = kit;
    const REVEALS = `[...(${RV}?.querySelectorAll('[data-rendered-feed] [data-wsh-card="ui-reveal"]') ?? [])]`;
    const CARD = `${RV}?.querySelector("[data-rendered-feed] [data-rendered-mockup]")`;
    const kindIs = (kind) => `${CARD}?.getAttribute("data-rendered-mockup") === ${JSON.stringify(kind)}`;

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
    // where a row's button sent the agent: the workspace's tabs, the canvas's tab and marking, and the window's agent
    const READ_OPEN = `const W = await mod("app/view/agents/workspacestore.ts");
        const w = globalStore.get(W.workspaceAtom(id));
        const c = C.getCanvas(id);
        return {
            tabs: w.tabs.map((t) => t.kind),
            window: globalStore.get(C.canvasWindowAtom),
            board: c.board,
            all: c.all,
            marking: c.marking,
            mark: c.mark,
        };`;
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

    const mockup = scenario("rendered-bs-mockup", { noBrainstorm: true, topic: TOPIC, transcript: TRANSCRIPT }, async (h, ctx, step) => {
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

        await step("a board file written swaps the card to one row: Mockup, topic, boards, updated, Open canvas, Mark", async () => {
            writeCanvasJson(ctx);
            for (const b of BOARDS) writeBoard(ctx, b, b);
            const boards = await polishWaitFor(h, kindIs("boards"), BS_POLL_WAIT_MS);
            const s = await h.ev(`(() => {
                const card = ${CARD};
                const label = (sel) => (card?.querySelector(sel)?.textContent ?? "").trim();
                return {
                    text: (card?.innerText ?? "").replace(/\\s+/g, " ").trim(),
                    iframes: card?.querySelectorAll("iframe").length ?? -1,
                    tabs: card?.querySelectorAll('[role="tab"]').length ?? -1,
                    open: label("[data-rendered-mockup-open]"),
                    mark: label("[data-rendered-mockup-mark]"),
                    ago: label("[data-rendered-mockup-ago]"),
                };
            })()`);
            await h.shot(SHOT(2, "row"));
            return [
                boards &&
                    s.text.startsWith(`Mockup ${ctx.topic} 2 boards updated`) &&
                    /^updated \d+s ago$/.test(s.ago) &&
                    s.open === "Open canvas" &&
                    s.mark === "Mark" &&
                    s.iframes === 0 &&
                    s.tabs === 0,
                { boards, ...s },
            ];
        });

        await step("the card sits on the last reveal's row outside its turn's fold, the earlier reveal folds, and the agent's last reply ends the transcript", async () => {
            const s = await h.ev(`(() => {
                const reveals = ${REVEALS};
                const feed = ${RV}?.querySelector("[data-rendered-feed]");
                const card = ${CARD};
                const reply = [...(feed?.querySelectorAll("*") ?? [])].find(
                    (el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(LAST_REPLY)}
                );
                return {
                    reveals: reveals.length,
                    cardOnRow: reveals.length === 1 && reveals[0].contains(card),
                    folds: [...(feed?.querySelectorAll("[data-fold]") ?? [])].map((f) => f.innerText.replace(/\\s+/g, " ").trim()),
                    replyAfterCard:
                        card != null && reply != null && !!(card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING),
                    hostEmpty: ${HOST}?.getAttribute("data-rendered-bs-card") === "none" && (${HOST}?.innerText ?? "").trim() === "",
                };
            })()`);
            await h.shot(SHOT(3, "in-place"));
            return [
                s.cardOnRow && s.folds.length >= 1 && s.folds[0].includes("revealed a canvas") && s.replyAfterCard && s.hostEmpty,
                s,
            ];
        });

        await step("the earlier reveal, its fold opened, is a row with Open canvas", async () => {
            await h.ev(`${RV}?.querySelector("[data-rendered-feed] [data-fold]")?.click()`);
            const shown = await polishWaitFor(h, `${REVEALS}.length === 2`, WAIT_MS);
            const s = await h.ev(`(() => {
                const reveals = ${REVEALS};
                const card = ${CARD};
                return {
                    earlier: (reveals[0]?.innerText ?? "").replace(/\\s+/g, " ").trim(),
                    earlierOpen: (reveals[0]?.querySelector("[data-reveal-open-canvas]")?.textContent ?? "").trim(),
                    cardOnLast: reveals.length === 2 && reveals[1].contains(card) && !reveals[0].contains(card),
                };
            })()`);
            await h.shot(SHOT(4, "earlier-reveal"));
            return [
                shown && s.cardOnLast && s.earlier.startsWith(`Showed in Arc canvas:${ctx.topic}`) && s.earlierOpen === "Open canvas",
                { shown, ...s },
            ];
        });

        await step("the earlier reveal's Open canvas opens the Canvas tab at the board", async () => {
            await h.ev(`${REVEALS}[0]?.querySelector("[data-reveal-open-canvas]")?.click()`);
            const at = await store(h, ctx, READ_OPEN);
            const back = await kit.closePaneTabs(h, ctx);
            return [
                at.tabs.includes("canvas") && at.board === BOARDS[0] && !at.marking && at.window == null && back,
                { ...at, back },
            ];
        });

        await step("a board file rewritten moves the row's updated time", async () => {
            const newest = () =>
                store(h, ctx, `return Math.max(...Object.values(C.getCanvas(id).boardModifiedMs ?? {}));`);
            const was = await newest();
            await polishNap(PAST_A_SECOND_MS);
            writeBoard(ctx, "States.dc.html", "States, rewritten");
            let now = was;
            for (const start = Date.now(); now <= was && Date.now() - start < BS_POLL_WAIT_MS; await polishNap(300)) {
                now = await newest();
            }
            const ago = await flat(h, `${CARD}?.querySelector("[data-rendered-mockup-ago]")`);
            return [now > was && /^updated \d+s ago$/.test(ago), { was, now, ago }];
        });

        await step("Open canvas opens the Canvas tab beside the transcript at the board", async () => {
            await h.ev(`${CARD}?.querySelector("[data-rendered-mockup-open]")?.click()`);
            const at = await store(h, ctx, READ_OPEN);
            await h.shot(SHOT(3, "open-canvas"));
            const back = await kit.closePaneTabs(h, ctx);
            return [
                at.tabs.includes("canvas") && at.board === BOARDS[0] && !at.all && !at.marking && at.window == null && back,
                { ...at, back },
            ];
        });

        await step("Mark opens the Canvas tab and the canvas window on the board with marking on", async () => {
            await h.ev(`${CARD}?.querySelector("[data-rendered-mockup-mark]")?.click()`);
            const at = await store(h, ctx, READ_OPEN);
            await h.shot(SHOT(4, "mark"));
            // closing turns marking off and drops the window, so the narrow step starts from a bare column
            await store(h, ctx, `C.closeCanvasWindow(); return true;`);
            const back = await kit.closePaneTabs(h, ctx);
            return [
                at.tabs.includes("canvas") &&
                    at.window === ctx.agentId &&
                    at.board === BOARDS[0] &&
                    !at.all &&
                    at.marking &&
                    at.mark == null &&
                    back,
                { ...at, back },
            ];
        });

        await step("the narrow column stacks the row's label and its actions", async () => {
            const narrowed = await kit.narrow(h);
            const s = await h.ev(`(() => {
                const card = ${CARD};
                const r = (sel) => card?.querySelector(sel)?.getBoundingClientRect();
                const label = r("[data-rendered-mockup-head] > span");
                const actions = r("[data-rendered-mockup-actions]");
                return {
                    headStacked: label != null && actions != null && actions.top >= label.bottom - 1,
                    compact: ${RV}?.querySelector("[data-rendered-mockup-card]")?.hasAttribute("data-compact") ?? false,
                };
            })()`);
            await h.shot(SHOT(5, "narrow"));
            const widened = await kit.widen(h);
            return [narrowed && s.compact && s.headStacked && widened, { narrowed, ...s, widened }];
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
