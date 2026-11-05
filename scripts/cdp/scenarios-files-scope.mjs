// Diff surface scenario diff-scope: what the surface reads (sources, ranges, history bounds) on a repo with a long
// history, a second worktree, a stash and an uncommitted edit, beside a plain folder and a clone with a remote.
// The helpers below are shared with scenarios-files-states.mjs.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINAL_SHOTS_UICTX, git, lookEval, reloadApp, teardownFixtureRun, TREE_RAIL_FIXTURE, waveService } from "./scenarios-shared.mjs";

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
    // a first-page commit no earlier step selects, so picking it reads its files afresh
    failCommit: "filler commit 55",
    // a second fixture agent whose transcript names its folder but carries no timestamp: a just-launched session
    noStartId: "fx-diff-no-start",
    noStart: "diff-no-start",
    // the label of the plain terminal tab the no-source step focuses
    terminalFocus: "verify-diff-terminal",
    remoteSeed: "seed the remote",
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

// the agents view model, found on the nav rail's props as the other scenarios find it
const MODEL = `(() => {
    const nav = document.querySelector('nav');
    const key = nav && Object.keys(nav).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? nav[key] : null; f != null; f = f.return) {
        if (f.memoizedProps?.model?.surfaceAtom != null) return f.memoizedProps.model;
    }
    return null;
})()`;

const NARROW = { width: 1000, height: 700 };
const SUMMARY = `(${q("[data-files-range-summary]")}?.textContent ?? "").trim()`;
const LIST_FAILURE = "[data-file-list-failure]";
const RAIL_ROWS = `document.querySelectorAll("[data-history-rail-row]").length`;
const widthOf = (sel) => `Math.round(${q(sel)}?.getBoundingClientRect().width ?? 0)`;

// a global key with nothing focused, as the reader presses it over the panes
async function pressGlobal(h, { key, code, vk, modifiers = 0 }) {
    await h.ev(`document.activeElement?.blur?.()`);
    const text = key.length === 1 ? { text: key } : {};
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers, ...text });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
}
const KEY_R = { key: "r", code: "KeyR", vk: 82 };
const KEY_SHIFT_H = { key: "H", code: "KeyH", vk: 72, modifiers: 8 };
const KEY_ENTER = { key: "Enter", code: "Enter", vk: 13 };

const clickButton = (h, scopeSel, label) =>
    h.ev(`(() => {
        const b = [...document.querySelectorAll(${JSON.stringify(`${scopeSel} button`)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        b?.click();
        return b != null;
    })()`);

// Moves every object out of the repository, so git still finds the repository but cannot read one commit. Each
// rename is retried: a git process the app is running can hold an object open for a moment on Windows.
async function emptyObjects(dir) {
    const objects = join(dir, ".git", "objects");
    const aside = mkdtempSync(join(tmpdir(), "verify-diff-objects-"));
    for (const name of readdirSync(objects)) {
        await renameRetrying(join(objects, name), join(aside, name));
    }
    return aside;
}

async function restoreObjects(dir, aside) {
    const objects = join(dir, ".git", "objects");
    for (const name of readdirSync(aside)) {
        await renameRetrying(join(aside, name), join(objects, name));
    }
    rmSync(aside, { recursive: true, force: true });
}

async function renameRetrying(from, to) {
    for (let i = 0; ; i++) {
        try {
            renameSync(from, to);
            return;
        } catch (e) {
            if (i >= 20) throw e;
            await sleep(150);
        }
    }
}

// Only the change list reads the index, so a corrupt one fails that read alone while git log still answers.
function corruptIndex(dir) {
    const index = join(dir, ".git", "index");
    renameSync(index, index + ".verify");
    writeFileSync(index, "not an index");
}

function restoreIndex(dir) {
    const index = join(dir, ".git", "index");
    rmSync(index, { force: true });
    renameSync(index + ".verify", index);
}

