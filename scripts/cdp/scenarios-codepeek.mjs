// The terminal Code peek (docs/superpowers/plans/2026-11-03-code-peek.md, boards Main, Trigger and PeekPanel under
// .superpowers/design/code-peek): Ctrl+click a file path an agent's terminal printed and a read-only card unfolds
// under that line. A shell tab is made a working claude agent by the agent:status event `wsh agentstatus` publishes,
// with its cwd a temp git repo, so the Agent surface shows it with the details rail. The shell prints one path per
// row, each starting in column 0: the card starts 4 cells in, so a click on the row's second cell reaches xterm even
// while the card covers the rest of the row.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SURFACE_LABEL } from "./attach.mjs";
import {
    lookEval,
    lookOpen,
    lookShot,
    holdRpc,
    polishNap,
    polishWaitFor,
    releaseRpc,
    skipStep,
    waveService,
} from "./scenarios-shared.mjs";

const PEEK_TAB_LABEL = "code peek";
const PEEK_WAIT_MS = 15_000;
const CTRL = 2;
const PEEK_MD_LINES = 15;
const COMMITTED_LINES = 40;
const ERROR_STUB = "peek stub: the read was refused";
const PEEK_URL = "https://github.com/a/b/README.md";
const NOT_TRACKED = "Not a git repository — no change tracking";
const PREVIEW_REASON = "Preview is for markdown files";
// rows the shell's prompt and a stray blank line can take beside the printed rows
const ROW_SLACK = 3;
// a 1x1 png: the peek classifies by mime, so the bytes only need to be a real image
const PIXEL_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const MORE_LINES = 5;
const RENDERER_SETTLE_MS = 1500;

const git = (cwd, ...args) =>
    execFileSync("git", ["-c", "user.name=verify", "-c", "user.email=verify@example.com", "-c", "core.autocrlf=false", ...args], {
        cwd,
        stdio: "pipe",
    });

function makeRepo(dir) {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "notes"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, "big"), { recursive: true });
    const committed = Array.from({ length: COMMITTED_LINES + 10 }, (_, i) => `export const line${i + 1} = ${i + 1};`);
    writeFileSync(join(dir, "src", "committed.ts"), committed.join("\n") + "\n");
    git(dir, "init", "-q");
    git(dir, "add", "src/committed.ts");
    git(dir, "commit", "-q", "-m", "seed");
    // two lines changed and one removed, so the stat has both a + and a −
    const changed = committed.filter((_, i) => i !== 5).map((l, i) => (i === 2 || i === 3 ? `${l} // changed` : l));
    writeFileSync(join(dir, "src", "committed.ts"), changed.join("\n") + "\n");
    const md = [
        "# Code peek",
        "",
        "Peek a file an agent wrote without leaving the Agent surface.",
        "",
        "## Trigger",
        "- Ctrl+click a file path in the agent's terminal.",
        "- The path resolves against the agent's working directory.",
        "",
        "## Behavior",
        "- Opens read-only; the Code surface keeps its own open file.",
        "- `Enter` opens the file in Code at the same line.",
        "- `Esc` closes the peek and returns focus to the terminal.",
        "",
        "## Out of scope",
        "- Editing inside the peek.",
    ];
    writeFileSync(join(dir, "notes", "peek.md"), md.slice(0, PEEK_MD_LINES).join("\n") + "\n");
    git(dir, "add", "notes/peek.md");
    writeFileSync(join(dir, "bin", "blob.bin"), Buffer.from([0x41, 0, 0x42, 0, 0, 0x43]));
    writeFileSync(join(dir, "bin", "pixel.png"), Buffer.from(PIXEL_PNG_B64, "base64"));
    writeFileSync(join(dir, "big", "huge.txt"), "x".repeat(2 * 1024 * 1024 + 4096));
}

// the rows the shell prints, each `<path> #<tag>`; tags find a row in the buffer
function peekRows(plainAbs, filler) {
    const rows = [
        ["notes/peek.md", "md"],
        ["src/committed.ts", "ts"],
        ["src/committed.ts:30", "line"],
        ["gone/missing.ts", "missing"],
        ["bin/blob.bin", "bin"],
        ["bin/pixel.png", "png"],
        ["big/huge.txt", "big"],
        ["~/x.md", "tilde"],
        [plainAbs, "plain"],
        [PEEK_URL, "url"],
    ];
    const lines = rows.map(([p, t]) => `${p} #${t}`);
    for (let i = 0; i < filler; i++) lines.push(`filler ${i + 1}`);
    lines.push("src/committed.ts #last");
    return lines;
}

