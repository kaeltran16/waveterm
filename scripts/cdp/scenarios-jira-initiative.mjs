// jira-initiative: the ticket on the initiative (Task 8 of docs/superpowers/plans/2026-11-03-jira-integration.md, board
// Initiative, motion moments 1 and 5). A ticketed initiative's Brief row draws its key as a link to Jira, and its open
// plan carries the ticket bar: compact, expanding to the description and acceptance criteria on paneReveal (instant
// under reduced motion), and a refresh whose new status chip colour transitions. The dev app talks to the fake Jira in
// jira-fixtures.mjs through the real Go client.
import {
    connectFakeJira,
    motionSamples,
    PAY_318_CRITERIA,
    PAY_318_DESCRIPTION,
    seedTicketedInitiative,
    startFakeJira,
    withReducedMotion,
} from "./jira-fixtures.mjs";
import { polishNap, polishReload, polishWaitFor } from "./scenarios-shared.mjs";

const KEY = "PAY-318";
const PROJECT = "payments-api";
const TITLE = "Retry webhook delivery when the partner returns 429";
const PLAIN_TITLE = "verify jira-initiative · no ticket";
const STAGE = "Build";
const CHUNKS = [
    { label: "Retry with backoff", status: "done" },
    { label: "Give up after 6 attempts", status: "active" },
    { label: "Failed state on the partner dashboard" },
];
const REVEAL_MS = 700;
const REFRESH_MS = 2500;
const PX_TOLERANCE = 0.5;

const row = (title) =>
    `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => r.innerText.includes(${JSON.stringify(title)}))`;
const card = (title) => `${row(title)}?.parentElement`;
const BAR = `${card(TITLE)}?.querySelector('[data-jarvis-ticket-bar]')`;
const BAR_SEL = "[data-jarvis-ticket-bar]";
const CHEVRON_CLICK = `document.querySelector('${BAR_SEL} [data-jarvis-ticket-chevron]').click()`;
const openRow = (title) =>
    `(() => { const r = ${row(title)}; const t = [...(r?.querySelectorAll('span') ?? [])].find((s) => s.title?.startsWith(${JSON.stringify(title)})); (t ?? r)?.click(); return !!r; })()`;

