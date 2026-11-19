// Scenario `workspace-brainstorm-history`: the 600px Brainstorm tab's "Decided so far" history and its removed view
// (docs/superpowers/plans/2026-11-19-brainstorm-tab-polish.md). WBS_KIT's fixture agent asking question 4 with three
// decided; the removed view's copy names the tab here, while brainstorm-mode's step 12c keeps the Terminal center's
// switch. At narrow the rail is a "Decided · N" toggle in the header that swaps the main area to the history (the
// canvas's Main, A2, A3, LA1 and LA2 boards); at 1600px in the Terminal center the rail stays beside the question.

import { rmSync } from "node:fs";
import { RBS_KIT } from "./scenarios-rendered-brainstorm.mjs";
import { BS_HISTORY, BS_Q1, bsFile, bsParts } from "./scenarios-shared.mjs";
import { WBS_KIT } from "./scenarios-workspace-brainstorm-question.mjs";

const NAME = "workspace-brainstorm-history";
const { polishWaitFor, polishNap, writeFile, BS_POLL_WAIT_MS, WAIT_MS } = RBS_KIT;
const { wbsScenario, tabOpens, store, setView, showInCenter, ASKING, BS_IN_TAB, BS_IN_CENTER, SETTLE_MS } = WBS_KIT;

const WORKING = { ...ASKING, question: null, working: "Writing “When it pages” from your answer." };
const FIRST = bsFile({
    parts: bsParts({ intent: "asked", goals: "open", anti: "open", constraints: "open", thresholds: "open" }),
    question: BS_Q1,
});

// the long case: 8 decided, questions that offered 3 to 6 answers, Q7 answered in the user's own words, question 9 asked
const offered = (labels, pick) => labels.map((label, i) => ({ label, detail: `What “${label}” costs.`, ...(i === pick ? { pick: true } : {}) }));
const picked = (n, q, labels, into) => ({ kind: "question", n, q, a: labels[0], options: offered(labels, 0), picked: 0, into });
const Q7_OWN =
    "As long as the replay plus 30 minutes, but never more than 6 hours: a replay that runs longer than that is itself something on-call should hear about, and I would rather get one page at hour six than miss a real stall hiding behind a silence nobody remembers creating.";
const LONG_HISTORY = [
    ...BS_HISTORY,
    picked(4, "When lag keeps growing on an enrichment partition, when should on-call get paged?", ["After 15 minutes of growth", "Past a fixed lag of 100k messages", "Whenever any partition is behind", "Burn-rate on lag seconds", "After 30 minutes of growth"], ["thresholds"]),
    picked(5, "Where does the heads-up at 10 minutes go?", ["#siem-ops, threaded under one message per incident", "#siem-ops, one message per alert", "#enrichment", "Email to the team list"], ["goals"]),
    picked(6, "What should the page say first?", ["The lag in minutes and whether it is still growing", "The consumer group and the partition count stuck", "A link to the Grafana panel", "The last deploy of the consumer", "The broker the partitions sit on", "Everything above, in one line each"], ["page"]),
    {
        kind: "question",
        n: 7,
        q: "How long should a silence for a planned replay last?",
        a: Q7_OWN,
        options: offered(["Exactly as long as the replay", "A fixed 2 hours", "Until someone lifts it", "No silences; mute the receiver"], 0),
        into: ["anti"],
    },
    picked(8, "Who owns the runbook the page links to?", ["The SIEM on-call rotation, in the ops repo", "The enrichment team, in their wiki", "Whoever wrote the rule, in its annotation"], ["page"]),
];
const LONG = bsFile({
    parts: bsParts({ intent: "yours", goals: "yours", anti: "yours", current: "yours", constraints: "yours", thresholds: "yours", page: "yours", builder: "asked" }),
    history: LONG_HISTORY,
    question: {
        n: 9,
        part: "builder",
        text: "Lag on the 11 consumer groups outside enrichment: should it page anyone, or only tell the channel, and should the answer change between office hours and the night?",
        why: "Enrichment has a clear owner and a clear cost when it stalls. The other 11 groups range from the audit archiver, which nobody reads for days, to the alert router, which is on the paging path itself; one rule for all of them will be wrong for some.",
        options: [
            { label: "Page only for the alert router and the dedupe stage; the other 9 post to #siem-ops", detail: "Pages follow the paging path.", pick: true },
            { label: "Channel only, day and night, for all 11", detail: "Nobody is woken for anything outside enrichment." },
            { label: "Page at night only when lag passes 1 hour; channel by day", detail: "Two rules per group and a time window." },
            { label: "Same rule as enrichment for every group", detail: "One rule to maintain." },
            { label: "Leave them out of this change", detail: "Ship enrichment first." },
        ],
    },
});

