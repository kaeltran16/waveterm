// The project Overview's Branches region (frontend/app/view/agents/projectbranches.tsx), checked inside the scenario
// scenarios-project-overview.mjs. It starts and ends with the modal open on ctx.project, restores in a finally
// whatever it installed, and names its steps "project-overview: <Board> board, branches: <state>".
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeOverview, openOverview, pageEval, shot } from "./project-overview-kit.mjs";
import { git } from "./scenarios-shared.mjs";
import { removeCodeRepo } from "./scenarios-code-kit.mjs";

const SIDE = "feat/verify-side";
const MAIN_SUBJECT = "verify: second commit on main";

const BRANCHES = `
    const region = () => overview()?.querySelector('[data-overview-region="branches"]');
    const commits = () => [...(region()?.querySelectorAll("[data-overview-commit]") ?? [])];
    const api = async () => (await mod("app/store/wshclientapi.ts")).RpcApi;
    const histStore = () => mod("app/view/agents/githistorystore.ts");
`;
const branchesEval = (h, body) => pageEval(h, `${BRANCHES} ${body}`);

// swaps RpcApi.GitHistoryCommand for `impl` (a page-side expression taking the original); restoreStub undoes it
const STUB = (impl) => `
    const A = await api();
    if (window.__branchesStub == null) {
        window.__branchesStub = { own: Object.prototype.hasOwnProperty.call(A, "GitHistoryCommand"), orig: A.GitHistoryCommand };
    }
    A.GitHistoryCommand = (${impl})(window.__branchesStub.orig.bind(A));
`;
const RESTORE = `
    if (window.__branchesStub != null) {
        const A = await api();
        if (window.__branchesStub.own) A.GitHistoryCommand = window.__branchesStub.orig;
        else delete A.GitHistoryCommand;
        delete window.__branchesStub;
    }
`;
// lets every read the loading stub held go through
const RELEASE = `window.__branchesRelease?.(); delete window.__branchesRelease; delete window.__branchesHeld;`;

// a temp folder, registered as a project; with git it is initialised but holds no commit
function makeBareFolder(withGit) {
    const dir = mkdtempSync(join(tmpdir(), "verify-overview-"));
    writeFileSync(join(dir, "notes.txt"), "plain\n");
    if (withGit) git(dir, "init", "-q", "-b", "main");
    return dir;
}

async function dropProject(h, extra) {
    if (extra == null) return;
    await h.rpc("deleteproject", { name: extra.name }).catch(() => {});
    removeCodeRepo(extra.dir);
}

// registers a second project on its own folder, opens the Overview on it, and reads the Branches region's note
async function readOtherProject(h, ctx, key, withGit) {
    const extra = { name: `${ctx.project}-${key}`, dir: makeBareFolder(withGit) };
    ctx[`branches_${key}`] = extra;
    try {
        await closeOverview(h);
        await pageEval(h, `
            await ps.registerProject(${JSON.stringify(extra.name)}, ${JSON.stringify(extra.dir)});
            await until(() => S.globalStore.get(ps.projectsAtom)?.[${JSON.stringify(extra.name)}] != null, 10000);
        `);
        const open = await openOverview(h, extra.name);
        const read = await branchesEval(h, `
            const note = () => region()?.querySelector("p");
            const shown = await until(() => note() != null, 10000);
            return { shown, note: flat(note()), rows: commits().length, alert: region()?.querySelector('[role="alert"]') != null };
        `);
        await shot(h, `branches-${key}`);
        return { open, ...read };
    } finally {
        await closeOverview(h).catch(() => {});
        await dropProject(h, extra);
        delete ctx[`branches_${key}`];
        await openOverview(h, ctx.project);
    }
}

