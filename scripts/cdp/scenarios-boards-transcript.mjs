// Scenario `boards-transcript` (A3, W1's left half, A1's "what reaches the agent"): a board's question as the agent's
// transcript shows it. The line Arc typed for the board is the person's own message with a "from <board> · on <labels>"
// chip above it, then the agent's one-line `wsh board draw` and its answer below.

import { clearTranscript, HOSTS, openFolds, prose, ROOT, showAt, user, waitSeam } from "./transcript-fixture.mjs";

const T0 = Date.UTC(2026, 10, 19, 9, 0, 0);
const S = 1000;
const BOARD = "Checkout flow";
const LABELS = "Cart, Pay button";
const TURN_ID = "7c1e-42";
const QUESTION = "why do two spinners show while the cart loads?";
const ANSWER = "The cart and the pay button each mount their own loader; I merged them into one on the board.";
const DRAW_COMMAND = `wsh board draw --context "checkout spinners" --ask "merge the two loaders"`;
const NARROW = 360;
// boardforward.Marker in pkg/boardforward/boardforward.go
const FORWARDED = `[From board "${BOARD}" · on ${LABELS} · turn ${TURN_ID}]\n${QUESTION}`;

const drawCall = {
    kind: "action",
    verb: "ran",
    target: DRAW_COMMAND,
    command: DRAW_COMMAND,
    ts: T0 + 5 * S,
    outcome: "ok",
    durationMs: 400,
    detail: { kind: "bash", command: DRAW_COMMAND, output: "drew 1 card", exit: 0 },
};
const ENTRIES = [user(FORWARDED, T0), drawCall, prose(ANSWER, T0 + 20 * S)];

const probe = (body) => `(() => { const root = document.querySelector(${JSON.stringify(ROOT)}); if (!root) return null; ${body} })()`;

// the board row, its chip and the whole feed's text, for the order checks
const FEED = probe(`
    const textOf = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();
    const row = root.querySelector('[data-arc-message="board"]');
    const chip = row?.querySelector('[data-board-chip]');
    const bubble = chip?.nextElementSibling;
    const feed = textOf(root);
    return {
        rows: root.querySelectorAll('[data-arc-message="board"]').length,
        chip: chip ? textOf(chip) : null,
        bubble: bubble ? textOf(bubble) : null,
        rowText: row ? textOf(row) : null,
        chipAboveBubble: !!chip && !!bubble && chip.getBoundingClientRect().bottom <= bubble.getBoundingClientRect().top + 1,
        questionAt: feed.indexOf(${JSON.stringify(QUESTION)}),
        drawAt: feed.indexOf('wsh board draw'),
        answerAt: feed.indexOf(${JSON.stringify(ANSWER)}),
        marker: feed.includes('[From board'),
        overflows: root.scrollWidth > root.clientWidth + 1,
    };
`);

export const boardsTranscript = {
    name: "boards-transcript",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;

        await showAt(h, HOSTS.rendered, ENTRIES);
        await openFolds(h);
        const feed = await h.ev(FEED);
        await h.shot("cdp-shots/boards-transcript-a3-forwarded.png");
        steps.push({
            step: "A3 forwarded question: the chip names the board and its labels above the question as a user message, the one-line wsh board draw and the answer below it",
            ok:
                feed?.rows === 1 &&
                feed.chip === `from ${BOARD} · on ${LABELS}` &&
                feed.bubble === QUESTION &&
                feed.chipAboveBubble &&
                !feed.marker &&
                feed.questionAt >= 0 &&
                feed.questionAt < feed.drawAt &&
                feed.drawAt < feed.answerAt,
            detail: JSON.stringify(feed),
        });

        await showAt(h, HOSTS.compact, ENTRIES, { width: NARROW });
        await openFolds(h);
        const narrow = await h.ev(FEED);
        await h.shot("cdp-shots/boards-transcript-a3-forwarded-compact.png");
        steps.push({
            step: "A3 forwarded question at the compact host (W1's narrow column): the chip and the question, nothing overflows",
            ok: narrow?.rows === 1 && narrow.chip === `from ${BOARD} · on ${LABELS}` && narrow.bubble === QUESTION && !narrow.overflows,
            detail: JSON.stringify(narrow),
        });
        return steps;
    },
    async teardown(h) {
        await clearTranscript(h);
    },
};

export const BOARDS_TRANSCRIPT_SCENARIOS = [boardsTranscript];
