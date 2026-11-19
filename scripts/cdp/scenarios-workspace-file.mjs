// Scenario `workspace-file`: the workspace pane's File tab (Task 7 of docs/superpowers/plans/2026-11-17-workspace-pane.md;
// the File board; the Main and Image boards of docs/superpowers/plans/2026-11-19-file-tab-polish.md). The roster is a
// fixture claude agent backed by a real tab with no controller, in the Rendered view, whose transcript's reply cites
// files of a temp git repo by absolute path, three with a line and one image. A click on a cited path opens a File tab
// holding the Code peek, landed on that line; Esc in the card closes its tab; Open in Code lands on the Code surface.
// The default view and the viewport are put back in teardown.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { gradientPng } from "./scenarios-code-editor.mjs";
import { git, polishNap, polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "workspace-file";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
// longer than a tab's entrance and the card's view swap
const SETTLE_MS = 700;
const STATS_REL = "internal/stats/stats.go";
const STATS_LINES = 60;
const STATS_LINE = 41;
const DEDUPE_REL = "internal/dedupe/dedupe.go";
const DEDUPE_LINE = 4;
// committed in the seed, then changed in the working tree: one hunk well inside Normalize, so git labels it with the
// func line, adding a line too long for the 600 px pane's one row; the reply cites that added line
const GROUPS_REL = "internal/dedupe/groups.go";
const GROUPS_LINE = 13;
const GROUPS_HUNK_LABEL = "func Normalize(tags []string) []string {";
const GROUPS_SEED = [
    "package dedupe",
    "",
    'import "strings"',
    "",
    "// Normalize lowercases each tag and drops the blank ones.",
    GROUPS_HUNK_LABEL,
    "\tout := make([]string, 0, len(tags))",
    "\tfor _, t := range tags {",
    "\t\tt = strings.TrimSpace(t)",
    '\t\tif t == "" {',
    "\t\t\tcontinue",
    "\t\t}",
    "\t\tout = append(out, strings.ToLower(t))",
    "\t}",
    "\treturn out",
    "}",
    "",
];
const GROUPS_LONG =
    '\t\t// a tag folds to lower case so "Go", "go" and "GO" share one shelf, and a leading # never makes a second shelf of its own when the shelf is listed';
const GROUPS_CHANGED = [
    ...GROUPS_SEED.slice(0, GROUPS_LINE - 1),
    GROUPS_LONG,
    '\t\tout = append(out, strings.ToLower(strings.TrimPrefix(t, "#")))',
    ...GROUPS_SEED.slice(GROUPS_LINE),
];
const IMAGE_REL = "docs/shots/stats-panel.png";
// wider than the pane, so it shows scaled down to fit
const IMAGE_SIZE = { w: 1280, h: 800 };
const LINKS = 4;
const PROMPT = "Where does the tag count live?";
const ESC = { key: "Escape", code: "Escape", keyCode: 27 };

const PANE = `document.querySelector('aside[aria-label="Workspace"]')`;
const CARD = `${PANE}?.querySelector('[data-code-peek][data-peek-variant="tab"]')`;
const tabSel = (key) => `[data-workspace-tab=${JSON.stringify(key)}]`;

const page = (h, body) =>
    agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        const ws = (id) => globalStore.get(W.workspaceAtom(id));
        ${body}`
    );

function makeRepo(dir) {
    mkdirSync(join(dir, "internal", "stats"), { recursive: true });
    mkdirSync(join(dir, "internal", "dedupe"), { recursive: true });
    mkdirSync(join(dir, "docs", "shots"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# linkshelf\n");
    writeFileSync(join(dir, GROUPS_REL), GROUPS_SEED.join("\n"));
    writeFileSync(join(dir, IMAGE_REL), gradientPng(IMAGE_SIZE.w, IMAGE_SIZE.h));
    writeFileSync(
        join(dir, DEDUPE_REL),
        ["package dedupe", "", "// Key folds a link to the form two duplicates share.", "func Key(url string) string {", "\treturn url", "}", ""].join("\n")
    );
    git(dir, "init", "-q", "--initial-branch=main");
    git(dir, "-c", "core.autocrlf=false", "add", ".");
    git(dir, "-c", "core.autocrlf=false", "commit", "-q", "-m", "seed");
    writeFileSync(join(dir, GROUPS_REL), GROUPS_CHANGED.join("\n"));
    // new since HEAD, so its stat reads "new file"
    const stats = Array.from({ length: STATS_LINES }, (_, i) => (i === 0 ? "package stats" : i === STATS_LINE - 1 ? "func CountByTag() map[string]int { return nil }" : `// line ${i + 1}`));
    writeFileSync(join(dir, STATS_REL), stats.join("\n") + "\n");
}

