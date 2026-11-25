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
// how long a sampler watches a line change state: past the wash (CHANGE_FLASH_MS, 1.2 s)
const CHANGE_WATCH_MS = 1800;
const SEC = 1000;
const MIN = 60 * SEC;
const q = JSON.stringify;
const HHMM = String.raw`\d\d:\d\d`;

const AGENT_NAME = `claude · ${PROJECT}`;
const BOARD = "App architecture";
const AGENT_REPLY = "Because a run outlives any one agent tab: wavesrv holds the DAG and lands the merges.";
// your lines in W1: one drawn (then failing in place), one the drawer wants on a new board
const DRAWING_Q = "Add the retry when a task review rejects twice";
const NEEDS_Q = "Draw the cancel path too";
const ASKED_Q = "What restarts a crashed worker?";
// the prototype's narrow window (States board, last frame), where the facts ellipsize and the input group holds
const NARROW = { ...VIEWPORT, width: 1000 };
const MIN_BOX_PX = 200;
// a ticking line watched for a wash: past two of the drawer's one-second ticks
const TICK_WATCH_MS = 2300;
const box = (x, y, text) => ({ type: "rectangle", x, y, width: 180, height: 70, label: { text } });
const FIRST_DRAWING = [box(0, 0, "Tauri shell"), box(260, 0, "wavesrv"), box(520, 0, "agents")];
const SECOND_DRAWING = [box(260, 160, "pkg/orchestrate"), { type: "arrow", x: 350, y: 75, width: 0, height: 80 }];
const SHAPES = FIRST_DRAWING.length + SECOND_DRAWING.length;
// wider than the narrow tab at full size, so it shows whole only when the view fits it
const LIVE_DRAWING = {
    title: "Restarting a worker",
    add: [box(0, 0, "crash"), box(260, 0, "supervisor"), box(520, 0, "restart"), box(780, 0, "resume")],
};

const SURF = `document.querySelector("[data-cockpit-surface-wrap]")`;
const RV = `${SURF}?.querySelector("[data-rendered-view]")`;
const ASIDE = `document.querySelector('aside[aria-label="Workspace"]')`;
const TAB = `${ASIDE}?.querySelector("[data-board-tab]")`;
const TALK = `${TAB}?.querySelector("[data-board-talk]")`;
const BAR = `${TAB}?.querySelector("[data-board-ask-bar]")`;
const LINE = `${TAB}?.querySelector("[data-board-bar-line]")`;
const INPUT = `${BAR}?.querySelector("[data-board-ask-box] input")`;
const lineIs = (turnId, state) =>
    `${LINE}?.getAttribute("data-board-bar-line") === ${q(turnId)} && ${LINE}?.getAttribute("data-board-bar-line-state") === ${q(state)}`;
