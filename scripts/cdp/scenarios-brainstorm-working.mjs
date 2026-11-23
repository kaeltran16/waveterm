// The Working view while the agent is in a turn: its live step (verb, target, elapsed time), and a thumbnail of each
// board written this turn; the design's working note draws the same step line. kit is scenarios-brainstorm.mjs's
// BS_KIT.
//
// The agent is faked (docs/superpowers/specs/2026-11-10-brainstorm-working-visibility-design.md): agent:status with
// state and transcriptpath, the block's agent:turnstartts, and a fixture transcript appended to as the turn goes on,
// which the live stream tails as it does a real agent's. The brainstorm asks question 3 and names no canvas yet: the
// first mockup turn.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolResult, toolUse, userText, writeTranscript } from "./agent-page-fixtures.mjs";

const NAME = "brainstorm-working";
const TOPIC = "lag-page-working";
const CANVAS = "lag-page";
const PAGE = "Page.dc.html";
const TREND = "Page-trend.dc.html";
const PAGE_SIZE = { w: 760, h: 640 };
const TURN_AGO_MS = 102_000;
const FILE_AGO_MS = 10 * 60_000;
const WAIT_MS = 10_000;
const ANSWER = "Lead with the lag number, then the trend.";
const BACKGROUND = "Researching how other alert tools page.";
const NEXT = "The next question comes after.";
const NOTE_TAIL = "Confirm, edit and keep open again when it asks its next question.";
const NOTE_FULL = `The agent is writing. ${NOTE_TAIL}`;
const ELAPSED = /^(\d+)m (\d{2})s$/;

const file = (over) => ({
    v: 1,
    title: "Consumer lag alerts",
    spec: "",
    question: { n: 3, part: "page", text: "What should on-call see first when the page fires?" },
    working: null,
    parts: [{ id: "page", title: "What on-call sees", state: "asked", body: "" }],
    history: [],
    done: false,
    check: null,
    run: null,
    ...over,
});
const ASKING = file({});
const BACKGROUND_FILE = file({ question: null, working: BACKGROUND });

// a light page, so a board reads against the dark theme in the shots
const board = (title) =>
    `<!doctype html><title>${title}</title><body style="margin:0;padding:40px;background:#fff"><h1 style="font:96px sans-serif">${title}</h1></body>`;
