// Code surface review fixes: code-editor. The editor's "Add review comment" menu item and the view zone that keeps
// the comment input off the code (F13), Alt+M from markdown Preview, and the image and binary states (F22).
import { crc32, deflateSync } from "node:zlib";
import { codeEval, makeCodeRepo, openFileInCode, openFolderInCode, removeCodeRepo } from "./scenarios-code-kit.mjs";
import { polishWaitFor } from "./scenarios-shared.mjs";

const SOURCE = "src/x.py";
const README = "README.md";
const IMAGE = "assets/logo.png";
const BINARY = "assets/blob.bin";
const COMMENTED = 5;
// no spaces: Monaco draws them as non-breaking ones, which a textContent match would miss
const sourceLine = (n) => `value_${n}=${n}`;

const INPUT = `document.querySelector('[data-code-comment-input]')`;
const ALT_M = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', altKey: true, bubbles: true, cancelable: true }))`;
// Monaco draws its context menu inside a shadow root, so the item is looked for there as well
const MENU_ITEM = `(() => {
    const roots = [document, ...[...document.querySelectorAll('.shadow-root-host')].map((h) => h.shadowRoot).filter(Boolean)];
    return roots.flatMap((r) => [...r.querySelectorAll('.monaco-menu .action-item')]).find((i) => i.textContent.includes('Add review comment')) ?? null;
})()`;

// a w x h RGB gradient as a PNG, so the shot shows the image filling a visible area
function gradientPng(w, h) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolor
    const rows = [];
    for (let y = 0; y < h; y++) {
        const row = Buffer.alloc(1 + w * 3);
        for (let x = 0; x < w; x++) {
            row[1 + x * 3] = Math.round((x / w) * 255);
            row[2 + x * 3] = Math.round((y / h) * 255);
            row[3 + x * 3] = 160;
        }
        rows.push(row);
    }
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

async function mouse(h, x, y, button) {
    for (const type of ["mousePressed", "mouseReleased"]) {
        await h.cdp("Input.dispatchMouseEvent", { type, x, y, button, clickCount: 1 });
    }
}

// the middle of a rendered source line, or null while it is not drawn
function linePoint(h, n) {
    return h.ev(`(() => {
        const line = [...document.querySelectorAll(".monaco-editor .view-line")].find((l) => l.textContent.replace(/00a0/g, " ").trim() === ${JSON.stringify(sourceLine(n))});
        const b = line?.getBoundingClientRect();
        return b ? { x: b.left + 30, y: b.top + b.height / 2 } : null;
    })()`);
}

async function cancelInput(h) {
    await h.ev(`${INPUT}?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))`);
    return (await polishWaitFor(h, `!${INPUT}`, 3000)) === true;
}

