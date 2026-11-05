// Diff surface scenario diff-scope: what the surface reads (sources, ranges, history bounds) on a repo with a long
// history, a second worktree, a stash and an uncommitted edit, beside a plain folder and a clone with a remote.
// The helpers below are shared with scenarios-files-states.mjs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINAL_SHOTS_UICTX, git, reloadApp, teardownFixtureRun, TREE_RAIL_FIXTURE, waveService } from "./scenarios-shared.mjs";

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
    // the landed run: its one commit, merged --no-ff into main, then a commit on main after it. audit.txt sorts
    // before run/ in git's list but after it in the tree, so the first file opened says which order was used
    runChannel: "verify-diff-scope-run",
    runCommit: "run: pay out the ledger",
    runFiles: ["audit.txt", "run/payout.txt"],
    runFirstTreeFile: "run/payout.txt",
    landMerge: "land the payout run",
    afterLand: "after the run landed",
    afterLandFile: "later.txt",
    // any commit on the first page, so the run link has a remembered row to override
    projectCommit: "filler commit 50",
};

const rev = (dir, ref) => git(dir, "rev-parse", ref).toString().trim();

// A real run record held by deferstart, so no lead starts. Its landing tree gets the run's commit, main merges it
// --no-ff the way a land does, and a later commit lands on main; the record then reads done and landed at that
// merge, with sealed evidence so the run sheet draws its diff link. endcommit stays unset: the tip must come from
// the land commit's parents.
// fills `run` as it goes, so teardown removes whatever was made before a failure
async function seedLandedRun(h, run) {
    const dir = run.cwd;
    const wslist = await h.rpc("workspacelist", null);
    const ch = await h.rpc("createchannel", { name: SCOPE.runChannel, projectpath: dir });
    run.channelId = ch.oid;
    const created = await h.rpc("createrun", {
        channelid: ch.oid,
        workspaceid: wslist[0].workspacedata.oid,
        goal: "verify diff-scope: do nothing, make no file changes, stop immediately",
        runtime: "claude",
        mode: "orchestrator",
        deferstart: true,
    });
    run.runId = created.run.id;
    run.landPath = created.run.landpath;
    run.base = created.run.basecommit || rev(dir, "HEAD");
    const tree = run.landPath;
    if (!tree) throw new Error("createrun made no landing tree");
    mkdirSync(join(tree, "run"), { recursive: true });
    writeFileSync(join(tree, "run", "payout.txt"), "payouts settle here\n");
    writeFileSync(join(tree, "audit.txt"), "audited\n");
    git(tree, "add", ...SCOPE.runFiles);
    git(tree, "commit", "-q", "-m", SCOPE.runCommit);
    run.tip = rev(tree, "HEAD");
    git(dir, "merge", "-q", "--no-ff", "-m", SCOPE.landMerge, run.tip);
    run.merge = rev(dir, "HEAD");
    writeFileSync(join(dir, SCOPE.afterLandFile), "later\n");
    git(dir, "add", SCOPE.afterLandFile);
    git(dir, "commit", "-q", "-m", SCOPE.afterLand);
    const oref = `run:${run.runId}`;
    const evidence = {
        capturedts: Date.now(),
        hash: "",
        files: SCOPE.runFiles.map((path) => ({ path, stat: "A", add: 1, del: 0 })),
        addtotal: 2,
        deltotal: 0,
        runtimems: 0,
        durationms: 0,
    };
    const stored = await waveService(h, "object", "GetObject", [oref]);
    await waveService(
        h,
        "object",
        "UpdateObject",
        [{ ...stored, otype: "run", status: "done", report: "", evidence, land: { state: "landed", commit: run.merge } }, false],
        FINAL_SHOTS_UICTX
    );
}

const SELECTED_ROW = `[...document.querySelectorAll("[data-history-row] > button.bg-surface-selected")].map((b) => b.textContent).join(" | ")`;
const historyHas = (subject) =>
    `[...document.querySelectorAll("[data-history-row]")].some((r) => r.textContent.includes(${JSON.stringify(subject)}))`;
const FILE_ROWS = `[...document.querySelectorAll("[data-changed-file-row]")].map((r) => r.getAttribute("data-changed-file-row"))`;
const OPEN_FILE = `document.querySelector('[data-changed-file-row][aria-current="true"]')?.getAttribute("data-changed-file-row") ?? null`;

// the row the divider labels, and whether it and the row above it are dimmed
const DIVIDER_ROW = `(() => {
    const rows = [...document.querySelectorAll("[data-history-row]")];
    const i = rows.findIndex((r) => r.firstElementChild?.tagName === "DIV" && /run base/i.test(r.firstElementChild.textContent));
    if (i < 0) return null;
    const dim = (r) => !!r?.querySelector("button span.text-muted.flex-1");
    return { subject: rows[i].querySelector("button span.flex-1")?.textContent ?? "", dimmed: dim(rows[i]), aboveDimmed: dim(rows[i - 1]), above: rows[i - 1]?.textContent ?? "" };
})()`;

// a value once it has held across one half-second poll
async function settled(h, expr) {
    let last = null;
    for (let waited = 0; waited < WAIT_MS; waited += 500) {
        const now = await h.ev(expr);
        if (now && now === last) return now;
        last = now;
        await sleep(500);
    }
    return last;
}

