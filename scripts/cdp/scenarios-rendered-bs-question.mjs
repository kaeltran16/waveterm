// Scenario rendered-bs-question: the question card at the end of the Rendered transcript through the FirstQuestion,
// Judging, JudgePick, JudgeFailed and Answered boards, and HardCases' ten options; the header row, the body's
// `Question N → <part>` meta line opening the pane at its part; the judged list drawn as the pane draws it (label over
// detail, the rank as a tag, the read with its pros and cons toggle, the dropped behind theirs); a pick sending the
// pane's line, recorded as picked here; and the narrow column stacking the option rows. kit is scenarios-rendered-brainstorm.mjs's RBS_KIT.

const NAME = "rendered-bs-question";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const FAILED_REASON = "Arc restarted before the judge started.";

const part = (id, title, state, body = "") => ({ id, title, state, body });
const parts = (states) =>
    [
        ["what", "What counts"],
        ["who", "Who it protects"],
        ["approach", "Approach"],
        ["queue", "Final queue"],
        ["banner", "Banner"],
    ].map(([id, title], i) => part(id, title, states[i], states[i] === "yours" ? `${title}: settled.` : ""));

const Q1 = {
    n: 1,
    text: "Which runs does this need to protect?",
    part: "what",
    why: "Only runs with a narrowed final-verify have lost scenarios so far, but every run shares the machine's memory.",
    options: [
        { label: "Runs with a Final", detail: "the case that failed in d508bb65" },
        { label: "Every run", detail: "workers and Finals alike" },
    ],
};
const APPROACHES = [
    { name: "One Final at a time", description: "queue final-verifies across runs", facts: [] },
    { name: "Memory gate", description: "hold new scenario runs while the OS reports low memory", facts: [] },
    { name: "Shared node_modules", description: "one install for every verify tree", facts: [] },
    { name: "Lower parallelism", description: "cap the run's width at 3", facts: [] },
    { name: "Sonnet workers", description: "smaller model, smaller sessions", facts: [] },
];
const Q3 = {
    n: 3,
    text: "How should a run keep its memory under the machine's limit?",
    part: "approach",
    approaches: APPROACHES,
};
const DROPPED = [
    { name: "Lower parallelism", reason: "width barely moves wall time, and this would slow every run" },
    { name: "Sonnet workers", reason: "the A/B kept Opus for quality" },
];
const JUDGED_OPTIONS = [
    {
        label: "One Final at a time",
        detail: "three overlapping verifies were the peak; one queue removes it",
        pick: true,
        pros: ["removes the peak that lost scenarios", "needs no memory probe"],
        cons: ["a busy hour waits longer for its Final"],
    },
    {
        label: "Memory gate",
        detail: "hold new scenario runs while the OS reports low memory",
        pros: ["keeps runs parallel"],
        cons: ["low memory reads late on Windows"],
    },
    {
        label: "Shared node_modules",
        detail: "one install for every verify tree",
        pros: ["one npm install instead of one per tree"],
        cons: ["leaves the verify's own memory as it is"],
    },
];
const READ = "Queueing Finals removes the peak that lost scenarios; the gate and the shared install each cut less.";
const AGENT_OPTIONS = APPROACHES.map((a, i) => ({ label: a.name, detail: a.description, ...(i === 0 ? { pick: true } : {}) }));
// HardCases: one more option than the keys reach
const TEN_OPTIONS = Array.from({ length: 10 }, (_, i) => ({ label: `Option ${i + 1}`, detail: `detail ${i + 1}` }));
const HISTORY_2 = [
    { kind: "question", n: 1, q: Q1.text, a: "Every run", into: ["what"] },
    { kind: "question", n: 2, q: "Which run does the queue serve first?", a: "The oldest", into: ["who"] },
];
const Q5 = {
    n: 5,
    text: "What should the banner say when a verify has waited 20 minutes?",
    part: "banner",
    why: "It sits with the other attention lines, so a run name and a wait time fit; anything longer wraps.",
};

