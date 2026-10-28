// Code surface scenarios: tree, search, symbols, sidebar, git status, diff, markdown.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SURFACE_LABEL } from "./attach.mjs";
import {
    MIN_FONT_PX,
    MODELS_VIEWPORT,
    SURFACE_ROOT,
    floorStep,
    focusAgentXterm,
    git,
    lookEval,
    lookKey,
    lookOpen,
    lookShot,
    openCanvasTerminal,
    paintEval,
    polishNap,
    polishWaitFor,
    setFinderQuery,
    skipStep,
    waitForProjectInConfig,
    waveService,
} from "./scenarios-shared.mjs";

// --- code: content search ----------------------------------------------------------------------
// Drives the real grep RPC, so it needs a backend built with GitGrepCommand (task build:backend).
// The query is a string this repository certainly contains; asserting "some rows" rather than an
// exact count keeps it from breaking on every edit.
const CODE_SEARCH_QUERY = "openInCode";

// Opens the project picker only when no project is loaded yet — the column tabs render only inside
// CodePanes, so their absence is the signal. Returns whether the picker was actually opened, because
// clicking a project row is only safe when it is.
const openProjectPicker = (h) =>
    h.ev(`(() => {
        if (document.querySelector('[data-code-column-tab]')) return false;
        const chip = document.querySelector('[data-code-project-picker]');
        if (!chip) return false;
        chip.click();
        return true;
    })()`);

// Scoped to the picker's own container, never the whole document: the app bar's global search
// button also carries a .font-mono child, so an unscoped query picks THAT and opens the command
// palette instead of selecting a project.
const chooseProjectRow = (h) =>
    h.ev(`(() => {
        const chip = document.querySelector('[data-code-project-picker]');
        const scope = chip && chip.parentElement;
        if (!scope) return false;
        const rows = [...scope.querySelectorAll('button')].filter((b) => b !== chip && b.querySelector('.font-mono'));
        if (!rows.length) return false;
        rows[0].click();
        return true;
    })()`);

// the picker row of one registered project, by name
const chooseProjectNamed = (h, name) =>
    h.ev(`(() => {
        const chip = document.querySelector('[data-code-project-picker]');
        const scope = chip && chip.parentElement;
        if (!scope) return false;
        const row = [...scope.querySelectorAll('button')].find(
            (b) => b !== chip && (b.textContent || '').includes(${JSON.stringify(name)})
        );
        if (!row) return false;
        row.click();
        return true;
    })()`);

const setSearchQuery = (h, text) =>
    h.ev(`(() => {
        const input = document.querySelector('input[placeholder="Search file contents"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
    })()`);

const CODE_SEARCH_PROJECT = "verify-code-search";

// Final runs on a fresh, empty store, so the scenario registers its own repo holding the query, and picks
// that row by name: rows[0], or whatever project Code already holds, need not contain it
export const codeSearch = {
    name: "code-search",
    surface: "code",
    async arrange(h) {
        const ctx = { name: CODE_SEARCH_PROJECT };
        try {
            ctx.dir = mkdtempSync(join(tmpdir(), "verify-code-search-"));
            git(ctx.dir, "init", "-q", "--initial-branch=main");
            writeFileSync(join(ctx.dir, "open.ts"), `export function ${CODE_SEARCH_QUERY}(path: string) {\n    return path;\n}\n`);
            git(ctx.dir, "add", ".");
            git(ctx.dir, "commit", "-q", "-m", "seed the search fixture");
            await h.rpc("createproject", { name: ctx.name, path: ctx.dir });
            ctx.madeProject = true;
            await waitForProjectInConfig(h, ctx.name);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        steps.push({
            step: "Code surface is active",
            ok: (await h.activeSurfaceLabel()) === SURFACE_LABEL.code,
            detail: `active=${await h.activeSurfaceLabel()}`,
        });

        const row = `document.querySelector('[data-code-picker-row=${JSON.stringify(ctx.name)}]')`;
        if (ctx.arrangeError == null && !(await h.ev(`!!${row}`))) {
            await h.ev(`document.querySelector('[data-code-project-picker]')?.click()`);
        }
        const shown = ctx.arrangeError == null && (await polishWaitFor(h, `!!${row}`, 5000));
        const picked = shown && (await h.ev(`(() => { const r = ${row}; if (!r) return false; r.click(); return true; })()`));
        steps.push({
            step: "select a project",
            ok: picked === true,
            detail: ctx.arrangeError ?? `picked=${picked}`,
        });
        await sleep(1200); // the index is one git ls-files call

        const switched = await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="search"]');
            if (!t) return false;
            t.click();
            return true;
        })()`);
        steps.push({ step: "switch the left column to Search", ok: switched === true, detail: `switched=${switched}` });

        const typed = await setSearchQuery(h, CODE_SEARCH_QUERY);
        steps.push({ step: "type a query and submit", ok: typed === true, detail: `typed=${typed}` });

        // poll rather than sleep a guessed interval: the RPC shells out to git. Take the LAST match so
        // the summary leaf wins over every ancestor div whose textContent also contains it.
        let summary = "";
        for (let i = 0; i < 20; i++) {
            summary = await h.ev(
                `(() => { const els=[...document.querySelectorAll('div')].filter((d)=>/match(es)? in \\d+ file/.test(d.textContent||'')); const el=els[els.length-1]; return el?(el.textContent||'').trim():''; })()`
            );
            if (summary) break;
            await sleep(500);
        }
        steps.push({
            step: `search "${CODE_SEARCH_QUERY}" reports a match summary`,
            ok: summary !== "",
            detail: `summary=${summary || "(none)"}`,
        });

        await h.shot("cdp-shots/code-search.png");
        return steps;
    },
    async teardown(h, ctx) {
        try {
            if (ctx.madeProject) await h.rpc("deleteproject", { name: ctx.name });
        } finally {
            if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 3 });
            await h.goto("cockpit"); // leave the app where a human expects it
        }
    },
};

const CODE_SYMBOLS_PROJECT = "verify-code-symbols";
// line numbers the steps assert against: alpha 5, beta 9, epsilon 13, Gamma 17, Gamma.Delta 19
const CODE_SYMBOLS_MAIN = [
    "package main",
    "",
    'import "fmt"',
    "",
    "func alpha() {",
    "\tfmt.Println(beta(), epsilon())",
    "}",
    "",
    "func beta() string {",
    '\treturn "b"',
    "}",
    "",
    "func epsilon() int {",
    "\treturn 1",
    "}",
    "",
    "type Gamma struct{}",
    "",
    "func (g Gamma) Delta() {}",
    "",
].join("\n");

// a frontmatter block the renderer draws as a setext heading the outline skips, and sections long enough
// that each heading starts below the fold
const CODE_SYMBOLS_DOC = ["---", "title: fixture", "---", ""]
    .concat(...["Overview", "Usage", "Notes"].map((h) => [`## ${h}`, "", ...Array.from({ length: 40 }, (_, i) => [`${h} paragraph ${i}.`, ""]).flat()]))
    .join("\n");

