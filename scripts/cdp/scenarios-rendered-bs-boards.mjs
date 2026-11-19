// Scenario rendered-bs-boards: the boards the open question's card names (Main): no board drawn in the card, each
// option's board chip opening the Brainstorm tab at that board, and the narrow column stacking the chips. kit is
// scenarios-rendered-brainstorm.mjs's RBS_KIT.
//
// The agent revealed the question's canvas in its turn: that reveal draws no Mockup card, since the card holds it.

import { assistantText, toolResult, toolUse, userText } from "./agent-page-fixtures.mjs";

const NAME = "rendered-bs-boards";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const TOPIC = `rbs-boards-${Date.now().toString(36)}`;
const MAIN = "Main.dc.html";
const STATES = "States.dc.html";

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
    const { scenario, polishWaitFor, agentPage, HOST, RV, PANE, WAIT_MS } = kit;
    const CHIP = (row, b) =>
        `${HOST}?.querySelector('[data-rendered-bs-option-row="${row}"] [data-rendered-bs-board-chip="${b}"]')`;

    // what the card and the option rows draw: any board block or iframe, and each row's chips
    const readBoards = (h) =>
        h.ev(`(() => {
            const rows = [...(${HOST}?.querySelectorAll("[data-rendered-bs-option-row]") ?? [])];
            return {
                block: !!${HOST}?.querySelector("[data-rendered-bs-boards]"),
                iframes: ${HOST}?.querySelectorAll("iframe").length ?? -1,
                chips: rows.map((r) =>
                    [...r.querySelectorAll("[data-rendered-bs-board-chip]")].map((c) => ({
                        label: c.textContent.trim(),
                        title: c.getAttribute("title"),
                    }))
                ),
                mockupCard: !!${RV}?.querySelector("[data-rendered-mockup-card]"),
            };
        })()`);

    const boardsScenario = scenario(NAME, { noTab: true, file: FILE, topic: TOPIC, boards: [MAIN, STATES], transcript: TRANSCRIPT }, async (h, ctx, step) => {
        await step("Main: the question card draws no board, and its options carry chips: Main on 1, none on 2, States on 3", async () => {
            const card = await kit.waitCard(h, "question");
            const s = await readBoards(h);
            await h.shot(SHOT(1, "main"));
            return [
                card &&
                    !s.block &&
                    s.iframes === 0 &&
                    s.chips.length === 3 &&
                    s.chips[0].length === 1 &&
                    s.chips[0][0].label === "Main" &&
                    s.chips[0][0].title === "Open Main in the Brainstorm tab" &&
                    s.chips[1].length === 0 &&
                    s.chips[2].length === 1 &&
                    s.chips[2][0].label === "States" &&
                    !s.mockupCard,
                { card, ...s },
            ];
        });

        const chipOpens = (row, board) => async () => {
            await h.ev(`${CHIP(row, board)}?.click()`);
            const opened = await polishWaitFor(h, `${PANE}?.getAttribute("data-brainstorm-view") === "board"`, WAIT_MS);
            const at = await agentPage(
                h,
                `const C = await mod("app/view/agents/canvasstore.ts");
                const c = C.getCanvas(${JSON.stringify(ctx.agentId)});
                return { board: c?.board ?? null, all: c?.all ?? null };`
            );
            const rendered = await h.ev(`${RV} != null`);
            await h.shot(SHOT(board === STATES ? 2 : 3, `${board === STATES ? "states" : "main"}-chip`));
            const back = await kit.closePaneTabs(h, ctx);
            return [opened && at.board === board && !at.all && rendered && back, { opened, ...at, rendered, back }];
        };
        await step("option 3's States chip opens the Brainstorm tab at the States board beside the transcript", chipOpens(2, STATES));
        await step("option 1's Main chip opens the Brainstorm tab at the Main board", chipOpens(0, MAIN));

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
