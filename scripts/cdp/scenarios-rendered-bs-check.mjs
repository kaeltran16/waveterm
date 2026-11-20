// Scenario rendered-bs-check: the builder check card at the end of the Rendered transcript through the BuilderCheck and
// CheckStates boards: the builder reading (its clock, past the usual time), the agent taking in its questions, the
// questions back with the builder's question answered by an option, the approve bar, and a check that did not finish
// with Try again; and the narrow column stacking the approve bar's buttons. kit is scenarios-rendered-brainstorm.mjs's
// RBS_KIT.
//
// The check's record is the tab meta the server writes (agent.builderCheck); the fixture roster has no server behind
// it, so a step patches it in, as the server would. How long checks here usually take is read through an rpc the page
// answers itself, since this machine's history is not the scenario's to rely on.

const NAME = "rendered-bs-check";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const SPEC = "docs/superpowers/specs/2026-11-17-run-memory-pressure-design.md";
// the past checks' times (ms), the BuilderCheck board's: usual 5m 02s, longest 6m 10s
const USUAL_MS = 302_000;
const LONGEST_MS = 370_000;
const READING_AGO_MS = 130_000;
const OVER_AGO_MS = 460_000;
const FAILED_REASON = "The builder session ended before it wrote its questions.";

const part = (id, title) => ({ id, title, state: "yours", body: `${title}: settled.` });
const PARTS = [
    part("what", "What counts"),
    part("who", "Who it protects"),
    part("approach", "Approach"),
    part("queue", "Final queue"),
    part("banner", "Banner"),
];
const OPEN = {
    q: "Does time spent queued count toward the run's wall time in Usage?",
    why: "The builder needs this to know whether Usage reads the queue's events.",
    part: "queue",
    options: [
        { label: "Yes", detail: "wall time is what you waited" },
        { label: "No, show the wait apart", detail: "a queued line beside wall time" },
    ],
};
const file = (over) => ({
    v: 1,
    title: "Run memory pressure",
    spec: SPEC,
    question: null,
    working: null,
    parts: PARTS,
    history: [],
    done: true,
    check: null,
    run: null,
    ...over,
});
const READY = file({});
const BACK = file({ check: { yours: [OPEN], calls: [{ text: "Reuse the median." }], answered: ["The profile."] } });
const SETTLED = file({
    check: { yours: [{ ...OPEN, a: "No, show the wait apart" }], calls: BACK.check.calls, answered: BACK.check.answered },
});
// HardCases: three builder questions for you, the first answered, the second asked, one still to come
const HARD = file({
    check: {
        yours: [
            { q: "Which runs?", part: "what", a: "Every run" },
            { ...OPEN, part: "approach" },
            { q: "Does the banner show on every surface?", part: "banner" },
        ],
        calls: BACK.check.calls,
        answered: BACK.check.answered,
    },
});
const HINT_2 = "press 1–2 to pick · or type your own answer below";

