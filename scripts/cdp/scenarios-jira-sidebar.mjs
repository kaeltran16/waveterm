// jira-sidebar: the ticket in the chunk sidebar, the run sheet and the activity feed (Task 10 of
// docs/superpowers/plans/2026-11-03-jira-integration.md, boards ChunkSidebar and RunSheetPosted, run half). A done chunk
// that went out in a progress post carries a note "In a post to PAY-318" with a link to the comment; the sidebar's
// breadcrumb ends with the key as a link; a run on the chunk leads its initiative line with the key and offers no
// posting; and the initiative's own "Posted progress to PAY-318." note in the activity feed links to the comment too.
// The dev app talks to the fake Jira in jira-fixtures.mjs through the real Go client.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectFakeJira, seedTicketedInitiative, startFakeJira } from "./jira-fixtures.mjs";
import { arrangeFixtureRun, polishNap, polishReload, polishWaitFor, teardownFixtureRun } from "./scenarios-shared.mjs";

const KEY = "PAY-318";
const PROJECT = "payments-api";
const TITLE = "verify jira-sidebar · Retry webhook delivery";
const STAGE = "Build";
const CHUNK = "Retry with backoff";
const CHUNKS = [{ label: CHUNK, status: "done" }, { label: "Give up after 6 attempts" }];
const POST_COMMENT = "Progress: 1 of 2 parts done.\n\nDone\n- Retry with backoff.";

const row = `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => r.innerText.includes(${JSON.stringify(TITLE)}))`;
const SIDEBAR = `document.querySelector('[data-jarvis-chunk-sidebar]')`;
const EFFORT_SHEET = `document.querySelector('[data-jarvis-brief-sheet="effort"]')`;
const CHUNK_ROW = `[...document.querySelectorAll('[data-jarvis-tracker-chunk]')].find((c) => c.getAttribute('data-jarvis-tracker-chunk') === ${JSON.stringify(CHUNK)})`;
const OPEN_ROW = `(() => { const r = ${row}; const t = [...(r?.querySelectorAll('span') ?? [])].find((s) => s.title?.startsWith(${JSON.stringify(TITLE)})); (t ?? r)?.click(); return !!r; })()`;
const RUN_SHEET = `document.querySelector('[data-run-sheet]')`;

const oidOf = (summary) => summary.oref.replace(/^effort:/, "");

// the initiative's plan open and the chunk selected, whatever the Brief was showing before
async function openChunk(h) {
    if (await h.ev(`!!${SIDEBAR}`)) return true;
    if (!(await h.ev(`!!${CHUNK_ROW}`))) {
        await h.ev(OPEN_ROW);
        if (!(await polishWaitFor(h, `!!${CHUNK_ROW}`, 8000))) return false;
    }
    await h.ev(`${CHUNK_ROW}?.click()`);
    return polishWaitFor(h, `!!${SIDEBAR}`, 5000);
}

