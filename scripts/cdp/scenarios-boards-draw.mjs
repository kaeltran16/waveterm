// Boards scenarios (draw): Draw on a board… in the palette, on a fixture agent (D1). The boards are made through the
// real board file RPCs in a scratch project; BoardDrawCommand is stubbed in the page to record its call, so no scribe
// runs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    lookEval,
    openPalette,
    PALETTE,
    PALETTE_INPUT,
    paletteKey,
    paletteStateWhen,
    PEEKS_ESC,
    polishNap,
    polishWaitFor,
    setInputExpr,
    setPageRoster,
} from "./scenarios-shared.mjs";

const NAME = "boards-draw";
const AGENT_ID = "fx-board-agent";
const AGENT_NAME = "claude · boards-draw";
const BOARDS = ["Brainstorm internals", "dag-lock bug"];
const NEW_BOARD = "Escalation flow";
const ASK = "the escalation flow";
const STEP_WAIT_MS = 5000;
const CALLS = "__boardDrawCalls";

const rowsOf = (s) => s?.groups.flatMap((g) => g.rows) ?? [];
// the drill's crumbs and separators are sibling spans, so its flat text has no spaces around ›
const drillOf = (s) => (s?.drill ?? "").replace(/\s*›\s*/g, " › ");
const echoOf = `(${PALETTE}?.querySelector('.border-t .truncate')?.textContent ?? '').trim()`;
const FOLLOW = `${PALETTE}?.querySelector('[data-palette-follow]')?.getAttribute('aria-checked') ?? null`;
const BOARD_STEP = `${PALETTE}?.querySelector('[data-palette-board-step]')?.getAttribute('data-palette-board-step') ?? null`;

// BoardDrawCommand records its call and resolves, with the real one kept to put back
const stubDraw = (h) =>
    lookEval(
        h,
        `const { RpcApi } = await mod("app/store/wshclientapi.ts");
        (window.__heldRpc ??= {}).BoardDrawCommand ??= RpcApi.BoardDrawCommand;
        window.${CALLS} = [];
        RpcApi.BoardDrawCommand = (_client, data) => {
            window.${CALLS}.push(data);
            return Promise.resolve();
        };
        return true;`
    );
const unstubDraw = (h) =>
    lookEval(
        h,
        `const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const held = window.__heldRpc?.BoardDrawCommand;
        if (held) RpcApi.BoardDrawCommand = held;
        delete window.__heldRpc?.BoardDrawCommand;
        delete window.${CALLS};
        return true;`
    );

