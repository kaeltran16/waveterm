// Scenario rendered-bs-boards: the boards drawn for the open question, inside its card (Main, CanvasUpdated): the
// live board with a tab per board the options name, each option's board chip switching it, the canvas rewritten
// under it, Mark opening the brainstorm pane's board, and the narrow column stacking the chips. kit is
// scenarios-rendered-brainstorm.mjs's RBS_KIT.
//
// The agent revealed the question's canvas in its turn: that reveal draws no Mockup card, since the card holds it.

import { assistantText, toolResult, toolUse, userText } from "./agent-page-fixtures.mjs";

const NAME = "rendered-bs-boards";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const TOPIC = `rbs-boards-${Date.now().toString(36)}`;
const MAIN = "Main.dc.html";
const STATES = "States.dc.html";
// a board's Last-Modified has whole seconds, so a rewrite meant to read as newer than a look waits past one
const PAST_A_SECOND_MS = 1200;

const part = (id, title, state, boards) => ({ id, title, state, body: state === "yours" ? `${title}: settled.` : "", ...(boards ? { boards } : {}) });
const Q4 = {
    n: 4,
    text: "Should a verify waiting for its turn show in the run's graph?",
    part: "queue",
    why: "With one Final at a time, a second run's verify can sit for minutes. Today its node reads the same as a stuck one.",
    options: [
        { label: "A queued chip on the Final node", detail: "the graph says 2nd in line", boards: [MAIN] },
        { label: "Only the attention banner, after 20 minutes", detail: "quiet until it matters" },
        { label: "Both", detail: "the chip at once, the banner after 20 minutes", boards: [STATES] },
    ],
};
const FILE = {
    v: 1,
    title: "Run memory pressure",
    spec: "docs/superpowers/specs/2026-11-17-run-memory-pressure-design.md",
    canvas: TOPIC,
    question: Q4,
    working: null,
    parts: [
        part("what", "What counts", "yours"),
        part("who", "Who it protects", "yours"),
        part("approach", "Approach", "yours"),
        part("queue", "Final queue", "asked", [MAIN, STATES]),
        part("banner", "Banner", "open"),
    ],
    history: [
        { kind: "question", n: 1, q: "Which runs does this need to protect?", a: "Runs with a Final", into: ["what"] },
        { kind: "question", n: 2, q: "What tells Arc memory is running low?", a: "The OS low-memory signal", into: ["who"] },
        { kind: "question", n: 3, q: "How should a run keep its memory under the machine's limit?", a: "One Final at a time", into: ["approach"] },
    ],
    done: false,
    check: null,
    run: null,
};
const REVEAL_ID = "toolu_rbs_boards_reveal";
const TRANSCRIPT = [
    userText("Let's think the memory pressure through before building."),
    toolUse(REVEAL_ID, "Bash", { command: `wsh ui reveal canvas:${TOPIC}`, description: "Show the mockup" }),
    toolResult(REVEAL_ID, ""),
    assistantText("For question 4 I drew how a waiting verify could look in the run's graph."),
];

