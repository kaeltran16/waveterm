// Code surface review fixes: code-jumps. Jumps land on their line (spec "Jumps into Code"): a search hit and F12
// into another file land on the line, a hit deep in a markdown file scrolls Preview to its section, Back returns
// to the earlier line, a folder link selects the folder, and in-page and cross-file anchors reach their heading.
import { codeEval, makeCodeRepo, openFileInCode, openFolderInCode, removeCodeRepo } from "./scenarios-code-kit.mjs";

const shot = (h, name) => h.shot(`cdp-shots/code-jumps-${name}.png`);

const FAR_LINE = 150;
const DEF_LINE = 120;
// a reveal must still hold this long after it first shows: a fresh document's scroller can reset under it
const SETTLE_MS = 600;
const filler = (tag, n) => Array.from({ length: n }, (_, i) => [`${tag} paragraph ${i}.`, ""]).flat();

// 200 lines, with the definition and a search needle far below the fold
const B_TS = Array.from({ length: 200 }, (_, i) => {
    const line = i + 1;
    if (line === DEF_LINE) return "export function farThing(): number {";
    if (line === DEF_LINE + 1) return "    return 1;";
    if (line === DEF_LINE + 2) return "}";
    if (line === FAR_LINE) return "// NEEDLE_FAR marks this line";
    return `export const v${line} = ${line};`;
}).join("\n");

const USE_TS = 'import { farThing } from "./b";\n\nexport const used = farThing();\n';

// every section long enough that the next heading starts below the fold
const GUIDE_MD = [
    "# Guide",
    "",
    "[to the deep part](#deep-section)",
    "",
    "## Setup",
    "",
    ...filler("Setup", 40),
    "## Middle",
    "",
    ...filler("Middle", 40),
    "## Deep Section",
    "",
    "NEEDLE_DOC lives here.",
    "",
    ...filler("Deep", 40),
    "## Setup",
    "",
    ...filler("Again", 10),
].join("\n");

const README_MD = "# demo\n\n[docs folder](docs/)\n\n[guide deep](docs/guide.md#deep-section)\n";

// the page-side helpers every step reads the surface with
const LIB = `
    const S = await mod("app/store/jotaiStore.ts");
    const C = await mod("app/view/code/codestore.ts");
    const rows = () => [...document.querySelectorAll('[data-code-tree] [role="treeitem"]')];
    const row = (name) => rows().find((r) => r.querySelector("span.min-w-0")?.textContent === name) ?? null;
    const openPath = () => document.querySelector("[data-code-path]")?.getAttribute("data-code-path") ?? null;
    const caret = () => { const el = document.querySelector(".monaco-editor .active-line-number"); return el ? Number(el.textContent.trim()) : null; };
    const shownLines = () => [...document.querySelectorAll(".monaco-editor .line-numbers")].map((e) => Number(e.textContent.trim()));
    const fileIs = (rel) => S.globalStore.get(C.codeFileAtom)?.path === rel && S.globalStore.get(C.codeFileAtom)?.kind === "text";
    // the preview's scroller: the one holding the document's headings, not the first on the page
    const viewport = () => [...document.querySelectorAll("[data-overlayscrollbars-viewport]")].find((v) => v.querySelector(".heading") != null) ?? null;
    // the heading's offset below the path bar on screen: small once a jump scrolled to it
    const headingTop = (name) => {
        const el = [...(viewport()?.querySelectorAll(".heading") ?? [])].find((x) => flat(x) === name);
        const bar = document.querySelector("[data-code-path]");
        return el == null || bar == null ? null : Math.round(el.getBoundingClientRect().top - bar.getBoundingClientRect().bottom);
    };
    // which elements hold a scroll offset, for a failure detail
    const scrolled = () => { const out = []; for (let e = viewport(); e != null; e = e.parentElement) if (e.scrollTop > 0) out.push(e.tagName + "." + String(e.className).slice(0, 40) + "=" + e.scrollTop); return out; };
    const atTop = (name) => { const t = headingTop(name); return t != null && t >= 0 && t < 80; };
    const searchHit = async (needle, rel) => {
        await C.findReferences(needle);
        await until(() => document.querySelector("[data-code-search-row]") != null, 8000);
        document.querySelector("[data-code-search-row]")?.click();
        return until(() => fileIs(rel), 8000);
    };
`;
const pageEval = (h, body) => codeEval(h, `const SETTLE_MS = ${SETTLE_MS}; ${LIB} ${body}`);

