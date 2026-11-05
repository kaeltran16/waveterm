// Diff surface scenario diff-scope: what the surface reads (sources, ranges, history bounds) on a repo with a long
// history, a second worktree, a stash and an uncommitted edit, beside a plain folder and a clone with a remote.
// The helpers below are shared with scenarios-files-states.mjs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, reloadApp, TREE_RAIL_FIXTURE } from "./scenarios-shared.mjs";

// the history page is 50 rows, so more than that makes a second page
const SCOPE_FILLER_COMMITS = 62;
const DIFF_VIEWPORT = { width: 1600, height: 950 };
const WAIT_MS = 8000;
const POLL_MS = 250;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
export const fileRowSel = (path) => `[data-changed-file-row=${JSON.stringify(path)}]`;
export const DIFF_EDITOR = "[data-diff-pane] .monaco-diff-editor";

export async function until(h, expr, ms = WAIT_MS) {
    for (let waited = 0; waited < ms; waited += POLL_MS) {
        if (await h.ev(expr).catch(() => false)) return true;
        await sleep(POLL_MS);
    }
    return false;
}

export const textOf = (h, sel) => h.ev(`(${q(sel)}?.textContent ?? "").trim()`);

// an emulation override belongs to one CDP session, so a step that reattaches or reloads applies it again
export const setViewport = (h, { width, height } = DIFF_VIEWPORT) =>
    h.cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

// scopes the surface to a project through its source picker and waits for its history to draw
export async function openOnDiff(h, name) {
    const option = `[data-files-source-option=${JSON.stringify(name)}]`;
    if (!(await until(h, `!!${q("[data-files-source-picker]")}`, 15000))) return false;
    await h.ev(`${q("[data-files-source-picker]")}.click()`);
    if (!(await until(h, `!!${q(option)}`, 5000))) return false;
    await h.ev(`${q(option)}.click()`);
    return until(h, `!!${q("[data-history-row]")}`, 15000);
}

export async function pickHistoryRow(h, subject) {
    const clicked = await h.ev(`(() => {
        const b = [...document.querySelectorAll("[data-history-row] > button")]
            .find((x) => x.textContent.includes(${JSON.stringify(subject)}));
        if (!b) return false;
        b.click();
        return true;
    })()`);
    return clicked && until(h, `!!${q("[data-changed-file-row]")} || !!${q("[data-diff-pane]")}`);
}

// opens a changed file and waits until the list marks it as the open one
export async function pickFile(h, path) {
    if (!(await until(h, `!!${q(fileRowSel(path))}`))) return false;
    await h.ev(`${q(fileRowSel(path))}.click()`);
    return until(h, `${q(fileRowSel(path))}?.getAttribute("aria-current") === "true"`);
}

export const historyRowCount = (h) => h.ev(`document.querySelectorAll("[data-history-row]").length`);

export async function removeFixtures(h, names, dirs) {
    for (const name of names) {
        try {
            await h.rpc("deleteproject", { name });
        } catch {
            /* leave a stale registry entry rather than failing teardown */
        }
    }
    for (const dir of dirs) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* a leftover temp repo is cheaper than a failed teardown */
        }
    }
}

export const SCOPE = {
    project: "verify-diff-scope",
    plain: "verify-diff-plain",
    remote: "verify-diff-remote",
    latest: `filler commit ${SCOPE_FILLER_COMMITS - 1}`,
    seed: "seed the ledger",
    side: "side: settle refunds on the side branch",
    stash: "verify stashed edit",
    edited: "ledger.txt",
    // a fixture agent working in the project; its name shares "diff-remote" with the remote project, so that
    // fragment matches exactly two sources, the agent drawn first
    agentId: "fx-diff-remote-chip",
    agent: "diff-remote-chip",
    twoSources: "diff-remote",
    noMatch: "zz-no-source-matches",
};

const FILTER_INPUT = `[aria-label="Filter sources"]`;
const KEYS = { ArrowDown: 40, Enter: 13, Escape: 27 };

async function pressKey(h, key) {
    const vk = KEYS[key];
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk });
}

const pickerLabel = (h) => textOf(h, "[data-files-source-picker]");
const pickerOpen = (h) => h.ev(`${q("[data-files-source-picker]")}?.getAttribute("aria-expanded") === "true"`);