const elapsedMs = (t) => {
    const m = ELAPSED.exec(t ?? "");
    return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null;
};
export default function (kit) {
    const { bsArrangeAgent, bsShowFile, bsTeardownAgent, bsWrite, bsOpenDesign, bsCloseDesign, polishNap, skipStep, BS_PANE } =
        kit;

    // agent:status as the hook publishes it, with a ts past every earlier one or the server drops it as stale
    const publish = (h, ctx, state) => {
        ctx.lastTs = Math.max(Date.now(), (ctx.lastTs ?? 0) + 1);
        return h.rpc("eventpublish", {
            event: "agent:status",
            scopes: [`block:${ctx.blockId}`],
            persist: 1,
            data: {
                oref: `block:${ctx.blockId}`,
                state,
                agent: "claude",
                cwd: ctx.cwd,
                transcriptpath: ctx.transcript,
                ts: ctx.lastTs,
            },
        });
    };

    // the verb is read from textContent: the VERB class uppercases it on screen
    const read = (h) =>
        h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const text = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
            const pane = ${BS_PANE};
            const stepOf = (root) => {
                const s = root?.querySelector("[data-brainstorm-step]");
                return s
                    ? {
                          verb: text(s.querySelector("[data-brainstorm-step-verb]")),
                          target: text(s.querySelector("[data-brainstorm-step-target]")),
                          elapsed: s.querySelector("[data-brainstorm-step-elapsed]") ? text(s.querySelector("[data-brainstorm-step-elapsed]")) : null,
                      }
                    : null;
            };
            const working = pane?.querySelector("[data-brainstorm-working]");
            const boards = working?.querySelector("[data-brainstorm-turn-boards]");
            const note = pane?.querySelector("[data-brainstorm-working-note]");
            // a board opened full size draws in the canvas window, over the pane
            const win = document.querySelector("[data-canvas-window]");
            const canvas = win?.querySelector("[data-canvas-pane]");
            return {
                view: pane?.getAttribute("data-brainstorm-view") ?? null,
                working: working ? flat(working) : null,
                step: stepOf(working),
                boards: boards
                    ? {
                          head: text(boards.firstElementChild),
                          chips: [...boards.querySelectorAll("[data-brainstorm-board-chip]")].map((c) => ({
                              name: c.getAttribute("data-brainstorm-board-chip"),
                              label: flat(c),
                              latest: c.hasAttribute("data-brainstorm-board-chip-latest"),
                          })),
                          frames: boards.querySelectorAll("iframe").length,
                      }
                    : null,
                note: note
                    ? {
                          text: text(note),
                          inner: flat(note),
                          step: stepOf(note),
                          chips: note.querySelectorAll("[data-brainstorm-board-chip]").length,
                      }
                    : null,
                canvas: canvas
                    ? {
                          topic: text(canvas.querySelector("span.font-mono")),
                          board: canvas.querySelector("[data-canvas-board]")?.getAttribute("data-canvas-frame") ?? null,
                          tabs: [...win.querySelectorAll('[role="tab"]')].map(flat),
                          scoped: !!win.querySelector("[data-canvas-scope-source]"),
                          band: !!win.querySelector("[data-brainstorm-band]"),
                      }
                    : null,
            };
        })()`);

    // polls the pane until want(read) holds; the last read and whether it did
    const until = async (h, want, ms = WAIT_MS) => {
        const start = Date.now();
        let r;
        do {
            r = await read(h).catch((e) => ({ error: String(e?.message ?? e) }));
            if (r.error == null && want(r)) return { ...r, ok: true };
            await polishNap(250);
        } while (Date.now() - start < ms);
        return { ...r, ok: false };
    };

    const append = (ctx, ...lines) => appendFileSync(ctx.transcript, lines.join("\n") + "\n");
    const call = (id, name, input, result) => [toolUse(id, name, input), toolResult(id, result)];
    const boardPath = (ctx, name) => join(ctx.cwd, ".superpowers", "design", CANVAS, "project", name);

    async function assert(h, ctx) {
        const missing = await bsShowFile(h, ctx);
        if (missing != null) return [skipStep(NAME, `could not verify: ${missing}`)];
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: JSON.stringify(detail) });

        // 1. the turn has only the user's answer: no step known yet
        const r1 = await until(h, (r) => (r.working ?? "").includes("Writing up your answer."));
        await h.shot("cdp-shots/brainstorm-working-1-answer-only.png");
        rec(
            "1. a turn with only the answer: Writing up your answer., no step line, The next question comes after. kept, no boards",
            r1.ok && r1.step == null && r1.working.includes(NEXT) && r1.boards == null,
            r1
        );

        // 2. a Read: the step line names it, with the turn's elapsed time
        append(ctx, ...call("toolu_read1", "Read", { file_path: join(ctx.cwd, "DESIGN.md") }, "# Design"));
        const r2 = await until(h, (r) => r.step?.verb === "read");
        await h.shot("cdp-shots/brainstorm-working-2-step.png");
        const ms2 = elapsedMs(r2.step?.elapsed);
        rec(
            "2. a Read: step read DESIGN.md with the turn's elapsed time (at least 1m 42s), no boards section",
            r2.ok &&
                r2.step.target === "DESIGN.md" &&
                ms2 != null &&
                ms2 >= TURN_AGO_MS &&
                !(r2.working ?? "").includes(NEXT) &&
                r2.boards == null,
            r2
        );

        // 3. two board writes: the step is the last, both boards as chips in write order, the last one marked
        append(
            ctx,
            ...call("toolu_write1", "Write", { file_path: boardPath(ctx, PAGE), content: board(PAGE) }, "File created"),
            ...call("toolu_write2", "Write", { file_path: boardPath(ctx, TREND), content: board(TREND) }, "File created")
        );
        const r3 = await until(h, (r) => r.step?.verb === "wrote" && r.boards?.chips.length === 2);
        await h.shot("cdp-shots/brainstorm-working-3-boards.png");
        rec(
            "3. two board writes: step wrote Page-trend.dc.html, Boards made this turn · 2, Page then Page-trend as chips by name with no iframe, the latest mark on Page-trend only",
            r3.ok &&
                r3.step.target === TREND &&
                r3.boards.head === "Boards made this turn · 2" &&
                JSON.stringify(r3.boards.chips.map((c) => c.name)) === JSON.stringify([PAGE, TREND]) &&
                JSON.stringify(r3.boards.chips.map((c) => c.label)) === JSON.stringify(["Page", "Page-trend"]) &&
                JSON.stringify(r3.boards.chips.filter((c) => c.latest).map((c) => c.name)) === JSON.stringify([TREND]) &&
                r3.boards.frames === 0,
            r3
        );

        // 4. (WinToday) a chip opens today's unscoped window on that board; Close returns to the Working view. The
        // design's note
        await h.ev(`${BS_PANE}?.querySelector('[data-brainstorm-turn-boards] [data-brainstorm-board-chip="${PAGE}"]')?.click()`);
        const r4 = await until(h, (r) => r.canvas?.board === PAGE);
        await h.shot("cdp-shots/brainstorm-working-4-full-size.png");
        await h.ev(`document.querySelector('[data-canvas-window] button[aria-label="Close"]')?.click()`);
        const r4b = await until(h, (r) => r.canvas == null && r.working != null && r.boards != null);
        rec(
            "4. (WinToday) the Page chip opens today's unscoped canvas window on it: every board by name with All, no scope and no band; its Close returns to the Working view",
            r4.ok &&
                r4.canvas.topic === CANVAS &&
                JSON.stringify(r4.canvas.tabs) === JSON.stringify(["All", "Page", "Page-trend"]) &&
                !r4.canvas.scoped &&
                !r4.canvas.band &&
                r4b.ok,
            { canvas: r4.canvas, view: r4.view, back: r4b.view }
        );
        const opened = await bsOpenDesign(h);
        const r4d = await until(h, (r) => r.note?.step != null);
        await h.shot("cdp-shots/brainstorm-working-4-design-note.png");
        rec(
            "4b. the design's note starts with the step (wrote Page-trend.dc.html) and ends with Confirm, edit and keep open again when it asks its next question., no board chips",
            opened &&
                r4d.ok &&
                r4d.note.step.verb === "wrote" &&
                r4d.note.step.target === TREND &&
                r4d.note.text.startsWith(`wrote${TREND}`) &&
                r4d.note.text.endsWith(NOTE_TAIL) &&
                r4d.note.chips === 0,
            { opened, note: r4d.note }
        );
        await bsCloseDesign(h);

        // 5. the agent ended its turn but the file still says working (background work): the plain view, no stale step
        bsWrite(ctx, BACKGROUND_FILE);
        await publish(h, ctx, "idle");
        const r5 = await until(h, (r) => (r.working ?? "").includes(BACKGROUND) && r.step == null);
        await h.shot("cdp-shots/brainstorm-working-5-background.png");
        rec(
            "5. background work with the agent idle: its working line and The next question comes after., no step line, no boards",
            r5.ok && r5.working.includes(NEXT) && r5.boards == null,
            r5
        );
        const opened5 = await bsOpenDesign(h);
        const r5d = await until(h, (r) => r.note != null);
        await h.shot("cdp-shots/brainstorm-working-5-design-note.png");
        rec(
            "5b. the design's note reads its full original sentence, no step",
            opened5 && r5d.ok && r5d.note.inner === NOTE_FULL && r5d.note.step == null,
            { opened5, note: r5d.note }
        );
        await bsCloseDesign(h);
        return steps;
    }

    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const ctx = await bsArrangeAgent(h, TOPIC, ASKING);
                if (ctx.launchError != null || ctx.cwd == null) return ctx;
                try {
                    // asked long before the turn, so the turn reads as the user's answer
                    const asked = new Date(Date.now() - FILE_AGO_MS);
                    utimesSync(ctx.file, asked, asked);
                    const project = join(ctx.cwd, ".superpowers", "design", CANVAS, "project");
                    mkdirSync(project, { recursive: true });
                    writeFileSync(
                        join(project, "canvas.json"),
                        JSON.stringify({ boards: { [PAGE]: PAGE_SIZE, [TREND]: PAGE_SIZE }, order: [PAGE, TREND] })
                    );
                    writeFileSync(join(project, PAGE), board(PAGE));
                    writeFileSync(join(project, TREND), board(TREND));
                    ctx.transcriptDir = mkdtempSync(join(tmpdir(), "verify-bs-working-"));
                    ctx.transcript = writeTranscript(ctx.transcriptDir, NAME, [userText(ANSWER, { cwd: ctx.cwd })]);
                    await h.rpc("setmeta", {
                        oref: `block:${ctx.blockId}`,
                        meta: { "agent:turnstartts": Date.now() - TURN_AGO_MS },
                    });
                    await publish(h, ctx, "working");
                } catch (e) {
                    ctx.launchError = String(e?.message ?? e);
                }
                return ctx;
            },
            assert,
            async teardown(h, ctx) {
                await bsTeardownAgent(h, ctx, NAME);
                if (ctx.transcriptDir) {
                    try {
                        rmSync(ctx.transcriptDir, { recursive: true, force: true });
                    } catch (e) {
                        console.error(`${NAME} teardown: remove the transcript dir failed: ${e?.message ?? e}`);
                    }
                }
            },
        },
    ];
}
