// Code surface review fixes: code-changed. F21: the Changed pane's rows are focusable buttons, ArrowUp/Down walk
// them and Enter opens the focused one in the editor.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookEval, lookKey, lookShot } from "./scenarios-shared.mjs";
import { makeCodeRepo, openFolderInCode, removeCodeRepo } from "./scenarios-code-kit.mjs";

const FILES = ["a.txt", "b.txt", "c.txt"];
const ROWS = `[...document.querySelectorAll("[data-code-changed-row]")]`;
const focusedRow = (h) =>
    h.ev(`document.activeElement?.closest?.("[data-code-changed-row]")?.getAttribute("data-code-changed-row") ?? null`);

export const codeChanged = {
    name: "code-changed",
    surface: "code",
    async arrange() {
        const dir = makeCodeRepo(Object.fromEntries(FILES.map((f) => [f, "one\n"])));
        for (const f of FILES) writeFileSync(join(dir, f), "one\ntwo\n");
        return { dir };
    },
    async assert(h, ctx) {
        const steps = [];
        const opened = await openFolderInCode(h, ctx.dir);
        const listed = await lookEval(h, `
            document.querySelector('[data-code-column-tab="changed"]')?.click();
            await until(() => document.querySelectorAll("[data-code-changed-row]").length === ${FILES.length}, 8000);
            return ${ROWS}.map((r) => r.getAttribute("data-code-changed-row"));
        `);

        // a sentinel just before the list, so a real Tab press is what lands on the first row
        const placed = await h.ev(`(() => {
            const list = document.querySelector("[data-code-changed-row]")?.parentElement;
            if (!list) return false;
            const s = document.createElement("span");
            s.tabIndex = 0;
            list.before(s);
            s.focus();
            return document.activeElement === s;
        })()`);
        await lookKey(h, "Tab", "Tab", 9);
        const tabbed = await h.ev(`(() => {
            const rows = ${ROWS};
            const at = rows.findIndex((r) => r === document.activeElement);
            return { at, stops: rows.filter((r) => r.tabIndex === 0).length, ring: at === -1 ? null : getComputedStyle(rows[at]).boxShadow };
        })()`);
        await h.shot(lookShot("code-changed-tab"));
        steps.push({
            step: "code-changed: Tab lands on the first row, the list's only tab stop, with a focus ring",
            ok:
                opened === true &&
                placed &&
                JSON.stringify(listed) === JSON.stringify(FILES) &&
                tabbed.at === 0 &&
                tabbed.stops === 1 &&
                / 0px 0px 0px [1-9]/.test(tabbed.ring ?? ""),
            detail: JSON.stringify({ opened, placed, listed, tabbed }),
        });

        await lookKey(h, "ArrowDown", "ArrowDown", 40);
        await new Promise((r) => setTimeout(r, 200));
        let viaKey = await focusedRow(h);
        let synthetic = false;
        if (viaKey !== FILES[1]) {
            // the key never reached the page: React's onKeyDown handles a bubbling keydown on the focused row
            synthetic = true;
            await h.ev(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))`);
            await new Promise((r) => setTimeout(r, 200));
            viaKey = await focusedRow(h);
        }
        const stop = await h.ev(`${ROWS}.map((r) => r.tabIndex).join(",")`);
        await h.shot(lookShot("code-changed-arrow"));
        steps.push({
            step: "code-changed: ArrowDown moves focus to the second row and the tab stop follows",
            ok: viaKey === FILES[1] && stop === "-1,0,-1",
            detail: JSON.stringify({ focused: viaKey, tabIndexes: stop, syntheticKeydown: synthetic }),
        });

        await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        const editor = await lookEval(h, `
            await until(() => document.querySelector('[data-code-path="${FILES[1]}"]') != null && document.querySelector(".monaco-editor") != null, 8000);
            return { path: document.querySelector("[data-code-path]")?.getAttribute("data-code-path") ?? null, monaco: document.querySelector(".monaco-editor") != null };
        `);
        await h.shot(lookShot("code-changed-enter"));
        steps.push({
            step: "code-changed: Enter opens the focused row in the editor",
            ok: editor.path === FILES[1] && editor.monaco,
            detail: JSON.stringify(editor),
        });

        // the tree unmounts while it holds focus; its arrow bindings must not outlive it
        const fromTree = await lookEval(h, `
            document.querySelector('[data-code-column-tab="files"]')?.click();
            await until(() => document.querySelector("[data-code-tree]") != null, 4000);
            document.querySelector("[data-code-tree]")?.focus();
            const treeHeld = document.activeElement?.matches?.("[data-code-tree]") ?? false;
            document.querySelector('[data-code-column-tab="changed"]')?.click();
            await until(() => document.querySelectorAll("[data-code-changed-row]").length === ${FILES.length}, 8000);
            document.querySelector("[data-code-changed-row]")?.focus();
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const { codeTreeFocusedAtom } = await mod("app/view/code/codestore.ts");
            return { treeHeld, treeFlag: globalStore.get(codeTreeFocusedAtom) };
        `);
        await lookKey(h, "ArrowDown", "ArrowDown", 40);
        await new Promise((r) => setTimeout(r, 200));
        const afterTree = await focusedRow(h);
        await h.shot(lookShot("code-changed-from-tree"));
        steps.push({
            step: "code-changed: opened from a focused tree, a real ArrowDown moves the Changed list's focus",
            ok: fromTree.treeHeld === true && fromTree.treeFlag === false && afterTree === FILES[1],
            detail: JSON.stringify({ ...fromTree, focused: afterTree }),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit");
        if (ctx?.dir) removeCodeRepo(ctx.dir);
    },
};
