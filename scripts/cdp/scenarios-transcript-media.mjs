// Scenario `transcript-media`: images in a transcript. An image Read's card draws thumbnails (imagethumbs.tsx) no
// taller than the thumbnail bound instead of the image at full size, and a click on one opens the zoom view
// (ImageZoom), which Escape closes. A user bubble draws its pasted image as a thumbnail in place of the "[Image #1]"
// placeholder, and Arc's trailing attachments block as thumbnails (image paths, read through wavesrv) and file chips (any
// other path, and an image that fails to load).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearTranscript, prose, ROOT, showTranscript, tool, user, waitSeam } from "./transcript-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
const S = 1000;
const WIDE = 736;
// ImageThumbs' THUMB_MAX_HEIGHT_PX, with a pixel of border slack
const THUMB_BOUND = 96;
// the generated image is well past the bound, so a card at full size would fail the check
const SOURCE_W = 600;
const SOURCE_H = 500;
const POLLS = 25;
const POLL_MS = 100;
const R = `document.querySelector(${JSON.stringify(ROOT)})`;

// a PNG drawn in the page, so the scenario ships no binary
const MAKE_PNG = `(() => {
    const c = document.createElement("canvas");
    c.width = ${SOURCE_W};
    c.height = ${SOURCE_H};
    const g = c.getContext("2d");
    g.fillStyle = "#3b5bdb";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#ffd43b";
    g.fillRect(50, 50, 200, 200);
    return c.toDataURL("image/png").split(",")[1];
})()`;

// a 24x24 PNG (a yellow square on blue) the attachment step writes to disk
const ATTACHED_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAKUlEQVR4nGOwjr5NFcQwatCAGvT/ijVBNGrQqEGjBlFuEHlo1CA6GgQAVAGWvgpgH7IAAAAASUVORK5CYII=";
const ATTACHED_PNG_W = 24;
const ATTACHMENTS_HEADER = "Attachments (read these files):";

const poll = async (h, expr) => {
    for (let i = 0; i < POLLS; i++) {
        if (await h.ev(expr)) return true;
        await sleep(POLL_MS);
    }
    return false;
};

const THUMBS_STATE = `(() => {
    const root = ${R};
    if (!root) return null;
    const card = root.querySelector('[data-tool-card="image"]');
    const thumbs = card ? [...card.querySelectorAll('[data-image-thumb]')] : [];
    const imgs = thumbs.map((t) => t.querySelector('img'));
    return {
        card: !!card,
        count: thumbs.length,
        heights: imgs.map((i) => Math.round(i.getBoundingClientRect().height)),
        natural: imgs.map((i) => i.naturalHeight),
    };
})()`;

