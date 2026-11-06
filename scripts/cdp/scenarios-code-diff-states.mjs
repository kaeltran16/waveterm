// Code surface review fixes: code-diff-states (F6, F14, F17, F10). A file git tracks but the working tree
// deleted shows its HEAD copy as all removed; the diff header picks HEAD or the branch base and says when
// nothing changed; a refused save's stale bar compares the draft with the copy on disk; a file git cannot
// count is listed in the Changed pane with no line counts.
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./scenarios-shared.mjs";
import { codeEval, makeCodeRepo, openFileInCode, openFolderInCode, removeCodeRepo } from "./scenarios-code-kit.mjs";

const GONE = "gone.txt";
const SAME = "same.txt";
const NOTES = "notes.txt";
const LOCKED = "locked.txt";
const GONE_TEXT = "alpha line\nbeta line\ngamma line\n";
const DRAFT = "first line\nmy unsaved edit\n";
const ON_DISK = "first line\nan agent wrote this\n";

// the deleted view once its diff has drawn the HEAD copy
const READ_DELETED = `
    const ok = await until(() => {
        const d = document.querySelector("[data-code-deleted] .monaco-diff-editor");
        return d != null && flat(d).includes("beta line");
    }, 8000);
    const root = document.querySelector("[data-code-deleted]");
    return {
        ok,
        title: flat(root).includes("Deleted in the working tree"),
        refresh: button(document, /Refresh index/) != null,
        removed: root?.querySelectorAll(".line-delete, .char-delete, .gutter-delete").length ?? 0,
    };
`;

// the diff header: its target, its label, and each option's pressed and disabled state
const READ_HEADER = `
    const t = document.querySelector("[data-code-diff-target]");
    const opt = (o) => {
        const b = document.querySelector('[data-code-diff-option="' + o + '"]');
        return b == null ? null : { pressed: b.getAttribute("aria-pressed") === "true", disabled: b.disabled, title: b.title };
    };
    const header = { target: t?.getAttribute("data-code-diff-target") ?? "", label: flat(t), head: opt("head"), base: opt("base") };
`;

