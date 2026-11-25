// Scenario `workspace-changes`: the workspace pane's Changes tab, every changed file in one scroll by folder (Task 3
// of docs/superpowers/plans/2026-11-18-changes-tab-polish.md; board Main), opening collapsed with folder toggles,
// Expand all / Collapse all and step-collapse (docs/superpowers/plans/2026-11-19-changes-collapse-all.md: boards Main,
// Opened, Expanded), so a step that reads a file's body opens it first. The roster is a fixture of two agents backed
// by real tabs with no controller, in the Rendered view: A, a pi agent, whose block names a temp repo holding every
// kind of change the tab draws, and B, a claude agent, whose block names a clean one. The steps open the tab through
// the workspace store, as the header chip does. States the repo cannot produce (a slow or failing patch read) come
// from stubbing RpcApi.GitPatchCommand on the app's own module instance. Teardown restores the stub, closes the
// workspace tabs, the tabs and the roster, and removes the temp dir.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
    agentPage,
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
    pinDefaultView,
    restoreDefaultView,
    restoreRoster,
    setRoster,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { git, polishNap, polishWaitFor, restoreLocalStorage } from "./scenarios-shared.mjs";

const NAME = "workspace-changes";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
// a fresh app's first git reads in a new repo can take a while
const GIT_WAIT_MS = 20_000;
// past the view fade, so a read after it sees the settled body
const SETTLE_MS = 700;
// the Main board is drawn at the pane's default width
const PANE_PX = 600;
const WIDTH_KEY = "agent.workspace.width";
const RECENTS_KEY = "code.project.recents";
// how long the stubbed read holds its reply, so the skeleton has frames to be seen in
const SLOW_READ_MS = 2_000;
const FAIL_MSG = "fixture: the patch read failed";

// the fixture repo, in display order: the root file, then the folders by path
const README = "README.md";
const LOGO = "assets/logo.bin";
const STYLE = "docs/style.md";
const GROUPS = "internal/dedupe/groups.go";
const OLD = "internal/dedupe/old.go";
const COUNTERS = "internal/stats/counters.go";
// untracked entries follow the tracked diff in path order, so the cap cuts only this one
const HUGE = "zz/huge.txt";
const HUGE_BYTES = 2.3 * 1024 * 1024;
// long enough, once opened, that the scroll has room to bring any hunk above it under the headers
const COUNTERS_LINES = 40;
const ORDER = [
    ["", [README]],
    ["assets", [LOGO]],
    ["docs", [STYLE]],
    ["internal/dedupe", [GROUPS, OLD]],
    ["internal/stats", [COUNTERS]],
    ["zz", [HUGE]],
];
// README 1, style 1, groups 2, old 1, counters 1; the binary and the cut file have none
const HUNKS = 6;
// with Hide whitespace the style file's only hunk goes
const HUNKS_NO_WS = 5;

const FUNC_LINE = "func Groups(bs []Bookmark) ([]Group, error) {";
const LATER_LINE = "func Later() string {";
const OLD_MARK = "the key before the fixture";
const NEW_FIRST = "the first key the fixture adds";
const NEW_MARK = "the key the fixture settles on";
const RELOAD_MARK = "readme line the reload brings";
// line 12 is the removed OLD_MARK line; NEW_FIRST and NEW_MARK take new lines 12 and 13, so the context line after
// them is old 13, new 14. The hunk starts 3 lines above, at 9: the line Open in Code lands on
const OLD_NO = "12";
const NEW_NO = "13";
const CONTEXT_NO = "14";
const FIRST_HUNK_LINE = 9;

const groupsSeed = [
    "package dedupe",
    "",
    "// Groups the bookmarks by URL.",
    FUNC_LINE,
    "\tbyKey := map[string]int{}",
    "\tout := []Group{}",
    "\tfor _, b := range bs {",
    "\t\t_ = b",
    "\t}",
    "\tn := len(out)",
    "\t_ = n",
    `\tk := "${OLD_MARK}"`,
    "\t_ = k",
    "\treturn out, nil",
    "}",
    // far enough down that the second edit is its own hunk; comments never read as a function line
    ...Array.from({ length: 64 }, (_, i) => `// filler ${i}`),
    LATER_LINE,
    "\ta := 1",
    "\tb := 2",
    "\tc := 3",
    '\treturn "later before"',
    "}",
];
const groupsEdited = groupsSeed
    .flatMap((l) => (l.includes(OLD_MARK) ? [`\tk := "${NEW_FIRST}"`, `\tk = "${NEW_MARK}"`] : [l]))
    .map((l) => (l.includes("later before") ? '\treturn "later after"' : l));
const readmeSeed = ["# demo", "", ...Array.from({ length: 10 }, (_, i) => `readme line ${i + 3}`)];
const readmeEdited = readmeSeed.map((l) => (l === "readme line 5" ? "readme line 5, edited" : l));
const readmeReloaded = readmeEdited.map((l) => (l === "readme line 6" ? RELOAD_MARK : l));
const lines = (ls) => ls.join("\n") + "\n";

const TAB = `document.querySelector("[data-workspace-changes]")`;
const OTHER_FILE = { kind: "file", path: README, line: null };