export const BOARDS_DRAW_SCENARIOS = [
    {
        name: NAME,
        surface: "cockpit",
        async arrange(h) {
            const tag = Date.now().toString(36);
            const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-boards-draw-")), project: `verify-boards-draw-${tag}` };
            ctx.channelId = (await h.rpc("createchannel", { name: ctx.project, projectpath: ctx.cwd })).oid;
            ctx.boards = [];
            for (const name of BOARDS) {
                ctx.boards.push(await h.rpc("boardcreate", { channelid: ctx.channelId, name }));
            }
            // an agent at the project's cwd draws there, whatever project the palette is in
            await setPageRoster(h, [
                { id: AGENT_ID, name: AGENT_NAME, task: "", state: "idle", agent: "claude", blockId: "fx-board-blk", cwd: ctx.cwd },
            ]);
            await stubDraw(h);
            return ctx;
        },
        async assert(h, ctx) {
            const steps = [];
            const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
            if (!(await openPalette(h))) {
                rec("1. pick a board", false, "the palette input never showed");
                return steps;
            }
            // the agent's row, then its actions, then Draw on a board…
            await h.ev(setInputExpr(PALETTE_INPUT, `a:${AGENT_NAME}`));
            await paletteStateWhen(h, (s) => (s.selected ?? "").includes(AGENT_NAME) && s.chip, STEP_WAIT_MS);
            await h.ev(paletteKey("ArrowRight"));
            await paletteStateWhen(h, (s) => s.drill != null, STEP_WAIT_MS);
            await h.ev(setInputExpr(PALETTE_INPUT, "draw on"));
            await paletteStateWhen(h, (s) => (s.selected ?? "").startsWith("Draw on a board"), STEP_WAIT_MS);
            await h.ev(paletteKey("Enter"));

            // 1. pick a board: the project's boards with their counts, then New board…
            const picking = await paletteStateWhen(h, (s) => rowsOf(s).some((r) => r.includes(BOARDS[0])), STEP_WAIT_MS);
            await h.shot("cdp-shots/boards-draw-1-pick.png");
            const rows = rowsOf(picking);
            rec(
                "1. pick a board: the project's boards with their counts, then New board…",
                drillOf(picking) === `Agent › ${AGENT_NAME} › Draw on a board…` &&
                    picking.placeholder === "Pick a board, or type to filter" &&
                    // the step slide wraps the groups, so the first group's text starts with the label; read as
                    // textContent, since innerText carries the label's CSS uppercase
                    (picking.groups[0]?.label ?? "").startsWith(`Boards in ${ctx.project}`) &&
                    BOARDS.every((b) => rows.some((r) => r.startsWith(b) && /0 groups · \d\d:\d\d/.test(r))) &&
                    rows.at(-1)?.startsWith("New board…"),
                { drill: drillOf(picking), placeholder: picking?.placeholder, groups: picking?.groups }
            );

            // 2. a typed name no board has becomes New board “…”…, carried into the name step, made on Enter
            await h.ev(setInputExpr(PALETTE_INPUT, NEW_BOARD));
            const typed = await paletteStateWhen(h, (s) => rowsOf(s).length === 1, STEP_WAIT_MS);
            await h.ev(paletteKey("Enter"));
            const naming = await paletteStateWhen(h, (s) => s.placeholder === "Name the new board", STEP_WAIT_MS);
            // the steps swap in wait mode: the name step mounts once the board step's slide has left
            await polishWaitFor(h, `${BOARD_STEP} === "name"`, STEP_WAIT_MS);
            const nameStep = await h.ev(BOARD_STEP);
            await h.ev(paletteKey("Enter"));
            const asking = await paletteStateWhen(h, (s) => drillOf(s).endsWith(`› ${NEW_BOARD}`), STEP_WAIT_MS);
            await polishNap(400); // the step's slide settles before the shot
            await h.shot("cdp-shots/boards-draw-2-new-board.png");
            const listed = await h.rpc("boardlist", { channelid: ctx.channelId });
            const made = (listed?.boards ?? []).find((b) => b.name === NEW_BOARD);
            if (made != null) ctx.boards.push(made);
            rec(
                "2. new board from typed name: New board “Escalation flow”… carries the name, Enter makes it and moves to the ask",
                rowsOf(typed)[0]?.startsWith(`New board “${NEW_BOARD}”…`) &&
                    naming?.query === NEW_BOARD &&
                    nameStep === "name" &&
                    made != null &&
                    drillOf(asking) === `Agent › ${AGENT_NAME} › Draw on a board… › ${NEW_BOARD}` &&
                    asking.placeholder.startsWith("What to draw (optional)"),
                { typed: rowsOf(typed), naming: naming?.query, nameStep, made: made?.id, drill: drillOf(asking) }
            );

            // 3. the ask, and Keep following toggled by Tab, said in the footer
            await h.ev(setInputExpr(PALETTE_INPUT, ASK));
            await paletteStateWhen(h, (s) => s.query === ASK, STEP_WAIT_MS);
            const before = await h.ev(FOLLOW);
            await h.ev(paletteKey("Tab"));
            await polishWaitFor(h, `${FOLLOW} === "true"`, STEP_WAIT_MS);
            const after = await h.ev(FOLLOW);
            const echo = await h.ev(echoOf);
            const still = await paletteStateWhen(h, () => true, 0);
            await h.shot("cdp-shots/boards-draw-3-ask-follow.png");
            const wantEcho = `Draw ${AGENT_NAME}: ${ASK} on ${NEW_BOARD}, and keep following`;
            rec(
                "3. ask and keep following: Tab ticks Keep following at the ask step, and the footer says what Enter does",
                before === "false" &&
                    after === "true" &&
                    echo === wantEcho &&
                    drillOf(still).endsWith(`› ${NEW_BOARD}`) &&
                    /Redraw at each of .*'s turn ends until it closes or you press Stop\. Each redraw is a scribe session\./.test(still?.text ?? ""),
                { before, after, echo, want: wantEcho, drill: drillOf(still) }
            );

            // 4. Enter hands it to the scribe and closes the palette
            await h.ev(paletteKey("Enter"));
            const closed = await polishWaitFor(h, `!${PALETTE_INPUT}`, STEP_WAIT_MS);
            const calls = (await h.ev(`window.${CALLS} ?? null`)) ?? [];
            await h.shot("cdp-shots/boards-draw-4-drawn.png");
            const call = calls[0];
            rec(
                "4. enter draws: one BoardDrawCommand with the board, the agent, the ask and the follow, and the palette closes",
                closed &&
                    calls.length === 1 &&
                    call.channelid === ctx.channelId &&
                    call.boardid === made?.id &&
                    call.source?.kind === "agent" &&
                    call.source.ref === AGENT_ID &&
                    call.source.title === AGENT_NAME &&
                    call.ask === ASK &&
                    call.follow === true,
                { closed, calls, boardId: made?.id }
            );
            return steps;
        },
        async teardown(h, ctx) {
            await h.ev(PEEKS_ESC).catch(() => {});
            await unstubDraw(h).catch(() => {});
            await setPageRoster(h, null).catch(() => {});
            // the boards live in the project's own folder under the data dir, which nothing else uses
            const dir = ctx.boards[0]?.path ? dirname(ctx.boards[0].path) : null;
            if (dir != null && dir.includes(ctx.project.replace(/[<>:"/\\|?*]/g, "_"))) {
                rmSync(dir, { recursive: true, force: true });
            }
            await h.rpc("deletechannel", { channelid: ctx.channelId }).catch(() => {});
            rmSync(ctx.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        },
    },
];
