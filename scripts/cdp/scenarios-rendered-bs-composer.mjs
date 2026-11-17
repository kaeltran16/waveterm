// Scenario rendered-bs-composer: the Rendered box answering the brainstorm (decision 7). Main's open question 4 sets
// its placeholder; Answered's question 5 (no options) is answered by typing, the "Answers question 5" label showing
// as the box fills and Send sending the pane's answer line, recorded as picked here; KeepTalking (no question open
// after the builder check) gives the pushback hint; Working (the agent writing) drops the brainstorm card and leaves
// the normal steer box over the turn's steps and working line. kit is scenarios-rendered-brainstorm.mjs's RBS_KIT.

import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { toolUse, userText } from "./agent-page-fixtures.mjs";
import { BS_HANDOFF_ANSWERED, BS_HISTORY, BS_HISTORY_Q4, BS_Q4, bsFile, bsParts } from "./scenarios-shared.mjs";

const NAME = "rendered-bs-composer";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;

const MAIN = bsFile({
    parts: bsParts({ intent: "yours", goals: "yours", anti: "yours", constraints: "guess", thresholds: "asked" }),
    history: BS_HISTORY,
    question: BS_Q4,
});
const Q5 = { n: 5, text: "What should the banner say while a run waits for its Final?", part: "page" };
const ANSWERED = bsFile({
    parts: bsParts({ intent: "yours", goals: "yours", anti: "yours", constraints: "yours", thresholds: "yours", page: "asked" }),
    history: BS_HISTORY_Q4,
    question: Q5,
});
const TYPED = "<run>'s Final has waited 20m for its turn";
// after the builder check, the user kept talking: nothing open, one part reopened as a guess
const KEEP_TALKING = {
    ...BS_HANDOFF_ANSWERED,
    done: false,
    parts: BS_HANDOFF_ANSWERED.parts.map((p) =>
        p.id === "page" ? { ...p, state: "guess", body: "<run>'s Final, 2nd in line, has waited 20m" } : p
    ),
};
const WRITING = { ...KEEP_TALKING, working: "Rewriting “What on-call sees” from your pushback." };
const PUSHBACK = "The banner should also say where the run is in the queue.";
const WORK_CMD = "node scripts/lint-banner.mjs";
const STEER = "Steer the agent; it reads this before its next step";
const HINT = "No question open · your line reaches the brainstorm as pushback or a question back";

