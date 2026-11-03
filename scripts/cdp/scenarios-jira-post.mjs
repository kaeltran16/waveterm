// jira-post: Post progress to Jira from the open plan (Task 9 of docs/superpowers/plans/2026-11-03-jira-integration.md;
// boards PostToJira and RunSheetPosted, motion moment 4). A ticketed initiative with chunk 1 done, against the fake
// Jira in jira-fixtures.mjs: the dialog opens on the greyed code draft, the drafted summaries cross-fade over it, Post
// keeps its width as Posting…, the footer line and the chunk tag fade in, a failed move keeps the comment and says
// so, and a later draft no longer reports what a post already did.
import {
    connectFakeJira,
    motionSamples,
    seedTicketedInitiative,
    startFakeJira,
    withReducedMotion,
} from "./jira-fixtures.mjs";
import { holdRpc, lookEval, releaseRpc } from "./scenarios-shared.mjs";

const KEY = "PAY-318";
const TITLE = "verify jira-post: Retry webhook delivery when the partner returns 429";
const CHUNK_1 = "Retry with backoff";
const CHUNK_2 = "Give up after 6 attempts";
const CHUNK_3 = "Failed state on the partner dashboard";
const CHUNK_1_NOTE = "Deliveries that get a 429 are retried with exponential backoff, honouring Retry-After.";
const REVIEWER_REQUIRED = "Field 'Reviewer' is required for this transition.";
const IN_REVIEW_ID = "31";
const SUMMARIES = "JiraPostSummariesCommand";
const POST = "JiraPostCommand";
const REWRITTEN =
    "Progress: 1 of 3 parts done.\n\nDone\n- Retry with backoff. verify: the drafted summary, rewritten by the model.";
// the stub's reply lands after the dialog has drawn the code draft, so the crossfade has something to cross
const SUMMARIES_DELAY_MS = 500;
const FADE_MS = 1500;
const LOAD_MS = 15_000;

const DETAIL = `document.querySelector('[data-jarvis-initiative-detail="true"]')`;
const POST_BUTTON = `${DETAIL}?.querySelector('[data-jarvis-initiative-action="post-to-jira"]')`;
const DIALOG = `document.querySelector('[data-jira-post-dialog]')`;
const POSTED = `${DETAIL}?.querySelector('[data-jarvis-jira-posted]')`;
const chunkRow = (label) => `${DETAIL}?.querySelector('[data-jarvis-tracker-chunk=${JSON.stringify(label)}]')`;

const opacityBetween = (frames) => frames.some((f) => f.present && Number(f.opacity) > 0.05 && Number(f.opacity) < 0.95);
const landed = (frames) => {
    const last = frames.filter((f) => f.present).pop();
    return last != null && Number(last.opacity) === 1;
};

// the Brief row of the seeded initiative, expanded so its plan and footer draw
const openPlan = (h) =>
    lookEval(h, `
        const row = () => [...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].find((r) => flat(r).includes(${JSON.stringify(TITLE)}));
        if (!(await until(() => row() != null, ${LOAD_MS}))) return { ok: false, why: "no Brief row for the seeded initiative" };
        if (row().getAttribute("aria-expanded") !== "true") row().click();
        const ok = await until(() => ${DETAIL} != null && ${chunkRow(CHUNK_1)} != null, ${LOAD_MS});
        return { ok, post: ${POST_BUTTON} != null, postText: flat(${POST_BUTTON}) };
    `);

// opens the dialog and waits for the draft (the status line draws once JiraPostDraft answers)
const openDialog = (h) =>
    lookEval(h, `
        ${POST_BUTTON}?.click();
        const ok = await until(() => ${DIALOG}?.querySelector('[data-jira-post-status]') != null, ${LOAD_MS});
        return { ok, error: flat(${DIALOG}?.querySelector('[data-jira-post-result="draft-failed"]')) || null };
    `);

const closeDialog = (h) =>
    lookEval(h, `
        button(${DIALOG}, /^(Cancel|Close)$/)?.click();
        await until(() => ${DIALOG} == null, 3000);
        return ${DIALOG} == null;
    `);

