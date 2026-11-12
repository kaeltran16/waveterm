// Boards scenarios (surface): Task 9. The Boards surface over boards made through the real board RPCs in a
// throwaway project; the scribe never runs. Draws reach the board through the real applier: its inbox read, ack
// and status are stubbed in page and a board:update event is fed to the page's own event handler, so the open
// canvas lands them live (updateScene) and saves them through the real BoardSaveCommand. The follow is a roster
// fixture agent whose tab meta is set in the page's object cache.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    floorStep,
    lookEval,
    polishNap,
    polishReload,
    polishWaitFor,
    setInputExpr,
    waitForProjectInConfig,
} from "./scenarios-shared.mjs";

const NAME = "boards-surface";
const PROJECT = "boards-surface-fx";
const OTHER_PROJECT = "boards-surface-fx-other";
const WIDE = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const AGENT_ID = "f0a0b0c0-0000-4000-8000-00000000b0a4";
const AGENT_NAME = "claude · waveterm";
const MAIN = "Brainstorm internals";
const NEW_BOARD = "dag-lock bug";
const BROKEN = "Orchestrator landing";
const MIN = 60_000;
const q = JSON.stringify;

// the three sources on the main board, oldest drawn first
const SRC = {
    run: { key: "run:4842b792", source: { kind: "run", ref: "4842b792", title: "run 4842b792" }, ask: "" },
    input: {
        key: "agent:fx|the judge input",
        source: { kind: "agent", ref: AGENT_ID, title: AGENT_NAME },
        ask: "the judge input",
    },
    rerun: {
        key: "agent:fx|how a rerun reaches the judge",
        source: { kind: "agent", ref: AGENT_ID, title: AGENT_NAME },
        ask: "how a rerun reaches the judge",
    },
};
const box = (x, y, text, type = "rectangle") => ({ type, x, y, width: 180, height: 70, label: { text } });
const SKELETON = {
    run: [box(0, 0, "plan review", "ellipse"), box(240, 0, "tasks"), box(480, 0, "final", "diamond")],
    input: [box(0, 0, "judge input"), { type: "text", x: 0, y: 100, text: "turns since the cursor" }],
    inputRedraw: [box(0, 0, "judge input"), box(240, 0, "the rerun's turns"), { type: "arrow", x: 185, y: 35, width: 50, height: 0 }],
    rerun: [box(0, 0, "rerun"), { type: "arrow", x: 185, y: 35, width: 50, height: 0 }, box(240, 0, "judge")],
};
const FAIL_REASON = "the scribe session ended without returning a drawing";
const REDRAW_SHAPES = SKELETON.inputRedraw.length;

const SURFACE = `document.querySelector("[data-boards-surface]")`;
const LIST = `${SURFACE}?.querySelector("aside")`;
const HEADER = `${SURFACE}?.querySelector("[data-surface-toolbar]")`;
const rowExpr = (boardId) => `${SURFACE}?.querySelector('[data-board-row="${boardId}"]')`;
const sourceExpr = (key) => `${SURFACE}?.querySelector('[data-board-source=${q(key)}]')`;
const text = (expr) => `((${expr})?.textContent ?? "").replace(/\\s+/g, " ").trim()`;

// a draw as the scribe leaves it in the inbox
const drawOf = (ctx, src, skeleton, ts) => ({
    id: crypto.randomUUID(),
    channelid: ctx.channelId,
    boardid: ctx.mainId,
    sourcekey: src.key,
    source: src.source,
    ask: src.ask || undefined,
    skeleton: JSON.stringify(skeleton),
    shapes: skeleton.length,
    ts,
});

// page-side: the app's board modules, the stubs' state, and Excalidraw's own selection read off its App component
const PAGE = `
    const B = await mod("app/view/boards/boardstore.ts");
    const M = await mod("app/view/boards/boardmodel.ts");
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    const { TabRpcClient } = await mod("app/store/wshrpcutil.ts");
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const fx = (window.__boardsFx ??= { inbox: [], acks: [], status: null });
    // the cockpit's model, on the nav rail's props
    const model = (() => {
        const nav = document.querySelector("nav");
        const key = nav && Object.keys(nav).find((k) => k.startsWith("__reactFiber$"));
        for (let f = key ? nav[key] : null; f != null; f = f.return) {
            if (f.memoizedProps?.model?.surfaceAtom != null) return f.memoizedProps.model;
        }
        return null;
    })();
    const selection = () => {
        const el = document.querySelector(".excalidraw");
        const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
        for (let f = key ? el[key] : null; f != null; f = f.return) {
            const ids = f.stateNode?.state?.selectedElementIds;
            if (ids != null) return Object.keys(ids).filter((id) => ids[id]).sort();
        }
        return null;
    };
    // the open canvas's live elements, off Excalidraw's App component
    const canvasElements = () => {
        const el = document.querySelector(".excalidraw");
        const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
        for (let f = key ? el[key] : null; f != null; f = f.return) {
            const scene = f.stateNode?.scene;
            if (typeof scene?.getNonDeletedElements === "function") return scene.getNonDeletedElements();
        }
        return null;
    };
    const boxOf = (els) => {
        const xs = [], ys = [];
        for (const e of els) {
            for (const [px, py] of e.points ?? [[0, 0], [e.width, e.height]]) {
                xs.push(e.x + px);
                ys.push(e.y + py);
            }
        }
        return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    };
    const overlap = (a, b) => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
    const readBoard = async (boardid) => {
        const r = await RpcApi.BoardReadCommand(TabRpcClient, { channelid: fx.channelId, boardid });
        return { rev: r.rev, scene: M.parseBoardFile(r.data) };
    };
`;
const page = (h, body) => lookEval(h, `${PAGE} ${body}`);