// The outline, the @ finder, and the two shaped searches, against a repo the scenario writes: epsilon is
// defined twice so F12 on it lists instead of jumping. The caret is read from Monaco's active line number,
// and placed on a word by a real click, since Monaco takes no text a CDP session types.
export const codeSymbols = {
    name: "code-symbols",
    surface: "code",
    async arrange(h) {
        const ctx = { name: CODE_SYMBOLS_PROJECT };
        try {
            ctx.dir = mkdtempSync(join(tmpdir(), "verify-code-symbols-"));
            git(ctx.dir, "init", "-q", "--initial-branch=main");
            writeFileSync(join(ctx.dir, "main.go"), CODE_SYMBOLS_MAIN);
            writeFileSync(join(ctx.dir, "guide.md"), CODE_SYMBOLS_DOC);
            mkdirSync(join(ctx.dir, "sub"));
            writeFileSync(join(ctx.dir, "sub", "x.go"), "package sub\n\nfunc epsilon() int { return 2 }\n");
            git(ctx.dir, "add", ".");
            git(ctx.dir, "commit", "-q", "-m", "seed the symbols fixture");
            await h.rpc("createproject", { name: ctx.name, path: ctx.dir });
            ctx.madeProject = true;
            await waitForProjectInConfig(h, ctx.name);
            // a terminal reporting as an agent in the fixture repo, whose edit stamp the last step moves
            await openCanvasTerminal(h, ctx, ctx.name);
            await h.rpc("eventpublish", {
                event: "agent:status",
                scopes: [`block:${ctx.blockId}`],
                persist: 1,
                data: { oref: `block:${ctx.blockId}`, state: "working", agent: "claude", cwd: ctx.dir, ts: Date.now() },
            });
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: ok === true, detail });
        const poll = async (expr, ms = 6000) => {
            for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) {
                const v = await h.ev(expr);
                if (v) return v;
            }
            return h.ev(expr);
        };
        const caretLine = `(() => { const el = document.querySelector(".monaco-editor .active-line-number"); return el ? Number(el.textContent.trim()) : null; })()`;
        const waitCaret = async (line) => {
            await poll(`${caretLine} === ${line}`);
            return h.ev(caretLine);
        };
        const key = (init) =>
            h.ev(`(() => {
                const t = document.activeElement ?? document.body;
                t.dispatchEvent(new KeyboardEvent("keydown", { ...${JSON.stringify(init)}, bubbles: true, cancelable: true }));
                return true;
            })()`);
        // a real click on a word of a rendered line puts Monaco's caret there
        const clickWord = async (lineText, word) => {
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
            await sleep(250);
            return true;
        };
        const searchTitle = `document.querySelector("[data-code-search-title]")?.textContent?.trim() ?? ""`;
        const searchSummary = `(() => { const t = document.querySelector("[data-code-search-title]"); const s = t?.nextElementSibling; return s ? (s.textContent || "").trim() : ""; })()`;

        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await h.goto("code");
        rec("Code surface is active", (await h.activeSurfaceLabel()) === SURFACE_LABEL.code, `active=${await h.activeSurfaceLabel()}`);

        const row = `document.querySelector('[data-code-picker-row=${JSON.stringify(ctx.name)}]')`;
        if (ctx.arrangeError == null && !(await h.ev(`!!${row}`))) {
            await h.ev(`document.querySelector('[data-code-project-picker]')?.click()`);
        }
        const shown = ctx.arrangeError == null && (await polishWaitFor(h, `!!${row}`, 5000));
        const picked = shown && (await h.ev(`(() => { const r = ${row}; if (!r) return false; r.click(); return true; })()`));
        rec("select the fixture project", picked, ctx.arrangeError ?? `picked=${picked}`);

        await h.ev(`document.querySelector('[data-code-column-tab="files"]')?.click()`);
        const opened = await poll(`(() => {
            const r = [...document.querySelectorAll('[data-code-tree] [role="treeitem"]')].find((x) => x.textContent.trim() === "main.go");
            if (!r) return false;
            r.click();
            return true;
        })()`);
        const editor = opened && (await poll(`!!document.querySelector(".monaco-editor .view-line")`));
        rec("open main.go in the editor", editor === true, `opened=${opened} editor=${editor}`);

        await h.ev(`document.querySelector('[data-code-column-tab="symbols"]')?.click()`);
        const names = await poll(`(() => {
            const rows = [...document.querySelectorAll("[data-code-symbol-row]")].map((r) => r.getAttribute("data-code-symbol-row") + "@" + r.getAttribute("data-line"));
            return rows.length ? rows : null;
        })()`);
        const want = ["alpha@5", "beta@9", "epsilon@13", "Gamma@17", "Gamma.Delta@19"];
        rec("the Symbols tab lists the file's declarations with their lines", JSON.stringify(names) === JSON.stringify(want), `rows=${JSON.stringify(names)}`);

        await h.ev(`document.querySelector('[data-code-symbol-row="Gamma.Delta"]')?.click()`);
        const afterRow = await waitCaret(19);
        await h.shot("cdp-shots/code-symbols.png");
        rec("clicking a symbol row moves the caret to its line", afterRow === 19, `caret=${afterRow}`);

        await h.ev(`document.querySelector('[data-code-symbols-filter]')?.focus()`);
        await key({ key: "O", code: "KeyO", ctrlKey: true, shiftKey: true });
        const seeded = await poll(`document.querySelector("input[data-palette-input]")?.value ?? null`);
        // textContent: the group label is uppercased by CSS, which innerText reports
        const group = await poll(`document.body.textContent.includes("Symbols in main.go")`);
        await h.shot("cdp-shots/code-symbols-finder.png");
        rec("Ctrl+Shift+O opens the search seeded with @, listing the file's symbols", seeded === "@" && group === true, `value=${JSON.stringify(seeded)} group=${group}`);

        const typed = await setFinderQuery(h, "@alpha");
        const afterPick = await waitCaret(5);
        rec("@alpha then Enter moves the caret to alpha's line", typed === true && afterPick === 5, `typed=${typed} caret=${afterPick}`);
        // a click while the closing overlay still covers the editor lands on the overlay
        await poll(`document.querySelector("input[data-palette-input]") == null`);
        await sleep(400);

        const onBeta = await clickWord("fmt.Println(beta(), epsilon())", "beta");
        const onLine = await waitCaret(6);
        await key({ key: "F12", code: "F12" });
        const afterDef = await waitCaret(9);
        rec("F12 on a name with one definition jumps to it", onBeta && onLine === 6 && afterDef === 9, `clicked=${onBeta} caret before=${onLine} after=${afterDef}`);

        const onEps = await clickWord("fmt.Println(beta(), epsilon())", "epsilon");
        await key({ key: "F12", code: "F12" });
        const defTitle = await poll(`(${searchTitle}) === "Definitions of epsilon" ? ${searchTitle} : ""`);
        const defSummary = await poll(`/2 matches in 2 files/.test(${searchSummary}) ? ${searchSummary} : ""`);
        await h.shot("cdp-shots/code-symbols-definitions.png");
        rec("F12 on a name defined twice lists both under Definitions of", onEps && defTitle !== "" && defSummary !== "", `clicked=${onEps} title=${JSON.stringify(defTitle)} summary=${JSON.stringify(defSummary)}`);

        const onBeta2 = await clickWord("fmt.Println(beta(), epsilon())", "beta");
        await key({ key: "F12", code: "F12", shiftKey: true });
        const refTitle = await poll(`(${searchTitle}) === "References to beta" ? ${searchTitle} : ""`);
        const refSummary = await poll(`/2 matches in 1 file/.test(${searchSummary}) ? ${searchSummary} : ""`);
        await h.shot("cdp-shots/code-symbols-references.png");
        rec("Shift+F12 lists the name's whole-word references under References to", onBeta2 && refTitle !== "" && refSummary !== "", `clicked=${onBeta2} title=${JSON.stringify(refTitle)} summary=${JSON.stringify(refSummary)}`);

        // a markdown file opens as a rendered document, where a heading row scrolls to its section
        await h.ev(`document.querySelector('[data-code-column-tab="files"]')?.click()`);
        const docOpened = await poll(`(() => {
            const r = [...document.querySelectorAll('[data-code-tree] [role="treeitem"]')].find((x) => x.textContent.trim() === "guide.md");
            if (!r) return false;
            r.click();
            return true;
        })()`);
        // the heading's offset from the top edge of whichever element scrolls the preview; null until it renders
        const headingTop = (name) => `(() => {
            const v = document.querySelector("[data-overlayscrollbars-viewport]:has(.heading)");
            const el = v && [...v.querySelectorAll(".heading")].find((x) => x.textContent.trim() === ${JSON.stringify(name)});
            let s = v;
            while (s && s.scrollHeight <= s.clientHeight) s = s.parentElement;
            return el && s ? Math.round(el.getBoundingClientRect().top - s.getBoundingClientRect().top) : null;
        })()`;
        const atTop = (name) => `(() => { const t = ${headingTop(name)}; return t != null && Math.abs(t) < 40; })()`;
        const before = await poll(`${headingTop("Usage")} ?? false`);
        await h.ev(`document.querySelector('[data-code-column-tab="symbols"]')?.click()`);
        await poll(`!!document.querySelector('[data-code-symbol-row="Usage"]')`);
        await h.ev(`document.querySelector('[data-code-symbol-row="Usage"]')?.click()`);
        const atUsage = await poll(atTop("Usage"));
        await h.shot("cdp-shots/code-symbols-markdown.png");
        rec("a heading row scrolls the markdown preview to that heading", docOpened && before > 200 && atUsage === true, `opened=${docOpened} top before=${before} after=${await h.ev(headingTop("Usage"))}`);

        await h.ev(`document.querySelector('[data-code-symbol-row="Overview"]')?.click()`);
        const atOverview = await poll(atTop("Overview"));
        rec("a heading row above the view scrolls back up to it", atOverview === true, `top=${await h.ev(headingTop("Overview"))}`);

        // an agent writing the open file while you stay on Code: no focus change announces it, the
        // agent's edit stamp does
        writeFileSync(join(ctx.dir, "guide.md"), CODE_SYMBOLS_DOC + "\nan agent's edit\n");
        await sleep(1500);
        const quiet = !(await h.ev(`!!document.querySelector("[data-code-stale]")`));
        if (ctx.blockId) {
            await h.rpc("setmeta", { oref: `block:${ctx.blockId}`, meta: { "agent:lasteditts": Date.now() } });
        }
        const stale = await poll(`!!document.querySelector("[data-code-stale]")`);
        await h.shot("cdp-shots/code-symbols-agent-edit.png");
        rec("an agent's edit stamp re-checks the open file and raises the stale bar", quiet && stale === true, `before stamp=${!quiet} after=${stale}`);
        return steps;
    },
    async teardown(h, ctx) {
        try {
            await h.ev(`document.querySelector('[data-code-column-tab="files"]')?.click()`);
            if (ctx.tabId) await waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false]);
            if (ctx.madeProject) await h.rpc("deleteproject", { name: ctx.name });
        } finally {
            if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 3 });
            await h.cdp("Emulation.clearDeviceMetricsOverride");
            await h.goto("cockpit");
        }
    },
};

