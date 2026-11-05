// Code surface review fixes: code-handoff. The path bar's and the review bar's popovers (F3), Blame outside the
// source editor (F8), the review list and Copy review keeping the review (F13), and the absolute path a
// reference hands over (F24). The repo is opened by path, outside the registry, so no agent matches it and both
// senders take their clipboard path; sending to a live agent is pinned by codereviewstore.test.ts.
import { codeEval, makeCodeRepo, openFileInCode, openFolderInCode, removeCodeRepo } from "./scenarios-code-kit.mjs";
import { polishWaitFor } from "./scenarios-shared.mjs";

const SOURCE = "src/x.py";
const README = "README.md";
const SEND = `document.querySelector('[data-code-send-to-agent]')`;
const SEND_LINE = `document.querySelector('[data-code-send-line]')`;
const REVIEW_SEND = `document.querySelector('[data-code-review-send]')`;
const REVIEW_PICKER = `${REVIEW_SEND}?.parentElement?.querySelector('[data-code-agent-picker-empty]')`;
const REVIEW_COUNT = `document.querySelector('[data-code-review-count]')`;
const REVIEW_LIST = `document.querySelector('[data-code-review-list]')`;
const BLAME_TOGGLE = `document.querySelector('[data-code-blame-toggle]')`;
const ESCAPE = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))`;
const ALT_SHIFT_M = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', code: 'KeyM', altKey: true, shiftKey: true, bubbles: true, cancelable: true }))`;

