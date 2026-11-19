// Boards scenario `boards-workspace` (boards W1, W2): a board tied to an agent, as a tab in that agent's workspace pane.
// One fixture claude agent (no controller, so nothing runs) in the Rendered view, and a real board made through
// BoardStartCommand with no question (so no drawer runs) in a throwaway project. The board's talk, the list's talk
// facts, and what would start a drawer or reach wavesrv's routing are stubbed in the page; a step changes the fixed
// talk and feeds board:update to the page's own handler, as wavesrv does when a turn moves.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    agentPage,
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
    restoreRoster,
    setRoster,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { polishNap, polishReload, polishWaitFor, waitForProjectInConfig } from "./scenarios-shared.mjs";

const NAME = "boards-workspace";
const PROJECT = "boards-ws-fx";
const SHOT = (board, what) => `cdp-shots/${NAME}-${board}-${what}.png`;
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const PANE_PX = 640;
const WAIT_MS = 15_000;
// longer than an item's entrance and the pane's reveal
const SETTLE_MS = 700;
// how long a sampler watches a list change: past the exit (durExit) and the entrance (durMacro)
const SAMPLE_MS = 900;
const SEC = 1000;
const MIN = 60 * SEC;
const q = JSON.stringify;
const HHMM = String.raw`\d\d:\d\d`;

const AGENT_NAME = `claude · ${PROJECT}`;
const BOARD = "App architecture";
const AGENT_REPLY = "Because a run outlives any one agent tab: wavesrv holds the DAG and lands the merges.";
const SENT_BESIDE = "sent to the agent · answered in the transcript";
const box = (x, y, text) => ({ type: "rectangle", x, y, width: 180, height: 70, label: { text } });
const FIRST_DRAWING = [box(0, 0, "Tauri shell"), box(260, 0, "wavesrv"), box(520, 0, "agents")];
const SECOND_DRAWING = [box(260, 160, "pkg/orchestrate"), { type: "arrow", x: 350, y: 75, width: 0, height: 80 }];
const SHAPES = FIRST_DRAWING.length + SECOND_DRAWING.length;

const SURF = `document.querySelector("[data-cockpit-surface-wrap]")`;
const RV = `${SURF}?.querySelector("[data-rendered-view]")`;
const ASIDE = `document.querySelector('aside[aria-label="Workspace"]')`;
const TAB = `${ASIDE}?.querySelector("[data-board-tab]")`;
const HEADER = `${TAB}?.querySelector("[data-board-tab-header]")`;
const TALK = `${TAB}?.querySelector("[data-board-talk]")`;
const lineOf = (turnId) => `${TAB}?.querySelector('[data-board-line="${turnId}"]')`;
const text = (expr) => `((${expr})?.textContent ?? "").replace(/\\s+/g, " ").trim()`;

// placement: the board tab's button in the pane's tab row, the Boards surface's switcher, the drawer's toast
const BOARD_KEY = (ctx) => `board:${ctx.boardId}`;
const boardTabButton = () => `${ASIDE}?.querySelector('[role="tab"][aria-label=${q(`Board · ${BOARD}`)}]')`;
const SCRATCH = "Scratch";
const BOARDS_SURFACE = `document.querySelector("[data-boards-surface]")`;
const SWITCHER = `${BOARDS_SURFACE}?.querySelector("[data-board-switcher]")`;
const switcherRow = (boardId) => `${BOARDS_SURFACE}?.querySelector('[data-board-switcher-row="${boardId}"]')`;
const DRAWER_TITLE = `The drawer drew on ${BOARD}`;
const DRAWER_TOAST = `[...document.querySelectorAll("[data-notification-toast]")].find((t) => t.textContent.includes(${q(DRAWER_TITLE)}))`;
// past the applier's list read and the toast's entrance
const TOAST_WAIT_MS = 1500;