// page helpers spliced into each evaluated body
const LIB = `
    const W = await mod("app/view/agents/workspacestore.ts");
    const Api = await mod("app/store/wshclientapi.ts");
    const ws = (id) => globalStore.get(W.workspaceAtom(id));
    const tab = () => ${TAB};
    const scroller = () => tab()?.querySelector("[data-workspace-changes-scroll]");
    const block = (p) => tab()?.querySelector('[data-changes-file="' + CSS.escape(p) + '"]');
    const header = (p) => block(p)?.querySelector("[data-changes-toggle]")?.parentElement;
    const toggle = (p) => block(p)?.querySelector("[data-changes-toggle]")?.click();
    const isOpen = (p) => block(p)?.dataset.changesOpen != null;
    // the tab opens collapsed: a step that reads a file's body opens it first, through its header
    const ensureOpen = async (...ps) => {
        for (const p of ps) if (!isOpen(p)) toggle(p);
        await nap(100);
    };
    const folder = (dir) => tab()?.querySelector('[data-changes-group="' + CSS.escape(dir) + '"] [data-changes-folder]');
    const toggleAll = () => tab()?.querySelector("[data-changes-toggle-all]");
    // per group, in order: each list box as its files, each open card as "card <path>"; a box is drawn by its rows'
    // edges, so a closed row that starts a run starts a box
    const segments = () =>
        [...(tab()?.querySelectorAll("[data-changes-group]") ?? [])].map((g) => [
            g.dataset.changesGroup,
            [...g.querySelectorAll("[data-changes-file]")].reduce((boxes, r) => {
                const p = r.dataset.changesFile;
                if (r.dataset.changesOpen != null) boxes.push("card " + p);
                else if (r.dataset.changesRunStart != null) boxes.push([p]);
                else boxes.at(-1).push(p);
                return boxes;
            }, []),
        ]);
    const folderFacts = () =>
        [...(tab()?.querySelectorAll("[data-changes-folder]") ?? [])].map((b) => ({
            dir: b.closest("[data-changes-group]")?.dataset.changesGroup,
            expanded: b.getAttribute("aria-expanded"),
            turned: b.querySelector("svg")?.classList.contains("rotate-90") ?? false,
        }));
    const counter = () => flat(tab()?.querySelector("[data-changes-counter]"));
    const click = (sel) => tab()?.querySelector(sel)?.click();
    const pressed = () => tab()?.querySelector("[data-changes-ignore-ws]")?.getAttribute("aria-pressed");
    // Shift+<letter> with focus on the surface wrapper, outside every field, as agent-keys presses keys: CDP
    // Input.dispatchKeyEvent often never reaches the WebView
    const press = async (letter) => {
        const wrap = document.querySelector("[data-cockpit-surface-wrap]");
        wrap.focus();
        const key = letter.toUpperCase();
        wrap.dispatchEvent(new KeyboardEvent("keydown", { key, code: "Key" + key, shiftKey: true, bubbles: true, cancelable: true }));
        await nap(150);
    };
    const footerText = () => flat(document.querySelector("[data-hints-footer]"));
    const rect = (el) => {
        const b = el?.getBoundingClientRect();
        return b ? { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) } : null;
    };
    const tabFacts = async () => {
        const R = await mod("app/view/agents/railstore.ts");
        const files = globalStore.get(R.railStateAtom)?.changes?.files ?? [];
        const t = tab();
        const all = (sel) => [...(t?.querySelectorAll(sel) ?? [])];
        return {
            line: flat(t?.querySelector("[data-workspace-changes-line]")),
            rail: (files.length === 1 ? "1 file" : files.length + " files") + " +" + files.reduce((n, f) => n + f.adds, 0) + " −" + files.reduce((n, f) => n + f.dels, 0),
            groups: all("[data-changes-group]").map((g) => [
                g.dataset.changesGroup,
                [...(g.querySelector("[data-changes-folder]")?.children ?? [])].map(flat).filter(Boolean).join(" "),
                [...g.querySelectorAll("[data-changes-file]")].map((b) => b.dataset.changesFile),
            ]),
            open: all("[data-changes-file][data-changes-open]").map((b) => b.dataset.changesFile),
            headers: all("[data-changes-toggle]").length,
            hunks: all("[data-changes-hunk]").length,
            loading: all("[data-changes-loading]").length,
            counter: counter(),
            all: flat(toggleAll()),
            band:flat(t?.querySelector("[data-workspace-changes-patch-failed]")),
            empty: document.querySelector("[data-workspace-changes-empty]")?.dataset.workspaceChangesEmpty ?? null,
        };
    };
    // the hunk's top sits on its file header's bottom, and that header is in the scroller's view
    const underHeader = (p, i) => {
        const h = rect(block(p)?.querySelector('[data-changes-hunk="' + i + '"]'));
        const hd = rect(header(p));
        const s = rect(scroller());
        return h != null && hd != null && s != null && Math.abs(h.top - hd.bottom) <= 2 && hd.top >= s.top - 1;
    };
    // the real read, kept on the window so the step that stubs it and teardown can both put it back
    const stubPatch = (fn) => {
        window.__arcChangesPatchRead ??= Api.RpcApi.GitPatchCommand;
        Api.RpcApi.GitPatchCommand = fn;
    };
    const unstubPatch = () => {
        if (window.__arcChangesPatchRead != null) Api.RpcApi.GitPatchCommand = window.__arcChangesPatchRead;
        delete window.__arcChangesPatchRead;
    };
    // every distinct value read() takes, one read per frame, until stop()
    const sampleFrames = (read) => {
        const values = [];
        let on = true;
        const tick = () => {
            const v = read();
            if (v != null && v !== values.at(-1)) values.push(v);
            if (on) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return { values, stop: () => (on = false) };
    };
`;
const page = (h, body) => agentPage(h, `${LIB} ${body}`);
const facts = (h) => page(h, `return await tabFacts();`);
const openChanges = (h, id) => page(h, `W.openWorkspaceTab(${JSON.stringify(id)}, { kind: "changes", selected: null }); return true;`);
// polls a page condition with the agent page's helpers in scope (mod, globalStore, flat), which a bare
// polishWaitFor expression lacks
async function waitPage(h, cond, ms = WAIT_MS) {
    for (const end = Date.now() + ms; Date.now() < end; await polishNap(250)) {
        if (await page(h, `return !!(${cond});`).catch(() => false)) return true;
    }
    return false;
}
const waitTab = (h, cond, ms = WAIT_MS) => waitPage(h, `await (async () => { const f = await tabFacts(); return ${cond}; })()`, ms);
// the patch is read: the counter counts its hunks, and no open body waits on it. The tab opens collapsed, so no hunk
// need be drawn
const loaded = `f.counter !== "" && f.loading === 0`;
// every file in display order, and each folder's files as one list box
const EVERY = ORDER.flatMap(([, files]) => files);
const ONE_LIST = JSON.stringify(ORDER.map(([dir, files]) => [dir, [files]]));
const DEDUPE = "internal/dedupe";