const px = (v) => (v == null || v === "" || v === "auto" ? NaN : parseFloat(v));
const deg = (frame) => {
    const r = frame.rotate;
    if (r != null && r !== "" && r !== "none") return parseFloat(r);
    const m = /matrix\(([^,]+),\s*([^,]+)/.exec(frame.transform ?? "");
    return m ? Math.round((Math.atan2(parseFloat(m[2]), parseFloat(m[1])) * 180) / Math.PI) : 0;
};

async function efforts(h) {
    return (await h.rpc("effortlist", { includearchived: true }))?.efforts ?? [];
}

const oidOf = (summary) => summary.oref.replace(/^effort:/, "");

export const jiraInitiative = {
    name: "jira-initiative",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { oids: [] };
        try {
            // a run that died before its teardown leaves its initiatives behind; they would match the row lookups
            for (const e of await efforts(h)) {
                if (e.title === TITLE || e.title === PLAIN_TITLE) {
                    await h.rpc("effortdelete", { effortoid: oidOf(e) }).catch(() => {});
                }
            }
            ctx.fake = await startFakeJira();
            ctx.restore = await connectFakeJira(h, ctx.fake);
            try {
                ctx.ticketed = await seedTicketedInitiative(h, { title: TITLE, project: PROJECT, key: KEY, chunks: CHUNKS });
            } catch (e) {
                // the show failed after the create: keep the initiative so the row step still runs, and say why
                ctx.seedError = String(e?.message ?? e);
                ctx.ticketed = (await efforts(h)).map((s) => (s.title === TITLE ? oidOf(s) : null)).find(Boolean);
            }
            if (ctx.ticketed != null) {
                ctx.oids.push(ctx.ticketed);
                await h.rpc("effortmutate", {
                    effortoid: ctx.ticketed,
                    author: "you",
                    ops: CHUNKS.map((c) => ({ op: "setChunkStage", chunk: c.label, stage: STAGE })),
                });
            }
            const plain = await h.rpc("effortcreate", { title: PLAIN_TITLE, project: PROJECT, chunks: [{ label: "One" }] });
            ctx.plain = plain.effortoid;
            ctx.oids.push(ctx.plain);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null || ctx.ticketed == null) {
            rec("0. the ticketed and the plain initiative were made", false, ctx.arrangeError ?? ctx.seedError ?? "no initiative");
            return steps;
        }
        await h.goto("jarvis");
        const both = `!!${row(TITLE)} && !!${row(PLAIN_TITLE)}`;
        if (!(await polishWaitFor(h, both, 8000))) await polishReload(h);
        if (!(await polishWaitFor(h, both, 15000))) {
            rec("0. both initiatives show on the Brief", false, JSON.stringify({ ticketed: ctx.ticketed, plain: ctx.plain }));
            return steps;
        }

        // 1. the row's meta keeps "PAY-318 · payments-api", the key a link to Jira, and the title opens the plan
        const meta = await h.ev(`(() => {
            const m = ${row(TITLE)}?.querySelector('[data-jarvis-brief-meta]');
            const a = m?.querySelector('a');
            return { text: m?.innerText.trim() ?? null, tag: a?.tagName ?? null, href: a?.getAttribute('href') ?? null, key: a?.innerText ?? null };
        })()`);
        await h.ev(openRow(TITLE));
        const opened = await polishWaitFor(h, `!!${BAR}`, 8000);
        await polishNap(450);
        await h.shot("cdp-shots/jira-initiative-1-row.png");
        const href = `${ctx.fake.url}/browse/${KEY}`;
        rec(
            `1. the row's meta reads "${KEY} · ${PROJECT}", ${KEY} links to ${href}, and the title opens the plan`,
            meta.text === `${KEY} · ${PROJECT}` && meta.tag === "A" && meta.key === KEY && meta.href === href && opened,
            JSON.stringify({ meta, opened })
        );
        if (ctx.seedError != null) {
            rec("1b. the ticket's last-seen copy landed (jirashow)", false, ctx.seedError);
            return steps;
        }

        // 2. the compact bar: key, type, status chip, the first line, and the seen stamp with its why
        const folded = await h.ev(`(() => {
            const b = ${BAR};
            if (!b) return null;
            const q = (s) => b.querySelector(s);
            return {
                state: b.getAttribute('data-jarvis-ticket-bar'),
                key: q('[data-jarvis-ticket-link]')?.innerText.trim() ?? null,
                type: q('[data-jarvis-ticket-type]')?.innerText.trim() ?? null,
                status: q('[data-jarvis-ticket-status]')?.innerText.trim() ?? null,
                tone: q('[data-jarvis-ticket-status]')?.getAttribute('data-jarvis-ticket-status') ?? null,
                first: q('[data-jarvis-ticket-first]')?.textContent.trim() ?? null,
                seen: q('[data-jarvis-ticket-seen]')?.innerText.trim() ?? null,
                seenTitle: q('[data-jarvis-ticket-seen]')?.getAttribute('title') ?? null,
                body: !!q('[data-jarvis-ticket-body]'),
            };
        })()`);
        await h.shot("cdp-shots/jira-initiative-2-folded.png");
        rec(
            "2. the folded bar draws the key, Story, a To Do chip, the description's first line and the seen stamp",
            folded != null &&
                folded.state === "folded" &&
                folded.key === KEY &&
                folded.type === "Story" &&
                folded.status === "To Do" &&
                folded.tone === "todo" &&
                folded.first === PAY_318_DESCRIPTION &&
                /^seen .+ ago$/.test(folded.seen ?? "") &&
                /^Arc last saw this ticket .+, when an agent ran wsh jira show$/.test(folded.seenTitle ?? "") &&
                !folded.body,
            JSON.stringify(folded)
        );

        // 3. the chevron expands it: height and opacity pass through between-values, and the chevron turns 0 -> 90
        const [chevronFrames, bodyFrames] = await Promise.all([
            motionSamples(h, { selector: `${BAR_SEL} [data-jarvis-ticket-chevron] svg`, props: ["rotate", "transform"], ms: REVEAL_MS, trigger: "" }),
            motionSamples(h, { selector: `${BAR_SEL} [data-jarvis-ticket-body]`, props: ["height", "opacity"], ms: REVEAL_MS, trigger: CHEVRON_CLICK }),
        ]);
        const present = bodyFrames.filter((f) => f.present);
        const full = present.length > 0 ? px(present[present.length - 1].height) : NaN;
        const midHeight = present.some((f) => px(f.height) > PX_TOLERANCE && px(f.height) < full - PX_TOLERANCE);
        const midOpacity = present.some((f) => parseFloat(f.opacity) > 0.01 && parseFloat(f.opacity) < 0.99);
        const turns = chevronFrames.filter((f) => f.present).map(deg);
        const turned = turns.length > 0 && turns[0] === 0 && turns.at(-1) === 90 && turns.some((d) => d > 0 && d < 90);
        const expanded = await h.ev(`(() => {
            const b = ${BAR};
            return b ? {
                state: b.getAttribute('data-jarvis-ticket-bar'),
                description: b.querySelector('[data-jarvis-ticket-description]')?.innerText.trim() ?? null,
                heading: b.innerText.includes('Acceptance criteria'),
                criteria: [...b.querySelectorAll('[data-jarvis-ticket-criterion]')].map((c) => c.innerText.trim()),
            } : null;
        })()`);
        await h.shot("cdp-shots/jira-initiative-3-expanded.png");
        rec(
            "3. the chevron expands the bar on paneReveal (between-values of height and opacity, chevron 0 -> 90) to the description and three criteria",
            midHeight &&
                midOpacity &&
                turned &&
                full > 0 &&
                expanded?.state === "open" &&
                expanded.description === PAY_318_DESCRIPTION &&
                expanded.heading &&
                JSON.stringify(expanded.criteria) === JSON.stringify(PAY_318_CRITERIA),
            JSON.stringify({ midHeight, midOpacity, full, turns: turns.filter((_, i) => i % 4 === 0), frames: present.length, expanded })
        );

        // 4. folding under reduced motion jumps: no frame between the open height and none
        const reducedFrames = await withReducedMotion(h, () =>
            motionSamples(h, { selector: `${BAR_SEL} [data-jarvis-ticket-body]`, props: ["height"], ms: REVEAL_MS, trigger: CHEVRON_CLICK })
        );
        const between = reducedFrames.filter((f) => f.present && px(f.height) > PX_TOLERANCE && px(f.height) < full - PX_TOLERANCE);
        const foldedAgain = await h.ev(`${BAR}?.getAttribute('data-jarvis-ticket-bar') ?? null`);
        rec(
            "4. under prefers-reduced-motion the fold has no between-height frames",
            between.length === 0 && foldedAgain === "folded",
            JSON.stringify({ between: between.slice(0, 5), foldedAgain, full })
        );

        // 5. Jira moves the ticket to In Progress; refresh redraws the chip, whose colour transitions
        ctx.fake.state.issues[KEY].status = "In Progress";
        const callsBefore = ctx.fake.state.calls.length;
        const chipFrames = await motionSamples(h, {
            selector: `${BAR_SEL} [data-jarvis-ticket-status]`,
            props: ["background-color"],
            ms: REFRESH_MS,
            trigger: `document.querySelector('${BAR_SEL} [data-jarvis-ticket-refresh]').click()`,
        });
        await polishNap(300);
        const colours = chipFrames.filter((f) => f.present).map((f) => f["background-color"]);
        const [from, to] = [colours[0], colours.at(-1)];
        const midColour = colours.some((c) => c !== from && c !== to);
        const refreshed = await h.ev(`(() => {
            const b = ${BAR};
            const q = (s) => b?.querySelector(s);
            return b ? {
                status: q('[data-jarvis-ticket-status]')?.innerText.trim() ?? null,
                tone: q('[data-jarvis-ticket-status]')?.getAttribute('data-jarvis-ticket-status') ?? null,
                seenTitle: q('[data-jarvis-ticket-seen]')?.getAttribute('title') ?? null,
                refresh: q('[data-jarvis-ticket-refresh]')?.getAttribute('data-jarvis-ticket-refresh') ?? null,
                error: q('[data-jarvis-ticket-error]')?.innerText ?? null,
            } : null;
        })()`);
        await h.shot("cdp-shots/jira-initiative-5-refreshed.png");
        rec(
            "5. refresh reads In Progress from Jira, the chip's background passes a between-colour, and the seen stamp says you refreshed it",
            from !== to &&
                midColour &&
                refreshed?.status === "In Progress" &&
                refreshed.tone === "progress" &&
                /when you refreshed it$/.test(refreshed.seenTitle ?? "") &&
                refreshed.refresh === "idle" &&
                refreshed.error == null &&
                ctx.fake.state.calls.slice(callsBefore).some((c) => c === `GET /rest/api/3/issue/${KEY}`),
            JSON.stringify({ from, to, midColour, refreshed, calls: ctx.fake.state.calls.slice(callsBefore) })
        );

        // 6. an initiative with no ticket opens on its plan with no bar
        await h.ev(openRow(PLAIN_TITLE));
        const plainOpen = await polishWaitFor(h, `!!${card(PLAIN_TITLE)}?.querySelector('[data-jarvis-initiative-detail="true"]')`, 8000);
        await polishNap(450);
        const plainBar = await h.ev(`!!${card(PLAIN_TITLE)}?.querySelector('[data-jarvis-ticket-bar]')`);
        const plainMeta = await h.ev(`${row(PLAIN_TITLE)}?.querySelector('[data-jarvis-brief-meta]')?.innerHTML ?? null`);
        await h.shot("cdp-shots/jira-initiative-6-no-ticket.png");
        rec(
            "6. an initiative with no ticket shows no ticket bar and no link in its meta",
            plainOpen && !plainBar && plainMeta != null && !plainMeta.includes("<a"),
            JSON.stringify({ plainOpen, plainBar, plainMeta })
        );
        return steps;
    },
    async teardown(h, ctx) {
        for (const effortoid of ctx.oids ?? []) {
            await h.rpc("effortdelete", { effortoid }).catch(() => {});
        }
        await ctx.restore?.().catch(() => {});
        await ctx.fake?.close();
        await h.goto("cockpit");
    },
};