export const workspaceFile = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-workspace-file-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            ctx.repo = join(ctx.dir, "linkshelf");
            makeRepo(ctx.repo);
            const abs = (rel) => join(ctx.repo, rel).replace(/\\/g, "/");
            ctx.stats = abs(STATS_REL);
            ctx.dedupe = abs(DEDUPE_REL);
            ctx.groups = abs(GROUPS_REL);
            ctx.image = abs(IMAGE_REL);
            ctx.imageBytes = statSync(join(ctx.repo, IMAGE_REL)).size;
            const reply = [
                `The count lives in \`${ctx.stats}:${STATS_LINE}\`, and the duplicate key in \`${ctx.dedupe}:${DEDUPE_LINE}\`.`,
                `Tags now fold their # in \`${ctx.groups}:${GROUPS_LINE}\`; the panel looks like \`${ctx.image}\`.`,
            ].join(" ");
            const transcript = writeTranscript(join(ctx.dir, "transcripts"), `workspace-file-${tag}`, [userText(PROMPT), assistantText(reply)]);
            await h.goto("agent");
            await pinDefaultView(h, "rendered");
            const a = await makeTab(h, ctx, { label: `workspace-file-${tag}`, blockMeta: { view: "term", controller: null } });
            ctx.aId = a.tabId;
            await setRoster(h, [
                {
                    id: a.tabId,
                    name: `workspace-file-${tag}`,
                    project: "linkshelf",
                    task: "workspace file fixture",
                    state: "idle",
                    agent: "claude",
                    model: "claude-opus-5-5",
                    blockId: a.blockId,
                    transcriptPath: transcript,
                },
            ]);
            await focusAgent(h, ctx.aId);
            const linked = `[...document.querySelectorAll("[data-rendered-view] [data-file-link]")].length === ${LINKS}`;
            if (!(await polishWaitFor(h, linked, WAIT_MS))) throw new Error(`the reply's ${LINKS} file links never rendered`);
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
        const statsKey = `file:${ctx.stats}`;
        const dedupeKey = `file:${ctx.dedupe}`;
        const groupsKey = `file:${ctx.groups}`;
        const imageKey = `file:${ctx.image}`;
        const samePath = (a, b) => (a ?? "").replace(/\\/g, "/").toLowerCase() === (b ?? "").toLowerCase();
        const clickLink = (path) =>
            h.ev(`(() => {
                const link = [...document.querySelectorAll("[data-rendered-view] [data-file-link]")].find((l) => l.getAttribute("data-file-link") === ${JSON.stringify(path)});
                if (!link) return false;
                getSelection().removeAllRanges();
                link.click();
                return true;
            })()`);
        // the card once its editor has drawn the cited line as the active one
        const landedOn = (line) =>
            polishWaitFor(
                h,
                `(${CARD})?.querySelector(".line-numbers.active-line-number")?.textContent.trim() === ${JSON.stringify(String(line))}`,
                WAIT_MS
            );
        const facts = () =>
            page(
                h,
                `const card = ${CARD};
                const ed = card?.querySelector(".monaco-editor");
                const active = card?.querySelector(".line-numbers.active-line-number");
                const box = ed?.getBoundingClientRect();
                const row = active?.getBoundingClientRect();
                const highlight = card?.querySelector(".current-line");
                const label = card?.querySelector("[data-peek-path]")?.previousElementSibling;
                return {
                    tabs: ws(${A}).tabs.map((t) => t.kind + ":" + (t.path ?? "")),
                    active: ws(${A}).active,
                    shown: [...document.querySelectorAll("[data-workspace-tab]")].map((t) => t.dataset.workspaceTab),
                    tabLabel: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
                    card: card != null,
                    state: card?.dataset.peekState ?? null,
                    label: label?.textContent.trim() ?? null,
                    path: card?.querySelector("[data-peek-path]")?.textContent.trim() ?? null,
                    title: card?.querySelector("[data-peek-path]")?.getAttribute("title") ?? null,
                    openInHeader: card?.querySelector("[data-peek-path]")?.parentElement.querySelector("[data-peek-open]")?.textContent.trim() ?? null,
                    closeButton: card?.querySelector('button[aria-label="Close the peek"]') != null,
                    footerKeys: [...(card?.querySelectorAll("kbd") ?? [])].map((k) => k.textContent),
                    source: card?.querySelector('[data-peek-mode="source"]')?.getAttribute("aria-pressed") ?? null,
                    readOnly: (card?.textContent ?? "").includes("Read-only"),
                    stat: card?.querySelector("[data-peek-stat]")?.textContent ?? null,
                    preview: card?.querySelector('[data-peek-mode="preview"]') != null,
                    cited: card?.querySelector(".peek-cited-line") != null,
                    activeLine: active?.textContent.trim() ?? null,
                    inView: box != null && row != null && row.top >= box.top && row.bottom <= box.bottom,
                    highlighted: highlight != null && highlight.getBoundingClientRect().height > 0,
                    dock: document.querySelector("[data-rendered-peek]") != null,
                };`
            );

        await step("a click on path:line in a reply opens a File tab named by its base name, in Source, the cited line highlighted and in view (File board)", async () => {
            const clicked = await clickLink(ctx.stats);
            const landed = await landedOn(STATS_LINE);
            await polishNap(SETTLE_MS);
            const f = await facts();
            const ok =
                clicked &&
                landed &&
                f.tabs.length === 1 &&
                f.active === statsKey &&
                f.shown.includes(statsKey) &&
                f.tabLabel === "stats.go" &&
                f.state === "text" &&
                f.label == null &&
                f.path === `${STATS_REL}:${STATS_LINE}` &&
                samePath(f.title, ctx.stats) &&
                f.openInHeader === "Open in Code" &&
                !f.closeButton &&
                f.footerKeys.length === 0 &&
                f.source === "true" &&
                !f.readOnly &&
                !f.preview &&
                f.cited &&
                (f.stat ?? "").includes("new file") &&
                f.activeLine === String(STATS_LINE) &&
                f.inView &&
                f.highlighted &&
                !f.dock;
            return [ok, { clicked, landed, ...f }];
        });
        await h.shot("cdp-shots/workspace-file-board.png");

        await step("Diff on a file new since HEAD reads as the plain file, as the Diff surface draws one; Source lands back on the line", async () => {
            const diff = await page(
                h,
                `const card = () => ${CARD};
                card()?.querySelector('[data-peek-mode="diff"]')?.click();
                const drawn = await until(() => card()?.querySelector("[data-diff-new-file] .monaco-editor .view-line") != null, ${WAIT_MS});
                await nap(400);
                const insert = card()?.querySelector("[data-diff-new-file] .view-overlays .line-insert");
                return {
                    drawn,
                    caption: (card()?.textContent ?? "").includes("New file, not in HEAD"),
                    pressed: card()?.querySelector('[data-peek-mode="diff"]')?.getAttribute("aria-pressed") ?? null,
                    band: insert ? getComputedStyle(insert).backgroundColor : null,
                };`
            );
            await h.shot("cdp-shots/workspace-file-newfile-diff.png");
            await h.ev(`(${CARD})?.querySelector('[data-peek-mode="source"]')?.click()`);
            const back = await landedOn(STATS_LINE);
            const ok = diff.drawn && diff.caption && diff.pressed === "true" && diff.band === "rgba(0, 0, 0, 0)" && back;
            return [ok, { ...diff, back }];
        });

        await step("a second click on the same link keeps the one tab and its card open", async () => {
            await clickLink(ctx.stats);
            await polishNap(SETTLE_MS);
            const f = await facts();
            return [f.tabs.length === 1 && f.active === statsKey && f.card && f.activeLine === String(STATS_LINE), f];
        });

        await step("a link to another file adds a second File tab, landed on its line", async () => {
            const clicked = await clickLink(ctx.dedupe);
            const landed = await landedOn(DEDUPE_LINE);
            const f = await facts();
            const ok = clicked && landed && f.tabs.length === 2 && f.active === dedupeKey && f.tabLabel === "dedupe.go" && f.path === `${DEDUPE_REL}:${DEDUPE_LINE}`;
            return [ok, { clicked, landed, ...f }];
        });

        await step("activating the first File tab shows its file again, on its line", async () => {
            await h.ev(`document.querySelector('${tabSel(statsKey)} [role="tab"]')?.click()`);
            const landed = await landedOn(STATS_LINE);
            const f = await facts();
            return [landed && f.active === statsKey && f.path === `${STATS_REL}:${STATS_LINE}`, { landed, ...f }];
        });

        await step("Esc in the card closes its tab, and the other File tab shows its file", async () => {
            const focused = await h.ev(`(() => { const c = ${CARD}; c?.focus(); return c != null && c.contains(document.activeElement); })()`);
            await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ESC.key, code: ESC.code, windowsVirtualKeyCode: ESC.keyCode });
            await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ESC.key, code: ESC.code, windowsVirtualKeyCode: ESC.keyCode });
            const closed = await polishWaitFor(h, `document.querySelector('${tabSel(statsKey)}') == null`, WAIT_MS);
            const landed = await landedOn(DEDUPE_LINE);
            const f = await facts();
            return [focused && closed && landed && f.tabs.length === 1 && f.active === dedupeKey && f.path === `${DEDUPE_REL}:${DEDUPE_LINE}`, { focused, closed, landed, ...f }];
        });

        await step("Source on a changed file: no minimap, the long line wrapped, 12.5 px text on 20 px lines, the cited line in its accent band with its accent number (Main board)", async () => {
            const clicked = await clickLink(ctx.groups);
            const landed = await landedOn(GROUPS_LINE);
            await polishNap(SETTLE_MS);
            const f = await page(
                h,
                `const card = ${CARD};
                const ed = card?.querySelector(".monaco-editor");
                const num = (n) => [...(card?.querySelectorAll(".line-numbers") ?? [])].find((e) => e.textContent.trim() === String(n));
                const top = (el) => el?.getBoundingClientRect().top ?? null;
                const minimap = ed?.querySelector(".minimap");
                const viewLine = ed?.querySelector(".view-lines .view-line");
                const band = card?.querySelector(".peek-cited-line");
                const citedNo = card?.querySelector(".peek-cited-line-number");
                // the tokens resolved to the computed form an element's colour reads back in
                const probe = document.createElement("div");
                document.body.append(probe);
                const token = (name) => {
                    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
                    return getComputedStyle(probe).color;
                };
                const accentbg = token("--color-accentbg");
                const accentSoft = token("--color-accent-soft");
                probe.remove();
                return {
                    active: ws(${A}).active,
                    tabs: ws(${A}).tabs.length,
                    path: card?.querySelector("[data-peek-path]")?.textContent.trim() ?? null,
                    minimap: minimap != null && minimap.getBoundingClientRect().width > 0 && getComputedStyle(minimap).display !== "none",
                    longRows: (top(num(${GROUPS_LINE + 1})) - top(num(${GROUPS_LINE}))) / 20,
                    fontSize: viewLine ? getComputedStyle(viewLine).fontSize : null,
                    lineHeight: viewLine ? viewLine.getBoundingClientRect().height : null,
                    citedNo: citedNo?.textContent.trim() ?? null,
                    citedTop: top(num(${GROUPS_LINE})),
                    bandTop: top(band),
                    bandColor: band ? getComputedStyle(band).backgroundColor : null,
                    accentbg,
                    numberColor: citedNo ? getComputedStyle(citedNo).color : null,
                    accentSoft,
                };`
            );
            await h.shot("cdp-shots/workspace-file-main.png");
            const ok =
                clicked &&
                landed &&
                f.active === groupsKey &&
                f.tabs === 2 &&
                f.path === `${GROUPS_REL}:${GROUPS_LINE}` &&
                !f.minimap &&
                f.longRows > 1 &&
                f.fontSize === "12.5px" &&
                f.lineHeight === 20 &&
                f.citedNo === String(GROUPS_LINE) &&
                f.bandTop != null &&
                Math.abs(f.bandTop - f.citedTop) < 1 &&
                f.bandColor === f.accentbg &&
                f.numberColor === f.accentSoft;
            return [ok, { clicked, landed, ...f }];
        });

        await step("An image is drawn fit to the pane, its size and Copy path under it, no modes, Open in Code (Image board)", async () => {
            const clicked = await clickLink(ctx.image);
            const drawn = await polishWaitFor(
                h,
                `(() => { const i = (${CARD})?.querySelector("[data-code-image] img"); return !!i && i.complete && i.naturalWidth > 0; })()`,
                WAIT_MS
            );
            await polishNap(SETTLE_MS);
            const f = await page(
                h,
                `const card = ${CARD};
                const img = card?.querySelector("[data-code-image] img");
                const b = img?.getBoundingClientRect();
                // the tab has no footer: its body is the card's last child
                const body = card?.lastElementChild?.getBoundingClientRect();
                const copy = [...(card?.querySelectorAll("[data-code-image] button") ?? [])].find((x) => x.textContent.trim() === "Copy path");
                const label = copy?.previousElementSibling;
                const under = (el) => !!b && !!el && el.getBoundingClientRect().top >= b.bottom;
                // the clipboard is stubbed: a CDP session does not give the page the focus a real write needs
                const clip = navigator.clipboard;
                let wrote = null;
                Object.defineProperty(clip, "writeText", { configurable: true, value: (t) => { wrote = t; return Promise.resolve(); } });
                copy?.click();
                await until(() => wrote != null, 2000);
                delete clip.writeText;
                const open = card?.querySelector("[data-peek-open]");
                return {
                    active: ws(${A}).active,
                    state: card?.dataset.peekState ?? null,
                    natural: img?.naturalWidth ?? 0,
                    shown: b ? Math.round(b.width) : null,
                    inside: !!b && !!body && b.left >= body.left && b.right <= body.right && b.top >= body.top && b.bottom <= body.bottom,
                    label: label?.textContent.trim() ?? null,
                    labelUnder: under(label),
                    copyUnder: under(copy),
                    wrote,
                    modes: card?.querySelectorAll("[data-peek-mode]").length ?? null,
                    open: open != null && !open.disabled,
                };`
            );
            await h.shot("cdp-shots/workspace-file-image.png");
            const n = ctx.imageBytes;
            const size = n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
            const ok =
                clicked &&
                drawn &&
                f.active === imageKey &&
                f.state === "binary" &&
                f.natural === IMAGE_SIZE.w &&
                f.shown < f.natural &&
                f.inside &&
                f.label === size &&
                f.labelUnder &&
                f.copyUnder &&
                samePath(f.wrote, ctx.image) &&
                f.modes === 0 &&
                f.open;
            return [ok, { clicked, drawn, size, ...f }];
        });

        await step("Open in Code lands on the Code surface at the cited line", async () => {
            await h.ev(`document.querySelector('${tabSel(dedupeKey)} [role="tab"]')?.click()`);
            await landedOn(DEDUPE_LINE);
            const r = await page(
                h,
                `const C = await mod("app/view/code/codestore.ts");
                (${CARD})?.querySelector("[data-peek-open]")?.click();
                await until(() => globalStore.get(C.codeFileAtom)?.path === ${JSON.stringify(DEDUPE_REL)} && globalStore.get(C.codeFileAtom)?.kind === "text", 8000);
                await until(() => flat(document.querySelector(".line-numbers.active-line-number")) === ${JSON.stringify(String(DEDUPE_LINE))} || globalStore.get(C.codePendingJumpAtom)?.line === ${DEDUPE_LINE}, 4000);
                const model = agentsModel();
                return {
                    surface: globalStore.get(model.surfaceAtom),
                    file: globalStore.get(C.codeFileAtom)?.path ?? null,
                    pending: globalStore.get(C.codePendingJumpAtom)?.line ?? null,
                    caret: flat(document.querySelector(".line-numbers.active-line-number")),
                    tabs: ws(${A}).tabs.length,
                };`
            );
            await h.shot("cdp-shots/workspace-file-code.png");
            const ok = r.surface === "code" && r.file === DEDUPE_REL && (r.pending === DEDUPE_LINE || r.caret === String(DEDUPE_LINE));
            return [ok, r];
        });

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
        if (ctx.aId) {
            await step("close the workspace tabs", () =>
                page(
                    h,
                    `for (const t of [...ws(${JSON.stringify(ctx.aId)}).tabs]) W.closeWorkspaceTab(${JSON.stringify(ctx.aId)}, "file:" + t.path);
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
