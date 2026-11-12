// Boards scenario `boards-follow` (A1): a followed agent's row in the Agent tree shows a chip naming the board and a
// Stop chip; the chip opens the board (the landing only: the surface itself is checked by boards-surface); Stop
// removes both chips and clears the follow keys. The agent is a real pending tab with the follow keys set by setmeta,
// beside a real channel and board, so nothing an agent runs is started.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentPage, closeTabs, focusAgent, makeTab, restoreRoster, setRoster } from "./agent-page-fixtures.mjs";
import { waveService } from "./scenarios-shared.mjs";

const NAME = "boards-follow";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const WAIT_MS = 10_000;
const FOLLOW_KEYS = ["board:followid", "board:followchannel", "board:followname", "board:followask"];

const ROW = (id) => `document.querySelector('[data-agent-tree] [data-tree-agent="${id}"]')`;
// the row's chips, found by their text: the board chip is the one that is neither Stop nor the pane tag
const chipsOf = (id, boardName) => `(() => {
    const row = ${ROW(id)};
    const buttons = [...(row?.querySelectorAll("button") ?? [])];
    const text = (b) => (b.textContent ?? "").replace(/\\s+/g, " ").trim();
    return {
        board: buttons.find((b) => text(b) === ${JSON.stringify(boardName)}) ?? null,
        stop: buttons.find((b) => text(b) === "Stop") ?? null,
    };
})()`;

export const boardsFollow = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = randomUUID().slice(0, 8);
        const ctx = { tag, tabIds: [], boardName: `Escalation ${tag}` };
        await h.goto("agent");
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            ctx.dir = mkdtempSync(join(tmpdir(), "verify-boards-follow-"));
            await setRoster(h, []);
            ctx.channelId = (await h.rpc("createchannel", { name: `verify-boards-follow-${tag}`, projectpath: ctx.dir })).oid;
            const board = await h.rpc("boardcreate", { channelid: ctx.channelId, name: ctx.boardName });
            ctx.boardId = board.id;
            ctx.boardsDir = dirname(board.path);
            const tab = await makeTab(h, ctx, { label: `follow-${tag}`, pending: true });
            ctx.agentId = tab.tabId;
            await h.rpc("setmeta", {
                oref: `tab:${ctx.agentId}`,
                meta: {
                    "board:followid": ctx.boardId,
                    "board:followchannel": ctx.channelId,
                    "board:followname": ctx.boardName,
                    "board:followask": "the escalation flow",
                },
            });
            await focusAgent(h, ctx.agentId);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("arrange the channel, board and followed agent", false, ctx.arrangeError);
            return steps;
        }

        // 1. the followed row carries the board chip and Stop
        const followed = await agentPage(
            h,
            `const chips = () => ${chipsOf(ctx.agentId, ctx.boardName)};
            const shown = await until(() => chips().board != null && chips().stop != null, ${WAIT_MS});
            await nap(500);
            const c = chips();
            return { shown, board: c.board?.title ?? null, stop: c.stop?.title ?? null, row: flat(${ROW(ctx.agentId)}) };`
        );
        await h.shot(SHOT(1, "followed-row"));
        rec("1. the followed row shows a chip naming the board and a Stop chip", followed.shown, JSON.stringify(followed));

        // 2. the chip lands on the Boards surface with the board selected
        const opened = await agentPage(
            h,
            `const model = agentsModel();
            const B = await mod("app/view/boards/boardstore.ts");
            ${chipsOf(ctx.agentId, ctx.boardName)}.board?.click();
            const landed = await until(
                () => globalStore.get(model.surfaceAtom) === "boards" && globalStore.get(B.openBoardByChannelAtom)[${JSON.stringify(ctx.channelId)}] === ${JSON.stringify(ctx.boardId)},
                ${WAIT_MS}
            );
            await nap(400);
            return {
                landed,
                surface: globalStore.get(model.surfaceAtom),
                open: globalStore.get(B.openBoardByChannelAtom)[${JSON.stringify(ctx.channelId)}] ?? null,
            };`
        );
        await h.shot(SHOT(2, "chip-opens-board"));
        rec("2. the board chip opens the board on the Boards surface", opened.landed, JSON.stringify(opened));

        // 3. Stop removes both chips and the keys
        await focusAgent(h, ctx.agentId);
        const stopped = await agentPage(
            h,
            `const chips = () => ${chipsOf(ctx.agentId, ctx.boardName)};
            await until(() => chips().stop != null, ${WAIT_MS});
            chips().stop?.click();
            const gone = await until(() => chips().board == null && chips().stop == null, ${WAIT_MS});
            await nap(300);
            return { gone, row: flat(${ROW(ctx.agentId)}) };`
        );
        const tab = await waveService(h, "object", "GetObject", [`tab:${ctx.agentId}`]);
        const left = FOLLOW_KEYS.filter((k) => tab?.meta?.[k] != null);
        await h.shot(SHOT(3, "follow-stopped"));
        rec(
            "3. Stop removes both chips and clears the follow keys on the tab",
            stopped.gone && left.length === 0,
            JSON.stringify({ ...stopped, keysLeft: left })
        );
        return steps;
    },
    // best-effort, so one failed step does not strand the rest
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`${NAME} teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("close the tabs", () => closeTabs(h, ctx));
        await step("restore the roster", () => restoreRoster(h));
        if (ctx?.channelId) await step("delete the channel", () => h.rpc("deletechannel", { channelid: ctx.channelId }));
        if (ctx?.boardsDir) await step("remove the board's project dir", () => rmSync(ctx.boardsDir, { recursive: true, force: true, maxRetries: 3 }));
        if (ctx?.dir) await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 3 }));
        await step("go home", () => h.goto("cockpit"));
    },
};

export const BOARDS_FOLLOW_SCENARIOS = [boardsFollow];
