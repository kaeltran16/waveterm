// The brainstorm's builder check while it asks (the Main board). kit holds scenarios.mjs's brainstorm helpers.
//
// The fixture is detector-engine-models' check with the Main board's copy and labels. The agent's terminal is a
// shell, so each line the pane sends is typed there and read back from its scrollback, as brainstorm-mode does.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOPIC = "detector-engine-models";
const SPEC = "docs/superpowers/specs/2026-10-21-detector-engine-models-design.md";
const BOARD = "Main.dc.html";
// a live spike, under the canvas folder rather than its project/
const SPIKE = "spike/motion.html";
// the shell's prompt ends its last row: pwsh and cmd end in >, bash and zsh in $, # or %
const PROMPT = /[>$#%]$/;
const PROMPT_WAIT_MS = 20000;
const CONFIG_WAIT_MS = 10000;
const CHECK_WAIT_MS = 7000;
const CHECK_LINE = "brainstorm: check";
// the pending card's copy, as brainstormmodel.ts words it
const CHECK_READING = "A builder is reading the design.";
const CHECK_TAKING_IN = "Taking in the builder's questions.";
// ids the builder-check record names; nothing real stands behind them
const CHECK_RUN = "5b0f6a1e-3c2d-4e7f-8a9b-0c1d2e3f4a5b";
const CHECK_CHANNEL = "9e8d7c6b-5a49-4382-b1a0-f9e8d7c6b5a4";

const PART = {
    intent: {
        title: "Intent and why",
        body: "Raise the engine beyond its current basic models so it catches more real attacks.",
    },
    today: { title: "What the engine runs today", body: "Each entity is scored on its own, one day at a time." },
    role: {
        title: "Where the forecast sits",
        body: "The forecaster grades HIGH-tier entities’ fields against a predicted weekday range instead of a flat z-score.",
        // the prototype New run attaches is the first board a part names
        boards: [BOARD],
        spikes: [SPIKE],
    },
    model: {
        title: "The forecast model",
        body: "A small global forecaster per tenant and entity type, trained across all of that type’s entities.",
    },
    purpose: {
        title: "What the forecast adds",
        body: "It damps the z-score’s weekday noise and raises a day that is high for its weekday.",
    },
    evaluation: {
        title: "How we know it is better",
        body: "Live from day one behind a setting; each row it grades stores the forecast’s expected value and range.",
    },
    builder: {
        title: "Left to the builder",
        body: "How the adjustment maps to strength, and the exact bands, kept monotonic.",
    },
};
const ASKING_STATES = {
    intent: "yours",
    today: "yours",
    role: "guess",
    model: "guess",
    purpose: "guess",
    evaluation: "guess",
    builder: "yours",
};

const OPTIONS = [
    {
        label: "Forecast the existing averaged fields",
        detail: "Bytes, bandwidth, pps and blscore keep their z-score; the forecast predicts their weekday shape.",
        pros: ["No new field and no new baseline.", "Keeps the original plan: damp the z-score’s weekday noise."],
        cons: ["On per-event averages the weekly rhythm may be weak, so the gain may be small."],
    },
    {
        label: "Add a per-entity event_count field",
        pick: true,
        detail: "A new numeric field that the forecast grades, beside the untouched z-scored fields.",
        pros: [
            "Counts carry the weekly rhythm the premise assumed.",
            "Enters scoring as an ordinary field row; the scoring engine is unchanged.",
        ],
        cons: ["A new monitored field and baseline to build.", "event_count also feeds ratio metrics, so the two can overlap."],
    },
    {
        label: "Extend volume_anomaly down to entities",
        detail: "Its seasonal median/MAD baseline runs per tenant today; run it per entity instead.",
        pros: ["Reuses a seasonal mechanism the engine already has."],
        cons: [
            "A statistical profile, not the ML model you asked for.",
            "Moves a tenant-level detector to entity grain, a different build again.",
        ],
    },
];
const YOURS = [
    {
        q: "The z-scored fields are per-event averages (bytes, bandwidth, pps, blscore), not counts, and event_count is not z-scored at all. What should the forecast act on?",
        label: "What the forecast acts on: averaged fields, a new event_count, or entity-level volume",
        why: "The whole “Monday peaks are z-score noise” premise assumed daily counts. On averages the weekly rhythm may be weak and the gain small. Each answer is a different build.",
        part: "role",
        options: OPTIONS,
    },
    {
        q: "A day that is normal against the flat mean but high for its weekday is dropped before scoring and never stored. Should the forecast re-grade severity so these days are stored, or stay damping-only?",
        label: "Re-grade severity so a high-for-this-weekday day is stored, or keep the forecast damping-only",
        why: "Keeping the new catch touches the storage gate, so it is no longer “nothing else changes”. Dropping it halves what the forecast adds.",
        part: "purpose",
    },
    {
        q: "When an entity has no aggregate row on a day, does that day count as zero in its weekday profile, or as missing?",
        label: "A day with no aggregate row: zero, or missing",
        why: "Missing means a weekday-only host has no Sunday profile; zero makes sparse fields’ profiles near-zero and much more sensitive.",
        part: "model",
    },
];
const CALLS = [
    ["model", "Zero spread (MAD = 0) leaves the field-day unchanged, matching modified_zscore’s existing guard."],
    ["model", "Reuse volume_anomaly.robust_median_mad for the profile instead of writing a second one."],
    ["model", "Build the profile from per-field (date, value) pairs, because the existing numeric lists are not date-aligned."],
    ["model", "Always store the profile. Baselines from fallback windows, the ES fallback or the tenant path get none and score unchanged."],
    ["purpose", "seasonal_raise takes its Evidence.direction from the seasonal residual, so the classifier doesn’t drop it."],
    ["purpose", "HIGH-tier-only is enforced by the plumbing, and the reshaping is idempotent, because scoring runs twice."],
    ["evaluation", "The audit is field-level (undamped vs stored strength plus the stored score). It does not replay the full pipeline."],
    ["evaluation", "Confidence-band shifts from damping are accepted."],
].map(([part, text]) => ({ text, part }));
const CHECK = {
    yours: YOURS,
    calls: CALLS,
    answered: [],
    touched: ["today", "role", "model", "purpose", "evaluation", "builder"],
};
// a talk question the agent asks during the check: the Check-Review board's question 16, about a part it added
const Q16 = {
    n: 16,
    part: "graph",
    text: "What is the graph model for: catching new access paths, or ranking how rare a relationship is?",
    why: "The builder’s answers left the graph model without a job. Each answer needs different relationship data.",
    options: [
        { label: "Catch new access paths", detail: "Score a link an entity has never used before.", pick: true },
        { label: "Rank how rare a relationship is", detail: "A daily pass that ranks every relationship by rarity." },
        { label: "Leave it out of this run", detail: "Build the forecast first; the graph model gets its own design." },
    ],
};
const GRAPH = { id: "graph", title: "Graph model", state: "asked", body: "" };
const PICKED_LINE = `brainstorm: builder answer: ${OPTIONS[1].label}`;
const TYPED_ANSWER = "Count a missing day as zero.";
const RAIL = `document.querySelector("[data-brainstorm-pane] [data-brainstorm-check-rail]")`;

export default function (kit) {
    const {
        bsArrangeAgent,
        bsShowFile,
        bsTeardownAgent,
        bsWrite,
        bsUntil,
        bsBrief,
        bsClick,
        bsFill,
        bsKey,
        bsMark,
        bsTyped,
        bsNothingTyped,
        bsAgentTook,
        bsPublishStatus,
        bsOpenDesign,
        bsCloseDesign,
        bsTermText,
        polishWaitFor,
        polishNap,
        skipStep,
        BS_PANE,
        BS_ANSWER,
        BS_APPROVE_BAR,
        NEW_RUN,
        PEEKS_ESC,
        flatText,
    } = kit;

    const parts = (states, extra = []) => [
        ...Object.entries(states).map(([id, state]) => ({ id, state, ...PART[id] })),
        ...extra,
    ];
    const file = (over) => ({
        v: 1,
        title: "Improving the detection engine: which models to add",
        spec: SPEC,
        canvas: TOPIC,
        question: null,
        working: null,
        parts: parts(ASKING_STATES),
        history: [],
        done: true,
        check: CHECK,
        run: null,
        ...over,
    });
    const ASKING = file({});
    const WITH_Q16 = file({ question: Q16, parts: parts(ASKING_STATES, [GRAPH]) });
    // every builder question answered, every decision yours, nothing asked: Approve is on
    const ALL_YOURS = parts(Object.fromEntries(Object.keys(PART).map((id) => [id, "yours"])));
    const SETTLED = file({
        parts: ALL_YOURS,
        check: {
            ...CHECK,
            yours: YOURS.map((y, i) => ({ ...y, a: i === 0 ? OPTIONS[1].label : "Settled.", into: [y.part] })),
        },
    });
    // the builder check not run yet: Check with a builder is on offer; RESULT is what a builder's questions leave
    const READY = file({ parts: ALL_YOURS, check: null });
    const RESULT = file({
        parts: ALL_YOURS,
        check: { yours: [YOURS[0]], calls: [CALLS[0]], answered: ["The forecast’s weekday profile."], touched: [] },
    });
    const CHECK_REASON = "The builder session ended before it wrote its questions.";
    // Arc's record of the check, as the server writes it to the agent's tab
    const setCheckRecord = (h, ctx, meta) =>
        h.rpc("setmeta", {
            oref: `tab:${ctx.tabId}`,
            meta: {
                "brainstorm:checkstate": meta.state,
                "brainstorm:checkts": Date.now(),
                "brainstorm:checkrun": CHECK_RUN,
                "brainstorm:checkchannel": CHECK_CHANNEL,
                "brainstorm:checkreason": meta.reason ?? "",
            },
        });
    // the check card, Check with a builder and Try again, as the pane draws them
    const readCheck = (h) =>
        h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const pane = ${BS_PANE};
            const btn = (sel) => {
                const el = pane?.querySelector(sel);
                return el ? { disabled: el.disabled } : null;
            };
            return {
                pending: flat(pane?.querySelector("[data-brainstorm-check-pending]")),
                failed: flat(pane?.querySelector("[data-brainstorm-check-failed]")),
                checkBtn: btn("[data-brainstorm-check-btn]"),
                retry: btn("[data-brainstorm-check-retry]"),
            };
        })()`);
    // a line sent before the shell's prompt is drawn is lost to it
    const waitForPrompt = async (h, ctx) => {
        let prompt = "";
        for (const start = Date.now(); Date.now() - start < PROMPT_WAIT_MS; await polishNap(250)) {
            const rows = (await bsTermText(h, ctx, "\n").catch(() => "")).split("\n").filter((r) => r.trim() !== "");
            prompt = rows.at(-1)?.trim() ?? "";
            if (PROMPT.test(prompt)) break;
        }
        return prompt;
    };
    const designLabel = (f) => {
        const decisions = f.parts.filter((p) => p.kind !== "note");
        return `The design · ${decisions.filter((p) => p.state === "yours").length} of ${decisions.length} yours`;
    };

    // what the check's main area and rail draw, beyond what bsRead reads
    const readAsk = (h) =>
        h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const pane = ${BS_PANE};
            const rail = ${RAIL};
            return {
                head: flat(pane?.querySelector("[data-brainstorm-builder-head]")),
                h1: flat(pane?.querySelector("[data-brainstorm-builder-question] h1")),
                track: [...(pane?.querySelectorAll("[data-brainstorm-builder-question] [data-brainstorm-track] [data-state]") ?? [])].map((x) => x.getAttribute("data-state")),
                proscons: pane?.querySelectorAll("[data-brainstorm-builder-question] [data-brainstorm-proscons]").length ?? 0,
                decide: !!pane?.querySelector("[data-brainstorm-builder-decide]"),
                progress: !!pane?.querySelector("[data-brainstorm-progress]"),
                railHeads: [...(rail?.querySelectorAll("h2, h3") ?? [])].map((x) => flat(x.parentElement)),
                railIntro: flat(rail?.querySelector("p")),
                queue: [...(rail?.querySelectorAll("[data-brainstorm-queue]") ?? [])].map((q) => ({
                    state: q.getAttribute("data-brainstorm-queue"),
                    tinted: q.className.includes("bg-warning/12"),
                    text: flat(q),
                })),
                groups: [...(rail?.querySelectorAll("[data-brainstorm-call-group]") ?? [])].map((g) => ({
                    part: g.getAttribute("data-brainstorm-call-group"),
                    title: flat(g.querySelector("button")),
                    calls: g.querySelectorAll(":scope > span").length,
                })),
                already: flat(rail?.querySelector("[data-brainstorm-already]")),
            };
        })()`);

    return [
        {
            name: "brainstorm-builder-ask",
            surface: "agent",
            async arrange(h) {
                const ctx = await bsArrangeAgent(h, TOPIC, ASKING);
                if (ctx.launchError != null || ctx.cwd == null) return ctx;
                // the New run window approve opens names the agent's project, which the terminal's tab meta sets to
                // the topic; and its prototype is the canvas's first board
                try {
                    const project = join(ctx.cwd, ".superpowers", "design", TOPIC, "project");
                    mkdirSync(project, { recursive: true });
                    writeFileSync(join(project, "canvas.json"), JSON.stringify({ boards: { [BOARD]: { w: 1600 } }, order: [BOARD] }));
                    writeFileSync(join(project, BOARD), `<!doctype html><title>${BOARD}</title><h1>${BOARD}</h1>`);
                    const spike = join(ctx.cwd, ".superpowers", "design", TOPIC, ...SPIKE.split("/"));
                    mkdirSync(join(spike, ".."), { recursive: true });
                    writeFileSync(spike, `<!doctype html><title>${SPIKE}</title><h1>${SPIKE}</h1>`);
                    await h.rpc("createproject", { name: TOPIC, path: ctx.cwd });
                    ctx.project = TOPIC;
                    for (let waited = 0; ; waited += 250) {
                        const cfg = await h.rpc("getfullconfig", null);
                        if (cfg?.projects?.[TOPIC] != null) break;
                        if (waited >= CONFIG_WAIT_MS) throw new Error(`project ${TOPIC} never reached the config`);
                        await polishNap(250);
                    }
                } catch (e) {
                    ctx.launchError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const name = "brainstorm-builder-ask";
                const missing = await bsShowFile(h, ctx);
                if (missing != null) return [skipStep(name, `could not verify: ${missing}`)];
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

                // 1. the builder's first question fills the main area; the check in the rail
                const s1 = await bsUntil(h, ctx, (s) => s.view === "check" && s.builder !== "");
                const a1 = await readAsk(h);
                await h.shot("cdp-shots/brainstorm-builder-ask-1.png");
                const wantGroups = [
                    { part: "model", title: PART.model.title, calls: 4 },
                    { part: "purpose", title: PART.purpose.title, calls: 2 },
                    { part: "evaluation", title: PART.evaluation.title, calls: 2 },
                ];
                const blocker = "Answer the builder’s 3 questions, then review what they change";
                rec(
                    "1. builder question 1 fills the main area (Main): Builder 1 of 3 · for Where the forecast sits, three lettered answers with pros and cons and Agent's pick on B; the rail's For you · 3 (first tinted), The agent decided · 8 under 3 parts, Nothing the builder asked…; no Progress segments; Approve disabled saying why",
                    s1.ok &&
                        a1.head === `Builder 1 of 3 · for ${PART.role.title}` &&
                        a1.h1 === YOURS[0].q &&
                        s1.why === YOURS[0].why &&
                        JSON.stringify(a1.track) === JSON.stringify(["now", "ahead", "ahead"]) &&
                        s1.options.length === 3 &&
                        s1.options.every((o, i) => o.text.startsWith(`${String.fromCharCode(65 + i)} ${OPTIONS[i].label}`)) &&
                        JSON.stringify(s1.options.map((o) => o.pick)) === JSON.stringify([false, true, false]) &&
                        s1.options[1].text.endsWith("Agent’s pick") &&
                        a1.proscons === 3 &&
                        a1.decide &&
                        s1.designBtn === designLabel(ASKING) &&
                        a1.railIntro === "A fresh agent checked whether it could plan from this without coming back to you. It had 11 questions." &&
                        a1.railHeads.includes("For you · 3 only you can answer") &&
                        a1.railHeads.includes("The agent decided · 8 you review them with the changes") &&
                        JSON.stringify(a1.queue.map((q) => [q.state, q.tinted, q.text])) ===
                            JSON.stringify(YOURS.map((y, i) => [i === 0 ? "now" : "waiting", i === 0, y.label])) &&
                        JSON.stringify(a1.groups) === JSON.stringify(wantGroups) &&
                        a1.already === "Nothing the builder asked was already in the design." &&
                        !a1.progress &&
                        s1.approve?.disabled === true &&
                        s1.approveReason === blocker,
                    { ...bsBrief(s1), ask: a1, why: s1.why, options: s1.options, designBtn: s1.designBtn, approve: s1.approve, approveReason: s1.approveReason }
                );

                // 2. each way of answering is one line to the agent
                const prompt = await waitForPrompt(h, ctx);
                const installed = await h.ev(TYPED_INSTALL);
                let mark = await bsMark(h, ctx, PICKED_LINE);
                const picked = await h.ev(`(() => {
                    const b = ${BS_PANE}?.querySelector('[data-brainstorm-builder-question] [data-brainstorm-option="1"]');
                    if (!b) return "missing";
                    b.click();
                    return "clicked";
                })()`);
                const pickTyped = await bsTyped(h, ctx, mark, PICKED_LINE);
                rec("2. clicking answer B sends brainstorm: builder answer: <its label>", PROMPT.test(prompt) && installed === true && picked === "clicked" && pickTyped.ok, {
                    lastRow: prompt,
                    installed,
                    picked,
                    ...pickTyped.detail,
                });
                await bsAgentTook(h, ctx);
                const typedLine = `brainstorm: builder answer: ${TYPED_ANSWER}`;
                mark = await bsMark(h, ctx, typedLine);
                const via = await bsFill(h, BS_ANSWER, TYPED_ANSWER);
                await bsKey(h, BS_ANSWER, "Enter", via);
                const typedSent = await bsTyped(h, ctx, mark, typedLine);
                rec("2b. a typed answer and Enter sends brainstorm: builder answer: <text>", typedSent.ok, { ...typedSent.detail, keys: via });
                await bsAgentTook(h, ctx);
                mark = await bsMark(h, ctx, "brainstorm: builder decide");
                const decided = await bsClick(h, `${BS_PANE}?.querySelector("[data-brainstorm-builder-question]")`, "Let the agent decide");
                const decideTyped = await bsTyped(h, ctx, mark, "brainstorm: builder decide");
                rec("2c. Let the agent decide sends brainstorm: builder decide", decided === "clicked" && decideTyped.ok, { decided, ...decideTyped.detail });
                await bsAgentTook(h, ctx);

                // 3. the design chip opens the review over the question; Back to the question returns to it
                const opened = await bsOpenDesign(h);
                const s3 = await bsUntil(h, ctx, (s) => s.back !== "" && s.builder === "", 3000);
                await h.shot("cdp-shots/brainstorm-builder-ask-3-review.png");
                rec(
                    "3. the design chip opens the review over the builder's question, with Back to the question",
                    opened && s3.ok && s3.back === "Back to the question",
                    { opened, ...bsBrief(s3), back: s3.back, builder: s3.builder.slice(0, 80) }
                );
                // 3a. the check's review keeps a part's mockups: the guess row opens to its board and spike
                const ROLE_ROW = `${BS_PANE}?.querySelector('[data-brainstorm-review-row="role"]')`;
                const toggled = await h.ev(`(() => {
                    const t = ${ROLE_ROW}?.querySelector("[data-brainstorm-review-toggle]");
                    if (!t) return "missing";
                    t.click();
                    return "clicked";
                })()`);
                const thumbShown = await polishWaitFor(
                    h,
                    `!!${ROLE_ROW}?.querySelector('[data-brainstorm-thumb="${BOARD}"] iframe') && !!${ROLE_ROW}?.querySelector("[data-brainstorm-spike]")`,
                    5000
                );
                // the link's title is parked by the tooltip while hovered, and the canvas server sends no CORS headers,
                // so the spike is fetched from here, from the folder the board is served from
                const mockups = await h.ev(`(() => {
                    const row = ${ROLE_ROW};
                    return {
                        src: row?.querySelector('[data-brainstorm-thumb="${BOARD}"] iframe')?.getAttribute("src") ?? "",
                        open: !!row?.querySelector("[data-brainstorm-open-board]"),
                        spikePath: row?.querySelector("[data-brainstorm-spike]")?.getAttribute("data-brainstorm-spike") ?? "",
                    };
                })()`);
                mockups.served = mockups.src.slice(0, mockups.src.lastIndexOf("/project/")) + `/${SPIKE}`;
                const spikePage = mockups.src === "" ? "" : await fetch(mockups.served).then((r) => (r.ok ? r.text() : "")).catch(() => "");
                mockups.spikeServed = spikePage.includes(`<h1>${SPIKE}</h1>`);
                await h.shot("cdp-shots/brainstorm-builder-ask-3a-mockups.png");
                rec(
                    "3a. in the check's review, the row of a part with a board opens to its thumbnail, Open full size, and its spike link under the canvas folder",
                    toggled === "clicked" &&
                        thumbShown &&
                        mockups.src.endsWith(`/${TOPIC}/project/${BOARD}`) &&
                        mockups.open &&
                        mockups.spikePath === SPIKE &&
                        mockups.spikeServed,
                    { toggled, thumbShown, ...mockups }
                );
                await h.ev(`${ROLE_ROW}?.querySelector("[data-brainstorm-review-toggle]")?.click()`);

                const closed = await bsCloseDesign(h);
                const s3b = await bsUntil(h, ctx, (s) => s.builder !== "" && s.back === "", 3000);
                await h.shot("cdp-shots/brainstorm-builder-ask-3-back.png");
                rec("3b. Back to the question returns to builder question 1", closed && s3b.ok && s3b.builder.includes(YOURS[0].q), {
                    closed,
                    ...bsBrief(s3b),
                });

                // 4. a part link in the rail opens the review with that decision as the cursor row
                const linked = await bsClick(h, `${RAIL}?.querySelector('[data-brainstorm-call-group="model"]')`, PART.model.title);
                const cursorRow = await polishWaitFor(
                    h,
                    `${BS_PANE}?.querySelector('[data-brainstorm-review-row="model"]')?.hasAttribute("data-cursor") === true`,
                    3000
                );
                const cursorRows = await h.ev(
                    `[...(${BS_PANE}?.querySelectorAll("[data-brainstorm-review-row][data-cursor]") ?? [])].map((r) => r.getAttribute("data-brainstorm-review-row"))`
                );
                rec("4. the rail's part link The forecast model opens the review with its row as the cursor row", linked === "clicked" && cursorRow && JSON.stringify(cursorRows) === JSON.stringify(["model"]), {
                    linked,
                    cursorRow,
                    cursorRows,
                });
                await bsCloseDesign(h);

                // 5. a talk question written during the check takes the main area
                bsWrite(ctx, WITH_Q16);
                const s5 = await bsUntil(h, ctx, (s) => s.question.includes(Q16.text));
                await h.shot("cdp-shots/brainstorm-builder-ask-5.png");
                rec(
                    "5. question 16, written during the check, takes the main area with its options, ahead of the builder's questions, with no Skip the questions and no skip note",
                    s5.ok &&
                        s5.view === "check" &&
                        s5.builder === "" &&
                        s5.question.startsWith(`16 → ${GRAPH.title}`) &&
                        s5.options.length === 3 &&
                        s5.options[0].pick &&
                        s5.answerBox &&
                        !s5.question.includes("Skip the questions") &&
                        s5.skipNote === "",
                    { ...bsBrief(s5), question: s5.question.slice(0, 160), options: s5.options, skipNote: s5.skipNote }
                );

                // 6. everything settled: Approve is on; Change and Approve open New run, only Approve sends a line
                bsWrite(ctx, SETTLED);
                const s6 = await bsUntil(h, ctx, (s) => s.approve?.disabled === false);
                mark = await bsMark(h, ctx, null);
                const changeClicked = await bsClick(h, BS_APPROVE_BAR, "Change");
                const changeOpen = await polishWaitFor(h, `!!${NEW_RUN}`, 3000);
                const changeQuiet = await bsNothingTyped(h, mark);
                await h.ev(PEEKS_ESC);
                const changeClosed = await polishWaitFor(h, `!${NEW_RUN}`, 3000);
                rec("6. with everything settled Approve is enabled; Change opens New run and sends nothing", s6.ok && s6.approveReason === "" && changeClicked === "clicked" && changeOpen && changeQuiet.ok && changeClosed, {
                    approve: s6.approve,
                    approveReason: s6.approveReason,
                    changeClicked,
                    changeOpen,
                    typed: changeQuiet.sent,
                    changeClosed,
                });
                rec("6a. the check's review, no question open, holds the line box, open", s6.view === "check" && s6.lineBox === "open", {
                    view: s6.view,
                    lineBox: s6.lineBox,
                });
                mark = await bsMark(h, ctx, "brainstorm: approved");
                const approved = await bsClick(h, BS_APPROVE_BAR, "Approve and start run");
                const approveTyped = await bsTyped(h, ctx, mark, "brainstorm: approved");
                const runOpen = await polishWaitFor(h, `!!${NEW_RUN}`, 3000);
                const goal = `Build ${SETTLED.title} as specified in ${join(ctx.cwd, ...SPEC.split("/"))}.`;
                const prototype = join(ctx.cwd, ".superpowers", "design", TOPIC, "project", BOARD);
                await polishWaitFor(h, `${NEW_RUN}?.querySelector('textarea[aria-label="Goal"]')?.value === ${JSON.stringify(goal)}`, 3000);
                const launcher = await h.ev(`({
                    goal: ${NEW_RUN}?.querySelector('textarea[aria-label="Goal"]')?.value ?? null,
                    text: ${flatText(NEW_RUN)},
                })`);
                await h.shot("cdp-shots/brainstorm-builder-ask-6-run.png");
                await h.ev(PEEKS_ESC);
                const runClosed = await polishWaitFor(h, `!${NEW_RUN}`, 3000);
                rec(
                    "6b. Approve sends brainstorm: approved and opens New run with the spec's absolute path and the prototype",
                    approved === "clicked" && approveTyped.ok && runOpen && launcher.goal === goal && launcher.text.includes(`Prototype · ${prototype}`) && runClosed,
                    { approved, ...approveTyped.detail, runOpen, goal: launcher.goal, wantGoal: goal, prototype, text: (launcher.text ?? "").slice(0, 400), runClosed }
                );
                return steps;
            },
            async teardown(h, ctx) {
                const step = async (what, fn) => {
                    try {
                        await fn();
                    } catch (e) {
                        console.error(`brainstorm-builder-ask teardown: ${what} failed: ${e?.message ?? e}`);
                    }
                };
                await step("close the New run window", () => h.ev(`${NEW_RUN} ? (${PEEKS_ESC}, true) : false`));
                await step("stop recording sent lines", () => h.ev(TYPED_REMOVE));
                if (ctx.project) await step("delete the project", () => h.rpc("deleteproject", { name: ctx.project }));
                await bsTeardownAgent(h, ctx, "brainstorm-builder-ask");
            },
        },
        {
            // plays the server (the tab's check record) and the agent (the file, its idle status); no builder launches
            name: "brainstorm-builder-check",
            surface: "agent",
            arrange: (h) => bsArrangeAgent(h, TOPIC, READY),
            async assert(h, ctx) {
                const name = "brainstorm-builder-check";
                const missing = await bsShowFile(h, ctx);
                if (missing != null) return [skipStep(name, `could not verify: ${missing}`)];
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
                const noCheckBtn = (c) => c.checkBtn == null || c.checkBtn.disabled === true;

                // 1. every part yours, no record: Check with a builder is offered
                const s1 = await bsUntil(h, ctx, (s) => s.check != null);
                const c1 = await readCheck(h);
                await h.shot("cdp-shots/brainstorm-builder-check-1.png");
                rec(
                    "1. ready: with every decision yours and no record, Check with a builder is offered, with no check card",
                    s1.ok && c1.checkBtn?.disabled === false && c1.pending === "" && c1.failed === "",
                    { ...bsBrief(s1), ...c1 }
                );

                // 2. reading: the pending card, and no Check button
                await setCheckRecord(h, ctx, { state: "reading" });
                const s2 = await bsUntil(h, ctx, (s) => s.working.includes(CHECK_READING));
                const c2 = await readCheck(h);
                await h.shot("cdp-shots/brainstorm-builder-check-2.png");
                rec(
                    "2. pending: with the record reading, the card reads A builder is reading the design. and Check with a builder is gone",
                    s2.ok && c2.pending.includes(CHECK_READING) && noCheckBtn(c2) && c2.failed === "",
                    { ...bsBrief(s2), ...c2 }
                );

                // 3. answered, the file untouched and the agent idle from before: the questions are still being taken in
                await setCheckRecord(h, ctx, { state: "answered" });
                const s3 = await bsUntil(h, ctx, (s) => s.working.includes(CHECK_TAKING_IN));
                const c3 = await readCheck(h);
                await h.shot("cdp-shots/brainstorm-builder-check-3.png");
                rec(
                    "3. taking in: with the record answered and the file unchanged, the card reads Taking in the builder's questions.",
                    s3.ok && c3.pending.includes(CHECK_TAKING_IN) && noCheckBtn(c3),
                    { ...bsBrief(s3), ...c3 }
                );

                // 4. the agent writes the check after the record and ends its turn: the builder's question, no card
                bsWrite(ctx, RESULT);
                await bsPublishStatus(h, ctx);
                const s4 = await bsUntil(h, ctx, (s) => s.view === "check" && s.builder !== "");
                const c4 = await readCheck(h);
                await h.shot("cdp-shots/brainstorm-builder-check-4.png");
                rec(
                    "4. result: with the check written and the agent idle, the main area holds the builder's question and the pending card is gone",
                    s4.ok && s4.builder.includes(YOURS[0].q) && c4.pending === "" && c4.failed === "",
                    { ...bsBrief(s4), builder: s4.builder.slice(0, 120), ...c4 }
                );

                // 5. the file's check cleared, the record failed: the reason and Try again
                bsWrite(ctx, READY);
                await setCheckRecord(h, ctx, { state: "failed", reason: CHECK_REASON });
                const shown = await polishWaitFor(h, `!!${BS_PANE}?.querySelector("[data-brainstorm-check-failed]")`, CHECK_WAIT_MS);
                const c5 = await readCheck(h);
                await h.shot("cdp-shots/brainstorm-builder-check-5.png");
                rec(
                    "5. failed: with the check cleared and the record failed, the card shows its reason and Try again, and Check with a builder is gone",
                    shown && c5.failed.includes(CHECK_REASON) && c5.retry?.disabled === false && c5.checkBtn == null && c5.pending === "",
                    c5
                );

                // 6. Try again sends the check line; the old record stays until a newer one arrives, so only the line is judged
                await waitForPrompt(h, ctx);
                const installed = await h.ev(TYPED_INSTALL);
                const mark = await bsMark(h, ctx, CHECK_LINE);
                const retried = await h.ev(`(() => {
                    const b = ${BS_PANE}?.querySelector("[data-brainstorm-check-retry]");
                    if (!b) return "missing";
                    b.click();
                    return "clicked";
                })()`);
                const sent = await bsTyped(h, ctx, mark, CHECK_LINE);
                await h.shot("cdp-shots/brainstorm-builder-check-6.png");
                rec("6. Try again sends brainstorm: check", installed === true && retried === "clicked" && sent.ok, { installed, retried, ...sent.detail });
                return steps;
            },
            async teardown(h, ctx) {
                try {
                    await h.ev(TYPED_REMOVE);
                } catch (e) {
                    console.error(`brainstorm-builder-check teardown: stop recording sent lines failed: ${e?.message ?? e}`);
                }
                await bsTeardownAgent(h, ctx, "brainstorm-builder-check");
            },
        },
    ];
}

// records every line the page sends an agent, as scenarios.mjs's BS_TYPED_INSTALL does
const TYPED_INSTALL = `(() => {
    const c = window.TabRpcClient;
    if (!c) return false;
    if (c.__bsOrig) return true;
    c.__bsOrig = c.wshRpcCall;
    const call = c.wshRpcCall.bind(c);
    window.__bsTyped = [];
    c.wshRpcCall = (command, data, opts) => {
        if (command === "agentprompt") window.__bsTyped.push({ block: data?.blockid, text: data?.text });
        return call(command, data, opts);
    };
    return true;
})()`;
const TYPED_REMOVE = `(() => {
    const c = window.TabRpcClient;
    if (c?.__bsOrig) {
        c.wshRpcCall = c.__bsOrig;
        delete c.__bsOrig;
    }
    return true;
})()`;