const dialogState = (h) =>
    lookEval(h, `
        const d = ${DIALOG};
        const boxes = [...(d?.querySelectorAll('[data-jira-post-comment]') ?? [])];
        const box = boxes[boxes.length - 1];
        const submit = d?.querySelector('[data-jira-post-submit]');
        const visible = [...(submit?.querySelectorAll('span span') ?? [])].find((s) => !s.classList.contains('invisible'));
        return {
            open: d != null,
            title: flat(d?.querySelector('h2')),
            status: flat(d?.querySelector('[data-jira-post-status]')),
            greyed: box?.dataset.jiraPostComment ?? null,
            drafting: flat(d?.querySelector('[data-jira-post-drafting]')) || null,
            text: box?.value ?? null,
            moves: [...(d?.querySelectorAll('[role="radio"]') ?? [])].map((b) => flat(b)),
            picked: flat(d?.querySelector('[role="radio"][aria-checked="true"]')),
            sentence: flat(d?.querySelector('[data-jira-post-sentence]')),
            label: flat(visible),
            width: submit ? Math.round(submit.getBoundingClientRect().width * 10) / 10 : null,
            disabled: submit?.disabled ?? null,
            result: d?.querySelector('[data-jira-post-result]')?.dataset.jiraPostResult ?? null,
            resultText: flat(d?.querySelector('[data-jira-post-result]')),
            buttons: [...(d?.querySelectorAll('button') ?? [])].map((b) => flat(b)),
        };
    `);

const pickMove = (h, label) =>
    lookEval(h, `
        ${DIALOG}?.querySelector('[data-jira-move=${JSON.stringify(label)}]')?.click();
        await nap(150);
        return true;
    `);

// the model's rewrite, stood in by the page: the held original goes back with releaseRpc
const stubSummaries = (h) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        (window.__heldRpc ??= {})[${JSON.stringify(SUMMARIES)}] ??= RpcApi[${JSON.stringify(SUMMARIES)}];
        RpcApi[${JSON.stringify(SUMMARIES)}] = async () => {
            await nap(${SUMMARIES_DELAY_MS});
            return { comment: ${JSON.stringify(REWRITTEN)}, rewritten: true };
        };
    `);

// holds the post until window.__releasePost(), which then makes the real call: holdRpc's never-answering promise
// would leave the dialog on Posting… for good, since the button stays disabled while a post is in flight
const gatePost = (h) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const real = ((window.__heldRpc ??= {})[${JSON.stringify(POST)}] ??= RpcApi[${JSON.stringify(POST)}]);
        RpcApi[${JSON.stringify(POST)}] = (...args) =>
            new Promise((resolve, reject) => {
                window.__releasePost = () => real(...args).then(resolve, reject);
            });
    `);

const chunkTags = (h) =>
    h.ev(`(() => Object.fromEntries(${JSON.stringify([CHUNK_1, CHUNK_2, CHUNK_3])}.map((l) => [l, !!${DETAIL}?.querySelector('[data-jarvis-tracker-chunk=' + JSON.stringify(l) + '] [data-jarvis-chunk-posted]')])))()`);