// the second fixture agent: its transcript names the project's folder and has no timestamp to anchor a session on
function seedNoStartAgent(h, ctx) {
    const root = mkdtempSync(join(tmpdir(), "verify-diff-nostart-"));
    ctx.dirs.push(root);
    const transcriptPath = join(root, "session.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ type: "user", cwd: ctx.dir, message: { role: "user", content: "start" } }) + "\n");
    return lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { devMockAgentsAtom } = await mod("app/view/agents/devmock.ts");
        const cur = globalStore.get(devMockAgentsAtom) ?? [];
        const base = cur.find((a) => a.id === ${JSON.stringify(SCOPE.agentId)}) ?? {};
        globalStore.set(devMockAgentsAtom, [...cur, { ...base, id: ${JSON.stringify(SCOPE.noStartId)}, name: ${JSON.stringify(SCOPE.noStart)}, activeMs: 0, transcriptPath: ${JSON.stringify(transcriptPath)} }]);
        return globalStore.get(devMockAgentsAtom).length;
    `);
}

async function openTerminalTab(h, ctx) {
    const bootTab = String(await h.ev("window.TabRpcClient.routeId")).replace(/^tab:/, "");
    const wslist = await h.rpc("workspacelist", null);
    const ws = wslist.find((w) => (w.workspacedata?.tabids ?? []).includes(bootTab)) ?? wslist[0];
    ctx.workspaceId = ws.workspacedata.oid;
    ctx.termTabId = await waveService(h, "workspace", "CreateTab", [ctx.workspaceId, SCOPE.terminalFocus, false]);
    const tab = await waveService(h, "object", "GetObject", [`tab:${ctx.termTabId}`]);
    const blockId = tab?.blockids?.[0];
    if (!blockId) throw new Error("the new tab has no block");
    await h.rpc("setmeta", { oref: `block:${blockId}`, meta: { view: "term", controller: "shell", "cmd:cwd": ctx.dir } });
    return { tabId: ctx.termTabId };
}

const dropAgent = (h, id) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { devMockAgentsAtom } = await mod("app/view/agents/devmock.ts");
        globalStore.set(devMockAgentsAtom, (globalStore.get(devMockAgentsAtom) ?? []).filter((a) => a.id !== ${JSON.stringify(id)}));
        return true;
    `);

// a pointer click at the element's centre, as the reader's mouse lands
async function mouseClick(h, sel) {
    const at = await h.ev(`(() => { const r = ${q(sel)}?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    if (at == null) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
        await h.cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    }
    return true;
}

async function pickSource(h, sel) {
    if (!(await pickerOpen(h))) await h.ev(`${q("[data-files-source-picker]")}.click()`);
    if (!(await until(h, `!!${q(sel)}`, 5000))) return false;
    await h.ev(`${q(sel)}.click()`);
    return true;
}

// Steps 9-12: the project's history, its open file, and what a failed read leaves on screen
async function historySteps(h, ctx, rec) {
    const onProject = (await openOnDiff(h, SCOPE.project)) && (await until(h, `/\\d+ commits loaded/.test(document.body.innerText)`));
    const rows = await historyRowCount(h);
    const label = await h.ev(`document.body.innerText.match(/(\\d+) commits loaded/)?.[0] ?? ""`);
    const uncommitted = await h.ev(historyHas("Uncommitted changes"));
    rec(
        "9. history counts: the count names the commits, not the uncommitted row above them",
        onProject && uncommitted && label === `${rows - 1} commits loaded`,
        JSON.stringify({ onProject, rows, label, uncommitted })
    );

    const wt = (await pickHistoryRow(h, "Uncommitted changes")) && (await pickFile(h, SCOPE.edited));
    const diff = wt && (await until(h, `!!${q(DIFF_EDITOR)}`));
    if (diff) await pressGlobal(h, KEY_ENTER);
    const code = diff
        ? await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { codeFileAtom } = await mod("app/view/code/codestore.ts");
            const model = ${MODEL};
            await until(() => globalStore.get(model.surfaceAtom) === "code" && globalStore.get(codeFileAtom)?.path === ${JSON.stringify(SCOPE.edited)}, 8000);
            return { surface: globalStore.get(model.surfaceAtom), file: globalStore.get(codeFileAtom)?.path ?? null };
        `)
        : null;
    await h.shot("cdp-shots/diff-scope-enter-code.png");
    rec(
        "10. Enter opens in Code: Enter on the open file switches to the Code surface on that file",
        code?.surface === "code" && code?.file === SCOPE.edited,
        JSON.stringify({ wt, diff, code })
    );
    await h.goto("files");

    // 11. a commit picked while git cannot read objects: the list says so and offers Retry, which reads it again
    let aside = null;
    try {
        // the surface's remount reads the change list and history again; emptying the objects under them
        // would fail those reads instead of the one this step is about
        await until(h, `${historyHas("Uncommitted changes")} && !!${q("[data-changed-file-row]")}`, 10000);
        await sleep(2000);
        aside = await emptyObjects(ctx.dir);
        const picked = await pickHistoryRow(h, SCOPE.failCommit);
        const failed = picked && (await until(h, `!!${q(LIST_FAILURE)} && !!${q("[data-file-list-retry]")}`, 10000));
        const message = failed ? await textOf(h, LIST_FAILURE) : "";
        await h.shot("cdp-shots/diff-scope-commit-failure.png");
        await restoreObjects(ctx.dir, aside);
        aside = null;
        if (failed) await h.ev(`${q("[data-file-list-retry]")}.click()`);
        const recovered = failed && (await until(h, `!${q(LIST_FAILURE)} && !!${q(fileRowSel("notes.txt"))}`, 10000));
        rec(
            "11. commit list failure: a commit whose files cannot be read shows the failure with Retry, and Retry reads them",
            failed && recovered,
            JSON.stringify({ picked, failed, recovered, message: message.slice(0, 160) })
        );
    } finally {
        if (aside) await restoreObjects(ctx.dir, aside);
    }

    // 12. a refresh that fails keeps the last read and says so; the next good read takes the notice away
    let corrupt = false;
    try {
        const onRow = (await pickHistoryRow(h, "Uncommitted changes")) && (await pickFile(h, SCOPE.edited));
        corruptIndex(ctx.dir);
        corrupt = true;
        await pressGlobal(h, KEY_R);
        const notice = await until(h, `!!${q("[data-files-refresh-failed]")}`, 10000);
        const noticeText = notice ? await textOf(h, "[data-files-refresh-failed]") : "";
        const rowStays = (await h.ev(historyHas("Uncommitted changes"))) && (await h.ev(`!!${q(fileRowSel(SCOPE.edited))}`));
        await h.shot("cdp-shots/diff-scope-refresh-failed.png");
        restoreIndex(ctx.dir);
        corrupt = false;
        await pressGlobal(h, KEY_R);
        const cleared = await until(h, `!${q("[data-files-refresh-failed]")}`, 10000);
        rec(
            "12. refresh failed notice: a failed r keeps the working-tree row and reads \"couldn’t refresh\"; a good r clears it",
            onRow && notice && noticeText.includes("couldn’t refresh") && rowStays && cleared,
            JSON.stringify({ onRow, notice, noticeText, rowStays, cleared })
        );
    } finally {
        if (corrupt) restoreIndex(ctx.dir);
    }
}

// Steps 13-16: compare on a repo without a remote, the rail and overlay at the shipped window size, Fetch on a clone
async function compareAndLayoutSteps(h, ctx, rec) {
    await openOnDiff(h, SCOPE.project);
    await h.ev(`${q('[data-range-chip="compare"]')}?.click()`);
    const comparing = await until(h, `${q('[data-range-chip="compare"]')}?.getAttribute("aria-pressed") === "true" && !!${q("[data-compare-column]")}`, 10000);
    // the pair the step reads: side is one commit ahead of main
    await lookEval(h, `
        const { setCompareRefs } = await mod("app/view/agents/comparestore.ts");
        await setCompareRefs(${JSON.stringify(ctx.dir)}, "main", "side");
    `);
    const sideRow = `[...document.querySelectorAll("[data-compare-column] button")].find((b) => b.textContent.includes(${JSON.stringify(SCOPE.side)}))`;
    const listed = comparing && (await until(h, `!!(${sideRow})`, 10000));
    // the branch list (and its remote answer) is in once the column is drawn
    await sleep(1000);
    const fetchShown = await h.ev(`!!${q("[data-files-fetch]")}`);
    rec(
        "13. no Fetch without a remote: comparing in a repository with no remote draws no Fetch",
        comparing && listed && !fetchShown,
        JSON.stringify({ comparing, listed, fetchShown })
    );

    let aside = null;
    try {
        aside = await emptyObjects(ctx.dir);
        if (listed) await h.ev(`(${sideRow}).click()`);
        const failed = listed && (await until(h, `!!${q(LIST_FAILURE)} && !!${q("[data-file-list-retry]")}`, 10000));
        await h.shot("cdp-shots/diff-scope-compare-row-failure.png");
        await restoreObjects(ctx.dir, aside);
        aside = null;
        if (failed) await h.ev(`${q("[data-file-list-retry]")}.click()`);
        const recovered = failed && (await until(h, `!${q(LIST_FAILURE)} && !!${q(fileRowSel("refunds.txt"))}`, 10000));
        rec(
            "14. compare row failure: a compare commit row whose files cannot be read shows the failure with Retry",
            failed && recovered,
            JSON.stringify({ failed, recovered })
        );
    } finally {
        if (aside) await restoreObjects(ctx.dir, aside);
    }

    // 15. at the shipped size the column is a rail: in compare its first dot is the whole comparison, and in history
    // scrolling it to the end reads the next page
    await setViewport(h, NARROW);
    const rail = await until(h, `!!${q("[data-history-rail]")}`, 5000);
    await h.ev(`${q("[data-history-rail-row]")}?.click()`);
    await sleep(500);
    const firstIsAll = await h.ev(`${q("[data-history-rail-scroll] button")}?.hasAttribute("data-history-rail-all") ?? false`);
    await h.ev(`${q("[data-history-rail-all]")}?.click()`);
    const allSelected = await until(
        h,
        `${q("[data-history-rail-all]")}?.getAttribute("aria-current") === "true"`,
        5000
    );
    const aggregate = await lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { compareSelectionAtom } = await mod("app/view/agents/comparestore.ts");
        return globalStore.get(compareSelectionAtom);
    `);
    await h.shot("cdp-shots/diff-scope-rail-all-changes.png");
    await h.ev(`${q('[data-range-chip="working"]')}?.click()`);
    const historyRail = await until(h, `${q('[data-range-chip="compare"]')}?.getAttribute("aria-pressed") !== "true" && ${RAIL_ROWS} > 0`, 10000);
    const before = await h.ev(RAIL_ROWS);
    await h.ev(`(() => { const el = ${q("[data-history-rail-scroll]")}; el.scrollTop = el.scrollHeight; })()`);
    const paged = await until(h, `${RAIL_ROWS} > ${before}`, 10000);
    const after = await h.ev(RAIL_ROWS);
    rec(
        "15. rail pages and has All changes: in compare the rail's first dot selects All changes; in history scrolling it loads the next page",
        rail && firstIsAll && allSelected && aggregate === "__aggregate__" && historyRail && paged,
        JSON.stringify({ rail, firstIsAll, allSelected, aggregate, before, after })
    );

    // 16. ⇧H at the shipped size opens the history over the panes rather than beside them
    const wt = await until(h, `!!${q(DIFF_EDITOR)}`);
    const paneBefore = await h.ev(widthOf("[data-diff-pane]"));
    await pressGlobal(h, KEY_SHIFT_H);
    const overlay = await until(h, `!!${q("[data-history-overlay] [data-history-row]")}`, 5000);
    await sleep(300);
    const paneAfter = await h.ev(widthOf("[data-diff-pane]"));
    const railStays = await h.ev(`!!${q("[data-history-rail]")}`);
    await h.shot("cdp-shots/diff-scope-overlay.png");
    await pressGlobal(h, KEY_SHIFT_H);
    const closed = await until(h, `!${q("[data-history-overlay]")}`, 5000);
    // the second press wrote an explicit "collapsed"; back to following the width for the steps after this one
    await lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { historyCollapsedAtom } = await mod("app/view/agents/difflayout.ts");
        globalStore.set(historyCollapsedAtom, null);
    `);
    rec(
        "16. overlay at 1000x700: ⇧H draws the history over the panes, leaving the diff pane's width as it was",
        wt && overlay && railStays && paneBefore > 0 && Math.abs(paneAfter - paneBefore) <= 1 && closed,
        JSON.stringify({ wt, overlay, railStays, paneBefore, paneAfter, closed })
    );
    await setViewport(h);

    // the previous project's rows stay drawn until the clone's load lands, and that load would drop a compare
    // entered before it, so wait for the clone's own commit first
    const onRemote = (await openOnDiff(h, SCOPE.remote)) && (await until(h, historyHas(SCOPE.remoteSeed), 15000));
    await h.ev(`${q('[data-range-chip="compare"]')}?.click()`);
    const remoteCompare = await until(h, `${q('[data-range-chip="compare"]')}?.getAttribute("aria-pressed") === "true"`, 10000);
    const fetchDrawn = onRemote && remoteCompare && (await until(h, `!!${q("[data-files-fetch]")}`, 10000));
    if (fetchDrawn) await mouseClick(h, "[data-files-fetch]");
    const fetched = fetchDrawn && (await until(h, `(${q("[data-files-fetched]")}?.textContent ?? "").trim() === "fetched just now"`, 15000));
    const fetchedText = await textOf(h, "[data-files-fetched]");
    const fetchStates = await lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const { fetchStatesAtom } = await mod("app/view/agents/comparestore.ts");
        const { filesStateAtom } = await mod("app/view/agents/filesstore.ts");
        return { states: globalStore.get(fetchStatesAtom), cwd: globalStore.get(filesStateAtom)?.cwd ?? null };
    `);
    await h.shot("cdp-shots/diff-scope-fetched.png");
    await h.ev(`${q('[data-range-chip="working"]')}?.click()`);
    rec(
        "17. fetched just now: on a clone with a remote, Fetch is drawn and its clock reads \"fetched just now\"",
        fetched,
        JSON.stringify({ onRemote, remoteCompare, fetchDrawn, fetchedText, fetchStates })
    );
}

// Steps 18-21: the plain folder, an agent with no session start, the same agent ended, and no source at all
async function subjectSteps(h, ctx, rec) {
    const plain = await pickSource(h, `[data-files-source-option=${JSON.stringify(SCOPE.plain)}]`);
    const notRepo = plain && (await until(h, `!!${q("[data-not-a-repo]")} && !!${q("[data-range-chip]")}`, 10000));
    const chips = await h.ev(`[...document.querySelectorAll("[data-range-chip]")].map((c) => c.getAttribute("data-range-chip"))`);
    await h.shot("cdp-shots/diff-scope-plain-no-compare.png");
    rec(
        "18. not a repo has no Compare: a plain folder offers no compare chip",
        notRepo && !chips.includes("compare"),
        JSON.stringify({ plain, notRepo, chips })
    );

    const seeded = await seedNoStartAgent(h, ctx);
    const picked = await pickSource(h, `[data-files-source-agent=${JSON.stringify(SCOPE.noStartId)}]`);
    const labelled = picked && (await until(h, `(${SUMMARY}).includes("(no session start yet)")`, 10000));
    const summary = await h.ev(SUMMARY);
    const chip = await h.ev(`(() => {
        const c = ${q('[data-range-chip="session"]')};
        return c ? { disabled: c.disabled, pressed: c.getAttribute("aria-pressed"), text: c.textContent.trim() } : null;
    })()`);
    await h.shot("cdp-shots/diff-scope-no-session-start.png");
    rec(
        "19. agent without a session start: the summary says it is measured from HEAD, and the session chip stays enabled",
        labelled && chip != null && !chip.disabled && chip.pressed === "true",
        JSON.stringify({ seeded, picked, summary, chip })
    );

    await dropAgent(h, SCOPE.noStartId);
    const ended = await until(h, `document.body.innerText.includes("This agent has ended")`, 10000);
    // the Agent surface moves focus to the remaining agent; the ended state must outlast that
    await sleep(1500);
    const held = await h.ev(`document.body.innerText.includes("This agent has ended")`);
    const body = await h.ev(`document.body.innerText.includes(${JSON.stringify(`Its changes are in ${ctx.dir}.`)})`);
    await h.shot("cdp-shots/diff-scope-ended-agent.png");
    const clicked = ended && (await clickButton(h, "body", "Open its folder"));
    const rescoped = clicked && (await until(h, `(${q("[data-files-source-picker]")}?.textContent ?? "").trim() === ${JSON.stringify(SCOPE.project)} && !!${q("[data-history-row]")}`, 15000));
    rec(
        "20. ended agent: an agent that leaves the roster reads \"This agent has ended\", and its action opens its folder's project",
        ended && held && body && rescoped,
        JSON.stringify({ ended, held, body, clicked, rescoped, label: await pickerLabel(h) })
    );

    // a real terminal: the Agent surface keeps a focus only on an agent or a terminal it can mount
    const term = await openTerminalTab(h, ctx).catch((e) => ({ error: String(e?.message ?? e) }));
    const focused =
        term.tabId != null &&
        (await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const model = ${MODEL};
            const id = ${JSON.stringify(term.tabId ?? "")};
            const listed = await until(() => globalStore.get(model.terminalsAtom).some((t) => t.id === id), 15000);
            globalStore.set(model.focusIdAtom, id);
            globalStore.set(model.diffScopeAtom, null);
            return listed;
        `));
    const pick = focused && (await until(h, `document.body.innerText.includes("Pick something to review")`, 5000));
    await sleep(1000);
    const pickHeld = await h.ev(`document.body.innerText.includes("Pick something to review")`);
    await h.shot("cdp-shots/diff-scope-no-source.png");
    const chose = pick && (await clickButton(h, "body", "Choose a source"));
    const opens = chose && (await until(h, `${q("[data-files-source-picker]")}?.getAttribute("aria-expanded") === "true"`, 3000));
    rec(
        "21. no source picked: with a terminal focused and no scope, Diff asks to pick a source, and its action opens the picker",
        pick && pickHeld && opens,
        JSON.stringify({ term, focused, pick, pickHeld, chose, opens })
    );
    await pressKey(h, "Escape");
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
    git(clone, "commit", "-q", "-m", SCOPE.remoteSeed);
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

            await historySteps(h, ctx, rec);
            await compareAndLayoutSteps(h, ctx, rec);
            await subjectSteps(h, ctx, rec);
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
        if (ctx.termTabId) {
            await waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.termTabId, false]).catch((e) =>
                console.error(`diff-scope teardown: closing the terminal tab: ${e?.message ?? e}`)
            );
        }
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