async function clickIn(h, expr, label) {
    const ok = await page(h, `const b = button(${expr}, ${label}); if (!b) return false; b.click(); return true;`);
    if (!ok) throw new Error(`no button ${label} in ${expr}`);
}

const pressEnter = (h, expr) =>
    h.ev(`(${expr})?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }))`);

// Escape as the dispatcher sees it, with focus outside any field
const pressEscape = (h) =>
    h.ev(`(() => {
        document.activeElement?.blur?.();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    })()`);

// stubs the inbox, its ack and the status read, so the real applier lands the draws handed to deliver(); the list
// reads the stubbed status into each board's state as wavesrv does (drawing if any source draws, else failed); Stop
// clears the fixture tab's follow keys as BoardFollowStop does
const STUBBED = ["BoardInboxCommand", "BoardInboxAckCommand", "BoardStatusCommand", "BoardListCommand", "BoardFollowStopCommand"];
async function installStubs(h, ctx) {
    await page(
        h,
        `fx.channelId = ${q(ctx.channelId)};
        fx.orig ??= { inbox: RpcApi.BoardInboxCommand, ack: RpcApi.BoardInboxAckCommand, status: RpcApi.BoardStatusCommand, list: RpcApi.BoardListCommand };
        RpcApi.BoardInboxCommand = async (_c, d) => fx.inbox.filter((x) => !d?.boardid || x.boardid === d.boardid);
        RpcApi.BoardInboxAckCommand = async (_c, d) => {
            fx.acks.push(d.drawid);
            fx.inbox = fx.inbox.filter((x) => x.id !== d.drawid);
        };
        RpcApi.BoardStatusCommand = async (c, d) =>
            fx.status != null && d.boardid === fx.status.boardid ? fx.status : fx.orig.status.call(RpcApi, c, d);
        RpcApi.BoardListCommand = async (c, d) => {
            const rtn = await fx.orig.list.call(RpcApi, c, d);
            const srcs = fx.status?.sources ?? [];
            const state = srcs.some((s) => s.state === "drawing") ? "drawing" : srcs.length > 0 ? "failed" : undefined;
            return { ...rtn, boards: (rtn?.boards ?? []).map((b) => (state && b.id === fx.status.boardid ? { ...b, state } : b)) };
        };
        RpcApi.BoardFollowStopCommand = async (_c, d) => {
            const WOS = await mod("app/store/wos.ts");
            WOS.setObjectValue({ otype: "tab", oid: d.tabid, version: 2, name: "fx", blockids: [], meta: {} });
        };
        return true;`
    );
}

// the check DrawCheck draws (its 12x12 path), so a row's kind icon never reads as one
const CHECK = `path[d="M2.5 6.5l2.5 2.5 4.5-6"]`;

const event = (h, data) =>
    page(
        h,
        `const W = await mod("app/store/wps.ts");
        W.handleWaveEvent({ event: "board:update", data: ${q(data)} });
        return true;`
    );

// the main board as the scribe and you left it: three sources drawn, the judge input edited by hand, a note of yours
async function seedMainBoard(h, ctx) {
    const t0 = Date.now() - 50 * MIN;
    const draws = [
        drawOf(ctx, SRC.run, SKELETON.run, t0),
        drawOf(ctx, SRC.input, SKELETON.input, t0 + 10 * MIN),
        drawOf(ctx, SRC.rerun, SKELETON.rerun, t0 + 30 * MIN),
    ];
    const r = await page(
        h,
        `const C = await mod("app/view/boards/boardconvert.ts");
        const draws = ${q(draws)};
        const times = [${t0}, ${t0 + 10 * MIN}, ${t0 + 30 * MIN}];
        let { rev, scene } = await readBoard(${q(ctx.mainId)});
        draws.forEach((d, i) => (scene = M.applyDraw(scene, d, C.convertSkeleton(d.skeleton), times[i]).scene));
        const input = scene.arc.sources.find((s) => s.key === ${q(SRC.input.key)});
        scene = {
            ...scene,
            elements: scene.elements.map((el) =>
                el.type === "text" && el.groupIds.includes(input.groupid) && el.containerId == null
                    ? { ...el, text: el.text + ", mine", originalText: (el.originalText ?? el.text) + ", mine", version: el.version + 1 }
                    : el
            ),
        };
        const note = C.convertSkeleton(JSON.stringify([{ type: "text", x: 0, y: 420, text: "check the cursor math" }]));
        scene = { ...scene, elements: [...scene.elements, ...note] };
        scene = M.markEdits(scene, ${t0 + 20 * MIN});
        scene = { ...scene, arc: { ...scene.arc, seents: ${t0 + 20 * MIN} } };
        const saved = await RpcApi.BoardSaveCommand(TabRpcClient, {
            channelid: fx.channelId, boardid: ${q(ctx.mainId)}, data: M.serializeBoard(scene), baserev: rev,
        });
        return { conflict: !!saved?.conflict, sources: scene.arc.sources.length };`
    );
    if (r?.conflict || r?.sources !== 3) throw new Error(`seeding the main board failed: ${q(r)}`);
}