const CODE_SIDEBAR_PROJECT = "verify-code-sidebar";

export const codeSidebar = {
    name: "code-sidebar",
    surface: "code",
    async arrange(h) {
        // unmount Code before seeding storage so the assertion starts from fresh component state.
        await h.goto("cockpit");
        const previous = await h.ev("localStorage.getItem('code.sidebar.prefs')");
        await h.ev(
            `localStorage.setItem('code.sidebar.prefs', ${JSON.stringify(
                JSON.stringify({ widths: { files: 280, search: 380, changed: 380 }, open: true })
            )})`
        );
        // Final's fresh store has no project, and the column tabs mount only once Code holds one
        const ctx = { previous, name: CODE_SIDEBAR_PROJECT };
        ctx.dir = mkdtempSync(join(tmpdir(), "verify-code-sidebar-"));
        git(ctx.dir, "init", "-q", "--initial-branch=main");
        writeFileSync(join(ctx.dir, "main.ts"), "export const answer = 42;\n");
        git(ctx.dir, "add", ".");
        git(ctx.dir, "commit", "-q", "-m", "seed the sidebar fixture");
        await h.rpc("createproject", { name: ctx.name, path: ctx.dir });
        ctx.madeProject = true;
        await waitForProjectInConfig(h, ctx.name);
        return ctx;
    },
    async assert(h, ctx) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        if ((await openProjectPicker(h)) === true) {
            const row = `document.querySelector('[data-code-picker-row=${JSON.stringify(ctx.name)}]')`;
            await polishWaitFor(h, `!!${row}`, 5000);
            await h.ev(`${row}?.click()`);
            await sleep(1200);
        }
        ctx.previousMode = await h.ev(
            `document.querySelector('[data-code-column-tab][aria-pressed="true"]')?.getAttribute('data-code-column-tab') || null`
        );
        const files = await h.ev(`(() => {
            const button = document.querySelector('[data-code-column-tab="files"]');
            if (!button) return false;
            button.click();
            return true;
        })()`);
        await sleep(100);
        steps.push({ step: "start in Files mode", ok: files === true, detail: `selected=${files}` });
        const probe = () =>
            h.ev(`(() => {
                const sidebar = document.querySelector('[aria-label="Code sidebar"]');
                const grip = document.querySelector('[role="separator"][aria-label="Resize Code sidebar"]');
                return sidebar && grip ? {
                    width: Math.round(sidebar.getBoundingClientRect().width),
                    value: Number(grip.getAttribute('aria-valuenow')),
                    active: document.activeElement?.getAttribute('aria-label') || ''
                } : null;
            })()`);
        let initial = null;
        for (let i = 0; i < 10 && initial == null; i++) {
            initial = await probe();
            if (initial == null) await sleep(200);
        }
        steps.push({
            step: "Files starts at its remembered default width",
            ok: initial?.width === 280 && initial?.value === 280,
            detail: JSON.stringify(initial),
        });

        const search = await h.ev(`(() => {
            const tab = document.querySelector('[data-code-column-tab="search"]');
            if (!tab) return false;
            tab.click();
            return true;
        })()`);
        await sleep(200);
        const searchWidth = await probe();
        steps.push({
            step: "Search keeps its independent remembered width",
            ok: search === true && searchWidth?.width === 380,
            detail: JSON.stringify(searchWidth),
        });

        const gripFocused = await h.ev(`(() => {
            const grip = document.querySelector('[role="separator"][aria-label="Resize Code sidebar"]');
            if (!grip) return false;
            grip.focus();
            return document.activeElement === grip;
        })()`);
        await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight" });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight" });
        await h.cdp("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "ArrowLeft",
            code: "ArrowLeft",
            modifiers: 8,
        });
        await h.cdp("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "ArrowLeft",
            code: "ArrowLeft",
            modifiers: 8,
        });
        const keyboard = gripFocused === true;
        await sleep(100);
        const keyboardWidth = await probe();
        steps.push({
            step: "Focused separator adjusts with keyboard without losing focus",
            ok: keyboard === true && keyboardWidth?.value === 356 && keyboardWidth?.active === "Resize Code sidebar",
            detail: JSON.stringify(keyboardWidth),
        });

        const collapsed = await h.ev(`(() => {
            const button = document.querySelector('button[aria-label="Collapse Code sidebar"]');
            if (!button) return false;
            button.click();
            return true;
        })()`);
        await sleep(200);
        const collapsedWidth = await probe();
        const openerFocused = await h.ev(`document.activeElement?.getAttribute('aria-label') || ''`);
        steps.push({
            step: "Collapse leaves a 36px reachable opener",
            ok: collapsed === true && collapsedWidth?.width === 36 && /Expand Code sidebar/.test(openerFocused),
            detail: JSON.stringify({ collapsedWidth, openerFocused }),
        });

        await h.cdp("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "f",
            code: "KeyF",
            modifiers: 10,
        });
        await h.cdp("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "f",
            code: "KeyF",
            modifiers: 10,
        });
        await sleep(200);
        const searchShortcut = await h.ev(`(() => {
            const tab = document.querySelector('[data-code-column-tab="search"]');
            const sidebar = document.querySelector('[aria-label="Code sidebar"]');
            return tab && sidebar ? {
                selected: tab.getAttribute('aria-pressed') === 'true',
                width: Math.round(sidebar.getBoundingClientRect().width),
                active: document.activeElement?.getAttribute('aria-label') || ''
            } : null;
        })()`);
        steps.push({
            step: "Ctrl+Shift+F expands the collapsed sidebar and selects Search",
            ok: searchShortcut?.selected === true && searchShortcut?.width === 356,
            detail: JSON.stringify(searchShortcut),
        });

        const collapsedForTree = await h.ev(`(() => {
            const button = document.querySelector('button[aria-label="Collapse Code sidebar"]');
            if (!button) return false;
            button.click();
            return true;
        })()`);
        await sleep(200);
        await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "t", code: "KeyT", modifiers: 1 });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "t", code: "KeyT", modifiers: 1 });
        await sleep(200);
        const treeShortcut = await h.ev(`(() => {
            const tree = document.querySelector('[data-code-tree]');
            const active = document.activeElement;
            return {
                collapsed: Math.round(document.querySelector('[aria-label="Code sidebar"]')?.getBoundingClientRect().width || 0) === 36,
                expanded: !!tree && !!active && tree.contains(active),
                active: active?.getAttribute('aria-label') || ''
            };
        })()`);
        steps.push({
            step: "Alt+T expands the collapsed sidebar before focusing the tree",
            ok: collapsedForTree === true && treeShortcut?.expanded === true,
            detail: JSON.stringify(treeShortcut),
        });

        await h.ev(`document.querySelector('button[aria-label="Collapse Code sidebar"]')?.click()`);
        await sleep(200);
        await h.ev(`document.querySelector('button[aria-label="Expand Code sidebar"]')?.click()`);
        await sleep(200);
        const reopened = await probe();
        steps.push({
            step: "Opener restores the selected mode width and focus",
            ok: reopened?.width === 280 && reopened?.active === "Collapse Code sidebar",
            detail: JSON.stringify(reopened),
        });

        await h.cdp("Emulation.setDeviceMetricsOverride", {
            width: 520,
            height: 950,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await sleep(300);
        const narrow = await probe();
        steps.push({
            step: "Narrow viewport temporarily compacts without changing the preference",
            ok: narrow?.width === 36 && /wider/.test(narrow?.active || ""),
            detail: JSON.stringify(narrow),
        });
        await h.cdp("Emulation.setDeviceMetricsOverride", {
            width: 1600,
            height: 950,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await sleep(300);
        const restored = await probe();
        steps.push({
            step: "Widening restores the open preference and remembered width",
            ok: restored?.width === 280 && restored?.active === "Collapse Code sidebar",
            detail: JSON.stringify(restored),
        });
        await h.shot("cdp-shots/code-sidebar.png");
        steps.push(await floorStep(h, `no visible text on the Code surface is under ${MIN_FONT_PX}px`, SURFACE_ROOT));
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(
            `(() => {
                const previousMode = ${JSON.stringify(ctx.previousMode ?? null)};
                if (previousMode === 'files' || previousMode === 'search' || previousMode === 'changed') {
                    document.querySelector(
                        '[data-code-column-tab="' + previousMode + '"]'
                    )?.click();
                }
                const previous = ${JSON.stringify(ctx.previous)};
                if (previous == null) localStorage.removeItem('code.sidebar.prefs');
                else localStorage.setItem('code.sidebar.prefs', previous);
            })()`
        );
        try {
            if (ctx.madeProject) await h.rpc("deleteproject", { name: ctx.name });
        } finally {
            if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 3 });
            await h.goto("cockpit");
        }
    },
};