// a real click on a word of a rendered line puts Monaco's caret there, as code-symbols does
async function clickWord(h, lineText, word) {
    const pt = await h.ev(`(() => {
        const line = [...document.querySelectorAll(".monaco-editor .view-line")].find((l) => l.textContent.replace(/\\u00a0/g, " ").includes(${JSON.stringify(lineText)}));
        if (!line) return null;
        const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const i = n.textContent.indexOf(${JSON.stringify(word)});
            if (i < 0) continue;
            const r = document.createRange();
            r.setStart(n, i + 1);
            r.setEnd(n, i + 2);
            const b = r.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }
        return null;
    })()`);
    if (pt == null) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
        await h.cdp("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    }
    await new Promise((r) => setTimeout(r, 250));
    return true;
}

export const codeJumps = {
    name: "code-jumps",
    surface: "code",
    async arrange() {
        const dir = makeCodeRepo({
            "README.md": README_MD,
            "src/a.ts": "export const a = 1;\n",
            "src/b.ts": B_TS,
            "src/use.ts": USE_TS,
            "docs/guide.md": GUIDE_MD,
        });
        return { dir };
    },
    async assert(h, ctx) {
        const steps = [];

        // 1. a search hit in another file opens it at the hit's line
        const opened = await openFolderInCode(h, ctx.dir);
        await openFileInCode(h, "src/a.ts");
        const hit = await pageEval(h, `
            const landed = await searchHit("NEEDLE_FAR", "src/b.ts");
            await until(() => caret() === ${FAR_LINE}, 4000);
            await nap(200);
            return { landed, caret: caret(), visible: shownLines().includes(${FAR_LINE}), pending: S.globalStore.get(C.codePendingJumpAtom) };
        `);
        await shot(h, "search-hit");
        steps.push({
            step: "code-jumps: a search hit in another file opens it at the hit's line",
            ok: opened === true && hit?.landed === true && hit.caret === FAR_LINE && hit.visible === true && hit.pending == null,
            detail: JSON.stringify({ opened, hit }),
        });

        // 2. F12 to a definition in another file puts the caret on the def line
        await openFileInCode(h, "src/use.ts");
        await pageEval(h, `await until(() => document.querySelector(".monaco-editor .view-line") != null && openPath() === "src/use.ts", 6000); await nap(300);`);
        const onWord = await clickWord(h, "export const used = farThing();", "farThing");
        const def = await pageEval(h, `
            const before = caret();
            const t = document.activeElement ?? document.body;
            t.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", code: "F12", bubbles: true, cancelable: true }));
            const landed = await until(() => fileIs("src/b.ts"), 8000);
            await until(() => caret() === ${DEF_LINE}, 4000);
            await nap(200);
            return { before, landed, caret: caret(), visible: shownLines().includes(${DEF_LINE}) };
        `);
        await shot(h, "f12");
        steps.push({
            step: "code-jumps: F12 to a definition in another file puts the caret on the def line",
            ok: onWord === true && def?.before === 3 && def.landed === true && def.caret === DEF_LINE && def.visible === true,
            detail: JSON.stringify({ onWord, def }),
        });

        // 3. a hit at a deep line of another markdown file scrolls Preview to that section
        const doc = await pageEval(h, `
            const landed = await searchHit("NEEDLE_DOC", "docs/guide.md");
            await until(() => atTop("Deep Section"), 4000);
            await nap(SETTLE_MS);
            return { landed, top: headingTop("Deep Section"), at: atTop("Deep Section"), scrolled: scrolled(), pending: S.globalStore.get(C.codePendingJumpAtom) };
        `);
        await shot(h, "markdown-hit");
        steps.push({
            step: "code-jumps: a hit at a deep line of another markdown file scrolls Preview to that section",
            ok: doc?.landed === true && doc.at === true && doc.pending == null,
            detail: JSON.stringify(doc),
        });

        // 4. Back across files returns to the earlier line
        const back = await pageEval(h, `
            document.querySelector('button[aria-label="Back"]')?.click();
            const landed = await until(() => fileIs("src/b.ts"), 8000);
            await until(() => caret() === ${DEF_LINE}, 4000);
            await nap(200);
            return { landed, caret: caret(), visible: shownLines().includes(${DEF_LINE}) };
        `);
        await shot(h, "back");
        steps.push({
            step: "code-jumps: Back across files returns to the earlier line",
            ok: back?.landed === true && back.caret === DEF_LINE && back.visible === true,
            detail: JSON.stringify(back),
        });

        // 5. a README link to a folder selects the folder in the tree and keeps the file open
        await openFileInCode(h, "README.md");
        const folder = await pageEval(h, `
            await until(() => viewport()?.querySelector('a[href="docs/"]') != null, 6000);
            const history = S.globalStore.get(C.codeHistoryAtom);
            viewport()?.querySelector('a[href="docs/"]')?.click();
            await until(() => row("docs")?.getAttribute("aria-selected") === "true", 4000);
            await nap(300);
            return {
                selected: row("docs")?.getAttribute("aria-selected"),
                expanded: row("docs")?.getAttribute("aria-expanded"),
                file: openPath(),
                kind: S.globalStore.get(C.codeFileAtom)?.kind,
                historyKept: S.globalStore.get(C.codeHistoryAtom) === history,
            };
        `);
        await shot(h, "folder-link");
        steps.push({
            step: "code-jumps: a README link to a folder selects the folder in the tree and keeps the file open",
            ok: folder?.selected === "true" && folder.file === "README.md" && folder.kind === "text" && folder.historyKept === true,
            detail: JSON.stringify(folder),
        });

        // 6. an in-page #anchor link scrolls to its heading
        await openFileInCode(h, "docs/guide.md");
        const inPage = await pageEval(h, `
            await until(() => viewport()?.querySelector('a[href="#deep-section"]') != null, 6000);
            await nap(200);
            const before = headingTop("Deep Section");
            viewport()?.querySelector('a[href="#deep-section"]')?.click();
            await until(() => atTop("Deep Section"), 4000);
            await nap(SETTLE_MS);
            return { before, top: headingTop("Deep Section"), at: atTop("Deep Section"), scrolled: scrolled(), file: openPath() };
        `);
        await shot(h, "in-page-anchor");
        steps.push({
            step: "code-jumps: an in-page #anchor link scrolls to its heading",
            ok: inPage?.before != null && inPage.before > 200 && inPage.at === true && inPage.file === "docs/guide.md",
            detail: JSON.stringify(inPage),
        });

        // 7. a doc.md#anchor link opens the doc at that heading
        await openFileInCode(h, "README.md");
        const cross = await pageEval(h, `
            await until(() => viewport()?.querySelector('a[href="docs/guide.md#deep-section"]') != null, 6000);
            viewport()?.querySelector('a[href="docs/guide.md#deep-section"]')?.click();
            const landed = await until(() => fileIs("docs/guide.md"), 8000);
            await until(() => atTop("Deep Section"), 4000);
            await nap(SETTLE_MS);
            return { landed, top: headingTop("Deep Section"), at: atTop("Deep Section"), scrolled: scrolled(), pending: S.globalStore.get(C.codePendingJumpAtom) };
        `);
        await shot(h, "cross-file-anchor");
        steps.push({
            step: "code-jumps: a doc.md#anchor link opens the doc at that heading",
            ok: cross?.landed === true && cross.at === true && cross.pending == null,
            detail: JSON.stringify(cross),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await codeEval(h, `
            const S = await mod("app/store/jotaiStore.ts");
            const C = await mod("app/view/code/codestore.ts");
            S.globalStore.set(C.lastCodeProjectAtom, null);
            await C.selectProject(null);
        `).catch(() => {});
        await h.goto("cockpit");
        if (ctx?.dir) removeCodeRepo(ctx.dir);
    },
};
