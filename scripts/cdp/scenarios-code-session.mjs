// Code surface review fixes: code-session. The session lifecycle (spec "Session lifecycle"): refresh, rename and
// New folder keep the session; re-picking the current project is a no-op; no project disables the header actions;
// a subfolder project's worktrees map to the subfolder; a refused save shows one banner; a by-path folder restores,
// and a deleted one does not.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeEval, makeCodeRepo, openFileInCode, openFolderInCode, removeCodeRepo } from "./scenarios-code-kit.mjs";
import { git, lookOpen, polishReload } from "./scenarios-shared.mjs";

const shot = (h, name) => h.shot(`cdp-shots/code-session-${name}.png`);

// the page-side helpers every step reads the surface with
const LIB = `
    const S = await mod("app/store/jotaiStore.ts");
    const C = await mod("app/view/code/codestore.ts");
    const rows = () => [...document.querySelectorAll('[data-code-tree] [role="treeitem"]')];
    const row = (name) => rows().find((r) => r.querySelector("span.min-w-0")?.textContent === name) ?? null;
    const headerButton = (label) => document.querySelector('button[aria-label="' + label + '"]');
    const openPath = () => document.querySelector("[data-code-path]")?.getAttribute("data-code-path") ?? null;
    const errors = () => [...document.querySelectorAll("[data-surface-error]")].map((e) => flat(e));
`;
const pageEval = (h, body) => codeEval(h, `${LIB} ${body}`);

// openFolderInCode resolves on any tree row, which the previous folder's tree already shows; this waits for the
// switch itself to land, so the picker it closes on success is closed before the next step opens it
async function openFolder(h, dir) {
    const shown = await openFolderInCode(h, dir);
    const landed = await pageEval(h, `
        const { sameRepoPath } = await mod("util/paths.ts");
        const ok = await until(() => sameRepoPath(S.globalStore.get(C.codeProjectAtom)?.path ?? "", ${JSON.stringify(dir)}) && S.globalStore.get(C.codeIndexAtom) != null, 8000);
        await nap(300);
        return ok;
    `);
    return shown === true && landed === true;
}

const samePath = (a, b) => String(a).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase() === String(b).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();