export const codeGitStatus = {
    name: "code-git-status",
    surface: "code",
    async arrange() {
        return {};
    },
    async assert(h) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        steps.push({
            step: "Code surface is active",
            ok: (await h.activeSurfaceLabel()) === SURFACE_LABEL.code,
            detail: `active=${await h.activeSurfaceLabel()}`,
        });

        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            const picked = await chooseProjectRow(h);
            steps.push({ step: "select a project", ok: picked === true, detail: `picked=${picked}` });
            await sleep(1200); // the index is one git ls-files call, status one git status call
        }

        const switched = await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="changed"]');
            if (!t) return false;
            t.click();
            return true;
        })()`);
        steps.push({
            step: "switch the left column to Changed",
            ok: switched === true,
            detail: `switched=${switched}`,
        });

        // poll rather than sleep a guessed interval: status shells out to git
        let rowPath = "";
        for (let i = 0; i < 20; i++) {
            rowPath = await h.ev(
                `(() => { const r = document.querySelector('[data-code-changed-row]'); return r ? r.getAttribute('data-code-changed-row') : ''; })()`
            );
            if (rowPath) break;
            await sleep(500);
        }
        steps.push({
            step: "the Changed column lists at least one changed file",
            ok: rowPath !== "",
            detail: `first=${rowPath || "(none)"}`,
        });

        const counts = await h.ev(
            `(() => { const r = document.querySelector('[data-code-changed-row]'); return r ? (r.textContent || '').trim() : ''; })()`
        );
        steps.push({
            step: "a changed row carries its +/- counts",
            ok: /\+\d+/.test(counts) && /-\d+/.test(counts),
            detail: `row="${counts}"`,
        });
        await h.shot("cdp-shots/code-changed.png");

        // scoped to the row container, never a document-wide button query
        const clicked = await h.ev(`(() => {
            const r = document.querySelector('[data-code-changed-row]');
            if (!r) return false;
            r.click();
            return true;
        })()`);
        steps.push({ step: "click the first changed row", ok: clicked === true, detail: `clicked=${clicked}` });
        await sleep(900); // one stat-then-read round trip

        const openPath = await h.ev(
            `(() => { const p = document.querySelector('[data-code-path]'); return p ? p.getAttribute('data-code-path') : ''; })()`
        );
        steps.push({
            step: "the editor opened on that path",
            ok: openPath === rowPath,
            detail: `open=${openPath} want=${rowPath}`,
        });

        const backToFiles = await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="files"]');
            if (!t) return false;
            t.click();
            return true;
        })()`);
        await sleep(400);
        const letters = await h.ev(`(() => document.querySelectorAll('[data-code-status]').length)()`);
        steps.push({
            step: "the tree paints a status letter on the revealed file",
            ok: backToFiles === true && letters > 0,
            detail: `letters=${letters}`,
        });
        await h.shot("cdp-shots/code-git-status.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};

// A directory git does not know: typed into the picker, it browses like a repository, minus change
// tracking. The fixture holds a skipped build folder, so the walk's skip set is checked too.
export const codePlainDir = {
    name: "code-plain-dir",
    surface: "code",
    async arrange() {
        const dir = mkdtempSync(join(tmpdir(), "verify-code-plain-"));
        writeFileSync(join(dir, "notes.txt"), "first line\nPLAINNEEDLE here\n");
        mkdirSync(join(dir, "sub"));
        writeFileSync(join(dir, "sub", "inner.txt"), "PLAINNEEDLE again\n");
        mkdirSync(join(dir, "node_modules"));
        writeFileSync(join(dir, "node_modules", "skipped.js"), "PLAINNEEDLE skipped\n");
        return { dir };
    },
    async assert(h, ctx) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const poll = async (expr, tries = 20) => {
            let v;
            for (let i = 0; i < tries; i++) {
                v = await h.ev(expr);
                if (v) break;
                await sleep(300);
            }
            return v;
        };
        await h.goto("code");

        await h.ev(`document.querySelector('[data-code-project-picker]')?.click()`);
        // the popover mounts its contents only once open, a render after the click
        await poll(`!!document.querySelector('[data-code-picker-path] input')`);
        const typed = await h.ev(`(() => {
            const input = document.querySelector('[data-code-picker-path] input');
            if (!input) return "no path input";
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(ctx.dir)});
            input.dispatchEvent(new Event("input", { bubbles: true }));
            return "ok";
        })()`);
        await sleep(100); // let React commit the typed value before the submit reads it
        await h.ev(`document.querySelector('[data-code-picker-path]')?.requestSubmit()`);
        rec("type the plain directory into the picker", typed === "ok", typed);

        const tree = await poll(`(() => {
            const rows = [...document.querySelectorAll('[data-code-tree] [role="treeitem"]')].map((r) => r.textContent.trim());
            return rows.length ? rows : null;
        })()`);
        rec(
            "the tree lists the directory's files",
            Array.isArray(tree) && tree.some((t) => t.includes("notes.txt")) && tree.some((t) => t.includes("sub")),
            `rows=${JSON.stringify(tree)}`
        );
        rec(
            "node_modules is skipped",
            Array.isArray(tree) && !tree.some((t) => t.includes("node_modules")),
            `rows=${JSON.stringify(tree)}`
        );
        const footer = await h.ev(`document.querySelector('[data-code-tree-skipset]')?.textContent ?? ""`);
        rec("the skip set is stated under the tree", footer.includes("node_modules"), `footer="${footer}"`);
        const header = await h.ev(`document.body.innerText.includes("not a git repository")`);
        rec("the header marks the directory as not a repository", header === true, `marked=${header}`);
        const changed = await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="changed"]');
            return t ? { disabled: t.disabled, title: t.title } : null;
        })()`);
        rec(
            "the Changed tab is disabled with its reason",
            changed?.disabled === true && /no change tracking/.test(changed?.title ?? ""),
            JSON.stringify(changed)
        );

        await h.ev(`(() => {
            const row = [...document.querySelectorAll('[data-code-tree] [role="treeitem"]')].find((r) => r.textContent.includes("notes.txt"));
            row?.click();
        })()`);
        const editor = await poll(`!!document.querySelector('.monaco-editor')`);
        rec("opening a file mounts the editor", editor === true, `editor=${editor}`);
        const diff = await h.ev(`document.querySelector('[data-code-view-mode="diff"]')?.disabled ?? null`);
        rec("the Diff toggle is disabled", diff === true, `disabled=${diff}`);
        const blame = await h.ev(`(() => {
            const b = document.querySelector('[data-code-blame-toggle]');
            return b ? { disabled: b.disabled, title: b.title } : null;
        })()`);
        rec(
            "the Blame toggle is disabled with its reason",
            blame?.disabled === true && /no change tracking/.test(blame?.title ?? ""),
            JSON.stringify(blame)
        );
        await h.shot("cdp-shots/code-plain-dir.png");

        // the path bar's send popover and the project picker sit on the popover shadow scale
        const SEND = `[...document.querySelectorAll("button")].find((b) => /^(Copy reference|Send to agent)$/.test((b.textContent || "").trim()))`;
        const PICKER = `document.querySelector("[data-code-project-picker]")`;
        for (const [label, shot, trigger] of [
            ["path bar's send popover", "send", SEND],
            ["project picker", "picker", PICKER],
        ]) {
            await h.ev(`${trigger}?.click()`);
            await sleep(400);
            const s = await paintEval(h, `return shadowVs((${trigger})?.parentElement.querySelector('[class*="shadow-popover"]') ?? null, "shadow-popover-md");`);
            await h.shot(lookShot(`code-plain-dir-${shot}`));
            await h.ev(`${trigger}?.click()`);
            await sleep(300);
            rec(`the ${label} casts shadow-popover-md over no raw overlay`, s.ok === true, JSON.stringify(s));
        }

        await h.ev(`document.querySelector('[data-code-column-tab="search"]')?.click()`);
        await sleep(300);
        await h.ev(`(() => {
            const input = document.querySelector('[data-code-search-input]');
            if (!input) return;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "plainneedle");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        })()`);
        await sleep(100);
        await h.ev(`document.querySelector('[data-code-search-input]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))`);
        const hits = await poll(`(() => {
            const rows = [...document.querySelectorAll('[data-code-search-row]')];
            return rows.length ? rows.map((r) => r.textContent.trim()) : null;
        })()`);
        rec(
            "search finds both matches and none under node_modules",
            Array.isArray(hits) && hits.length === 2 && !hits.some((t) => t.includes("skipped")),
            `hits=${JSON.stringify(hits)}`
        );
        await h.shot("cdp-shots/code-plain-dir-search.png");

        const PANE = `document.querySelector("[data-code-search-input]")?.parentElement?.parentElement`;
        const flag = await tabOnto(h, `${PANE}?.querySelector("[data-code-search-flag]")`);
        await h.shot(lookShot("code-plain-dir-search-focus"));
        const unlabelled = await h.ev(unlabelledButtons(PANE));
        rec(
            "Tab onto a search pane button shows the focus ring, and every icon-only button there is labelled",
            flag.focused && flag.ring && unlabelled === 0,
            JSON.stringify({ ...flag, unlabelled })
        );
        steps.push(await floorStep(h, `no visible text on the Code surface is under ${MIN_FONT_PX}px`, SURFACE_ROOT));

        // a file gone from disk: the viewer's Refresh index lives in surfacescaffold.tsx, which no task changes,
        // so whether it rings is recorded, not required
        rmSync(join(ctx.dir, "sub", "inner.txt"));
        await h.ev(`document.querySelector('[data-code-column-tab="files"]')?.click()`);
        await sleep(300);
        await h.ev(`(() => {
            const sub = [...document.querySelectorAll('[data-code-tree] [role="treeitem"]')].find((r) => r.textContent.trim() === "sub");
            if (sub?.getAttribute("aria-expanded") === "false") sub.click();
        })()`);
        await sleep(400);
        await h.ev(`[...document.querySelectorAll('[data-code-tree] [role="treeitem"]')].find((r) => r.textContent.includes("inner.txt"))?.click()`);
        const REFRESH = `[...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Refresh index")`;
        const shown = await poll(`!!${REFRESH}`, 10);
        const refresh = shown ? await tabOnto(h, REFRESH) : null;
        if (shown) await h.shot(lookShot("code-plain-dir-missing-focus"));
        rec(
            "finding: the viewer's Refresh index (surfacescaffold.tsx) under Tab - recorded, not required",
            true,
            JSON.stringify(shown ? { ...refresh, ring: refresh.ring ? "rings" : "no ring" } : { shown: false })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit");
        if (ctx?.dir) rmSync(ctx.dir, { recursive: true, force: true });
    },
};

