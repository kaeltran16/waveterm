// Scenario rendered-bs-rows: the Rendered transcript's own brainstorm rows. Answers Arc sent fold to their question and
// pick with where they were picked (the answer records seeded in the page, as sendBrainstorm writes them), an answer
// only the file's history knows reads "You answered question N", a canvas mark line is a bubble with its crop, and
// the pane-action lines read "You ...", and the pinned bar draws the last prompt, a mark, as its row reads. kit is
// scenarios-rendered-brainstorm.mjs's RBS_KIT.

import { crc32, deflateSync } from "node:zlib";
import { assistantText, userText } from "./agent-page-fixtures.mjs";
import { bsFile } from "./scenarios-shared.mjs";

const TOPIC = `rbs-rows-${Date.now().toString(36)}`;
const S = 1000;
const M = 60 * S;
const T0 = Date.now() - 30 * M;
const at = (ms) => ({ ts: new Date(T0 + ms).toISOString() });

const Q1 = { q: "Which runs does this need to protect?", options: ["Runs with a Final", "Every run"], picked: 0 };
const Q2 = { q: "What tells Arc memory is running low?", options: ["Free memory under a line", "The OS low-memory signal"], picked: 1 };
const Q3 = { q: "How many Finals may run at once?", options: ["Two at a time", "One Final at a time"], picked: 1 };
const Q4 = {
    q: "Should a verify waiting for its turn show in the run's graph?",
    why: "With one Final at a time, a second run's verify can sit for minutes.",
    options: ["A queued chip on the Final node", "Only the attention banner, after 20 minutes", "Both"],
    picked: 2,
};
const BUILDER_Q = "Does time spent queued count toward the run's wall time in Usage?";
const BUILDER_LINE = "brainstorm: builder answer: Yes";
const RUN_ID = "3f9a1c2e-6b0d-4c55-9e1a-2b7f0d9c4a11";
const NOTE = "The chip crowds the Final label; put it under the title";
const MARK_LINE = `look at .superpowers/design/${TOPIC}/feedback/003.png — mark on Main.dc.html: ${NOTE}`;

const answerOf = (q) => q.options[q.picked];
const entry = (n, q) => ({
    kind: "question",
    n,
    q: q.q,
    ...(q.why ? { why: q.why } : {}),
    a: answerOf(q),
    into: [],
    options: q.options.map((label) => ({ label, detail: "" })),
    picked: q.picked,
});

const FILE = bsFile({
    title: "Run memory pressure",
    canvas: TOPIC,
    done: true,
    history: [entry(1, Q1), entry(2, Q2), entry(3, Q3), entry(4, Q4)],
    check: {
        yours: [{ q: BUILDER_Q, a: "Yes", options: [{ label: "Yes", detail: "" }, { label: "No", detail: "" }] }],
        calls: [{ text: "Queued time shows in Usage as its own line." }],
        answered: ["Which store? The run store, from the recon."],
    },
});

// when each prompt lands; a record is written a second before its prompt, as a send does
const TS = { q1: 1 * M, q2: 3 * M, q3: 5 * M, q4: 7 * M, skip: 8 * M, check: 9 * M, builder: 11 * M, keep: 13 * M, mark: 15 * M, approved: 17 * M, run: 18 * M };

const TRANSCRIPT = [
    userText("Let's think the memory pressure through before building.", at(0)),
    assistantText("Question 1 is in the card.", at(10 * S)),
    userText(answerOf(Q1), at(TS.q1)),
    assistantText("Written into Intent. Question 2 next.", at(TS.q1 + 20 * S)),
    userText(answerOf(Q2), at(TS.q2)),
    assistantText("Written into Signal. Question 3 next.", at(TS.q2 + 20 * S)),
    userText(answerOf(Q3), at(TS.q3)),
    assistantText("Written into Approach. Question 4 next.", at(TS.q3 + 20 * S)),
    userText(answerOf(Q4), at(TS.q4)),
    assistantText("Written into Queue.", at(TS.q4 + 20 * S)),
    userText("brainstorm: skip questions", at(TS.skip)),
    assistantText("The rest are guesses for you to confirm.", at(TS.skip + 20 * S)),
    userText("brainstorm: check", at(TS.check)),
    assistantText("A builder read the design; one question is yours.", at(TS.check + 90 * S)),
    userText(BUILDER_LINE, at(TS.builder)),
    assistantText("Settled into Usage.", at(TS.builder + 20 * S)),
    userText("brainstorm: keep talking", at(TS.keep)),
    assistantText("Say what to change.", at(TS.keep + 10 * S)),
    userText(MARK_LINE, at(TS.mark)),
    assistantText("Moved the chip under the title on Main.", at(TS.mark + 30 * S)),
    userText("brainstorm: approved", at(TS.approved)),
    userText(`brainstorm: run ${RUN_ID}`, at(TS.run)),
    assistantText("The run is building.", at(TS.run + 10 * S)),
];