// in-page: the visible terminal's TermWrap (through TerminalView's model prop), a tagged row's cells, the card
const PEEK_LIB = `
    const termWrap = () => {
        const view = [...document.querySelectorAll("[data-term-view]")].find((v) => v.checkVisibility());
        if (!view) return null;
        const key = Object.keys(view).find((k) => k.startsWith("__reactFiber$"));
        for (let f = view[key]; f; f = f.return) {
            const tw = f.memoizedProps?.model?.termRef?.current;
            if (tw?.terminal) return tw;
        }
        return null;
    };
    const screenEl = () => termWrap()?.terminal.element?.querySelector(".xterm-screen") ?? null;
    const rowOf = (tag) => {
        const b = termWrap()?.terminal.buffer.active;
        let hit = null;
        for (let y = 0; b && y < b.length; y++) {
            const s = b.getLine(y)?.translateToString(true) ?? "";
            if (s.endsWith(" #" + tag)) hit = { y, text: s };
        }
        return hit;
    };
    // the row's second cell, inside its path and left of where the card starts
    const cellOf = (tag) => {
        const r = rowOf(tag);
        const tw = termWrap();
        const sc = screenEl();
        if (!r || !tw || !sc) return null;
        const t = tw.terminal;
        const s = sc.getBoundingClientRect();
        const cw = s.width / t.cols;
        const ch = s.height / t.rows;
        const row = r.y - t.buffer.active.viewportY;
        if (row < 0 || row >= t.rows) return null;
        return { bufferLine: r.y, row, x: Math.round(s.left + 1.5 * cw), y: Math.round(s.top + (row + 0.5) * ch), top: s.top + row * ch, bottom: s.top + (row + 1) * ch, ch };
    };
    const card = () => document.querySelector("[data-code-peek]");
    const visibleTextarea = () => [...document.querySelectorAll(".xterm-helper-textarea")].find((x) => x.checkVisibility()) ?? null;
    const rectOf = (el) => { const r = el?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null; };
    const peekInfo = () => {
        const c = card();
        if (!c) return { count: 0, modes: {}, stat: "", message: "" };
        const p = c.querySelector("[data-peek-path]");
        return {
            count: document.querySelectorAll("[data-code-peek]").length,
            state: c.dataset.peekState,
            side: c.dataset.peekSide,
            rect: rectOf(c),
            path: flat(p),
            title: p?.title ?? null,
            readOnly: /Read-only/.test(flat(c)),
            stat: flat(c.querySelector("[data-peek-stat]")),
            message: flat(c.querySelector("[data-peek-message]")),
            focused: c.contains(document.activeElement),
            modes: Object.fromEntries([...c.querySelectorAll("[data-peek-mode]")].map((b) => [b.dataset.peekMode, { pressed: b.getAttribute("aria-pressed") === "true", disabled: b.disabled, title: b.title }])),
        };
    };
`;
const TERM_READY = `(() => { ${PEEK_LIB} return termWrap() != null; })()`;
const RAIL_LIB = `const { loadRailForAgent, railVisibleAtom } = await mod("app/view/agents/railstore.ts"); const { globalStore } = await mod("app/store/jotaiStore.ts");`;
const peekEval = (h, body) => lookEval(h, `${PEEK_LIB} ${body}`);
const cellOf = (h, tag) => peekEval(h, `return cellOf(${JSON.stringify(tag)});`);
const peekInfo = (h) => peekEval(h, `return peekInfo();`);

async function mouse(h, type, x, y, modifiers = 0) {
    const click = type === "mouseMoved" ? {} : { button: "left", clickCount: 1 };
    await h.cdp("Input.dispatchMouseEvent", { type, x, y, modifiers, ...click });
}

// xterm resolves the link on the move, then activates it on a press and release over the same link
async function ctrlClick(h, at) {
    await moveOff(h, at.row);
    await mouse(h, "mouseMoved", at.x + 3, at.y, CTRL);
    await polishNap(80);
    await mouse(h, "mouseMoved", at.x, at.y, CTRL);
    await polishNap(150);
    await mouse(h, "mousePressed", at.x, at.y, CTRL);
    await mouse(h, "mouseReleased", at.x, at.y, CTRL);
}

// a plain cell on another row, so the next move over a link is a fresh hover: xterm skips a move that stays in the
// cell it last saw. Column 2 sits left of the card, so xterm sees the move even while the card is open
async function moveOff(h, row = -1) {
    const at = await peekEval(h, `
        const t = termWrap()?.terminal;
        const s = screenEl()?.getBoundingClientRect();
        if (!t || !s) return null;
        const r = ${JSON.stringify(row)} === 12 ? 13 : 12;
        return { x: Math.round(s.left + 2.5 * (s.width / t.cols)), y: Math.round(s.top + (r + 0.5) * (s.height / t.rows)) };
    `);
    if (at) await mouse(h, "mouseMoved", at.x, at.y, 0);
    await polishNap(120);
}

