// Helpers shared by the code-* scenario modules (session, jumps, toolbar, keys, handoff, changed, blame-draft,
// diff-states, editor). Later tasks only read this file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, lookEval, lookOpen } from "./scenarios-shared.mjs";

export { lookEval as codeEval };

// a temp dir holding `files` (rel path -> content); with git, one commit of everything on `branch`
export function makeCodeRepo(files, { git: init = true, branch = "main" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "verify-code-"));
    for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
    }
    if (init) {
        git(dir, "init", "-q", "-b", branch);
        git(dir, "config", "user.name", "dana k");
        git(dir, "config", "user.email", "dana@example.com");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "init");
    }
    return dir;
}

export function removeCodeRepo(dir) {
    rmSync(dir, { recursive: true, force: true });
}

// opens `dir` through the picker's path input, as code-stale-bar does; true once the tree shows a row
export async function openFolderInCode(h, dir) {
    await lookOpen(h, "code");
    return lookEval(h, `
        document.querySelector("[data-code-project-picker]")?.click();
        await until(() => document.querySelector("[data-code-picker-path] input") != null, 4000);
        const input = document.querySelector("[data-code-picker-path] input");
        if (input == null) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(dir)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await nap(100); // let React commit the typed value before the submit reads it
        document.querySelector("[data-code-picker-path]")?.requestSubmit();
        return until(() => document.querySelector('[data-code-tree] [role="treeitem"]') != null, 8000);
    `);
}

// opens a file of the loaded folder through the app's openPath; true once its path bar shows
export function openFileInCode(h, rel) {
    return lookEval(h, `
        const { openPath } = await mod("app/view/code/codestore.ts");
        await openPath(${JSON.stringify(rel)});
        return until(() => document.querySelector('[data-code-path="' + ${JSON.stringify(rel)} + '"]') != null, 8000);
    `);
}