const RECORDS = [
    { line: answerOf(Q1), question: 1, builder: null, answer: answerOf(Q1), origin: "transcript", at: T0 + TS.q1 - S },
    { line: answerOf(Q2), question: 2, builder: null, answer: answerOf(Q2), origin: "transcript", at: T0 + TS.q2 - S },
    { line: answerOf(Q4), question: 4, builder: null, answer: answerOf(Q4), origin: "pane", at: T0 + TS.q4 - S },
    { line: BUILDER_LINE, question: null, builder: BUILDER_Q, answer: "Yes", origin: "transcript", at: T0 + TS.builder - S },
];

// a solid 300x76 PNG, the marked crop the canvas pane would have written
function cropPng(w = 300, h = 76) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([0x13, 0x17, 0x1d]))]);
    const raw = Buffer.concat(Array.from({ length: h }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const SHOT = (n, what) => `cdp-shots/rendered-bs-rows-${n}-${what}.png`;

export default (kit) => {
    const { scenario, agentPage, polishWaitFor, polishNap, narrow, widen, closePaneTabs, RV, PANE, WAIT_MS } = kit;
    const FEED = `${RV}?.querySelector("[data-rendered-feed]")`;

    // every brainstorm row the feed draws, in order: its kind, flat text, origin, and the answer's font size
    const readRows = (h) =>
        h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const feed = ${FEED};
            const els = [...(feed?.querySelectorAll("[data-rbs-row], [data-pane-action], [data-check-fold]") ?? [])];
            return els.map((el) => ({
                kind: el.getAttribute("data-rbs-row") ?? (el.hasAttribute("data-check-fold") ? "check-fold" : "pane:" + el.getAttribute("data-pane-action")),
                text: flat(el),
                origin: el.getAttribute("data-origin"),
                compact: el.closest("[data-rbs-compact]") != null,
                size: getComputedStyle(el.querySelector("[data-rbs-answer]") ?? el).fontSize,
                kindMono: el.querySelector("[data-rbs-answer-kind]")?.classList.contains("font-mono") ?? null,
            }));
        })()`);

    const byText = (rows, kind, words) => rows.find((r) => r.kind === kind && words.every((w) => r.text.includes(w)));

    const seedRecords = (h, ctx) =>
        agentPage(
            h,
            `const S = await mod("app/view/agents/brainstormstore.ts");
            const s = S.getBrainstorm(${JSON.stringify(ctx.agentId)});
            if (s == null) return false;
            const all = globalStore.get(S.brainstormAnswersAtom);
            globalStore.set(S.brainstormAnswersAtom, { ...all, [s.path]: ${JSON.stringify(RECORDS)} });
            return true;`
        );

    // the canvas and the crop exist before the feed draws, as they do before any mark is sent
    const files = { [`.superpowers/design/${TOPIC}/feedback/003.png`]: cropPng() };

    return [
        scenario("rendered-bs-rows", { topic: TOPIC, file: FILE, transcript: TRANSCRIPT, boards: ["Main.dc.html"], files }, async (h, ctx, step) => {
            const seeded = await seedRecords(h, ctx);
            await polishWaitFor(h, `(${FEED}?.querySelectorAll("[data-rbs-row='answer']").length ?? 0) >= 4`, WAIT_MS);

            await step("Main: Question 1 and Question 2 fold to their picks, picked here, the label not mono; Question 3, with no record, reads You answered question 3", async () => {
                const rows = await readRows(h);
                const q1 = byText(rows, "answer", ["Question 1", Q1.q, "Runs with a Final", "picked here"]);
                const q2 = byText(rows, "answer", ["Question 2", Q2.q, "The OS low-memory signal", "picked here"]);
                const q3 = byText(rows, "answered", ["You answered question 3:", "One Final at a time"]);
                await h.shot(SHOT(1, "answers"));
                return [
                    seeded && !!q1 && !!q2 && !!q3 && q1.origin === "transcript" && q1.kindMono === false && q2.kindMono === false,
                    { q1, q2, q3 },
                ];
            });

            await step("Answered: Question 4, answered from the pane, reads picked in the brainstorm pane", async () => {
                const q4 = byText(await readRows(h), "answer", ["Question 4", "Both", "picked in the brainstorm pane"]);
                return [q4?.origin === "pane" && q4.kindMono === false, q4];
            });

            await step("a folded row opens, read-only, to its question, why and options with the pick marked", async () => {
                const opened = await h.ev(`(() => {
                    const row = [...(${FEED}?.querySelectorAll("[data-rbs-row='answer']") ?? [])].find((r) => r.innerText.includes("Question 4"));
                    const b = row?.querySelector("button[aria-expanded]");
                    if (!b) return false;
                    b.click();
                    return true;
                })()`);
                await polishWaitFor(h, `!!${FEED}?.querySelector("[data-rbs-answer-body]")`, WAIT_MS);
                await polishNap(400);
                const body = await h.ev(`(() => {
                    const row = [...(${FEED}?.querySelectorAll("[data-rbs-row='answer']") ?? [])].find((r) => r.innerText.includes("Question 4"));
                    const b = row?.querySelector("[data-rbs-answer-body]");
                    return {
                        expanded: row?.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded"),
                        text: (b?.innerText ?? "").replace(/\\s+/g, " ").trim(),
                        options: [...(b?.querySelectorAll("[data-rbs-option]") ?? [])].map((o) => ({ text: o.innerText.trim(), picked: o.hasAttribute("data-picked") })),
                        buttons: b?.querySelectorAll("button").length ?? 0,
                    };
                })()`);
                await h.ev(`(() => { [...(${FEED}?.querySelectorAll("[data-rbs-row='answer']") ?? [])].find((r) => r.innerText.includes("Question 4"))?.scrollIntoView({ block: "center" }); return true; })()`);
                await polishNap(300);
                await h.shot(SHOT(2, "expanded"));
                const picked = body.options.filter((o) => o.picked).map((o) => o.text);
                return [
                    opened &&
                        body.expanded === "true" &&
                        body.text.includes(Q4.why) &&
                        body.options.length === 3 &&
                        JSON.stringify(picked) === JSON.stringify(["Both"]) &&
                        body.buttons === 0,
                    body,
                ];
            });

            await step("CheckReview: the builder answer folds to Builder question <question> Yes picked here", async () => {
                const b = byText(await readRows(h), "answer", ["Builder question", BUILDER_Q, "Yes", "picked here"]);
                return [b?.origin === "transcript" && b.kindMono === false, b];
            });

            await step("CanvasUpdated: the mark is a bubble with its crop, the note and marked on Main · the canvas; the crop opens Main in the pane", async () => {
                await polishWaitFor(h, `(${FEED}?.querySelector("[data-rbs-row='mark'] img")?.naturalWidth ?? 0) > 0`, WAIT_MS);
                const bubble = await h.ev(`(() => {
                    const el = ${FEED}?.querySelector("[data-rbs-row='mark']");
                    const img = el?.querySelector("img");
                    return {
                        text: (el?.innerText ?? "").replace(/\\s+/g, " ").trim(),
                        crop: img ? img.naturalWidth + "x" + img.naturalHeight : null,
                        right: el ? getComputedStyle(el).alignItems : null,
                    };
                })()`);
                await h.shot(SHOT(3, "mark"));
                await h.ev(`(() => { ${FEED}?.querySelector("[data-rbs-row='mark'] [data-rbs-crop]")?.click(); return true; })()`);
                const board = await polishWaitFor(h, `${PANE}?.getAttribute("data-brainstorm-view") === "board"`, WAIT_MS);
                await h.shot(SHOT(4, "mark-opened"));
                const back = await closePaneTabs(h, ctx);
                return [
                    bubble.text.includes(NOTE) &&
                        bubble.text.includes(`marked on Main · ${TOPIC}`) &&
                        bubble.crop === "300x76" &&
                        bubble.right === "flex-end" &&
                        board &&
                        back,
                    { ...bubble, board, back },
                ];
            });

            await step("the pinned bar: scrolled past the mark, the bar draws it as the mark row does (its crop, the note, marked on Main · the canvas), not the raw look at line; a click brings the mark back", async () => {
                // room under the transcript, so the mark can scroll wholly above the top whatever the window's height
                const SCROLL = `${RV}?.querySelector("[data-rendered-scroll]")`;
                const MARK_ROW = `${FEED}?.querySelector("[data-rbs-row='mark']")?.closest("[data-entry-row]")`;
                const PINNED = `${RV}?.querySelector("[data-pinned-prompt]")`;
                await h.ev(`(() => {
                    const s = ${SCROLL};
                    const col = s?.querySelector("[data-rendered-column]");
                    const row = ${MARK_ROW};
                    if (!s || !col || !row) return false;
                    col.style.paddingBottom = "2000px";
                    s.scrollTop += row.getBoundingClientRect().bottom - s.getBoundingClientRect().top + 8;
                    s.dispatchEvent(new Event("scroll"));
                    return true;
                })()`);
                const shown = await polishWaitFor(h, `!!${PINNED}?.querySelector("[data-pinned-row='mark'] img")`, WAIT_MS);
                await polishNap(300);
                const bar = await h.ev(`(() => {
                    const bar = ${PINNED};
                    return {
                        text: (bar?.innerText ?? "").replace(/\\s+/g, " ").trim(),
                        row: bar?.querySelector("[data-pinned-row]")?.getAttribute("data-pinned-row") ?? null,
                        img: !!bar?.querySelector("img"),
                    };
                })()`);
                await h.shot(SHOT(7, "pinned-mark"));
                await h.ev(`(${PINNED}?.click(), true)`);
                const back = await polishWaitFor(
                    h,
                    `(() => { const r = ${MARK_ROW}?.getBoundingClientRect(); const s = ${SCROLL}?.getBoundingClientRect(); return !!r && !!s && r.bottom > s.top && r.top < s.bottom; })()`,
                    WAIT_MS
                );
                await h.ev(`(() => { const col = ${SCROLL}?.querySelector("[data-rendered-column]"); if (col) col.style.paddingBottom = ""; return true; })()`);
                return [
                    shown &&
                        bar.row === "mark" &&
                        bar.img &&
                        bar.text.includes(NOTE) &&
                        bar.text.includes(`marked on Main · ${TOPIC}`) &&
                        !bar.text.includes("look at") &&
                        back,
                    { ...bar, shown, back },
                ];
            });

            await step("KeepTalking: the folded check row (A builder read the design · 3 questions settled · Spec) above You chose to keep talking", async () => {
                const rows = await readRows(h);
                const fold = rows.findIndex((r) => r.kind === "check-fold");
                const keep = rows.findIndex((r) => r.kind === "pane:keep-talking");
                const text = rows[fold]?.text ?? "";
                return [
                    fold >= 0 &&
                        keep === fold + 1 &&
                        ["A builder read the design", "3 questions settled", "Spec"].every((w) => text.includes(w)) &&
                        rows[keep].text === "You chose to keep talking",
                    { fold: rows[fold], keep: rows[keep] },
                ];
            });

            await step("the pane-action rows: You skipped the questions, You asked for the builder check, You approved the design, Started run <id> from the spec with Open run", async () => {
                const rows = await readRows(h);
                const t = (kind) => rows.find((r) => r.kind === kind)?.text;
                const got = {
                    skip: t("pane:skip"),
                    check: t("pane:check"),
                    approved: t("pane:approved"),
                    run: t("pane:run"),
                    old: rows.some((r) => r.text.includes("In the brainstorm pane")),
                };
                await h.shot(SHOT(5, "pane-actions"));
                return [
                    got.skip === "You skipped the questions" &&
                        got.check === "You asked for the builder check" &&
                        got.approved === "You approved the design" &&
                        got.run === `Started run ${RUN_ID.slice(0, 8)} from the spec Open run` &&
                        !got.old,
                    got,
                ];
            });

            await step("the narrow column draws the rows at the compact sizes", async () => {
                const wide = await readRows(h);
                const narrowed = await narrow(h);
                await polishWaitFor(h, `!!${FEED}?.querySelector("[data-rbs-compact] [data-rbs-row]")`, WAIT_MS);
                const rows = await readRows(h);
                await h.shot(SHOT(6, "narrow"));
                const widened = await widen(h);
                const q1Wide = byText(wide, "answer", ["Question 1"]);
                const q1 = byText(rows, "answer", ["Question 1"]);
                return [
                    narrowed &&
                        widened &&
                        rows.length === wide.length &&
                        rows.every((r) => r.compact) &&
                        !q1Wide?.compact &&
                        parseFloat(q1?.size ?? "0") < parseFloat(q1Wide?.size ?? "0"),
                    { wide: q1Wide?.size, narrow: q1?.size, compact: rows.map((r) => `${r.kind}:${r.compact}`) },
                ];
            });
        }),
    ];
};
