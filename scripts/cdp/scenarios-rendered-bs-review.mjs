// Scenario rendered-bs-review: the check review card at the end of the Rendered transcript (the CheckReview board):
// its sections and counts, a pick held in the state the pane reads, a changed row opening to its was/now, the settle
// line the last choice sends, and the narrow column stacking Keep the change / Put mine back under the row. kit is
// scenarios-rendered-brainstorm.mjs's RBS_KIT.

const NAME = "rendered-bs-review";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;

const part = (id, title, state, body, over = {}) => ({ id, title, state, body, ...over });
const FILE = {
    v: 1,
    title: "Run memory pressure",
    spec: "docs/superpowers/specs/2026-11-17-run-memory-pressure-design.md",
    question: null,
    working: null,
    parts: [
        part("queue", "Final queue", "guess", "One Final-verify at a time, across every run on the machine. A waiting run shows a banner.", {
            was: "Two Final-verifies at a time. A waiting run shows a banner.",
            why: "builder question 1",
        }),
        part("gate", "Memory gate", "guess", "Hold a new scenario run while the OS reports under 2 GB free.", {
            was: "Hold a new scenario run while the OS reports under 4 GB free.",
            why: "answer 3: the box has 16 GB",
        }),
        part("banner", "Banner", "guess", "Waiting for a verify slot, with how long.", { from: "check" }),
        part("intent", "Intent and why", "yours", "Runs lose scenarios when three Finals overlap and memory runs out."),
        part("scan", "What the scan found", "yours", "Three overlapping verifies were the peak.", { kind: "note" }),
    ],
    history: [{ kind: "question", n: 3, q: "How big is the box?", a: "16 GB", into: ["gate"] }],
    done: false,
    check: {
        yours: [],
        calls: [
            { part: "queue", text: "The queue is per machine, not per project, because the memory is." },
            { part: "gate", text: "The gate reads free memory once a second." },
        ],
        answered: [],
        touched: ["queue", "gate"],
    },
    run: null,
};
const SETTLE = "brainstorm: settle keep queue";