// the follow: a roster agent whose tab meta names the main board
async function seedFollow(h, ctx) {
    await page(
        h,
        `const D = await mod("app/view/agents/devmock.ts");
        const WOS = await mod("app/store/wos.ts");
        globalStore.set(D.devMockAgentsAtom, [{
            id: ${q(AGENT_ID)}, name: ${q(AGENT_NAME)}, task: "explain the judge", state: "working",
            agent: "claude", model: "opus", project: ${q(PROJECT)}, activeMs: 60000, blockId: "fx-blk-boards",
        }]);
        const oref = WOS.makeORef("tab", ${q(AGENT_ID)});
        await WOS.loadAndPinWaveObject(oref).catch(() => {});
        await nap(300);
        WOS.setObjectValue({
            otype: "tab", oid: ${q(AGENT_ID)}, version: 1, name: "fx", blockids: [],
            meta: {
                "board:followid": ${q(ctx.mainId)}, "board:followchannel": ${q(ctx.channelId)},
                "board:followname": ${q(MAIN)}, "board:followask": "how a rerun reaches the judge",
            },
        });
        return true;`
    );
}

// opens the board unless it already is: clicking an open board's row folds it
async function openBoard(h, boardId) {
    const canvas = `!!${SURFACE}?.querySelector('[data-board-canvas="${boardId}"] .excalidraw')`;
    if (!(await h.ev(canvas))) await h.ev(`${rowExpr(boardId)}?.querySelector("button")?.click()`);
    if (!(await polishWaitFor(h, canvas, 20000))) {
        throw new Error(`board ${boardId} never opened its canvas`);
    }
    await polishNap(1200);
}

// makes a throwaway project and waits for the channel wavesrv gives it
async function createProject(h, name, path) {
    await h.rpc("createproject", { name, path });
    await waitForProjectInConfig(h, name);
    for (let waited = 0; waited < 10000; waited += 250) {
        const channel = ((await h.rpc("getchannels", null))?.channels ?? []).find((c) => c.name === name);
        if (channel != null) return channel;
        await polishNap(250);
    }
    throw new Error(`project ${name} never got a channel`);
}

const toastText = (h, needle) =>
    h.ev(`[...document.querySelectorAll("[data-notification-toast]")].map((t) => t.textContent).find((t) => t.includes(${q(needle)})) ?? null`);