// opens the source picker and types into its filter, replacing what a previous step left there
async function filterPicker(h, text) {
    if (!(await pickerOpen(h))) await h.ev(`${q("[data-files-source-picker]")}.click()`);
    if (!(await until(h, `!!${q(FILTER_INPUT)}`, 5000))) return false;
    await h.ev(`${q(FILTER_INPUT)}.focus(); ${q(FILTER_INPUT)}.select()`);
    await h.cdp("Input.insertText", { text });
    return until(h, `${q(FILTER_INPUT)}?.value === ${JSON.stringify(text)}`, 3000);
}

// The cockpit reads its roster from the dev fixture once at boot, and a card draws its diff chip only once its
// transcript names a cwd with changes: a transcript whose one line names the project gives a real chip from the
// real pipeline. The fixture file may be a developer's own, so it is kept and put back in teardown.
function seedChipAgent(dir) {
    const transcriptRoot = mkdtempSync(join(tmpdir(), "verify-diff-chip-"));
    const transcriptPath = join(transcriptRoot, "session.jsonl");
    const line = { type: "user", cwd: dir, timestamp: new Date().toISOString(), message: { role: "user", content: "settle the ledger" } };
    writeFileSync(transcriptPath, JSON.stringify(line) + "\n");
    const priorFixture = existsSync(TREE_RAIL_FIXTURE) ? readFileSync(TREE_RAIL_FIXTURE, "utf8") : null;
    mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
    const agent = {
        id: SCOPE.agentId,
        name: SCOPE.agent,
        project: SCOPE.project,
        task: "settle the ledger",
        state: "working",
        agent: "claude",
        model: "haiku",
        activeMs: 60_000,
        transcriptPath,
    };
    writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify([agent], null, 2));
    return { transcriptRoot, priorFixture };
}

function restoreFixture(priorFixture) {
    if (priorFixture == null) rmSync(TREE_RAIL_FIXTURE, { force: true });
    else writeFileSync(TREE_RAIL_FIXTURE, priorFixture);
}

function seedScopeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "verify-diff-scope-"));
    git(dir, "init", "-q", "--initial-branch=main");
    writeFileSync(join(dir, "ledger.txt"), "ledger\n");
    writeFileSync(join(dir, "notes.txt"), "notes\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", SCOPE.seed);
    for (let i = 0; i < SCOPE_FILLER_COMMITS; i++) {
        writeFileSync(join(dir, "notes.txt"), `notes\nentry ${i}\n`);
        git(dir, "commit", "-q", "-a", "-m", `filler commit ${i}`);
    }

    // the side branch lives in a second worktree, outside the project folder
    const sideRoot = mkdtempSync(join(tmpdir(), "verify-diff-scope-side-"));
    const side = join(sideRoot, "side");
    git(dir, "worktree", "add", "-q", "-b", "side", side);
    writeFileSync(join(side, "refunds.txt"), "refunds settle here\n");
    git(side, "add", ".");
    git(side, "commit", "-q", "-m", SCOPE.side);

    // stashed before the uncommitted edit, so the edit stays in the working tree
    writeFileSync(join(dir, "notes.txt"), "notes\nstashed line\n");
    git(dir, "stash", "push", "-q", "-m", SCOPE.stash);
    writeFileSync(join(dir, SCOPE.edited), "ledger\nan uncommitted line\n");
    return { dir, sideRoot };
}

function seedRemoteRepo() {
    const root = mkdtempSync(join(tmpdir(), "verify-diff-remote-"));
    const bare = join(root, "origin.git");
    const clone = join(root, "clone");
    mkdirSync(bare);
    git(bare, "init", "-q", "--bare", "--initial-branch=main");
    git(root, "clone", "-q", bare, clone);
    // an empty clone takes the user's init.defaultBranch, which may not be main
    git(clone, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(clone, "README.md"), "# remote\n");
    git(clone, "add", ".");
    git(clone, "commit", "-q", "-m", "seed the remote");
    git(clone, "push", "-q", "-u", "origin", "main");
    return { root, clone };
}

