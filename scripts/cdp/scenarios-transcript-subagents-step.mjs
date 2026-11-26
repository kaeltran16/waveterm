// Scenario `transcript-subagents-step`: the live line on each Agent step, a background step held running and out of
// the fold, and Open. Arranged over the transcript-subagents fixture (transcript-subagents-fixture.mjs) with the parent
// working; teardown removes it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPage } from "./agent-page-fixtures.mjs";
import { polishWaitFor } from "./scenarios-shared.mjs";
import {
    SUBAGENTS,
    arrangeSubagentsAgent,
    finishSubagent,
    setParentState,
    teardownSubagentsAgent,
    writeSubagentsFixture,
} from "./transcript-subagents-fixture.mjs";

const NAME = "transcript-subagents-step";
// the first listing, then the parent's re-read: its stream's next poll plus the 4s debounce
const LIST_WAIT_MS = 20_000;
// a running child's listing is re-read every 2s
const POLL_WAIT_MS = 10_000;

const S = SUBAGENTS;
// the state each child correlates to while the parent works: the spawn's result or notification says success
const WANT_STATES = {
    [S.guide.agentId]: "success",
    [S.tests.agentId]: "success",
    [S.research.agentId]: "working",
    [S.audit.agentId]: "working",
    [S.find.agentId]: "working",
};

const FEED = `document.querySelector("[data-rendered-feed]")`;
// the Open on a subagent's finish notice, drawn as either notification row
const NOTICE_OPEN = "[data-task-notification] [data-subagent-open], [data-notice] [data-subagent-open]";
const rowOf = (agentId) => `${FEED}?.querySelector('[data-step][data-subagent="${agentId}"]')`;

// what a step row draws for its subagent, as the page has it
const rowFacts = (agentId) => `(() => {
    const row = ${rowOf(agentId)};
    if (row == null) return null;
    const text = (sel) => row.querySelector(sel)?.textContent.replace(/\\s+/g, " ").trim() ?? null;
    return {
        status: row.getAttribute("data-step-status"),
        title: text("[data-step-title]"),
        spinner: row.querySelector('[aria-label="Running"]') != null,
        elapsed: text("[data-step-elapsed]"),
        duration: text("[data-step-duration]"),
        open: row.querySelector("[data-subagent-open]") != null,
        background: row.querySelector("[data-step-background]") != null,
        line: row.querySelector("[data-subagent-line]")?.getAttribute("data-subagent-line") ?? null,
        call: text("[data-subagent-call]"),
        target: text("[data-subagent-target]"),
        outcome: text("[data-subagent-outcome]"),
        count: text("[data-subagent-count]"),
        inFold: row.closest("[data-turn-fold]") != null,
    };
})()`;

const listOf = (parentId) =>
    `const S = await mod("app/view/agents/subagentsstore.ts");
    return (globalStore.get(S.subagentsByIdAtom)[${JSON.stringify(parentId)}] ?? []).map((s) => ({
        id: s.id,
        toolUseId: s.toolUseId,
        state: s.state,
    }));`;

const focused = () =>
    `const S = await mod("app/view/agents/subagentsstore.ts");
    return globalStore.get(S.focusSubagentAtom)?.agentId ?? null;`;

const unfocus = () =>
    `const S = await mod("app/view/agents/subagentsstore.ts");
    globalStore.set(S.focusSubagentAtom, null);
    return true;`;

// the last finished turn's fold, and the stretch drawn right after it
const AFTER_FOLD = `(() => {
    const folds = [...(${FEED}?.querySelectorAll("[data-turn-fold]") ?? [])];
    const fold = folds[folds.length - 1];
    if (fold == null) return null;
    const next = fold.nextElementSibling;
    return {
        line: fold.querySelector("[data-fold]")?.textContent.replace(/\\s+/g, " ").trim() ?? "",
        after: [...(next?.querySelectorAll("[data-step][data-subagent]") ?? [])].map((r) => r.getAttribute("data-subagent")),
    };
})()`;