export default (kit) => {
    const { scenario, writeFile, readHost, waitCard, recordSends, waitSent, answerRecords, agentPage, polishWaitFor, RV, WAIT_MS, BS_POLL_WAIT_MS } = kit;
    const BOX = `${RV}?.querySelector("[data-rendered-composer]")`;

    // the box as drawn: its placeholder, route, the label and hint beside the model chip, and which button shows
    const readBox = (h) =>
        h.ev(`(() => {
            const box = ${BOX};
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            return {
                placeholder: box?.querySelector("textarea")?.placeholder ?? null,
                route: box?.querySelector("[data-composer-box]")?.getAttribute("data-composer-route") ?? null,
                answers: flat(box?.querySelector("[data-composer-answers]")) || null,
                hint: flat(box?.querySelector("[data-composer-hint]")) || null,
                stop: box?.querySelector("[data-composer-interrupt]") != null,
                send: box?.querySelector("[data-composer-send]") != null,
            };
        })()`);

    const typeBox = (h, text) =>
        h.ev(`(() => {
            const ta = ${BOX}?.querySelector("textarea");
            if (!ta) return false;
            ta.focus();
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ${JSON.stringify(text)});
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        })()`);

    const patchAgent = (h, ctx, fields) =>
        agentPage(h, `window.__cockpitRosterFixture?.patch(${JSON.stringify(ctx.agentId)}, ${JSON.stringify(fields)}); return true;`);

    return [
        scenario(NAME, { file: MAIN }, async (h, ctx, step) => {
            await step("Main: question 4 open, the box reads Answer question 4 in your own words, or push back", async () => {
                const want = "Answer question 4 in your own words, or push back";
                const met = await polishWaitFor(h, `${BOX}?.querySelector("textarea")?.placeholder === ${JSON.stringify(want)}`, BS_POLL_WAIT_MS);
                const box = await readBox(h);
                await h.shot(SHOT(1, "main"));
                return [met && box.route === "talk" && box.answers == null && box.hint == null, box];
            });

            await step("Answered: question 5 has no options; typing shows Answers question 5 and Send sends the line, recorded as picked here", async () => {
                writeFile(ctx, ANSWERED);
                const asked = await polishWaitFor(h, `${BOX}?.querySelector("textarea")?.placeholder?.startsWith("Answer question 5") === true`, BS_POLL_WAIT_MS);
                const empty = await readBox(h);
                await recordSends(h);
                await typeBox(h, TYPED);
                const labelled = await polishWaitFor(h, `(${BOX}?.querySelector("[data-composer-answers]")?.innerText ?? "").includes("Answers question 5")`, WAIT_MS);
                const filled = await readBox(h);
                await h.shot(SHOT(2, "answered-filled"));
                await h.ev(`(() => { ${BOX}?.querySelector("[data-composer-send]")?.click(); return true; })()`);
                const line = await waitSent(h, 0);
                const recs = await answerRecords(h, ctx);
                const rec = recs.at(-1) ?? null;
                const cleared = await polishWaitFor(h, `${BOX}?.querySelector("textarea")?.value === ""`, WAIT_MS);
                const ok =
                    asked &&
                    empty.answers == null &&
                    labelled &&
                    filled.answers === "Answers question 5" &&
                    line === TYPED &&
                    rec?.origin === "transcript" &&
                    rec?.question === 5 &&
                    rec?.line === TYPED &&
                    cleared;
                return [ok, { asked, empty, filled, line, rec, cleared }];
            });

            await step("KeepTalking: no question open after the builder check; the box keeps its placeholder and gives the pushback hint", async () => {
                writeFile(ctx, KEEP_TALKING);
                await kit.agentIdle(h, ctx);
                const met = await polishWaitFor(h, `(${BOX}?.querySelector("[data-composer-hint]")?.innerText ?? "").includes("No question open")`, BS_POLL_WAIT_MS);
                const box = await readBox(h);
                await h.shot(SHOT(3, "keep-talking"));
                await typeBox(h, PUSHBACK);
                const filled = await readBox(h);
                await typeBox(h, "");
                const ok = met && box.hint === HINT && box.route === "line" && box.placeholder?.startsWith("Reply to ") && filled.answers == null;
                return [ok, { box, filledAnswers: filled.answers }];
            });

            await step("Working: the agent writing; no brainstorm card under the timeline, the steer box with Stop, the turn's steps and working line drawn", async () => {
                const transcript = readdirSync(ctx.dir).find((f) => f.endsWith(".jsonl"));
                if (transcript == null) return [false, "no transcript file in the fixture dir"];
                const t0 = Date.now();
                appendFileSync(
                    join(ctx.dir, transcript),
                    [
                        userText(PUSHBACK, { ts: new Date(t0 - 20_000).toISOString() }),
                        toolUse("toolu_rbs_work", "Bash", { command: WORK_CMD }, { ts: new Date(t0 - 5_000).toISOString() }),
                    ].join("\n") + "\n"
                );
                writeFile(ctx, WRITING);
                await patchAgent(h, ctx, { state: "working" });
                const gone = await waitCard(h, "none");
                const steering = await polishWaitFor(h, `${BOX}?.querySelector("textarea")?.placeholder === ${JSON.stringify(STEER)}`, BS_POLL_WAIT_MS);
                const drawn = await polishWaitFor(
                    h,
                    `${RV}?.querySelector("[data-working-line]") != null && (${RV}?.querySelector('[data-step][data-step-status="running"]')?.innerText ?? "").includes(${JSON.stringify(WORK_CMD)})`,
                    WAIT_MS
                );
                // the hint leaves through its exit fade, so it can still be in the DOM the moment the steer box shows
                const hintGone = await polishWaitFor(h, `${BOX}?.querySelector("[data-composer-hint]") == null`, WAIT_MS);
                const host = await readHost(h);
                const box = await readBox(h);
                await h.shot(SHOT(4, "working"));
                const ok = gone && steering && drawn && hintGone && host.text === "" && box.route == null && box.hint == null && box.stop && !box.send;
                return [ok, { gone, steering, drawn, hintGone, hostText: host.text, box }];
            });
        }),
    ];
};