const POLICY_GO = (budget) => `package retry

func Budget() int {
    return ${budget}
}
`;

export const codeDiff = {
    name: "code-diff",
    surface: "code",
    // its own repo with exactly one uncommitted edit: final-verify boots a fresh store with no projects
    async arrange(h) {
        const dir = mkdtempSync(join(tmpdir(), "verify-code-diff-"));
        git(dir, "init", "-q", "--initial-branch=main");
        writeFileSync(join(dir, "policy.go"), POLICY_GO(3));
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "seed the retry package");
        writeFileSync(join(dir, "policy.go"), POLICY_GO(8));
        const name = "verify-code-diff";
        await h.rpc("createproject", { name, path: dir });
        await waitForProjectInConfig(h, name);
        try {
            await h.ev("location.reload()");
        } catch {
            /* the evaluate is cut off by the navigation it just started */
        }
        for (let waited = 0; waited < 30000; waited += 500) {
            const up = await h
                .ev("!!window.TabRpcClient && !!document.querySelector('nav button')")
                .catch(() => false);
            if (up) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        return { dir, name };
    },
    async assert(h, ctx) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            // not chooseProjectRow: rows[0] may be any registered project, and the step-1 check pins policy.go
            await chooseProjectNamed(h, ctx.name);
            await sleep(1200);
        }

        // the Changed column guarantees the file we open actually differs from HEAD
        await h.ev(`(() => {
            const t = document.querySelector('[data-code-column-tab="changed"]');
            if (t) t.click();
            return true;
        })()`);
        let rowPath = "";
        for (let i = 0; i < 20; i++) {
            rowPath = await h.ev(
                `(() => { const r = document.querySelector('[data-code-changed-row]'); return r ? r.getAttribute('data-code-changed-row') : ''; })()`
            );
            if (rowPath) break;
            await sleep(500);
        }
        const opened = await h.ev(`(() => {
            const r = document.querySelector('[data-code-changed-row]');
            if (!r) return false;
            r.click();
            return true;
        })()`);
        steps.push({
            step: "open a file that differs from HEAD",
            ok: opened === true && rowPath === "policy.go",
            detail: `path=${rowPath || "(none)"}`,
        });
        await sleep(900);

        const toDiff = await h.ev(`(() => {
            const b = document.querySelector('[data-code-view-mode="diff"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await sleep(1500); // monaco is lazy, and the HEAD read is one git call
        const mounted = await h.ev(`(() => !!document.querySelector('.monaco-diff-editor'))()`);
        const onHead = await h.ev(`!!document.querySelector('[data-code-diff-target="head"]')`);
        steps.push({
            step: "Diff mounts the Monaco diff editor, headed against HEAD",
            ok: toDiff === true && mounted === true && onHead === true,
            detail: `toggled=${toDiff} mounted=${mounted} head=${onHead}`,
        });
        await h.shot("cdp-shots/code-diff.png");
        steps.push(await floorStep(h, `no visible text on the Code surface's diff is under ${MIN_FONT_PX}px`, SURFACE_ROOT));
        // codediffview draws no button of its own; the mode toggle above it lives in codepathbar.tsx, outside the
        // focus pass, so whether it rings is recorded, not required
        const toggle = await tabOnto(h, `document.querySelector('[data-code-view-mode="diff"]')`);
        await h.shot(lookShot("code-diff-toolbar-focus"));
        steps.push({
            step: "finding: the diff view's mode toggle (codepathbar.tsx) under Tab - recorded, not required",
            ok: true,
            detail: JSON.stringify({ ...toggle, ring: toggle.ring ? "rings" : "no ring" }),
        });

        // `d` and `r` are gated on !editable, so focus has to leave Monaco first
        const press = async (key) => {
            await h.ev(`(() => {
                const t = document.querySelector('[data-code-tree]');
                if (t) t.focus();
                return true;
            })()`);
            await h.ev(
                `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(`Key${key.toUpperCase()}`)}, bubbles: true }))`
            );
        };
        const view = () =>
            h.ev(`(() => {
                const d = document.querySelector('.monaco-diff-editor');
                const o = d && (d.querySelector('.editor.original .view-lines') || d);
                const t = document.querySelector('[data-code-diff-target]');
                return {
                    diff: !!d,
                    plain: !!document.querySelector('.monaco-editor'),
                    target: t ? t.getAttribute('data-code-diff-target') : '',
                    label: t ? t.textContent : '',
                    original: o ? (o.textContent || '').replace(/\\s+/g, ' ') : '',
                };
            })()`);
        const single = `(() => !document.querySelector('.monaco-diff-editor') && !!document.querySelector('.monaco-editor'))()`;
        // the buffer is what was read, so after an on-disk change the file is re-read the way a reader would
        const reopen = async () => {
            await press("r");
            await sleep(1200);
            await h.ev(`(() => {
                const t = document.querySelector('[data-code-column-tab="changed"]');
                if (t) t.click();
                return true;
            })()`);
            await polishWaitFor(h, `!!document.querySelector('[data-code-changed-row="policy.go"]')`, 8000);
            await h.ev(`(() => {
                const r = document.querySelector('[data-code-changed-row="policy.go"]');
                if (r) r.click();
                return true;
            })()`);
            await sleep(900);
        };

        // on main, HEAD is the merge-base, so the base step would repeat the HEAD diff under another name
        await h.ev(`(() => {
            window.__codeDiffSawBase = false;
            const mark = () => {
                if (document.querySelector('[data-code-diff-target="base"]')) window.__codeDiffSawBase = true;
            };
            window.__codeDiffBaseWatch = new MutationObserver(mark);
            window.__codeDiffBaseWatch.observe(document.body, { subtree: true, childList: true, attributes: true });
            return true;
        })()`);
        await press("d");
        const skipped = await polishWaitFor(h, single, 6000);
        const sawBase = await h.ev(`(() => {
            window.__codeDiffBaseWatch && window.__codeDiffBaseWatch.disconnect();
            return window.__codeDiffSawBase === true;
        })()`);
        steps.push({
            step: "on the default branch, d skips the base and returns to the single editor",
            ok: skipped === true && sawBase === false,
            detail: `single=${skipped} sawBase=${sawBase}`,
        });

        git(ctx.dir, "checkout", "-q", "-b", "feature");
        git(ctx.dir, "commit", "-q", "-am", "raise the retry budget");
        writeFileSync(join(ctx.dir, "policy.go"), POLICY_GO(9));
        await reopen();
        await press("d");
        const head = await polishWaitFor(
            h,
            `!!document.querySelector('[data-code-diff-target="head"]') && !!document.querySelector('.monaco-diff-editor')`,
            6000
        );
        await press("d");
        const based = await polishWaitFor(
            h,
            `(() => {
                const d = document.querySelector('.monaco-diff-editor');
                const o = d && (d.querySelector('.editor.original .view-lines') || d);
                return !!document.querySelector('[data-code-diff-target="base"]') && !!o && /return\\s3/.test(o.textContent || '');
            })()`,
            8000
        );
        const baseView = await view();
        steps.push({
            step: "on a feature branch, d goes HEAD then base, and the base side holds main's return 3",
            ok: head === true && based === true,
            detail: `head=${head} base=${based} label=${JSON.stringify(baseView.label)} original=${JSON.stringify(baseView.original.slice(0, 80))}`,
        });
        await h.shot("cdp-shots/code-diff-base.png");
        await press("d");
        const off = await polishWaitFor(h, single, 6000);
        steps.push({ step: "d from the base returns to the single editor", ok: off === true, detail: `single=${off}` });

        // DefaultBranch now answers origin/gone, which GetDivergence cannot resolve, so the RPC throws
        git(ctx.dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");
        await press("d");
        await polishWaitFor(h, `!!document.querySelector('[data-code-diff-target="head"]')`, 6000);
        await press("d");
        const failed = await polishWaitFor(
            h,
            `(() => !!document.querySelector('[data-code-diff-target="base"]') && (document.body.textContent || '').includes('Cannot diff against the branch base'))()`,
            8000
        );
        const errView = await view();
        steps.push({
            step: "a base that cannot resolve shows the error state, not a HEAD diff",
            ok: failed === true && errView.diff === false,
            detail: `error=${failed} diff=${errView.diff} target=${errView.target}`,
        });
        await h.shot("cdp-shots/code-diff-base-error.png");
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit"); // leave the app where a human expects it
        try {
            await h.rpc("deleteproject", { name: ctx.name });
        } catch {
            /* leave a stale registry entry rather than failing teardown */
        }
        try {
            rmSync(ctx.dir, { recursive: true, force: true });
        } catch {
            /* a leftover temp repo is cheaper than a failed teardown */
        }
    },
};