// page-side: the app's modules, the stubs' state, and board:update fed to the page's own handler
const PAGE = `
    const B = await mod("app/view/boards/boardstore.ts");
    const W = await mod("app/view/agents/workspacestore.ts");
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    const { TabRpcClient } = await mod("app/store/wshrpcutil.ts");
    const fx = (window.__boardsWorkspaceFx ??= { talks: {}, calls: {} });
    const feed = async (data) => {
        const E = await mod("app/store/wps.ts");
        E.handleWaveEvent({ event: "board:update", data: { channelid: fx.channelId, ...data } });
    };
    const t = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    // what the narrow tab lists: each line's turn, opacity, detail and actions
    const readLines = () => [...(${TAB}?.querySelectorAll("[data-board-line]") ?? [])].map((el) => ({
        id: el.getAttribute("data-board-line"),
        opacity: Number(getComputedStyle(el).opacity),
        forward: el.getAttribute("data-board-forward"),
        text: t(el),
        detail: t(el.querySelector("[data-board-line-detail]")),
        flash: getComputedStyle(el.querySelector("[data-board-line-detail]") ?? el).animationName,
        show: !!el.querySelector("[data-board-show]"),
        reroute: t(el.querySelector("[data-board-reroute]")),
    }));
    // every frame for ms after fn runs, in one evaluation: a CDP round trip per frame is slower than the motion
    const sample = async (ms, fn, read) => {
        const frames = [];
        await fn();
        for (const end = performance.now() + ms; performance.now() < end; ) {
            frames.push(read());
            await new Promise((r) => setTimeout(r, 16));
        }
        return frames;
    };
`;
const page = (h, body) => agentPage(h, `${PAGE} ${body}`);

const STUBBED = [
    "BoardTalkCommand",
    "BoardListCommand",
    "BoardAskCommand",
    "BoardRerouteCommand",
    "BoardSetAgentCommand",
    "BoardAnswerInboxCommand",
];
async function installStubs(h, ctx) {
    await page(
        h,
        `fx.channelId = ${q(ctx.channelId)};
        fx.orig ??= { talk: RpcApi.BoardTalkCommand, list: RpcApi.BoardListCommand };
        RpcApi.BoardTalkCommand = async (c, d) =>
            fx.talks[d.boardid] != null ? structuredClone(fx.talks[d.boardid]) : fx.orig.talk.call(RpcApi, c, d);
        // wavesrv's list facts over the fixed talks, as boards-ask derives them
        RpcApi.BoardListCommand = async (c, d) => {
            const rtn = await fx.orig.list.call(RpcApi, c, d);
            const boards = (rtn?.boards ?? []).map((b) => {
                const talk = fx.talks[b.id];
                if (talk == null) return b;
                const info = { ...b, questions: 0, drawings: 0, drawnts: 0, activets: b.createdts, state: undefined, agenttabid: talk.agent?.tabid };
                for (const t of talk.turns) {
                    if (!t.kept && (t.question || t.briefing)) info.questions++;
                    info.activets = Math.max(info.activets, t.ts, t.answeredts ?? 0);
                    if (t.state === "answered" && (t.added ?? 0) + (t.changed ?? 0) + (t.removed ?? 0) > 0) {
                        info.drawings++;
                        info.drawnts = Math.max(info.drawnts, t.answeredts ?? 0);
                    }
                }
                if (talk.turns.at(-1)?.state === "answering") info.state = "answering";
                return info;
            });
            return { ...rtn, boards };
        };
        RpcApi.BoardAskCommand = async (_c, d) => { (fx.calls.ask ??= []).push(d); };
        RpcApi.BoardRerouteCommand = async (_c, d) => { (fx.calls.reroute ??= []).push(d); };
        RpcApi.BoardSetAgentCommand = async (_c, d) => { (fx.calls.setagent ??= []).push(d); };
        RpcApi.BoardAnswerInboxCommand = async () => [];
        return true;`
    );
}

// a throwaway project, and the channel wavesrv gives it
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

// a real board holding both drawings, with the shape ids of each drawing
const makeBoard = (h, name, drawings) =>
    page(
        h,
        `const C = await mod("app/view/boards/boardconvert.ts");
        const drawings = ${q(drawings)}.map((d) => C.convertSkeleton(JSON.stringify(d)));
        const info = await RpcApi.BoardStartCommand(TabRpcClient, {
            channelid: fx.channelId, name: ${q(name)}, about: { kind: "project", ref: "", title: "" },
            elements: JSON.stringify(drawings.flat()),
        });
        const ids = drawings.map((els) => els.filter((e) => !(e.type === "text" && e.containerId != null)).map((e) => e.id));
        return { info, ids };`
    );