const file = (over) => ({
    v: 1,
    title: "Run memory pressure",
    spec: "docs/superpowers/specs/2026-11-17-run-memory-pressure-design.md",
    question: null,
    working: null,
    parts: [],
    history: [],
    done: false,
    check: null,
    run: null,
    ...over,
});
const FIRST = file({ question: Q1, parts: parts(["asked", "open", "open", "open", "open"]) });
const AT_Q3 = { parts: parts(["yours", "yours", "asked", "open", "open"]), history: HISTORY_2 };
const JUDGING = file({ ...AT_Q3, question: Q3, working: "The judge is weighing 5 approaches." });
const JUDGE_PICK = file({
    ...AT_Q3,
    question: { ...Q3, options: JUDGED_OPTIONS, read: READ, judge: { added: [], dropped: DROPPED } },
});
const JUDGE_FAILED = file({ ...AT_Q3, question: { ...Q3, options: AGENT_OPTIONS, judge: { failed: FAILED_REASON } } });
const TEN = file({ ...AT_Q3, question: { ...Q3, options: TEN_OPTIONS } });
const ANSWERED = file({
    question: Q5,
    parts: parts(["yours", "yours", "yours", "yours", "asked"]),
    history: [
        ...HISTORY_2,
        { kind: "question", n: 3, q: Q3.text, a: "One Final at a time", into: ["approach"] },
        { kind: "question", n: 4, q: "Should a waiting verify show in the run's graph?", a: "Both", into: ["queue"] },
    ],
});