// --- code: blame -------------------------------------------------------------------------------
// A deferred orchestrator run gives a real run id, a BaseCommit and a live wave/<runId> landing tree, which is
// what the backend credits a branch's commits to. The tree is the Code project: one commit on main, one on the
// run's branch, one uncommitted line, so the column shows a seed row, a credited run row and "not committed".
const BLAME_FILE = "blame.txt";
const BLAME_SEED = "seed the file";
const BLAME_RUN_COMMIT = "run commit";
const BLAME_GOAL = "verify code-blame: do nothing, make no file changes, stop immediately";
const blameLines = (edits = {}) =>
    ["one", "two", "three", "four", "five", "six"].map((l, i) => edits[i + 1] ?? l).join("\n") + "\n";
const BLAME_ENTRIES = `[...document.querySelectorAll('[data-code-blame-column] [data-code-blame-entry]')]`;
const BLAME_ROWS = `${BLAME_ENTRIES}.map((r) => ({
    sha: r.getAttribute('data-code-blame-entry'),
    run: r.getAttribute('data-code-blame-run'),
    title: r.getAttribute('title') || '',
    text: (r.textContent || '').trim(),
}))`;
const blameRow = (subject) =>
    `${BLAME_ENTRIES}.find((r) => (r.getAttribute('title') || '').startsWith(${JSON.stringify(subject)}))`;