// Ctrl+click the row tagged `tag` and wait for the card to reach a state that is not `notState`
async function peekAt(h, tag, until = `peekInfo().count > 0 && peekInfo().state !== "loading"`) {
    const at = await cellOf(h, tag);
    if (at == null) return { at, info: { count: 0, modes: {}, stat: "", message: "" } };
    await ctrlClick(h, at);
    await peekEval(h, `await until(() => ${until}, 5000);`);
    await polishNap(250);
    return { at, info: await peekInfo(h) };
}

const ESCAPE = { key: "Escape", code: "Escape", keyCode: 27 };
const ENTER = { key: "Enter", code: "Enter", keyCode: 13 };

// as tui-leader does: a window capture probe added after the keybinding dispatcher sees only the keys it left alone
async function pressKey(h, { key, code, keyCode }) {
    await h.ev(`(() => {
        window.__peekSeen = [];
        if (!window.__peekProbe) {
            window.__peekProbe = (e) => window.__peekSeen.push(e.key);
            window.addEventListener("keydown", window.__peekProbe, true);
        }
    })()`);
    for (const type of ["keyDown", "keyUp"]) {
        await h.cdp("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode });
    }
    await polishNap(450);
    return JSON.parse(await h.ev("JSON.stringify(window.__peekSeen || [])"));
}

// a plain click left of the card, which xterm answers by focusing its textarea
async function focusTerminal(h) {
    await moveOff(h);
    const at = await peekEval(h, `
        const t = termWrap()?.terminal;
        const s = screenEl()?.getBoundingClientRect();
        return t && s ? { x: Math.round(s.left + 2.5 * (s.width / t.cols)), y: Math.round(s.top + 12.5 * (s.height / t.rows)) } : null;
    `);
    if (at) {
        await mouse(h, "mousePressed", at.x, at.y, 0);
        await mouse(h, "mouseReleased", at.x, at.y, 0);
    }
    await polishNap(200);
}

const closePeekByButton = (h) =>
    peekEval(h, `card()?.querySelector('button[aria-label="Close the peek"]')?.click(); return until(() => card() == null, 3000);`);

const typeLine = (h, ctx, text) =>
    h.rpc("controllerinput", { blockid: ctx.blockId, inputdata64: Buffer.from(text + "\r").toString("base64") });

const publishWorking = (h, ctx) =>
    h.rpc("eventpublish", {
        event: "agent:status",
        scopes: [`block:${ctx.blockId}`],
        persist: 1,
        data: { oref: `block:${ctx.blockId}`, state: "working", agent: "claude", cwd: ctx.repo, ts: Date.now() },
    });

const shotName = (n) => lookShot(`code-peek-${n}`);

export const codePeek = {
    name: "code-peek",
    surface: "agent",
    async arrange(h) {
        const ctx = {};
        try {
            ctx.repo = mkdtempSync(join(tmpdir(), "verify-peek-repo-"));
            ctx.plainDir = mkdtempSync(join(tmpdir(), "verify-peek-plain-"));
            makeRepo(ctx.repo);
            ctx.plainAbs = join(ctx.plainDir, "plain.ts");
            writeFileSync(ctx.plainAbs, "export const plain = true;\n");
            const bootTab = String(await h.ev("window.TabRpcClient.routeId")).replace(/^tab:/, "");
            const wslist = await h.rpc("workspacelist", null);
            const ws = wslist.find((w) => (w.workspacedata?.tabids ?? []).includes(bootTab)) ?? wslist[0];
            ctx.workspaceId = ws.workspacedata.oid;
            ctx.tabId = await waveService(h, "workspace", "CreateTab", [ctx.workspaceId, PEEK_TAB_LABEL, false]);
            const tab = await waveService(h, "object", "GetObject", [`tab:${ctx.tabId}`]);
            ctx.blockId = tab?.blockids?.[0];
            if (!ctx.blockId) throw new Error("the new tab has no block");
            // the shell starts in ~ and cds into the repo once it is up; teardown cds back out, or the shell would
            // hold the repo dir and it could not be removed
            await h.rpc("setmeta", { oref: `block:${ctx.blockId}`, meta: { view: "term", controller: "shell", "cmd:cwd": "~" } });
            await publishWorking(h, ctx);
        } catch (e) {
            ctx.launchError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const first = "Ctrl held over a path shows the pointer, the underline, the accent and the hint";
        if (ctx.launchError != null) return [skipStep(first, `could not verify: the arrange failed: ${ctx.launchError}`)];
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        await lookOpen(h, "agent");
        const row = `document.querySelector('[data-agent-tree] [data-tree-agent="${ctx.tabId}"]')`;
        const inRoster = await polishWaitFor(h, `!!${row}`, PEEK_WAIT_MS);
        if (!inRoster) return [skipStep(first, "could not verify: the shell tab never joined the roster as an agent")];
        await h.ev(`${row}?.click()`);
        const ready = await polishWaitFor(h, TERM_READY, PEEK_WAIT_MS);
        if (!ready) return [skipStep(first, "could not verify: the agent's terminal never became visible")];
        // the shell's banner and first prompt land before the cls, so the rows print from the top
        await polishNap(2500);
        const termRows = await peekEval(h, `return termWrap().terminal.rows;`);
        const filler = Math.max(0, termRows - 11 - ROW_SLACK);
        ctx.linesFile = join(ctx.plainDir, "lines.txt");
        writeFileSync(ctx.linesFile, peekRows(ctx.plainAbs, filler).join("\n") + "\n");
        ctx.moreFile = join(ctx.plainDir, "more.txt");
        writeFileSync(ctx.moreFile, Array.from({ length: MORE_LINES }, (_, i) => `more ${i + 1}`).join("\n") + "\n");
        // the shell reports its cwd (OSC 7) into cmd:cwd, which the peek resolves against
        await typeLine(h, ctx, `cd -LiteralPath '${ctx.repo}'; cls; Get-Content -LiteralPath '${ctx.linesFile}'`);
        ctx.cdIn = true;
        const printed = await polishWaitFor(h, `(() => { ${PEEK_LIB} return rowOf("last") != null; })()`, PEEK_WAIT_MS);
        if (!printed) return [skipStep(first, "could not verify: the shell never printed the path rows")];
        await polishNap(800);
        // the rail reads the agent's cwd once per focus, which was ~ until the shell cd'd: read it again
        ctx.railWas = await lookEval(h, `${RAIL_LIB} const was = globalStore.get(railVisibleAtom); globalStore.set(railVisibleAtom, true); await loadRailForAgent(${JSON.stringify(ctx.tabId)}, undefined, ${JSON.stringify(ctx.blockId)}); return was;`);
        await polishNap(1500);

        // 1. [Trigger] on the DOM renderer, so the cells are readable
        // a renderer switch changes the cell width, so the terminal refits and the shell redraws: let it settle
        await peekEval(h, `termWrap().setTermRenderer("dom"); await nap(${RENDERER_SETTLE_MS});`);
        const md = await cellOf(h, "md");
        const triggerRead = `
            const sc = screenEl();
            const c = cellOf("md");
            const accent = getComputedStyle(document.documentElement).getPropertyValue("--color-accent-soft").trim();
            const probe = document.createElement("span");
            probe.style.color = accent;
            document.body.appendChild(probe);
            const accentRgb = getComputedStyle(probe).color;
            probe.remove();
            const rowEl = sc?.querySelectorAll(".xterm-rows > div")[c.row];
            const spans = [...(rowEl?.querySelectorAll("span") ?? [])];
            // a decorated cell is drawn as its own span
            const linkSpans = spans.slice(0, "notes/peek.md".length);
            const hint = document.querySelector("[data-peek-hint]");
            return {
                pointer: sc?.classList.contains("xterm-cursor-pointer") ?? false,
                hint: hint ? flat(hint).replace(/\\s+/g, " ") : null,
                underline: linkSpans.length > 0 && linkSpans.every((s) => getComputedStyle(s).textDecorationLine.includes("underline")),
                recolor: linkSpans.length > 0 && linkSpans.every((s) => getComputedStyle(s).color === accentRgb),
                accentRgb,
                spans: linkSpans.map((s) => ({ text: s.textContent, cls: s.className, color: getComputedStyle(s).color })),
            };
        `;
        await moveOff(h, md.row);
        await mouse(h, "mouseMoved", md.x, md.y, 0);
        await polishNap(400);
        const plain = await peekEval(h, triggerRead);
        await moveOff(h, md.row);
        await mouse(h, "mouseMoved", md.x, md.y, CTRL);
        await polishNap(400);
        const held = await peekEval(h, triggerRead);
        await h.shot(shotName("1-trigger"));
        rec(first, held.pointer && held.hint === "Ctrl + click to peek" && held.underline && held.recolor, held);
        rec("without Ctrl there is no hint, no underline and no recolor", !plain.pointer && plain.hint == null && !plain.underline && !plain.recolor, plain);
        await moveOff(h);
        await peekEval(h, `termWrap().setTermRenderer("webgl"); await nap(${RENDERER_SETTLE_MS});`);

        // 2. [Main, AgentShell]
        const opened = await peekAt(h, "md");
        const main = await peekEval(h, `
            const c = cellOf("md");
            const band = document.querySelector("[data-peek-line]");
            const pane = card()?.closest("[data-term-view]");
            const tree = document.querySelector("[data-agent-tree]");
            const rail = [...document.querySelectorAll("h3")].find((x) => flat(x) === "Files touched" && x.checkVisibility());
            const railRow = [...document.querySelectorAll("button, div")].find((x) => x.checkVisibility() && [...x.children].some((s) => flat(s) === "notes/peek.md") && x.closest("[data-code-peek]") == null);
            const railAdds = railRow ? [...railRow.children].map(flat).find((t) => /^\\+\\d+$/.test(t)) : null;
            return { line: c, band: rectOf(band), pane: rectOf(pane), tree: tree?.checkVisibility() ?? false, rail: rail != null, railAdds };
        `);
        await h.shot(shotName("2-main"));
        const info2 = opened.info;
        const r2 = info2.rect;
        rec(
            "Ctrl+click opens one card below the line, with the line band on that row",
            info2.count === 1 && info2.side === "below" && r2 && r2.top >= main.line.bottom - 0.5 && main.band && Math.abs(main.band.top - main.line.top) <= 1,
            { info: info2, main }
        );
        rec("the card's header reads notes/peek.md and Read-only", info2.path === "notes/peek.md" && info2.readOnly, info2);
        rec(
            "the card lies within the terminal pane",
            r2 && main.pane && r2.top >= main.pane.top && r2.bottom <= main.pane.bottom && r2.left >= main.pane.left && r2.right <= main.pane.right,
            { card: r2, pane: main.pane }
        );
        rec(
            "the tree and the details rail stay beside it, and the rail's notes/peek.md row shows the card's +15",
            main.tree && main.rail && main.railAdds === "+15" && info2.stat.includes("+15"),
            { tree: main.tree, rail: main.rail, railAdds: main.railAdds, stat: info2.stat }
        );
        rec("opening the card focuses it", info2.focused, info2);

        // 3. [PeekPanel Preview]
        const preview = await peekEval(h, `
            await until(() => card()?.querySelector(".heading") != null, 3000);
            return { headings: [...(card()?.querySelectorAll(".heading") ?? [])].map(flat) };
        `);
        await h.shot(shotName("3-preview"));
        rec(
            "a markdown file opens on Preview, with rendered headings and the stat new file +15",
            info2.modes.preview?.pressed && preview.headings.includes("Code peek") && /new file/.test(info2.stat) && /\+15/.test(info2.stat),
            { modes: info2.modes, preview, stat: info2.stat }
        );

        // 4. [PeekPanel Source]
        const source = await peekEval(h, `
            card()?.querySelector('[data-peek-mode="source"]')?.click();
            await until(() => card()?.querySelector(".monaco-editor .line-numbers") != null, 6000);
            await nap(300);
            const ed = card()?.querySelector(".monaco-editor");
            return {
                pressed: peekInfo().modes.source?.pressed,
                lineNumbers: [...(ed?.querySelectorAll(".line-numbers") ?? [])].length,
                readOnly: ed?.querySelector("textarea")?.readOnly ?? ed?.querySelector(".native-edit-context")?.getAttribute("aria-readonly") === "true",
            };
        `);
        await h.shot(shotName("4-source"));
        rec("Source shows a read-only Monaco editor with line numbers", source.pressed && source.lineNumbers > 0 && source.readOnly !== false, source);

        // 5. [PeekPanel Diff]
        const diff = await peekEval(h, `
            card()?.querySelector('[data-peek-mode="diff"]')?.click();
            await until(() => card()?.querySelector(".monaco-editor .line-insert") != null, 6000);
            await nap(400);
            const ed = card()?.querySelector(".monaco-editor");
            return {
                pressed: peekInfo().modes.diff?.pressed,
                caption: /New file, not in HEAD/.test(flat(card())),
                lines: ed?.querySelectorAll(".view-line").length ?? 0,
                inserted: ed?.querySelectorAll(".view-overlays .line-insert").length ?? 0,
                removed: card()?.querySelectorAll(".line-delete, .inline-deleted-margin-view-zone").length ?? 0,
            };
        `);
        await h.shot(shotName("5-diff"));
        // a file not in HEAD has nothing removed: monaco's diff against "" drew an empty removed line 1
        rec(
            "Diff shows New file, not in HEAD, every line inserted and no removed line",
            diff.pressed && diff.caption && diff.lines > 0 && diff.inserted === diff.lines && diff.removed === 0,
            diff
        );

        // 6. toggle
        await ctrlClick(h, await cellOf(h, "md"));
        const closedByToggle = await peekEval(h, `return until(() => card() == null, 3000);`);
        const reopened = await peekAt(h, "md");
        rec("Ctrl+click on the same path closes the card, and again reopens it", closedByToggle && reopened.info.count === 1, { closedByToggle, reopened: reopened.info });

        // 7. move
        const moved = await peekAt(h, "ts", `peekInfo().path === "src/committed.ts" && peekInfo().state !== "loading"`);
        await h.shot(shotName("7-moved"));
        const i7 = moved.info;
        rec(
            "Ctrl+click on src/committed.ts moves the card: one card, on Source, Preview disabled with its reason, a + and − stat",
            i7.count === 1 &&
                i7.path === "src/committed.ts" &&
                i7.modes.source?.pressed &&
                i7.modes.preview?.disabled &&
                i7.modes.preview?.title === PREVIEW_REASON &&
                /\+\d+/.test(i7.stat) &&
                /−\d+/.test(i7.stat),
            i7
        );

        // 8. :line
        await peekAt(h, "line");
        const line30 = await peekEval(h, `
            await until(() => card()?.querySelector(".monaco-editor .line-numbers") != null, 6000);
            await nap(400);
            const nums = [...(card()?.querySelectorAll(".monaco-editor .line-numbers") ?? [])].map(flat);
            return { state: peekInfo().state, source: peekInfo().modes.source?.pressed, nums, active: flat(card()?.querySelector(".line-numbers.active-line-number")) };
        `);
        await h.shot(shotName("8-line"));
        rec("src/committed.ts:30 opens on Source with line 30 in view", line30.source && line30.nums.includes("30"), line30);

        // 9. loading
        await holdRpc(h, "FileInfoCommand");
        const loading = await peekAt(h, "missing", `peekInfo().state === "loading"`);
        await h.shot(shotName("9-loading"));
        await releaseRpc(h, "FileInfoCommand");
        rec("a read still in flight shows the loading state", loading.info.state === "loading" && /^Reading /.test(loading.info.message), loading.info);
        await closePeekByButton(h);

        // 10. missing, binary, too large
        const missing = await peekAt(h, "missing");
        rec("a path that does not exist shows missing", missing.info.state === "missing" && missing.info.message === `No such file: ${join(ctx.repo, "gone", "missing.ts")}`, missing.info);
        await h.shot(shotName("10-missing"));
        const binary = await peekAt(h, "bin");
        rec("a binary file shows binary", binary.info.state === "binary" && binary.info.message === "Binary file", binary.info);
        await h.shot(shotName("10-binary"));
        const png = await peekAt(h, "png");
        rec("an image file hints that Code shows it", png.info.state === "binary" && png.info.message === "Image — open it in Code", png.info);
        await h.shot(shotName("10-image"));
        const big = await peekAt(h, "big");
        rec("a file over 2 MB shows too large", big.info.state === "toolarge" && big.info.message === "Larger than the 2 MB view limit", big.info);
        await h.shot(shotName("10-toolarge"));

        // 11. ~
        const tilde = await peekAt(h, "tilde");
        rec("~/x.md resolves against home", tilde.info.state === "missing" && tilde.info.message === `No such file: ${join(homedir(), "x.md")}`, tilde.info);
        await h.shot(shotName("11-tilde"));

        // 12. error
        await peekEval(h, `
            const { RpcApi } = await mod("app/store/wshclientapi.ts");
            (window.__heldRpc ??= {}).FileReadCommand ??= RpcApi.FileReadCommand;
            RpcApi.FileReadCommand = () => Promise.reject(new Error(${JSON.stringify(ERROR_STUB)}));
        `);
        await closePeekByButton(h);
        const failed = await peekAt(h, "ts");
        await releaseRpc(h, "FileReadCommand");
        rec("a read that fails shows the error with its message", failed.info.state === "error" && failed.info.message === ERROR_STUB, failed.info);
        await h.shot(shotName("12-error"));

        // 13. non-repo
        const plainPeek = await peekAt(h, "plain");
        rec(
            "an absolute path outside a repository opens with Diff disabled as not tracked",
            plainPeek.info.state === "text" && plainPeek.info.modes.diff?.disabled && plainPeek.info.modes.diff?.title === NOT_TRACKED,
            plainPeek.info
        );
        await h.shot(shotName("13-norepo"));

        // 14. last rows
        const last = await peekAt(h, "last");
        const lastLine = await cellOf(h, "last");
        rec(
            "a path on the last rows opens the card above the line",
            last.info.side === "above" && last.info.rect && lastLine && last.info.rect.bottom <= lastLine.top + 0.5,
            { info: last.info, line: lastLine }
        );
        await h.shot(shotName("14-above"));

        // 15. the card rides its line
        const before = { card: last.info.rect, line: lastLine };
        await typeLine(h, ctx, `Get-Content -LiteralPath '${ctx.moreFile}'`);
        await peekEval(h, `await until(() => termWrap().terminal.buffer.active.getLine(termWrap().terminal.buffer.active.length - 2)?.translateToString(true).startsWith("more ${MORE_LINES}") || /more ${MORE_LINES}/.test(flat(screenEl())), 5000);`);
        await polishNap(600);
        const after = { card: (await peekInfo(h)).rect, line: await cellOf(h, "last") };
        const shiftRows = before.line && after.line ? before.line.row - after.line.row : null;
        const cardShift = before.card && after.card ? before.card.top - after.card.top : null;
        rec(
            `printing ${MORE_LINES} more lines moves the card with its line`,
            shiftRows != null && shiftRows >= MORE_LINES && cardShift != null && Math.abs(cardShift - shiftRows * before.line.ch) <= 1,
            { shiftRows, cardShift, rowHeight: before.line?.ch, before, after }
        );
        await h.shot(shotName("15-scrolled"));
        // the first rows scrolled off with those lines; the rest of the steps click them
        await peekEval(h, `termWrap().terminal.scrollToTop(); await nap(300);`);

        // 16. the Code surface's file is untouched
        const codeFile = `const { codeFileAtom } = await mod("app/view/code/codestore.ts"); const { globalStore } = await mod("app/store/jotaiStore.ts"); return JSON.stringify(globalStore.get(codeFileAtom));`;
        await closePeekByButton(h);
        const fileBefore = await peekEval(h, codeFile);
        const peekedMd = (await peekAt(h, "md")).info;
        const peekedTs = (await peekAt(h, "ts")).info;
        const fileAfter = await peekEval(h, codeFile);
        rec(
            "peeking leaves the Code surface's open file unchanged",
            peekedMd.state === "text" && peekedTs.state === "text" && fileBefore === fileAfter,
            { md: peekedMd.state, ts: peekedTs.state, fileBefore: fileBefore.slice(0, 200), fileAfter: fileAfter.slice(0, 200) }
        );

        // 17. close returns focus to the terminal
        const closed = await peekEval(h, `
            card()?.querySelector('button[aria-label="Close the peek"]')?.click();
            const gone = await until(() => card() == null, 3000);
            await nap(150);
            const ta = [...document.querySelectorAll(".xterm-helper-textarea")].find((x) => x.checkVisibility());
            return { gone, focused: ta != null && document.activeElement === ta };
        `);
        rec("the close button closes the card and gives the terminal its focus back", closed.gone && closed.focused, closed);
        await h.shot(shotName("17-closed"));

        // 18. Open in Code
        await peekAt(h, "line");
        const landed = await peekEval(h, `
            card()?.querySelector("[data-peek-open]")?.click();
            const { codeFileAtom, codePendingJumpAtom } = await mod("app/view/code/codestore.ts");
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            await until(() => globalStore.get(codeFileAtom)?.path === "src/committed.ts" && globalStore.get(codeFileAtom)?.kind === "text", 8000);
            await until(() => flat(document.querySelector(".line-numbers.active-line-number")) === "30" || globalStore.get(codePendingJumpAtom)?.line === 30, 4000);
            // the card closes once the landing resolves, a moment after the file shows
            await until(() => card() == null, 3000);
            return {
                file: globalStore.get(codeFileAtom)?.path ?? null,
                pending: globalStore.get(codePendingJumpAtom)?.line ?? null,
                caret: flat(document.querySelector(".line-numbers.active-line-number")),
                peekClosed: card() == null,
            };
        `);
        await h.shot(shotName("18-code"));
        rec(
            "Open in Code lands on src/committed.ts at line 30 and closes the peek",
            landed.file === "src/committed.ts" && (landed.pending === 30 || landed.caret === "30") && landed.peekClosed,
            landed
        );
        await h.goto("agent");
        await h.ev(`${row}?.click()`);
        await polishWaitFor(h, TERM_READY, PEEK_WAIT_MS);
        await polishNap(400);

        // 19. a URL stays a web link
        await peekEval(h, `window.__openExternal = window.api.openExternal; window.__opened = []; window.api.openExternal = (u) => window.__opened.push(u);`);
        const urlAt = await cellOf(h, "url");
        if (urlAt) await ctrlClick(h, urlAt);
        await polishNap(600);
        const url = await peekEval(h, `const r = { cards: document.querySelectorAll("[data-code-peek]").length, opened: window.__opened }; window.api.openExternal = window.__openExternal; return r;`);
        rec("Ctrl+click on a URL opens no card (the web link takes it)", urlAt != null && url.cards === 0, url);

        // 20. Esc closes the focused card; Esc in the terminal goes to the agent
        await peekAt(h, "md");
        const escCard = await peekInfo(h);
        const escSeen = await pressKey(h, ESCAPE);
        const escClosed = await peekEval(h, `
            const gone = await until(() => card() == null, 3000);
            await nap(150);
            return { gone, focused: document.activeElement === visibleTextarea() };
        `);
        await peekAt(h, "md");
        await focusTerminal(h);
        const termFocused = await peekEval(h, `return document.activeElement === visibleTextarea();`);
        const termSeen = await pressKey(h, ESCAPE);
        const stays = await peekInfo(h);
        await h.shot(shotName("20-esc"));
        rec(
            "Esc in the focused card closes it and focuses the terminal; Esc in the terminal reaches the agent and leaves the card open",
            escCard.focused && escClosed.gone && escClosed.focused && termFocused && stays.count === 1 && termSeen.includes("Escape"),
            { cardFocused: escCard.focused, cardEscSeen: escSeen, escClosed, termFocused, termEscSeen: termSeen, stays: stays.count }
        );
        await closePeekByButton(h);
        // the Esc typed into the terminal scrolled it to the bottom, past the rows the next step clicks
        await peekEval(h, `termWrap().terminal.scrollToTop(); await nap(300);`);

        // 21. Enter opens the file in Code
        const enterAt = await peekAt(h, "line");
        const enterSeen = await pressKey(h, ENTER);
        const entered = await peekEval(h, `
            const { codeFileAtom, codePendingJumpAtom } = await mod("app/view/code/codestore.ts");
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            await until(() => globalStore.get(codeFileAtom)?.path === "src/committed.ts" && globalStore.get(codeFileAtom)?.kind === "text", 8000);
            await until(() => flat(document.querySelector(".line-numbers.active-line-number")) === "30" || globalStore.get(codePendingJumpAtom)?.line === 30, 4000);
            await until(() => card() == null, 3000);
            return {
                file: globalStore.get(codeFileAtom)?.path ?? null,
                pending: globalStore.get(codePendingJumpAtom)?.line ?? null,
                caret: flat(document.querySelector(".line-numbers.active-line-number")),
                peekClosed: card() == null,
            };
        `);
        const surface = await h.activeSurfaceLabel();
        await h.shot(shotName("21-enter"));
        rec(
            "Enter in the card opens src/committed.ts in Code at line 30 and closes the peek",
            enterAt.info.focused &&
                surface === SURFACE_LABEL.code &&
                entered.file === "src/committed.ts" &&
                (entered.pending === 30 || entered.caret === "30") &&
                entered.peekClosed,
            { cardFocused: enterAt.info.focused, enterSeen, surface, ...entered }
        );
        return steps;
    },
    async teardown(h, ctx) {
        await mouse(h, "mouseMoved", 1, 1, 0).catch(() => {});
        await h.ev(`window.__peekProbe && (window.removeEventListener("keydown", window.__peekProbe, true), delete window.__peekProbe)`).catch(() => {});
        await releaseRpc(h, "FileInfoCommand").catch(() => {});
        await releaseRpc(h, "FileReadCommand").catch(() => {});
        await h.ev(`window.__openExternal && (window.api.openExternal = window.__openExternal)`).catch(() => {});
        await h.ev(`document.querySelector('[data-code-peek] button[aria-label="Close the peek"]')?.click()`).catch(() => {});
        if (ctx.cdIn) {
            await typeLine(h, ctx, "cd ~").catch(() => {});
            await polishNap(800);
        }
        if (ctx.railWas != null) {
            await lookEval(h, `${RAIL_LIB} globalStore.set(railVisibleAtom, ${JSON.stringify(ctx.railWas)});`).catch(() => {});
        }
        if (ctx.tabId) {
            try {
                await waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false]);
            } catch (e) {
                console.error(`code-peek teardown: closing ${ctx.tabId} failed: ${e?.message ?? e}`);
            }
        }
        for (const dir of [ctx.repo, ctx.plainDir]) {
            if (!dir) continue;
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch (e) {
                console.error(`code-peek teardown: removing ${dir} failed: ${e?.message ?? e}`);
            }
        }
        await h.goto("cockpit");
    },
};
