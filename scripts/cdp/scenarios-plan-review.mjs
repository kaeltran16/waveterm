// Plan review scenarios: the plan reviewer's rounds and model picks.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    MODELS_PLAN,
    MODELS_VIEWPORT,
    PEEKS_ESC,
    flatText,
    polishNap,
    polishReload,
    polishWaitFor,
    seedDag,
    teardownFixtureRun,
} from "./scenarios-shared.mjs";
import { RV_WIDE, RV_MODAL, rvFact } from "./scenarios-runs.mjs";

// --- new-run-window, model-picks: a model per task (docs/superpowers/specs/2026-09-29-worker-reviewer-models-design.md)
// model-picks reads a five-task plan of noops, past the fast track so the full review picks: Task 1 has a Model
// line, Tasks 2 to 5 are left to the plan reviewer.
const MODELS_RPC = { timeout: 30000 };
const MODELS_PLAN_FULL = fileURLToPath(new URL("./fixtures/models-plan-full.md", import.meta.url));
const FULL_PLAN_TASKS = 5;

const PICKS_BANNER = `document.querySelector('[data-dag-modal-kind] [data-model-picks-banner]')`;
// the pick row lives in the selected task's peek card, so only the selected task's row is ever on screen
const PICKS_PEEK = `[data-dag-modal-kind] [data-dag-task-peek]`;
const PICK_ROWS = `[...document.querySelectorAll('${PICKS_PEEK} [data-model-pick]')]`;
const pickRowExpr = (id) => `document.querySelector('${PICKS_PEEK} [data-model-pick="${id}"]')`;
const pickToggleExpr = (id, sonnet) =>
    `[...(${pickRowExpr(id)}?.querySelectorAll('[role="group"] button') ?? [])].find((b) => (b.textContent.trim() === 'sonnet') === ${sonnet})`;
const dagCardExpr = (id) => `document.querySelector('[data-dag-modal-kind] [data-dag-node="${id}"]')`;
// a card's model tag chip names the model; who put it there is the last clause of the card's aria-label
const cardTagExpr = (id) =>
    `((c) => { const t = c?.querySelector('[data-dag-node-tag]'); return t ? t.textContent.trim() + ' · ' + c.getAttribute('aria-label').split(', ').pop() : null; })(${dagCardExpr(id)})`;
// the peek card's Worker row carries the same route attribute as the nodes
const DAG_RAIL_ROUTE = `document.querySelector('${PICKS_PEEK} [data-dag-node-route]')`;
const peekRouteExpr = (id) => `document.querySelector('[data-dag-modal-kind] [data-dag-task-peek="${id}"] [data-dag-node-route]')`;
const railExpr = `({ route: ${DAG_RAIL_ROUTE}?.getAttribute('data-dag-node-route') ?? null, text: ${flatText(DAG_RAIL_ROUTE)} })`;
// Task 1's Model line leaves it off the picks; one sonnet pick and the rest lead picks make the banner "1 of 5"
const MODEL_PICKS = [
    { taskid: "t-2", model: "sonnet", reason: "a noop needs no deep reasoning" },
    { taskid: "t-3", model: "lead", reason: "kept on the lead, so its rail must show no pick" },
    { taskid: "t-4", model: "lead", reason: "kept on the lead" },
    { taskid: "t-5", model: "lead", reason: "kept on the lead" },
];

async function dagTask(h, ctx, id) {
    const g = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
    return (g?.tasks ?? []).find((t) => t.id === id) ?? null;
}

async function waitDagTask(h, ctx, id, ok) {
    let task = null;
    for (let waited = 0; waited < 8000; waited += 250) {
        task = await dagTask(h, ctx, id);
        if (task != null && ok(task)) break;
        await polishNap(250);
    }
    return task;
}

const taskFacts = (t) =>
    t && { state: t.state, modelsource: t.modelsource ?? "", runtime: t.runspec?.runtime ?? "", model: t.runspec?.model ?? "" };

// the plan review's reviewers are real sessions; haiku keeps a round's two cheap
const HAIKU_ROUTE = { runtime: "claude", model: "haiku" };
const ROUND_ONE_LENSES = ["full", "second"];
const LENS_TITLE = {
    full: "Full review",
    second: "Second pass",
    followup: "Round-2 follow-up",
};
const PLAN_REVIEWER_WAIT_MS = 90000;

