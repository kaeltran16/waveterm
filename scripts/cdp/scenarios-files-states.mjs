// Diff surface scenario diff-states: the diff pane's states (binary, too large, empty, deleted, nothing picked,
// read failure) on one repo whose working tree holds a file of each kind and whose history has a commit with no
// files. Helpers come from scenarios-files-scope.mjs.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, reloadApp } from "./scenarios-shared.mjs";
import {
    DIFF_EDITOR,
    fileRowSel,
    historyRowCount,
    openOnDiff,
    pickFile,
    removeFixtures,
    setViewport,
    textOf,
    until,
} from "./scenarios-files-scope.mjs";

const BLOB_BYTES = 1024;
// over the pane's size limit for an untracked file
const BIG_LOG_BYTES = 3 * 1024 * 1024;

export const STATES = {
    project: "verify-diff-states",
    seed: "seed the states repo",
    noFiles: "a commit with no files",
    deleted: "src/old.py",
    deletedEmpty: "src/gone.txt",
    binary: "src/blob.bin",
    big: "big.log",
    empty: "src/empty.txt",
};

function seedStatesRepo() {
    const dir = mkdtempSync(join(tmpdir(), "verify-diff-states-"));
    git(dir, "init", "-q", "--initial-branch=main");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, STATES.deleted), "def old():\n    return 1\n");
    writeFileSync(join(dir, STATES.deletedEmpty), "");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", STATES.seed);
    git(dir, "commit", "-q", "--allow-empty", "-m", STATES.noFiles);
    rmSync(join(dir, STATES.deleted));
    rmSync(join(dir, STATES.deletedEmpty));
    writeFileSync(join(dir, STATES.binary), randomBytes(BLOB_BYTES));
    writeFileSync(join(dir, STATES.big), "x".repeat(BIG_LOG_BYTES - 1) + "\n");
    writeFileSync(join(dir, STATES.empty), "");
    return dir;
}

export const diffStates = {
    name: "diff-states",
    surface: "files",
    async arrange(h) {
        const dir = seedStatesRepo();
        await h.rpc("createproject", { name: STATES.project, path: dir });
        // fresh module state: Diff's scope, range and history collapse outlive the surface for the page's life
        await reloadApp(h);
        return { dir, names: [STATES.project], dirs: [dir] };
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        try {
            await setViewport(h);
            const opened = await openOnDiff(h, STATES.project);
            // the working tree draws as a history row of its own, above the two commits
            const rows = await historyRowCount(h);
            const commits = await h.ev(`(() => {
                const text = [...document.querySelectorAll("[data-history-row]")].map((r) => r.textContent).join("\\n");
                return [${JSON.stringify(STATES.seed)}, ${JSON.stringify(STATES.noFiles)}].every((s) => text.includes(s));
            })()`);
            const files = [STATES.deleted, STATES.deletedEmpty, STATES.binary, STATES.big, STATES.empty];
            const listed = await until(h, files.map((p) => `!!document.querySelector(${JSON.stringify(fileRowSel(p))})`).join(" && "));
            const listedRows = await h.ev(
                `[...document.querySelectorAll("[data-changed-file-row]")].map((e) => e.dataset.changedFileRow).join(",")`
            );
            const picked = await pickFile(h, STATES.deleted);
            const diff = picked && (await until(h, `!!document.querySelector(${JSON.stringify(DIFF_EDITOR)})`));
            rec(
                "1. the project opens on Diff with its two commits, lists each working-tree file, and the deleted file opens a diff",
                opened && rows === 3 && commits && listed && diff,
                JSON.stringify({ opened, rows, commits, listed, listedRows, picked, diff, pane: (await textOf(h, "[data-diff-pane]")).slice(0, 120) })
            );
            await h.shot("cdp-shots/diff-states-open.png");
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        await removeFixtures(h, ctx.names, ctx.dirs);
    },
};