export const codeBlame = {
    name: "code-blame",
    surface: "code",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-code-blame-"));
        const name = "verify-code-blame";
        const ctx = { cwd, name };
        try {
            git(cwd, "init", "-q", "--initial-branch=main");
            writeFileSync(join(cwd, BLAME_FILE), blameLines());
            git(cwd, "add", ".");
            git(cwd, "commit", "-q", "-m", BLAME_SEED);
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name, projectpath: cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: BLAME_GOAL,
                runtime: "claude",
                mode: "orchestrator",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            // createrun already checked wave/<runId> out here, at BaseCommit
            ctx.landPath = created.run.landpath;
            if (!ctx.landPath) throw new Error("createrun made no landing tree");
            writeFileSync(join(ctx.landPath, BLAME_FILE), blameLines({ 3: "THREE", 4: "FOUR" }));
            git(ctx.landPath, "commit", "-q", "-am", BLAME_RUN_COMMIT);
            writeFileSync(join(ctx.landPath, BLAME_FILE), blameLines({ 3: "THREE", 4: "FOUR", 6: "six, edited" }));
            await h.rpc("createproject", { name, path: ctx.landPath });
            ctx.project = true;
            await waitForProjectInConfig(h, name);
            await h.reload();
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError) return [{ step: "arrange the run's landing tree", ok: false, detail: ctx.arrangeError }];
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        await h.goto("code");
        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            await chooseProjectNamed(h, ctx.name);
        }
        const TREE_ROW = `[...document.querySelectorAll('[data-code-tree] [role="treeitem"]')].find((r) => r.textContent.includes(${JSON.stringify(BLAME_FILE)}))`;
        await polishWaitFor(h, `!!${TREE_ROW}`, 10000);
        await h.ev(`${TREE_ROW}?.click()`);
        const editor = await polishWaitFor(
            h,
            `document.querySelector('[data-code-path]')?.getAttribute('data-code-path') === ${JSON.stringify(BLAME_FILE)} && !!document.querySelector('.monaco-editor')`,
            10000
        );
        rec("open the file in the run's landing tree", editor === true, `editor=${editor}`);

        await h.ev(`document.querySelector('[data-code-blame-toggle]')?.click()`);
        // the first blame after launch reads every landed run's commits to credit them
        await polishWaitFor(h, `${BLAME_ENTRIES}.length >= 3`, 40000);
        const rows = (await h.ev(BLAME_ROWS)) ?? [];
        rec(
            "the toggle mounts the column with three or more entries, one not committed",
            rows.length >= 3 && rows.some((r) => r.text === "not committed"),
            JSON.stringify(rows.map((r) => r.text))
        );
        await h.shot("cdp-shots/code-blame.png");

        const seed = rows.find((r) => r.title.startsWith(BLAME_SEED));
        const ran = rows.find((r) => r.title.startsWith(BLAME_RUN_COMMIT));
        rec(
            "a committed row's title names its commit subject and author",
            seed != null && seed.title.endsWith(" — dana k"),
            `title=${JSON.stringify(seed?.title)}`
        );
        rec(
            "the run commit's row links the run and shows its goal",
            ran?.run === ctx.runId && ran.text.includes(BLAME_GOAL),
            JSON.stringify(ran)
        );
        rec("the seed row has no run link", seed != null && seed.run == null, JSON.stringify(seed));

        // the clipboard is stubbed: a CDP session does not give the page the focus a real write needs
        const copied = await h.ev(`(async () => {
            const clip = navigator.clipboard;
            let wrote = null;
            Object.defineProperty(clip, 'writeText', { configurable: true, value: (t) => { wrote = t; return Promise.resolve(); } });
            ${blameRow(BLAME_SEED)}?.click();
            let state = null;
            for (let i = 0; i < 20 && state == null; i++) {
                await new Promise((r) => setTimeout(r, 50));
                state = ${blameRow(BLAME_SEED)}?.getAttribute('data-code-blame-copied') ?? null;
            }
            delete clip.writeText;
            return { state, wrote };
        })()`);
        rec(
            "clicking the seed row copies its sha and says so on the row",
            copied?.state === "copied" && copied.wrote === seed?.sha,
            JSON.stringify(copied)
        );

        await h.ev(`${blameRow(BLAME_RUN_COMMIT)}?.click()`);
        const opened = await polishWaitFor(
            h,
            `document.querySelector('[data-jarvis-brief-sheet] [data-run-id]')?.getAttribute('data-run-id') === ${JSON.stringify(ctx.runId)}`,
            10000
        );
        const surface = await h.activeSurfaceLabel();
        rec(
            "clicking the run row leaves Code and opens that run",
            opened === true && surface !== SURFACE_LABEL.code,
            `surface=${surface} opened=${opened}`
        );
        await h.shot("cdp-shots/code-blame-run.png");

        await h.goto("code");
        await polishWaitFor(h, `!!document.querySelector('[data-code-blame-column]')`, 5000);
        await h.ev(`document.querySelector('[data-code-tree]')?.focus()`);
        await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true }))`);
        const gone = await polishWaitFor(h, `!document.querySelector('[data-code-blame-column]')`, 5000);
        rec("b with the tree focused hides the column", gone === true, `gone=${gone}`);
        return steps;
    },
    // the run first, which ends its hold on the landing tree, then the project and channel, then the dirs
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`code-blame teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("leave Code", () => h.goto("cockpit"));
        if (ctx?.runId) await step("cancel the run", () => h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.runId }));
        if (ctx?.project) await step("delete the project", () => h.rpc("deleteproject", { name: ctx.name }));
        if (ctx?.channelId) await step("delete the channel", () => h.rpc("deletechannel", { channelid: ctx.channelId }));
        for (const dir of [ctx?.landPath, ctx?.cwd].filter(Boolean)) {
            await step(`remove ${dir}`, () => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }));
        }
    },
};