export default (kit) => {
    const { scenario, polishWaitFor, polishNap, agentPage, HOST, RV, PANE, WAIT_MS, BS_POLL_WAIT_MS } = kit;
    const BLOCK = `${HOST}?.querySelector("[data-rendered-bs-boards]")`;
    const TAB = (b) => `${BLOCK}?.querySelector('[data-live-board-tab="${b}"]')`;
    const FRAME = `${BLOCK}?.querySelector("[data-live-board] iframe")`;
    const CHIP = (row, b) =>
        `${HOST}?.querySelector('[data-rendered-bs-option-row="${row}"] [data-rendered-bs-board-chip="${b}"]')`;
    const shownIs = (b) => `${BLOCK}?.querySelector("[data-live-board]")?.getAttribute("data-live-board") === "${b}"`;
    const flat = (sel) => `(${sel}?.innerText ?? "").replace(/\\s+/g, " ").trim()`;

    // what the block and the option rows draw: the tabs, the board shown, and each row's chips with their pressed state
    const readBoards = (h) =>
        h.ev(`(() => {
            const block = ${BLOCK};
            const rows = [...(${HOST}?.querySelectorAll("[data-rendered-bs-option-row]") ?? [])];
            return {
                tablist: block?.querySelector('[role="tablist"]')?.getAttribute("aria-label") ?? null,
                tabs: [...(block?.querySelectorAll('[role="tab"]') ?? [])].map((t) => t.textContent.trim()),
                selected: block?.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
                shown: block?.querySelector("[data-live-board]")?.getAttribute("data-live-board") ?? null,
                mark: !!block?.querySelector("[data-live-boards-mark]"),
                open: !!block?.querySelector("[data-live-boards-open]"),
                text: ${flat("block")},
                chips: rows.map((r) =>
                    [...r.querySelectorAll("[data-rendered-bs-board-chip]")].map((c) => ({
                        label: c.textContent.trim(),
                        pressed: c.getAttribute("aria-pressed"),
                        title: c.getAttribute("title"),
                    }))
                ),
                mockupCard: !!${RV}?.querySelector("[data-rendered-mockup-card]"),
            };
        })()`);

    const boardsScenario = scenario(NAME, { file: FILE, topic: TOPIC, boards: [MAIN, STATES], transcript: TRANSCRIPT }, async (h, ctx, step) => {
        await step("Main: the question card holds its boards, tabs Main | States, Mark and Open canvas, option 1's chip pressed", async () => {
            const card = await kit.waitCard(h, "question");
            const drawn = await polishWaitFor(h, `!!${FRAME}`, BS_POLL_WAIT_MS);
            const s = await readBoards(h);
            await h.shot(SHOT(1, "main"));
            return [
                card &&
                    drawn &&
                    s.tablist === "Boards for this question" &&
                    s.tabs.join("|") === "Main|States" &&
                    s.selected === "Main" &&
                    s.shown === MAIN &&
                    s.mark &&
                    s.open &&
                    s.text.includes(`the agent's mockup · ${TOPIC}`) &&
                    s.chips.length === 3 &&
                    s.chips[0].length === 1 &&
                    s.chips[0][0].label === "Main" &&
                    s.chips[0][0].pressed === "true" &&
                    s.chips[0][0].title === "Show Main above" &&
                    s.chips[1].length === 0 &&
                    s.chips[2][0]?.label === "States" &&
                    s.chips[2][0]?.pressed === "false" &&
                    !s.mockupCard,
                { card, drawn, ...s },
            ];
        });

        await step("option 3's States chip switches the board shown and presses, option 1's lets go", async () => {
            await h.ev(`${CHIP(2, STATES)}?.click()`);
            const switched = await polishWaitFor(h, `${shownIs(STATES)} && !!${FRAME}`, WAIT_MS);
            const s = await readBoards(h);
            await h.shot(SHOT(2, "states-chip"));
            return [
                switched &&
                    s.selected === "States" &&
                    s.chips[2][0]?.pressed === "true" &&
                    s.chips[0][0]?.pressed === "false",
                { switched, selected: s.selected, chips: s.chips },
            ];
        });

        await step("CanvasUpdated: a board file rewritten reloads the shown board, puts the unseen dot on States, updated <n>s ago", async () => {
            // back on Main through its chip, so States' last look is known and its rewrite comes after it
            await h.ev(`${CHIP(0, MAIN)}?.click()`);
            await polishWaitFor(h, `${shownIs(MAIN)} && !!${FRAME}`, WAIT_MS);
            const before = await h.ev(`(() => { const f = ${FRAME}; if (f) f.__rbsOld = true; return !!f; })()`);
            const noDot = await h.ev(`!${TAB(STATES)}?.querySelector("[data-live-board-unseen]")`);
            await polishNap(PAST_A_SECOND_MS);
            kit.writeBoard(ctx.cwd, TOPIC, MAIN, "Main, with the chip wider");
            kit.writeBoard(ctx.cwd, TOPIC, STATES, "States, with the chip wider");
            const dot = await polishWaitFor(h, `!!${TAB(STATES)}?.querySelector("[data-live-board-unseen]")`, BS_POLL_WAIT_MS);
            const reloaded = await polishWaitFor(h, `${FRAME} != null && !${FRAME}.__rbsOld`, BS_POLL_WAIT_MS);
            const ago = await h.ev(flat(`${BLOCK}?.querySelector("[data-live-boards-ago]")`));
            await h.shot(SHOT(3, "canvas-updated"));
            return [
                before && noDot && dot && reloaded && /updated \d+s ago/.test(ago),
                { before, noDot, dot, reloaded, ago },
            ];
        });

        await step("Mark opens the brainstorm pane's board with marking on", async () => {
            await h.ev(`${BLOCK}?.querySelector("[data-live-boards-mark]")?.click()`);
            const board = await polishWaitFor(h, `${PANE}?.getAttribute("data-brainstorm-view") === "board"`, WAIT_MS);
            const marking = await polishWaitFor(
                h,
                `[...(${PANE}?.querySelectorAll("button[aria-pressed]") ?? [])]
                    .some((b) => (b.textContent || "").trim() === "Mark" && b.getAttribute("aria-pressed") === "true")`,
                WAIT_MS
            );
            const s = await agentPage(
                h,
                `const C = await mod("app/view/agents/canvasstore.ts");
                const c = C.getCanvas(${JSON.stringify(ctx.agentId)});
                return { board: c?.board ?? null, marking: c?.marking ?? null };`
            );
            const rendered = await h.ev(`${RV} != null`);
            await h.shot(SHOT(4, "mark-pane"));
            await agentPage(
                h,
                `const C = await mod("app/view/agents/canvasstore.ts");
                C.setMarking(${JSON.stringify(ctx.agentId)}, false);
                return true;`
            );
            const back = await kit.backToRendered(h, ctx);
            return [board && marking && s.board === MAIN && !rendered && back, { board, marking, ...s, rendered, back }];
        });

        await step("the narrow column stacks each option's chip under its label", async () => {
            const narrowed = await kit.narrow(h);
            await polishWaitFor(h, `!!${CHIP(0, MAIN)}`, WAIT_MS);
            const s = await h.ev(`(() => {
                const rows = [...(${HOST}?.querySelectorAll("[data-rendered-bs-option-row]") ?? [])];
                return rows.map((r) => {
                    const label = r.querySelector("[data-rendered-bs-option-label]")?.getBoundingClientRect();
                    const chip = r.querySelector("[data-rendered-bs-option-chip]")?.getBoundingClientRect();
                    return chip == null ? null : label != null && chip.top >= label.bottom - 1;
                });
            })()`);
            await h.shot(SHOT(5, "narrow"));
            const widened = await kit.widen(h);
            return [narrowed && s[0] === true && s[1] === null && s[2] === true && widened, { narrowed, rows: s, widened }];
        });
    });

    return [boardsScenario];
};