// Steps 4-7: the landed run, opened from its sheet after a commit was picked on the project
async function runSteps(h, ctx, rec) {
    const { run } = ctx;
    if (ctx.runError) {
        rec("4-7. the landed run fixture", false, ctx.runError);
        return;
    }
    // the project's own load has to settle first, or it moves the selection off a row picked while it ran
    const onProject =
        (await openOnDiff(h, SCOPE.project)) && (await until(h, `${SELECTED_ROW}.includes("Uncommitted changes")`, 15000));
    const picked = onProject && (await pickHistoryRow(h, SCOPE.projectCommit));
    const pickedRow = picked ? await settled(h, SELECTED_ROW) : null;
    const opened = await openRunFromSheet(h, run.runId);
    // the summary counts the change list only once it is in, which is when its row can be selected
    const runRow = opened && (await until(h, `${SELECTED_ROW}.includes("Run changes")`, 15000));
    const summary = runRow ? await settled(h, `(${q("[data-files-range-summary]")}?.textContent ?? "").trim()`) : "";
    const want = `${run.base.slice(0, 7)} … ${run.tip.slice(0, 7)} · ${SCOPE.runFiles.length} files`;
    await h.shot("cdp-shots/diff-scope-run-bounded.png");
    rec(
        "4. run range bounded: a landed run opens on <base> … <tip>, counting none of the commit landed after it",
        opened && !!summary?.startsWith(want),
        JSON.stringify({ opened, summary, want })
    );

    const row = await settled(h, SELECTED_ROW);
    rec(
        "5. run link selects Run changes: the commit picked on the project gives way to the run's own row",
        !!pickedRow?.includes(SCOPE.projectCommit) && !!row?.includes("Run changes"),
        JSON.stringify({ pickedRow, row })
    );

    const divider = await h.ev(DIVIDER_ROW);
    const sideListed = await h.ev(historyHas(SCOPE.side));
    const laterListed = await h.ev(historyHas(SCOPE.afterLand));
    rec(
        "6. session divider: under the run, the side branch's commit is absent and the divider sits above the dimmed base row",
        !!divider?.subject.includes(SCOPE.latest) && divider.dimmed && !divider.aboveDimmed && !sideListed && !laterListed,
        JSON.stringify({ divider, sideListed, laterListed })
    );

    const open = await settled(h, OPEN_FILE);
    const order = await h.ev(FILE_ROWS);
    await h.shot("cdp-shots/diff-scope-first-file.png");
    rec(
        "7. first file is first row: in tree mode the run opens on the first file row drawn, not git's first file",
        open === SCOPE.runFirstTreeFile && order[0] === open,
        JSON.stringify({ open, order })
    );
}

// opens the run's sheet the way a finished run is reached and follows its diff link, which calls openRunDiff
async function openRunFromSheet(h, runId) {
    await h.goto("jarvis");
    if (!(await until(h, `typeof window.__openAddress === "function"`, 5000))) return false;
    await h.ev(`window.__openAddress(${JSON.stringify(`run:${runId}`)})`);
    const link = `[...document.querySelectorAll("[data-evidence-block] button")].find((b) => /open the repository diff/.test(b.textContent || ""))`;
    if (!(await until(h, `!!(${link})`, 10000))) return false;
    await h.ev(`${link}.click()`);
    return until(h, `(${q("[data-files-range-summary]")}?.textContent ?? "").includes("…")`, 15000);
}

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
        const run = { cwd: scope.dir };
        let runError = null;
        try {
            await seedLandedRun(h, run);
        } catch (e) {
            runError = String(e?.message ?? e);
        }
        // fresh module state: Diff's scope, range and history collapse outlive the surface for the page's life; the
        // same reload reads the fixture roster
        await reloadApp(h);
        return {
            ...scope,
            plain,
            remoteRoot: remote.root,
            names,
            run,
            runError,
            priorFixture: chip.priorFixture,
            dirs: [scope.dir, scope.sideRoot, plain, remote.root, chip.transcriptRoot],
        };
    },
    async assert(h, ctx) {
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

            await runSteps(h, ctx, rec);

            const onProject = await openOnDiff(h, SCOPE.project);
            await until(h, historyHas(SCOPE.afterLand));
            const stashRow = await h.ev(`${historyHas("verify stashed edit")} || ${historyHas("index on main")}`);
            const stashChip = await h.ev(
                `[...document.querySelectorAll("[data-history-row] button span")].some((s) => ["stash", "refs/stash"].includes(s.textContent.trim()))`
            );
            await h.shot("cdp-shots/diff-scope-no-stash.png");
            rec(
                "8. stash not listed: the project's history has no row and no chip for the fixture's stash",
                onProject && !stashRow && !stashChip,
                JSON.stringify({ onProject, stashRow, stashChip })
            );
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
        restoreFixture(ctx.priorFixture);
        if (ctx.run?.channelId) {
            // a done run cannot be cancelled; this deletes its channel and its landing tree
            await teardownFixtureRun(h, { ...ctx.run, runId: null }, "diff-scope", null).catch((e) =>
                console.error(`diff-scope teardown: ${e?.message ?? e}`)
            );
        }
        await removeFixtures(h, ctx.names, ctx.dirs);
        // drop the fixture roster the page read at boot
        await reloadApp(h);
    },
};
