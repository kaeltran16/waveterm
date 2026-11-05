// Live spikes on a question's answers: each option's (and, while the judge weighs, each approach's) spikes draw as
// links in its row, and a spike left only on a note is linked over the question. kit is scenarios-brainstorm.mjs's
// BS_KIT.
//
// The fixture plays the portfolio-motion brainstorm: three motion options, a live spike for two of them, and the note
// the agent wrote the spikes up in.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOPIC = "motion-spikes";
const NAME = "brainstorm-answer-spikes";
const SPRING = "spike/spring.html";
const FADE = "spike/fade.html";
const TEXT = "How should the project cards move in?";

const opt = (label, spikes) => ({ label, detail: `${label} on scroll.`, ...(spikes ? { spikes } : {}) });
const NOTE = {
    id: "motion-spikes",
    title: "Motion spikes",
    kind: "note",
    from: "spike",
    gist: "Spring and fade, built as live pages.",
    body: "Both run at 60fps on the card grid.",
    spikes: [SPRING, FADE],
};
const file = (question, over = {}) => ({
    v: 1,
    title: "Portfolio redesign",
    spec: "",
    canvas: TOPIC,
    question: { n: 3, part: "motion", text: TEXT, ...question },
    working: null,
    parts: [{ id: "motion", title: "Card motion", state: "asked", body: "" }, NOTE],
    history: [],
    done: false,
    check: null,
    run: null,
    ...over,
});
const ON_OPTIONS = file({ options: [opt("Spring", [SPRING]), opt("Fade", [FADE]), opt("None")] });
// what went wrong: the spikes only on the note, the options text only
const TEXT_ONLY = file({ options: [opt("Spring"), opt("Fade"), opt("None")] });
const approach = (name, spikes) => ({ name, description: `${name} on scroll.`, facts: [], ...(spikes ? { spikes } : {}) });
const JUDGING = file(
    { approaches: [approach("Spring", [SPRING]), approach("None"), approach("Fade", [FADE])] },
    { working: "The judge is weighing 3 approaches." }
);

export default function (kit) {
    const { bsBoardScenario, bsArrangeAgent, bsWrite, bsUntil, bsBrief, bsCloseDesign, bsPartSel, polishWaitFor, BS_PANE } =
        kit;

    const LINK = `${BS_PANE}?.querySelector("[data-brainstorm-hidden-mockups]")`;
    // each answer row's spike links, by row, and the link to spikes the question does not draw
    const readRows = (h) =>
        h.ev(`(() => {
            const pane = ${BS_PANE};
            const rows = [...(pane?.querySelectorAll("[data-brainstorm-question] [data-brainstorm-option]") ?? [])];
            return {
                rows: rows.map((b) => [...b.parentElement.querySelectorAll("[data-brainstorm-spike]")].map((s) => s.getAttribute("data-brainstorm-spike"))),
                titles: rows.map((b) => [...b.parentElement.querySelectorAll("[data-brainstorm-spike]")].map((s) => s.title)),
                link: ${LINK} ? (${LINK}.innerText ?? "").trim() : null,
            };
        })()`);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    const scenario = bsBoardScenario(NAME, TOPIC, ON_OPTIONS, async (h, ctx, rec) => {
        const s1 = await bsUntil(h, ctx, (s) => s.question.includes(TEXT));
        const drawn = await polishWaitFor(h, `!!${BS_PANE}?.querySelector("[data-brainstorm-question] [data-brainstorm-spike]")`, 5000);
        const r1 = await readRows(h);
        await h.shot("cdp-shots/brainstorm-answer-spikes-1-options.png");
        rec(
            "1. each option's spike draws as a link in its own row, served from the canvas folder; the note's spikes are all shown, so no link over the question",
            s1.ok &&
                drawn &&
                same(r1.rows, [[SPRING], [FADE], []]) &&
                r1.titles[0][0]?.endsWith(`/${TOPIC}/${SPRING}`) &&
                r1.link === null,
            { ...bsBrief(s1), rows: r1 }
        );

        bsWrite(ctx, TEXT_ONLY);
        const linked = await polishWaitFor(h, `!!${LINK}`, 5000);
        const r2 = await readRows(h);
        await h.shot("cdp-shots/brainstorm-answer-spikes-2-note-only.png");
        rec(
            "2. spikes only on a note: the rows are text only, and the question links to them as Live spikes in 1 part",
            linked && same(r2.rows, [[], [], []]) && r2.link === "Live spikes in 1 part",
            r2
        );

        await h.ev(`${LINK}?.click()`);
        const opened = await polishWaitFor(
            h,
            `${bsPartSel(NOTE.id)}?.querySelectorAll("[data-brainstorm-spike]").length === 2`,
            5000
        );
        await h.shot("cdp-shots/brainstorm-answer-spikes-3-opened.png");
        rec("3. the link opens the design with the note open on its two spike links", opened, { opened });
        const closed = await bsCloseDesign(h);

        bsWrite(ctx, JUDGING);
        const judging = await polishWaitFor(
            h,
            `${BS_PANE}?.querySelectorAll("[data-brainstorm-judging] [data-brainstorm-approach]").length === 3`,
            5000
        );
        await polishWaitFor(h, `!!${BS_PANE}?.querySelector("[data-brainstorm-judging] [data-brainstorm-spike]")`, 5000);
        const r4 = await readRows(h);
        await h.shot("cdp-shots/brainstorm-answer-spikes-4-judging.png");
        rec(
            "4. while the judge weighs, each approach's spike draws in its row",
            closed && judging && same(r4.rows, [[SPRING], [], [FADE]]) && r4.link === null,
            { closed, judging, rows: r4 }
        );
    });

    return [
        {
            ...scenario,
            async arrange(h) {
                const ctx = await bsArrangeAgent(h, TOPIC, ON_OPTIONS);
                if (ctx.launchError != null || ctx.cwd == null) return ctx;
                try {
                    const dir = join(ctx.cwd, ".superpowers", "design", TOPIC, "spike");
                    mkdirSync(dir, { recursive: true });
                    for (const p of [SPRING, FADE]) {
                        writeFileSync(join(ctx.cwd, ".superpowers", "design", TOPIC, p), `<!doctype html><title>${p}</title>`);
                    }
                } catch (e) {
                    ctx.launchError = String(e?.message ?? e);
                }
                return ctx;
            },
        },
    ];
}