export const boardsSurface = {
    name: NAME,
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        try {
            ctx.cwd = mkdtempSync(join(tmpdir(), "arc-boards-fx-"));
            ctx.project = PROJECT;
            ctx.channelId = (await createProject(h, PROJECT, ctx.cwd)).oid;
            await h.cdp("Emulation.setDeviceMetricsOverride", WIDE);
            await polishReload(h);
            await installStubs(h, ctx);
            await page(h, `B.selectBoard(${q(ctx.channelId)}, ""); return true;`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError) return [{ step: `${NAME}: arrange`, ok: false, detail: ctx.arrangeError }];
        const steps = [];
        const run = async (step, fn) => {
            try {
                steps.push({ step, ...(await fn()) });
            } catch (e) {
                steps.push({ step, ok: false, detail: String(e?.message ?? e) });
            }
        };

        await run("1. no boards (N2): the empty state names the project, says what a board is, and offers New board", async () => {
            await h.goto("boards");
            await polishWaitFor(h, `!!${SURFACE}?.querySelector("[data-boards-empty]")`, 10000);
            const empty = await h.ev(text(`${SURFACE}?.querySelector("[data-boards-empty]")`));
            const header = await h.ev(text(HEADER));
            await h.shot(`cdp-shots/${NAME}-1-no-boards.png`);
            const ok =
                empty.includes(`No boards in ${PROJECT} yet`) &&
                empty.includes("A board is a canvas you name and keep") &&
                empty.includes("New board") &&
                empty.includes("Draw on a board…") &&
                header === `Boards${PROJECT}`;
            return { ok, detail: q({ empty, header }) };
        });

        await run("2. new board (N1): the focused name field, Type a name first on an empty Enter, then the new empty board", async () => {
            await h.ev(`${SURFACE}?.querySelector("[data-new-board-button]")?.click()`);
            await polishWaitFor(h, `!!document.getElementById("new-board-name")`, 5000);
            const focused = await h.ev(`document.activeElement?.id === "new-board-name"`);
            const field = await h.ev(text(`${SURFACE}?.querySelector("[data-new-board]")`));
            await pressEnter(h, `document.getElementById("new-board-name")`);
            await polishNap(400);
            const refused = await h.ev(text(`${SURFACE}?.querySelector("[data-new-board-error]")`));
            await h.shot(`cdp-shots/${NAME}-2a-name-field.png`);
            await h.ev(setInputExpr(`document.getElementById("new-board-name")`, NEW_BOARD));
            await pressEnter(h, `document.getElementById("new-board-name")`);
            await polishWaitFor(h, `!!${SURFACE}?.querySelector("[data-board-empty]")`, 20000);
            const list = (await h.rpc("boardlist", { channelid: ctx.channelId }))?.boards ?? [];
            const made = list.find((b) => b.name === NEW_BOARD);
            ctx.newId = made?.id;
            ctx.boardDir ??= made && dirname(made.path);
            const header = await h.ev(text(HEADER));
            const overlay = await h.ev(text(`${SURFACE}?.querySelector("[data-board-empty]")`));
            const tree = await h.ev(text(ctx.newId ? rowExpr(ctx.newId) : "null"));
            await h.shot(`cdp-shots/${NAME}-2b-new-board.png`);
            const ok =
                focused &&
                field.includes(`New board in ${PROJECT}`) &&
                refused === "Type a name first" &&
                ctx.newId != null &&
                header.startsWith(`Boards/${NEW_BOARD}empty · created`) &&
                overlay.startsWith("Nothing on this board yet") &&
                tree.includes("Nothing drawn yet");
            return { ok, detail: q({ focused, field, refused, newId: ctx.newId, header, overlay, tree }) };
        });

        await run("3. board open (F8): the follow with Stop, three sources, a pending row with Keep and Drop, the pending frame on the canvas, the draw toast with Open", async () => {
            const info = await h.rpc("boardcreate", { channelid: ctx.channelId, name: MAIN });
            ctx.mainId = info.id;
            ctx.boardDir ??= dirname(info.path);
            await page(h, `await B.loadBoardList(${q(ctx.channelId)}); return true;`);
            await seedMainBoard(h, ctx);
            await seedFollow(h, ctx);
            await page(h, `await B.loadBoardList(${q(ctx.channelId)}); return true;`);
            await openBoard(h, ctx.mainId);
            // the judge input's redraw lands beside the group you edited
            const redraw = drawOf(ctx, SRC.input, SKELETON.inputRedraw, Date.now());
            ctx.redrawId = redraw.id;
            await page(h, `fx.inbox.push(${q(redraw)}); return true;`);
            await event(h, { channelid: ctx.channelId, boardid: ctx.mainId, what: "draw" });
            await polishWaitFor(h, `!!${sourceExpr(SRC.input.key)}?.textContent.includes("waits beside it")`, 15000);
            await polishWaitFor(h, `[...document.querySelectorAll("[data-notification-toast]")].some((t) => t.textContent.includes("Scribe drew"))`, 10000);
            await polishNap(600);
            const file = await page(
                h,
                `const { scene } = await readBoard(${q(ctx.mainId)});
                return {
                    frames: scene.elements.filter((e) => e.type === "frame").map((e) => e.name),
                    pending: scene.arc.sources.find((s) => s.key === ${q(SRC.input.key)})?.pending?.drawid ?? null,
                    acked: fx.acks.includes(${q(redraw.id)}),
                };`
            );
            const rows = await h.ev(`[...(${LIST}?.querySelectorAll("[data-board-source]") ?? [])].map((r) => r.getAttribute("data-board-source"))`);
            const follow = await h.ev(text(`${LIST}?.querySelector("[data-board-follow]")`));
            const pending = await h.ev(text(sourceExpr(SRC.input.key)));
            const yours = await h.ev(text(`${LIST}?.querySelector("[data-board-yours]")`));
            const header = await h.ev(text(HEADER));
            const toast = await toastText(h, "Scribe drew");
            const toastOpen = await h.ev(
                `!![...document.querySelectorAll("[data-notification-toast]")].find((t) => t.textContent.includes("Scribe drew"))?.querySelector("[data-notification-toast-action]")`
            );
            await h.shot(`cdp-shots/${NAME}-3-board-open.png`);
            const floor = await floorStep(h, "floor", LIST, HEADER);
            const ok =
                follow === `Following ${AGENT_NAME}redraws at each turn endStop` &&
                q(rows) === q([SRC.rerun.key, SRC.input.key, SRC.run.key]) &&
                pending.includes("Drop") &&
                pending.includes("Keep") &&
                /You edited it at \d\d:\d\d, so the \d\d:\d\d redraw waits beside it\./.test(pending) &&
                yours === "Your shapes1 note · the scribe never changes them" &&
                header.includes(`Boards/${MAIN}3 groups · 1 new since you looked · last drawn`) &&
                header.endsWith(`Following ${AGENT_NAME}`) &&
                q(file?.frames) === q([`Pending redraw · ${SRC.input.ask}`]) &&
                file?.pending === redraw.id &&
                file?.acked === true &&
                toast === `Scribe drew ${REDRAW_SHAPES} shapes on ${MAIN}From ${AGENT_NAME}Open` &&
                toastOpen &&
                floor.ok;
            return { ok, detail: q({ follow, rows, pending, yours, header, file, toast, toastOpen, floor: floor.detail }) };
        });

        await run("4. keep pending: the pending frame clears the group right of the edited one; Keep turns the frame into the source's group, and the row loses its pending line", async () => {
            // the rerun's group sits right of the edited judge input, so the frame goes past the board's content
            const placement = await page(
                h,
                `const { scene } = await readBoard(${q(ctx.mainId)});
                const live = scene.elements.filter((e) => !e.isDeleted);
                const frame = live.find((e) => e.type === "frame");
                const edited = boxOf(live.filter((e) => e.groupIds.includes(scene.arc.sources.find((s) => s.key === ${q(SRC.input.key)}).groupid)));
                const others = scene.arc.sources
                    .filter((s) => s.key !== ${q(SRC.input.key)})
                    .map((s) => ({ key: s.key, box: boxOf(live.filter((e) => e.groupIds.includes(s.groupid))) }));
                const yours = live.filter((e) => e.customData?.arcSource == null);
                if (yours.length > 0) others.push({ key: "yours", box: boxOf(yours) });
                const f = frame && boxOf([frame]);
                return {
                    frame: f ?? null,
                    rightOfEdited: others.filter((o) => o.box.minX >= edited.maxX && o.box.minY < edited.maxY && edited.minY < o.box.maxY).map((o) => o.key),
                    covered: f ? others.filter((o) => overlap(f, o.box)).map((o) => o.key) : null,
                };`
            );
            await clickIn(h, sourceExpr(SRC.input.key), "/^Keep$/");
            await polishWaitFor(h, `!${sourceExpr(SRC.input.key)}?.textContent.includes("waits beside it")`, 10000);
            await polishNap(600);
            const file = await page(
                h,
                `const { scene } = await readBoard(${q(ctx.mainId)});
                const src = scene.arc.sources.find((s) => s.key === ${q(SRC.input.key)});
                return {
                    frames: scene.elements.filter((e) => e.type === "frame").length,
                    groupid: src?.groupid,
                    pending: src?.pending ?? null,
                    edited: src?.editedts ?? null,
                    faded: scene.elements.filter((e) => e.groupIds.includes(src?.groupid) && e.opacity !== 100).length,
                };`
            );
            const row = await h.ev(text(sourceExpr(SRC.input.key)));
            const yours = await h.ev(text(`${LIST}?.querySelector("[data-board-yours]")`));
            await h.shot(`cdp-shots/${NAME}-4-keep-pending.png`);
            const ok =
                placement.frame != null &&
                placement.rightOfEdited.includes(SRC.rerun.key) &&
                q(placement.covered) === "[]" &&
                file.frames === 0 &&
                file.groupid === `arc-group-${ctx.redrawId}` &&
                file.pending == null &&
                file.edited == null &&
                file.faded === 0 &&
                // drawn after you opened the board, so it is New
                new RegExp(`^${SRC.input.ask}(New)?${AGENT_NAME} · ${REDRAW_SHAPES} shapes · \\d\\d:\\d\\d$`).test(row) &&
                !row.includes("Keep") &&
                // the edited group is yours now: its box (its label is part of it) and its text join your note
                yours === "Your shapes2 notes, 1 shape · the scribe never changes them";
            return { ok, detail: q({ placement, file, row, yours }) };
        });

        await run("5. drawing and failed (D2): a drawing row with its queued line, a failed row with Retry, the error toast", async () => {
            const ts = Date.now();
            const status = {
                channelid: ctx.channelId,
                boardid: ctx.mainId,
                sources: [
                    { sourcekey: SRC.rerun.key, source: SRC.rerun.source, ask: SRC.rerun.ask, state: "drawing", reading: "the 16:09 turn end", queued: 1, ts },
                    { sourcekey: SRC.run.key, source: SRC.run.source, state: "failed", reason: FAIL_REASON, ts },
                ],
            };
            await page(h, `fx.status = ${q(status)}; return true;`);
            await event(h, { channelid: ctx.channelId, boardid: ctx.mainId, what: "failed", sourcekey: SRC.run.key, reason: FAIL_REASON });
            await polishWaitFor(h, `!!${sourceExpr(SRC.run.key)}?.textContent.includes("Retry")`, 10000);
            await polishWaitFor(h, `[...document.querySelectorAll('[data-notification-toast="error"]')].some((t) => t.textContent.includes("couldn't draw"))`, 10000);
            await polishWaitFor(h, `!!${rowExpr(ctx.mainId)}?.querySelector('button [data-board-mark="drawing"]')`, 10000);
            // the drawing row's New chip leaves as the drawing mark comes (moment 1 exit): read the row once it has
            await polishWaitFor(h, `${text(sourceExpr(SRC.rerun.key))}.startsWith(${q(`${SRC.rerun.ask}drawing`)})`, 5000);
            const drawing = await h.ev(text(sourceExpr(SRC.rerun.key)));
            const failed = await h.ev(text(sourceExpr(SRC.run.key)));
            const header = await h.ev(text(HEADER));
            const toast = await toastText(h, "couldn't draw");
            // the board's own row says the scribe draws on it (D2), not what is new
            const boardRow = await h.ev(text(`${rowExpr(ctx.mainId)}?.querySelector("button")`));
            await h.shot(`cdp-shots/${NAME}-5-drawing-and-failed.png`);
            const ok =
                boardRow === `${MAIN}drawing` &&
                drawing ===
                    `${SRC.rerun.ask}drawingReading the 16:09 turn endThe group stays as drawn until the redraw lands. 1 more turn end came in; it joins the next pass.` &&
                /^run 4842b792failedno ask, read whole · 3 shapes · \d\d:\d\dThe \d\d:\d\d redraw failed: the scribe session ended without returning a drawing\. The group keeps its \d\d:\d\d version\.Retry$/.test(failed) &&
                header.endsWith(`Scribe drawing · following ${AGENT_NAME}`) &&
                toast === `Scribe couldn't draw on ${MAIN}run 4842b792: ${FAIL_REASON}Open`;
            return { ok, detail: q({ boardRow, drawing, failed, header, toast }) };
        });

        await run("5b. a draw lands: the source that was drawing gets its draw, and its row trades the drawing mark for the drawn check beside New", async () => {
            const before = await h.ev(`!!${sourceExpr(SRC.rerun.key)}?.querySelector(${q(CHECK)})`);
            const status = await page(h, `return fx.status;`);
            await page(h, `fx.status = ${q({ ...status, sources: status.sources.filter((s) => s.sourcekey !== SRC.rerun.key) })}; return true;`);
            const draw = drawOf(ctx, SRC.rerun, SKELETON.rerun, Date.now());
            await page(h, `fx.inbox.push(${q(draw)}); return true;`);
            await event(h, { channelid: ctx.channelId, boardid: ctx.mainId, what: "draw" });
            const landed = await polishWaitFor(h, `!!${sourceExpr(SRC.rerun.key)}?.querySelector(${q(CHECK)})`, 15000);
            // the drawing note has left (moment 6 exit) once the row's text no longer holds it
            await polishWaitFor(h, `!${sourceExpr(SRC.rerun.key)}?.textContent.includes("stays as drawn")`, 5000);
            await polishNap(500);
            const row = await h.ev(text(sourceExpr(SRC.rerun.key)));
            const mark = await h.ev(`!!${sourceExpr(SRC.rerun.key)}?.querySelector("[data-board-mark]")`);
            const acked = await page(h, `return fx.acks.includes(${q(draw.id)});`);
            await h.shot(`cdp-shots/${NAME}-5b-draw-lands.png`);
            const ok =
                !before &&
                landed &&
                !mark &&
                acked &&
                new RegExp(`^${SRC.rerun.ask}New${AGENT_NAME} · ${SKELETON.rerun.length} shapes · \\d\\d:\\d\\d$`).test(row);
            return { ok, detail: q({ before, landed, mark, acked, row }) };
        });

        await run("5c. stop a follow: Stop's row leaves, and the first source row closes up to where it was, no gap left", async () => {
            const FOLLOW = `${LIST}?.querySelector("[data-board-follow]")`;
            const r = await page(
                h,
                `const list = ${LIST};
                const follow = list?.querySelector("[data-board-follow]");
                if (!follow) return { error: "no follow row" };
                const followTop = follow.getBoundingClientRect().top;
                button(follow, /^Stop$/).click();
                await nap(60);
                const mid = list.querySelector("[data-board-follow]");
                return { followTop, exiting: mid != null ? parseFloat(getComputedStyle(mid).opacity) : null };`
            );
            const gone = await polishWaitFor(h, `!${FOLLOW}`, 5000);
            // the rows below slide up (layout); let that end before measuring
            await polishNap(900);
            const top = await h.ev(`${LIST}?.querySelector("[data-board-source]")?.getBoundingClientRect().top ?? null`);
            const header = await h.ev(text(HEADER));
            await h.shot(`cdp-shots/${NAME}-5c-stop-follow.png`);
            const ok =
                r?.error == null &&
                r.exiting != null &&
                r.exiting < 1 &&
                gone &&
                top != null &&
                Math.abs(top - r.followTop) < 1 &&
                !header.includes("ollowing");
            return { ok, detail: q({ ...r, gone, top, header }) };
        });

        await run("6. won't open (E1): a truncated file's row says won't open, and the board shows the error, its path and Retry; fixed, Retry opens it and its waiting draw lands", async () => {
            await page(h, `fx.status = null; await B.loadBoardStatus(${q(ctx.channelId)}, ${q(ctx.mainId)}); return true;`);
            const info = await h.rpc("boardcreate", { channelid: ctx.channelId, name: BROKEN });
            ctx.brokenId = info.id;
            const whole = readFileSync(info.path, "utf8");
            writeFileSync(info.path, whole.slice(0, Math.floor(whole.length / 2)));
            await page(h, `await B.loadBoardList(${q(ctx.channelId)}); return true;`);
            await h.ev(`${rowExpr(info.id)}?.querySelector("button")?.click()`);
            await polishWaitFor(h, `!!${SURFACE}?.querySelector("[data-board-load-error]")`, 10000);
            const row = await h.ev(text(rowExpr(info.id)));
            const err = await h.ev(text(`${SURFACE}?.querySelector("[data-board-load-error]")`));
            const header = await h.ev(text(HEADER));
            await h.shot(`cdp-shots/${NAME}-6-wont-open.png`);
            const hasRetry = await page(h, `return !!button(${SURFACE}?.querySelector("[data-board-load-error]"), /^Retry$/);`);
            // a draw waits in the inbox, with no draw event: only opening the fixed board can land it
            const waiting = { ...drawOf(ctx, SRC.run, SKELETON.run, Date.now()), boardid: info.id };
            await page(h, `fx.inbox.push(${q(waiting)}); return true;`);
            writeFileSync(info.path, whole);
            await clickIn(h, `${SURFACE}?.querySelector("[data-board-load-error]")`, "/^Retry$/");
            const opened = await polishWaitFor(h, `!!${SURFACE}?.querySelector('[data-board-canvas="${info.id}"] .excalidraw')`, 20000);
            await polishWaitFor(h, `!!window.__boardsFx?.acks.includes(${q(waiting.id)})`, 15000);
            await polishNap(600);
            const landed = await page(
                h,
                `const els = canvasElements() ?? [];
                return {
                    shapes: els.filter((e) => e.customData?.arcSource === ${q(SRC.run.key)} && e.type !== "text").length,
                    acked: fx.acks.includes(${q(waiting.id)}),
                    inbox: fx.inbox.filter((x) => x.boardid === ${q(info.id)}).length,
                };`
            );
            await h.shot(`cdp-shots/${NAME}-6b-retry-lands-waiting-draw.png`);
            const ok =
                opened &&
                landed.shapes === SKELETON.run.length &&
                landed.acked &&
                landed.inbox === 0 &&
                row === `${BROKEN}won't open` &&
                err.startsWith(`Couldn't open ${BROKEN}: its file is not valid Excalidraw JSON`) &&
                err.includes("Arc has not changed the file.") &&
                err.includes(`The file:${info.path}`) &&
                err.endsWith("Fix or restore it, then Retry. Nothing draws on this board until it opens.") &&
                header === `Boards/${BROKEN}won't open` &&
                hasRetry;
            return { ok, detail: q({ row, err, header, hasRetry, opened, landed }) };
        });

        await run("6b. nothing animates on open: from opening a board until its rows have come, nothing in its tree is below full opacity", async () => {
            // sampled every frame in page: the rows arrive with the canvas's scene, after the tree itself mounts
            const r = await page(
                h,
                `const row = ${rowExpr(ctx.mainId)};
                if (!row) return { error: "no main board row" };
                button(row, /./).click();
                const t0 = performance.now();
                let min = 1, minAt = null, frames = 0, loadedAt = null, rows = 0;
                while (performance.now() - t0 < 15000) {
                    await new Promise((res) => { requestAnimationFrame(res); setTimeout(res, 50); });
                    frames++;
                    const group = row.querySelector('[role="group"]');
                    if (group == null) continue;
                    for (const el of [group, ...group.querySelectorAll("*")]) {
                        const o = parseFloat(getComputedStyle(el).opacity);
                        if (o < min) {
                            min = o;
                            minAt = el.tagName + " " + [...el.attributes].map((a) => a.name + "=" + a.value.slice(0, 40)).join(" ");
                        }
                    }
                    if (loadedAt == null && group.querySelector("[data-board-yours]")) {
                        loadedAt = performance.now();
                        rows = group.querySelectorAll("[data-board-source]").length;
                    }
                    if (loadedAt != null && performance.now() - loadedAt > 800) break;
                }
                return { min, minAt, frames, loaded: loadedAt != null, rows };`
            );
            await h.shot(`cdp-shots/${NAME}-6b-open-settled.png`);
            const ok = r?.error == null && r.loaded && r.rows === 3 && r.min === 1;
            return { ok, detail: q(r) };
        });

        await run("7. source row selects group: clicking a source row selects exactly its group's elements on the canvas", async () => {
            await openBoard(h, ctx.mainId);
            await h.ev(`${sourceExpr(SRC.run.key)}?.querySelector("button")?.click()`);
            await polishNap(800);
            const r = await page(
                h,
                `const { scene } = await readBoard(${q(ctx.mainId)});
                const src = scene.arc.sources.find((s) => s.key === ${q(SRC.run.key)});
                const want = scene.elements.filter((e) => e.groupIds.includes(src.groupid)).map((e) => e.id).sort();
                return { want, got: selection(), owns: globalStore.get(B.boardOwnsEscapeAtom) };`
            );
            const selected = await h.ev(`${sourceExpr(SRC.run.key)}?.getAttribute("aria-selected")`);
            await h.shot(`cdp-shots/${NAME}-7-source-selects-group.png`);
            const ok = r.want.length > 0 && q(r.got) === q(r.want) && r.owns === true && selected === "true";
            return { ok, detail: q({ ...r, selected }) };
        });

        await run("8. escape: with a selection, Escape clears it and stays on Boards; again, it goes home", async () => {
            await pressEscape(h);
            await polishNap(500);
            const first = await page(h, `return { sel: selection(), owns: globalStore.get(B.boardOwnsEscapeAtom) };`);
            const after1 = await h.activeSurfaceLabel();
            await h.shot(`cdp-shots/${NAME}-8a-escape-clears.png`);
            await pressEscape(h);
            await polishNap(800);
            const after2 = await h.activeSurfaceLabel();
            await h.shot(`cdp-shots/${NAME}-8b-escape-home.png`);
            const ok = q(first.sel) === "[]" && first.owns === false && after1 === "Boards" && after2 === "Cockpit";
            return { ok, detail: q({ first, after1, after2 }) };
        });

        await run("9. switcher follow: picking another project in the app-bar switcher while on Boards opens its boards, over the landing's", async () => {
            ctx.otherCwd = mkdtempSync(join(tmpdir(), "arc-boards-fx-"));
            ctx.otherProject = OTHER_PROJECT;
            await createProject(h, OTHER_PROJECT, ctx.otherCwd);
            // registering in the app refreshes the channel snapshot; over the bare rpc, the page must
            await page(
                h,
                `const Ch = await mod("app/view/agents/channelsstore.ts");
                await Ch.primeChannels();
                return true;`
            );
            await h.goto("boards");
            await polishWaitFor(h, `!!${SURFACE}`, 10000);
            const before = await page(
                h,
                `window.__boardsPrevScope ??= globalStore.get(model.projectFilterAtom);
                return { pinned: globalStore.get(B.boardsChannelAtom), header: ${text(HEADER)} };`
            );
            await h.ev(`document.querySelector('[data-project-switcher="bar"]')?.click()`);
            await polishWaitFor(h, `!!document.querySelector('[data-project-option="${OTHER_PROJECT}"]')`, 5000);
            const title = await h.ev(`document.querySelector('[data-project-switcher="bar"]')?.getAttribute("title")`);
            await h.ev(`document.querySelector('[data-project-option="${OTHER_PROJECT}"]')?.click()`);
            await polishWaitFor(h, `${text(HEADER)} === "Boards${OTHER_PROJECT}"`, 8000).catch(() => {});
            const after = await page(
                h,
                `return { pinned: globalStore.get(B.boardsChannelAtom), header: ${text(HEADER)}, empty: ${text(`${SURFACE}?.querySelector("[data-boards-empty]")`)} };`
            );
            await h.shot(`cdp-shots/${NAME}-9-switcher-follow.png`);
            const ok =
                before.pinned === ctx.channelId &&
                before.header.startsWith("Boards") &&
                !before.header.includes(OTHER_PROJECT) &&
                title === "Set the project default; Boards opens it" &&
                after.pinned == null &&
                after.header === `Boards${OTHER_PROJECT}` &&
                after.empty.includes(`No boards in ${OTHER_PROJECT} yet`);
            return { ok, detail: q({ before, title, after }) };
        });

        return steps;
    },
    async teardown(h, ctx) {
        await page(
            h,
            `const D = await mod("app/view/agents/devmock.ts");
            for (const k of ${q(STUBBED)}) delete RpcApi[k];
            delete window.__boardsFx;
            globalStore.set(D.devMockAgentsAtom, null);
            globalStore.set(B.boardsChannelAtom, null);
            if (window.__boardsPrevScope != null) globalStore.set(model.projectFilterAtom, window.__boardsPrevScope);
            delete window.__boardsPrevScope;
            return true;`
        ).catch(() => {});
        if (ctx.boardDir) rmSync(ctx.boardDir, { recursive: true, force: true });
        if (ctx.project) await h.rpc("deleteproject", { name: ctx.project });
        if (ctx.cwd) rmSync(ctx.cwd, { recursive: true, force: true });
        if (ctx.otherProject) await h.rpc("deleteproject", { name: ctx.otherProject });
        if (ctx.otherCwd) rmSync(ctx.otherCwd, { recursive: true, force: true });
    },
};

export const BOARDS_SURFACE_SCENARIOS = [boardsSurface];
