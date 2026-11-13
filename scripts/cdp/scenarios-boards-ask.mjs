// Boards scenario `boards-ask` (boards B1-B12, E1): the Boards surface as a conversation with the drawer. The boards
// are real, made through BoardStartCommand with no question (so no drawer runs) in a throwaway project. What would
// start a drawer, or needs a fixed talk, is stubbed in the page: the talk read, the list's talk facts (as wavesrv
// derives them, with an in-flight turn reading "answering" as it does while the drawer runs), Ask, Stop, Retry, the
// choice, and the answer inbox and its ack. Updates reach the page's own board:update handlers, so the real
// applier lands a fed answer on the open canvas and saves it through the real BoardSaveCommand.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    lookEval,
    openPalette,
    PALETTE_INPUT,
    paletteKey,
    paletteStateWhen,
    PEEKS_ESC,
    polishNap,
    polishReload,
    polishWaitFor,
    setInputExpr,
    setPageRoster,
    waitForProjectInConfig,
} from "./scenarios-shared.mjs";

const NAME = "boards-ask";
const PROJECT = "boards-ask-fx";
const SHOT = (board, what) => `cdp-shots/${NAME}-${board}-${what}.png`;
const WAIT_MS = 15_000;
const SEC = 1000;
const MIN = 60 * SEC;
const q = JSON.stringify;
const HHMM = String.raw`\d\d:\d\d`;

const AGENT_ID = "f0a0b0c0-0000-4000-8000-00000000b0a5";
const AGENT_NAME = `claude · ${PROJECT}`;
const PROJECT_ABOUT = { kind: "project", ref: "", title: "" };

const EMPTY_BOARD = "Scratch";
const TALK_BOARD = "Run landing";
const SLOW_BOARD = "Judge latency";
const FAILED_BOARD = "Merge order";
const BRIEFED_BOARD = "Landing internals";
const ASKS_BOARD = "Rerun path";
const HANDOFF_BOARD = "Run landing, retries";
const BROKEN_BOARD = "Orchestrator landing";

const FAIL_REASON = "the drawer's reply was not JSON";
const BRIEFING = {
    from: AGENT_NAME,
    text: "The rerun path skips the judge when the cursor is stale, so a rerun can land unjudged.",
    ask: "how a stale cursor reaches the judge",
};

// the talk board's drawing: its first answer drew three labelled boxes, its second added a box and an arrow
const box = (x, y, text) => ({ type: "rectangle", x, y, width: 180, height: 70, label: { text } });
const FIRST_DRAWING = [box(0, 0, "wavesrv"), box(260, 0, "orchestrate"), box(520, 0, "land")];
const SECOND_DRAWING = [box(260, 160, "merge queue"), { type: "arrow", x: 350, y: 75, width: 0, height: 80 }];
const FED_ANSWER = [box(0, 320, "retry"), box(260, 320, "rebase"), { type: "arrow", x: 185, y: 355, width: 70, height: 0 }];
const START_SHAPES = FIRST_DRAWING.length + SECOND_DRAWING.length;
const QUESTION = "What happens when a landing fails?";

const SURFACE = `document.querySelector("[data-boards-surface]")`;
const HEADER = `${SURFACE}?.querySelector("[data-surface-toolbar]")`;
const TALK = `${SURFACE}?.querySelector("[data-board-talk]")`;
const FORM = `${SURFACE}?.querySelector('[data-board-ask-form="column"]')`;
const NEW_BOARD = `${SURFACE}?.querySelector("[data-boards-new]")`;
const DIALOG = `document.querySelector("[data-new-board-dialog]")`;
const ASK_BOX = `${TALK}?.querySelector("[data-board-ask-box]")`;
const SWITCHER = `${SURFACE}?.querySelector("[data-board-switcher]")`;
const POPOVER = `${SURFACE}?.querySelector("[data-board-switcher-popover]")`;
const canvasOf = (boardId) => `${SURFACE}?.querySelector('[data-board-canvas="${boardId}"] .excalidraw')`;
const itemsOf = (kind) => `[...(${TALK}?.querySelectorAll('[data-board-item="${kind}"]') ?? [])]`;
const text = (expr) => `((${expr})?.textContent ?? "").replace(/\\s+/g, " ").trim()`;

// a textarea's value, set the way React hears it
const setTextareaExpr = (elExpr, value) => `(() => {
    const el = ${elExpr};
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${q(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
})()`;

// page-side: the app's board modules, the stubs' state, and Excalidraw's App component off the canvas's fiber
const PAGE = `
    const B = await mod("app/view/boards/boardstore.ts");
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    const { TabRpcClient } = await mod("app/store/wshrpcutil.ts");
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const fx = (window.__boardsAskFx ??= { talks: {}, answers: [], calls: {} });
    const app = () => {
        const el = document.querySelector(".excalidraw");
        const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
        for (let f = key ? el[key] : null; f != null; f = f.return) {
            if (typeof f.stateNode?.updateScene === "function" && f.stateNode?.scene != null) return f.stateNode;
        }
        return null;
    };
    const selection = () => {
        const ids = app()?.state?.selectedElementIds;
        return ids == null ? null : Object.keys(ids).filter((id) => ids[id]).sort();
    };
    // the canvas's shapes: bound text is part of its container, as the header counts
    const shapes = () =>
        (app()?.scene.getNonDeletedElements() ?? []).filter((e) => !(e.type === "text" && e.containerId != null));
    const feed = async (data) => {
        const W = await mod("app/store/wps.ts");
        W.handleWaveEvent({ event: "board:update", data: { channelid: fx.channelId, ...data } });
    };
    const record = (name, data) => (fx.calls[name] ??= []).push(data);
`;
const page = (h, body) => lookEval(h, `${PAGE} ${body}`);