export default (kit) => {
    const {
        scenario,
        writeFile,
        waitCard,
        narrow,
        widen,
        recordSends,
        waitSent,
        answerRecords,
        polishWaitFor,
        polishNap,
        closePaneTabs,
        HOST,
        PANE,
    } = kit;
    const CARD = `${HOST}?.querySelector("[data-rendered-bs-question]")`;

    // the card as drawn: its header, meta line and text pieces, its read and the toggles beside it and the judge's work,
    // its rows (key, label, detail, badge, rank note, enabled, detail under label, pros and cons), its buttons, the
    // dropped approaches once shown, and whether the action row is stacked
    const readQ = (h) =>
        h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const host = ${HOST};
            const card = ${CARD};
            const q = (sel) => card?.querySelector(sel);
            const rows = [...(card?.querySelectorAll("[data-rendered-bs-option-row]") ?? [])].map((r) => {
                const b = r.querySelector("[data-rendered-bs-option]");
                const l = r.querySelector("[data-rendered-bs-option-label]")?.getBoundingClientRect();
                const d = r.querySelector("[data-rendered-bs-option-detail]")?.getBoundingClientRect();
                return {
                    key: flat(r.querySelector("[data-rendered-bs-key]")),
                    noKey: r.querySelector("[data-rendered-bs-no-key]") != null,
                    label: flat(r.querySelector("[data-rendered-bs-option-label]")),
                    detail: flat(r.querySelector("[data-rendered-bs-option-detail]")),
                    badge: flat(r.querySelector("[data-rendered-bs-pick-badge]")),
                    note: flat(r.querySelector("[data-rendered-bs-option-note]")),
                    enabled: b != null && !b.disabled,
                    stacked: l && d ? d.top >= l.bottom - 1 : null,
                    reasons: [...r.querySelectorAll("[data-rendered-bs-proscons] ul")].map((u) => {
                        const box = u.getBoundingClientRect();
                        return { items: [...u.querySelectorAll("li")].map(flat), left: box.left, right: box.right, top: box.top };
                    }),
                    labelLeft: l?.left ?? null,
                };
            });
            const dropped = [...(card?.querySelectorAll("[data-brainstorm-judge-dropped] li") ?? [])].map(flat);
            const toggle = (sel) => {
                const b = q(sel);
                return b == null ? null : { text: flat(b), open: b.getAttribute("aria-expanded") === "true" };
            };
            const actions = q("[data-rendered-bs-q-actions]");
            const hint = q("[data-rendered-bs-picks-hint]")?.getBoundingClientRect();
            const firstBtn = actions?.querySelector("button")?.getBoundingClientRect();
            return {
                kind: host?.getAttribute("data-rendered-bs-card") ?? null,
                compact: host?.hasAttribute("data-compact") ?? null,
                card: card != null,
                text: flat(card),
                head: flat(q("[data-rendered-bs-head]")),
                pill: host?.querySelector("[data-needs-input]") != null,
                meta: flat(q("[data-rendered-bs-q-meta]")),
                status: flat(q("[data-rendered-bs-status]")),
                started: flat(host?.querySelector("[data-rendered-bs-started]")),
                startedOpen: host?.querySelector("[data-rendered-bs-started] button") != null,
                judgeStatus: flat(q("[data-rendered-bs-judge-status]")),
                waitDrawn: host?.querySelector("[data-rendered-bs-judge-wait]") != null,
                read: flat(q("[data-rendered-bs-read]")),
                reasonsToggle: toggle("[data-brainstorm-proscons-toggle]"),
                work: flat(q("[data-brainstorm-judge-work]")),
                droppedToggle: toggle("[data-brainstorm-judge-dropped-toggle]"),
                hint: flat(q("[data-rendered-bs-picks-hint]")),
                buttons: [...(actions?.querySelectorAll("button") ?? [])].map(flat),
                actionsStacked: hint && firstBtn ? hint.top >= firstBtn.bottom - 1 : null,
                rows,
                dropped,
            };
        })()`);

    const drawn = (h, test) => polishWaitFor(h, `(() => { const card = ${CARD}; return ${test}; })()`, kit.BS_POLL_WAIT_MS);
    // fmtDuration's words: "<1s", "4s", "1m 05s"
    const CLOCK = /^(<1s|\d+s|\d+m \d{2}s)$/;
    const clockOf = (text, lead) => text.replace(lead, "").trim().split(" ")[0];
    // the boards' header row: wide it runs chip, status, Open; compact (Narrow), Open ends the first line and the chip
    // and status take the second. No pill sits above the card
    const asks = (r, topic, status) =>
        !r.pill &&
        r.head ===
            (r.compact
                ? `Brainstorm ${topic} Open brainstorm Needs your input ${status}`
                : `Brainstorm ${topic} Needs your input ${status} Open brainstorm`);
    const hintFor = (n) => `press 1–${n} to pick · or type your own answer below`;

    return [
        scenario(NAME, { noTab: true, file: FIRST }, async (h, ctx, step) => {
            await step("FirstQuestion: the Started a brainstorm row (no Open) over question 1's card: the header, Question 1 → What counts, Guess for me and Skip the questions", async () => {
                await waitCard(h, "question");
                const r = await readQ(h);
                await h.shot(SHOT(1, "first"));
                const ok =
                    r.started.includes("Started a brainstorm") &&
                    r.started.includes(ctx.topic) &&
                    r.started.includes("· 5 decisions to talk through") &&
                    !r.started.includes("Open brainstorm") &&
                    !r.startedOpen &&
                    asks(r, ctx.topic, "Talking it through · 0 of 5 yours") &&
                    r.meta === "Question 1 → What counts" &&
                    r.text.includes(Q1.text) &&
                    r.text.includes(Q1.why) &&
                    JSON.stringify(r.buttons) === JSON.stringify(["Guess for me", "Skip the questions"]) &&
                    r.rows.length === 2 &&
                    r.rows[0].label === "Runs with a Final" &&
                    r.rows[1].detail === "workers and Finals alike" &&
                    r.hint === hintFor(2);
                return [ok, r];
            });

            await step("the meta line's part opens the Brainstorm tab at What counts, its row open", async () => {
                const clicked = await h.ev(`(() => {
                    const b = ${CARD}?.querySelector("[data-rendered-bs-q-meta] [data-rendered-bs-part-link]");
                    if (!b) return false;
                    b.click();
                    return true;
                })()`);
                const sel = `${PANE}?.querySelector('[data-brainstorm-part="what"]')`;
                const opened = await polishWaitFor(
                    h,
                    `${sel}?.querySelector("[data-brainstorm-row-toggle]")?.getAttribute("aria-expanded") === "true"`,
                    kit.WAIT_MS
                );
                await polishNap(300);
                await h.shot(SHOT(2, "part-opens-pane"));
                const back = await closePaneTabs(h, ctx);
                const card = await drawn(h, `card?.querySelector("[data-rendered-bs-q-meta]") != null`);
                return [clicked && opened && back && card, { clicked, opened, back, card }];
            });

            await step("Judging: the 5 approaches answerable, no Guess for me, the judge's status with its clock, and no waiting line under the card", async () => {
                writeFile(ctx, JUDGING);
                await drawn(h, `card?.querySelector("[data-rendered-bs-judge-status]") != null`);
                const r = await readQ(h);
                await h.shot(SHOT(3, "judging"));
                const statusClock = clockOf(r.judgeStatus, "The judge is weighing 5 approaches");
                const ok =
                    r.kind === "question" &&
                    r.started === "" &&
                    asks(r, ctx.topic, "Talking it through · 2 of 5 yours") &&
                    r.meta === "Question 3 → Approach" &&
                    r.rows.length === 5 &&
                    r.rows.every((x) => x.enabled && x.badge === "") &&
                    r.rows.map((x) => x.label).join("|") === APPROACHES.map((a) => a.name).join("|") &&
                    !r.buttons.includes("Guess for me") &&
                    r.buttons.includes("Skip the questions") &&
                    r.judgeStatus.startsWith("The judge is weighing 5 approaches") &&
                    r.judgeStatus.endsWith("its pick shows here; you can pick first") &&
                    CLOCK.test(statusClock) &&
                    !r.waitDrawn &&
                    r.hint === hintFor(5);
                return [ok, { statusClock, ...r }];
            });

            await step("the file rewritten to JudgePick swaps the list in the same card: each label over its own detail, Judge's pick on option 1 and the rank as a tag on the kept, the 2 dropped behind their toggle until it opens", async () => {
                // the card node is marked, so its survival shows the list swapped inside it rather than a new card
                await h.ev(`(() => { const c = ${CARD}; if (c) c.__rbsSame = true; return true; })()`);
                writeFile(ctx, JUDGE_PICK);
                const swapped = await drawn(h, `card?.querySelector('[data-view-swap="judged"]') != null`);
                const same = await h.ev(`${CARD}?.__rbsSame === true`);
                const r = await readQ(h);
                await h.shot(SHOT(4, "judge-pick"));
                const opened = await h.ev(`(() => {
                    const b = ${CARD}?.querySelector("[data-brainstorm-judge-dropped-toggle]");
                    if (!b) return false;
                    b.click();
                    return true;
                })()`);
                const listed = await drawn(
                    h,
                    `card?.querySelectorAll("[data-brainstorm-judge-dropped] li").length === ${DROPPED.length}`
                );
                await polishNap(300);
                const open = await readQ(h);
                await h.shot(SHOT(5, "judge-pick-dropped"));
                const ok =
                    swapped &&
                    same &&
                    asks(r, ctx.topic, "Talking it through · 2 of 5 yours") &&
                    r.meta === "Question 3 → Approach" &&
                    r.judgeStatus === "" &&
                    !r.waitDrawn &&
                    r.rows.length === 3 &&
                    r.rows.every((x, i) => x.stacked === true && x.detail === JUDGED_OPTIONS[i].detail) &&
                    r.rows[0].badge === "Judge’s pick" &&
                    r.rows[0].note === "" &&
                    r.rows[1].badge === "" &&
                    r.rows[1].note === "kept as the second option" &&
                    r.rows[2].note === "kept as the third option" &&
                    r.work === "Judge’s work: weighed the 5 approaches the agent listed, added none, dropped 2." &&
                    r.droppedToggle?.text === "Show the 2 dropped" &&
                    !r.droppedToggle.open &&
                    r.dropped.length === 0 &&
                    opened &&
                    listed &&
                    open.droppedToggle?.text === "Hide the 2 dropped" &&
                    open.droppedToggle.open &&
                    JSON.stringify(open.dropped) ===
                        JSON.stringify(DROPPED.map((d) => `${d.name} Dropped: ${d.reason}`)) &&
                    r.buttons.includes("Guess for me") &&
                    r.hint === hintFor(3);
                return [ok, { swapped, same, opened, listed, ...r, openDropped: open.dropped }];
            });

            await step("the Judge's read over the options with Show pros and cons on its right; the pros and cons start hidden and, shown, sit under each row in two columns indented to its label", async () => {
                const r = await readQ(h);
                const clicked = await h.ev(`(() => {
                    const b = ${CARD}?.querySelector("[data-brainstorm-proscons-toggle]");
                    if (!b) return false;
                    b.click();
                    return true;
                })()`);
                const shown = await drawn(
                    h,
                    `card?.querySelectorAll("[data-rendered-bs-proscons]").length === ${JUDGED_OPTIONS.length}`
                );
                await polishNap(400);
                const s = await readQ(h);
                await h.shot(SHOT(6, "pros-cons"));
                const reasonsOk = s.rows.every((x, i) => {
                    const [pros, cons] = x.reasons;
                    return (
                        JSON.stringify(pros?.items) === JSON.stringify(JUDGED_OPTIONS[i].pros.map((t) => `+ ${t}`)) &&
                        JSON.stringify(cons?.items) === JSON.stringify(JUDGED_OPTIONS[i].cons.map((t) => `− ${t}`)) &&
                        Math.abs(pros.left - x.labelLeft) <= 1 &&
                        cons.left >= pros.right - 1 &&
                        Math.abs(cons.top - pros.top) <= 1
                    );
                });
                const ok =
                    r.read === `Judge’s read: ${READ}` &&
                    r.reasonsToggle?.text === "Show pros and cons" &&
                    !r.reasonsToggle.open &&
                    r.rows.every((x) => x.reasons.length === 0) &&
                    clicked &&
                    shown &&
                    s.reasonsToggle?.text === "Hide pros and cons" &&
                    s.reasonsToggle.open &&
                    reasonsOk;
                return [ok, { clicked, shown, reasonsOk, read: r.read, toggle: s.reasonsToggle, rows: s.rows }];
            });

            await step("JudgeFailed: Agent's pick on option 1 and the judge failed, so the read and pick are the agent's: <reason>", async () => {
                writeFile(ctx, JUDGE_FAILED);
                await drawn(h, `card?.querySelector('[data-view-swap="failed"]') != null`);
                const r = await readQ(h);
                await h.shot(SHOT(7, "judge-failed"));
                const ok =
                    asks(r, ctx.topic, "Talking it through · 2 of 5 yours") &&
                    r.meta === "Question 3 → Approach" &&
                    r.rows.length === 5 &&
                    r.rows[0].badge === "Agent’s pick" &&
                    r.rows.slice(1).every((x) => x.badge === "") &&
                    r.rows[1].detail === APPROACHES[1].description &&
                    r.read === "" &&
                    r.reasonsToggle == null &&
                    r.work === `Judge’s work: the judge failed, so the read and pick are the agent’s: ${FAILED_REASON}` &&
                    r.droppedToggle == null &&
                    r.hint === hintFor(5);
                return [ok, r];
            });

            await step("Answered's question 5: the open question, no options, and the hint says answer in the box below", async () => {
                writeFile(ctx, ANSWERED);
                await drawn(h, `(card?.innerText ?? "").includes(${JSON.stringify(Q5.text)})`);
                const r = await readQ(h);
                await h.shot(SHOT(8, "answered-q5"));
                const ok =
                    r.kind === "question" &&
                    asks(r, ctx.topic, "Talking it through · 4 of 5 yours") &&
                    r.meta === "Question 5 → Banner" &&
                    r.text.includes(Q5.why) &&
                    r.rows.length === 0 &&
                    r.hint === "answer in the box below";
                return [ok, r];
            });

            await step("HardCases' ten options: keys 1-9 on the first nine rows, a blank on the tenth, and the hint names keys 1-9", async () => {
                writeFile(ctx, TEN);
                await drawn(h, `card?.querySelectorAll("[data-rendered-bs-option-row]").length === ${TEN_OPTIONS.length}`);
                const r = await readQ(h);
                await h.shot(SHOT(9, "ten-options"));
                const ok =
                    r.rows.length === 10 &&
                    r.rows.slice(0, 9).every((x, i) => x.key === String(i + 1) && !x.noKey) &&
                    r.rows[9].key === "" &&
                    r.rows[9].noKey &&
                    r.rows[9].label === "Option 10" &&
                    r.hint === hintFor(9);
                return [ok, r];
            });

            await step("the narrow column renders the card compact: the header wraps under Open, the option rows and the action row stacked", async () => {
                writeFile(ctx, JUDGE_PICK);
                await drawn(h, `card?.querySelector('[data-view-swap="judged"]') != null`);
                const narrowed = await narrow(h);
                const r = await readQ(h);
                await h.shot(SHOT(10, "narrow"));
                const widened = await widen(h);
                const ok =
                    narrowed &&
                    r.compact === true &&
                    asks(r, ctx.topic, "Talking it through · 2 of 5 yours") &&
                    r.meta === "Question 3 → Approach" &&
                    r.rows.length === 3 &&
                    r.rows.every((x) => x.stacked === true) &&
                    r.actionsStacked === true &&
                    r.hint === hintFor(3) &&
                    widened;
                return [ok, { narrowed, widened, ...r }];
            });

            await step("a pick sends its line: option 2 sends what the pane sends for it, recorded as picked here", async () => {
                await recordSends(h);
                const clicked = await h.ev(`(() => {
                    const b = ${CARD}?.querySelector('[data-rendered-bs-option="1"]');
                    if (!b || b.disabled) return false;
                    b.click();
                    return true;
                })()`);
                const line = await waitSent(h, 0);
                const records = await answerRecords(h, ctx);
                const last = records[records.length - 1] ?? null;
                const ok =
                    clicked &&
                    line === "Memory gate" &&
                    last?.origin === "transcript" &&
                    last?.question === 3 &&
                    last?.line === "Memory gate";
                return [ok, { clicked, line, last }];
            });
        }),
    ];
};
