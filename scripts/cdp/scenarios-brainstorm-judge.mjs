// A question the judge weighed (.superpowers/design/brainstorm-judge): the read and pick are labelled the judge's, one
// line under the answers says how it got there, and what it dropped sits behind a toggle that starts closed. A failed
// judge keeps the agent's labels and says why; once answered, the rail row keeps the judge's pick. kit holds
// scenarios.mjs's brainstorm helpers.

const TOPIC = "agent-messages-judge";
const NAME = "brainstorm-judged-question";

const OPTIONS = [
    {
        label: "No forwarding from an agent-started turn",
        detail: "The server flags a turn an agent message started, and refuses wsh agents send from it.",
        pick: true,
        pros: [
            "Ends loops of any length (A→B→A, A→B→C→A) with no counters or send graph.",
            "Fits the read-based reply model: a target never needs to send to answer.",
            "Small: agentctl.Send is the one entry point, and the UserPromptSubmit hook already marks new turns.",
        ],
        cons: [
            "An agent that another agent woke can't delegate onward.",
            "The orchestrator's pushes (wake.go overStream) must count as human-started.",
        ],
    },
    {
        label: "Inbox, no wake",
        detail: "Agent messages never start a turn: they join a running one or wait for the target's next human-started turn.",
        pros: ["Strongest guarantee: only humans start turns.", "Reuses Msg.MidTurn and the atPrompt check in wake.go."],
        cons: [
            "A message to an idle agent does nothing until a human prompts it.",
            "Needs a new inbox store; agentctl streams are memory-only, capped at 16.",
        ],
    },
    {
        label: "Hop count carried in the message",
        detail: "Each send from an agent-started turn carries the incoming hop plus one; the server refuses past a named maximum.",
        pros: ["Allows bounded delegation chains (A→B→C).", "Still stops any cycle at the limit."],
        cons: ["No message type has a hop or sender field today, so the types, the server command and the mod all change."],
    },
    {
        label: "Per-pair rate cap",
        detail: "The server counts sends per sender and target over a time window and refuses past a limit.",
        pros: ["Easy on top of the refuse-and-report agentctl.Send already does."],
        cons: ["A slow loop under the cap is never stopped.", "New window and count constants to tune."],
    },
];
const DROPPED = [
    {
        name: "Refuse a send back to a sender whose request is still open",
        reason: "misses longer cycles; A→B→C→A needs the whole send graph, not only the reverse edge.",
    },
    {
        name: "Human approval for chained sends",
        reason: "stalls automation on a human, against your “Orchestrator wall-clock matters” note.",
    },
    { name: "Prompt wording plus docs only", reason: "enforces nothing." },
];
const APPROACHES = [
    ...OPTIONS.map((o) => ({ name: o.label, description: o.detail, facts: [] })),
    ...DROPPED.map((d) => ({ name: d.name, description: "", facts: [] })),
];
const READ =
    "Only the one-hop and inbox rules end every cycle by construction, and only the one-hop rule still wakes an idle agent; it rests on agentctl.Send being the one place an engine prompt enters a session.";
const WEIGHED = { added: [], dropped: DROPPED };
const FAILED_REASON = "Arc restarted before the judge started.";

const Q4 = {
    n: 4,
    part: "guard",
    text: "How should agent-to-agent prompt loops be stopped?",
    why: "Agents answer by being read (wsh agents read), so a target never has to send back to reply. What I can't tell is whether an agent that another agent woke should be able to delegate onward.",
    read: READ,
    options: OPTIONS,
    approaches: APPROACHES,
    judge: WEIGHED,
};

const PARTS = [
    { id: "intent", title: "Intent and why", state: "yours", body: "Agents can message each other without looping." },
    { id: "reply", title: "How a target replies", state: "yours", body: "By being read: wsh agents read." },
    { id: "guard", title: "Loop guard", state: "asked", body: "" },
    { id: "delivery", title: "Delivery", state: "guess", body: "A message joins the target's running turn." },
    { id: "ui", title: "What the cockpit shows", state: "open", body: "" },
];
const HISTORY = [
    { kind: "question", n: 1, q: "What should agent messages let you do?", a: "Hand work between agents.", into: ["intent"] },
    { kind: "question", n: 2, q: "How does a target answer?", a: "By being read.", into: ["reply"] },
    { kind: "question", n: 3, q: "Where does a message land?", a: "In the running turn.", into: ["delivery"] },
];
const ANSWERED = {
    kind: "question",
    n: 4,
    q: Q4.text,
    a: OPTIONS[0].label,
    into: ["guard"],
    options: OPTIONS,
    picked: 0,
    judge: WEIGHED,
};

const file = (over) => ({
    v: 1,
    title: "Agent messages",
    spec: "docs/superpowers/specs/2026-10-23-agent-messages-design.md",
    question: Q4,
    working: null,
    parts: PARTS,
    history: HISTORY,
    done: false,
    check: null,
    run: null,
    ...over,
});
const JUDGED = file({});
const FAILED = file({ question: { ...Q4, judge: { failed: FAILED_REASON } } });
const DONE = file({
    question: null,
    parts: PARTS.map((p) => (p.id === "guard" ? { ...p, state: "yours", body: OPTIONS[0].detail, from: "answer 4" } : p)),
    history: [...HISTORY, ANSWERED],
});