const ESCAPE = { key: "Escape", code: "Escape", keyCode: 27 };

// what the pane draws of the history: the toggle and where it sits, the main area's kind, the history rows newest
// first with their option lines and fold link, the rail, and how many elements scroll vertically
const read = (h, pane = BS_IN_TAB) =>
    h.ev(`(() => {
        const pane = ${pane};
        const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
        const box = (el) => el?.getBoundingClientRect() ?? null;
        const t = pane?.querySelector("[data-brainstorm-decided]");
        const phase = box(pane?.querySelector("[data-brainstorm-phase]"));
        const track = box(pane?.querySelector("[data-brainstorm-track]"));
        const tb = box(t);
        const list = pane?.querySelector("[data-brainstorm-history]");
        const rows = [...(list?.children ?? [])].map((r) => ({
            label: flat(r.querySelector(".font-mono")),
            items: [...r.querySelectorAll("ul > li")].filter((li) => li.querySelector("[data-brainstorm-unfold]") == null).map(flat),
            unfold: flat(r.querySelector("[data-brainstorm-unfold]")) || null,
        }));
        const scrolls = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY);
        const scrollers = pane == null ? [] : [pane, ...pane.querySelectorAll("*")].filter((el) => el.tagName !== "TEXTAREA" && scrolls(el));
        const scroller = (el) => { for (let e = el; e != null; e = e.parentElement) if (scrolls(e)) return e; return null; };
        const working = pane?.querySelector("[data-brainstorm-working]");
        const line = working?.querySelector("p");
        const rail = pane?.querySelector("[data-brainstorm-rail]");
        const question = pane?.querySelector("[data-brainstorm-question]");
        return {
            toggle: t == null ? null : {
                text: flat(t),
                pressed: t.getAttribute("aria-pressed"),
                inRow: phase != null && Math.abs((tb.top + tb.bottom) / 2 - (phase.top + phase.bottom) / 2) < 8,
                aboveTrack: track == null || tb.bottom <= track.top,
            },
            question: question != null,
            history: pane?.querySelector("[data-brainstorm-history-main]") != null,
            back: flat(pane?.querySelector("[data-brainstorm-history-back]")) || null,
            heading: flat(list?.parentElement?.querySelector("h2")) || null,
            rows,
            rail: rail == null ? null : { left: Math.round(box(rail).left), top: Math.round(box(rail).top) },
            main: question == null ? null : { right: Math.round(box(question).right), top: Math.round(box(question).top) },
            scrollers: scrollers.length,
            working: working != null,
            historyInWorking: working?.querySelector("[data-brainstorm-history]") != null,
            historyUnderLine: line != null && list != null && box(list).top >= box(line).bottom,
            oneScroll: line != null && list != null && scroller(line) === scroller(list),
        };
    })()`);

const click = (h, sel) => h.ev(`(() => { const el = ${sel}; el?.click(); return el != null; })()`);
const TOGGLE = `${BS_IN_TAB}?.querySelector("[data-brainstorm-decided]")`;
const BACK = `${BS_IN_TAB}?.querySelector("[data-brainstorm-history-back]")`;
const HISTORY_SHOWN = `${BS_IN_TAB}?.querySelector("[data-brainstorm-history-main]") != null`;
const QUESTION_SHOWN = `${BS_IN_TAB}?.querySelector("[data-brainstorm-question]") != null && ${BS_IN_TAB}?.querySelector("[data-brainstorm-history-main]") == null`;
// a history row's fold link or reasoning toggle, by the row's label
const rowControl = (label, attr) =>
    `[...(${BS_IN_TAB}?.querySelector("[data-brainstorm-history]")?.children ?? [])].find((r) => (r.querySelector(".font-mono")?.innerText ?? "").trim() === ${JSON.stringify(label)})?.querySelector("[${attr}]")`;

// keys reach the surface's bindings only from outside a field
async function pressEscape(h) {
    await h.ev(`(() => { document.activeElement?.blur?.(); document.querySelector("[data-cockpit-surface-wrap]")?.focus(); return true; })()`);
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ESCAPE.key, code: ESCAPE.code, windowsVirtualKeyCode: ESCAPE.keyCode });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ESCAPE.key, code: ESCAPE.code, windowsVirtualKeyCode: ESCAPE.keyCode });
}

async function showFile(h, ctx, file, shown) {
    writeFile(ctx, file);
    const ok = await polishWaitFor(h, shown, BS_POLL_WAIT_MS + WAIT_MS);
    await polishNap(SETTLE_MS);
    return ok;
}

