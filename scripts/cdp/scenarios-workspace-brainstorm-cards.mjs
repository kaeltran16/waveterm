// Scenario `workspace-brainstorm-cards`: the transcript's brainstorm cards while the 600px Brainstorm tab shows
// (docs/superpowers/plans/2026-11-19-brainstorm-tab-polish.md). WBS_KIT's fixture agent asking question 4.
//
// While the tab shows the question, the card is one row (its step, a title, Open brainstorm); behind another tab, the
// pane collapsed or the tab closed, it is the full card again. The design, check and review cards make the same row.

import { RBS_KIT } from "./scenarios-rendered-brainstorm.mjs";
import { BS_Q4, bsFile, bsParts } from "./scenarios-shared.mjs";
import { WBS_KIT } from "./scenarios-workspace-brainstorm-question.mjs";

const NAME = "workspace-brainstorm-cards";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const { polishWaitFor, polishNap, writeFile, waitCard, HOST, WAIT_MS, BS_POLL_WAIT_MS } = RBS_KIT;
const { wbsScenario, tabOpens, store, SETTLE_MS } = WBS_KIT;
// a row of 12.5px text with 8px padding; the full question card is far taller
const ROW_MAX_PX = 48;

// every part settled, two of them the agent's guesses: the design card asks to confirm them
const DESIGN = bsFile({
    parts: bsParts({ intent: "yours", goals: "yours", anti: "yours", constraints: "guess", thresholds: "guess" }),
    done: true,
});
const BUILDER_Q = {
    q: "When a lag page fires, should it also hold the autoscaler, or only report?",
    part: "thresholds",
    options: [
        { label: "Only report", detail: "scaling stays a human call" },
        { label: "Hold it", detail: "until on-call acks" },
    ],
};
// the builder check back with one question for the user
const CHECK = bsFile({
    parts: bsParts({ intent: "yours", goals: "yours", anti: "yours", constraints: "yours", thresholds: "yours" }),
    done: true,
    check: { yours: [BUILDER_Q], calls: [{ text: "Reuse the existing receivers." }], answered: [] },
});
// the check changed a part the user had confirmed: the review card asks to keep it or put it back
const REVIEW = bsFile({
    parts: bsParts(
        { intent: "yours", goals: "yours", anti: "yours", constraints: "yours", thresholds: "guess" },
        { thresholds: { was: "Page when lag has grown for 10 straight minutes.", why: "builder question 1" } }
    ),
    check: {
        yours: [],
        calls: [{ part: "thresholds", text: "Five minutes matches the existing paging rules." }],
        answered: [],
        touched: ["thresholds"],
    },
});

// the host's card as drawn: whether it is the one row, its height, its title and Open, and how many answer rows show
const readCard = (h, attr) =>
    h.ev(`(() => {
        const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
        const card = ${HOST}?.querySelector(${JSON.stringify(`[${attr}]`)});
        return {
            card: card != null,
            row: card?.querySelector("[data-rendered-bs-row]") != null,
            height: card ? Math.round(card.getBoundingClientRect().height) : null,
            title: flat(card?.querySelector("[data-rendered-bs-row-title]")),
            open: card?.querySelector("[data-rendered-bs-open]") != null,
            answers: card?.querySelectorAll("[data-rendered-bs-option]").length ?? 0,
            pill: ${HOST}?.querySelector("[data-needs-input]") != null,
        };
    })()`);

const waitRow = (h, attr, on) =>
    polishWaitFor(h, `${HOST}?.querySelector(${JSON.stringify(`[${attr}] [data-rendered-bs-row]`)}) ${on ? "!=" : "=="} null`, WAIT_MS);

const isRow = (c) => c.card && c.row && c.height != null && c.height < ROW_MAX_PX && c.open && c.answers === 0 && !c.pill;
const isFull = (c) => c.card && !c.row && c.height >= ROW_MAX_PX && c.answers === BS_Q4.options.length && c.open;

const Q = "data-rendered-bs-question";

// a file the agent writes, the card it makes, and that card drawn as the one row; title is the row's
async function rowFor(h, ctx, file, kind, attr, shot) {
    writeFile(ctx, file);
    const drawn = await waitCard(h, kind, BS_POLL_WAIT_MS + WAIT_MS);
    const row = await waitRow(h, attr, true);
    await polishNap(SETTLE_MS);
    const c = await readCard(h, attr);
    await h.shot(shot);
    return { drawn, row, ...c };
}

export const workspaceBrainstormCards = wbsScenario(NAME, async (h, ctx, step) => {
    await step("the 600px Brainstorm tab shows the asking question, and the pane reads itself narrow", () => tabOpens(h, ctx));

    await step("with the tab showing, the question card is one row: its step, the question's text and Open, no answers", async () => {
        const row = await waitRow(h, Q, true);
        const c = await readCard(h, Q);
        await h.shot(SHOT(1, "question-row"));
        return [row && isRow(c) && c.title === BS_Q4.text, { row, ...c }];
    });

    await step("closing the tab brings the full card back with its answers", async () => {
        await store(h, ctx, `W.closeWorkspaceTab(id, "brainstorm"); return true;`);
        const full = await waitRow(h, Q, false);
        await polishNap(SETTLE_MS);
        const c = await readCard(h, Q);
        await store(h, ctx, `W.openWorkspaceTab(id, { kind: "brainstorm" }); return true;`);
        const again = await waitRow(h, Q, true);
        return [full && isFull(c) && again, { full, ...c, again }];
    });

    await step("the pane on another tab brings the full card back, and the Brainstorm tab active makes it one row again", async () => {
        await store(h, ctx, `W.openWorkspaceTab(id, { kind: "changes", selected: null }); return true;`);
        const full = await waitRow(h, Q, false);
        await polishNap(SETTLE_MS);
        const c = await readCard(h, Q);
        await store(h, ctx, `W.activateWorkspaceTab(id, "brainstorm"); W.closeWorkspaceTab(id, "changes"); return true;`);
        const again = await waitRow(h, Q, true);
        return [full && isFull(c) && again, { full, ...c, again }];
    });

    await step("collapsing the pane brings the full card back, and opening it makes it one row again", async () => {
        await store(h, ctx, `W.setWorkspaceCollapsed(id, true); return true;`);
        const full = await waitRow(h, Q, false);
        await polishNap(SETTLE_MS);
        const c = await readCard(h, Q);
        await store(h, ctx, `W.setWorkspaceCollapsed(id, false); return true;`);
        const again = await waitRow(h, Q, true);
        return [full && isFull(c) && again, { full, ...c, again }];
    });

    await step("the design card's row reads Confirm the design", async () => {
        const r = await rowFor(h, ctx, DESIGN, "design", "data-rendered-bs-design", SHOT(2, "design-row"));
        return [r.drawn && r.row && r.height < ROW_MAX_PX && r.open && r.title === "Confirm the design", r];
    });

    await step("the check card's row names the builder step", async () => {
        const r = await rowFor(h, ctx, CHECK, "check", "data-rendered-bs-check-row", SHOT(3, "check-row"));
        return [r.drawn && r.row && r.height < ROW_MAX_PX && r.open && r.title === "Builder question · 1 of 1", r];
    });

    await step("the review card's row reads Review what the check changed", async () => {
        const r = await rowFor(h, ctx, REVIEW, "review", "data-rendered-bs-review", SHOT(4, "review-row"));
        return [r.drawn && r.row && r.height < ROW_MAX_PX && r.open && r.title === "Review what the check changed", r];
    });
});