const listJoined = (list) =>
    list.length === Object.keys(WANT_STATES).length &&
    Object.values(S).every((sub) =>
        list.some((s) => s.id === sub.agentId && s.toolUseId === sub.toolUseId && s.state === WANT_STATES[sub.agentId])
    );

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const ctx = { dir: mkdtempSync(join(tmpdir(), "verify-ts-step-")) };
                // a throw past this point still returns ctx, so teardown undoes whatever was already set
                try {
                    Object.assign(ctx, writeSubagentsFixture(ctx.dir, { turnEnded: false }));
                    await arrangeSubagentsAgent(h, ctx, { state: "working" });
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec("arrange the fixture agent", false, ctx.arrangeError);
                    return steps;
                }
                const list = () => agentPage(h, listOf(ctx.parentId));
                const facts = (sub) => h.ev(rowFacts(sub.agentId));

                // 1. the listing joins every file to its Agent call, the audit child (prompt reworded) by its meta
                let list1 = [];
                for (let waited = 0; waited < LIST_WAIT_MS && !listJoined(list1); waited += 500) {
                    list1 = (await list()) ?? [];
                    if (!listJoined(list1)) await new Promise((r) => setTimeout(r, 500));
                }
                rec(
                    "1. the parent's subagent list joins all five files to their Agent calls with the fixture's states",
                    listJoined(list1),
                    JSON.stringify(list1)
                );

                // 2. the running foreground step and the finished one
                await polishWaitFor(h, `${rowFacts(S.find.agentId)}?.count === "9 tools"`, LIST_WAIT_MS);
                const find = await facts(S.find);
                const tests = await facts(S.tests);
                await h.shot("cdp-shots/transcript-subagents-step-2-live-line.png");
                rec(
                    "2. the running foreground step, headed Explore, shows the spinner, elapsed, Open and its Grep; the finished one done",
                    find?.spinner &&
                        !!find.elapsed &&
                        find.open &&
                        find.call === "Searched" &&
                        find.target === "parsePlan(" &&
                        find.count === "9 tools" &&
                        find.title === "Explore" &&
                        tests != null &&
                        tests.title === "Explore" &&
                        !tests.spinner &&
                        tests.outcome === "done" &&
                        tests.count === "14 tools" &&
                        !!tests.duration,
                    JSON.stringify({ find, tests })
                );

                // 3. a background step whose launch ack landed stays running; the finished background notice opens
                const research = await facts(S.research);
                const tagAfterDescription = await h.ev(`(() => {
                    const tag = ${rowOf(S.research.agentId)}?.querySelector("[data-step-background]");
                    return tag?.previousElementSibling?.textContent.trim() === ${JSON.stringify(S.research.description)};
                })()`);
                const noticeOpen = await h.ev(`${FEED}?.querySelector(${JSON.stringify(NOTICE_OPEN)}) != null`);
                rec(
                    "3. the acked background step, headed general-purpose, shows the spinner, the background tag after its description and its live line; the notice shows Open",
                    research?.spinner &&
                        research.title === "general-purpose" &&
                        research.background &&
                        tagAfterDescription &&
                        research.line === "running" &&
                        !!research.call &&
                        noticeOpen,
                    JSON.stringify({ research, tagAfterDescription, noticeOpen })
                );

                // 4. the parent turns idle with its turn ended: the turn folds, both running background steps under it
                writeSubagentsFixture(ctx.dir, { turnEnded: true, now: ctx.now });
                await setParentState(h, ctx, "idle");
                const heldBoth = (a) =>
                    a != null &&
                    a.line.startsWith("Worked for") &&
                    a.after.includes(S.research.agentId) &&
                    a.after.includes(S.audit.agentId);
                await polishWaitFor(h, `(${heldBoth.toString()})(${AFTER_FOLD})`, LIST_WAIT_MS);
                const after4 = await h.ev(AFTER_FOLD);
                await h.shot("cdp-shots/transcript-subagents-step-4-held.png");
                rec(
                    "4. the ended turn folds into Worked for, both running background steps right under the fold line",
                    heldBoth(after4),
                    JSON.stringify(after4)
                );

                // 5. a finished child's step reads done with no spinner and joins the fold
                finishSubagent(ctx.childPaths.research);
                await polishWaitFor(
                    h,
                    `(() => { const a = ${AFTER_FOLD}; return a != null && !a.after.includes(${JSON.stringify(S.research.agentId)}); })()`,
                    POLL_WAIT_MS
                );
                const after5 = await h.ev(AFTER_FOLD);
                await h.ev(`(() => {
                    const folds = [...(${FEED}?.querySelectorAll("[data-turn-fold]") ?? [])];
                    folds[folds.length - 1]?.querySelector("[data-fold]")?.click();
                    return true;
                })()`);
                await polishWaitFor(h, `${rowFacts(S.research.agentId)}?.inFold === true`, POLL_WAIT_MS);
                const research5 = await facts(S.research);
                const spinnerOnFinished = await h.ev(`[...(${FEED}?.querySelectorAll("[data-step][data-subagent]") ?? [])]
                    .filter((r) => r.querySelector("[data-subagent-line]")?.getAttribute("data-subagent-line") !== "running")
                    .filter((r) => r.querySelector('[aria-label="Running"]') != null)
                    .map((r) => r.getAttribute("data-subagent"))`);
                await h.shot("cdp-shots/transcript-subagents-step-5-joined.png");
                rec(
                    "5. after the research child finishes, its step reads done with no spinner inside the fold",
                    after5 != null &&
                        !after5.after.includes(S.research.agentId) &&
                        after5.after.includes(S.audit.agentId) &&
                        research5?.inFold &&
                        research5.outcome === "done" &&
                        !research5.spinner &&
                        spinnerOnFinished.length === 0,
                    JSON.stringify({ after5, research5, spinnerOnFinished })
                );

                // 6. Open on a step and on the finished notice focuses that child
                await h.ev(`${rowOf(S.audit.agentId)}?.querySelector("[data-subagent-open]")?.click() ?? false`);
                const fromStep = await agentPage(h, focused());
                await agentPage(h, unfocus());
                await polishWaitFor(h, `${FEED}?.querySelector(${JSON.stringify(NOTICE_OPEN)}) != null`, POLL_WAIT_MS);
                await h.ev(`${FEED}?.querySelector(${JSON.stringify(NOTICE_OPEN)})?.click() ?? false`);
                const fromNotice = await agentPage(h, focused());
                await agentPage(h, unfocus());
                rec(
                    "6. Open on the audit step and on the guide's finish notice focuses that child",
                    fromStep === S.audit.agentId && fromNotice === S.guide.agentId,
                    JSON.stringify({ fromStep, fromNotice })
                );
                return steps;
            },
            teardown: teardownSubagentsAgent,
        },
    ];
}