// the stubs; BoardStartCommand stays real and is only recorded
const STUBBED = [
    "BoardTalkCommand",
    "BoardListCommand",
    "BoardStartCommand",
    "BoardAskCommand",
    "BoardAskStopCommand",
    "BoardAskRetryCommand",
    "BoardAskChoiceCommand",
    "BoardAnswerInboxCommand",
    "BoardAnswerAckCommand",
];
async function installStubs(h, ctx) {
    await page(
        h,
        `fx.channelId = ${q(ctx.channelId)};
        fx.orig ??= { talk: RpcApi.BoardTalkCommand, list: RpcApi.BoardListCommand, start: RpcApi.BoardStartCommand };
        const talkOf = (id) => fx.talks[id];
        RpcApi.BoardTalkCommand = async (c, d) =>
            talkOf(d.boardid) != null ? structuredClone(talkOf(d.boardid)) : fx.orig.talk.call(RpcApi, c, d);
        // wavesrv's list facts (boardstore.applyTalkFacts) over the fixed talks; an in-flight last turn reads
        // "answering", as the drawer's busy state makes it
        RpcApi.BoardListCommand = async (c, d) => {
            const rtn = await fx.orig.list.call(RpcApi, c, d);
            const boards = (rtn?.boards ?? []).map((b) => {
                const talk = talkOf(b.id);
                if (talk == null) return b;
                const info = { ...b, questions: 0, answeredts: 0, activets: b.createdts, state: undefined, about: undefined };
                if (talk.about.kind !== "" && talk.about.kind !== "project") info.about = talk.about.title;
                for (const t of talk.turns) {
                    if (!t.kept && (t.question || t.briefing)) info.questions++;
                    info.answeredts = Math.max(info.answeredts, t.answeredts ?? 0);
                    info.activets = Math.max(info.activets, t.ts, t.answeredts ?? 0);
                }
                const last = talk.turns.at(-1);
                if (last?.state === "answering" || last?.state === "waiting") info.state = "answering";
                else if (last?.state === "asks" && !last.choice) info.state = "asks";
                else if (last?.state === "failed") info.state = "failed";
                return info;
            });
            boards.sort((a, b) => b.activets - a.activets || (a.id < b.id ? -1 : 1));
            return { ...rtn, boards };
        };
        RpcApi.BoardStartCommand = async (c, d) => {
            record("start", d);
            return fx.orig.start.call(RpcApi, c, d);
        };
        RpcApi.BoardAskCommand = async (_c, d) => {
            record("ask", d);
            fx.talks[d.boardid].turns.push({
                id: "asked-" + fx.calls.ask.length, ts: Date.now(), question: d.question, on: d.on,
                selectedids: d.selectedids, state: "answering",
            });
            await feed({ boardid: d.boardid, what: "talk" });
        };
        RpcApi.BoardAskStopCommand = async (_c, d) => {
            record("stop", d);
            const t = fx.talks[d.boardid].turns.find((t) => t.state === "answering");
            if (t) t.state = "stopped";
            await feed({ boardid: d.boardid, what: "talk" });
        };
        RpcApi.BoardAskRetryCommand = async (_c, d) => record("retry", d);
        // Keep records the choice on the asking turn and runs a kept turn on this board (decision 15)
        RpcApi.BoardAskChoiceCommand = async (_c, d) => {
            record("choice", d);
            const talk = fx.talks[d.boardid];
            const t = talk?.turns.find((t) => t.id === d.turnid);
            if (t == null) return;
            t.choice = d.choice;
            if (d.choice === "keep") {
                talk.turns.push({ id: d.turnid + "-kept", ts: Date.now(), kept: true, question: t.briefing?.ask, state: "answering" });
            }
            await feed({ boardid: d.boardid, what: "talk" });
        };
        RpcApi.BoardAnswerInboxCommand = async (_c, d) =>
            structuredClone(fx.answers.filter((a) => !d?.boardid || a.boardid === d.boardid));
        // the ack answers the turn with the shapes the frontend reports, as wavesrv does
        RpcApi.BoardAnswerAckCommand = async (_c, d) => {
            record("ack", d);
            const answer = fx.answers.find((a) => a.id === d.answerid);
            fx.answers = fx.answers.filter((a) => a.id !== d.answerid);
            const t = fx.talks[d.boardid]?.turns.find((t) => t.id === d.turnid);
            if (t != null && answer != null) {
                Object.assign(t, answer.turn, { state: "answered", shapeids: d.shapeids, answeredts: Date.now() });
            }
            await feed({ boardid: d.boardid, turnid: d.turnid, what: "talk" });
        };
        return true;`
    );
}

// makes a throwaway project and waits for the channel wavesrv gives it
async function createProject(h, name, path) {
    await h.rpc("createproject", { name, path });
    await waitForProjectInConfig(h, name);
    for (let waited = 0; waited < 10_000; waited += 250) {
        const channel = ((await h.rpc("getchannels", null))?.channels ?? []).find((c) => c.name === name);
        if (channel != null) return channel;
        await polishNap(250);
    }
    throw new Error(`project ${name} never got a channel`);
}

// a real board with no question, its drawing converted in the page, and a fixed talk; returns the board and the
// element ids of each drawing given
async function makeBoard(h, ctx, name, { about = PROJECT_ABOUT, drawings = [], talk = null } = {}) {
    const r = await page(
        h,
        `const C = await mod("app/view/boards/boardconvert.ts");
        const drawings = ${q(drawings)}.map((d) => C.convertSkeleton(JSON.stringify(d)));
        const elements = drawings.flat();
        const info = await RpcApi.BoardStartCommand(TabRpcClient, {
            channelid: fx.channelId, name: ${q(name)}, about: ${q(about)},
            elements: elements.length > 0 ? JSON.stringify(elements) : undefined,
        });
        // a drawing's shapes: bound text is part of its container
        const ids = drawings.map((els) => els.filter((e) => !(e.type === "text" && e.containerId != null)).map((e) => e.id));
        const byLabel = {};
        for (const e of elements) if (e.type === "text" && e.containerId != null) byLabel[e.text] = e.containerId;
        return { info, ids, byLabel };`
    );
    ctx.boardDir ??= dirname(r.info.path);
    if (talk != null) await setTalk(h, r.info.id, talk(r));
    return r;
}

const setTalk = (h, boardId, talk) =>
    page(h, `fx.talks[${q(boardId)}] = ${q({ channelid: "", boardid: boardId, about: PROJECT_ABOUT, ...talk })};
        fx.talks[${q(boardId)}].channelid = fx.channelId;
        return true;`);