export default (kit) => {
    const { scenario, writeFile, waitCard, narrow, widen, recordSends, waitSent, answerRecords, agentPage, polishWaitFor, HOST } =
        kit;
    const drawn = (h, test) => polishWaitFor(h, `(() => { const host = ${HOST}; return ${test}; })()`, kit.BS_POLL_WAIT_MS);

    // the tab meta's builder check record, as the server writes it
    const setRecord = (h, ctx, record) =>
        agentPage(
            h,
            `window.__cockpitRosterFixture?.patch(${JSON.stringify(ctx.agentId)}, { builderCheck: ${JSON.stringify(record)} });
            return true;`
        );

    // answers the past checks' times in the page; installed before recordSends, so it is the layer recordSends restores
    const fakeTimes = (h) =>
        h.ev(`(() => {
            const c = window.TabRpcClient;
            if (!c) return false;
            if (c.__rbsTimesOrig) return true;
            c.__rbsTimesOrig = c.wshRpcCall;
            const call = c.wshRpcCall.bind(c);
            c.wshRpcCall = (command, data, opts) =>
                command === "brainstormchecktimes"
                    ? Promise.resolve({ usualms: ${USUAL_MS}, longestms: ${LONGEST_MS} })
                    : call(command, data, opts);
            return true;
        })()`);
    const restoreTimes = (h) =>
        h.ev(`(() => {
            const c = window.TabRpcClient;
            if (c?.__rbsTimesOrig) {
                c.wshRpcCall = c.__rbsTimesOrig;
                delete c.__rbsTimesOrig;
            }
            return true;
        })()`);

    // the card as drawn: the clock, the summary, the builder's question, the approve bar and the failure card
    const readCheck = (h) =>
        h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const host = ${HOST};
            const q = (sel) => host?.querySelector(sel);
            const rect = (sel) => q(sel)?.getBoundingClientRect();
            const btn = (sel) => { const b = q(sel); return b ? { disabled: b.disabled, title: b.title } : null; };
            const keep = rect("[data-rendered-bs-keep-talking]");
            const approve = rect("[data-rendered-bs-approve-btn]");
            const rows = [...(host?.querySelectorAll("[data-rendered-bs-option-row]") ?? [])].map((r) => ({
                label: flat(r.querySelector("[data-rendered-bs-option-label]")),
                detail: flat(r.querySelector("[data-rendered-bs-option-detail]")),
                enabled: !r.querySelector("[data-rendered-bs-option]")?.disabled,
            }));
            const fill = q("[data-rendered-bs-check-fill]");
            const head = (sel) => flat(q(sel + " [data-rendered-bs-head]"));
            const body = (sel) => flat(q(sel + " [data-rendered-bs-body]"));
            const note = q("[data-rendered-bs-check-note]");
            // the note's words drawn in the warning tone, itself included
            const warned = note
                ? [note, ...note.querySelectorAll("*")].filter((el) => (el.getAttribute("class") ?? "").includes("text-warning")).map(flat)
                : [];
            // the pending card at full strength: its frame and every ancestor up to the host
            const faded = [];
            for (let el = q("[data-rendered-bs-check-pending] [data-rendered-bs-frame]"); el && el !== host?.parentElement; el = el.parentElement) {
                const o = getComputedStyle(el).opacity;
                if (o !== "1") faded.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), opacity: o });
            }
            const subject = q("[data-rendered-bs-check-pending] [data-rendered-bs-subject]");
            const summaryRect = rect("[data-rendered-bs-check-summary]");
            const approveRect = rect("[data-rendered-bs-approve]");
            const retryInHead = q("[data-rendered-bs-check-failed] [data-rendered-bs-head] [data-rendered-bs-check-retry]") != null;
            return {
                pendingHead: head("[data-rendered-bs-check-pending]"),
                warned,
                faded,
                subjectMuted: subject ? subject.className.includes("text-muted") || !subject.className.includes("text-primary") : null,
                summaryHead: head("[data-rendered-bs-check-summary]"),
                meta: flat(q("[data-rendered-bs-q-meta]")),
                partLink: flat(q("[data-rendered-bs-builder-question] [data-rendered-bs-q-meta] [data-rendered-bs-part-link]")),
                approveHead: head("[data-rendered-bs-approve]"),
                approveBody: body("[data-rendered-bs-approve]"),
                summaryAbove: summaryRect && approveRect ? summaryRect.bottom <= approveRect.top : null,
                failedHead: head("[data-rendered-bs-check-failed]"),
                retryInHead,
                kind: host?.getAttribute("data-rendered-bs-card") ?? null,
                compact: host?.hasAttribute("data-compact") ?? null,
                text: flat(host),
                swap: q("[data-view-swap]")?.getAttribute("data-view-swap") ?? null,
                stage: q("[data-rendered-bs-check-pending]")?.getAttribute("data-rendered-bs-check-pending") ?? null,
                pending: flat(q("[data-rendered-bs-check-pending]")),
                clock: flat(q("[data-rendered-bs-check-clock]")),
                running: q("[data-rendered-bs-check-clock]")?.getAttribute("data-rendered-bs-check-clock") ?? null,
                times: flat(q("[data-rendered-bs-check-times]")),
                note: flat(q("[data-rendered-bs-check-note]")),
                // the past-usual lead, the one part of the note in the warning tone
                noteWarns: q("[data-rendered-bs-check-note-lead]")?.className.includes("text-warning") ?? false,
                bar: q("[data-rendered-bs-check-bar]") != null,
                fillAt: fill?.style.width ?? null,
                fillTone: fill?.getAttribute("data-rendered-bs-check-fill") ?? null,
                usualAt: q("[data-rendered-bs-check-usual]")?.style.left ?? null,
                summary: flat(q("[data-rendered-bs-check-summary]")),
                back: flat(q("[data-rendered-bs-check-back]")),
                specPath: flat(q("[data-rendered-bs-check-spec-path]")),
                specLink: btn("[data-rendered-bs-check-spec]"),
                counts: flat(q("[data-rendered-bs-check-counts]")),
                ask: flat(q("[data-rendered-bs-builder-question]")),
                askHead: flat(q("[data-rendered-bs-builder-question] [data-rendered-bs-head]")),
                qText: flat(q("[data-rendered-bs-q-text]")),
                qWhy: flat(q("[data-rendered-bs-q-why]")),
                hint: flat(q("[data-rendered-bs-picks-hint]")),
                decide: btn("[data-rendered-bs-builder-decide]"),
                needsInput: q("[data-needs-input]") != null,
                openBrainstorm: flat(q("[data-rendered-bs-open]")),
                rows,
                approveText: flat(q("[data-rendered-bs-approve]")),
                reasonText: flat(q("[data-rendered-bs-approve-reason]")),
                keepTalking: btn("[data-rendered-bs-keep-talking]"),
                approveBtn: btn("[data-rendered-bs-approve-btn]"),
                buttonsStacked: keep && approve ? approve.top >= keep.bottom - 1 : null,
                failed: flat(q("[data-rendered-bs-check-failed]")),
                retry: btn("[data-rendered-bs-check-retry]"),
                reason: flat(q("[data-rendered-bs-check-reason]")),
            };
        })()`);

    const base = scenario(NAME, { noTab: true, file: READY }, async (h, ctx, step) => {
        await step("BuilderCheck reading: Builder check, A builder is reading the design., the usual and longest times, the clock running and a bar filling toward the usual mark", async () => {
            await fakeTimes(h);
            await setRecord(h, ctx, { state: "reading", ts: Date.now() - READING_AGO_MS });
            await waitCard(h, "check");
            await drawn(h, `host?.querySelector("[data-rendered-bs-check-times]") != null`);
            const r = await readCheck(h);
            await h.shot(SHOT(1, "reading"));
            const fill = parseFloat(r.fillAt);
            const ok =
                r.kind === "check" &&
                r.stage === "reading" &&
                /^Builder check A builder is reading the design\. usual 5m 02s · longest 6m 10s 2m \d\ds$/.test(r.pendingHead) &&
                r.times === "usual 5m 02s · longest 6m 10s" &&
                /^2m \d\ds$/.test(r.clock) &&
                r.running === "running" &&
                r.bar &&
                r.usualAt === "81.6%" &&
                r.fillTone === "within" &&
                fill > 30 &&
                fill < 81.6 &&
                r.note === "Checks here usually take about 5m. Edits to the design wait until it is back." &&
                r.noteWarns === false &&
                r.warned.length === 0;
            return [ok, r];
        });

        await step("CheckStates past the usual time: the bar full in the warning tone and only the note's lead, Taking longer than usual:, in the warning tone", async () => {
            await setRecord(h, ctx, { state: "reading", ts: Date.now() - OVER_AGO_MS });
            await drawn(h, `host?.querySelector('[data-rendered-bs-check-fill="over"]') != null`);
            const r = await readCheck(h);
            await h.shot(SHOT(2, "past-usual"));
            const ok =
                r.stage === "reading" &&
                /^7m \d\ds$/.test(r.clock) &&
                r.fillAt === "100%" &&
                r.fillTone === "over" &&
                r.note ===
                    "Taking longer than usual: most checks here finish in about 5m. Edits to the design wait until it is back." &&
                r.noteWarns === true &&
                r.warned.length === 1 &&
                r.warned[0] === "Taking longer than usual:" &&
                r.failed === "";
            return [ok, r];
        });

        await step("CheckStates taking in: the agent sorting the builder's questions at full strength, the clock gone and the note saying the builder finished", async () => {
            await setRecord(h, ctx, { state: "answered", ts: Date.now() });
            await drawn(h, `host?.querySelector('[data-rendered-bs-check-pending="taking-in"]') != null`);
            // read once the reading card's swap to this one has settled: a card stuck faded times out here and fails below
            await drawn(h, `host?.querySelector('[data-view-swap="reading"]') == null`);
            await drawn(
                h,
                `(() => {
                    for (let el = host?.querySelector("[data-rendered-bs-check-pending] [data-rendered-bs-frame]"); el && el !== host.parentElement; el = el.parentElement) {
                        if (getComputedStyle(el).opacity !== "1") return false;
                    }
                    return true;
                })()`
            );
            const r = await readCheck(h);
            await h.shot(SHOT(3, "taking-in"));
            const ok =
                r.stage === "taking-in" &&
                r.pendingHead === "Builder check Taking in the builder's questions. usual 5m 02s · longest 6m 10s" &&
                r.faded.length === 0 &&
                r.subjectMuted === false &&
                r.running === null &&
                r.note ===
                    "The builder finished. The agent is sorting its questions into yours, its calls and what the design already answers." &&
                r.noteWarns === false;
            return [ok, r];
        });

        await step("BuilderCheck questions back: the file rewritten swaps the card to 3 questions back, the spec and the 1/1/1 counts, and the builder's question", async () => {
            writeFile(ctx, BACK);
            await drawn(h, `host?.querySelector("[data-rendered-bs-builder-question]") != null`);
            const r = await readCheck(h);
            // the card's own swap trades taking-in for the first builder question; the host's stays on check
            const replaced = await h.ev(
                `${HOST}?.querySelector('[data-view-swap="asking:1"]') != null && ${HOST}?.querySelector('[data-view-swap="taking-in"]') == null`
            );
            await h.shot(SHOT(4, "questions-back"));
            const ok =
                replaced &&
                r.pending === "" &&
                r.back === "3 questions back" &&
                r.summaryHead === "Builder check 3 questions back Spec" &&
                r.specPath === SPEC &&
                r.specLink?.disabled === false &&
                r.counts === "1 already in the design 1 the agent decided 1 for you" &&
                !r.needsInput &&
                r.askHead === "Builder question 1 of 1 Needs your input Open brainstorm" &&
                r.meta === "Builder question 1 → Final queue" &&
                r.partLink === "Final queue" &&
                r.qText === OPEN.q &&
                r.qWhy === OPEN.why &&
                r.rows.length === 2 &&
                r.rows.every((x) => x.enabled) &&
                r.rows[0].label === "Yes" &&
                r.rows[1].detail === "a queued line beside wall time" &&
                r.hint === HINT_2 &&
                r.decide?.disabled === false &&
                r.approveText === "";
            return [ok, { replaced, ...r }];
        });

        await step("the builder question answered by an option sends the pane's builder-answer line, recorded as picked here", async () => {
            await recordSends(h);
            const clicked = await h.ev(`(() => {
                const b = ${HOST}?.querySelector('[data-rendered-bs-option="1"]');
                if (!b || b.disabled) return false;
                b.click();
                return true;
            })()`);
            const line = await waitSent(h, 0);
            const records = await answerRecords(h, ctx);
            const last = records[records.length - 1] ?? null;
            const ok =
                clicked &&
                line === "brainstorm: builder answer: No, show the wait apart" &&
                last?.origin === "transcript" &&
                last?.builder === OPEN.q &&
                last?.line === line;
            return [ok, { clicked, line, last }];
        });

        await step("HardCases: the second of three builder questions reads 2 of 3 in its header and names its own part", async () => {
            writeFile(ctx, HARD);
            await drawn(h, `host?.querySelector('[data-view-swap="asking:2"]') != null`);
            const r = await readCheck(h);
            await h.shot(SHOT(5, "builder-2-of-3"));
            const ok =
                r.askHead === "Builder question 2 of 3 Needs your input Open brainstorm" &&
                r.meta === "Builder question 2 → Approach" &&
                r.qText === OPEN.q &&
                r.hint === HINT_2;
            return [ok, r];
        });

        await step("Main approve card: once the questions are settled, the summary card above a Brainstorm card Ready to approve, A builder read the design with Keep talking and Approve and start run, both enabled", async () => {
            writeFile(ctx, SETTLED);
            await drawn(h, `host?.querySelector("[data-rendered-bs-approve]") != null`);
            const r = await readCheck(h);
            await h.shot(SHOT(6, "approve"));
            const ok =
                r.kind === "check" &&
                r.summaryHead === "Builder check 3 questions back Spec" &&
                r.specPath === SPEC &&
                r.summaryAbove === true &&
                r.approveHead === `Brainstorm ${ctx.topic} Ready to approve Builder check Open brainstorm` &&
                r.approveBody.startsWith(
                    "A builder read the design Its 3 questions are settled. Approving starts an orchestrator run from the spec."
                ) &&
                r.reasonText === "" &&
                r.keepTalking?.disabled === false &&
                r.approveBtn?.disabled === false &&
                r.ask === "";
            return [ok, r];
        });

        await step("the narrow column renders the card compact with the approve bar's buttons stacked", async () => {
            const narrowed = await narrow(h);
            const r = await readCheck(h);
            await h.shot(SHOT(7, "narrow-approve"));
            const widened = await widen(h);
            const ok = narrowed && r.compact === true && r.buttonsStacked === true && widened;
            return [ok, { narrowed, widened, compact: r.compact, buttonsStacked: r.buttonsStacked }];
        });

        await step("Keep talking sends brainstorm: keep talking", async () => {
            const clicked = await h.ev(`(() => {
                const b = ${HOST}?.querySelector("[data-rendered-bs-keep-talking]");
                if (!b || b.disabled) return false;
                b.click();
                return true;
            })()`);
            const line = await waitSent(h, 1);
            return [clicked && line === "brainstorm: keep talking", { clicked, line }];
        });

        await step("CheckStates failed: the header says The builder check did not finish with Try again, the body its reason, narrow keeps Try again in the header, and Try again sends brainstorm: check", async () => {
            // the cleared check and a failed record, as the pane's own failed step has them; the file's rewrite settles the
            // keep talking line the agent was sent
            await setRecord(h, ctx, { state: "failed", ts: Date.now(), reason: FAILED_REASON });
            writeFile(ctx, READY);
            await drawn(h, `host?.querySelector("[data-rendered-bs-check-failed]") != null`);
            const r = await readCheck(h);
            await h.shot(SHOT(8, "failed"));
            const narrowed = await narrow(h);
            const n = await readCheck(h);
            await h.shot(SHOT(9, "narrow-failed"));
            const widened = await widen(h);
            const clicked = await h.ev(`(() => {
                const b = ${HOST}?.querySelector("[data-rendered-bs-check-retry]");
                if (!b || b.disabled) return false;
                b.click();
                return true;
            })()`);
            const line = await waitSent(h, 2);
            const ok =
                r.failedHead === "Builder check The builder check did not finish Try again" &&
                r.reason === FAILED_REASON &&
                r.retryInHead &&
                r.retry?.disabled === false &&
                r.pending === "" &&
                narrowed &&
                n.compact === true &&
                n.retryInHead &&
                widened &&
                clicked &&
                line === "brainstorm: check";
            return [ok, { failedHead: r.failedHead, reason: r.reason, retry: r.retry, narrowed, narrowHead: n.failedHead, widened, clicked, line }];
        });
    });

    // the page-side times answer comes off after the kit's own teardown has restored the layer it wrapped
    return [
        {
            ...base,
            async teardown(h, ctx) {
                await base.teardown(h, ctx);
                try {
                    await restoreTimes(h);
                } catch (e) {
                    console.error(`${NAME} teardown: restoring the check times rpc failed: ${e?.message ?? e}`);
                }
            },
        },
    ];
};