export const jiraPost = {
    name: "jira-post",
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        try {
            ctx.fake = await startFakeJira();
            ctx.restoreJira = await connectFakeJira(h, ctx.fake);
            ctx.effortoid = await seedTicketedInitiative(h, {
                title: TITLE,
                key: KEY,
                chunks: [{ label: CHUNK_1, status: "done", note: CHUNK_1_NOTE }, CHUNK_2, CHUNK_3],
            });
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError) {
            return [{ step: "arrange: a ticketed initiative on the fake Jira", ok: false, detail: ctx.arrangeError }];
        }
        const steps = [];
        const fake = ctx.fake;
        await h.goto("jarvis");

        // 1. the footer offers post to Jira on an initiative with a ticket
        const plan = await openPlan(h);
        steps.push({
            step: "1. the open plan's footer offers post to Jira",
            ok: plan.ok && plan.post && plan.postText === "post to Jira",
            detail: JSON.stringify(plan),
        });

        // 2. the dialog opens on the code draft, greyed, while the summaries are drafted
        await holdRpc(h, SUMMARIES);
        const opened = await openDialog(h);
        const first = await dialogState(h);
        steps.push({
            step: "2. the dialog opens on the greyed code draft with Drafting summaries…, Leave as is first",
            ok:
                opened.ok &&
                first.title === `Post progress to ${KEY}` &&
                first.status === "Currently To Do in Jira. Last posted: never." &&
                first.greyed === "drafting" &&
                first.drafting === "Drafting summaries…" &&
                /\nDone\n- Retry with backoff\b/.test(first.text ?? "") &&
                first.moves[0] === "Leave as is" &&
                first.picked === "Leave as is" &&
                first.sentence === "Posts the comment; the ticket stays To Do." &&
                first.label === "Post comment",
            detail: JSON.stringify({ opened, ...first }),
        });
        await h.shot("cdp-shots/jira-post-dialog.png");
        await closeDialog(h);
        await releaseRpc(h, SUMMARIES);

        // 3. the drafted summaries cross-fade over the code draft
        await stubSummaries(h);
        const cross = await motionSamples(h, {
            selector: '[data-jira-post-dialog] [data-jira-post-comment="ready"]',
            props: ["opacity"],
            ms: FADE_MS * 2,
            trigger: `document.querySelector('[data-jarvis-initiative-detail="true"] [data-jarvis-initiative-action="post-to-jira"]')?.click()`,
        });
        const swapped = await dialogState(h);
        steps.push({
            step: "3. the drafted summaries cross-fade over the code draft",
            ok: opacityBetween(cross) && landed(cross) && swapped.text === REWRITTEN && swapped.drafting == null,
            detail: JSON.stringify({ frames: cross.length, between: cross.filter((f) => f.present).map((f) => f.opacity), text: swapped.text }),
        });

        // 4. a move turns the sentence and the button; Posting… keeps the button's width
        await pickMove(h, "In Progress");
        const moving = await dialogState(h);
        await gatePost(h);
        await h.ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))`);
        await h.ev("new Promise((r) => setTimeout(r, 200))");
        const posting = await dialogState(h);
        steps.push({
            step: "4. In Progress reads Post and move; ctrl+⏎ shows Posting… at the same width",
            ok:
                moving.sentence === "Posts the comment, then moves To Do to In Progress." &&
                moving.label === "Post and move" &&
                posting.label === "Posting…" &&
                posting.disabled === true &&
                moving.width != null &&
                Math.abs(posting.width - moving.width) < 0.6,
            detail: JSON.stringify({ moving: [moving.sentence, moving.label, moving.width], posting: [posting.label, posting.width] }),
        });

        // 5. the post lands: the dialog closes, Jira has the comment and the move, the footer line fades in
        const footerFade = await motionSamples(h, {
            selector: '[data-jarvis-initiative-detail="true"] [data-jarvis-jira-posted]',
            props: ["opacity"],
            ms: FADE_MS * 2,
            trigger: "window.__releasePost()",
        });
        await releaseRpc(h, POST);
        const after = await lookEval(h, `
            await until(() => ${DIALOG} == null && ${chunkRow(CHUNK_1)}?.querySelector('[data-jarvis-chunk-posted]') != null, ${LOAD_MS});
            return { dialog: ${DIALOG} != null, footer: flat(${POSTED}) };
        `);
        const tags = await chunkTags(h);
        steps.push({
            step: "5. the dialog closes, Jira has one comment and the move, and Posted … moved to In Progress fades in",
            ok:
                !after.dialog &&
                fake.state.comments.length === 1 &&
                fake.state.issues[KEY].status === "In Progress" &&
                /^Posted .+ ago, moved to In Progress$/.test(after.footer) &&
                opacityBetween(footerFade) &&
                landed(footerFade) &&
                tags[CHUNK_1] === true &&
                tags[CHUNK_2] === false,
            detail: JSON.stringify({
                ...after,
                comments: fake.state.comments.length,
                status: fake.state.issues[KEY].status,
                fade: footerFade.filter((f) => f.present).map((f) => f.opacity),
                tags,
            }),
        });
        await h.shot("cdp-shots/jira-post-footer.png");
        await releaseRpc(h, SUMMARIES);

        // 6. a refused move keeps the comment, says Jira's message and the real status, and offers Jira
        await h.rpc("effortmutate", {
            effortoid: ctx.effortoid,
            author: "you",
            ops: [{ op: "setChunkStatus", chunk: CHUNK_2, status: "done", note: "Gives up after 6 attempts." }],
        });
        fake.state.failTransition[IN_REVIEW_ID] = REVIEWER_REQUIRED;
        await holdRpc(h, SUMMARIES);
        await lookEval(h, `await until(() => ${chunkRow(CHUNK_2)}?.querySelector('[data-jarvis-chunk-status="done"]') != null, ${LOAD_MS});`);
        const second = await openDialog(h);
        const secondDraft = await dialogState(h);
        await pickMove(h, "In Review");
        await lookEval(h, `
            ${DIALOG}?.querySelector('[data-jira-post-submit]')?.click();
            await until(() => ${DIALOG}?.querySelector('[data-jira-post-result="move-failed"]') != null, ${LOAD_MS});
        `);
        const failed = await dialogState(h);
        steps.push({
            step: "6. a refused move: Comment posted, Couldn't move it to In Review, Jira's message, Move it in Jira ↗",
            ok:
                second.ok &&
                /- Give up after 6 attempts/.test(secondDraft.text ?? "") &&
                !/Retry with backoff/.test(secondDraft.text ?? "") &&
                failed.result === "move-failed" &&
                failed.resultText.includes("Comment posted.") &&
                failed.resultText.includes("Couldn't move it to In Review, so it is still In Progress.") &&
                failed.resultText.includes(`Jira: ${REVIEWER_REQUIRED}`) &&
                failed.buttons.includes("Move it in Jira ↗") &&
                failed.buttons.includes("Close") &&
                fake.state.comments.length === 2 &&
                fake.state.issues[KEY].status === "In Progress",
            detail: JSON.stringify({ second, secondDraft: secondDraft.text, result: failed.result, text: failed.resultText, buttons: failed.buttons, comments: fake.state.comments.length }),
        });
        await h.shot("cdp-shots/jira-post-move-failed.png");
        await closeDialog(h);
        await openDialog(h);
        const third = await dialogState(h);
        steps.push({
            step: "6b. the next draft reports neither posted chunk as done",
            ok: third.text != null && !/Retry with backoff/.test(third.text) && !/Give up after 6 attempts/.test(third.text),
            detail: JSON.stringify({ text: third.text }),
        });

        // 7. under reduced motion the footer line still lands
        const reduced = await withReducedMotion(h, () =>
            motionSamples(h, {
                selector: '[data-jarvis-initiative-detail="true"] [data-jarvis-jira-posted]',
                props: ["opacity"],
                ms: FADE_MS * 2,
                trigger: `document.querySelector('[data-jira-post-dialog] [data-jira-post-submit]')?.click()`,
            })
        );
        const reducedAfter = await lookEval(h, `
            await until(() => ${DIALOG} == null, ${LOAD_MS});
            return { dialog: ${DIALOG} != null, footer: flat(${POSTED}) };
        `);
        steps.push({
            step: "7. under reduced motion the Posted line still lands",
            ok: !reducedAfter.dialog && landed(reduced) && /^Posted .+ ago$/.test(reducedAfter.footer) && fake.state.comments.length === 3,
            detail: JSON.stringify({ ...reducedAfter, last: reduced.filter((f) => f.present).pop() ?? null, comments: fake.state.comments.length }),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await releaseRpc(h, SUMMARIES).catch(() => {});
        await releaseRpc(h, POST).catch(() => {});
        await h.ev(`document.querySelector('[data-jira-post-dialog]') && window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`).catch(() => {});
        // the seed can throw after the create landed (the show refused), so the initiative is found by its title
        const efforts = (await h.rpc("effortlist", { includearchived: true }).catch(() => null))?.efforts ?? [];
        for (const e of efforts.filter((x) => x.title === TITLE)) {
            await h.rpc("effortdelete", { effortoid: e.oref.replace(/^effort:/, "") }).catch((err) => {
                console.error(`jira-post teardown: delete the initiative failed: ${err?.message ?? err}`);
            });
        }
        await ctx.restoreJira?.().catch((e) => console.error(`jira-post teardown: restore Jira settings failed: ${e?.message ?? e}`));
        await ctx.fake?.close();
        await h.goto("cockpit");
    },
};