export default (kit) => {
    const { scenario, waitCard, narrow, widen, recordSends, waitSent, agentPage, backToRendered, polishWaitFor, HOST, PANE, WAIT_MS } =
        kit;
    const CARD = `${HOST}?.querySelector("[data-rendered-bs-review]")`;
    const ROW = (id) => `${CARD}?.querySelector('[data-rendered-bs-review-row="${id}"]')`;

    // the card as drawn: its summary, section heads, rows with their buttons, the picks bar
    const readReview = (h) =>
        h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const card = ${CARD};
            const q = (sel) => card?.querySelector(sel);
            const rows = [...(card?.querySelectorAll("[data-rendered-bs-review-row]") ?? [])].map((r) => ({
                id: r.getAttribute("data-rendered-bs-review-row"),
                text: flat(r),
                buttons: [...r.querySelectorAll("button")].map((b) => ({ text: flat(b), pressed: b.getAttribute("aria-pressed"), disabled: b.disabled })),
                calls: [...r.querySelectorAll("[data-rendered-bs-review-call]")].map(flat),
            }));
            return {
                card: card != null,
                text: flat(card),
                summary: flat(q("[data-rendered-bs-review-summary]")),
                changed: flat(q('[data-rendered-bs-review-section="changed"] > div')),
                fresh: flat(q('[data-rendered-bs-review-section="fresh"]')),
                unchanged: flat(q('[data-rendered-bs-review-links="unchanged"]')),
                notes: flat(q('[data-rendered-bs-review-links="notes"]')),
                keepAll: flat(q("[data-rendered-bs-keep-all]")),
                picksLine: flat(q("[data-rendered-bs-picks-line]")),
                send: flat(q("[data-rendered-bs-send-picks]")),
                status: flat(q("[data-rendered-bs-status]")),
                rows,
            };
        })()`);

    const click = (h, expr) =>
        h.ev(`(() => { const el = ${expr}; if (!el || el.disabled) return false; el.click(); return true; })()`);
    const keepOnQueue = `[...(${ROW("queue")}?.querySelectorAll("button") ?? [])].find((b) => b.innerText.trim() === "Keep the change")`;

    return [
        scenario(NAME, { file: FILE }, async (h, ctx, step) => {
            await step("CheckReview: the summary, Changed since you confirmed with Keep all, New since the check, the links, and each agent's call under its decision", async () => {
                const shown = await waitCard(h, "review");
                const s = await readReview(h);
                await h.shot(SHOT(1, "review"));
                const queue = s.rows.find((r) => r.id === "queue");
                const banner = s.rows.find((r) => r.id === "banner");
                return [
                    shown &&
                        s.text.includes("Review what the check changed") &&
                        s.summary.startsWith("The check changed 2 decisions you had confirmed, and 1 is new.") &&
                        s.changed.includes("Changed since you confirmed · 2") &&
                        s.changed.includes("open one to see what it was") &&
                        s.keepAll === "Keep all 2 changes" &&
                        s.fresh.includes("New since the check · 1") &&
                        banner?.buttons.map((b) => b.text).join("|") === "That’s right|Edit" &&
                        queue?.buttons.some((b) => b.text === "Keep the change") &&
                        queue?.buttons.some((b) => b.text === "Put mine back") &&
                        queue?.text.includes("builder question 1") &&
                        queue?.calls.join("").includes("per machine") &&
                        s.unchanged === "Yours, unchanged · 1 Intent and why" &&
                        s.notes === "What the agent found · 1 What the scan found" &&
                        s.picksLine === "",
                    s,
                ];
            });

            await step("Keep the change on Final queue shows Keep the change pressed and the picks line reads 1 choice made, 2 still open", async () => {
                await recordSends(h);
                const clicked = await click(h, keepOnQueue);
                const settled = await polishWaitFor(h, `${CARD}?.querySelector("[data-rendered-bs-picks-line]") != null`, WAIT_MS);
                // the count rolls: let it finish before reading the text
                await polishWaitFor(h, `(${CARD}?.querySelector("[data-rendered-bs-picks-line]")?.innerText ?? "").replace(/\\s+/g, " ").trim() === "1 choice made, 2 still open"`, WAIT_MS);
                const s = await readReview(h);
                await h.shot(SHOT(2, "picked"));
                const queue = s.rows.find((r) => r.id === "queue");
                return [
                    clicked &&
                        settled &&
                        s.picksLine === "1 choice made, 2 still open" &&
                        s.send === "Send 1 choice" &&
                        queue?.buttons.find((b) => b.text === "Keep the change")?.pressed === "true",
                    s,
                ];
            });

            await step("the pick shows as picked in the brainstorm pane, and one made there shows here", async () => {
                await agentPage(
                    h,
                    `const S = await mod("app/view/agents/brainstormstore.ts");
                    S.openBrainstormAt(${JSON.stringify(ctx.agentId)}, {});
                    return true;`
                );
                const row = `${PANE}?.querySelector('[data-brainstorm-review-row="queue"]')`;
                const shown = await polishWaitFor(h, `!!${row}`, WAIT_MS);
                const inPane = await h.ev(`(() => {
                    const keep = [...(${row}?.querySelectorAll("button") ?? [])].find((b) => b.innerText.trim() === "Keep the change");
                    const mine = [...(document.querySelectorAll('[data-brainstorm-review-row="gate"] button') ?? [])].find((b) => b.innerText.trim() === "Put mine back");
                    mine?.click();
                    return { pressed: keep?.getAttribute("aria-pressed") ?? null, clickedGate: mine != null };
                })()`);
                await h.shot(SHOT(3, "pane"));
                const back = await backToRendered(h, ctx);
                const hasCard = await waitCard(h, "review");
                const s = await readReview(h);
                const gate = s.rows.find((r) => r.id === "gate");
                return [
                    shown &&
                        inPane.pressed === "true" &&
                        inPane.clickedGate &&
                        back &&
                        hasCard &&
                        gate?.buttons.find((b) => b.text === "Put mine back")?.pressed === "true" &&
                        s.picksLine === "2 choices made, 1 still open",
                    { shown, inPane, back, picksLine: s.picksLine },
                ];
            });

            await step("a changed row opens to its was/now sentence diff", async () => {
                const before = await h.ev(`${ROW("queue")}?.querySelector("[data-rendered-bs-review-diff]") != null`);
                const clicked = await click(h, `${ROW("queue")}?.querySelector("[data-rendered-bs-review-toggle]")`);
                const opened = await polishWaitFor(h, `${ROW("queue")}?.querySelector("[data-rendered-bs-review-diff]") != null`, WAIT_MS);
                const diff = await h.ev(
                    `(${ROW("queue")}?.querySelector("[data-rendered-bs-review-diff]")?.innerText ?? "").replace(/\\s+/g, " ").trim()`
                );
                const expanded = await h.ev(`${ROW("queue")}?.querySelector("[data-rendered-bs-review-toggle]")?.getAttribute("aria-expanded")`);
                await h.shot(SHOT(4, "was-now"));
                return [
                    before === false &&
                        clicked &&
                        opened &&
                        expanded === "true" &&
                        diff.includes("− Two Final-verifies at a time.") &&
                        diff.includes("+ One Final-verify at a time, across every run on the machine."),
                    { before, expanded, diff },
                ];
            });

            await step("the narrow column stacks Keep the change / Put mine back under the row", async () => {
                const wide = await h.ev(`(() => {
                    const r = ${ROW("queue")};
                    const gist = r?.querySelector("[data-rendered-bs-review-gist]")?.getBoundingClientRect();
                    const keep = r?.querySelector("[data-rendered-bs-review-actions] button")?.getBoundingClientRect();
                    return { besideGist: gist && keep ? keep.top < gist.bottom : null };
                })()`);
                const narrowed = await narrow(h);
                const at = await h.ev(`(() => {
                    const r = ${ROW("queue")};
                    const gist = r?.querySelector("[data-rendered-bs-review-gist]")?.getBoundingClientRect();
                    const btns = [...(r?.querySelectorAll("[data-rendered-bs-review-actions] button") ?? [])].map((b) => b.getBoundingClientRect());
                    const host = ${HOST};
                    return {
                        compact: host?.hasAttribute("data-compact") ?? null,
                        under: gist != null && btns.length === 2 && btns.every((b) => b.top >= gist.bottom - 1),
                        sameLine: btns.length === 2 && Math.abs(btns[0].top - btns[1].top) < 6,
                        fits: r != null && host != null && r.getBoundingClientRect().right <= host.getBoundingClientRect().right + 1,
                    };
                })()`);
                await h.shot(SHOT(5, "narrow"));
                const widened = await widen(h);
                return [wide.besideGist === true && narrowed && at.compact && at.under && at.fits && widened, { wide, ...at }];
            });

            await step("Send 1 choice sends the pane's settle line", async () => {
                // the gate pick from the pane step goes first: take it back so one choice is left
                const undone = await click(
                    h,
                    `[...(${ROW("gate")}?.querySelectorAll("button") ?? [])].find((b) => b.innerText.trim() === "Put mine back")`
                );
                await polishWaitFor(h, `(${CARD}?.querySelector("[data-rendered-bs-picks-line]")?.innerText ?? "").includes("1 choice made")`, WAIT_MS);
                const clicked = await click(h, `${CARD}?.querySelector("[data-rendered-bs-send-picks]")`);
                const line = await waitSent(h, 0);
                return [undone && clicked && line === SETTLE, { undone, clicked, line }];
            });
        }),
    ];
};