export const transcriptMedia = {
    name: "transcript-media",
    surface: "cockpit",
    async arrange() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-transcript-media-"));
        const png = path.join(dir, "attached.png");
        const txt = path.join(dir, "notes.txt");
        fs.writeFileSync(png, Buffer.from(ATTACHED_PNG_B64, "base64"));
        fs.writeFileSync(txt, "notes\n");
        return { dir, png, txt, missing: path.join(dir, "missing.png") };
    },
    async assert(h, ctx) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;

        const data = await h.ev(MAKE_PNG);
        const image = { mediaType: "image/png", data };
        await showTranscript(h, {
            entries: [
                user("Look at the screenshot.", T0),
                tool("read", "shot.png", { ts: T0 + 2 * S, images: [image, image] }),
                prose("It shows a blue field with a yellow square.", T0 + 3 * S),
            ],
            width: WIDE,
            renderers: true,
        });
        const opened = await poll(h, `!!${R}?.querySelector('[data-tool-card="image"]')`);
        const state = await h.ev(THUMBS_STATE);
        await h.shot("cdp-shots/transcript-media-thumbs.png");
        steps.push({
            step: "thumbs: an image Read's card draws its images as thumbnails no taller than the bound, not at full size",
            ok:
                opened &&
                state != null &&
                state.count === 2 &&
                state.natural.every((n) => n === SOURCE_H) &&
                state.heights.every((px) => px > 0 && px <= THUMB_BOUND + 1),
            detail: JSON.stringify(state),
        });

        await h.ev(`${R}.querySelector('[data-tool-card="image"] [data-image-thumb]').click()`);
        const zoomed = await poll(h, `!!document.querySelector('[data-image-zoom]')`);
        const loaded = zoomed && (await poll(h, `(document.querySelector('[data-image-zoom-img]')?.naturalWidth ?? 0) === ${SOURCE_W}`));
        await h.shot("cdp-shots/transcript-media-zoom.png");
        steps.push({
            step: "zoom: clicking a thumbnail opens the zoom view on that image",
            ok: zoomed && loaded,
            detail: `zoomed=${zoomed} loaded=${loaded}`,
        });

        await h.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
        const closed = await poll(h, `!document.querySelector('[data-image-zoom]')`);
        steps.push({ step: "zoom: Escape closes the zoom view", ok: closed, detail: `closed=${closed}` });

        const attachText = ["Review these.", "", ATTACHMENTS_HEADER, `- ${ctx.png}`, `- ${ctx.txt}`, `- ${ctx.missing}`].join("\n");
        await showTranscript(h, {
            entries: [
                { kind: "user", text: "see [Image #1]", ts: T0, images: [image] },
                prose("A blue field with a yellow square.", T0 + 2 * S),
                user(attachText, T0 + 10 * S),
                prose("Read them.", T0 + 12 * S),
            ],
            width: WIDE,
        });
        const bubblesUp = await poll(h, `(${R}?.querySelectorAll('[data-user-bubble]').length ?? 0) === 2`);
        const pasted = await h.ev(`(() => {
            const b = ${R}?.querySelectorAll('[data-user-bubble]')[0];
            return b ? { text: b.innerText, thumbs: b.querySelectorAll('[data-image-thumb]').length } : null;
        })()`);
        steps.push({
            step: "bubble: a pasted image draws as a thumbnail in place of its [Image #1] placeholder",
            ok: bubblesUp && pasted != null && pasted.thumbs === 1 && !pasted.text.includes("[Image #1]") && pasted.text.includes("see"),
            detail: JSON.stringify(pasted),
        });

        await h.ev(`${R}.querySelectorAll('[data-user-bubble]')[0].querySelector('[data-image-thumb]')?.click()`);
        const bubbleZoom = await poll(h, `!!document.querySelector('[data-image-zoom]')`);
        const bubbleZoomLoaded = bubbleZoom && (await poll(h, `(document.querySelector('[data-image-zoom-img]')?.naturalWidth ?? 0) === ${SOURCE_W}`));
        await h.shot("cdp-shots/transcript-media-bubble-zoom.png");
        await h.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
        const bubbleZoomClosed = await poll(h, `!document.querySelector('[data-image-zoom]')`);
        steps.push({
            step: "bubble zoom: the pasted image's thumbnail opens the zoom view",
            ok: bubbleZoom && bubbleZoomLoaded && bubbleZoomClosed,
            detail: `zoomed=${bubbleZoom} loaded=${bubbleZoomLoaded} closed=${bubbleZoomClosed}`,
        });

        // the image path loads and the missing one falls back, each after its own fetch
        const ATTACH_STATE = `(() => {
            const b = ${R}?.querySelectorAll('[data-user-bubble]')[1];
            if (!b) return null;
            const imgs = [...b.querySelectorAll('[data-image-thumb] img')];
            return {
                text: b.innerText,
                loaded: imgs.map((i) => i.naturalWidth),
                chips: [...b.querySelectorAll('[data-file-chip]')].map((c) => ({ title: c.title, name: c.innerText.trim() })),
            };
        })()`;
        const settled = await poll(h, `(() => { const s = ${ATTACH_STATE}; return s != null && s.chips.length + s.loaded.length === 3 && s.loaded.every((w) => w > 0); })()`);
        const attach = await h.ev(ATTACH_STATE);
        await h.shot("cdp-shots/transcript-media-attachments.png");
        const chipFor = (p) => attach?.chips.some((c) => c.title === p && c.name === path.basename(p));
        steps.push({
            step: "attachments: the block draws as one loaded image thumbnail and two file chips (the .txt, the missing PNG), not as text",
            ok:
                settled &&
                attach != null &&
                !attach.text.includes(ATTACHMENTS_HEADER) &&
                attach.text.includes("Review these.") &&
                attach.loaded.length === 1 &&
                attach.loaded[0] === ATTACHED_PNG_W &&
                attach.chips.length === 2 &&
                chipFor(ctx.txt) &&
                chipFor(ctx.missing),
            detail: JSON.stringify(attach),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await clearTranscript(h);
        if (ctx?.dir) fs.rmSync(ctx.dir, { recursive: true, force: true });
    },
};
