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
            const reason = rect("[data-rendered-bs-check-reason]");
            const retry = rect("[data-rendered-bs-check-retry]");
            const rows = [...(host?.querySelectorAll("[data-rendered-bs-option-row]") ?? [])].map((r) => ({
                label: flat(r.querySelector("[data-rendered-bs-option-label]")),
                detail: flat(r.querySelector("[data-rendered-bs-option-detail]")),
                enabled: !r.querySelector("[data-rendered-bs-option]")?.disabled,
            }));
            const fill = q("[data-rendered-bs-check-fill]");
            return {
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
                noteWarns: q("[data-rendered-bs-check-note]")?.className.includes("text-warning") ?? null,
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
                retryStacked: reason && retry ? retry.top >= reason.bottom - 1 : null,
            };
        })()`);

    const base = scenario(NAME, { file: READY }, async (h, ctx, step) => {
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
                r.pending.startsWith("Builder check A builder is reading the design.") &&
                r.times === "usual 5m 02s · longest 6m 10s" &&
                /^2m \d\ds$/.test(r.clock) &&
                r.running === "running" &&
                r.bar &&
                r.usualAt === "81.6%" &&
                r.fillTone === "within" &&
                fill > 30 &&
                fill < 81.6 &&
                r.note === "Checks here usually take about 5m. Edits to the design wait until it is back." &&
                r.noteWarns === false;
            return [ok, r];
        });

        await step("CheckStates past the usual time: the bar full in the warning tone and the note says Taking longer than usual", async () => {
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
                r.failed === "";
            return [ok, r];
        });

        await step("CheckStates taking in: the agent sorting the builder's questions, the clock gone and the note saying the builder finished", async () => {
            await setRecord(h, ctx, { state: "answered", ts: Date.now() });
            await drawn(h, `host?.querySelector('[data-rendered-bs-check-pending="taking-in"]') != null`);
            const r = await readCheck(h);
            await h.shot(SHOT(3, "taking-in"));
            const ok =
                r.stage === "taking-in" &&
                r.pending.startsWith("Builder check Taking in the builder's questions.") &&
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
                r.specPath === SPEC &&
                r.specLink?.disabled === false &&
                r.counts === "1 already in the design 1 the agent decided 1 for you" &&
                r.needsInput &&
                r.askHead === "Builder question · 1 of 1 → Final queue Open brainstorm" &&
                r.qText === OPEN.q &&
                r.qWhy === OPEN.why &&
                r.rows.length === 2 &&
                r.rows.every((x) => x.enabled) &&
                r.rows[0].label === "Yes" &&
                r.rows[1].detail === "a queued line beside wall time" &&
                r.hint === "1–2 picks · or type your own answer below" &&
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

        await step("BuilderCheck approve bar: once the questions are settled, A builder read the design with Keep talking and Approve and start run, both enabled", async () => {
            writeFile(ctx, SETTLED);
            await drawn(h, `host?.querySelector("[data-rendered-bs-approve]") != null`);
            const r = await readCheck(h);
            await h.shot(SHOT(5, "approve"));
            const ok =
                r.kind === "check" &&
                r.summary.startsWith("Builder check 3 questions back") &&
                r.approveText.startsWith(
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
            await h.shot(SHOT(6, "narrow-approve"));
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

        await step("CheckStates failed: The builder check did not finish with its reason, narrow stacks Try again under it, and Try again sends brainstorm: check", async () => {
            // the cleared check and a failed record, as the pane's own failed step has them; the file's rewrite settles the
            // keep talking line the agent was sent
            await setRecord(h, ctx, { state: "failed", ts: Date.now(), reason: FAILED_REASON });
            writeFile(ctx, READY);
            await drawn(h, `host?.querySelector("[data-rendered-bs-check-failed]") != null`);
            const r = await readCheck(h);
            await h.shot(SHOT(7, "failed"));
            const narrowed = await narrow(h);
            const n = await readCheck(h);
            await h.shot(SHOT(8, "narrow-failed"));
            const widened = await widen(h);
            const clicked = await h.ev(`(() => {
                const b = ${HOST}?.querySelector("[data-rendered-bs-check-retry]");
                if (!b || b.disabled) return false;
                b.click();
                return true;
            })()`);
            const line = await waitSent(h, 2);
            const ok =
                r.failed === `The builder check did not finish ${FAILED_REASON} Try again` &&
                r.retry?.disabled === false &&
                r.pending === "" &&
                narrowed &&
                n.retryStacked === true &&
                widened &&
                clicked &&
                line === "brainstorm: check";
            return [ok, { failed: r.failed, retry: r.retry, narrowed, retryStacked: n.retryStacked, widened, clicked, line }];
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