const patchTurn = (h, boardId, turnId, patch) =>
    page(h, `Object.assign(fx.talks[${q(boardId)}].turns.find((t) => t.id === ${q(turnId)}), ${q(patch)});
        await feed({ boardid: ${q(boardId)}, what: "talk" });
        return true;`);

// opens a board as a landing does, and waits for its talk and, unless it won't open, its canvas
async function openBoard(h, ctx, boardId, { canvas = true } = {}) {
    await page(h, `await B.loadBoardList(fx.channelId); B.selectBoard(fx.channelId, ${q(boardId)}); return true;`);
    if (!(await polishWaitFor(h, `!!${TALK}`, WAIT_MS))) throw new Error(`board ${boardId} never showed its talk`);
    if (canvas && !(await polishWaitFor(h, `!!${canvasOf(boardId)}`, 20_000))) {
        throw new Error(`board ${boardId} never opened its canvas`);
    }
    await polishNap(800);
}

const calls = (h, name) => page(h, `return fx.calls[${q(name)}] ?? [];`);

// Escape as the shell's dispatcher sees it, with focus on the given element (outside any field)
const pressEscapeOn = (h, focusExpr) =>
    h.ev(`(() => {
        document.activeElement?.blur?.();
        (${focusExpr})?.focus?.();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    })()`);

const toastWith = (needle) =>
    `[...document.querySelectorAll("[data-notification-toast]")].find((t) => t.textContent.includes(${q(needle)}))`;