// what the Diff surface shows: its scope's origin, the file its diff pane draws and the pair it loaded
const diffSurface = (h) =>
    page(
        h,
        `const model = agentsModel();
        const P = await mod("app/view/agents/diffcontentstore.ts");
        const scope = globalStore.get(model.diffScopeAtom);
        return {
            surface: globalStore.get(model.surfaceAtom),
            origin: scope?.repo?.origin ?? null,
            file: flat(document.querySelector("[data-diff-pane] [data-diff-filename]")),
            pair: globalStore.get(P.diffPairAtom)?.path ?? null,
        };`
    );

const rosterAgent = (id, blockId, name, transcriptPath, agent = "claude") => ({
    id,
    name,
    project: name,
    task: "changes tab fixture",
    state: "idle",
    agent,
    model: "claude-opus-5-5",
    blockId,
    transcriptPath,
});

function write(repo, path, data) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), data);
}

function makeRepo(root, name, files) {
    const repo = join(root, name);
    mkdirSync(repo);
    git(repo, "init", "-q", "--initial-branch=main");
    for (const [path, data] of Object.entries(files)) write(repo, path, data);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "seed");
    return repo;
}

// a root edit, a function-context edit and a far second hunk, a whitespace-only edit, a deletion, a modified binary,
// an untracked new file and an untracked file over the patch cap
function makeEditedRepo(root) {
    const repo = makeRepo(root, "edited", {
        [README]: lines(readmeSeed),
        [LOGO]: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2, 3, 0, 4]),
        [STYLE]: lines(["# Style", "", "keep it short"]),
        [GROUPS]: lines(groupsSeed),
        [OLD]: lines(["package dedupe", "", "func Old() {}"]),
    });
    write(repo, README, lines(readmeEdited));
    write(repo, LOGO, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 9, 9, 9, 0, 4, 5]));
    write(repo, STYLE, lines(["# Style", "", "keep  it   short"]));
    write(repo, GROUPS, lines(groupsEdited));
    rmSync(join(repo, OLD));
    write(repo, COUNTERS, lines(["package stats", ...Array.from({ length: COUNTERS_LINES - 1 }, (_, i) => `// counts note ${i}`)]));
    write(repo, HUGE, `${"x".repeat(99)}\n`.repeat(Math.ceil(HUGE_BYTES / 100)));
    return repo;
}

async function arrangeAgentA(h, ctx) {
    await h.goto("agent");
    await pinDefaultView(h, "rendered");
    await setRoster(h, ctx.roster);
    await focusAgent(h, ctx.aId);
    if (!(await polishWaitFor(h, `document.querySelector("[data-rendered-composer]") != null`, WAIT_MS))) {
        throw new Error("agent A never showed the Rendered view");
    }
}