export const codeDiffStates = {
    name: "code-diff-states",
    surface: "code",
    async arrange() {
        const dir = makeCodeRepo({
            [GONE]: GONE_TEXT,
            [SAME]: "unchanged\n",
            [NOTES]: "first line\n",
            [LOCKED]: "one\n",
        });
        unlinkSync(join(dir, GONE));
        return { dir };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });

        const folder = await openFolderInCode(h, ctx.dir);
        const fromTree = await codeEval(h, `
            const row = () => [...document.querySelectorAll('[data-code-tree] [role="treeitem"]')].find((r) => flat(r).includes(${JSON.stringify(GONE)}));
            await until(() => row() != null, 8000);
            row()?.click();
            ${READ_DELETED}
        `);
        await h.shot("cdp-shots/code-diff-states-deleted-tree.png");
        rec(
            "a deleted tracked file opened from the tree shows Deleted in the working tree with its HEAD copy removed, and no Refresh index",
            folder === true && fromTree?.ok === true && fromTree.title === true && fromTree.refresh === false,
            JSON.stringify({ folder, fromTree })
        );

        const fromChanged = await codeEval(h, `
            const { openPath } = await mod("app/view/code/codestore.ts");
            await openPath(${JSON.stringify(SAME)});
            await until(() => document.querySelector("[data-code-deleted]") == null, 4000);
            document.querySelector('[data-code-column-tab="changed"]')?.click();
            const row = () => document.querySelector('[data-code-changed-row=${JSON.stringify(GONE)}]');
            await until(() => row() != null, 8000);
            const letter = flat(row()).slice(0, 1);
            row()?.click();
            const out = await (async () => { ${READ_DELETED} })();
            document.querySelector('[data-code-column-tab="files"]')?.click();
            return { ...out, letter };
        `);
        await h.shot("cdp-shots/code-diff-states-deleted-changed.png");
        rec(
            "the Changed pane's D row lands on the same deleted view",
            fromChanged?.letter === "D" && fromChanged?.ok === true && fromChanged.title === true && fromChanged.refresh === false,
            JSON.stringify(fromChanged)
        );

        const same = (await openFileInCode(h, SAME)) === true;
        const unchanged = await codeEval(h, `
            document.querySelector('[data-code-view-mode="diff"]')?.click();
            const said = await until(() => (document.body.textContent || "").includes("No changes against HEAD"), 8000);
            // the header asks for the base on mount; on main there is none to offer
            await until(() => document.querySelector('[data-code-diff-option="base"]')?.disabled === true, 6000);
            ${READ_HEADER}
            return { said, diff: document.querySelector(".monaco-diff-editor") != null, header };
        `);
        await h.shot("cdp-shots/code-diff-states-unchanged.png");
        rec(
            "an unchanged file says No changes against HEAD instead of two equal columns, and Branch base is disabled with its reason on main",
            same &&
                unchanged?.said === true &&
                unchanged.diff === false &&
                unchanged.header?.head?.pressed === true &&
                unchanged.header?.base?.disabled === true &&
                (unchanged.header?.base?.title ?? "") !== "",
            JSON.stringify(unchanged)
        );

        // a commit ahead of main gives the branch a base; only same.txt goes in, so gone.txt stays deleted
        git(ctx.dir, "checkout", "-q", "-b", "feature");
        writeFileSync(join(ctx.dir, SAME), "changed on the feature branch\n");
        git(ctx.dir, "commit", "-q", "-m", "change same", "--", SAME);
        const based = await codeEval(h, `
            const { openPath } = await mod("app/view/code/codestore.ts");
            document.querySelector('[data-code-view-mode="source"]')?.click();
            await openPath(${JSON.stringify(NOTES)});
            await openPath(${JSON.stringify(SAME)});
            await until(() => document.querySelector('[data-code-path=${JSON.stringify(SAME)}]') != null, 6000);
            document.querySelector('[data-code-view-mode="diff"]')?.click();
            const offered = await until(() => {
                const b = document.querySelector('[data-code-diff-option="base"]');
                return b != null && !b.disabled;
            }, 8000);
            document.querySelector('[data-code-diff-option="base"]')?.click();
            const shown = await until(() => {
                const d = document.querySelector(".monaco-diff-editor");
                return document.querySelector('[data-code-diff-target="base"]') != null && d != null && flat(d).includes("unchanged") && flat(d).includes("feature branch");
            }, 8000);
            ${READ_HEADER}
            return { offered, shown, header };
        `);
        await h.shot("cdp-shots/code-diff-states-base.png");
        rec(
            "on a feature branch the header's Branch base switches to the base, whose side holds main's copy",
            based?.offered === true &&
                based.shown === true &&
                based.header?.base?.pressed === true &&
                /merge-base with/.test(based.header?.label ?? ""),
            JSON.stringify(based)
        );

        // Monaco takes no text a CDP session types, so the edit goes through editDraft, which its onChange calls
        const drafted = await codeEval(h, `
            const { editDraft, openPath } = await mod("app/view/code/codestore.ts");
            document.querySelector('[data-code-view-mode="source"]')?.click();
            await openPath(${JSON.stringify(NOTES)});
            await until(() => document.querySelector(".monaco-editor") != null, 8000);
            editDraft(${JSON.stringify(DRAFT)});
            await nap(300);
            return true;
        `);
        writeFileSync(join(ctx.dir, NOTES), ON_DISK);
        const compared = await codeEval(h, `
            const { saveCurrent } = await mod("app/view/code/codestore.ts");
            await saveCurrent();
            const bar = () => document.querySelector("[data-code-stale]");
            await until(() => bar() != null, 4000);
            const labels = [...(bar()?.querySelectorAll("button") ?? [])].map(flat);
            button(bar(), /^Compare with disk$/)?.click();
            const shown = await until(() => {
                const d = document.querySelector(".monaco-diff-editor");
                return document.querySelector('[data-code-diff-target="disk"]') != null && d != null && flat(d).includes("an agent wrote this") && flat(d).includes("my unsaved edit");
            }, 8000);
            ${READ_HEADER}
            return { labels, refused: /not saved/.test(flat(bar())), shown, header };
        `);
        await h.shot("cdp-shots/code-diff-states-disk.png");
        rec(
            "a refused save's stale bar offers Compare with disk, which shows the draft against the disk copy",
            drafted === true &&
                compared?.refused === true &&
                JSON.stringify(compared.labels) === JSON.stringify(["Discard my edits and reload", "Compare with disk"]) &&
                compared.shown === true &&
                compared.header?.label?.includes("Your edits against the copy on disk") &&
                compared.header?.head != null &&
                compared.header?.base != null,
            JSON.stringify(compared)
        );

        await codeEval(h, `
            const { revertDraft } = await mod("app/view/code/codestore.ts");
            revertDraft();
            document.querySelector('[data-code-view-mode="source"]')?.click();
        `);

        // the Changed row after a fresh status read; a count reads as +N or -N
        const readLocked = `
            const { loadStatus } = await mod("app/view/code/codestore.ts");
            await loadStatus();
            document.querySelector('[data-code-column-tab="changed"]')?.click();
            const row = () => document.querySelector('[data-code-changed-row=${JSON.stringify(LOCKED)}]');
            await until(() => row() != null, 8000);
            // the pane re-renders from the new status after the atom is set
            await nap(300);
            const text = flat(row());
            return { listed: row() != null, text, counted: /[+\\-\\u2212]\\d/.test(text) };
        `;
        const lockedPath = join(ctx.dir, LOCKED);
        // a size the index does not hold, so git lists it as modified without hashing its bytes
        writeFileSync(lockedPath, "one\ntwo\n");
        // refreshes the index's stat for it, so later statuses never need to read it
        git(ctx.dir, "status", "--porcelain");
        const readable = await codeEval(h, readLocked);
        let unreadable = null;
        // read-data only: git still lists the file, but its line counts fail for every file
        execFileSync("icacls", [lockedPath, "/deny", `${process.env.USERNAME}:(RD)`], { stdio: "pipe" });
        try {
            unreadable = await codeEval(h, readLocked);
            await h.shot("cdp-shots/code-diff-states-uncounted.png");
        } finally {
            execFileSync("icacls", [lockedPath, "/remove:d", process.env.USERNAME], { stdio: "pipe" });
            await codeEval(h, `document.querySelector('[data-code-column-tab="files"]')?.click();`);
        }
        rec(
            "a modified file git cannot read is still listed in the Changed pane, with no + or − count where a readable one shows its counts",
            readable?.counted === true && unreadable?.listed === true && unreadable.counted === false,
            JSON.stringify({ readable, unreadable })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit");
        if (ctx?.dir) removeCodeRepo(ctx.dir);
    },
};