export const jiraSidebar = {
    name: "jira-sidebar",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { oids: [], cwd: mkdtempSync(join(tmpdir(), "verify-jira-sidebar-")) };
        try {
            // a run that died before its teardown leaves its initiative behind; it would match the row lookup
            for (const e of (await h.rpc("effortlist", { includearchived: true }))?.efforts ?? []) {
                if (e.title === TITLE) await h.rpc("effortdelete", { effortoid: oidOf(e) }).catch(() => {});
            }
            ctx.fake = await startFakeJira();
            ctx.restore = await connectFakeJira(h, ctx.fake);
            ctx.effortoid = await seedTicketedInitiative(h, { title: TITLE, project: PROJECT, key: KEY, chunks: CHUNKS });
            ctx.oids.push(ctx.effortoid);
            await h.rpc("effortmutate", {
                effortoid: ctx.effortoid,
                author: "you",
                ops: CHUNKS.map((c) => ({ op: "setChunkStage", chunk: c.label, stage: STAGE })),
            });
            // the post the sidebar and the feed read back: the real Go path writes the notes and the comment url
            ctx.post = await h.rpc("jirapost", { effortoid: ctx.effortoid, comment: POST_COMMENT, donechunks: [CHUNK] });
            // a held run on the chunk, for the run sheet's initiative line
            await arrangeFixtureRun(h, ctx, "jira-sidebar", undefined, undefined, {
                effortoid: ctx.effortoid,
                chunklabel: CHUNK,
            });
            await polishReload(h);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null || ctx.post?.commenturl == null) {
            rec("0. the ticketed initiative, its post and its run were made", false, ctx.arrangeError ?? "no post");
            return steps;
        }
        const comment = ctx.post.commenturl;
        await h.goto("jarvis");
        if (!(await polishWaitFor(h, `!!${row}`, 8000))) await polishReload(h);
        if (!(await polishWaitFor(h, `!!${row}`, 15000))) {
            rec("0. the initiative shows on the Brief", false, ctx.effortoid);
            return steps;
        }

        // 1. the sidebar: the crumb ends with the key as a link, and the post note links to its comment
        const up = await openChunk(h);
        await polishNap(450);
        const side = await h.ev(`(() => {
            const s = ${SIDEBAR};
            const crumb = s?.querySelector('[data-jarvis-ticket-link]');
            const card = [...(s?.querySelectorAll('[data-jarvis-note-card]') ?? [])].find((c) => c.innerText.includes('In a post to'));
            const link = card?.querySelector('[data-jarvis-jira-comment-link]');
            return {
                crumb: crumb?.innerText.trim() ?? null,
                crumbHref: crumb?.getAttribute('href') ?? null,
                crumbLast: !!crumb && crumb.nextElementSibling == null,
                note: card?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
                link: link?.innerText.trim() ?? null,
                linkHref: link?.getAttribute('href') ?? null,
            };
        })()`);
        await h.shot("cdp-shots/jira-sidebar-1-sidebar.png");
        rec(
            `1. the crumb ends "${KEY} ↗" linking to ${ctx.fake.url}/browse/${KEY}, and the post note reads "In a post to ${KEY} · you · <time>" with "View comment ↗" to the comment`,
            up &&
                side.crumb === `${KEY} ↗` &&
                side.crumbHref === `${ctx.fake.url}/browse/${KEY}` &&
                side.crumbLast &&
                /^In a post to PAY-318 you (\d{2}:\d{2}|\d{2}-\d{2})/.test(side.note ?? "") &&
                side.link === "View comment ↗" &&
                side.linkHref === comment,
            JSON.stringify({ up, side, comment })
        );

        // 2. a run on the chunk: its sheet's initiative line leads with the key, and nothing there posts to Jira
        const opened = await h.ev(`window.__openAddress(${JSON.stringify(`run:${ctx.runId}`)})`).catch((e) => String(e));
        const lineUp = await polishWaitFor(h, `!!document.querySelector('[data-run-sheet-effort-line]')`, 8000);
        await polishNap(450);
        const sheet = await h.ev(`(() => {
            const line = document.querySelector('[data-run-sheet-effort-line]');
            const key = line?.querySelector('[data-jarvis-ticket-link]');
            return {
                line: line?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
                keyHref: key?.getAttribute('href') ?? null,
                posts: /post to Jira/i.test(${RUN_SHEET}?.innerText ?? ''),
            };
        })()`);
        await h.shot("cdp-shots/jira-sidebar-2-run-sheet.png");
        rec(
            `2. the run sheet's initiative line starts "${KEY} ·" with the key linking to Jira, and the sheet has no "post to Jira"`,
            lineUp &&
                (sheet.line ?? "").startsWith(`${KEY} · ${TITLE} · ${STAGE} · ${CHUNK}`) &&
                sheet.keyHref === `${ctx.fake.url}/browse/${KEY}` &&
                !sheet.posts,
            JSON.stringify({ opened, lineUp, sheet })
        );

        // 3. the activity feed: the initiative's own post note links to the comment, with the move in its text
        await polishReload(h);
        await polishWaitFor(h, `!!${row}`, 15000);
        const reopened = await openChunk(h);
        await h.ev(
            `[...(${SIDEBAR}?.querySelectorAll('button') ?? [])].find((b) => /^activity/i.test(b.innerText.trim()))?.click()`
        );
        const sheetUp = await polishWaitFor(h, `!!${EFFORT_SHEET}?.querySelector('[data-jarvis-effort-note]')`, 8000);
        await polishNap(450);
        const feed = await h.ev(`(() => {
            const note = [...(${EFFORT_SHEET}?.querySelectorAll('[data-jarvis-effort-note]') ?? [])].find((n) => n.innerText.includes('Posted progress to ${KEY}.'));
            const link = note?.parentElement?.querySelector('[data-jarvis-jira-comment-link]');
            return { note: note?.innerText.replace(/\\s+/g, ' ').trim() ?? null, link: link?.innerText.trim() ?? null, href: link?.getAttribute('href') ?? null };
        })()`);
        await h.shot("cdp-shots/jira-sidebar-3-activity.png");
        rec(
            `3. the activity view lists "Posted progress to ${KEY}." with "View comment ↗" to the comment`,
            reopened && sheetUp && feed.note != null && feed.link === "View comment ↗" && feed.href === comment,
            JSON.stringify({ reopened, sheetUp, feed, comment })
        );
        return steps;
    },
    async teardown(h, ctx) {
        for (const effortoid of ctx.oids ?? []) {
            await h.rpc("effortdelete", { effortoid }).catch(() => {});
        }
        await ctx.restore?.().catch(() => {});
        await ctx.fake?.close();
        await teardownFixtureRun(h, ctx, "jira-sidebar");
        await h.goto("cockpit");
    },
};
