// Scenario `transcript-media`: images in a transcript. An image Read's card draws thumbnails (imagethumbs.tsx) no
// taller than the thumbnail bound instead of the image at full size, and a click on one opens the zoom view
// (ImageZoom), which Escape closes.

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
        return {};
    },
    async assert(h) {
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
        return steps;
    },
    async teardown(h) {
        await clearTranscript(h);
    },
};