const planReviewOf = async (h, ctx) =>
    (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group?.planreview ?? null;

// Waits for the round's reviewers to start, then records each one's verdict in its own name before it can send
// one, the reviewer that picks models last, so the round settles on it. verdicts maps a lens to
// { verdict, notes, picks? }, in the order they are sent.
async function recordPlanReviewRound(h, ctx, round, verdicts) {
    const lenses = Object.keys(verdicts);
    let pr = null;
    const started = () =>
        pr?.round === round &&
        (pr.reviewers ?? []).length === lenses.length &&
        pr.reviewers.every((r) => r.runid && lenses.includes(r.lens));
    for (let waited = 0; waited < PLAN_REVIEWER_WAIT_MS && !started(); waited += 1000) {
        pr = await planReviewOf(h, ctx);
        if (!started()) await polishNap(1000);
    }
    if (!started()) {
        throw new Error(`round ${round}: want reviewers ${lenses.join(", ")} with run ids, got ${JSON.stringify(pr?.reviewers ?? null)}`);
    }
    for (const lens of lenses) {
        const r = pr.reviewers.find((x) => x.lens === lens);
        if (r.state !== "reviewing") {
            throw new Error(`round ${round}: the ${lens} reviewer sent its own verdict (${r.state}) before the scenario could`);
        }
        const v = verdicts[lens];
        await h.rpc(
            "dagaction",
            {
                channelid: ctx.channelId,
                runid: r.runid,
                taskid: "",
                action: `planreview-${v.verdict}`,
                notes: v.notes,
                ...(v.picks ? { picks: v.picks } : {}),
            },
            MODELS_RPC
        );
    }
}

const PLAN_REVIEWER_CHIPS = `[...document.querySelectorAll('[data-dag-modal-kind] [data-plan-reviewer]')].map((c) => ({
    lens: c.getAttribute('data-plan-reviewer'),
    state: c.getAttribute('data-plan-reviewer-state'),
    line: (c.parentElement?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
}))`;
const DAG_RAIL = `document.querySelector('[data-dag-modal-kind] [data-timeline-rail]')`;

// Opens the timeline rail's group whose title starts with prefix, and reads the titles of its events and the
// plan reviewer sub-rows under them. One group is open at a time, so opening it closes any other.
const railGroupExpr = (prefix) => `(async () => {
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const rows = () => [...(${DAG_RAIL}?.querySelectorAll('[data-timeline-row]') ?? [])];
    const row = () => rows().find((b) => flat(b.querySelector('span > span')).startsWith(${JSON.stringify(prefix)}));
    for (let i = 0; i < 40 && !row(); i++) await new Promise((r) => setTimeout(r, 250));
    if (!row()) return { found: false, rows: rows().map((b) => flat(b.querySelector('span > span'))) };
    if (row().getAttribute('aria-expanded') !== 'true') row().click();
    for (let i = 0; i < 20 && !row().nextElementSibling; i++) await new Promise((r) => setTimeout(r, 100));
    const detail = row().nextElementSibling;
    return {
        found: true,
        titles: [...(detail?.querySelectorAll(':scope > div > div:first-child > span:nth-child(2)') ?? [])].map(flat),
        reviewers: [...(detail?.querySelectorAll('[data-plan-review-reviewer]') ?? [])].map((r) => ({
            lens: r.getAttribute('data-plan-review-reviewer'),
            text: flat(r),
        })),
    };
})()`;

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export const modelPicks = {
    name: "model-picks",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-model-picks-"));
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-model-picks", projectpath: cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: "verify model-picks: do nothing, make no file changes, stop immediately",
                runtime: "claude",
                mode: "orchestrator",
                deferstart: true,
                reviewerpicks: true,
                reviewerroute: HAIKU_ROUTE,
                lightreviewerroute: HAIKU_ROUTE,
                parallelism: 1,
            });
            ctx.runId = created.run.id;
            await h.rpc(
                "dagsubmit",
                { channelid: ctx.channelId, runid: ctx.runId, parallelism: 1, planpath: MODELS_PLAN_FULL },
                MODELS_RPC
            );
            // the two reviewers are real sessions, spawned after the submit returns: the second pass's pass, then
            // the full reviewer's with the picks
            const pass = { verdict: "pass", notes: "verify model-picks: five noops" };
            await recordPlanReviewRound(h, ctx, 1, {
                second: pass,
                full: { ...pass, picks: MODEL_PICKS },
            });
            // the Brief reads a boot-primed snapshot, so the RPC-created channel needs a reload
            await polishReload(h);
            ctx.opened = await h.ev(`(async () => {
                for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                if (typeof window.__openAddress !== "function") return { ok: false, why: "no __openAddress hook" };
                return window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)});
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. a Reviewer picks run passed its plan review with picks", false, ctx.arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        const openDag = `[...(document.querySelector('[data-jarvis-brief-sheet]')?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Open DAG')`;
        const sheet = await polishWaitFor(h, `!!${openDag}`, 15000);
        if (sheet) await h.ev(`${openDag}.click()`);
        const graph = await polishWaitFor(
            h,
            `!!document.querySelector('[data-dag-modal-kind="live"]') && document.querySelectorAll('[data-dag-modal-kind] [data-dag-node]:not([data-dag-node="final"])').length === ${FULL_PLAN_TASKS}`,
            10000
        );
        rec(
            `0. the run's graph opened with its ${FULL_PLAN_TASKS} tasks`,
            ctx.opened?.ok === true && sheet && graph,
            JSON.stringify({ runId: ctx.runId, opened: ctx.opened, sheet, graph })
        );
        if (!graph) return steps;

        await polishWaitFor(h, `!!${PICKS_BANNER}`, 5000);
        const banner = await h.ev(flatText(PICKS_BANNER));
        await h.shot("cdp-shots/model-picks-1-banner.png");
        const wantBanner = `1 of ${FULL_PLAN_TASKS} tasks on sonnet`;
        rec(`1. the banner reads \`${wantBanner}\``, banner.includes(wantBanner), `banner=${JSON.stringify(banner)}`);

        await h.ev(`${dagCardExpr("t-3")}?.click()`);
        const leadCard = await polishWaitFor(h, `!!${peekRouteExpr("t-3")}`, 3000);
        const leadRows = await h.ev(`${PICK_ROWS}.map((r) => r.getAttribute('data-model-pick'))`);
        await h.ev(`${dagCardExpr("t-2")}?.click()`);
        await polishWaitFor(h, `!!${pickRowExpr("t-2")}`, 3000);
        const rail = await h.ev(`({
            rows: ${PICK_ROWS}.map((r) => r.getAttribute('data-model-pick')),
            pressed: ${pickRowExpr("t-2")}?.querySelector('[role="group"] button[aria-pressed="true"]')?.textContent.trim() ?? null,
            reason: ${flatText(pickRowExpr("t-2"))}.includes(${JSON.stringify(MODEL_PICKS[0].reason)}),
            outside: document.querySelectorAll('[data-dag-modal-kind] [data-model-pick]').length - ${PICK_ROWS}.length,
        })`);
        rec(
            "2. only the sonnet pick shows a model row in the task's peek card, on sonnet, with its reason",
            leadCard &&
                leadRows.length === 0 &&
                rail.rows.length === 1 &&
                rail.rows[0] === "t-2" &&
                rail.pressed === "sonnet" &&
                rail.reason &&
                rail.outside === 0,
            JSON.stringify({ leadCard, leadRows, ...rail })
        );

        const card = await h.ev(`(() => {
            const row = ${pickRowExpr("t-2")};
            const toggle = row?.querySelector('[role="group"]');
            return {
                inCard: row?.closest('[data-dag-task-peek]')?.getAttribute('data-dag-task-peek') ?? null,
                toggle: [...(toggle?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()),
                text: ${flatText(pickRowExpr("t-2"))},
            };
        })()`);
        await h.shot("cdp-shots/model-picks-1b-card.png");
        rec(
            "1b. the waiting t-2's card carries its model toggle, waiting, with the plan reviewer's reason",
            card.inCard === "t-2" && card.toggle.length === 2 && card.toggle.includes("sonnet") && card.text.includes("waiting") && card.text.includes("Plan reviewer:"),
            JSON.stringify(card)
        );

        const picked = await h.ev(`({
            t1: ${cardTagExpr("t-1")},
            t2: ${cardTagExpr("t-2")},
            t3: ${cardTagExpr("t-3")},
            rail: ${railExpr},
        })`);
        rec(
            "3. the cards tag the plan's and the reviewer's picks, and the peek card's Worker row names the reviewer",
            picked.t1 === "sonnet · plan's pick" &&
                picked.t2 === "sonnet · reviewer's pick" &&
                picked.t3 == null &&
                picked.rail.route === "reviewer:claude:sonnet" &&
                picked.rail.text.includes("claude / sonnet") &&
                picked.rail.text.includes("reviewer's pick"),
            JSON.stringify(picked)
        );

        await h.ev(`${pickToggleExpr("t-2", false)}?.click()`);
        const onLead = await waitDagTask(h, ctx, "t-2", (t) => t.modelsource === "owner");
        await polishWaitFor(h, `${flatText(pickRowExpr("t-2"))}.includes('you changed it')`, 3000);
        const leadRow = await h.ev(flatText(pickRowExpr("t-2")));
        rec(
            "4. toggling the pick to the lead's model writes modelsource owner and clears the pin",
            onLead?.modelsource === "owner" && !onLead.runspec?.model && leadRow.includes("you changed it"),
            JSON.stringify({ task: taskFacts(onLead), row: leadRow })
        );

        await h.ev(`${pickToggleExpr("t-2", true)}?.click()`);
        const onSonnet = await waitDagTask(h, ctx, "t-2", (t) => t.modelsource === "owner" && t.runspec?.model === "sonnet");
        await polishWaitFor(h, `${cardTagExpr("t-2")} === "sonnet · your pick"`, 3000);
        const yours = await h.ev(`({ tag: ${cardTagExpr("t-2")}, rail: ${railExpr} })`);
        await h.shot("cdp-shots/model-picks-2-yours.png");
        rec(
            "5. toggling it back to sonnet tags the node sonnet, labelled your pick, and the peek card's Worker row names your pick",
            onSonnet?.modelsource === "owner" &&
                onSonnet.runspec?.model === "sonnet" &&
                yours.tag === "sonnet · your pick" &&
                yours.rail.route === "owner:claude:sonnet" &&
                yours.rail.text.includes("your pick"),
            JSON.stringify({ task: taskFacts(onSonnet), ...yours })
        );

        const chips = await h.ev(PLAN_REVIEWER_CHIPS);
        await h.shot("cdp-shots/model-picks-3-reviewers.png");
        rec(
            "6. the graph's stage line shows two plan reviewers, each passed",
            sameSet(
                chips.map((c) => c.lens),
                ROUND_ONE_LENSES
            ) && chips.every((c) => c.state === "passed"),
            JSON.stringify(chips)
        );

        // step 2 left t-2 selected, which narrows the rail to t-2's events; Plan reviewed is the run's, under All
        await h.ev(`${DAG_RAIL}?.querySelector('[data-timeline-filter-count="all"]')?.closest('button')?.click()`);
        const reviewed = await h.ev(railGroupExpr("Plan reviewed"));
        await h.shot("cdp-shots/model-picks-4-plan-reviewed.png");
        rec(
            "7. the timeline's Plan reviewed row lists two reviewers",
            reviewed.found &&
                sameSet(
                    reviewed.reviewers.map((r) => r.lens),
                    ROUND_ONE_LENSES
                ) &&
                reviewed.reviewers.every((r) => r.text === `${LENS_TITLE[r.lens]} · passed`),
            JSON.stringify(reviewed)
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await teardownFixtureRun(h, ctx, "model-picks");
    },
};

// --- plan-review-rounds: round 1's two reviewers, the second pass failing, then round 2's follow-up on a resubmit
// (docs/superpowers/specs/2026-10-14-wider-plan-review-design.md). The failed round launches a real lead: its run
// is on haiku, and the finding it is woken with tells it to leave the plan alone, so the scenario's resubmit is the
// only one.
const ROUNDS_FINDING =
    "verify plan-review-rounds: a UI check drives this review; leave the plan as it is, do not resubmit it, and stop";
const ROUNDS_GOAL =
    "verify plan-review-rounds: a UI check drives this run; do nothing, make no file changes, submit no plan, and stop";
const PLAN_REVIEW_TITLE = "Plan review · ";

// the agent tree's plan-reviewer rows, with the run's finished reviews unfolded first: a stage with a verdict
// folds under "N reviews". It waits for want rows.
const planReviewTreeRows = (want) => `(async () => {
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const tree = () => document.querySelector('[data-agent-tree]');
    const folds = () => [...(tree()?.querySelectorAll('div.cursor-pointer') ?? [])].filter(
        (d) => /\\d+ (plan )?reviews?$/.test(flat(d)) && d.querySelector('.lucide-chevron-right')
    );
    const titles = () => [...(tree()?.querySelectorAll('div') ?? [])].filter(
        (d) => d.children.length === 0 && flat(d).startsWith(${JSON.stringify(PLAN_REVIEW_TITLE)})
    );
    for (let i = 0; i < 40 && folds().length === 0 && titles().length < ${want}; i++) {
        await new Promise((r) => setTimeout(r, 250));
    }
    folds().forEach((f) => f.click());
    for (let i = 0; i < 20 && titles().length < ${want}; i++) await new Promise((r) => setTimeout(r, 250));
    return {
        tree: tree() != null,
        rows: titles().map((t) => ({ title: flat(t), sub: flat(t.nextElementSibling) })),
    };
})()`;

async function openRunGraph(h, ctx, tasks) {
    await polishReload(h);
    await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
    const opened = await h.ev(`(async () => {
        for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
            await new Promise((r) => setTimeout(r, 250));
        }
        if (typeof window.__openAddress !== "function") return { ok: false, why: "no __openAddress hook" };
        return window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)});
    })()`);
    const openDag = `[...(document.querySelector('[data-jarvis-brief-sheet]')?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Open DAG')`;
    const sheet = await polishWaitFor(h, `!!${openDag}`, 15000);
    if (sheet) await h.ev(`${openDag}.click()`);
    const graph = await polishWaitFor(
        h,
        `!!document.querySelector('[data-dag-modal-kind="live"]') && document.querySelectorAll('[data-dag-modal-kind] [data-dag-node]:not([data-dag-node="final"])').length === ${tasks}`,
        10000
    );
    return { ok: opened?.ok === true && sheet && graph, opened, sheet, graph };
}

export const planReviewRounds = {
    name: "plan-review-rounds",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-plan-review-rounds-"));
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            // the lead the failed round launches works in cwd, so it reads this copy rather than the repo's fixture
            ctx.planPath = join(cwd, "plan.md");
            writeFileSync(ctx.planPath, readFileSync(MODELS_PLAN_FULL));
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-plan-review-rounds", projectpath: cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: ROUNDS_GOAL,
                runtime: "claude",
                model: "haiku",
                mode: "orchestrator",
                deferstart: true,
                // owned here, so the profile cannot make the full reviewer's pass need picks
                reviewerpicks: false,
                reviewerroute: HAIKU_ROUTE,
                lightreviewerroute: HAIKU_ROUTE,
                parallelism: 1,
            });
            ctx.runId = created.run.id;
            ctx.landPath = created.run.landpath;
            await h.rpc(
                "dagsubmit",
                { channelid: ctx.channelId, runid: ctx.runId, parallelism: 1, planpath: ctx.planPath },
                MODELS_RPC
            );
            const pass = { verdict: "pass", notes: "verify plan-review-rounds: five noops" };
            await recordPlanReviewRound(h, ctx, 1, {
                second: { verdict: "fail", notes: ROUNDS_FINDING },
                full: pass,
            });
            ctx.graph = await openRunGraph(h, ctx, FULL_PLAN_TASKS);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. round 1's two reviewers recorded their verdicts, the second pass failing", false, ctx.arrangeError);
            return steps;
        }
        rec(`0. the run's graph opened with its ${FULL_PLAN_TASKS} tasks`, ctx.graph.ok, JSON.stringify({ runId: ctx.runId, ...ctx.graph }));
        if (!ctx.graph.ok) return steps;

        await polishWaitFor(h, `${PLAN_REVIEWER_CHIPS}.filter((c) => c.state !== 'reviewing').length === ${ROUND_ONE_LENSES.length}`, 5000);
        const chips = await h.ev(PLAN_REVIEWER_CHIPS);
        await h.shot("cdp-shots/plan-review-rounds-1-chips.png");
        rec(
            "1. round 1: two chips, full passed and the second pass failed",
            sameSet(
                chips.map((c) => c.lens),
                ROUND_ONE_LENSES
            ) && chips.every((c) => c.state === (c.lens === "second" ? "failed" : "passed")),
            JSON.stringify(chips)
        );

        const reviewed = await h.ev(railGroupExpr("Plan reviewed"));
        const findings = (await planReviewOf(h, ctx))?.findings ?? "";
        await h.shot("cdp-shots/plan-review-rounds-2-plan-reviewed.png");
        rec(
            "2. the Plan reviewed row lists two reviewers, and the findings begin with [Second pass]",
            reviewed.found &&
                sameSet(
                    reviewed.reviewers.map((r) => r.lens),
                    ROUND_ONE_LENSES
                ) &&
                reviewed.reviewers.every((r) => r.text === `${LENS_TITLE[r.lens]} · ${r.lens === "second" ? "failed" : "passed"}`) &&
                findings.startsWith("[Second pass]"),
            JSON.stringify({ ...reviewed, findings: findings.slice(0, 200) })
        );

        const started = await h.ev(railGroupExpr("Plan reviewer started"));
        const want = ROUND_ONE_LENSES.map((l) => `Plan reviewer started · ${LENS_TITLE[l]}`);
        await h.shot("cdp-shots/plan-review-rounds-3-started.png");
        rec(
            "3. the timeline names each reviewer's lens in its started row",
            started.found && sameSet(started.titles, want),
            JSON.stringify(started)
        );

        await h.goto("agent");
        const tree = await h.ev(planReviewTreeRows(ROUND_ONE_LENSES.length));
        await h.shot("cdp-shots/plan-review-rounds-4-tree.png");
        const wantRows = ROUND_ONE_LENSES.map((l) => ({
            title: `${PLAN_REVIEW_TITLE}${LENS_TITLE[l]}`,
            verdict: l === "second" ? "failed" : "passed",
        }));
        rec(
            "4. the agent tree's plan-reviewer rows name their lens and verdict",
            tree.rows.length === ROUND_ONE_LENSES.length &&
                wantRows.every((w) => tree.rows.some((r) => r.title === w.title && r.sub.split(" · ")[0] === w.verdict)),
            tree.rows.length === 0
                ? `no plan-reviewer rows in the tree: the run's reviewer tabs were reaped or never joined the roster (${JSON.stringify(tree)})`
                : JSON.stringify(tree)
        );

        // the same plan again: the review failed and nothing dispatched, so it replaces the proposal and opens round 2
        await h.rpc(
            "dagsubmit",
            { channelid: ctx.channelId, runid: ctx.runId, parallelism: 1, planpath: ctx.planPath },
            MODELS_RPC
        );
        let round2 = null;
        for (let waited = 0; waited < PLAN_REVIEWER_WAIT_MS; waited += 1000) {
            round2 = await planReviewOf(h, ctx);
            if (round2?.round === 2 && round2.reviewers?.length === 1 && round2.reviewers[0].runid) break;
            await polishNap(1000);
        }
        const graph2 = await openRunGraph(h, ctx, FULL_PLAN_TASKS);
        await polishWaitFor(h, `${PLAN_REVIEWER_CHIPS}.length === 1`, 5000);
        const reviewing = await h.ev(PLAN_REVIEWER_CHIPS);
        await h.shot("cdp-shots/plan-review-rounds-5-round-2.png");
        rec(
            "5. round 2 shows one follow-up chip",
            graph2.ok &&
                reviewing.length === 1 &&
                reviewing[0].lens === "followup" &&
                reviewing[0].state === "reviewing" &&
                reviewing[0].line.includes("round 2"),
            JSON.stringify({ graph: graph2, chips: reviewing, reviewers: round2?.reviewers ?? null })
        );
        if (reviewing.length !== 1) return steps;

        // while round 2's reviewer is in flight: measured now, as step 6 ends the review
        await planReviewInFlight(h, ctx, rec);

        let recorded = "ok";
        try {
            await recordPlanReviewRound(h, ctx, 2, { followup: { verdict: "pass", notes: "verify plan-review-rounds: the plan is unchanged" } });
        } catch (e) {
            recorded = String(e?.message ?? e);
        }
        await polishWaitFor(h, `${PLAN_REVIEWER_CHIPS}[0]?.state === 'passed'`, 5000);
        const passed = await h.ev(PLAN_REVIEWER_CHIPS);
        await h.shot("cdp-shots/plan-review-rounds-6-round-2-passed.png");
        rec(
            "6. the follow-up chip reads passed",
            recorded === "ok" && passed.length === 1 && passed[0].lens === "followup" && passed[0].state === "passed",
            JSON.stringify({ recorded, chips: passed })
        );

        await planReviewEnded(h, ctx, rec);
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await h.cdp("Emulation.clearDeviceMetricsOverride").catch((e) => {
            console.error(`plan-review-rounds teardown: clear the viewport override failed: ${e?.message ?? e}`);
        });
        await teardownFixtureRun(h, ctx, "plan-review-rounds");
    },
};