export async function steps(h, ctx) {
    const steps = [];

    // a side branch off init with two commits, and one more commit on main, so the log has two lanes
    git(ctx.dir, "checkout", "-q", "-b", SIDE);
    for (const n of [1, 2]) {
        writeFileSync(join(ctx.dir, `side-${n}.md`), `side ${n}\n`);
        git(ctx.dir, "add", `side-${n}.md`);
        git(ctx.dir, "commit", "-q", "-m", `verify: side commit ${n}`);
    }
    git(ctx.dir, "checkout", "-q", "main");
    writeFileSync(join(ctx.dir, "MAIN.md"), "main\n");
    git(ctx.dir, "add", "MAIN.md");
    git(ctx.dir, "commit", "-q", "-m", MAIN_SUBJECT);
    const mainHash = git(ctx.dir, "rev-parse", "HEAD").toString().trim();

    // the region reads the log once per opening, so reopen to see the new commits
    await closeOverview(h);
    await openOverview(h, ctx.project);

    // 1. rows: the uncommitted row first, the branch chips, two lanes in the gutter
    const rows = await branchesEval(h, `
        const shown = await until(() => commits().length >= 5, 10000);
        const r = region();
        const chips = [...(r?.querySelectorAll("[data-ref-chip]") ?? [])].map(flat);
        const lanes = new Set([...(r?.querySelectorAll("[data-graph-gutter] circle") ?? [])].map((c) => c.getAttribute("cx")));
        return {
            shown,
            first: commits()[0]?.getAttribute("data-overview-commit"),
            firstText: flat(commits()[0]),
            head: flat(r?.querySelector("section > div")),
            chips,
            lanes: lanes.size,
            count: commits().length,
        };
    `);
    await shot(h, "branches-rows");
    steps.push({
        step: "project-overview: Main board, branches: the uncommitted row leads, main and side chips, two lanes",
        ok:
            rows?.shown === true &&
            rows.first === "uncommitted" &&
            rows.firstText.startsWith("Uncommitted changes") &&
            rows.chips.includes("main") &&
            rows.chips.includes(SIDE) &&
            rows.lanes >= 2 &&
            rows.head.includes(String(rows.count - 1)) &&
            rows.head.includes("open in Diff"),
        detail: JSON.stringify(rows),
    });

    // 2. a commit on main opens the Diff on that commit and closes the modal
    const commitClick = await branchesEval(h, `
        const hash = ${JSON.stringify(mainHash)};
        region()?.querySelector('[data-overview-commit="' + hash + '"]')?.click();
        const H = await histStore();
        const landed = await until(
            () => overview() == null && S.globalStore.get(model.surfaceAtom) === "files" && S.globalStore.get(H.selectedCommitAtom) === hash,
            15000
        );
        await nap(400);
        const selected = [...document.querySelectorAll("[data-history-row] > button.bg-surface-selected")].map(flat).join(" | ");
        return {
            landed,
            modalGone: overview() == null,
            surface: S.globalStore.get(model.surfaceAtom),
            selectedCommit: S.globalStore.get(H.selectedCommitAtom),
            selectedRow: selected,
        };
    `);
    await shot(h, "branches-commit-click");
    steps.push({
        step: "project-overview: Main board, branches: a commit row opens the Diff on that commit and closes the modal",
        ok:
            commitClick?.landed === true &&
            commitClick.selectedCommit === mainHash &&
            commitClick.selectedRow.includes(mainHash.slice(0, 7)),
        detail: JSON.stringify(commitClick),
    });
    await openOverview(h, ctx.project);

    // 3. "open in Diff ↗" scopes the Diff to this project's repo and closes the modal
    const link = await branchesEval(h, `
        await until(() => commits().length > 0, 10000);
        S.globalStore.set(model.surfaceAtom, "cockpit");
        await nap(200);
        button(region(), /open in Diff/)?.click();
        const landed = await until(() => overview() == null && S.globalStore.get(model.surfaceAtom) === "files", 10000);
        const origin = S.globalStore.get(model.diffScopeAtom)?.repo?.origin;
        return { landed, origin };
    `);
    await shot(h, "branches-open-in-diff");
    steps.push({
        step: "project-overview: Main board, branches: 'open in Diff' scopes the Diff to the project and closes the modal",
        ok:
            link?.landed === true &&
            link.origin?.kind === "project" &&
            link.origin.name === ctx.project &&
            link.origin.path === ctx.dir,
        detail: JSON.stringify(link),
    });
    await openOverview(h, ctx.project);

    // 4. loading: skeleton lines while the log read is held. Back on the Cockpit, so no Diff read shares the stub.
    await closeOverview(h);
    await pageEval(h, `S.globalStore.set(model.surfaceAtom, "cockpit"); await nap(300);`);
    let loading;
    try {
        await branchesEval(
            h,
            STUB(`(orig) => (...a) => new Promise((resolve) => {
                const held = (window.__branchesHeld ??= []);
                held.push(() => resolve(orig(...a)));
                window.__branchesRelease = () => held.splice(0).forEach((go) => go());
            })`)
        );
        await openOverview(h, ctx.project);
        loading = await branchesEval(h, `
            const skeleton = () => region()?.querySelector('div[aria-hidden="true"] .h-3') != null;
            const held = await until(skeleton, 4000);
            return { held, rows: commits().length };
        `);
        await shot(h, "branches-loading");
        loading.released = await branchesEval(h, `
            window.__branchesRelease?.();
            return until(() => commits().length > 0, 10000);
        `);
    } finally {
        await branchesEval(h, `${RESTORE} ${RELEASE}`).catch(() => {});
    }
    steps.push({
        step: "project-overview: Main board, branches: loading shows skeleton lines until the log arrives",
        ok: loading?.held === true && loading.rows === 0 && loading.released === true,
        detail: JSON.stringify(loading),
    });

    // 5. a repository with no commit
    const empty = await readOtherProject(h, ctx, "nocommit", true);
    steps.push({
        step: "project-overview: Main board, branches: a repository with no commit reads 'No commits yet.'",
        ok: empty?.shown === true && empty.note === "No commits yet." && empty.rows === 0,
        detail: JSON.stringify(empty),
    });

    // 6. a folder git does not know
    const norepo = await readOtherProject(h, ctx, "norepo", false);
    steps.push({
        step: "project-overview: Quiet board, branches: a plain folder reads '<project> is not a git repository.'",
        ok: norepo?.shown === true && norepo.note === `${ctx.project}-norepo is not a git repository.` && norepo.rows === 0,
        detail: JSON.stringify(norepo),
    });

    // 7. a failed read names git's own stderr, and Retry brings the rows back
    await closeOverview(h);
    let failed;
    try {
        await branchesEval(
            h,
            STUB(`() => async () => ({ isrepo: true, head: "", failure: { command: "git log", exitcode: 128, stderr: "fatal: verify stub failure" } })`)
        );
        await openOverview(h, ctx.project);
        failed = await branchesEval(h, `
            const alert = () => region()?.querySelector('[role="alert"]');
            const shown = await until(() => alert() != null, 8000);
            return { shown, text: flat(alert()) };
        `);
        await shot(h, "branches-failed");
    } finally {
        await branchesEval(h, RESTORE).catch(() => {});
    }
    const retried = await branchesEval(h, `
        button(region()?.querySelector('[role="alert"]'), /^Retry$/)?.click();
        const back = await until(() => commits().length > 0 && region()?.querySelector('[role="alert"]') == null, 10000);
        return { back, rows: commits().length };
    `);
    await shot(h, "branches-retried");
    steps.push({
        step: "project-overview: Failures board, branches: a failed read shows git's stderr, and Retry restores the rows",
        ok:
            failed?.shown === true &&
            failed.text.includes("Could not read the commits: fatal: verify stub failure") &&
            retried?.back === true,
        detail: JSON.stringify({ failed, retried }),
    });

    return steps;
}

export async function cleanup(h, ctx) {
    await branchesEval(h, `${RESTORE} ${RELEASE}`).catch(() => {});
    for (const key of ["nocommit", "norepo"]) {
        await dropProject(h, ctx[`branches_${key}`]);
        delete ctx[`branches_${key}`];
    }
}