// the agent's request (a briefing), your drawn line, your forwarded line, and the agent's next request being drawn
function startTalk(ctx, ids) {
    const now = Date.now();
    const agent = { tabid: ctx.agentId, title: AGENT_NAME, runtime: "claude" };
    return {
        channelid: ctx.channelId,
        boardid: ctx.boardId,
        about: { kind: "project", ref: "", title: "" },
        agent,
        turns: [
            {
                id: "r1", ts: now - 12 * MIN, state: "answered", route: "draw",
                briefing: { from: AGENT_NAME, text: "The Tauri shell starts wavesrv; agents report in through wsh.", ask: "the shell, wavesrv and the agents" },
                title: "How Arc fits together", added: FIRST_DRAWING.length, shapeids: ids[0], answeredts: now - 11 * MIN,
            },
            {
                id: "r2", ts: now - 8 * MIN, state: "answered", route: "draw", question: "Open this up", on: "wavesrv",
                title: "wavesrv, opened up", added: SECOND_DRAWING.length, shapeids: ids[1], answeredts: now - 7 * MIN,
            },
            {
                id: "r3", ts: now - 4 * MIN, state: "forwarded", route: "agent", question: "Why does it own the orchestrator?", on: "pkg/orchestrate",
                forward: { state: "sent", tabid: ctx.agentId, title: AGENT_NAME, runtime: "claude", sentts: now - 4 * MIN },
            },
            {
                id: "r4", ts: now - 6 * SEC, state: "answering",
                briefing: { from: AGENT_NAME, text: "", ask: "under pkg/orchestrate, the run loop" },
            },
        ],
    };
}

// the fixed talk changed by a page expression over `talk`, fed as wavesrv's talk update
const changeTalk = (ctx, body) => `{
    const talk = fx.talks[${q(ctx.boardId)}];
    ${body}
    await feed({ boardid: ${q(ctx.boardId)}, what: "talk" });
}`;

const rosterAgent = (ctx, transcriptPath) => ({
    id: ctx.agentId,
    name: AGENT_NAME,
    project: PROJECT,
    task: "boards workspace fixture",
    state: "idle",
    agent: "claude",
    model: "claude-opus-5-5",
    blockId: ctx.blockId,
    cwd: ctx.cwd,
    transcriptPath,
});

async function showRendered(h) {
    await h.ev(`(() => {
        const b = ${SURF}?.querySelector("button[data-view-toggle]");
        if (b && b.getAttribute("aria-pressed") !== "true") b.click();
        return true;
    })()`);
    return polishWaitFor(h, `${RV} != null`, WAIT_MS);
}

async function arrange(h) {
    const ctx = { name: NAME, tabIds: [], dir: mkdtempSync(join(tmpdir(), "arc-boards-ws-")) };
    try {
        ctx.cwd = join(ctx.dir, "project");
        mkdirSync(ctx.cwd, { recursive: true });
        await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
        ctx.project = PROJECT;
        ctx.channelId = (await createProject(h, PROJECT, ctx.cwd)).oid;
        await polishReload(h);
        const transcript = writeTranscript(ctx.dir, "boards-ws", [
            userText("How does the app fit together? Put it on a board."),
            assistantText(`The Tauri shell starts wavesrv; the frontend talks to it over websocket RPC. I asked the drawer for it on ${BOARD}.`),
            userText(`[From board "${BOARD}" · on pkg/orchestrate · turn r3]\nWhy does it own the orchestrator?`),
            assistantText("Because a run outlives any one agent tab."),
        ]);
        await h.goto("agent");
        const t = await makeTab(h, ctx, { label: PROJECT, blockMeta: { view: "term", controller: null } });
        Object.assign(ctx, { agentId: t.tabId, blockId: t.blockId });
        await setRoster(h, [rosterAgent(ctx, transcript)]);
        await focusAgent(h, ctx.agentId);
        if (!(await showRendered(h))) throw new Error("the Rendered view never showed for the fixture agent");

        await installStubs(h, ctx);
        const made = await makeBoard(h, BOARD, [FIRST_DRAWING, SECOND_DRAWING]);
        ctx.boardId = made.info.id;
        ctx.boardDir = dirname(made.info.path);
        await page(h, `fx.talks[${q(ctx.boardId)}] = ${q(startTalk(ctx, made.ids))}; return true;`);
        await page(
            h,
            `globalStore.set(W.workspaceWidthAtom, ${PANE_PX});
            W.openWorkspaceTab(${q(ctx.agentId)}, { kind: "board", channelId: ${q(ctx.channelId)}, boardId: ${q(ctx.boardId)} });
            return true;`
        );
        if (!(await polishWaitFor(h, `!!${TAB}?.querySelector(".excalidraw")`, 20_000))) {
            throw new Error("the board tab never opened its canvas");
        }
    } catch (e) {
        ctx.arrangeError = String(e?.message ?? e);
    }
    return ctx;
}