export const diffScope = {
    name: "diff-scope",
    surface: "files",
    async arrange(h) {
        const scope = seedScopeRepo();
        const plain = mkdtempSync(join(tmpdir(), "verify-diff-plain-"));
        const remote = seedRemoteRepo();
        const names = [SCOPE.project, SCOPE.plain, SCOPE.remote];
        await h.rpc("createproject", { name: SCOPE.project, path: scope.dir });
        await h.rpc("createproject", { name: SCOPE.plain, path: plain });
        await h.rpc("createproject", { name: SCOPE.remote, path: remote.clone });
        const chip = seedChipAgent(scope.dir);
        // fresh module state: Diff's scope, range and history collapse outlive the surface for the page's life; the
        // same reload reads the fixture roster
        await reloadApp(h);
        return {
            ...scope,
            plain,
            remoteRoot: remote.root,
            names,
            priorFixture: chip.priorFixture,
            dirs: [scope.dir, scope.sideRoot, plain, remote.root, chip.transcriptRoot],
        };
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        try {
            await setViewport(h);
            const opened = await openOnDiff(h, SCOPE.project);
            const rows = await historyRowCount(h);
            const top = await until(
                h,
                `[...document.querySelectorAll("[data-history-row]")].some((r) => r.textContent.includes(${JSON.stringify(SCOPE.latest)}))`
            );
            const edited = await pickFile(h, SCOPE.edited);
            const diff = edited && (await until(h, `!!${q(DIFF_EDITOR)}`));
            rec(
                "1. the project opens on Diff with a page of history, and its uncommitted edit opens a diff",
                opened && rows > 0 && top && diff,
                JSON.stringify({ opened, rows, top, edited, diff, pane: (await textOf(h, "[data-diff-pane]")).slice(0, 120) })
            );
            await h.shot("cdp-shots/diff-scope-open.png");

            // real keys reach the filter only while the page holds focus, which a dev window behind another lacks
            await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
            const typed = await filterPicker(h, SCOPE.twoSources);
            const rowsShown = await h.ev(`document.querySelectorAll("[data-files-source-agent], [data-files-source-option]").length`);
            await pressKey(h, "ArrowDown");
            const highlighted = await until(
                h,
                `${q("[data-highlighted]")}?.getAttribute("data-files-source-option") === ${JSON.stringify(SCOPE.remote)}`,
                3000
            );
            await h.shot("cdp-shots/diff-scope-picker-highlight.png");
            await pressKey(h, "Enter");
            const scoped = await until(h, `(${q("[data-files-source-picker]")}?.textContent ?? "").trim() === ${JSON.stringify(SCOPE.remote)}`);
            const closed = !(await pickerOpen(h));
            await filterPicker(h, SCOPE.noMatch);
            await pressKey(h, "Enter");
            await sleep(500);
            const stillOpen = await pickerOpen(h);
            const noMatch = await h.ev(`document.body.innerText.includes("No match")`);
            await h.shot("cdp-shots/diff-scope-picker-no-match.png");
            await pressKey(h, "Escape");
            rec(
                "2. picker keyboard: ArrowDown + Enter picks the second of two matches and closes; Enter on no match stays open",
                typed && rowsShown === 2 && highlighted && scoped && closed && stillOpen && noMatch,
                JSON.stringify({ typed, rowsShown, highlighted, scoped, closed, stillOpen, noMatch, label: await pickerLabel(h) })
            );

            const pinned = await openOnDiff(h, SCOPE.project);
            await h.goto("cockpit");
            const chipSel = `[data-diff-chip]`;
            const chip = await until(h, `!!${q(chipSel)}`, 15000);
            if (chip) await h.ev(`${q(chipSel)}.click()`);
            const named = chip && (await until(h, `(${q("[data-files-source-picker]")}?.textContent ?? "").trim() === ${JSON.stringify(SCOPE.agent)}`, 10000));
            await h.shot("cdp-shots/diff-scope-card-chip.png");
            rec(
                "3. card chip scopes to the agent: with Diff pinned to the project, the Cockpit card's diff chip opens Diff on that agent",
                pinned && chip && named,
                JSON.stringify({ pinned, chip, named, label: await pickerLabel(h) })
            );
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
        restoreFixture(ctx.priorFixture);
        await removeFixtures(h, ctx.names, ctx.dirs);
        // drop the fixture roster the page read at boot
        await reloadApp(h);
    },
};
