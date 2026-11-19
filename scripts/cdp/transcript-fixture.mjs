// The transcript-* scenarios' harness: one NarrationTimeline over fixture entries, mounted through the dev-only
// window.__narrationFeedFixture seam (frontend/app/view/agents/narrationfeedfixture.tsx), which seeds the wsh data
// cache and run events and hands the timeline a TranscriptContext holding the live cockpit model.

import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEAM_POLLS = 25;
const SEAM_POLL_MS = 200;
const CLEAR_POLLS = 25;
const CLEAR_POLL_MS = 100;
const SHOW_POLLS = 50;
const SHOW_POLL_MS = 100;
// the modal's open motion and the rows' fade-in settle before a step reads styles
const SETTLE_MS = 900;

export const ROOT = "[data-narration-fixture]";
const rootExpr = `document.querySelector(${JSON.stringify(ROOT)})`;

// whether the seam is up, polling while the app finishes loading
export async function waitSeam(h) {
    for (let i = 0; i < SEAM_POLLS; i++) {
        if (await h.ev(`typeof window.__narrationFeedFixture === 'object'`)) return true;
        await sleep(SEAM_POLL_MS);
    }
    return false;
}

export async function clearTranscript(h) {
    await h.ev(`window.__narrationFeedFixture?.clear()`);
    // the modal's key is stable, so a show during the exit motion would revive the old feed
    for (let i = 0; i < CLEAR_POLLS && (await h.ev(`${rootExpr} != null`)); i++) await sleep(CLEAR_POLL_MS);
}

// opts: ctx (without model), compact, active, renderers, seed (wshdata keys), runEvents (by run id)
export async function showTranscript(h, { entries, width, ...opts }) {
    await clearTranscript(h);
    await h.ev(`window.__narrationFeedFixture.show(${JSON.stringify(entries)}, ${width}, ${JSON.stringify(opts)})`);
    // a cold first mount can outlast the settle: wait for the root before it
    for (let i = 0; i < SHOW_POLLS && !(await h.ev(`${rootExpr} != null`)); i++) await sleep(SHOW_POLL_MS);
    await sleep(SETTLE_MS);
}

// a finished turn's work sits behind its "Worked for" line: open every closed one, and let the reveal settle. Returns
// how many it opened.
const FOLD_MOTION_MS = 600;
export async function openFolds(h) {
    const opened = await h.ev(`(() => {
        const folds = [...(${rootExpr}?.querySelectorAll('[data-fold][aria-expanded="false"]') ?? [])];
        folds.forEach((f) => f.click());
        return folds.length;
    })()`);
    await sleep(FOLD_MOTION_MS);
    return opened;
}

// the census's two hosts: the rendered view (a card's width, thoughts and renderers drawn) and the compact row
export const HOSTS = {
    rendered: { width: 736, renderers: true, thoughts: true, accentLatest: true },
    compact: { width: 360, compact: true, accentLatest: true },
};

// one transcript at a host; extra rides over the host's props (seed, ctx, nowLine...)
export function showAt(h, host, entries, extra = {}) {
    return showTranscript(h, { entries, ...host, ...extra });
}

// the dev server serves any file under the workspace as /@fs/<absolute path>: resolved from this script's location, so
// the tree under test projects, not whichever checkout the app was started from
const treeModule = (file) =>
    `/@fs/${fileURLToPath(new URL(`../../frontend/app/view/agents/${file}`, import.meta.url)).replaceAll("\\", "/")}`;
const PROJECTION_MODULE = treeModule("transcriptprojection.ts");
const PI_PROJECTION_MODULE = treeModule("pitranscriptprojection.ts");

// the tree's own projectTranscript over raw jsonl lines (strings), run in the page: the projected AgentEntry[]
export function projectInPage(h, lines) {
    return h.ev(
        `import(${JSON.stringify(PROJECTION_MODULE)}).then((m) => m.projectTranscript(${JSON.stringify(lines)}))`
    );
}

// the same over a pi v3 transcript, through the tree's own projectPiTranscript
export function projectPiInPage(h, lines) {
    return h.ev(
        `import(${JSON.stringify(PI_PROJECTION_MODULE)}).then((m) => m.projectPiTranscript(${JSON.stringify(lines)}))`
    );
}

export const user = (text, ts) => ({ kind: "user", text, ts });

export const prose = (text, ts) => ({ kind: "message", text, ts });

// a Bash call as Claude's projection records it: the description is the target when there is one, and a pending
// call has no result yet. command and ts ride on the action for the layout that reads them.
export function bash({ description, command, output = "", exit = 0, ts, durationMs, pending = false }) {
    const action = { kind: "action", verb: "ran", target: description || command, command, ts };
    if (pending) {
        return { ...action, pending: true, startedTs: ts };
    }
    return {
        ...action,
        outcome: exit === 0 ? "ok" : "fail",
        durationMs,
        detail: { kind: "bash", command, output, exit },
    };
}

export const tool = (verb, target, extra = {}) => ({ kind: "action", verb, target, outcome: "ok", ...extra });