// --- plan-review-light: a plan of 3 tasks takes the fast track: one light reviewer, failed here over RPC, then the
// same plan resubmitted, which dispatches as the lead's amendment
// (docs/superpowers/specs/2026-11-23-orchestrator-quick-track-design.md). The failed round wakes a real lead on
// haiku, whose finding tells it to leave the plan alone, so the scenario's resubmit is the only one.
const LIGHT_FINDING =
    "verify plan-review-light: a UI check drives this review; leave the plan as it is, do not resubmit it, and stop";
const LIGHT_GOAL =
    "verify plan-review-light: a UI check drives this run; do nothing, make no file changes, submit no plan, and stop";
const LIGHT_TASKS = 3;
const LIGHT_TITLE = "Light review";
const LIGHT_DISPATCH_WAIT_MS = 30000;

export const planReviewLight = {
    name: "plan-review-light",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-plan-review-light-"));
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            // the lead the failed round launches works in cwd, so it reads this copy rather than the repo's fixture
            ctx.planPath = join(cwd, "plan.md");
            writeFileSync(ctx.planPath, readFileSync(MODELS_PLAN));
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-plan-review-light", projectpath: cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: LIGHT_GOAL,
                runtime: "claude",
                model: "haiku",
                mode: "orchestrator",
                deferstart: true,
                // owned here, so the profile cannot make the light reviewer's verdict need picks
                reviewerpicks: false,
                reviewerroute: HAIKU_ROUTE,
                lightreviewerroute: HAIKU_ROUTE,
                parallelism: 1,
            });
            ctx.runId = created.run.id;
            await h.rpc(
                "dagsubmit",
                { channelid: ctx.channelId, runid: ctx.runId, parallelism: 1, planpath: ctx.planPath },
                MODELS_RPC
            );
            await recordPlanReviewRound(h, ctx, 1, { light: { verdict: "fail", notes: LIGHT_FINDING } });
            ctx.graph = await openRunGraph(h, ctx, LIGHT_TASKS);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. the light reviewer recorded its fail", false, ctx.arrangeError);
            return steps;
        }
        rec(`0. the run's graph opened with its ${LIGHT_TASKS} tasks`, ctx.graph.ok, JSON.stringify({ runId: ctx.runId, ...ctx.graph }));
        if (!ctx.graph.ok) return steps;

        await polishWaitFor(h, `${PLAN_REVIEWER_CHIPS}.filter((c) => c.state === 'failed').length === 1`, 5000);
        const chips = await h.ev(PLAN_REVIEWER_CHIPS);
        await h.shot("cdp-shots/plan-review-light-1-chip.png");
        rec(
            `1. the graph shows one plan reviewer chip, titled ${LIGHT_TITLE}`,
            chips.length === 1 && chips[0].lens === "light" && chips[0].state === "failed" && chips[0].line.includes(LIGHT_TITLE),
            JSON.stringify(chips)
        );

        const reviewed = await h.ev(railGroupExpr("Plan reviewed"));
        await h.shot("cdp-shots/plan-review-light-2-plan-reviewed.png");
        rec(
            `2. the timeline's Plan reviewed row lists one reviewer, ${LIGHT_TITLE} · failed`,
            reviewed.found && reviewed.reviewers.length === 1 && reviewed.reviewers[0].text === `${LIGHT_TITLE} · failed`,
            JSON.stringify(reviewed)
        );

        await h.goto("agent");
        const tree = await h.ev(planReviewTreeRows(1));
        await h.shot("cdp-shots/plan-review-light-3-tree.png");
        rec(
            `3. the agent tree's plan reviewer row reads ${PLAN_REVIEW_TITLE}${LIGHT_TITLE}`,
            tree.rows.length === 1 && tree.rows[0].title === `${PLAN_REVIEW_TITLE}${LIGHT_TITLE}`,
            tree.rows.length === 0
                ? `no plan-reviewer rows in the tree: the run's reviewer tab was reaped or never joined the roster (${JSON.stringify(tree)})`
                : JSON.stringify(tree)
        );

        // the same plan again: on the fast track the resubmit after a light fail dispatches with no second round
        let resubmitted = "ok";
        try {
            await h.rpc(
                "dagsubmit",
                { channelid: ctx.channelId, runid: ctx.runId, parallelism: 1, planpath: ctx.planPath },
                MODELS_RPC
            );
        } catch (e) {
            resubmitted = String(e?.message ?? e);
        }
        let g = null;
        const dispatched = () => g?.status !== "plan-review" && !!(g?.tasks ?? []).find((t) => t.id === "t-1")?.runid;
        for (let waited = 0; waited < LIGHT_DISPATCH_WAIT_MS && !dispatched(); waited += 1000) {
            g = (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
            if (!dispatched()) await polishNap(1000);
        }
        const graph2 = await openRunGraph(h, ctx, LIGHT_TASKS);
        await h.shot("cdp-shots/plan-review-light-4-dispatched.png");
        const t1 = (g?.tasks ?? []).find((t) => t.id === "t-1");
        rec(
            "4. after the resubmit the dag leaves plan-review and t-1 dispatches",
            resubmitted === "ok" && dispatched() && g?.planreview?.state === "accepted" && g?.planreview?.amended === true && graph2.ok,
            JSON.stringify({ resubmitted, status: g?.status, planreview: { state: g?.planreview?.state, amended: g?.planreview?.amended, round: g?.planreview?.round }, t1: t1 && { state: t1.state, runid: t1.runid ?? "" }, graph: graph2.ok })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await h.cdp("Emulation.clearDeviceMetricsOverride").catch((e) => {
            console.error(`plan-review-light teardown: clear the viewport override failed: ${e?.message ?? e}`);
        });
        await teardownFixtureRun(h, ctx, "plan-review-light");
    },
};