export const codeMarkdown = {
    name: "code-markdown",
    surface: "code",
    async arrange() {
        return {};
    },
    async assert(h) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const steps = [];
        await h.goto("code");
        steps.push({
            step: "Code surface is active",
            ok: (await h.activeSurfaceLabel()) === SURFACE_LABEL.code,
            detail: `active=${await h.activeSurfaceLabel()}`,
        });

        if ((await openProjectPicker(h)) === true) {
            await sleep(300);
            const picked = await chooseProjectRow(h);
            steps.push({ step: "select a project", ok: picked === true, detail: `picked=${picked}` });
            await sleep(1200); // the index is one git ls-files call
        }

        // Ctrl+P on Code opens the search on its Files scope; Enter opens the top-ranked match
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
        );
        await sleep(300);
        const typed = await setFinderQuery(h, "README.md");
        steps.push({
            step: "open the finder with Ctrl+P and open README.md",
            ok: typed === true,
            detail: `typed=${typed}`,
        });
        await sleep(800); // one stat-then-read round trip

        const heading = await h.ev(`(() => {
            const h = document.querySelector('.markdown .heading');
            return h ? (h.textContent || '').trim() : null;
        })()`);
        steps.push({
            step: "markdown file renders as a document (a heading is present)",
            ok: heading != null && heading.length > 0,
            detail: `heading=${heading}`,
        });
        await h.shot("cdp-shots/code-markdown-preview.png");

        await h.ev(`document.querySelector('[data-code-column-tab="files"]')?.click()`);
        await sleep(100);
        const filesSelected = await h.ev(
            `document.querySelector('[data-code-column-tab="files"]')?.getAttribute('aria-pressed') === 'true'`
        );
        await h.ev(`(() => {
            window.__codeMarkdownNodes = [
                document.querySelector('.markdown .heading'),
                document.querySelector('.markdown .paragraph'),
            ];
            document.querySelector('[data-code-column-tab="changed"]')?.click();
        })()`);
        await sleep(100);
        const stableRender = await h.ev(`(() => {
            const before = window.__codeMarkdownNodes;
            delete window.__codeMarkdownNodes;
            return {
                changedSelected: document.querySelector('[data-code-column-tab="changed"]')?.getAttribute('aria-pressed') === 'true',
                nodesPreserved: Array.isArray(before)
                    && before[0] != null
                    && before[1] != null
                    && before[0] === document.querySelector('.markdown .heading')
                    && before[1] === document.querySelector('.markdown .paragraph'),
            };
        })()`);
        steps.push({
            step: "unrelated Code pane updates preserve the rendered document nodes",
            ok:
                filesSelected === true &&
                stableRender?.changedSelected === true &&
                stableRender?.nodesPreserved === true,
            detail: JSON.stringify({ filesSelected, ...stableRender }),
        });

        const toSource = await h.ev(`(() => {
            const b = document.querySelector('[data-code-view-mode="source"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await sleep(600);
        const editor = await h.ev(`(() => !!document.querySelector('.monaco-editor'))()`);
        steps.push({
            step: "toggle to Source mounts the Monaco editor",
            ok: toSource === true && editor === true,
            detail: `toggled=${toSource} editor=${editor}`,
        });

        const backToPreview = await h.ev(`(() => {
            const b = document.querySelector('[data-code-view-mode="preview"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await sleep(400);
        const previewAgain = await h.ev(`(() => !!document.querySelector('.markdown .heading'))()`);
        steps.push({
            step: "toggle back to Preview re-renders the document",
            ok: backToPreview === true && previewAgain === true,
            detail: `toggled=${backToPreview} preview=${previewAgain}`,
        });

        // reopening reads the file again; every painted frame must show a document, never the
        // "Opening…" placeholder that used to sit on screen for the whole render of a large file
        await h.ev(`(() => {
            const seen = { frames: 0, placeholder: 0, blank: 0 };
            const t0 = performance.now();
            const frame = () => {
                seen.frames++;
                const md = document.querySelector('.markdown .heading');
                const opening = [...document.querySelectorAll('body *')]
                    .some((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Opening…');
                if (opening) seen.placeholder++;
                else if (!md) seen.blank++;
                if (performance.now() - t0 < 1500) requestAnimationFrame(frame);
                else window.__codeMarkdownReopen = seen;
            };
            requestAnimationFrame(frame);
        })()`);
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
        );
        await sleep(300);
        const reopened = await setFinderQuery(h, "README.md");
        await sleep(1500);
        const reopen = await h.ev(`(() => { const s = window.__codeMarkdownReopen; delete window.__codeMarkdownReopen; return s; })()`);
        steps.push({
            step: "reopening the document never paints the Opening… placeholder or an empty pane",
            ok: reopened === true && reopen != null && reopen.placeholder === 0 && reopen.blank === 0,
            detail: JSON.stringify({ reopened, ...reopen }),
        });

        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// The Code tree's keys are gated on the tree holding focus (codeTreeFocusedAtom); arriving left it on
// <body>, so j/k/arrows/Enter were dead until a click or Alt+T.
export const codeTreeOnArrival = {
    name: "code-tree-on-arrival",
    surface: "code",
    async arrange() {
        return {};
    },
    async assert(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        // the tree learns it has focus from its focus event, which Chromium holds back while the dev
        // window is behind another one
        await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
        await h.goto("code");
        if (!(await h.ev(`document.querySelector('[data-code-tree]')?.checkVisibility() ?? false`))) {
            return [skipStep("the Code surface shows its file tree", "no tree: pick a project on Code first")];
        }
        await h.goto("agent");
        await h.ev(focusAgentXterm);
        await h.goto("code");
        const r = await h.ev(`(() => {
            const a = document.activeElement;
            const e = new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', bubbles: true, cancelable: true });
            (a ?? document.body).dispatchEvent(e);
            return { inTree: a?.closest?.('[data-code-tree]') != null, claimed: e.defaultPrevented, active: a?.tagName };
        })()`);
        return [
            {
                step: "Agent -> nav click Code: the tree has focus and j moves its cursor",
                ok: r.inTree === true && r.claimed === true,
                detail: `active=${r.active} inTree=${r.inTree} claimed=${r.claimed}`,
            },
        ];
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

const LOOK_STALE_FILE = "notes.txt";

// the stale check runs on window focus, which a CDP session does not move, so the scenario calls the same function
// the focus effect calls
const lookCheckStale = (h) =>
    lookEval(h, `
        const { checkStale } = await mod("app/view/code/codestore.ts");
        await checkStale();
    `);

const lookStaleBar = (h) =>
    lookEval(h, `
        const bar = () => document.querySelector("[data-code-stale]");
        await until(() => bar() != null, 4000);
        await nap(200);
        return bar() ? { text: flat(bar()), button: flat(bar().querySelector("button")) } : null;
    `);

export const codeStaleBarLook = {
    name: "code-stale-bar",
    surface: "code",
    async arrange() {
        const dir = mkdtempSync(join(tmpdir(), "verify-code-stale-"));
        writeFileSync(join(dir, LOOK_STALE_FILE), "first line\n");
        return { dir };
    },
    async assert(h, ctx) {
        const steps = [];
        const file = join(ctx.dir, LOOK_STALE_FILE);
        await lookOpen(h, "code");
        const opened = await lookEval(h, `
            document.querySelector("[data-code-project-picker]")?.click();
            await until(() => document.querySelector("[data-code-picker-path] input") != null, 4000);
            const input = document.querySelector("[data-code-picker-path] input");
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(ctx.dir)});
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await nap(100); // let React commit the typed value before the submit reads it
            document.querySelector("[data-code-picker-path]")?.requestSubmit();
            const row = () => [...document.querySelectorAll('[data-code-tree] [role="treeitem"]')].find((r) => flat(r).includes(${JSON.stringify(LOOK_STALE_FILE)}));
            await until(() => row() != null, 8000);
            row()?.click();
            return until(() => document.querySelector(".monaco-editor") != null, 8000);
        `);

        writeFileSync(file, "first line\nan agent wrote this\n");
        await lookCheckStale(h);
        const clean = await lookStaleBar(h);
        await h.shot(lookShot("code-stale-bar"));
        steps.push({
            step: "a file changed on disk while open shows the stale bar with Reload",
            ok: opened === true && clean != null && clean.text.includes(`${LOOK_STALE_FILE} changed on disk`) && clean.button === "Reload",
            detail: JSON.stringify({ opened, clean }),
        });
        const reload = await tabOnto(h, `document.querySelector("[data-code-stale] button")`);
        await h.shot(lookShot("code-stale-bar-focus"));
        const unlabelled = await h.ev(unlabelledButtons(`document.querySelector("[data-code-stale]")`));
        steps.push({
            step: "Tab onto Reload shows the focus ring, and no stale-bar button is unlabelled",
            ok: reload.focused && reload.ring && unlabelled === 0,
            detail: JSON.stringify({ ...reload, unlabelled }),
        });
        steps.push(await floorStep(h, `no visible text in the stale bar is under ${MIN_FONT_PX}px`, `document.querySelector("[data-code-stale]")`));

        const reloaded = await lookEval(h, `
            document.querySelector("[data-code-stale] button")?.click();
            return until(() => document.querySelector("[data-code-stale]") == null, 4000);
        `);
        steps.push({ step: "Reload reads the disk copy and clears the bar", ok: reloaded === true, detail: `cleared=${reloaded}` });

        // an unsaved edit, then another write under it. Monaco takes no text a CDP session types, so the edit goes
        // through editDraft, which the editor's onChange calls.
        await lookEval(h, `
            const { editDraft } = await mod("app/view/code/codestore.ts");
            editDraft("first line\\nan agent wrote this\\nmy edit\\n");
            await nap(300);
        `);
        writeFileSync(file, "first line\nan agent wrote this\nand this\n");
        await lookCheckStale(h);
        const dirty = await lookStaleBar(h);
        await h.shot(lookShot("code-stale-bar-dirty"));
        steps.push({
            step: "with an unsaved edit the bar says the edits are still here, and its button says what it destroys",
            ok: dirty != null && /your unsaved edits are still here/.test(dirty.text) && dirty.button === "Discard my edits and reload",
            detail: JSON.stringify(dirty),
        });
        const discarded = await lookEval(h, `
            document.querySelector("[data-code-stale] button")?.click();
            return until(() => document.querySelector("[data-code-stale]") == null, 4000);
        `);
        steps.push({ step: "Discard my edits and reload clears the bar", ok: discarded === true, detail: `cleared=${discarded}` });
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit");
        if (ctx?.dir) rmSync(ctx.dir, { recursive: true, force: true });
    },
};

// moves focus onto the element by a real Tab key, from a focusable put just before it, and reads whether the
// focused element shows a ring (a spread-only box-shadow layer)
async function tabOnto(h, target) {
    const placed = await h.ev(`(() => {
        const t = ${target};
        if (!t) return false;
        const s = document.createElement("span");
        s.tabIndex = 0;
        s.setAttribute("data-tab-sentinel", "");
        t.before(s);
        s.focus();
        return document.activeElement === s;
    })()`);
    if (placed) await lookKey(h, "Tab", "Tab", 9);
    await polishNap(200);
    return h.ev(`(() => {
        const t = ${target};
        const shadow = t ? getComputedStyle(t).boxShadow : null;
        const out = { placed: ${placed}, focused: t != null && document.activeElement === t, shadow, ring: shadow != null && / 0px 0px 0px [1-9]/.test(shadow) };
        document.querySelector("[data-tab-sentinel]")?.remove();
        return out;
    })()`);
}
// the buttons under a root with no text and no aria-label
const unlabelledButtons = (root) =>
    `[...((${root})?.querySelectorAll("button") ?? [])].filter((b) => (b.textContent || "").trim() === "" && !(b.getAttribute("aria-label") || "").trim()).length`;