// Excalidraw's App component off the tab canvas's fiber
const TAB_APP = `(() => {
    const el = ${TAB}?.querySelector(".excalidraw");
    const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    for (let f = key ? el[key] : null; f != null; f = f.return) {
        if (typeof f.stateNode?.updateScene === "function" && f.stateNode?.scene != null) return f.stateNode;
    }
    return null;
})()`;
const text = (expr) => `((${expr})?.textContent ?? "").replace(/\\s+/g, " ").trim()`;
const TAB_EDIT = `${TAB}?.querySelector("[data-board-edit]")`;

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
    // the one line above the bar: its turn, state, words, actions, the detail's wash, and the reveal's height
    const readLine = () => {
        const el = ${LINE};
        if (el == null) return null;
        const detail = el.querySelector("[data-board-bar-line-detail]");
        return {
            id: el.getAttribute("data-board-bar-line"),
            state: el.getAttribute("data-board-bar-line-state"),
            count: ${TAB}.querySelectorAll("[data-board-bar-line]").length,
            text: t(el),
            words: t(el.querySelector('[role="status"]')),
            detail: t(detail),
            flash: getComputedStyle(detail ?? el).animationName,
            actions: [...el.querySelectorAll("button")].map(t),
            breathes: el.classList.contains("pulse-glow"),
            pulses: !!el.querySelector(".pulse-dot"),
            height: Math.round(el.closest(".overflow-hidden")?.getBoundingClientRect().height ?? 0),
        };
    };
    // the selection chip in the input group, with its opacity mid-entrance or mid-exit
    const readChip = () => {
        const el = ${BAR}?.querySelector("[data-board-ask-selection]");
        return el == null ? null : { text: t(el), opacity: Number(getComputedStyle(el).opacity) };
    };
    // the first n boxes on the tab's canvas selected, as a pointer would
    const select = (n) => {
        const app = ${TAB_APP};
        const ids = app.scene.getNonDeletedElements().filter((e) => e.type === "rectangle").slice(0, n).map((e) => e.id);
        app.updateScene({ appState: { selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])) }, captureUpdate: "NEVER" });
    };
    // typed into the bar's input as React sees typing, then Enter
    const typeAndEnter = async (value) => {
        const input = ${INPUT};
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        // the keydown reads the typed value from the next render
        await new Promise((r) => setTimeout(r, 50));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    };
    // every painted frame for ms after fn runs, or until stop(), in one evaluation: a CDP round trip per frame is slower
    // than the motion, and a timer can skip a micro motion's few frames when a render holds the thread; the timeout
    // keeps a window that paints nothing from stalling it
    const sample = async (ms, fn, read, stop = () => false) => {
        const frames = [];
        await fn();
        for (const end = performance.now() + ms; performance.now() < end && !stop(); ) {
            frames.push(read());
            await new Promise((r) => {
                requestAnimationFrame(r);
                setTimeout(r, 50);
            });
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
    "BoardAskRetryCommand",
    "BoardAskChoiceCommand",
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
        // wavesrv's retry and Keep it here, on the fixed talk
        const onTurn = async (d, change) => {
            Object.assign(fx.talks[d.boardid].turns.find((t) => t.id === d.turnid), change);
            await feed({ boardid: d.boardid, what: "talk" });
        };
        RpcApi.BoardAskRetryCommand = async (_c, d) => {
            (fx.calls.retry ??= []).push(d);
            await onTurn(d, { state: "answering", ts: Date.now(), reason: undefined, answeredts: undefined });
        };
        RpcApi.BoardAskChoiceCommand = async (_c, d) => {
            (fx.calls.choice ??= []).push(d);
            await onTurn(d, { choice: d.choice });
        };
        return true;`
    );
}

// a throwaway project, and the channel wavesrv gives it
export async function createProject(h, name, path) {
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

// the agent's request (a briefing), your drawn line, your forwarded line, and the agent's next request, drawn: idle
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
                id: "r4", ts: now - 3 * MIN, state: "answered", route: "draw",
                briefing: { from: AGENT_NAME, text: "", ask: "under pkg/orchestrate, the run loop" },
                title: "The run loop", added: 1, shapeids: [], answeredts: now - 2 * MIN,
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
        ctx.prevWidth = await page(h, `return globalStore.get(W.workspaceWidthAtom);`);
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

// the tab as drawn: the pane, the canvas, the line above the bar, the ask bar (the agent chip, the input group with its
// selection chip, the facts at its end), and the transcript beside it
const readTab = (h) =>
    page(
        h,
        `const aside = ${ASIDE};
        const canvas = ${TAB}?.querySelector("section[aria-label^='Board:']");
        const rv = ${RV};
        const bar = ${BAR};
        const group = bar?.querySelector("[data-board-ask-box]");
        const input = ${INPUT};
        const facts = bar?.querySelector("[data-board-facts]");
        const chip = bar?.querySelector("[data-board-agent-chip]");
        const chipText = chip?.querySelector(".truncate");
        const ask = group?.querySelector("[data-board-ask-send]");
        const rect = (el) => el?.getBoundingClientRect();
        return {
            pane: aside?.getAttribute("data-workspace-pane") ?? null,
            layout: ${TAB}?.getAttribute("data-board-tab") ?? null,
            label: aside?.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
            header: !!${TAB}?.querySelector("[data-board-tab-header]"),
            line: readLine(),
            bar: bar != null,
            barUnderCanvas: bar != null && canvas != null && rect(bar).top >= rect(canvas).bottom - 1 && rect(bar).left >= rect(canvas).left - 1,
            chip: t(chip),
            chipLabel: chip?.getAttribute("aria-label") ?? null,
            selection: readChip()?.text ?? null,
            placeholder: input?.placeholder ?? null,
            inputDisabled: input?.disabled ?? null,
            // a wrapping input drops a placeholder wider than itself out of view
            placeholderOneLine: input != null && getComputedStyle(input).whiteSpace === "nowrap",
            buttons: [...(group?.querySelectorAll("button") ?? [])].map((b) => t(b)),
            facts: t(facts),
            factsAtEnd: facts != null && group != null && rect(facts).left >= rect(group).right && rect(facts).right <= rect(bar).right,
            factsTruncated: facts != null && facts.scrollWidth > facts.clientWidth,
            groupPx: group ? Math.round(rect(group).width) : 0,
            barFits: bar != null && bar.scrollWidth <= bar.clientWidth,
            askVisible: ask != null && aside != null && rect(ask).right <= rect(aside).right && rect(ask).right <= rect(bar).right,
            chipTruncated: chipText != null && chipText.scrollWidth > chipText.clientWidth,
            canvas: !!canvas?.querySelector(".excalidraw"),
            canvasPx: canvas ? Math.round(rect(canvas).width) : 0,
            transcript: rv != null && rect(rv).width > 0,
            transcriptLeftOfPane: rv != null && aside != null && rect(rv).right <= rect(aside).left + 1,
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

        // its frameless shapes open as one drawing, Earlier drawings, and the facts count the row's drawings
        const facts = new RegExp(`^1 drawing · ${SHAPES} shapes · drawn ${HHMM}$`);

        await run("W1 idle, 2 shapes selected: no header and no line; under the canvas the ask bar holds the bare agent chip, the Selected chip entering (moment 1), Ask the board, Ask, and the facts at its end", async () => {
            await polishWaitFor(h, `/shapes/.test(${BAR}?.querySelector("[data-board-facts]")?.textContent ?? "")`, WAIT_MS);
            // asking about shapes is Edit's
            await h.ev(`${TAB_EDIT}?.click()`);
            await polishWaitFor(h, `${TAB_EDIT}?.getAttribute("aria-pressed") === "true"`, 5000);
            await polishNap(SETTLE_MS);
            const frames = await page(h, `return sample(${SAMPLE_MS}, () => select(2), readChip);`);
            await polishNap(SETTLE_MS);
            const s = await readTab(h);
            await h.shot(SHOT("W1", "idle-selected"));
            const entered = frames.filter((c) => c != null && c.opacity < 0.99);
            const ok =
                s.pane === "open" &&
                s.layout === "beside" &&
                s.label === `Board · ${BOARD}` &&
                !s.header &&
                s.line == null &&
                s.bar &&
                s.barUnderCanvas &&
                s.chip === AGENT_NAME &&
                s.chipLabel === `Board agent: ${AGENT_NAME}` &&
                /^Selected.+ and 1 more$/.test(s.selection ?? "") &&
                entered.length > 0 &&
                s.placeholder === "Ask the board" &&
                s.inputDisabled === false &&
                q(s.buttons) === q(["Ask"]) &&
                facts.test(s.facts) &&
                s.factsAtEnd &&
                s.canvas &&
                s.transcript &&
                s.transcriptLeftOfPane;
            return { ok, detail: q({ s, entered: entered.length }) };
        });

        await run("W1 Enter asks: Enter in the input asks the typed line about the selection, and Enter on an empty input asks nothing", async () => {
            await page(h, `fx.calls.ask = []; await typeAndEnter(${q(ASKED_Q)}); return true;`);
            const asked = await polishWaitFor(h, `(window.__boardsWorkspaceFx?.calls.ask ?? []).length === 1`, WAIT_MS);
            await polishWaitFor(h, `${INPUT}?.disabled === false && ${INPUT}?.value === ""`, WAIT_MS);
            await page(h, `await typeAndEnter("   "); return true;`);
            await polishNap(SETTLE_MS);
            const calls = await page(h, `return fx.calls.ask;`);
            // the blank line stays typed; cleared, so the input shows its placeholder again
            await page(h, `await typeAndEnter(""); return true;`);
            const ok = asked && calls.length === 1 && calls[0].question === ASKED_Q && /and 1 more$/.test(calls[0].on ?? "");
            return { ok, detail: q({ asked, calls }) };
        });

        await run("W1 idle, nothing selected: clearing the selection takes the Selected chip out (moment 1) and the input reads Select shapes to ask about them", async () => {
            const frames = await page(h, `return sample(${SAMPLE_MS}, () => select(0), readChip);`);
            await polishNap(SETTLE_MS);
            const s = await readTab(h);
            await h.shot(SHOT("W1", "idle-none"));
            const left = frames.filter((c) => c != null && c.opacity < 0.99);
            const ok =
                frames[0] != null &&
                left.length > 0 &&
                s.selection == null &&
                s.line == null &&
                s.placeholder === "Select shapes to ask about them" &&
                s.placeholderOneLine &&
                s.inputDisabled === false &&
                q(s.buttons) === q(["Ask"]);
            return { ok, detail: q({ s, left: left.length }) };
        });

        await run("W1 drawing: a turn being drawn reveals one line (moment 6) with its pulsing dot and seconds, the input is disabled with You can ask once this answer lands, and Stop holds Ask's place; the ticking seconds never wash", async () => {
            const frames = await page(
                h,
                `return sample(${SAMPLE_MS}, async () => ${changeTalk(
                    ctx,
                    `talk.turns.push({ id: "d1", ts: Date.now() - 18 * ${SEC}, state: "answering", route: "draw", question: ${q(DRAWING_Q)} });`
                )}, readLine);`
            );
            await polishWaitFor(h, lineIs("d1", "drawing"), WAIT_MS);
            await polishNap(SETTLE_MS);
            const s = await readTab(h);
            await h.shot(SHOT("W1", "drawing"));
            const ticks = await page(h, `return sample(${TICK_WATCH_MS}, () => {}, readLine);`);
            const final = s.line?.height ?? 0;
            const revealing = frames.filter((l) => l != null && l.height > 0 && l.height < final);
            const elapsed = new Set(ticks.map((l) => l?.words));
            const ok =
                revealing.length > 0 &&
                s.line?.id === "d1" &&
                s.line.count === 1 &&
                new RegExp(`^"${DRAWING_Q}" Drawing · (1[89]|2\\d) s$`).test(s.line.words) &&
                s.line.pulses &&
                q(s.line.actions) === q([]) &&
                s.inputDisabled === true &&
                s.placeholder === "You can ask once this answer lands" &&
                q(s.buttons) === q(["Stop"]) &&
                elapsed.size > 1 &&
                ticks.every((l) => l?.flash !== "changeFlash");
            return { ok, detail: q({ s, revealing: revealing.length, frames: frames.length, shown: frames.findIndex((l) => l != null), elapsed: [...elapsed] }) };
        });

        await run("W1 failed: the drawing turn failing in place keeps one line whose detail washes once (moment 14), with the error and Retry; Retry re-asks that turn", async () => {
            const frames = await page(
                h,
                `return sample(${CHANGE_WATCH_MS}, async () => ${changeTalk(
                    ctx,
                    `Object.assign(talk.turns.find((t) => t.id === "d1"), { state: "failed", reason: "the reply was not JSON", answeredts: Date.now() });`
                )}, readLine);`
            );
            await polishWaitFor(h, lineIs("d1", "failed"), WAIT_MS);
            const s = await readTab(h);
            await h.shot(SHOT("W1", "failed"));
            // the wash's runs: one stretch of frames, never two
            const washes = frames.filter((l, i) => l?.flash === "changeFlash" && frames[i - 1]?.flash !== "changeFlash");
            await page(h, `fx.calls.retry = []; return true;`);
            await h.ev(`${LINE}?.querySelector('[data-board-retry="d1"]')?.click()`);
            const reasked = await polishWaitFor(h, lineIs("d1", "drawing"), WAIT_MS);
            const retry = await page(h, `return fx.calls.retry;`);
            const ok =
                frames.every((l) => l?.id === "d1" && l.count === 1) &&
                washes.length === 1 &&
                s.line?.state === "failed" &&
                s.line.words === `"${DRAWING_Q}" couldn't answer` &&
                q(s.line.actions) === q(["Retry"]) &&
                s.inputDisabled === false &&
                reasked &&
                q(retry.map((d) => d.turnid)) === q(["d1"]);
            return { ok, detail: q({ s, washes: washes.length, frames: frames.length, reasked, retry }) };
        });

        await run("W1 needs you: a request waiting on your choice breathes (moment 3) with New board from this and Keep it here; Keep it here keeps it and the line collapses (moment 6); New board from this opens the Boards form", async () => {
            await page(
                h,
                `${changeTalk(
                    ctx,
                    `Object.assign(talk.turns.find((t) => t.id === "d1"), { state: "answered", reply: "Drawn.", answeredts: Date.now() });
                    talk.turns.push({ id: "n1", ts: Date.now(), state: "asks", route: "draw", question: ${q(NEEDS_Q)}, reply: "That is its own path. Draw it on a new board?" });`
                )} return true;`
            );
            const shown = await polishWaitFor(h, lineIs("n1", "asks"), WAIT_MS);
            await polishNap(SETTLE_MS);
            const s = await readTab(h);
            await h.shot(SHOT("W1", "needs-you"));
            await page(h, `fx.calls.choice = []; return true;`);
            const frames = await page(
                h,
                // until the line is gone, however late the choice's re-render starts its collapse
                `return sample(${WAIT_MS}, () => ${LINE}?.querySelector('[data-board-choice="keep"]')?.click(), readLine, () => !${LINE});`
            );
            const cleared = await polishWaitFor(h, `!${LINE}`, WAIT_MS);
            const choice = await page(h, `return fx.calls.choice;`);
            const final = s.line?.height ?? 0;
            const collapsing = frames.filter((l) => l != null && l.height > 0 && l.height < final);
            // New board from this, on a second request: the Boards surface with its form
            await page(
                h,
                `${changeTalk(
                    ctx,
                    `talk.turns.push({ id: "n2", ts: Date.now(), state: "asks", route: "draw", question: ${q(NEEDS_Q)}, reply: "A new board?" });`
                )} return true;`
            );
            await polishWaitFor(h, lineIs("n2", "asks"), WAIT_MS);
            await h.ev(`${LINE}?.querySelector('[data-board-choice="new"]')?.click()`);
            const form = await polishWaitFor(h, `!!${BOARDS_SURFACE}?.querySelector("[data-board-ask-form]")`, WAIT_MS);
            const surface = await h.activeSurfaceLabel();
            await h.shot(SHOT("W1", "new-board-form"));
            await h.ev(`${BOARDS_SURFACE}?.querySelector("[data-board-form-cancel]")?.click()`);
            await page(h, `${changeTalk(ctx, `talk.turns.find((t) => t.id === "n2").choice = "new";`)} return true;`);
            await h.goto("agent");
            const back = await polishWaitFor(h, `!!${TAB}?.querySelector(".excalidraw") && !${LINE}`, WAIT_MS);
            const ok =
                shown &&
                s.line?.words === `"${NEEDS_Q}" wants a new board` &&
                q(s.line.actions) === q(["New board from this", "Keep it here"]) &&
                s.line.breathes &&
                s.placeholder === "Select shapes to ask about them" &&
                cleared &&
                q(choice.map((d) => [d.turnid, d.choice])) === q([["n1", "keep"]]) &&
                collapsing.length > 0 &&
                form &&
                surface === "Boards" &&
                back;
            return { ok, detail: q({ s, cleared, choice, collapsing: collapsing.length, frames: frames.length, moved: frames.findIndex((l) => l == null || l.height < final), form, surface, back }) };
        });

        await run("W1 narrow window: at 1000px wide the bar fits the pane: the facts at its end and the agent chip's label are truncated, the input group keeps at least 200px, and Ask is fully visible", async () => {
            await h.cdp("Emulation.setDeviceMetricsOverride", NARROW);
            await polishNap(SETTLE_MS);
            const s = await readTab(h);
            await h.shot(SHOT("W1", "narrow"));
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            await polishNap(SETTLE_MS);
            const ok = s.bar && s.factsTruncated && s.groupPx >= MIN_BOX_PX && s.barFits && s.askVisible && s.chipTruncated;
            return { ok, detail: q(s) };
        });

        await run("W1 drawings row: in the narrow board tab the row shows the board's one drawing, Earlier drawings; a drawing landed through the page's live apply joins the row as current and lies wholly inside the tab's visible canvas", async () => {
            const ROW = `[...(${TAB}?.querySelectorAll("[data-board-drawings] [data-board-drawing]") ?? [])]`;
            const readRow = () =>
                h.ev(`${ROW}.map((b) => ({
                    id: b.getAttribute("data-board-drawing"),
                    title: b.querySelector("[data-board-drawing-title]")?.textContent ?? "",
                    current: b.getAttribute("aria-current") === "true",
                }))`);
            await h.cdp("Emulation.setDeviceMetricsOverride", NARROW);
            await polishNap(SETTLE_MS);
            const before = await readRow();
            await page(
                h,
                `await B.liveBoardApply(${q(ctx.boardId)})({
                    id: "fx-live-drawing", channelid: fx.channelId, boardid: ${q(ctx.boardId)}, turnid: "fx-live",
                    add: ${q(JSON.stringify(LIVE_DRAWING.add))}, title: ${q(LIVE_DRAWING.title)}, ts: Date.now(),
                });
                return true;`
            );
            await polishWaitFor(h, `${ROW}.length === 2`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const after = await readRow();
            const view = await h.ev(`(() => {
                const a = ${TAB_APP}, s = a?.state;
                const f = a?.scene.getNonDeletedElements().find((e) => e.id === ${q(after.at(-1)?.id ?? "")});
                if (f == null) return null;
                const z = s.zoom.value, left = (f.x + s.scrollX) * z, top = (f.y + s.scrollY) * z;
                return { left, top, right: left + f.width * z, bottom: top + f.height * z, width: s.width, height: s.height };
            })()`);
            await h.shot(SHOT("W1", "drawings-row"));
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            await polishNap(SETTLE_MS);
            const ok =
                before.length === 1 &&
                before[0].title === "Earlier drawings" &&
                before[0].current &&
                after.length === 2 &&
                after[1].title === LIVE_DRAWING.title &&
                after[1].current &&
                view != null &&
                view.left >= 0 &&
                view.top >= 0 &&
                view.right <= view.width &&
                view.bottom <= view.height;
            return { ok, detail: q({ before, after, view }) };
        });

        await run("W2 expanded: Expand gives the turns column (the agent's request rows, the copied reply with Back to the transcript and Draw instead, the agent's request being drawn with its seconds) with no ask box, beside the full-width canvas with the ask bar under it; Back to the transcript returns to W1 with the drawing line", async () => {
            // W1's own turns leave; your line goes to the agent and its reply lands, while the agent's next request is drawn
            await page(
                h,
                `${changeTalk(
                    ctx,
                    `talk.turns = talk.turns.filter((t) => ["r1", "r2", "r3", "r4"].includes(t.id));
                    talk.turns.push({ id: "r5", ts: Date.now() - 60 * ${SEC}, state: "forwarded", route: "agent", question: "Who restarts a crashed worker?", forward: { state: "replied", tabid: ${q(ctx.agentId)}, title: ${q(AGENT_NAME)}, runtime: "claude", sentts: Date.now() - 50 * ${SEC}, reply: ${q(AGENT_REPLY)}, replyts: Date.now() } });
                    talk.turns.push({ id: "r6", ts: Date.now() - 4000, state: "answering", briefing: { from: ${q(AGENT_NAME)}, text: "", ask: "who restarts a crashed worker" } });`
                )} return true;`
            );
            await polishWaitFor(h, lineIs("r6", "drawing"), WAIT_MS);
            await h.ev(`${ASIDE}?.querySelector("[data-workspace-expand]")?.click()`);
            const turnOf = (id, kind) => `${TALK}?.querySelector('[data-board-turn="${id}"][data-board-item="${kind}"]')`;
            const expanded = await polishWaitFor(
                h,
                `${ASIDE}?.getAttribute("data-workspace-pane") === "expanded" && !!${turnOf("r5", "forward")}?.textContent.includes("answered")`,
                WAIT_MS
            );
            await polishNap(SETTLE_MS);
            const s = await page(
                h,
                `const talkEl = ${TALK};
                const canvas = ${TAB}?.querySelector("section[aria-label^='Board:']");
                const bar = ${BAR};
                const reply = ${turnOf("r5", "forward")};
                return {
                    layout: ${TAB}?.getAttribute("data-board-tab"),
                    asked: [...(talkEl?.querySelectorAll('[data-board-item="briefing"]') ?? [])].map((el) => [el.getAttribute("data-board-turn"), t(el)]),
                    line: t(reply?.querySelector("[data-board-forward-line]")),
                    reply: t(reply?.querySelector("[data-board-forward-reply]")),
                    back: t(reply?.querySelector("[data-board-back]")),
                    reroute: t(reply?.querySelector("[data-board-reroute]")),
                    working: t(${turnOf("r6", "working")}),
                    talkAskBox: !!talkEl?.querySelector("[data-board-ask-box]"),
                    barLine: !!${LINE},
                    barUnderCanvas: bar != null && canvas != null && talkEl != null && bar.getBoundingClientRect().top >= canvas.getBoundingClientRect().bottom - 1 && bar.getBoundingClientRect().left >= talkEl.getBoundingClientRect().right - 1,
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
                !s.talkAskBox &&
                !s.barLine &&
                s.barUnderCanvas &&
                s.canvas &&
                s.canvasBesideTalk &&
                s.canvasPx >= s.pane - s.talkPx - 2 &&
                back &&
                w1.pane === "open" &&
                w1.layout === "beside" &&
                w1.line?.id === "r6" &&
                w1.line.state === "drawing" &&
                /^"who restarts a crashed worker" Drawing · \d+ s$/.test(w1.line.words) &&
                w1.bar &&
                w1.barUnderCanvas &&
                q(w1.buttons) === q(["Stop"]) &&
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

        await run("Edit is the board's: Edit, turned on in the agent's board tab, is still on for that board on the Boards surface and on the tab after switching back", async () => {
            // the Edit switch under scope, and the view mode and toolbar of the canvas beside it
            const readEdit = (scope) =>
                page(
                    h,
                    `const scope = ${scope};
                    const el = scope?.querySelector(".excalidraw");
                    const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
                    let app = null;
                    for (let f = key ? el[key] : null; f != null && app == null; f = f.return) {
                        if (typeof f.stateNode?.updateScene === "function" && f.stateNode?.scene != null) app = f.stateNode;
                    }
                    return {
                        edit: scope?.querySelector("[data-board-edit]")?.getAttribute("aria-pressed") ?? null,
                        viewMode: app?.state?.viewModeEnabled ?? null,
                        toolbar: !!el?.querySelector(".App-toolbar"),
                    };`
                );
            if ((await h.ev(`${TAB_EDIT}?.getAttribute("aria-pressed")`)) !== "true") {
                await h.ev(`${TAB_EDIT}?.click()`);
            }
            await polishWaitFor(h, `${TAB_EDIT}?.getAttribute("aria-pressed") === "true"`, 5000);
            const tab = await readEdit(TAB);
            await page(h, `await B.loadBoardList(fx.channelId); B.selectBoard(fx.channelId, ${q(ctx.boardId)}); return true;`);
            await h.goto("boards");
            const onBoards = await polishWaitFor(
                h,
                `${text(SWITCHER)} === ${q(BOARD)} && !!${BOARDS_SURFACE}?.querySelector(".excalidraw .App-toolbar")`,
                WAIT_MS
            );
            const boards = await readEdit(BOARDS_SURFACE);
            await h.shot(SHOT("edit", "on-boards"));
            await h.goto("agent");
            const back = await polishWaitFor(h, `!!${TAB}?.querySelector(".excalidraw .App-toolbar")`, WAIT_MS);
            const tabAgain = await readEdit(TAB);
            const on = (r) => r.edit === "true" && r.viewMode === false && r.toolbar;
            const ok = on(tab) && onBoards && on(boards) && back && on(tabAgain);
            return { ok, detail: q({ tab, onBoards, boards, back, tabAgain }) };
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
        // the width is stored, so left at PANE_PX it narrows every later scenario's transcript column
        await step("restore the pane width", () =>
            ctx.prevWidth != null ? page(h, `globalStore.set(W.workspaceWidthAtom, ${ctx.prevWidth}); return true;`) : null
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