const PRR_WAITS = "waits on plan review";
// a confirm on the modal stack, above the DAG modal: its own dialog, not the modal's panel
// the cancel button also carries its "esc" key hint
const PRR_KEEP = `[...(d?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim().startsWith("Keep running"))`;
const PRR_CONFIRM = `[...document.querySelectorAll('[role="dialog"]')].find((d) => !d.closest("[data-dag-modal-kind]") && ${PRR_KEEP} != null)`;
const PRR_REVIEWERS = 5;
const PRR_EXTRA_LENSES = ["full", "second", "spec", "order", "tests"];
// the round's own reviewers kept, with their runs, so teardown's cancel still stops them; others added up to five
function prrFiveReviewers(dag) {
    const kept = dag.planreview?.reviewers ?? [];
    const extra = PRR_EXTRA_LENSES.filter((lens) => !kept.some((r) => r.lens === lens))
        .slice(0, Math.max(0, PRR_REVIEWERS - kept.length))
        .map((lens) => ({ lens, state: "passed", text: "verify plan-review-rounds" }));
    return { ...dag, planreview: { ...dag.planreview, reviewers: [...kept, ...extra] } };
}
const prrGroup = async (h, ctx) => (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group;
const PRR_CARDS = `[...(${RV_MODAL}?.querySelectorAll("[data-dag-node]:not([data-dag-node='final'])") ?? [])]`;

// F19 and F15 at 1600x950, while round 2's follow-up reviewer is still reviewing
async function planReviewInFlight(h, ctx, rec) {
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_WIDE);
    const g = await prrGroup(h, ctx);
    const pending = (g?.tasks ?? []).filter((t) => t.state === "pending" || t.state === "ready").map((t) => t.id);
    const facts = await h.ev(
        `${PRR_CARDS}.map((n) => ({ id: n.getAttribute("data-dag-node"), fact: ${rvFact("n")} }))`
    );
    const pendingFacts = facts.filter((f) => pending.includes(f.id));
    await h.shot("cdp-shots/plan-review-rounds-f19-facts.png");
    rec(
        "7. F19: while the dag is in plan review, every pending card's fact reads waits on plan review",
        g?.status === "plan-review" &&
            pending.length > 0 &&
            pendingFacts.length === pending.length &&
            pendingFacts.every((f) => f.fact === PRR_WAITS),
        JSON.stringify({ status: g?.status, pending, facts })
    );

    const before = g?.status;
    await h.ev(`${RV_MODAL}?.querySelector("[data-dag-cancel]")?.click()`);
    const asked = await polishWaitFor(h, `!!${PRR_CONFIRM}`, 3000);
    const message = await h.ev(`(${PRR_CONFIRM}?.textContent ?? "").replace(/\\s+/g, " ").trim()`);
    await h.shot("cdp-shots/plan-review-rounds-f15-confirm.png");
    await h.ev(`((d) => ${PRR_KEEP})(${PRR_CONFIRM})?.click()`);
    const dismissed = await polishWaitFor(h, `!${PRR_CONFIRM}`, 3000);
    // a cancel that went through anyway would land within this
    await polishNap(1500);
    const after = (await prrGroup(h, ctx))?.status;
    rec(
        "8. F15: the graph header's Cancel, with the plan reviewer in flight, asks first, and Keep running leaves the dag as it was",
        asked && message.includes("Stop 1 running worker") && dismissed && after === before && after === "plan-review",
        JSON.stringify({ asked, message, dismissed, before, after })
    );
}