const labels = (r) => r.rows.map((x) => x.label);
const row = (r, label) => r.rows.find((x) => x.label === label) ?? null;

export const workspaceBrainstormHistory = wbsScenario(NAME, async (h, ctx, step) => {
    await step("the 600px Brainstorm tab shows the asking question, and the pane reads itself narrow", () => tabOpens(h, ctx));

    await step("the removed brainstorm file names the tab", async () => {
        rmSync(ctx.file, { force: true });
        const removed = await polishWaitFor(h, `${BS_IN_TAB}?.getAttribute("data-brainstorm-view") === "removed"`, BS_POLL_WAIT_MS);
        const gone = await h.ev(`(${BS_IN_TAB}?.querySelector("[data-brainstorm-gone]")?.innerText ?? "").replace(/\\s+/g, " ").trim()`);
        // the file back, so a later step starts from the question again
        writeFile(ctx, ASKING);
        const back = await polishWaitFor(h, `${BS_IN_TAB}?.querySelector('[data-brainstorm-option="2"]') != null`, BS_POLL_WAIT_MS + WAIT_MS);
        return [
            removed && gone === `It is no longer at ${ctx.file}. The Brainstorm tab disappears once you close it.` && back,
            { removed, gone, file: ctx.file, back },
        ];
    });

    await step("Main board: question 4 with 3 decided draws the header's Decided · 3 toggle at rest, and no rail or second scroller", async () => {
        await polishNap(SETTLE_MS);
        const r = await read(h);
        await h.shot(`cdp-shots/${NAME}-main.png`);
        return [
            r.toggle?.text === "Decided · 3" &&
                r.toggle.pressed === "false" &&
                r.toggle.inRow &&
                r.toggle.aboveTrack &&
                r.question &&
                !r.history &&
                r.rail == null &&
                r.scrollers === 1,
            r,
        ];
    });

    await step("A2 board: the toggle pressed shows the history newest first under Back to question 4; the chip, the toggle and Esc each return", async () => {
        const opened = (await click(h, TOGGLE)) && (await polishWaitFor(h, HISTORY_SHOWN, WAIT_MS));
        await polishNap(SETTLE_MS);
        const r = await read(h);
        await h.shot(`cdp-shots/${NAME}-a2.png`);
        const byChip = (await click(h, BACK)) && (await polishWaitFor(h, QUESTION_SHOWN, WAIT_MS));
        const restAfterChip = (await read(h)).toggle?.pressed;
        const reopened = (await click(h, TOGGLE)) && (await polishWaitFor(h, HISTORY_SHOWN, WAIT_MS));
        const byToggle = (await click(h, TOGGLE)) && (await polishWaitFor(h, QUESTION_SHOWN, WAIT_MS));
        const again = (await click(h, TOGGLE)) && (await polishWaitFor(h, HISTORY_SHOWN, WAIT_MS));
        await pressEscape(h);
        const byEsc = await polishWaitFor(h, QUESTION_SHOWN, WAIT_MS);
        return [
            opened &&
                r.toggle?.pressed === "true" &&
                r.back === "Back to question 4" &&
                !r.question &&
                r.heading?.startsWith("Decided so far · 3") &&
                JSON.stringify(labels(r)) === JSON.stringify(["Q3", "Q2", "Q1", "Recon"]) &&
                byChip &&
                restAfterChip === "false" &&
                reopened &&
                byToggle &&
                again &&
                byEsc,
            { opened, ...r, byChip, restAfterChip, reopened, byToggle, again, byEsc },
        ];
    });

    await step("A3 board: the agent writing draws the working line, then the history under it in one scroll; the toggle reads pressed and clicking it changes nothing", async () => {
        const shown = await showFile(h, ctx, WORKING, `${BS_IN_TAB}?.querySelector("[data-brainstorm-working]") != null`);
        const r = await read(h);
        await h.shot(`cdp-shots/${NAME}-a3.png`);
        await click(h, TOGGLE);
        await polishNap(SETTLE_MS);
        const after = await read(h);
        const asking = await showFile(h, ctx, ASKING, `${BS_IN_TAB}?.querySelector('[data-brainstorm-option="2"]') != null`);
        return [
            shown &&
                r.working &&
                r.historyInWorking &&
                r.historyUnderLine &&
                r.oneScroll &&
                r.scrollers === 1 &&
                r.toggle?.pressed === "true" &&
                // the newest answer is the one the agent is writing from, as the wide rail marks it
                JSON.stringify(labels(r)) === JSON.stringify(["Q3 · just now", "Q2", "Q1", "Recon"]) &&
                after.toggle?.pressed === "true" &&
                after.working &&
                after.historyInWorking &&
                !after.history &&
                asking,
            { shown, ...r, after, asking },
        ];
    });

    await step("question 1 with nothing decided draws no toggle", async () => {
        const shown = await showFile(h, ctx, FIRST, `${BS_IN_TAB}?.querySelector("[data-brainstorm-question]")?.innerText.includes(${JSON.stringify(BS_Q1.text)}) === true`);
        const r = await read(h);
        return [shown && r.toggle == null && r.rail == null, { shown, ...r }];
    });

    await step("LA1/LA2 boards: 8 decided reads Decided · 8; pressed, questions past 3 answers fold behind N other options, which opens in place; Q7's own words show whole", async () => {
        const shown = await showFile(h, ctx, LONG, `${BS_IN_TAB}?.querySelector('[data-brainstorm-option="4"]') != null`);
        const rest = await read(h);
        const opened = (await click(h, TOGGLE)) && (await polishWaitFor(h, HISTORY_SHOWN, WAIT_MS));
        await polishNap(SETTLE_MS);
        const r = await read(h);
        await h.shot(`cdp-shots/${NAME}-la2.png`);
        const unfolded = await click(h, rowControl("Q6", "data-brainstorm-unfold"));
        await polishNap(SETTLE_MS);
        const q6 = row(await read(h), "Q6");
        const reasoned = await click(h, rowControl("Q4", "data-brainstorm-reasoning"));
        await polishNap(SETTLE_MS);
        const q4 = row(await read(h), "Q4");
        const q7 = row(r, "Q7");
        const ok =
            shown &&
            rest.toggle?.text === "Decided · 8" &&
            rest.toggle.pressed === "false" &&
            opened &&
            r.back === "Back to question 9" &&
            JSON.stringify(labels(r)) === JSON.stringify(["Q8", "Q7", "Q6", "Q5", "Q4", "Q3", "Q2", "Q1", "Recon"]) &&
            row(r, "Q6")?.items.length === 1 &&
            row(r, "Q6").items[0].startsWith("The lag in minutes") &&
            row(r, "Q6").unfold === "5 other options" &&
            row(r, "Q5")?.items.length === 1 &&
            row(r, "Q5").unfold === "3 other options" &&
            row(r, "Q4")?.unfold === "4 other options" &&
            row(r, "Q8")?.items.length === 3 &&
            row(r, "Q8").unfold == null &&
            q7?.items.length === 1 &&
            q7.items[0] === `In your words ${Q7_OWN}` &&
            q7.unfold === "4 other options" &&
            unfolded &&
            q6?.items.length === 6 &&
            q6.unfold == null &&
            reasoned &&
            q4?.items.length === 5 &&
            q4.unfold == null;
        await click(h, BACK);
        return [ok, { shown, rest: rest.toggle, opened, back: r.back, rows: r.rows, q6, q4 }];
    });

    await step("at 1600px in the Terminal center the rail is beside the question and no toggle shows; the wide pane closes the tab's open history", async () => {
        const asking = await showFile(h, ctx, ASKING, `${BS_IN_TAB}?.querySelector('[data-brainstorm-option="2"]') != null`);
        const opened = (await click(h, TOGGLE)) && (await polishWaitFor(h, HISTORY_SHOWN, WAIT_MS));
        const terminal = await setView(h, false);
        const center = await showInCenter(h, ctx, true);
        // the question slides in, so its box reaches its place beside the rail only once the entrance ends
        const beside = await polishWaitFor(
            h,
            `(() => {
                const rail = ${BS_IN_CENTER}?.querySelector("[data-brainstorm-rail]")?.getBoundingClientRect();
                const q = ${BS_IN_CENTER}?.querySelector("[data-brainstorm-question]")?.getBoundingClientRect();
                return rail != null && q != null && rail.left >= q.right - 1 && Math.abs(rail.top - q.top) < 60;
            })()`,
            WAIT_MS
        );
        const c = await read(h, BS_IN_CENTER);
        await h.shot(`cdp-shots/${NAME}-wide.png`);
        const historyOpen = await store(h, ctx, `return globalStore.get(S.brainstormAtom(id))?.historyOpen ?? null;`);
        const left = await showInCenter(h, ctx, false);
        const rendered = await setView(h, true);
        const kept = await polishWaitFor(h, `${BS_IN_TAB} != null`, WAIT_MS);
        return [
            asking &&
                opened &&
                terminal &&
                center &&
                c.toggle == null &&
                beside &&
                historyOpen === false &&
                left &&
                rendered &&
                kept,
            { asking, opened, terminal, center, beside, toggle: c.toggle, rail: c.rail, main: c.main, historyOpen, left, rendered, kept },
        ];
    });
});