export const boardsAsk = {
    name: NAME,
    surface: "boards",
    async arrange(h) {
        const ctx = { boards: {} };
        try {
            ctx.cwd = mkdtempSync(join(tmpdir(), "arc-boards-ask-"));
            ctx.project = PROJECT;
            ctx.channelId = (await createProject(h, PROJECT, ctx.cwd)).oid;
            await polishReload(h);
            await installStubs(h, ctx);
            await page(h, `B.selectBoard(fx.channelId, ""); return true;`);
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

        await run("1. B12 no boards: the shared empty state, New board and the palette hint; New board opens the dialog with Name focused, an empty name says Type a name first, Cancel closes it", async () => {
            await h.goto("boards");
            await polishWaitFor(h, `!!${SURFACE}?.querySelector("[data-boards-empty]")`, WAIT_MS);
            const empty = await h.ev(text(`${SURFACE}?.querySelector("[data-boards-empty]")`));
            const hint = await h.ev(text(`${SURFACE}?.querySelector("[data-boards-empty-hint]")`));
            const button = await h.ev(text(NEW_BOARD));
            await h.shot(SHOT("B12", "no-boards"));
            await h.ev(`${NEW_BOARD}?.click()`);
            await polishWaitFor(h, `!!${DIALOG}`, 5000);
            await polishNap(400);
            // the dialog's order: Name, First question, Cancel, Ask; a project board shows no About
            const dialog = await h.ev(`(() => {
                const f = ${DIALOG};
                if (!f) return null;
                const n = f.querySelector('input[type="text"]'), qn = f.querySelector("textarea");
                const ask = f.querySelector("[data-board-form-ask]"), cancel = f.querySelector("[data-board-form-cancel]");
                const before = (x, y) => !!(x && y && x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
                const label = (el) => (el ? f.querySelector('label[for="' + el.id + '"]')?.textContent.trim() : null);
                return {
                    name: label(n), question: label(qn), about: !!f.querySelector("[data-board-about]"),
                    ask: ask?.textContent.trim(), cancel: cancel?.textContent.trim(),
                    ordered: before(n, qn) && before(qn, cancel) && before(cancel, ask),
                    nameFocused: document.activeElement === n,
                };
            })()`);
            const footer = await h.ev(text(DIALOG));
            await h.shot(SHOT("B12", "new-board-dialog"));
            await h.ev(`${DIALOG}?.querySelector("[data-board-form-ask]")?.click()`);
            await polishWaitFor(h, `!!${DIALOG}?.querySelector("[data-board-form-error]")`, 5000);
            const refused = await h.ev(text(`${DIALOG}?.querySelector("[data-board-form-error]")`));
            await h.ev(`${DIALOG}?.querySelector("[data-board-form-cancel]")?.click()`);
            const closed = await polishWaitFor(h, `!${DIALOG}`, 5000);
            const ok =
                empty.includes(`No boards in ${PROJECT} yet`) &&
                empty.includes("A board is a conversation with a drawer.") &&
                button === "New board" &&
                hint.includes("Ask a board about this…") &&
                dialog?.name === "Name" &&
                dialog.question === "First question" &&
                !dialog.about &&
                dialog.cancel?.startsWith("Cancel") &&
                dialog.ask?.startsWith("Ask") &&
                dialog.ordered &&
                dialog.nameFocused &&
                footer.includes(`The drawer reads ${PROJECT}`) &&
                refused === "Type a name first" &&
                closed;
            return { ok, detail: q({ empty, hint, button, dialog, footer, refused, closed }) };
        });

        await run("2. B3 ask something new: the column form and the waiting canvas; an empty name says Type a name first; Esc on its buttons cancels and Boards stays", async () => {
            // what the switcher's + Ask something new requests (the switcher itself is step 9)
            await page(h, `const F = await mod("app/view/boards/boardformrequest.ts");
                globalStore.set(F.boardFormAtom, { kind: "new", channelId: fx.channelId });
                return true;`);
            await polishWaitFor(h, `!!${FORM}`, WAIT_MS);
            const form = await h.ev(text(FORM));
            const nameFocused = await h.ev(`document.activeElement === ${FORM}?.querySelector('input[type="text"]')`);
            const waiting = await h.ev(text(`${SURFACE}?.querySelector("[data-board-canvas-waiting]")`));
            const header = await h.ev(text(HEADER));
            await h.ev(`${FORM}?.querySelector("[data-board-form-ask]")?.click()`);
            await polishWaitFor(h, `!!${FORM}?.querySelector("[data-board-form-error]")`, 5000);
            const refused = await h.ev(text(`${FORM}?.querySelector("[data-board-form-error]")`));
            await h.shot(SHOT("B3", "ask-something-new"));
            await pressEscapeOn(h, `${FORM}?.querySelector("[data-board-form-cancel]")`);
            const closed = await polishWaitFor(h, `!${FORM} && !!${SURFACE}?.querySelector("[data-boards-empty]")`, 5000);
            const surface = await h.activeSurfaceLabel();
            const ok =
                form.startsWith("Ask something new") &&
                form.includes("Name") &&
                form.includes("First question") &&
                form.includes(`Aboutthe ${PROJECT} code`) &&
                form.includes("the drawer reads the project's code") &&
                form.includes("Ctrl Enter asks · Esc cancels") &&
                nameFocused &&
                waiting === "The drawer draws here once you ask." &&
                header === `Boards/New boardin ${PROJECT}` &&
                refused === "Type a name first" &&
                closed &&
                surface === "Boards";
            return { ok, detail: q({ form, nameFocused, waiting, header, refused, closed, surface }) };
        });

        await run("3. B11 empty board: Ask with a name and no question makes the board, with nothing asked and nothing drawn", async () => {
            await h.ev(`${NEW_BOARD}?.click()`);
            await polishWaitFor(h, `!!${DIALOG}`, 5000);
            await h.ev(setInputExpr(`${DIALOG}?.querySelector('input[type="text"]')`, EMPTY_BOARD));
            await h.ev(`${DIALOG}?.querySelector("[data-board-form-ask]")?.click()`);
            await polishWaitFor(h, `!!${SURFACE}?.querySelector("[data-board-empty]") && !!${TALK}`, 20_000);
            const started = (await calls(h, "start")).at(-1);
            ctx.boards.empty = (await h.rpc("boardlist", { channelid: ctx.channelId }))?.boards?.find((b) => b.name === EMPTY_BOARD);
            ctx.boardDir ??= ctx.boards.empty && dirname(ctx.boards.empty.path);
            await polishNap(600);
            const talk = await h.ev(text(`${TALK}?.querySelector("[data-board-talk-empty]")`));
            const canvas = await h.ev(text(`${SURFACE}?.querySelector("[data-board-empty]")`));
            const facts = await h.ev(text(`${SURFACE}?.querySelector("[data-board-facts]")`));
            const name = await h.ev(text(SWITCHER));
            await h.shot(SHOT("B11", "empty-board"));
            const ok =
                started?.name === EMPTY_BOARD &&
                !started.question &&
                ctx.boards.empty != null &&
                talk.startsWith("Nothing asked on this board yet") &&
                canvas.startsWith("Nothing on this board yet") &&
                new RegExp(`^empty · created ${HHMM}$`).test(facts) &&
                name === EMPTY_BOARD;
            return { ok, detail: q({ started, talk, canvas, facts, name }) };
        });

        await run("4. B1 talk: About, two questions on wavesrv with replies and cards; Show selects the card's shapes; a selection names itself; Ask sends it; a fed answer lands live, is acked with its shapes, and one undo takes it back", async () => {
            const now = Date.now();
            const made = await makeBoard(h, ctx, TALK_BOARD, {
                drawings: [FIRST_DRAWING, SECOND_DRAWING],
                talk: ({ ids, byLabel }) => ({
                    turns: [
                        {
                            id: "t1", ts: now - 40 * MIN, question: "How does a run land?", on: "wavesrv",
                            selectedids: [byLabel.wavesrv], state: "answered", reply: "wavesrv hands the plan to orchestrate, which lands it.",
                            title: "How a run lands", added: FIRST_DRAWING.length, shapeids: ids[0], answeredts: now - 39 * MIN,
                        },
                        {
                            id: "t2", ts: now - 20 * MIN, question: "Where do merges wait?", on: "wavesrv",
                            selectedids: [byLabel.wavesrv], state: "answered", reply: "In the merge queue, one at a time.",
                            title: "The merge queue", added: SECOND_DRAWING.length, shapeids: ids[1], answeredts: now - 19 * MIN,
                        },
                    ],
                }),
            });
            ctx.boards.talk = made.info;
            await openBoard(h, ctx, made.info.id);
            const id = made.info.id;
            const about = await h.ev(text(`${TALK}?.querySelector("[data-board-about]")`));
            const questions = await h.ev(`${itemsOf("question")}.map((e) => e.textContent.replace(/\\s+/g, " ").trim())`);
            const cards = await h.ev(`[...(${TALK}?.querySelectorAll("[data-board-card]") ?? [])].map((e) => e.textContent.replace(/\\s+/g, " ").trim())`);
            const factsBefore = await h.ev(text(`${SURFACE}?.querySelector("[data-board-facts]")`));

            // Show selects exactly the card's shapes; again, it clears
            await h.ev(`${TALK}?.querySelector('[data-board-show="t2"]')?.click()`);
            await polishNap(500);
            const shown = await page(h, `return selection();`);
            const pressed = await h.ev(`${TALK}?.querySelector('[data-board-show="t2"]')?.getAttribute("aria-pressed")`);
            await h.shot(SHOT("B1", "show"));
            await h.ev(`${TALK}?.querySelector('[data-board-show="t2"]')?.click()`);
            await polishNap(400);
            const cleared = await page(h, `return selection();`);

            // a shape selected on the canvas names itself in the ask box
            await page(h, `app().updateScene({ appState: { selectedElementIds: { ${q(made.byLabel.wavesrv)}: true } }, captureUpdate: "NEVER" }); return true;`);
            await polishWaitFor(h, `${text(`${ASK_BOX}?.querySelector("[data-board-ask-hint]")`)}.startsWith("Selected")`, 5000);
            const hint = await h.ev(text(`${ASK_BOX}?.querySelector("[data-board-ask-hint]")`));

            // Ask sends the question, the selection's label and its ids
            await h.ev(setTextareaExpr(`${ASK_BOX}?.querySelector("textarea")`, QUESTION));
            await h.ev(`[...(${ASK_BOX}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Ask")?.click()`);
            await polishWaitFor(h, `${itemsOf("working")}.length === 1`, WAIT_MS);
            const asked = (await calls(h, "ask")).at(-1);

            // the drawer's answer, fed to the page's own applier: it lands live and is acked with its shapes
            const answerId = randomUUID();
            const turnId = "asked-1";
            await page(
                h,
                `fx.answers.push({
                    id: ${q(answerId)}, channelid: fx.channelId, boardid: ${q(id)}, turnid: ${q(turnId)},
                    add: ${q(JSON.stringify(FED_ANSWER))}, ts: Date.now(),
                    turn: { reply: "A failed landing retries after a rebase.", title: "Retrying a landing", added: ${FED_ANSWER.length} },
                });
                await feed({ boardid: ${q(id)}, what: "answer" });
                return true;`
            );
            await polishWaitFor(h, `!!window.__boardsAskFx?.calls.ack?.length`, WAIT_MS);
            await polishWaitFor(h, `${itemsOf("reply")}.length === 3`, WAIT_MS);
            await polishNap(800);
            const ack = (await calls(h, "ack")).at(-1);
            const landed = await page(h, `const ids = new Set(shapes().map((e) => e.id));
                return { shapes: ids.size, acked: ${q(ack?.shapeids ?? [])}.every((id) => ids.has(id)) };`);
            const factsAfter = await h.ev(text(`${SURFACE}?.querySelector("[data-board-facts]")`));
            const lastCard = await h.ev(text(`${TALK}?.querySelector('[data-board-card="${turnId}"]')`));
            await h.shot(SHOT("B1", "talk"));

            // one undo takes the whole answer back
            await h.ev(`${canvasOf(id)}?.querySelector('[data-testid="button-undo"]')?.click()`);
            await polishNap(600);
            const undone = await page(h, `const ids = new Set(shapes().map((e) => e.id));
                return { shapes: ids.size, gone: ${q(ack?.shapeids ?? [])}.every((id) => !ids.has(id)) };`);
            await h.shot(SHOT("B1", "undo"));

            const ok =
                about === `Aboutthe ${PROJECT} code` &&
                q(questions) === q(["How does a run land?on wavesrv", "Where do merges wait?on wavesrv"]) &&
                cards.length === 2 &&
                new RegExp(`^How a run landsdrew ${FIRST_DRAWING.length} shapes · ${HHMM}Show$`).test(cards[0]) &&
                new RegExp(`^The merge queueadded ${SECOND_DRAWING.length} shapes · ${HHMM}Show$`).test(cards[1]) &&
                new RegExp(`^2 questions · ${START_SHAPES} shapes · answered ${HHMM}$`).test(factsBefore) &&
                q(shown) === q([...made.ids[1]].sort()) &&
                pressed === "true" &&
                q(cleared) === "[]" &&
                hint === "Selectedwavesrv" &&
                asked?.question === QUESTION &&
                asked.on === "wavesrv" &&
                q(asked.selectedids) === q([made.byLabel.wavesrv]) &&
                ack?.answerid === answerId &&
                ack.turnid === turnId &&
                ack.shapeids?.length === FED_ANSWER.length &&
                landed.acked &&
                landed.shapes === START_SHAPES + FED_ANSWER.length &&
                new RegExp(`^3 questions · ${START_SHAPES + FED_ANSWER.length} shapes · answered ${HHMM}$`).test(factsAfter) &&
                new RegExp(`^Retrying a landingadded ${FED_ANSWER.length} shapes · ${HHMM}Show$`).test(lastCard) &&
                undone.gone &&
                undone.shapes === START_SHAPES;
            return {
                ok,
                detail: q({ about, questions, cards, factsBefore, shown, want: made.ids[1], pressed, cleared, hint, asked, ack, landed, factsAfter, lastCard, undone }),
            };
        });

        await run("5. B4 answering: Answering N s under the question, and Stop in Ask's place until the answer lands", async () => {
            const made = await makeBoard(h, ctx, SLOW_BOARD, {
                talk: () => ({ turns: [{ id: "s1", ts: Date.now() - 12 * SEC, question: "Why is the judge slow?", state: "answering" }] }),
            });
            ctx.boards.slow = made.info;
            await openBoard(h, ctx, made.info.id);
            const order = await h.ev(`[...(${TALK}?.querySelectorAll("[data-board-item]") ?? [])].map((e) => e.getAttribute("data-board-item"))`);
            const working = await h.ev(text(`${itemsOf("working")}[0]`));
            const box = await h.ev(`(() => {
                const b = ${ASK_BOX};
                const ask = [...(b?.querySelectorAll("button") ?? [])].find((x) => x.textContent.trim() === "Ask");
                const stop = b?.querySelector("[data-board-ask-stop]");
                const r = stop?.getBoundingClientRect();
                return {
                    disabled: b?.getAttribute("aria-disabled"),
                    ask: !!ask,
                    stop: (stop?.textContent ?? "").trim(),
                    stopSize: r ? [Math.round(r.width), Math.round(r.height)] : null,
                    hint: (b?.querySelector("[data-board-ask-hint]")?.textContent ?? "").trim(),
                };
            })()`);
            ctx.stopSize = box.stopSize;
            await h.shot(SHOT("B4", "answering"));
            const ok =
                q(order) === q(["question", "working"]) &&
                /^Answering\d+ s$/.test(working) &&
                box.disabled === "true" &&
                !box.ask &&
                box.stop === "Stop" &&
                box.hint === "You can ask once this answer lands";
            return { ok, detail: q({ order, working, box }) };
        });

        await run("6. B5 slow: past 90 s it says Still answering and offers Stop, which stops the turn", async () => {
            const id = ctx.boards.slow?.id;
            await patchTurn(h, id, "s1", { ts: Date.now() - 95 * SEC });
            await polishWaitFor(h, `${text(`${itemsOf("working")}[0]`)}.startsWith("Still answering")`, WAIT_MS);
            const working = await h.ev(text(`${itemsOf("working")}[0]`));
            await h.shot(SHOT("B5", "slow"));
            await h.ev(`${TALK}?.querySelector("[data-board-stop]")?.click()`);
            await polishWaitFor(h, `${itemsOf("stopped")}.length === 1`, WAIT_MS);
            const stop = await calls(h, "stop");
            const stopped = await h.ev(text(`${itemsOf("stopped")}[0]`));
            const ok =
                /^Still answering1 min 3\d sThis is taking/.test(working) &&
                working.endsWith("This is taking longer than most answers. Stop it to ask something narrower; nothing on the board changes.Stop") &&
                stop.length === 1 &&
                stop[0].channelid === ctx.channelId &&
                stop[0].boardid === id &&
                stopped === "Stopped. Nothing on the board changed.";
            return { ok, detail: q({ working, stop, stopped }) };
        });

        await run("6b. Stop in the ask box stops a running answer; Ask comes back the same size", async () => {
            const id = ctx.boards.slow?.id;
            await patchTurn(h, id, "s1", { state: "answering", ts: Date.now() - 12 * SEC });
            await polishWaitFor(h, `!!${ASK_BOX}?.querySelector("[data-board-ask-stop]")`, WAIT_MS);
            await h.ev(`${ASK_BOX}?.querySelector("[data-board-ask-stop]")?.click()`);
            await polishWaitFor(h, `${itemsOf("stopped")}.length === 1 && ${itemsOf("working")}.length === 0`, WAIT_MS);
            const stop = await calls(h, "stop");
            const ask = await h.ev(`(() => {
                const b = [...(${ASK_BOX}?.querySelectorAll("button") ?? [])].find((x) => x.textContent.trim() === "Ask");
                const r = b?.getBoundingClientRect();
                return { found: !!b, size: r ? [Math.round(r.width), Math.round(r.height)] : null, stop: !!${ASK_BOX}?.querySelector("[data-board-ask-stop]") };
            })()`);
            await h.shot(SHOT("B5", "stopped-from-input"));
            const ok =
                stop.length === 2 &&
                stop[1].boardid === id &&
                ask.found &&
                !ask.stop &&
                q(ask.size) === q(ctx.stopSize);
            return { ok, detail: q({ stop, ask, stopSize: ctx.stopSize }) };
        });

        await run("7. B6 failed: Couldn't answer with the reason and Nothing on the board changed; Retry asks again for that turn", async () => {
            const made = await makeBoard(h, ctx, FAILED_BOARD, {
                talk: () => ({
                    turns: [{ id: "f1", ts: Date.now() - 3 * MIN, question: "Which merge goes first?", state: "failed", reason: FAIL_REASON, answeredts: Date.now() - 2 * MIN }],
                }),
            });
            ctx.boards.failed = made.info;
            await openBoard(h, ctx, made.info.id);
            const failed = await h.ev(text(`${itemsOf("failed")}[0]`));
            await h.shot(SHOT("B6", "failed"));
            await h.ev(`${TALK}?.querySelector('[data-board-retry="f1"]')?.click()`);
            await polishWaitFor(h, `!!window.__boardsAskFx?.calls.retry?.length`, 5000);
            const retry = await calls(h, "retry");
            const ok =
                new RegExp(`^Couldn't answer${HHMM}The drawer's reply was not JSON\\. Nothing on the board changed\\. Retry asks the same question again\\.Retry$`).test(failed) &&
                retry.length === 1 &&
                retry[0].turnid === "f1" &&
                retry[0].boardid === made.info.id;
            return { ok, detail: q({ failed, retry }) };
        });

        await run("8. B7 new info: the briefing and the drawer's question; New board from this opens the form on the briefing with no drawing; Keep it here records keep", async () => {
            const now = Date.now();
            const made = await makeBoard(h, ctx, BRIEFED_BOARD, {
                drawings: [FIRST_DRAWING],
                talk: ({ ids }) => ({
                    turns: [
                        {
                            id: "r1", ts: now - 30 * MIN, question: "What lands a run?", state: "answered", reply: "orchestrate lands it after Final.",
                            title: "What lands a run", added: FIRST_DRAWING.length, shapeids: ids[0], answeredts: now - 29 * MIN,
                        },
                        {
                            id: "r2", ts: now - 5 * MIN, briefing: BRIEFING, state: "asks", answeredts: now - 4 * MIN,
                            reply: "This briefing is about the rerun path, not the landing this board explains.",
                        },
                    ],
                }),
            });
            ctx.boards.briefed = made.info;
            await openBoard(h, ctx, made.info.id);
            const briefing = await h.ev(text(`${itemsOf("briefing")}[0]`));
            const asks = await h.ev(text(`${itemsOf("asks")}[0]`));
            await h.shot(SHOT("B7", "new-info"));

            await h.ev(`${TALK}?.querySelector('[data-board-choice="new"]')?.click()`);
            await polishWaitFor(h, `!!${FORM}`, WAIT_MS);
            await polishNap(400);
            const form = await h.ev(`(() => {
                const f = ${FORM};
                return {
                    title: f?.querySelector("h2")?.textContent.trim(),
                    about: (f?.querySelector("[data-board-about]")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
                    question: f?.querySelector("textarea")?.value,
                    startsWith: !!f?.querySelector("[data-board-starts-with]"),
                };
            })()`);
            const waiting = await h.ev(`!!${SURFACE}?.querySelector("[data-board-canvas-waiting]")`);
            await h.shot(SHOT("B7", "new-board-form"));
            await pressEscapeOn(h, `${FORM}?.querySelector("[data-board-form-cancel]")`);
            await polishWaitFor(h, `!${FORM} && !!${TALK}`, 5000);

            await h.ev(`${TALK}?.querySelector('[data-board-choice="keep"]')?.click()`);
            await polishWaitFor(h, `${text(`${itemsOf("asks")}[0]`)}.endsWith("Kept here")`, WAIT_MS);
            const choice = await calls(h, "choice");
            const kept = await h.ev(text(`${itemsOf("asks")}[0]`));
            const ok =
                new RegExp(`^${BRIEFING.from}sent a briefing · ${HHMM}${BRIEFING.text}Ask: ${BRIEFING.ask}$`).test(briefing) &&
                asks.includes("New board from this") &&
                asks.includes("Keep it here") &&
                form.title === "Ask something new" &&
                form.about === `About${BRIEFING.from}The drawer starts from this briefing and reads the project's code.` &&
                form.question === BRIEFING.ask &&
                !form.startsWith &&
                waiting &&
                choice.length === 1 &&
                choice[0].turnid === "r2" &&
                choice[0].choice === "keep" &&
                kept.endsWith("Kept here");
            return { ok, detail: q({ briefing, asks, form, waiting, choice, kept }) };
        });

        await run("9. B2 switcher: the header's board name opens Ask something new, then the project's boards newest first with their questions, about and marks", async () => {
            const now = Date.now();
            const made = await makeBoard(h, ctx, ASKS_BOARD, {
                about: { kind: "agent", ref: AGENT_ID, title: AGENT_NAME, runtime: "claude" },
                talk: () => ({
                    about: { kind: "agent", ref: AGENT_ID, title: AGENT_NAME, runtime: "claude" },
                    turns: [{ id: "a1", ts: now - 2 * MIN, briefing: { ...BRIEFING, ask: "the rerun's judge" }, state: "asks", reply: "Does this belong on a new board?", answeredts: now - MIN }],
                }),
            });
            ctx.boards.asks = made.info;
            await openBoard(h, ctx, ctx.boards.talk.id);
            await h.ev(`${SWITCHER}?.click()`);
            await polishWaitFor(h, `!!${POPOVER}`, 5000);
            await polishNap(400);
            const pop = await page(h, `const p = ${POPOVER};
                const rows = [...(p?.querySelectorAll("[data-board-switcher-row]") ?? [])].map((r) => ({
                    id: r.getAttribute("data-board-switcher-row"),
                    text: r.textContent.replace(/\\s+/g, " ").trim(),
                    mark: r.querySelector("[data-board-switcher-mark]")?.getAttribute("data-board-switcher-mark") ?? null,
                }));
                const list = globalStore.get(B.boardListAtom(fx.channelId))?.boards ?? [];
                return {
                    first: p?.querySelector("button")?.hasAttribute("data-board-ask-new") ?? false,
                    askNew: (p?.querySelector("[data-board-ask-new]")?.textContent ?? "").trim(),
                    heading: (p?.querySelector("[data-board-switcher-heading]")?.textContent ?? "").trim(),
                    rows,
                    newestFirst:
                        list.every((b, i) => i === 0 || list[i - 1].activets >= b.activets) &&
                        JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(list.map((b) => b.id)),
                };`);
            await h.shot(SHOT("B2", "switcher"));
            const row = (board) => pop.rows.find((r) => r.id === board?.id);
            const ok =
                pop.first &&
                pop.askNew === "+Ask something new" &&
                pop.heading === `6 boards in ${PROJECT}` &&
                pop.rows.length === 6 &&
                pop.newestFirst &&
                row(ctx.boards.talk)?.text.endsWith(`3 questions · the ${PROJECT} code`) &&
                row(ctx.boards.asks)?.text === `${ASKS_BOARD}asks you1 question · ${AGENT_NAME}` &&
                row(ctx.boards.briefed)?.mark === "answering" &&
                row(ctx.boards.asks)?.mark === "asks" &&
                row(ctx.boards.failed)?.mark === "failed" &&
                row(ctx.boards.slow)?.mark === null &&
                new RegExp(`^${EMPTY_BOARD}${HHMM}0 questions · the ${PROJECT} code$`).test(row(ctx.boards.empty)?.text ?? "");
            await h.ev(`${SWITCHER}?.click()`);
            await polishWaitFor(h, `!${POPOVER}`, 3000);
            return { ok, detail: q(pop) };
        });

        await run("10. B8 handoff: New board from this says what it starts with, keeps the drawing on the canvas, and Ask starts a board from it with a copy under new ids", async () => {
            const from = ctx.boards.talk;
            await h.ev(`${SURFACE}?.querySelector("[data-board-handoff]")?.click()`);
            await polishWaitFor(h, `!!${FORM}`, WAIT_MS);
            await polishNap(400);
            const title = await h.ev(text(`${FORM}?.querySelector("h2")`));
            const form = await h.ev(text(FORM));
            const startsWith = await h.ev(`[...(${FORM}?.querySelector("[data-board-starts-with]")?.children ?? [])].map((e) => e.textContent.trim())`);
            const canvas = await h.ev(`!!${canvasOf(from.id)}`);
            const header = await h.ev(text(HEADER));
            await h.shot(SHOT("B8", "handoff"));
            const fileIds = JSON.parse(readFileSync(from.path, "utf8")).elements.map((e) => e.id);
            await h.ev(setInputExpr(`${FORM}?.querySelector('input[type="text"]')`, HANDOFF_BOARD));
            await h.ev(`${FORM}?.querySelector("[data-board-form-ask]")?.click()`);
            await polishWaitFor(h, `${text(SWITCHER)} === ${q(HANDOFF_BOARD)}`, 20_000);
            const started = (await calls(h, "start")).at(-1);
            const copied = JSON.parse(started?.elements ?? "[]");
            const copiedShapes = copied.filter((e) => !(e.type === "text" && e.containerId != null)).length;
            ctx.boards.handoff = (await h.rpc("boardlist", { channelid: ctx.channelId }))?.boards?.find((b) => b.name === HANDOFF_BOARD);
            const ok =
                title === `New board from ${TALK_BOARD}` &&
                form.includes("It starts with") &&
                q(startsWith) ===
                    q([
                        `A summary of ${TALK_BOARD}'s 3 questions, written by its drawer`,
                        `Its drawing, copied: ${START_SHAPES} shapes, free to change`,
                        `${TALK_BOARD} and its talk stay as they are.`,
                    ]) &&
                canvas &&
                header === `Boards/New boardfrom ${TALK_BOARD}` &&
                started?.name === HANDOFF_BOARD &&
                started.fromboardid === from.id &&
                copied.length === fileIds.length &&
                copiedShapes === START_SHAPES &&
                copied.every((e) => !fileIds.includes(e.id)) &&
                ctx.boards.handoff != null;
            return { ok, detail: q({ title, startsWith, canvas, header, fromboardid: started?.fromboardid, copied: copied.length, copiedShapes, fileIds: fileIds.length }) };
        });

        await run("11. B9 from palette: Ask a board about this… on an agent lands on Boards with the form on the agent, its question focused", async () => {
            await setPageRoster(h, [
                { id: AGENT_ID, name: AGENT_NAME, task: "", state: "idle", agent: "claude", blockId: "fx-board-ask-blk", cwd: ctx.cwd, project: PROJECT },
            ]);
            await h.goto("cockpit");
            if (!(await openPalette(h))) return { ok: false, detail: "the palette input never showed" };
            await h.ev(setInputExpr(PALETTE_INPUT, `a:${AGENT_NAME}`));
            await paletteStateWhen(h, (s) => (s.selected ?? "").includes(AGENT_NAME) && s.chip, 5000);
            await h.ev(paletteKey("ArrowRight"));
            await paletteStateWhen(h, (s) => s.drill != null, 5000);
            await h.ev(setInputExpr(PALETTE_INPUT, "ask a board"));
            const action = await paletteStateWhen(h, (s) => (s.selected ?? "").startsWith("Ask a board about this…"), 5000);
            await h.ev(paletteKey("Enter"));
            await polishWaitFor(h, `!!${FORM}`, WAIT_MS);
            await polishNap(500);
            const surface = await h.activeSurfaceLabel();
            const form = await h.ev(`(() => {
                const f = ${FORM};
                const about = f?.querySelector("[data-board-about]");
                return {
                    title: f?.querySelector("h2")?.textContent.trim(),
                    about: (about?.textContent ?? "").replace(/\\s+/g, " ").trim(),
                    dot: !!about?.querySelector("span.rounded-full"),
                    focused: document.activeElement === f?.querySelector("textarea"),
                };
            })()`);
            await h.shot(SHOT("B9", "from-palette"));
            await pressEscapeOn(h, `${FORM}?.querySelector("[data-board-form-cancel]")`);
            await polishWaitFor(h, `!${FORM}`, 5000);
            const ok =
                (action?.selected ?? "").startsWith("Ask a board about this…") &&
                surface === "Boards" &&
                form.title === "Ask a board about this" &&
                form.about === `About${AGENT_NAME}The drawer starts from this agent's session and reads the project's code.` &&
                form.dot &&
                form.focused;
            return { ok, detail: q({ selected: action?.selected, surface, form }) };
        });

        await run("12. B10 toasts: a briefing answered and a briefing that asks each raise their toast with Open, which lands on that board", async () => {
            const id = ctx.boards.asks.id;
            await page(h, `fx.talks[${q(id)}].turns.unshift({ id: "a0", ts: Date.now() - 3 * 60000, briefing: ${q(BRIEFING)}, state: "answered", reply: "Drawn.", answeredts: Date.now() });
                await feed({ boardid: ${q(id)}, turnid: "a0", state: "answered", from: ${q(AGENT_NAME)}, what: "talk" });
                await feed({ boardid: ${q(id)}, turnid: "a1", state: "asks", from: ${q(AGENT_NAME)}, what: "talk" });
                return true;`);
            await polishWaitFor(h, `!!${toastWith(`The drawer answered on ${ASKS_BOARD}`)} && !!${toastWith(`The drawer asks you on ${ASKS_BOARD}`)}`, WAIT_MS);
            const answered = await h.ev(text(toastWith(`The drawer answered on ${ASKS_BOARD}`)));
            const asks = await h.ev(text(toastWith(`The drawer asks you on ${ASKS_BOARD}`)));
            await h.shot(SHOT("B10", "toasts"));
            await h.goto("cockpit");
            await h.ev(`${toastWith(`The drawer asks you on ${ASKS_BOARD}`)}?.querySelector("[data-notification-toast-action]")?.click()`);
            await polishWaitFor(h, `${text(SWITCHER)} === ${q(ASKS_BOARD)}`, WAIT_MS);
            const surface = await h.activeSurfaceLabel();
            const open = await h.ev(text(SWITCHER));
            const ok =
                answered === `The drawer answered on ${ASKS_BOARD}From ${AGENT_NAME}'s briefingOpen` &&
                asks === `The drawer asks you on ${ASKS_BOARD}Does ${AGENT_NAME}'s briefing belong on a new board?Open` &&
                surface === "Boards" &&
                open === ASKS_BOARD;
            return { ok, detail: q({ answered, asks, surface, open }) };
        });

        await run("13. E1 load error: a damaged board file shows the reason, its path and Retry over the canvas; its talk still shows and the ask box says the board won't open", async () => {
            const info = await h.rpc("boardstart", { channelid: ctx.channelId, name: BROKEN_BOARD, about: PROJECT_ABOUT });
            ctx.boards.broken = info;
            const whole = readFileSync(info.path, "utf8");
            writeFileSync(info.path, whole.slice(0, Math.floor(whole.length / 2)));
            await openBoard(h, ctx, info.id, { canvas: false });
            await polishWaitFor(h, `!!${SURFACE}?.querySelector("[data-board-load-error]")`, WAIT_MS);
            const err = await h.ev(text(`${SURFACE}?.querySelector("[data-board-load-error]")`));
            const retry = await h.ev(`[...(${SURFACE}?.querySelector("[data-board-load-error]")?.querySelectorAll("button") ?? [])].some((b) => b.textContent.trim() === "Retry")`);
            const talk = await h.ev(text(`${TALK}?.querySelector("[data-board-talk-empty]")`));
            const box = await h.ev(`({ disabled: ${ASK_BOX}?.getAttribute("aria-disabled"), hint: (${ASK_BOX}?.querySelector("[data-board-ask-hint]")?.textContent ?? "").trim() })`);
            const facts = await h.ev(text(`${SURFACE}?.querySelector("[data-board-facts]")`));
            await h.shot(SHOT("E1", "load-error"));
            writeFileSync(info.path, whole);
            const ok =
                err.startsWith(`Couldn't open ${BROKEN_BOARD}:`) &&
                err.includes("Arc has not changed the file.") &&
                err.includes(`The file:${info.path}`) &&
                retry &&
                talk.startsWith("Nothing asked on this board yet") &&
                box.disabled === "true" &&
                box.hint === "This board won't open, so the drawer can't answer on it" &&
                facts === "won't open";
            return { ok, detail: q({ err, retry, talk, box, facts }) };
        });

        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await page(
            h,
            `for (const k of ${q(STUBBED)}) delete RpcApi[k];
            delete window.__boardsAskFx;
            globalStore.set(B.boardsChannelAtom, null);
            return true;`
        ).catch(() => {});
        await setPageRoster(h, null).catch(() => {});
        if (ctx.boardDir) rmSync(ctx.boardDir, { recursive: true, force: true });
        if (ctx.project) await h.rpc("deleteproject", { name: ctx.project });
        if (ctx.cwd) rmSync(ctx.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    },
};

export const BOARDS_ASK_SCENARIOS = [boardsAsk];
