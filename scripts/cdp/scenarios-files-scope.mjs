// Diff surface scenario diff-scope: what the surface reads (sources, ranges, history bounds) on a repo with a long
// history, a second worktree, a stash and an uncommitted edit, beside a plain folder and a clone with a remote.
// The helpers below are shared with scenarios-files-states.mjs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, reloadApp } from "./scenarios-shared.mjs";

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
};

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
        // fresh module state: Diff's scope, range and history collapse outlive the surface for the page's life
        await reloadApp(h);
        return { ...scope, plain, remoteRoot: remote.root, names, dirs: [scope.dir, scope.sideRoot, plain, remote.root] };
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
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        await removeFixtures(h, ctx.names, ctx.dirs);
    },
};