export const workspaceChanges = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-workspace-changes-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            const edited = makeEditedRepo(ctx.dir);
            const clean = makeRepo(ctx.dir, "clean", { "readme.md": "clean\n" });
            ctx.edited = edited;
            const transcripts = join(ctx.dir, "transcripts");
            mkdirSync(transcripts);
            const path = (n, cwd) =>
                writeTranscript(transcripts, `changes-${n}-${tag}`, [
                    userText(`Tidy the ${n} notes.`, { cwd }),
                    assistantText(`The ${n} notes are tidy.`, { cwd }),
                ]);
            // A is a pi agent: a claude agent counts only its transcript's Edit/Write calls, which cannot delete a
            // file, while pi reads the checkout since its session started, so every kind of change reaches the tab.
            // A pi v3 session stamped now, after the seed commit, so the session-start anchor is that commit
            const piPath = (n, cwd) => {
                const ts = new Date().toISOString();
                const lines = [
                    { type: "session", version: 3, id: `fx-${n}-${tag}`, timestamp: ts, cwd },
                    { type: "message", id: "m0", parentId: null, timestamp: ts, message: { role: "user", content: `Tidy the ${n} notes.`, timestamp: Date.now() } },
                ];
                const p = join(transcripts, `changes-${n}-${tag}.jsonl`);
                writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
                return p;
            };
            await h.goto("agent");
            ctx.prev = await page(
                h,
                `return { width: localStorage.getItem(${JSON.stringify(WIDTH_KEY)}), widthAtom: globalStore.get(W.workspaceWidthAtom), recents: localStorage.getItem(${JSON.stringify(RECENTS_KEY)}) };`
            );
            await page(h, `globalStore.set(W.workspaceWidthAtom, ${PANE_PX}); return true;`);
            // the rail reads the block's cwd before the transcript's; no controller, so no shell stamps its own
            const a = await makeTab(h, ctx, { label: `changes-a-${tag}`, blockMeta: { view: "term", controller: null, "cmd:cwd": edited } });
            const b = await makeTab(h, ctx, { label: `changes-b-${tag}`, blockMeta: { view: "term", controller: null, "cmd:cwd": clean } });
            Object.assign(ctx, { aId: a.tabId, bId: b.tabId, aBlockId: a.blockId });
            ctx.roster = [
                rosterAgent(a.tabId, a.blockId, `changes-a-${tag}`, piPath("edited", edited), "pi"),
                rosterAgent(b.tabId, b.blockId, `changes-b-${tag}`, path("clean", clean)),
            ];
            await arrangeAgentA(h, ctx);
        } catch (err) {
            ctx.arrangeError = String(err?.message ?? err);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }
        // one throwing step is one FAIL, not the end of the run
        const step = async (name, fn) => {
            try {
                const [ok, detail] = await fn();
                rec(name, ok, detail);
            } catch (err) {
                rec(name, false, `threw: ${err?.message ?? err}`);
            }
        };
        const A = JSON.stringify(ctx.aId);
        const q = JSON.stringify;

        await step("the summary is the rail's files and totals; root file first, then each folder with its count (Main board)", async () => {
            await openChanges(h, ctx.aId);
            await waitTab(h, `f.line !== "" && ${loaded} && f.counter !== ""`, GIT_WAIT_MS);
            const f = await facts(h);
            const want = ORDER.map(([dir, files]) => [dir, dir === "" ? "" : `${dir}/ ${files.length === 1 ? "1 file" : `${files.length} files`}`, files]);
            const ok =
                /^7 files \+\d+ −\d+ main, (uncommitted|since session start)$/.test(f.line) &&
                f.line.startsWith(`${f.rail} main, `) &&
                JSON.stringify(f.groups) === JSON.stringify(want);
            return [ok, { line: f.line, rail: f.rail, groups: f.groups }];
        });

        await step("opens collapsed: every file a row in its folder's one list box, the header reads Expand all; a folder label opens its files and closes them again (Main board)", async () => {
            const look = `const f = await tabFacts();
                return { open: f.open, all: f.all, segs: segments(), folders: folderFacts(), newFiles: [${q(COUNTERS)}, ${q(HUGE)}].map((p) => flat(block(p)?.querySelector("[data-changes-new]"))) };`;
            const before = await page(h, look);
            await h.shot("cdp-shots/workspace-changes-main.png");
            const opened = await page(h, `folder(${q(DEDUPE)})?.click(); await nap(${SETTLE_MS}); ${look}`);
            const closed = await page(h, `folder(${q(DEDUPE)})?.click(); await nap(${SETTLE_MS}); ${look}`);
            const dedupe = (r) => r.folders.find((x) => x.dir === DEDUPE);
            const segsOf = (r, dir) => JSON.stringify(r.segs.find(([d]) => d === dir)?.[1]);
            const ok =
                before.open.length === 0 &&
                before.all === "Expand all" &&
                JSON.stringify(before.segs) === ONE_LIST &&
                before.folders.length === ORDER.length - 1 &&
                before.folders.every((x) => x.expanded === "false" && !x.turned) &&
                before.newFiles.every((t) => t === "new file") &&
                JSON.stringify(opened.open) === JSON.stringify([GROUPS, OLD]) &&
                opened.all === "Collapse all" &&
                dedupe(opened)?.expanded === "true" &&
                dedupe(opened)?.turned &&
                segsOf(opened, DEDUPE) === JSON.stringify([`card ${GROUPS}`, `card ${OLD}`]) &&
                closed.open.length === 0 &&
                closed.all === "Expand all" &&
                JSON.stringify(closed.segs) === ONE_LIST &&
                dedupe(closed)?.expanded === "false" &&
                !dedupe(closed)?.turned;
            return [ok, { before, opened, closed }];
        });

        await step("a file inside a list box opens and closes in place: its body grows and shrinks over frames, and its header glides with the gap a card opens instead of jumping by it", async () => {
            const r = await page(
                h,
                `const watch = () => {
                    const top = sampleFrames(() => rect(header(${q(OLD)}))?.top);
                    const height = sampleFrames(() => block(${q(OLD)})?.offsetHeight);
                    return { top, height };
                };
                const run = async () => {
                    const w = watch();
                    toggle(${q(OLD)});
                    await nap(${SETTLE_MS});
                    w.top.stop();
                    w.height.stop();
                    return { tops: w.top.values, heights: w.height.values, open: isOpen(${q(OLD)}) };
                };
                const opening = await run();
                const closing = await run();
                return { opening, closing };`
            );
            // an unanimated toggle draws two values only, before and after
            const moved = (x) => x.tops.length > 2 && x.heights.length > 2;
            const ok = r.opening.open && !r.closing.open && moved(r.opening) && moved(r.closing);
            return [ok, r];
        });

        await step("Shift+N opens the stepped-into file as its own card between list boxes; the next step into another file closes it; a file opened from its header stays open across steps (Opened board)", async () => {
            const look = `({ counter: counter(), open: [...tab().querySelectorAll("[data-changes-file][data-changes-open]")].map((b) => b.dataset.changesFile) })`;
            const r = await page(
                h,
                `const S = await mod("app/view/agents/workspacechangesstore.ts");
                globalStore.set(S.changesAtAtom(${A}), 0);
                await nap(100);
                const seen = [];
                for (let i = 0; i < 3; i++) {
                    await press("n");
                    await nap(${SETTLE_MS});
                    seen.push(${look});
                }
                return { seen, segs: segments() };`
            );
            await h.shot("cdp-shots/workspace-changes-opened.png");
            const rest = await page(
                h,
                `await press("n");
                await nap(${SETTLE_MS});
                const sameFile = ${look};
                await press("n");
                await nap(${SETTLE_MS});
                const nextFile = ${look};
                toggle(${q(README)});
                await nap(100);
                for (let i = 0; i < 3; i++) await press("n");
                await nap(${SETTLE_MS});
                const kept = ${look};
                toggleAll()?.click();
                await nap(100);
                return { sameFile, nextFile, kept, after: (await tabFacts()).open };`
            );
            const at = (n, open) => ({ counter: `${n}/${HUNKS}`, open });
            const want = {
                seen: [at(1, [README]), at(2, [STYLE]), at(3, [GROUPS])],
                segs: ORDER.map(([dir, files]) => [dir, dir === DEDUPE ? [`card ${GROUPS}`, [OLD]] : [files]]),
                sameFile: at(4, [GROUPS]),
                nextFile: at(5, [OLD]),
                // past counters (6) and round to README (1): the step-opened files close, the header-opened README stays
                kept: at(2, [README, STYLE]),
            };
            const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
            const ok =
                same(r.seen, want.seen) &&
                same(r.segs, want.segs) &&
                same(rest.sameFile, want.sameFile) &&
                same(rest.nextFile, want.nextFile) &&
                same(rest.kept, want.kept) &&
                rest.after.length === 0;
            return [ok, { ...r, ...rest }];
        });

        await step("Expand all opens every file, new ones too, and reads Collapse all; stepping closes nothing; Collapse all returns each folder to one list box (Expanded board)", async () => {
            const r = await page(
                h,
                `toggleAll()?.click();
                await nap(${SETTLE_MS});
                const f = await tabFacts();
                return { open: f.open, all: f.all, segs: segments(), folders: folderFacts() };`
            );
            await h.shot("cdp-shots/workspace-changes-expanded.png");
            const back = await page(
                h,
                `for (let i = 0; i < 3; i++) {
                    click("[data-changes-next]");
                    await nap(150);
                }
                const stepped = (await tabFacts()).open;
                toggleAll()?.click();
                await nap(${SETTLE_MS});
                const f = await tabFacts();
                const S = await mod("app/view/agents/workspacechangesstore.ts");
                globalStore.set(S.changesAtAtom(${A}), 0);
                return { stepped, open: f.open, all: f.all, segs: segments() };`
            );
            const cards = JSON.stringify(ORDER.map(([dir, files]) => [dir, files.map((p) => `card ${p}`)]));
            const ok =
                JSON.stringify(r.open) === JSON.stringify(EVERY) &&
                r.all === "Collapse all" &&
                JSON.stringify(r.segs) === cards &&
                r.folders.every((x) => x.expanded === "true" && x.turned) &&
                JSON.stringify(back.stepped) === JSON.stringify(EVERY) &&
                back.open.length === 0 &&
                back.all === "Expand all" &&
                JSON.stringify(back.segs) === ONE_LIST;
            return [ok, { r, back }];
        });

        await step("a hunk's label row is the function line's text, and no row shows a raw @@", async () => {
            const r = await page(
                h,
                `await ensureOpen(${q(GROUPS)});
                const labels = [...(block(${q(GROUPS)})?.querySelectorAll("[data-changes-hunk-label]") ?? [])].map((l) => [...l.children].map(flat));
                return { labels, raw: (tab()?.textContent ?? "").includes("@@") };`
            );
            const label = (i, text) => JSON.stringify(r.labels[i]) === JSON.stringify(["⋯", text]);
            return [label(0, FUNC_LINE) && label(1, LATER_LINE) && !r.raw, r];
        });

        await step("diff rows carry the added and removed tints, numbered by the new side (a removed line's old one)", async () => {
            const r = await page(
                h,
                `await ensureOpen(${q(GROUPS)});
                const rows = [...(block(${q(GROUPS)})?.querySelectorAll("[data-diff-line]") ?? [])];
                const row = (text) => rows.find((x) => x.textContent.includes(text));
                const fact = (text) => { const x = row(text); return x ? { cls: x.className, no: flat(x.querySelector("[data-diff-no]")) } : null; };
                return { removed: fact(${q(OLD_MARK)}), added: fact(${q(NEW_MARK)}), context: fact("_ = k") };`
            );
            const ok =
                r.removed?.cls.includes("diff-line-removed") &&
                r.removed.no === OLD_NO &&
                r.added?.cls.includes("diff-line-added") &&
                r.added.no === NEW_NO &&
                !/diff-line-(added|removed)/.test(r.context?.cls ?? "x") &&
                r.context?.no === CONTEXT_NO;
            return [!!ok, r];
        });

        await step("the untracked file is closed and reads new file; opened, its rows are numbered and untinted; a modified file's header closes it", async () => {
            const r = await page(
                h,
                `const before = { open: block(${q(COUNTERS)})?.dataset.changesOpen != null, newFile: flat(block(${q(COUNTERS)})?.querySelector("[data-changes-new]")) };
                toggle(${q(COUNTERS)});
                await until(() => block(${q(COUNTERS)})?.querySelector("[data-diff-line]") != null, ${WAIT_MS});
                const rows = [...block(${q(COUNTERS)}).querySelectorAll("[data-diff-line]")];
                const after = {
                    open: block(${q(COUNTERS)})?.dataset.changesOpen != null,
                    newFile: flat(block(${q(COUNTERS)})?.querySelector("[data-changes-new]")),
                    numbers: rows.map((x) => flat(x.querySelector("[data-diff-no]"))),
                    tinted: rows.filter((x) => /diff-line-(added|removed)/.test(x.className)).length,
                };
                await ensureOpen(${q(STYLE)});
                const styleWasOpen = isOpen(${q(STYLE)});
                toggle(${q(STYLE)});
                await nap(${SETTLE_MS});
                return { before, after, styleWasOpen, styleOpen: block(${q(STYLE)})?.dataset.changesOpen != null };`
            );
            const ok =
                !r.before.open &&
                r.before.newFile === "new file" &&
                r.after.open &&
                r.after.newFile === "" &&
                r.after.numbers.join(",") === Array.from({ length: COUNTERS_LINES }, (_, i) => i + 1).join(",") &&
                r.after.tinted === 0 &&
                r.styleWasOpen &&
                !r.styleOpen;
            return [ok, r];
        });

        await step("next from 0/N lands the first hunk under the sticky headers; next into a closed file opens it; previous from 1/N wraps to N/N", async () => {
            const r = await page(
                h,
                `const start = counter();
                scroller().scrollTop = scroller().scrollHeight;
                await nap(100);
                click("[data-changes-next]");
                await nap(${SETTLE_MS});
                const first = { counter: counter(), under: underHeader(${q(README)}, 0) };
                click("[data-changes-next]");
                await nap(${SETTLE_MS});
                const second = { counter: counter(), styleOpen: block(${q(STYLE)})?.dataset.changesOpen != null, under: underHeader(${q(STYLE)}, 0) };
                click("[data-changes-prev]");
                await nap(100);
                const back = counter();
                click("[data-changes-prev]");
                await nap(${SETTLE_MS});
                return { start, first, second, back, wrapped: counter() };`
            );
            const ok =
                r.start === `0/${HUNKS}` &&
                r.first.counter === `1/${HUNKS}` &&
                r.first.under &&
                r.second.counter === `2/${HUNKS}` &&
                r.second.styleOpen &&
                r.second.under &&
                r.back === `1/${HUNKS}` &&
                r.wrapped === `${HUNKS}/${HUNKS}`;
            return [ok, r];
        });

        await step("the binary file reads Binary file; the over-cap file reads Too large to show here while the files before it draw hunks", async () => {
            const r = await page(
                h,
                `const note = (p) => block(p)?.querySelector("[data-changes-note]")?.dataset.changesNote ?? null;
                const hunks = (p) => block(p)?.querySelectorAll("[data-changes-hunk]").length ?? 0;
                await ensureOpen(${[LOGO, README, GROUPS, OLD, COUNTERS].map(q).join(",")});
                return {
                    binary: [note(${q(LOGO)}), flat(block(${q(LOGO)})?.querySelector("[data-changes-note]"))],
                    hugeText: (await ensureOpen(${q(HUGE)}), await nap(${SETTLE_MS}), flat(block(${q(HUGE)})?.querySelector("[data-changes-note]"))),
                    before: [${[README, GROUPS, OLD, COUNTERS].map(q).join(",")}].map(hunks),
                };`
            );
            await page(h, `toggle(${q(HUGE)}); return true;`);
            const ok =
                r.binary[0] === "binary" &&
                r.binary[1] === "Binary file" &&
                r.hugeText === "Too large to show here" &&
                r.before.every((n) => n > 0);
            return [ok, r];
        });

        await step("loading: with the read held, B then A shows skeleton lines in the open bodies until the reply lands", async () => {
            await page(
                h,
                `stubPatch(async function (...a) { await nap(${SLOW_READ_MS}); return window.__arcChangesPatchRead.apply(this, a); });
                return true;`
            );
            try {
                await focusAgent(h, ctx.bId);
                await polishNap(SETTLE_MS);
                await page(
                    h,
                    `window.__arcLoadingFrames = sampleFrames(() => (tab() == null ? null : tab().querySelector("[data-changes-loading]") ? "skeleton" : tab().querySelector("[data-changes-hunk]") ? "hunks" : "none"));
                    return true;`
                );
                await focusAgent(h, ctx.aId);
                const landed = await waitTab(h, loaded, GIT_WAIT_MS);
                const r = await page(h, `window.__arcLoadingFrames.stop(); const v = window.__arcLoadingFrames.values; delete window.__arcLoadingFrames; return v;`);
                const skeleton = r.indexOf("skeleton");
                const ok = landed && skeleton >= 0 && r.indexOf("hunks", skeleton) > skeleton && r.at(-1) === "hunks";
                return [ok, { landed, frames: r }];
            } finally {
                await page(h, `unstubPatch(); return true;`);
            }
        });
        await h.shot("cdp-shots/workspace-changes-loaded.png");

        await step("failure: a failing re-read shows the band with its message and Retry over the headers; Retry brings the hunks back", async () => {
            try {
                await page(h, `stubPatch(async () => { throw new Error(${q(FAIL_MSG)}); }); click("[data-changes-ignore-ws]"); return true;`);
                await waitTab(h, `f.band !== ""`, WAIT_MS);
                const failed = await page(
                    h,
                    `const band = tab()?.querySelector("[data-workspace-changes-patch-failed]");
                    const first = tab()?.querySelector("[data-changes-file]");
                    return {
                        ...(await tabFacts()),
                        retry: band?.querySelector("[data-workspace-changes-patch-retry]") != null,
                        above: band != null && first != null && (band.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
                    };`
                );
                await h.shot("cdp-shots/workspace-changes-failed.png");
                await page(h, `unstubPatch(); click("[data-workspace-changes-patch-retry]"); return true;`);
                const back = await waitTab(h, `f.band === "" && f.hunks > 0`, GIT_WAIT_MS);
                const after = await facts(h);
                const ok = failed.band.includes(FAIL_MSG) && failed.retry && failed.above && failed.headers === 7 && back && after.band === "";
                return [ok, { failed: { band: failed.band, retry: failed.retry, above: failed.above, headers: failed.headers }, back, hunks: after.hunks }];
            } finally {
                // Hide whitespace back off, read for real
                await page(h, `unstubPatch(); if (tab()?.querySelector("[data-changes-ignore-ws]")?.getAttribute("aria-pressed") === "true") click("[data-changes-ignore-ws]"); return true;`);
                await waitTab(h, `f.counter.endsWith("/${HUNKS}")`, GIT_WAIT_MS);
            }
        });

        await step("a rail reload brings the edit's new line into its hunk with no skeleton in any frame", async () => {
            await page(
                h,
                `window.__arcReloadFrames = sampleFrames(() => (tab()?.querySelector("[data-changes-loading]") ? "skeleton" : "rows"));
                return true;`
            );
            writeFileSync(join(ctx.edited, README), lines(readmeReloaded));
            await h.rpc("setmeta", { oref: `block:${ctx.aBlockId}`, meta: { "agent:lasteditts": Date.now() } });
            const landed = await waitPage(
                h,
                `(block(${q(README)})?.querySelector('[data-changes-hunk="0"]')?.textContent ?? "").includes(${q(RELOAD_MARK)})`,
                GIT_WAIT_MS
            );
            const frames = await page(h, `window.__arcReloadFrames.stop(); const v = window.__arcReloadFrames.values; delete window.__arcReloadFrames; return v;`);
            return [landed && !frames.includes("skeleton"), { landed, frames }];
        });

        await step("a closed file and the counter at 2/N hold across another tab and another agent", async () => {
            const before = await page(
                h,
                `for (let i = 0; i < ${HUNKS + 2} && counter() !== "2/${HUNKS}"; i++) {
                    click("[data-changes-next]");
                    await nap(50);
                }
                if (block(${q(STYLE)})?.dataset.changesOpen != null) toggle(${q(STYLE)});
                await nap(100);
                const f = await tabFacts();
                return { counter: f.counter, open: f.open };`
            );
            await page(h, `W.openWorkspaceTab(${A}, ${q(OTHER_FILE)}); return true;`);
            await polishNap(SETTLE_MS);
            await page(h, `W.activateWorkspaceTab(${A}, "changes"); return true;`);
            await waitTab(h, `${loaded} && f.counter !== ""`, GIT_WAIT_MS);
            const afterTab = await facts(h);
            await focusAgent(h, ctx.bId);
            await polishNap(SETTLE_MS);
            await focusAgent(h, ctx.aId);
            await waitTab(h, `${loaded} && f.counter !== ""`, GIT_WAIT_MS);
            const afterAgent = await facts(h);
            const same = (f) => f.counter === `2/${HUNKS}` && JSON.stringify(f.open) === JSON.stringify(before.open);
            const ok = before.counter === `2/${HUNKS}` && !before.open.includes(STYLE) && same(afterTab) && same(afterAgent);
            return [ok, { before, afterTab: { counter: afterTab.counter, open: afterTab.open }, afterAgent: { counter: afterAgent.counter, open: afterAgent.open } }];
        });

        await step("Open in Code lands on the Code surface at the first hunk's new-side line; the deleted file has no Open in Code", async () => {
            const r = await page(
                h,
                `const C = await mod("app/view/code/codestore.ts");
                const model = agentsModel();
                const deletedButton = block(${q(OLD)})?.querySelector("[data-changes-open-code]") != null;
                const jumps = [];
                const un = globalStore.sub(C.codePendingJumpAtom, () => {
                    const j = globalStore.get(C.codePendingJumpAtom);
                    if (j != null) jumps.push(j);
                });
                block(${q(GROUPS)})?.querySelector("[data-changes-open-code]")?.click();
                // the viewer consumes the jump once it has put the caret on the line
                const landed = await until(
                    () =>
                        globalStore.get(model.surfaceAtom) === "code" &&
                        globalStore.get(C.codeFileAtom)?.path === ${q(GROUPS)} &&
                        jumps.length > 0 &&
                        globalStore.get(C.codePendingJumpAtom) == null,
                    ${GIT_WAIT_MS}
                );
                un();
                return { deletedButton, landed, jumps, surface: globalStore.get(model.surfaceAtom), file: globalStore.get(C.codeFileAtom)?.path ?? null };`
            );
            await h.shot("cdp-shots/workspace-changes-open-in-code.png");
            await h.goto("agent");
            const ok = !r.deletedButton && r.landed && r.jumps.some((j) => j.path === GROUPS && j.line === FIRST_HUNK_LINE);
            return [ok, r];
        });

        await step("Hide whitespace: the whitespace-only file reads Only whitespace changed and N drops; pressed again it returns", async () => {
            await waitTab(h, `${loaded} && f.counter !== ""`, GIT_WAIT_MS);
            await page(h, `if (block(${q(STYLE)})?.dataset.changesOpen == null) toggle(${q(STYLE)}); click("[data-changes-ignore-ws]"); return true;`);
            const hidden = await waitTab(h, `f.counter.endsWith("/${HUNKS_NO_WS}")`, GIT_WAIT_MS);
            const on = await page(
                h,
                `return { pressed: tab()?.querySelector("[data-changes-ignore-ws]")?.getAttribute("aria-pressed"), note: flat(block(${q(STYLE)})?.querySelector('[data-changes-note="whitespace"]')), counter: counter() };`
            );
            await h.shot("cdp-shots/workspace-changes-hide-whitespace.png");
            await page(h, `click("[data-changes-ignore-ws]"); return true;`);
            const shown = await waitTab(h, `f.counter.endsWith("/${HUNKS}")`, GIT_WAIT_MS);
            const off = await page(
                h,
                `return { pressed: tab()?.querySelector("[data-changes-ignore-ws]")?.getAttribute("aria-pressed"), hunks: block(${q(STYLE)})?.querySelectorAll("[data-changes-hunk]").length ?? 0, counter: counter() };`
            );
            const ok = hidden && on.pressed === "true" && on.note === "Only whitespace changed" && shown && off.pressed === "false" && off.hunks === 1;
            return [ok, { on, off }];
        });

        await step("Shift+N twice reads 2/N, Shift+P back 1/N, Shift+W flips Hide whitespace; with another tab shown Shift+N leaves the counter", async () => {
            await waitTab(h, `${loaded} && f.counter !== ""`, GIT_WAIT_MS);
            const r = await page(
                h,
                `const S = await mod("app/view/agents/workspacechangesstore.ts");
                const D = await mod("app/view/agents/diffoptions.ts");
                globalStore.set(S.changesAtAtom(${A}), 0);
                await nap(100);
                const start = counter();
                await press("n");
                await press("n");
                const two = counter();
                await press("p");
                const one = counter();
                const before = pressed();
                await press("w");
                const flipped = { pressed: pressed(), atom: globalStore.get(D.ignoreWsAtom) };
                await press("w");
                return { start, two, one, before, flipped, after: { pressed: pressed(), atom: globalStore.get(D.ignoreWsAtom) } };`
            );
            await waitTab(h, `${loaded} && f.counter !== ""`, GIT_WAIT_MS);
            await page(h, `W.openWorkspaceTab(${A}, ${q(OTHER_FILE)}); return true;`);
            await polishNap(SETTLE_MS);
            const away = await page(
                h,
                `const S = await mod("app/view/agents/workspacechangesstore.ts");
                const D = await mod("app/view/agents/diffoptions.ts");
                await press("n");
                await press("w");
                return { at: globalStore.get(S.changesAtAtom(${A})), atom: globalStore.get(D.ignoreWsAtom), tabShown: tab() != null };`
            );
            await page(h, `W.activateWorkspaceTab(${A}, "changes"); return true;`);
            await waitTab(h, `${loaded} && f.counter !== ""`, GIT_WAIT_MS);
            const back = await facts(h);
            const ok =
                r.start === `0/${HUNKS}` &&
                r.two === `2/${HUNKS}` &&
                r.one === `1/${HUNKS}` &&
                r.before === "false" &&
                r.flipped.pressed === "true" &&
                r.flipped.atom === true &&
                r.after.pressed === "false" &&
                r.after.atom === false &&
                !away.tabShown &&
                away.at === 1 &&
                away.atom === false &&
                back.counter === `1/${HUNKS}`;
            return [ok, { ...r, away, back: back.counter }];
        });

        await step("the footer shows the change chip while the Changes tab shows, and not while another workspace tab does", async () => {
            await page(h, `W.activateWorkspaceTab(${A}, "changes"); return true;`);
            const shown = await waitPage(h, `footerText().includes("⇧N/⇧P")`);
            await page(h, `W.activateWorkspaceTab(${A}, ${q("file:" + README)}); return true;`);
            const gone = await waitPage(h, `!footerText().includes("⇧N/⇧P")`);
            const other = await page(h, `return { footer: footerText(), tab: tab() != null };`);
            await page(h, `W.activateWorkspaceTab(${A}, "changes"); return true;`);
            await waitTab(h, `${loaded} && f.counter !== ""`, GIT_WAIT_MS);
            return [shown && gone && !other.tab, { shown, gone, other }];
        });

        await step("setting selected to a lower file scrolls its header into view, open", async () => {
            const r = await page(
                h,
                `scroller().scrollTop = 0;
                await nap(100);
                W.updateWorkspaceTab(${A}, "changes", { selected: ${q(HUGE)} });
                await until(() => block(${q(HUGE)})?.dataset.changesOpen != null, ${WAIT_MS});
                await nap(${SETTLE_MS});
                const s = rect(scroller());
                const hd = rect(header(${q(HUGE)}));
                return { open: block(${q(HUGE)})?.dataset.changesOpen != null, scrolled: scroller().scrollTop, inView: hd != null && hd.top >= s.top - 1 && hd.bottom <= s.bottom + 1 };`
            );
            return [r.open && r.scrolled > 0 && r.inView, r];
        });

        await step("Open on Diff lands on the agent's scope", async () => {
            await h.ev(`${TAB}?.querySelector("[data-workspace-open-diff]")?.click()`);
            await waitPage(
                h,
                `globalStore.get(agentsModel().surfaceAtom) === "files" && document.querySelector("[data-diff-pane] .monaco-editor") != null`,
                GIT_WAIT_MS
            );
            await polishNap(SETTLE_MS);
            const d = await diffSurface(h);
            ctx.diffOwn = d.pair;
            const ok = d.surface === "files" && d.origin?.kind === "agent" && d.origin?.id === ctx.aId && d.pair != null && d.file === basename(d.pair);
            return [ok, d];
        });
        await h.shot("cdp-shots/workspace-changes-on-diff.png");

        await step("after the tab scrolls to another file, the Diff surface still shows its own selection and pair", async () => {
            const own = ctx.diffOwn ?? "";
            // the tab scrolls to a file the Diff surface is not showing
            const other = [GROUPS, README].find((p) => p !== own);
            await h.goto("agent");
            await waitTab(h, loaded, GIT_WAIT_MS);
            await page(h, `W.updateWorkspaceTab(${A}, "changes", { selected: ${q(other)} }); return true;`);
            await polishNap(SETTLE_MS);
            const tabOpen = await page(h, `return block(${q(other)})?.dataset.changesOpen != null;`);
            await h.goto("files");
            await polishWaitFor(h, `document.querySelector("[data-diff-pane] .monaco-editor") != null`, GIT_WAIT_MS);
            await polishNap(SETTLE_MS);
            const d = await diffSurface(h);
            const ok = tabOpen && d.origin?.kind === "agent" && d.origin?.id === ctx.aId && d.pair === own && d.file === basename(own);
            return [ok, { other, tabOpen, own, ...d }];
        });
        await h.shot("cdp-shots/workspace-changes-diff-own.png");

        await step("a clean repo's tab says there are no changes", async () => {
            await h.goto("agent");
            await focusAgent(h, ctx.bId);
            await openChanges(h, ctx.bId);
            await waitTab(h, `f.empty != null`, GIT_WAIT_MS);
            const f = await facts(h);
            const title = await h.ev(`document.querySelector("[data-workspace-changes-empty] h2")?.textContent ?? null`);
            return [f.empty === "clean" && title === "No changes", { empty: f.empty, title }];
        });
        await h.shot("cdp-shots/workspace-changes-clean.png");
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`${NAME} teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("restore the patch read", () => page(h, `unstubPatch(); return true;`));
        await step("close the workspace tabs", () =>
            page(
                h,
                `for (const id of ${JSON.stringify([ctx.aId, ctx.bId].filter(Boolean))}) {
                    for (const t of [...ws(id).tabs]) W.closeWorkspaceTab(id, t.kind === "run" ? "run:" + t.runId : t.kind === "file" ? "file:" + t.path : t.kind);
                }
                return true;`
            )
        );
        if (ctx.prev != null) {
            await step("restore the pane width and the Code recents", () =>
                page(
                    h,
                    `globalStore.set(W.workspaceWidthAtom, ${JSON.stringify(ctx.prev.widthAtom)});
                    ${restoreLocalStorage(WIDTH_KEY, ctx.prev.width)};
                    ${restoreLocalStorage(RECENTS_KEY, ctx.prev.recents)};
                    return true;`
                )
            );
        }
        await step("restore the roster", () => restoreRoster(h));
        await step("restore the default view", () => restoreDefaultView(h));
        await step("close the tabs", () => closeTabs(h, ctx));
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true }));
        await step("go home", () => h.goto("cockpit"));
    },
};