// F10, F11, F12 and F24 at 1600x950, once the review is over: the dag cancelled with every task skipped and no
// Final stage, then given five plan reviewers. Each task keeps its run, so teardown's cancel still stops a worker.
async function planReviewEnded(h, ctx, rec) {
    await h.cdp("Emulation.setDeviceMetricsOverride", RV_WIDE);
    const g = await prrGroup(h, ctx);
    ctx.dagId = g?.oid ?? g?.id;
    const n = g?.tasks?.length ?? 0;
    let seeded = "ok";
    let nudge = null;
    try {
        nudge = await seedDag(
            h,
            ctx,
            (dag) => {
                const { final: _final, ...rest } = dag;
                return { ...rest, status: "cancelled", tasks: dag.tasks.map((t) => ({ ...t, state: "skipped" })) };
            },
            (dag) => `${dag?.status}|${dag?.final ? "final" : ""}|${(dag?.tasks ?? []).map((t) => t.state).join(",")}`
        );
    } catch (e) {
        seeded = String(e?.message ?? e);
    }
    const graph = (await h.ev(`!!${RV_MODAL}`)) ? { ok: true } : await openRunGraph(h, ctx, FULL_PLAN_TASKS);
    const skippedShown = `(${RV_MODAL}?.querySelector("[data-dag-progress]")?.textContent ?? "").includes("skipped")`;
    for (let i = 0; i < 5 && !(await polishWaitFor(h, skippedShown, 2000)); i++) {
        if (nudge) await nudge().catch(() => {});
    }
    const ended = await h.ev(`(() => {
        const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
        return {
            progress: flat(${RV_MODAL}?.querySelector("[data-dag-progress]")),
            final: flat(${RV_MODAL}?.querySelector('[data-dag-node="final"]')),
            byYou: [...(${RV_MODAL}?.querySelectorAll("[data-dag-node]") ?? [])].filter((c) => flat(c).includes("by you")).map((c) => c.getAttribute("data-dag-node")),
            facts: ${PRR_CARDS}.map((c) => ({ id: c.getAttribute("data-dag-node"), fact: ${rvFact("c")} })),
        };
    })()`);
    await h.shot("cdp-shots/plan-review-rounds-f10-cancelled.png");
    rec(
        "9. F10, F11, F12: cancelled with every task skipped and no Final stage: the header reads 0/n done · n skipped, the Final node did not run · run cancelled, and every card's fact is run cancelled with no by you",
        seeded === "ok" &&
            graph.ok &&
            n > 0 &&
            ended.progress.includes(`0/${n} done · ${n} skipped`) &&
            ended.final.includes("did not run · run cancelled") &&
            ended.byYou.length === 0 &&
            ended.facts.length === n &&
            ended.facts.every((f) => f.fact === "run cancelled"),
        JSON.stringify({ seeded, graph: graph.ok, n, ...ended })
    );

    let five = "ok";
    try {
        await seedDag(h, ctx, prrFiveReviewers, (dag) => (dag?.planreview?.reviewers ?? []).map((r) => r.lens).join(","));
    } catch (e) {
        five = String(e?.message ?? e);
    }
    await polishWaitFor(h, `${RV_MODAL}?.querySelectorAll("[data-plan-reviewer]").length === ${PRR_REVIEWERS}`, 10000);
    const lines = await h.ev(
        `[...(${RV_MODAL}?.querySelectorAll("[data-dag-stage-entry], [data-plan-reviewer]") ?? [])].map((el) => ({
            key: el.getAttribute("data-dag-stage-entry") ?? el.getAttribute("data-plan-reviewer"),
            rects: el.getClientRects().length,
        }))`
    );
    await h.shot("cdp-shots/plan-review-rounds-f24-stage-line.png");
    rec(
        "10. F24: with five plan reviewers, the stage line's entry and each reviewer sit on one line apiece",
        five === "ok" && lines.length === PRR_REVIEWERS + 1 && lines.every((l) => l.rects === 1),
        JSON.stringify({ five, lines })
    );
}