export const codeEditor = {
    name: "code-editor",
    surface: "code",
    async arrange() {
        const source = Array.from({ length: 20 }, (_, i) => sourceLine(i + 1)).join("\n") + "\n";
        const readme = ["# Editor", "", "First paragraph.", "", "Second paragraph."].join("\n") + "\n";
        const blob = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe, 0x00, 0x10]);
        try {
            return { dir: makeCodeRepo({ [SOURCE]: source, [README]: readme, [IMAGE]: gradientPng(2400, 1600), [BINARY]: blob }) };
        } catch (e) {
            return { arrangeError: String(e?.message ?? e) };
        }
    },
    async assert(h, ctx) {
        if (ctx.arrangeError) return [{ step: "code-editor: arrange the temp repo", ok: false, detail: ctx.arrangeError }];
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step: `code-editor: ${step}`, ok, detail });

        const loaded = await openFolderInCode(h, ctx.dir);
        const opened = loaded && (await openFileInCode(h, SOURCE)) && (await polishWaitFor(h, `!!document.querySelector('.monaco-editor .view-line')`, 8000));
        rec("open the temp repo and src/x.py", opened === true, `loaded=${loaded} opened=${opened}`);
        if (!opened) return steps;

        // a right click on the line moves the caret there, as Monaco does for a click outside the selection
        const at = await linePoint(h, COMMENTED);
        if (at != null) await mouse(h, at.x, at.y, "right");
        const listed = (await polishWaitFor(h, `!!${MENU_ITEM}`, 3000)) === true;
        await h.shot("cdp-shots/code-editor-context-menu.png");
        const item = await h.ev(`(() => { const b = ${MENU_ITEM}?.getBoundingClientRect(); return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; })()`);
        if (item != null) await mouse(h, item.x, item.y, "left");
        const shown = (await polishWaitFor(h, `!!${INPUT}`, 3000)) === true;
        const label = await h.ev(`${INPUT}?.getAttribute('aria-label') ?? null`);
        await h.shot("cdp-shots/code-editor-context-comment.png");
        rec(
            "the context menu lists Add review comment and it opens the comment input",
            listed && shown && label === `Comment on line ${COMMENTED}`,
            JSON.stringify({ at, listed, item, shown, label })
        );

        // the zone under the commented line pushes the next line below the input
        await new Promise((r) => setTimeout(r, 300));
        const room = await h.ev(`(() => {
            const box = ${INPUT}?.parentElement?.getBoundingClientRect();
            const next = [...document.querySelectorAll(".monaco-editor .view-line")].find((l) => l.textContent.replace(/00a0/g, " ").trim() === ${JSON.stringify(sourceLine(COMMENTED + 1))});
            const top = next?.getBoundingClientRect().top;
            return box && top != null ? { inputTop: box.top, inputBottom: box.bottom, nextTop: top } : null;
        })()`);
        await h.shot("cdp-shots/code-editor-comment-room.png");
        rec(
            "with the input open, the commented line's next line sits below the input",
            room != null && room.nextTop >= room.inputBottom,
            JSON.stringify(room)
        );
        const closed = await cancelInput(h);
        const after = await h.ev(`(() => {
            const lines = [...document.querySelectorAll(".monaco-editor .view-line")];
            const a = lines.find((l) => l.textContent.replace(/00a0/g, " ").trim() === ${JSON.stringify(sourceLine(COMMENTED))})?.getBoundingClientRect();
            const b = lines.find((l) => l.textContent.replace(/00a0/g, " ").trim() === ${JSON.stringify(sourceLine(COMMENTED + 1))})?.getBoundingClientRect();
            return a && b ? b.top - a.bottom : null;
        })()`);
        rec("Escape closes the input and its gap", closed && after != null && Math.abs(after) < 1, JSON.stringify({ closed, gap: after }));

        const readme = await openFileInCode(h, README);
        const preview = await codeEval(
            h,
            `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { codeViewModeAtom } = await mod("app/view/code/codestore.ts");
            globalStore.set(codeViewModeAtom, "preview");
            return until(() => document.querySelector(".monaco-editor") == null, 3000);
        `
        );
        await h.shot("cdp-shots/code-editor-preview.png");
        await h.ev(ALT_M);
        const fromPreview = (await polishWaitFor(h, `!!${INPUT} && !!document.querySelector('.monaco-editor .view-line')`, 8000)) === true;
        const mode = await codeEval(
            h,
            `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { codeViewModeAtom } = await mod("app/view/code/codestore.ts");
            return globalStore.get(codeViewModeAtom);
        `
        );
        await h.shot("cdp-shots/code-editor-preview-alt-m.png");
        rec(
            "Alt+M in markdown Preview switches to Source and opens the comment input",
            readme === true && preview === true && fromPreview && mode === "source",
            JSON.stringify({ readme, preview, fromPreview, mode })
        );
        await cancelInput(h);

        const image = await openFileInCode(h, IMAGE);
        const IMG = `document.querySelector('[data-code-image] img')`;
        const drawn = (await polishWaitFor(h, `${IMG}?.complete && ${IMG}.naturalWidth > 0`, 8000)) === true;
        // larger than the pane, so it shows scaled down to fit inside it
        const size = await h.ev(`(() => {
            const i = ${IMG};
            const b = i?.getBoundingClientRect();
            const pane = document.querySelector('[data-code-image]')?.getBoundingClientRect();
            const inside = !!b && !!pane && b.left >= pane.left && b.right <= pane.right && b.top >= pane.top && b.bottom <= pane.bottom;
            return i ? { natural: i.naturalWidth, shown: Math.round(b.width), inside, src: i.src.slice(0, 5) } : null;
        })()`);
        await h.shot("cdp-shots/code-editor-image.png");
        rec(
            "a PNG renders as an img with natural width > 0, fit to the pane",
            image === true && drawn && size?.src === "blob:" && size.inside && size.shown < size.natural,
            JSON.stringify({ image, drawn, size })
        );

        const binary = await openFileInCode(h, BINARY);
        const COPY = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Copy path'))`;
        const offered = (await polishWaitFor(h, `!!${COPY} && document.body.textContent.includes('Binary file')`, 5000)) === true;
        // the clipboard is stubbed: a CDP session does not give the page the focus a real write needs
        const wrote = await h.ev(`(async () => {
            const clip = navigator.clipboard; let wrote = null;
            Object.defineProperty(clip, 'writeText', { configurable: true, value: (t) => { wrote = t; return Promise.resolve(); } });
            ${COPY}?.click();
            await new Promise((r) => setTimeout(r, 100));
            delete clip.writeText;
            return wrote;
        })()`);
        await h.shot("cdp-shots/code-editor-binary.png");
        const abs = await codeEval(
            h,
            `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { codeProjectAtom } = await mod("app/view/code/codestore.ts");
            const { joinRepoPath } = await mod("util/paths.ts");
            return joinRepoPath(globalStore.get(codeProjectAtom).path, ${JSON.stringify(BINARY)});
        `
        );
        rec("a binary file offers Copy path", binary === true && offered && wrote === abs, JSON.stringify({ binary, offered, wrote, abs }));
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit");
        if (ctx?.dir) removeCodeRepo(ctx.dir);
    },
};