// the tab as drawn: the pane, the header line, the canvas, the lines and the ask box, and the transcript beside it
const readTab = (h) =>
    page(
        h,
        `const aside = ${ASIDE};
        const canvas = ${TAB}?.querySelector("section[aria-label^='Board:']");
        const rv = ${RV};
        return {
            pane: aside?.getAttribute("data-workspace-pane") ?? null,
            layout: ${TAB}?.getAttribute("data-board-tab") ?? null,
            label: aside?.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
            name: t(${HEADER}?.querySelector("[data-board-tab-name]")),
            chip: t(${HEADER}?.querySelector("[data-board-agent-chip]")),
            facts: t(${HEADER}?.querySelector("[data-board-facts]")),
            drawing: t(${HEADER}?.querySelector("[data-board-drawing]")),
            canvas: !!canvas?.querySelector(".excalidraw"),
            canvasPx: canvas ? Math.round(canvas.getBoundingClientRect().width) : 0,
            lines: readLines(),
            askBox: !!${TAB}?.querySelector("[data-board-ask-box]"),
            askButtons: [...(${TAB}?.querySelectorAll("[data-board-ask-box] button") ?? [])].map((b) => t(b)),
            transcript: rv != null && rv.getBoundingClientRect().width > 0,
            transcriptLeftOfPane: rv != null && aside != null && rv.getBoundingClientRect().right <= aside.getBoundingClientRect().left + 1,
        };`
    );

// the pane's tab row (labels in order, the active one, the board tab's unseen dot), the shown agent, and the
// drawer's toasts on this board
const readPane = (h) =>
    page(
        h,
        `const tabs = [...(${ASIDE}?.querySelectorAll('[role="tab"]') ?? [])];
        return {
            tabs: tabs.map((b) => b.getAttribute("aria-label")),
            active: tabs.find((b) => b.getAttribute("aria-selected") === "true")?.getAttribute("aria-label") ?? null,
            boardUnseen: !!${boardTabButton()}?.querySelector("[data-workspace-tab-unseen]"),
            focusId: globalStore.get(agentsModel().focusIdAtom) ?? null,
            toasts: [...document.querySelectorAll("[data-notification-toast]")].filter((t) => t.textContent.includes(${q(BOARD)})).length,
        };`
    );