export default function (kit) {
    const { bsBoardScenario, bsWrite, bsUntil, bsBrief, bsClick, BS_PANE } = kit;

    const WORK = `${BS_PANE}?.querySelector("[data-brainstorm-judge-work]")`;
    const readJudge = (h) =>
        h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const pane = ${BS_PANE};
            const question = flat(pane?.querySelector("[data-brainstorm-question]"));
            const toggle = pane?.querySelector("[data-brainstorm-judge-dropped-toggle]");
            const list = pane?.querySelector("[data-brainstorm-judge-dropped]");
            return {
                read: flat(pane?.querySelector("[data-brainstorm-read]")),
                work: flat(${WORK}),
                judgePicks: (question.match(/Judge’s pick/g) ?? []).length,
                agentPicks: (question.match(/Agent’s pick/g) ?? []).length,
                agents: question.includes("Agent’s"),
                toggle: toggle ? { text: flat(toggle), expanded: toggle.getAttribute("aria-expanded") } : null,
                dropped: list
                    ? [...list.querySelectorAll("li")].map((li) => ({ name: flat(li.firstElementChild), reason: flat(li.lastElementChild) }))
                    : null,
            };
        })()`);
    const showWork = (h) => h.ev(`${WORK}?.scrollIntoView({ block: "center" })`);
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    return [
        bsBoardScenario(NAME, TOPIC, JUDGED, async (h, ctx, rec) => {
            const s1 = await bsUntil(h, ctx, (s) => s.question.includes(Q4.text) && s.options.length === OPTIONS.length);
            await showWork(h);
            const m1 = await readJudge(h);
            await h.shot("cdp-shots/brainstorm-judged-question.png");
            rec(
                "1. a weighed question: Judge’s read, one Judge’s pick, no Agent’s, the judge's work line, and the dropped list closed behind Show the 3 dropped",
                s1.ok &&
                    m1.read === `Judge’s read: ${READ}` &&
                    m1.judgePicks === 1 &&
                    !m1.agents &&
                    m1.work === "Judge’s work: weighed the 7 approaches the agent listed, added none, dropped 3." &&
                    m1.dropped === null &&
                    m1.toggle?.text === "Show the 3 dropped" &&
                    m1.toggle.expanded === "false",
                { ...bsBrief(s1), marks: m1 }
            );

            const clicked = await bsClick(h, BS_PANE, "Show the 3 dropped");
            await showWork(h);
            const m2 = await readJudge(h);
            await h.shot("cdp-shots/brainstorm-judged-question-dropped.png");
            rec(
                "2. Show the 3 dropped opens the list: each dropped approach with its Dropped: reason, and the toggle reads Hide the 3 dropped",
                clicked === "clicked" &&
                    eq(m2.dropped, DROPPED.map((d) => ({ name: d.name, reason: `Dropped: ${d.reason}` }))) &&
                    m2.toggle?.text === "Hide the 3 dropped" &&
                    m2.toggle.expanded === "true",
                { clicked, marks: m2 }
            );

            bsWrite(ctx, FAILED);
            const s3 = await bsUntil(h, ctx, (s) => s.question.includes("the judge failed"));
            await showWork(h);
            const m3 = await readJudge(h);
            await h.shot("cdp-shots/brainstorm-judged-question-failed.png");
            rec(
                "3. a failed judge: Agent’s read and Agent’s pick, and the work line says the judge failed and why, with no dropped toggle",
                s3.ok &&
                    m3.read === `Agent’s read: ${READ}` &&
                    m3.agentPicks === 1 &&
                    m3.judgePicks === 0 &&
                    m3.work === `Judge’s work: the judge failed, so the read and pick are the agent’s: ${FAILED_REASON}` &&
                    m3.toggle === null &&
                    m3.dropped === null,
                { ...bsBrief(s3), marks: m3 }
            );

            bsWrite(ctx, DONE);
            const s4 = await bsUntil(h, ctx, (s) => s.history.some((r) => r.label.startsWith("Q4")));
            const row = s4.history.find((r) => r.label.startsWith("Q4"));
            await h.ev(`(() => { const r = ${BS_PANE}?.querySelector("[data-brainstorm-rail]"); r?.scrollTo(0, r.scrollHeight); })()`);
            await h.shot("cdp-shots/brainstorm-judged-question-answered.png");
            rec(
                "4. answered: the rail's Q4 row marks the picked answer as the Judge’s pick, not the Agent’s",
                s4.ok &&
                    eq(row?.picked, [`${OPTIONS[0].label} Judge’s pick ${OPTIONS[0].detail}`]) &&
                    !row.text.includes("Agent’s pick"),
                { ...bsBrief(s4), row }
            );
        }),
    ];
}