// a real click at the top-left of the code surface: it lands on the backdrop when one is up
async function clickOutside(h) {
    const pt = await h.ev(`(() => {
        const b = document.querySelector('[data-code-tree]')?.getBoundingClientRect();
        return b ? { x: b.left + 20, y: b.bottom - 20 } : { x: 40, y: 400 };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
        await h.cdp("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    }
}

// both ways out of a popover: an outside click, then Esc after reopening it
async function closesBothWays(h, open, shown) {
    await h.ev(open);
    const first = (await polishWaitFor(h, `!!(${shown})`, 3000)) === true;
    await clickOutside(h);
    const byClick = (await polishWaitFor(h, `!(${shown})`, 3000)) === true;
    await h.ev(open);
    const second = (await polishWaitFor(h, `!!(${shown})`, 3000)) === true;
    await h.ev(ESCAPE);
    const byEsc = (await polishWaitFor(h, `!(${shown})`, 3000)) === true;
    return { first, byClick, second, byEsc, ok: first && byClick && second && byEsc };
}

// the open project's comments, set through the app's store; the inline input is code-review's to check
function seedComments(h, comments) {
    return codeEval(
        h,
        `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { codeProjectAtom } = await mod("app/view/code/codestore.ts");
        const { codeReviewsAtom } = await mod("app/view/code/codereviewstore.ts");
        const key = globalStore.get(codeProjectAtom)?.path;
        if (key == null) return false;
        globalStore.set(codeReviewsAtom, (r) => new Map(r).set(key, ${JSON.stringify(comments)}));
        return true;
    `
    );
}

export const codeHandoff = {
    name: "code-handoff",
    surface: "code",
    async arrange() {
        const lines = Array.from({ length: 20 }, (_, i) => `value_${i + 1} = ${i + 1}`).join("\n") + "\n";
        const readme = ["# Handoff", "", "First paragraph.", "", "Second paragraph."].join("\n") + "\n";
        try {
            return { dir: makeCodeRepo({ [SOURCE]: lines, [README]: readme }) };
        } catch (e) {
            return { arrangeError: String(e?.message ?? e) };
        }
    },
    async assert(h, ctx) {
        if (ctx.arrangeError) return [{ step: "code-handoff: arrange the temp repo", ok: false, detail: ctx.arrangeError }];
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step: `code-handoff: ${step}`, ok, detail });

        const loaded = await openFolderInCode(h, ctx.dir);
        const opened = loaded && (await openFileInCode(h, SOURCE));
        rec("open the temp repo and src/x.py", opened === true, `loaded=${loaded} opened=${opened}`);
        if (!opened) return steps;

        const sendShown = `!!${SEND_LINE}`;
        const send = await closesBothWays(h, `${SEND}?.click()`, sendShown);
        await h.shot("cdp-shots/code-handoff-send-closed.png");
        rec("Send to agent closes on an outside click and on Esc", send.ok, JSON.stringify(send));

        const seeded = await seedComments(h, [
            { id: "h1", path: SOURCE, startLine: 3, endLine: 3, anchor: "value_3 = 3", note: "three" },
            { id: "h2", path: SOURCE, startLine: 12, endLine: 14, anchor: "value_12 = 12", note: "twelve to fourteen" },
        ]);
        const counted = await polishWaitFor(h, `${REVIEW_COUNT}?.getAttribute('data-code-review-count') === "2"`, 3000);
        const review = await closesBothWays(h, `${REVIEW_SEND}?.click()`, REVIEW_PICKER);
        await h.shot("cdp-shots/code-handoff-review-closed.png");
        rec("Send review closes on an outside click and on Esc", seeded && counted && review.ok, JSON.stringify({ seeded, counted, ...review }));

        await h.ev(ALT_SHIFT_M);
        const openedByKey = (await polishWaitFor(h, `!!(${REVIEW_PICKER})`, 3000)) === true;
        await h.goto("cockpit");
        await h.goto("code");
        await polishWaitFor(h, `!!${REVIEW_COUNT}`, 5000);
        await new Promise((r) => setTimeout(r, 400));
        const stillOpen = await h.ev(`!!(${REVIEW_PICKER})`);
        await h.shot("cdp-shots/code-handoff-review-after-return.png");
        rec("Send review is closed after leaving Code and coming back", openedByKey && stillOpen === false, JSON.stringify({ openedByKey, stillOpen }));

        const readme = await openFileInCode(h, README);
        const preview = await codeEval(
            h,
            `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { codeViewModeAtom } = await mod("app/view/code/codestore.ts");
            const { codeBlameOnAtom } = await mod("app/view/code/codeblamestore.ts");
            globalStore.set(codeViewModeAtom, "preview");
            globalStore.set(codeBlameOnAtom, true);
            await nap(300);
            return { pressed: ${BLAME_TOGGLE}?.getAttribute("aria-pressed"), column: !!document.querySelector("[data-code-blame-column]") };
        `
        );
        await h.shot("cdp-shots/code-handoff-blame-preview.png");
        await h.ev(`${BLAME_TOGGLE}?.click()`);
        const shown = await polishWaitFor(
            h,
            `${BLAME_TOGGLE}?.getAttribute("aria-pressed") === "true" && !!document.querySelector("[data-code-blame-column]") && !!document.querySelector(".monaco-editor .view-line")`,
            8000
        );
        const mode = await codeEval(
            h,
            `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { codeViewModeAtom } = await mod("app/view/code/codestore.ts");
            return globalStore.get(codeViewModeAtom);
        `
        );
        await h.shot("cdp-shots/code-handoff-blame-source.png");
        rec(
            "Blame in markdown Preview is not pressed, and a click shows Source with the blame column",
            readme === true && preview?.pressed === "false" && preview?.column === false && shown === true && mode === "source",
            JSON.stringify({ readme, preview, shown, mode })
        );
        await codeEval(
            h,
            `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { codeBlameOnAtom } = await mod("app/view/code/codeblamestore.ts");
            globalStore.set(codeBlameOnAtom, false);
        `
        );

        await h.ev(`${REVIEW_COUNT}?.click()`);
        const rows = `[...(${REVIEW_LIST}?.querySelectorAll('[data-code-review-row]') ?? [])].map((r) => r.getAttribute('data-code-review-row'))`;
        const listed = (await polishWaitFor(h, `${rows}.length === 2`, 3000)) === true;
        const before = await h.ev(rows);
        await h.shot("cdp-shots/code-handoff-review-list.png");
        await h.ev(`${REVIEW_LIST}?.querySelector('[aria-label="Delete comment"]')?.click()`);
        const left = (await polishWaitFor(h, `${rows}.length === 1 && ${REVIEW_COUNT}?.getAttribute('data-code-review-count') === "1"`, 3000)) === true;
        const after = await h.ev(rows);
        await h.shot("cdp-shots/code-handoff-review-list-deleted.png");
        rec(
            "the review list shows two comments and deleting one leaves one",
            listed && left && before?.[0] === `${SOURCE}:L3` && before?.[1] === `${SOURCE}:L12-L14` && after?.[0] === `${SOURCE}:L12-L14`,
            JSON.stringify({ before, after })
        );
        await h.ev(ESCAPE);
        await polishWaitFor(h, `!${REVIEW_LIST}`, 3000);

        // the clipboard is stubbed: a CDP session does not give the page the focus a real write needs
        const STUB = `const clip = navigator.clipboard; let wrote = null;
            Object.defineProperty(clip, 'writeText', { configurable: true, value: (t) => { wrote = t; return Promise.resolve(); } });`;
        await h.ev(`${REVIEW_SEND}?.click()`);
        await polishWaitFor(h, `!!(${REVIEW_PICKER})`, 3000);
        const copied = await h.ev(`(async () => {
            ${STUB}
            (${REVIEW_PICKER})?.click();
            for (let i = 0; i < 20 && wrote == null; i++) await new Promise((r) => setTimeout(r, 50));
            await new Promise((r) => setTimeout(r, 150));
            delete clip.writeText;
            return { wrote, label: ${REVIEW_SEND}?.textContent?.trim(), count: ${REVIEW_COUNT}?.getAttribute('data-code-review-count') ?? null };
        })()`);
        await h.shot("cdp-shots/code-handoff-review-copied.png");
        rec(
            "Copy review keeps the count and shows Copied",
            copied?.count === "1" && copied?.label === "Copied" && /Checkout: /.test(copied?.wrote ?? "") && /L12-L14/.test(copied?.wrote ?? ""),
            JSON.stringify(copied)
        );

        await openFileInCode(h, SOURCE);
        await h.ev(`${SEND}?.click()`);
        await polishWaitFor(h, sendShown, 3000);
        const reference = await h.ev(`(async () => {
            const composed = ${SEND_LINE}?.textContent ?? null;
            ${STUB}
            ${SEND}?.parentElement?.querySelector('[data-code-agent-picker-empty]')?.click();
            for (let i = 0; i < 20 && wrote == null; i++) await new Promise((r) => setTimeout(r, 50));
            delete clip.writeText;
            return { composed, wrote };
        })()`);
        await h.shot("cdp-shots/code-handoff-copy-reference.png");
        const abs = await codeEval(
            h,
            `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { codeProjectAtom } = await mod("app/view/code/codestore.ts");
            const { joinRepoPath } = await mod("util/paths.ts");
            return joinRepoPath(globalStore.get(codeProjectAtom).path, ${JSON.stringify(SOURCE)});
        `
        );
        rec(
            "Copy reference puts the absolute path on the clipboard",
            typeof abs === "string" && reference?.wrote === `look at ${abs}` && reference?.composed === reference?.wrote,
            JSON.stringify({ abs, ...reference })
        );
        return steps;
    },
    async teardown(h, ctx) {
        // reviews persist: a temp checkout's comments must not outlive it
        await codeEval(
            h,
            `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { codeReviewsAtom } = await mod("app/view/code/codereviewstore.ts");
            const tmp = ${JSON.stringify(ctx?.dir ?? "")}.replace(/\\\\/g, "/").toLowerCase();
            globalStore.set(codeReviewsAtom, (r) => new Map([...r].filter(([k]) => tmp === "" || k.replace(/\\\\/g, "/").toLowerCase() !== tmp)));
        `
        ).catch(() => {});
        await h.goto("cockpit");
        if (ctx?.dir) removeCodeRepo(ctx.dir);
    },
};
