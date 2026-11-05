// Code surface review fixes: code-keys. F7 (d is dead in a plain folder) and F15 (Alt+arrows from the editor).
import { lookShot } from "./scenarios-shared.mjs";
import { codeEval, makeCodeRepo, openFileInCode, openFolderInCode, removeCodeRepo } from "./scenarios-code-kit.mjs";

const ALT = 1; // CDP Input.dispatchKeyEvent modifier bitmask
const VK = { ArrowLeft: 37, d: 68 };
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

// the binding's own run() through the app's module, with the context the dispatcher would derive
const runBinding = (h, id) =>
    codeEval(h, `
        const { buildCodeBindings } = await mod("app/store/keybindings/bindings.ts");
        const b = buildCodeBindings({}).find((x) => x.id === ${JSON.stringify(id)});
        const editable = document.activeElement?.closest(".monaco-editor") != null;
        const ctx = { surface: "code", editable, modalOpen: false, leader: null };
        return b.when(ctx) ? { result: b.run(ctx) ?? null } : { blocked: true };
    `);

// Sends a key as a real CDP event. A WebView that never got page focus drops it silently, so when `landed`
// stays false the binding's run() is called instead; the return says which path held, for the step's detail.
async function pressKey(h, { id, key, modifiers = 0 }, landed) {
    await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
    const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, modifiers, windowsVirtualKeyCode: VK[key] };
    await h.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    for (let i = 0; i < 6; i++) {
        await nap(200);
        if (await landed()) return "key event";
    }
    const ran = await runBinding(h, id);
    await nap(600);
    return `binding run() ${JSON.stringify(ran)} (the key event never arrived)`;
}

export const codeKeys = {
    name: "code-keys",
    surface: "code",
    async arrange() {
        const repo = makeCodeRepo({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" });
        const plain = makeCodeRepo({ "notes.txt": "plain notes\n" }, { git: false });
        return { repo, plain };
    },
    async assert(h, ctx) {
        const steps = [];
        const shot = (name) => h.shot(lookShot(name));
        const path = () => codeEval(h, `return document.querySelector("[data-code-path]")?.getAttribute("data-code-path") ?? null;`);
        const inDiff = () => codeEval(h, `return document.querySelector("[data-code-diff-target]") != null;`);

        // Alt+Left from the editor walks Back
        const opened = (await openFolderInCode(h, ctx.repo)) && (await openFileInCode(h, "a.ts")) && (await openFileInCode(h, "b.ts"));
        const focused = await codeEval(h, `
            await until(() => document.querySelector(".monaco-editor .view-line") != null, 8000);
            const host = document.querySelector(".monaco-editor .native-edit-context, .monaco-editor textarea");
            host?.focus();
            return document.activeElement?.closest(".monaco-editor") != null;
        `);
        const how = await pressKey(h, { id: "code:back", key: "ArrowLeft", modifiers: ALT }, async () => (await path()) === "a.ts");
        const after = await path();
        await shot("code-keys-alt-left");
        steps.push({
            step: "code-keys: Alt+Left with focus in the editor walks Back to the previous file",
            ok: opened && focused && after === "a.ts",
            detail: `opened=${opened} editorFocused=${focused} path=${after} via ${how}`,
        });

        // d in a plain folder leaves the single editor. A dead key proves nothing, so the binding's own answer is
        // read too: run() must return false (the key passes) rather than cycle into Diff
        const plainOpened = await openFolderInCode(h, ctx.plain);
        const fileOpened = await openFileInCode(h, "notes.txt");
        await codeEval(h, `document.activeElement?.blur?.();`);
        await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
        const base = { key: "d", code: "KeyD", windowsVirtualKeyCode: VK.d };
        await h.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        await nap(800);
        const ran = await runBinding(h, "code:diff");
        await nap(400);
        const diffShown = await inDiff();
        const editorShown = await codeEval(h, `return document.querySelector(".monaco-editor .view-line") != null;`);
        await shot("code-keys-d-plain");
        steps.push({
            step: "code-keys: d in a plain folder leaves the single editor",
            ok: plainOpened && fileOpened && ran?.result === false && !diffShown && editorShown,
            detail: `plainOpened=${plainOpened} fileOpened=${fileOpened} run()=${JSON.stringify(ran)} diffTarget=${diffShown} editor=${editorShown}`,
        });
        return steps;
    },
    async teardown(h, ctx) {
        await h.goto("cockpit");
        for (const dir of [ctx?.repo, ctx?.plain]) {
            if (dir) removeCodeRepo(dir);
        }
    },
};