export const codeSession = {
    name: "code-session",
    surface: "code",
    async arrange() {
        const dir = makeCodeRepo({
            "README.md": "# demo\n",
            "src/a.ts": "export const a = 1;\n",
            "src/b.ts": "export const b = 2;\n",
        });
        // git worktree add takes an empty existing dir
        const wt = mkdtempSync(join(tmpdir(), "verify-code-wt-"));
        git(dir, "worktree", "add", "-q", "-b", "feat", wt);
        const plain = makeCodeRepo({ "notes.txt": "plain\n" }, { git: false });
        return { dir, wt, plain };
    },
    async assert(h, ctx) {
        const steps = [];

        // 1. refresh keeps the open file, its expanded folder and an enabled Back
        const opened = await openFolder(h, ctx.dir);
        await openFileInCode(h, "README.md");
        await openFileInCode(h, "src/b.ts");
        const refresh = await pageEval(h, `
            if (row("src")?.getAttribute("aria-expanded") !== "true") row("src")?.click();
            await until(() => row("b.ts") != null, 4000);
            const before = S.globalStore.get(C.codeIndexAtom);
            headerButton("Refresh index")?.click();
            const landed = await until(() => S.globalStore.get(C.codeIndexAtom) !== before, 8000);
            await nap(300);
            return { landed, file: openPath(), expanded: row("src")?.getAttribute("aria-expanded"), back: headerButton("Back")?.disabled };
        `);
        await shot(h, "refresh");
        steps.push({
            step: "code-session: refresh keeps the open file, its expanded folder and an enabled Back",
            ok: opened === true && refresh?.landed === true && refresh.file === "src/b.ts" && refresh.expanded === "true" && refresh.back === false,
            detail: JSON.stringify({ opened, refresh }),
        });

        // 2. rename of the open file keeps it open under the new name
        const rename = await pageEval(h, `
            await C.renamePath("src/b.ts", "c.ts");
            await until(() => openPath() === "src/c.ts" && row("c.ts") != null, 4000);
            return { file: openPath(), row: row("c.ts") != null, back: headerButton("Back")?.disabled };
        `);
        await shot(h, "rename");
        steps.push({
            step: "code-session: rename of the open file keeps it open under the new name",
            ok: rename?.file === "src/c.ts" && rename.row === true && rename.back === false,
            detail: JSON.stringify(rename),
        });

        // 3. New folder shows a row for the empty folder, selected
        const folder = await pageEval(h, `
            S.globalStore.set(C.codeCursorAtom, null); // a root-level folder
            headerButton("New folder (Shift+N)")?.click();
            await until(() => document.querySelector("[data-code-name-input]") != null, 4000);
            const input = document.querySelector("[data-code-name-input]");
            if (input == null) return { input: false };
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "fresh");
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await nap(100);
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            await until(() => row("fresh") != null, 4000);
            await nap(200);
            const r = row("fresh");
            return { row: r != null, selected: r?.getAttribute("aria-selected"), expanded: r?.getAttribute("aria-expanded"), file: openPath() };
        `);
        await shot(h, "new-folder");
        steps.push({
            step: "code-session: New folder shows a row for the empty folder, selected",
            ok: folder?.row === true && folder.selected === "true" && folder.expanded === "true" && folder.file === "src/c.ts",
            detail: JSON.stringify(folder),
        });

        // 3b. New folder again with the empty folder's name is refused as existing (it is not in the index, only
        // in the session's dirs), Enter makes no second row, Escape cancels
        const dup = await pageEval(h, `
            const EXISTS = "Something with that name is already here.";
            S.globalStore.set(C.codeCursorAtom, null);
            headerButton("New folder (Shift+N)")?.click();
            await until(() => document.querySelector("[data-code-name-input]") != null, 4000);
            const input = document.querySelector("[data-code-name-input]");
            if (input == null) return { input: false };
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "fresh");
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await until(() => input.parentElement?.textContent?.includes(EXISTS), 2000);
            const message = input.parentElement?.textContent ?? "";
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            await nap(500);
            const stillOpen = document.querySelector("[data-code-name-input]") != null;
            const freshRows = rows().filter((r) => r.querySelector("span.min-w-0")?.textContent === "fresh").length;
            document.querySelector("[data-code-name-input]")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await until(() => document.querySelector("[data-code-name-input]") == null, 2000);
            return { message, stillOpen, freshRows, closed: document.querySelector("[data-code-name-input]") == null };
        `);
        await shot(h, "new-folder-exists");
        steps.push({
            step: "code-session: New folder with an existing empty folder's name shows the exists message and creates no second row",
            ok: dup?.message?.includes("Something with that name is already here.") === true && dup.stillOpen === true && dup.freshRows === 1 && dup.closed === true,
            detail: JSON.stringify(dup),
        });

        // 4. re-picking the current project keeps the open file
        const repicked = await openFolder(h, ctx.dir);
        const repick = await pageEval(h, `
            await nap(500);
            return { file: openPath(), back: headerButton("Back")?.disabled, fresh: row("fresh") != null };
        `);
        await shot(h, "repick");
        steps.push({
            step: "code-session: re-picking the current project keeps the open file",
            ok: repicked === true && repick?.file === "src/c.ts" && repick.back === false && repick.fresh === true,
            detail: JSON.stringify({ repicked, repick }),
        });

        // 5. a subfolder project's Worktrees rows point at the subfolder in each checkout
        const sub = join(ctx.dir, "src");
        const subOpened = await openFolder(h, sub);
        const worktrees = await pageEval(h, `
            document.querySelector("[data-code-project-picker]")?.click();
            const section = () => document.querySelector('[data-code-picker-section="worktrees"]');
            await until(() => (section()?.querySelectorAll("[data-code-picker-row]").length ?? 0) >= 2, 8000);
            return [...(section()?.querySelectorAll("[data-code-picker-row]") ?? [])].map((r) => ({
                label: r.getAttribute("data-code-picker-row"),
                detail: r.querySelector(".font-mono")?.textContent ?? "",
            }));
        `);
        await shot(h, "worktrees");
        await pageEval(h, `document.querySelector("[data-code-project-picker]")?.click(); await nap(200);`);
        const wantMain = join(ctx.dir, "src");
        const wantFeat = join(ctx.wt, "src");
        steps.push({
            step: "code-session: a subfolder project's Worktrees rows point at the subfolder in each checkout",
            ok:
                subOpened === true &&
                Array.isArray(worktrees) &&
                worktrees.length === 2 &&
                worktrees.some((w) => samePath(w.detail, wantMain)) &&
                worktrees.some((w) => w.label === "feat" && samePath(w.detail, wantFeat)),
            detail: JSON.stringify({ subOpened, worktrees, wantMain, wantFeat }),
        });

        // 6. a save over a disk change shows one banner (the stale bar) and no SurfaceError
        await openFileInCode(h, "a.ts");
        await pageEval(h, `C.editDraft("export const a = 1;\\n// mine\\n"); await nap(200);`);
        writeFileSync(join(sub, "a.ts"), "export const a = 'an agent wrote this';\n");
        const conflict = await pageEval(h, `
            await C.saveCurrent();
            await until(() => document.querySelector("[data-code-stale]") != null, 4000);
            await nap(200);
            const bar = document.querySelector("[data-code-stale]");
            return { bar: flat(bar), button: flat(bar?.querySelector("button")), errors: errors() };
        `);
        await shot(h, "save-conflict");
        steps.push({
            step: "code-session: a save over a disk change shows one banner (the stale bar) and no SurfaceError",
            ok:
                conflict?.bar?.includes("a.ts changed on disk — not saved; your unsaved edits are still here") &&
                conflict.button === "Discard my edits and reload" &&
                conflict.errors.length === 0,
            detail: JSON.stringify(conflict),
        });
        await pageEval(h, `
            document.querySelector("[data-code-stale] button")?.click();
            await until(() => document.querySelector("[data-code-stale]") == null, 4000);
        `);

        // 7. with no project, New file / New folder / Refresh are disabled
        const none = await pageEval(h, `
            S.globalStore.set(C.lastCodeProjectAtom, null);
            await C.selectProject(null);
            await nap(300);
            return {
                project: S.globalStore.get(C.codeProjectAtom),
                newFile: headerButton("New file (n)")?.disabled,
                newFolder: headerButton("New folder (Shift+N)")?.disabled,
                refresh: headerButton("Refresh index")?.disabled,
                edit: S.globalStore.get(C.codeEditAtom),
            };
        `);
        await shot(h, "no-project");
        steps.push({
            step: "code-session: with no project, New file, New folder and Refresh index are disabled",
            ok: none?.project == null && none.newFile === true && none.newFolder === true && none.refresh === true && none.edit == null,
            detail: JSON.stringify(none),
        });

        // 8. a by-path folder is restored after a reload
        const pathOpened = await openFolder(h, ctx.dir);
        await polishReload(h);
        await lookOpen(h, "code");
        const restored = await pageEval(h, `
            await until(() => row("src") != null, 10000);
            return { project: S.globalStore.get(C.codeProjectAtom)?.path ?? null, row: row("src") != null, errors: errors() };
        `);
        await shot(h, "restore-by-path");
        steps.push({
            step: "code-session: a by-path folder is restored after a reload",
            ok: pathOpened === true && samePath(restored?.project ?? "", ctx.dir) && restored.row === true && restored.errors.length === 0,
            detail: JSON.stringify({ pathOpened, restored }),
        });

        // 9. a deleted by-path folder is not restored
        const plainOpened = await openFolder(h, ctx.plain);
        await h.goto("jarvis");
        rmSync(ctx.plain, { recursive: true, force: true });
        await polishReload(h);
        await lookOpen(h, "code");
        const gone = await pageEval(h, `
            await until(() => S.globalStore.get(C.lastCodeProjectAtom) == null, 6000);
            await nap(800);
            return {
                project: S.globalStore.get(C.codeProjectAtom)?.path ?? null,
                stored: S.globalStore.get(C.lastCodeProjectAtom),
                empty: /No project selected|No registered projects/.test(flat(document.body)),
                errors: errors(),
            };
        `);
        await shot(h, "deleted-by-path");
        steps.push({
            step: "code-session: a deleted by-path folder is not restored",
            ok:
                plainOpened === true &&
                gone?.stored == null &&
                !samePath(gone.project ?? "", ctx.plain) &&
                gone.errors.every((e) => !e.includes("Could not list files")) &&
                (gone.project != null || gone.empty === true),
            detail: JSON.stringify({ plainOpened, gone }),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await codeEval(h, `
            const S = await mod("app/store/jotaiStore.ts");
            const C = await mod("app/view/code/codestore.ts");
            C.revertDraft();
            S.globalStore.set(C.lastCodeProjectAtom, null);
            await C.selectProject(null);
        `).catch(() => {});
        await h.goto("cockpit");
        if (ctx?.wt) {
            try {
                git(ctx.dir, "worktree", "remove", "--force", ctx.wt);
            } catch {
                /* removed below either way; prune drops the stale registration */
            }
            rmSync(ctx.wt, { recursive: true, force: true });
        }
        if (ctx?.dir) removeCodeRepo(ctx.dir);
        if (ctx?.plain) removeCodeRepo(ctx.plain);
    },
};
