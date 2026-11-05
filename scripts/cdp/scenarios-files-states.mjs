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
    pickHistoryRow,
    removeFixtures,
    setViewport,
    textOf,
    until,
} from "./scenarios-files-scope.mjs";

const BLOB_BYTES = 1024;
// over the pane's size limit for an untracked file
const BIG_LOG_BYTES = 3 * 1024 * 1024;
// diffoptions.SPLIT_MIN_PX: below it the pane offers no split, so the hint names ⇧H instead of ⇧D
const SPLIT_MIN_PX = 900;
const NARROW_HINT = "Removed lines: collapse history (⇧H) or widen the window to use split view and comment on them";
const PANE = "[data-diff-pane]";
const emptyIs = (kind) => `!!document.querySelector(${JSON.stringify(`${PANE} [data-diff-empty="${kind}"]`)})`;

// opens a file and waits for the pane's empty state of that kind; returns what the pane says
async function emptyStateOf(h, path, kind) {
    const picked = await pickFile(h, path);
    const shown = picked && (await until(h, emptyIs(kind)));
    return { picked, shown, pane: (await textOf(h, PANE)).slice(0, 160) };
}

// an open diff can hold focus in Monaco, where the dispatcher lets every key through
async function pressKey(h, key, code, vk) {
    await h.ev("document.activeElement?.blur?.()");
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, text: key, windowsVirtualKeyCode: vk });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
}

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
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        // one failed step is one FAIL row, not an abort of every step after it
        const guard = async (step, fn) => {
            try {
                await fn();
            } catch (e) {
                rec(step, false, String(e?.message ?? e));
            }
        };
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
            return steps;
        }

        const s2 = "2. untracked binary: the working-tree read says Binary file instead of drawing bytes";
        await guard(s2, async () => {
            const got = await emptyStateOf(h, STATES.binary, "binary");
            rec(s2, got.shown && got.pane.includes("Binary file"), JSON.stringify(got));
            await h.shot("cdp-shots/diff-states-binary.png");
        });

        const s3 = "3. untracked too large: a 3 MB untracked file is capped on the working-tree side";
        await guard(s3, async () => {
            const got = await emptyStateOf(h, STATES.big, "toolarge");
            rec(s3, got.shown && got.pane.includes("Too large to show here"), JSON.stringify(got));
        });

        const s4 = "4. new empty file: an empty untracked file reads New empty file, not a rename";
        await guard(s4, async () => {
            const got = await emptyStateOf(h, STATES.empty, "newempty");
            rec(s4, got.shown && got.pane.includes("New empty file"), JSON.stringify(got));
            await h.shot("cdp-shots/diff-states-new-empty.png");
        });

        const s5 = "5. deleted empty file: a deleted empty file reads Deleted empty file, not a rename";
        await guard(s5, async () => {
            const got = await emptyStateOf(h, STATES.deletedEmpty, "deletedempty");
            rec(s5, got.shown && got.pane.includes("Deleted empty file"), JSON.stringify(got));
        });

        const s6 = "6. narrow-pane hint: with history expanded at 1600x950 the removed-lines hint names ⇧H, not ⇧D";
        await guard(s6, async () => {
            // the history column is what narrows the pane below split's width
            await h.ev(`document.querySelector('[aria-label="Expand history"]')?.click()`);
            const expanded = await until(h, `!document.querySelector('[aria-label="Expand history"]')`);
            const picked = await pickFile(h, STATES.deleted);
            const diff = picked && (await until(h, `!!document.querySelector(${JSON.stringify(DIFF_EDITOR)})`));
            const hinted = diff && (await until(h, `!!document.querySelector("[data-diff-split-hint]")`));
            const hint = await textOf(h, "[data-diff-split-hint]");
            const width = await h.ev(`document.querySelector(${JSON.stringify(PANE)})?.clientWidth ?? 0`);
            rec(
                s6,
                expanded && hinted && hint === NARROW_HINT && width < SPLIT_MIN_PX,
                JSON.stringify({ expanded, picked, diff, hint, width })
            );
            await h.shot("cdp-shots/diff-states-narrow-hint.png");
        });

        const s7 = "7. diff read failure: a file turned into a folder says Couldn’t read this file with Retry, and Retry reads it once restored";
        await guard(s7, async () => {
            const path = join(ctx.dir, STATES.deleted);
            const picked = await pickFile(h, STATES.deleted);
            const diff = picked && (await until(h, `!!document.querySelector(${JSON.stringify(DIFF_EDITOR)})`));
            // tracked and deleted, so git still lists it while its path is a folder the read cannot open
            mkdirSync(path);
            let failed = false;
            let failedText = "";
            try {
                await pressKey(h, "r", "KeyR", 82);
                failed = await until(h, `${emptyIs("failed")} && !!document.querySelector("[data-diff-retry]")`);
                failedText = await textOf(h, PANE);
                await h.shot("cdp-shots/diff-states-read-failure.png");
            } finally {
                rmSync(path, { recursive: true, force: true });
            }
            await h.ev(`document.querySelector("[data-diff-retry]")?.click()`);
            const recovered = await until(h, `!!document.querySelector(${JSON.stringify(DIFF_EDITOR)})`);
            rec(
                s7,
                diff && failed && failedText.includes("Couldn’t read this file") && recovered,
                JSON.stringify({ picked, diff, failed, failedText: failedText.slice(0, 200), recovered })
            );
        });

        const s8 = "8. pick a file: a commit with no files asks for a file and names n / p";
        await guard(s8, async () => {
            const picked = await pickHistoryRow(h, STATES.noFiles);
            const shown = picked && (await until(h, emptyIs("nofile")));
            const pane = await textOf(h, PANE);
            rec(
                s8,
                shown &&
                    pane.includes("Pick a file to see its changes") &&
                    pane.includes("Choose one from the list, or step through it with n / p."),
                JSON.stringify({ picked, shown, pane: pane.slice(0, 160) })
            );
            await h.shot("cdp-shots/diff-states-pick-file.png");
        });
        return steps;
    },
    async teardown(h, ctx) {
        await removeFixtures(h, ctx.names, ctx.dirs);
    },
};