export const boardsWorkspace = {
    name: NAME,
    surface: "agent",
    arrange,
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

        await run("W1 board tab: beside the transcript, the header line (name, agent chip, facts, the drawer at work with its seconds), the canvas, the 2 last turns (drawn with Show, forwarded with Draw instead) and the ask box", async () => {
            await polishWaitFor(h, `/shapes/.test(${HEADER}?.querySelector("[data-board-facts]")?.textContent ?? "")`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const s = await readTab(h);
            await h.shot(SHOT("W1", "board-tab"));
            const [drawn, sent] = s.lines;
            const ok =
                s.pane === "open" &&
                s.layout === "beside" &&
                s.label === `Board · ${BOARD}` &&
                s.name === BOARD &&
                s.chip === `Agent${AGENT_NAME}` &&
                new RegExp(`^2 drawings · ${SHAPES} shapes · drawn ${HHMM}$`).test(s.facts) &&
                /^Drawing · \d+ s$/.test(s.drawing) &&
                s.canvas &&
                s.lines.length === 2 &&
                drawn.id === "r2" &&
                drawn.show &&
                drawn.reroute === "Send to the agent" &&
                drawn.text.startsWith('"Open this up" on wavesrv · wavesrv, opened up') &&
                sent.id === "r3" &&
                sent.detail === SENT_BESIDE &&
                sent.reroute === "Draw instead" &&
                !sent.show &&
                s.askBox &&
                // the drawer is at work, so Stop holds Ask's place
                q(s.askButtons) === q(["Stop"]) &&
                s.transcript &&
                s.transcriptLeftOfPane;
            return { ok, detail: q(s) };
        });

        await run("W1 new turn: a turn joining the list enters while the oldest leaves (moments 1, 2), and a forward's line moves from waiting for the agent to sent with the change wash (moment 14)", async () => {
            // the agent's request lands drawn: it joins, and r2 leaves
            const joined = await page(
                h,
                `return sample(${SAMPLE_MS}, async () => ${changeTalk(
                    ctx,
                    `Object.assign(talk.turns.find((t) => t.id === "r4"), { state: "answered", route: "draw", title: "The run loop", added: 1, shapeids: [], answeredts: Date.now() });`
                )}, readLines);`
            );
            await polishNap(SETTLE_MS);
            const afterJoin = (await readTab(h)).lines.map((l) => l.id);
            // your next line, flagged for the agent while it has a prompt open, then sent once it is answered
            await page(
                h,
                `${changeTalk(
                    ctx,
                    `talk.turns.push({ id: "r5", ts: Date.now(), state: "forwarded", route: "agent", question: "Who restarts a crashed worker?", forward: { state: "held", tabid: ${q(ctx.agentId)}, title: ${q(AGENT_NAME)}, runtime: "claude" } });`
                )} return true;`
            );
            const held = await polishWaitFor(h, `!!${lineOf("r5")}`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const waiting = (await readTab(h)).lines.find((l) => l.id === "r5");
            const moved = await page(
                h,
                `return sample(${SAMPLE_MS}, async () => ${changeTalk(
                    ctx,
                    `Object.assign(talk.turns.find((t) => t.id === "r5").forward, { state: "sent", sentts: Date.now() });`
                )}, () => readLines().find((l) => l.id === "r5"));`
            );
            await h.shot(SHOT("W1", "new-turn"));
            const enter = joined.filter((f) => f.some((l) => l.id === "r4" && l.opacity < 0.99));
            const exit = joined.filter((f) => f.some((l) => l.id === "r2" && l.opacity < 0.99));
            const washed = moved.filter((l) => l?.detail === SENT_BESIDE && l.flash === "changeFlash");
            const ok =
                joined[0].some((l) => l.id === "r2") &&
                enter.length > 0 &&
                exit.length > 0 &&
                q(afterJoin) === q(["r3", "r4"]) &&
                held &&
                waiting?.forward === "held" &&
                waiting.detail === `waiting for ${AGENT_NAME}` &&
                moved.at(-1)?.forward === "sent" &&
                washed.length > 0;
            return {
                ok,
                detail: q({ frames: joined.length, enter: enter.length, exit: exit.length, afterJoin, waiting, washed: washed.length, last: moved.at(-1) }),
            };
        });

        await run("W2 expanded: Expand gives the turns column (the agent's request rows, the copied reply with Back to the transcript and Draw instead, the agent's request being drawn with its seconds) beside the full-width canvas; Back to the transcript returns to W1", async () => {
            await page(
                h,
                `${changeTalk(
                    ctx,
                    `Object.assign(talk.turns.find((t) => t.id === "r5").forward, { state: "replied", reply: ${q(AGENT_REPLY)}, replyts: Date.now() });
                    talk.turns.push({ id: "r6", ts: Date.now() - 4000, state: "answering", briefing: { from: ${q(AGENT_NAME)}, text: "", ask: "who restarts a crashed worker" } });`
                )} return true;`
            );
            await polishWaitFor(h, `!!${lineOf("r5")}?.textContent.includes("answered")`, WAIT_MS);
            await h.ev(`${ASIDE}?.querySelector("[data-workspace-expand]")?.click()`);
            const expanded = await polishWaitFor(h, `${ASIDE}?.getAttribute("data-workspace-pane") === "expanded" && !!${TALK}`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const turnOf = (id, kind) => `${TALK}?.querySelector('[data-board-turn="${id}"][data-board-item="${kind}"]')`;
            const s = await page(
                h,
                `const talkEl = ${TALK};
                const canvas = ${TAB}?.querySelector("section[aria-label^='Board:']");
                const reply = ${turnOf("r5", "forward")};
                return {
                    layout: ${TAB}?.getAttribute("data-board-tab"),
                    asked: [...(talkEl?.querySelectorAll('[data-board-item="briefing"]') ?? [])].map((el) => [el.getAttribute("data-board-turn"), t(el)]),
                    line: t(reply?.querySelector("[data-board-forward-line]")),
                    reply: t(reply?.querySelector("[data-board-forward-reply]")),
                    back: t(reply?.querySelector("[data-board-back]")),
                    reroute: t(reply?.querySelector("[data-board-reroute]")),
                    working: t(${turnOf("r6", "working")}),
                    lines: !!${TAB}?.querySelector("[data-board-lines]"),
                    canvas: !!canvas?.querySelector(".excalidraw"),
                    canvasBesideTalk: canvas != null && talkEl != null && canvas.getBoundingClientRect().left >= talkEl.getBoundingClientRect().right - 1,
                    canvasPx: canvas ? Math.round(canvas.getBoundingClientRect().width) : 0,
                    talkPx: talkEl ? Math.round(talkEl.getBoundingClientRect().width) : 0,
                    pane: ${ASIDE} ? Math.round(${ASIDE}.getBoundingClientRect().width) : 0,
                };`
            );
            await h.shot(SHOT("W2", "expanded"));
            await h.ev(`${TALK}?.querySelector("[data-board-back]")?.click()`);
            const back = await polishWaitFor(h, `${ASIDE}?.getAttribute("data-workspace-pane") === "open" && ${TAB}?.getAttribute("data-board-tab") === "beside"`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const w1 = await readTab(h);
            await h.shot(SHOT("W2", "back"));
            const askedRe = new RegExp(`^the agent asked · ${HHMM}`);
            const ok =
                expanded &&
                s.layout === "expanded" &&
                q(s.asked.map(([id]) => id)) === q(["r1", "r4", "r6"]) &&
                s.asked.every(([, text]) => askedRe.test(text)) &&
                new RegExp(`^${AGENT_NAME} answered · ${HHMM}$`).test(s.line) &&
                s.reply === AGENT_REPLY &&
                s.back === "Back to the transcript" &&
                s.reroute === "Draw instead" &&
                /^Answering\d+ s$/.test(s.working) &&
                !s.lines &&
                s.canvas &&
                s.canvasBesideTalk &&
                s.canvasPx >= s.pane - s.talkPx - 2 &&
                back &&
                w1.pane === "open" &&
                w1.layout === "beside" &&
                q(w1.lines.map((l) => l.id)) === q(["r4", "r5"]) &&
                /^Drawing · \d+ s$/.test(w1.drawing) &&
                w1.askBox &&
                w1.transcript;
            return { ok, detail: q({ expanded, s, back, w1 }) };
        });

        await run("join on draw: a join update for the shown agent adds the board tab behind the active one with its unseen mark, and its request answering raises no toast", async () => {
            await page(
                h,
                `W.openWorkspaceTab(${q(ctx.agentId)}, { kind: "changes", selected: null });
                W.closeWorkspaceTab(${q(ctx.agentId)}, ${q(BOARD_KEY(ctx))});
                return true;`
            );
            const closed = await polishWaitFor(h, `!${boardTabButton()} && ${ASIDE}?.getAttribute("data-workspace-pane") === "open"`, WAIT_MS);
            await page(h, `await feed({ boardid: ${q(ctx.boardId)}, what: "join", agenttabid: ${q(ctx.agentId)} }); return true;`);
            const joined = await polishWaitFor(h, `!!${boardTabButton()}`, WAIT_MS);
            // the drawn request the join came with: in view, so the drawer stays quiet
            await page(
                h,
                `${changeTalk(
                    ctx,
                    `Object.assign(talk.turns.find((t) => t.id === "r6"), { state: "answered", route: "draw", title: "Who restarts a worker", added: 1, shapeids: [], answeredts: Date.now() });`
                )}
                await feed({ boardid: ${q(ctx.boardId)}, turnid: "r6", state: "answered", from: ${q(AGENT_NAME)}, what: "talk" });
                return true;`
            );
            await polishNap(TOAST_WAIT_MS);
            const s = await readPane(h);
            await h.shot(SHOT("join", "unseen"));
            const ok =
                closed &&
                joined &&
                q(s.tabs) === q(["Changes", `Board · ${BOARD}`]) &&
                s.active === "Changes" &&
                s.boardUnseen &&
                s.toasts === 0;
            return { ok, detail: q({ closed, joined, s }) };
        });

        await run("open from Boards: picking the tied board in the Boards switcher lands on the Agent surface with the board tab active", async () => {
            const scratch = await page(
                h,
                `const info = await RpcApi.BoardStartCommand(TabRpcClient, {
                    channelid: fx.channelId, name: ${q(SCRATCH)}, about: { kind: "project", ref: "", title: "" },
                });
                // listed first, or the surface falls back to the project's most recently active board
                await B.loadBoardList(fx.channelId);
                B.selectBoard(fx.channelId, info.id);
                return info;`
            );
            ctx.scratchId = scratch.id;
            await h.goto("boards");
            const onBoards = await polishWaitFor(h, `${text(SWITCHER)} === ${q(SCRATCH)}`, WAIT_MS);
            await h.ev(`${SWITCHER}?.click()`);
            await polishWaitFor(h, `!!${switcherRow(ctx.boardId)}`, WAIT_MS);
            await h.ev(`${switcherRow(ctx.boardId)}?.click()`);
            const landed = await polishWaitFor(h, `!!${TAB}?.querySelector(".excalidraw")`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const s = await readPane(h);
            const surface = await h.activeSurfaceLabel();
            await h.shot(SHOT("open", "from-boards"));
            const ok =
                onBoards &&
                landed &&
                surface === "Agent" &&
                s.focusId === ctx.agentId &&
                s.active === `Board · ${BOARD}` &&
                !s.boardUnseen;
            return { ok, detail: q({ onBoards, landed, surface, s }) };
        });

        await run("toast off-screen: with the Boards surface shown, the tied agent's request answering raises the drawer's toast, and its Open lands on the Agent surface with that agent and the board tab active", async () => {
            await page(h, `W.activateWorkspaceTab(${q(ctx.agentId)}, "changes"); return true;`);
            await h.goto("boards");
            const onBoards = (await h.activeSurfaceLabel()) === "Boards";
            await page(
                h,
                `${changeTalk(
                    ctx,
                    `talk.turns.push({ id: "r7", ts: Date.now() - 3000, state: "answered", route: "draw", briefing: { from: ${q(AGENT_NAME)}, text: "", ask: "the merge queue" }, title: "The merge queue", added: 1, shapeids: [], answeredts: Date.now() });`
                )}
                await feed({ boardid: ${q(ctx.boardId)}, turnid: "r7", state: "answered", from: ${q(AGENT_NAME)}, what: "talk" });
                return true;`
            );
            const toasted = await polishWaitFor(h, `!!${DRAWER_TOAST}`, WAIT_MS);
            const toast = await h.ev(text(DRAWER_TOAST));
            await h.shot(SHOT("toast", "off-screen"));
            await h.ev(`${DRAWER_TOAST}?.querySelector("[data-notification-toast-action]")?.click()`);
            const landed = await polishWaitFor(h, `!!${TAB}?.querySelector(".excalidraw")`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const s = await readPane(h);
            const surface = await h.activeSurfaceLabel();
            const ok =
                onBoards &&
                toasted &&
                toast === `${DRAWER_TITLE}From ${AGENT_NAME}'s briefingOpen` &&
                landed &&
                surface === "Agent" &&
                s.focusId === ctx.agentId &&
                s.active === `Board · ${BOARD}`;
            return { ok, detail: q({ onBoards, toasted, toast, landed, surface, s }) };
        });

        await run("Escape with the board mounted twice: with the board tab active in the agent's workspace and the same board open on Boards, closing that tab leaves Escape to the Boards canvas: a selected shape clears and the surface stays Boards", async () => {
            const CANVAS = `${BOARDS_SURFACE}?.querySelector(".excalidraw")`;
            // Excalidraw's App component off the Boards canvas's fiber
            const APP = `(() => {
                const el = ${CANVAS};
                const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
                for (let f = key ? el[key] : null; f != null; f = f.return) {
                    if (typeof f.stateNode?.updateScene === "function" && f.stateNode?.scene != null) return f.stateNode;
                }
                return null;
            })()`;
            const SELECTED = `Object.values(${APP}?.state?.selectedElementIds ?? {}).filter(Boolean).length`;
            const tabActive = (await readPane(h)).active === `Board · ${BOARD}`;
            await page(h, `await B.loadBoardList(fx.channelId); B.selectBoard(fx.channelId, ${q(ctx.boardId)}); return true;`);
            await h.goto("boards");
            const onBoards = await polishWaitFor(h, `${text(SWITCHER)} === ${q(BOARD)} && !!${CANVAS} && ${APP} != null`, WAIT_MS);
            const mountedTwice = await h.ev(`document.querySelectorAll(".excalidraw").length === 2 && !!${TAB}?.querySelector(".excalidraw")`);
            await page(h, `W.closeWorkspaceTab(${q(ctx.agentId)}, ${q(BOARD_KEY(ctx))}); return true;`);
            const unmounted = await polishWaitFor(h, `document.querySelectorAll(".excalidraw").length === 1 && !!${CANVAS}`, WAIT_MS);
            await h.ev(`(() => {
                const app = ${APP};
                const shape = app.scene.getNonDeletedElements().find((e) => e.type === "rectangle");
                app.updateScene({ appState: { selectedElementIds: { [shape.id]: true } }, captureUpdate: "NEVER" });
            })()`);
            const selected = await polishWaitFor(h, `${SELECTED} === 1`, WAIT_MS);
            await h.ev(`(() => {
                document.activeElement?.blur?.();
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
            })()`);
            const cleared = await polishWaitFor(h, `${SELECTED} === 0`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const surface = await h.activeSurfaceLabel();
            await h.shot(SHOT("escape", "mounted-twice"));
            const ok = tabActive && onBoards && mountedTwice && unmounted && selected && cleared && surface === "Boards";
            return { ok, detail: q({ tabActive, onBoards, mountedTwice, unmounted, selected, cleared, surface }) };
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
        await step("close the board and changes tabs", () =>
            ctx.agentId && ctx.boardId
                ? page(
                      h,
                      `W.closeWorkspaceTab(${q(ctx.agentId)}, ${q(`board:${ctx.boardId}`)});
                      W.closeWorkspaceTab(${q(ctx.agentId)}, "changes");
                      return true;`
                  )
                : null
        );
        await step("unpin the Boards project", () =>
            page(h, `globalStore.set(B.boardsChannelAtom, null); return true;`)
        );
        await step("drop the stubs", () =>
            page(h, `for (const k of ${q(STUBBED)}) delete RpcApi[k]; delete window.__boardsWorkspaceFx; return true;`)
        );
        await step("restore the roster", () => restoreRoster(h));
        await step("drop the focus", () => agentPage(h, `globalStore.set(agentsModel().focusIdAtom, undefined); return true;`));
        await step("close the tabs", () => closeTabs(h, ctx));
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        if (ctx.boardDir) await step("remove the board", () => rmSync(ctx.boardDir, { recursive: true, force: true }));
        if (ctx.project) await step("delete the project", () => h.rpc("deleteproject", { name: ctx.project }));
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
        await step("go home", () => h.goto("cockpit"));
    },
};

// Boards in the agent's workspace (W1, W2), and where a tied board opens (join, open from Boards, toast off-screen).
export const BOARDS_WORKSPACE_SCENARIOS = [boardsWorkspace];
