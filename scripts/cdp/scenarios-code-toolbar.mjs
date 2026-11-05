// Code surface review fixes: code-toolbar. The toolbar and tree fixes (spec "Toolbar, tree, panes"): the project
// picker closes on an outside click and on Esc (F3); a collapsed folder holding a draft shows the unsaved dot and the
// toolbar's "N unsaved" lists the project's drafts (F16); the app-bar switcher opens its project in Code (F18); the
// no-projects empty state opens New project (F20).
import { codeEval, makeCodeRepo, openFileInCode, openFolderInCode, removeCodeRepo } from "./scenarios-code-kit.mjs";

const shot = (h, name) => h.shot(`cdp-shots/code-toolbar-${name}.png`);

// the cockpit's model, found the way the other scenarios find it: on the nav rail's props
const LIB = `
    const S = await mod("app/store/jotaiStore.ts");
    const C = await mod("app/view/code/codestore.ts");
    const { atoms } = await mod("app/store/global-atoms.ts");
    const { sameRepoPath } = await mod("util/paths.ts");
    const model = (() => {
        const nav = document.querySelector("nav");
        const key = nav && Object.keys(nav).find((k) => k.startsWith("__reactFiber$"));
        for (let f = key ? nav[key] : null; f != null; f = f.return) {
            if (f.memoizedProps?.model?.surfaceAtom != null) return f.memoizedProps.model;
        }
        return null;
    })();
    const rows = () => [...document.querySelectorAll('[data-code-tree] [role="treeitem"]')];
    const row = (name) => rows().find((r) => r.querySelector("span.min-w-0")?.textContent === name) ?? null;
    const pickerOpen = () => document.querySelector("[data-code-picker-path]") != null;
    const openFile = () => document.querySelector("[data-code-path]")?.getAttribute("data-code-path") ?? null;
`;
const pageEval = (h, body) => codeEval(h, `${LIB} ${body}`);

// a real pointer click: the backdrop has to take it, so a synthetic click on the backdrop itself proves nothing
async function clickAt(h, x, y) {
    await h.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await h.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export const codeToolbar = {
    name: "code-toolbar",
    surface: "code",
    async arrange() {
        const dir = makeCodeRepo({
            "README.md": "# demo\n",
            "src/a.ts": "export const a = 1;\n",
            "src/b.ts": "export const b = 2;\n",
        });
        const other = makeCodeRepo({ "OTHER.md": "# other\n" });
        return { dir, other, project: `verify-code-toolbar-${Date.now().toString(36)}` };
    },
    async assert(h, ctx) {
        const steps = [];

        // 1. the picker closes on an outside click and on Esc, and Esc does not leave Code
        const opened = await openFolderInCode(h, ctx.dir);
        await pageEval(h, `await until(() => sameRepoPath(S.globalStore.get(C.codeProjectAtom)?.path ?? "", ${JSON.stringify(ctx.dir)}), 8000); await nap(300);`);
        const before = await pageEval(h, `
            document.querySelector("[data-code-project-picker]")?.click();
            const shown = await until(pickerOpen, 4000);
            const body = document.querySelector("[data-code-tree]")?.getBoundingClientRect();
            return { shown, x: body ? body.left + body.width / 2 : 300, y: body ? body.top + body.height - 20 : 600 };
        `);
        await shot(h, "picker-open");
        await clickAt(h, before.x, before.y);
        const outside = await pageEval(h, `return until(() => !pickerOpen(), 4000);`);
        const esc = await pageEval(h, `
            document.querySelector("[data-code-project-picker]")?.click();
            const reopened = await until(pickerOpen, 4000);
            (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
            const closed = await until(() => !pickerOpen(), 4000);
            await nap(300);
            return { reopened, closed, surface: S.globalStore.get(model.surfaceAtom), focus: document.activeElement?.hasAttribute("data-code-project-picker") };
        `);
        await shot(h, "picker-closed");
        steps.push({
            step: "code-toolbar: the picker closes on an outside click and on Esc, and Esc does not leave Code",
            ok: opened === true && before?.shown === true && outside === true && esc?.reopened === true && esc.closed === true && esc.surface === "code",
            detail: JSON.stringify({ opened, before, outside, esc }),
        });

        // 2. a draft inside a collapsed folder shows the unsaved dot on the folder row
        await openFileInCode(h, "src/a.ts");
        const dot = await pageEval(h, `
            C.editDraft("export const a = 1;\\n// unsaved\\n");
            await nap(200);
            if (row("src")?.getAttribute("aria-expanded") === "true") row("src").click();
            await until(() => row("src")?.getAttribute("aria-expanded") === "false", 4000);
            await nap(200);
            return {
                collapsed: row("src")?.getAttribute("aria-expanded"),
                dot: row("src")?.querySelector('[aria-label="Contains unsaved edits"]') != null,
                cleanDot: row("README.md")?.querySelector('[aria-label="Contains unsaved edits"]') != null,
            };
        `);
        await shot(h, "folder-dot");
        steps.push({
            step: "code-toolbar: a draft inside a collapsed folder shows the unsaved dot on the folder row",
            ok: dot?.collapsed === "false" && dot.dot === true && dot.cleanDot === false,
            detail: JSON.stringify(dot),
        });

        // 3. N unsaved lists the draft and a row opens it
        await openFileInCode(h, "README.md");
        const list = await pageEval(h, `
            const count = document.querySelector("[data-code-unsaved-count]");
            const n = count?.getAttribute("data-code-unsaved-count");
            const label = flat(count);
            count?.click();
            await until(() => document.querySelector("[data-code-unsaved-row]") != null, 4000);
            const listed = [...document.querySelectorAll("[data-code-unsaved-row]")].map((r) => r.getAttribute("data-code-unsaved-row"));
            return { n, label, listed };
        `);
        await shot(h, "unsaved-list");
        const opens = await pageEval(h, `
            document.querySelector('[data-code-unsaved-row="src/a.ts"]')?.click();
            const landed = await until(() => openFile() === "src/a.ts", 6000);
            await nap(200);
            return { landed, closed: document.querySelector("[data-code-unsaved-row]") == null };
        `);
        await shot(h, "unsaved-opened");
        steps.push({
            step: "code-toolbar: N unsaved lists the draft and a row opens it",
            ok: list?.n === "1" && list.label === "1 unsaved" && list.listed.length === 1 && list.listed[0] === "src/a.ts" && opens?.landed === true && opens.closed === true,
            detail: JSON.stringify({ list, opens }),
        });
        // the draft is the scenario's own; drop it so it does not outlast the run in localStorage
        await pageEval(h, `C.revertDraft(); await nap(200);`);

        // 4. picking a registered project in the app-bar switcher while on Code opens it in Code
        const follow = await pageEval(h, `
            const ps = await mod("app/view/agents/projectsstore.ts");
            const name = ${JSON.stringify(ctx.project)};
            await ps.registerProject(name, ${JSON.stringify(ctx.other)});
            const listed = await until(() => C.registeredProjects(S.globalStore.get(ps.projectsAtom)).some((p) => p.name === name), 10000);
            window.__codeToolbarPrevScope = S.globalStore.get(model.projectFilterAtom);
            document.querySelector('[data-project-switcher="bar"]')?.click();
            await until(() => document.querySelector('[data-project-option="' + name + '"]') != null, 4000);
            const title = document.querySelector('[data-project-switcher="bar"]')?.getAttribute("title");
            document.querySelector('[data-project-option="' + name + '"]')?.click();
            const landed = await until(() => sameRepoPath(S.globalStore.get(C.codeProjectAtom)?.path ?? "", ${JSON.stringify(ctx.other)}) && row("OTHER.md") != null, 8000);
            await nap(300);
            return { listed, title, landed, surface: S.globalStore.get(model.surfaceAtom), project: S.globalStore.get(C.codeProjectAtom)?.name };
        `);
        await shot(h, "follow-switcher");
        steps.push({
            step: "code-toolbar: picking a registered project in the app-bar switcher while on Code opens it in Code",
            ok: follow?.listed === true && follow.landed === true && follow.surface === "code" && follow.title === "Set the project default; Code opens it",
            detail: JSON.stringify(follow),
        });

        // 5. the empty state's New project opens the New project dialog
        // the values are kept page-side so a step that throws between the empty and the restore still restores
        let empty;
        let dialog;
        try {
            empty = await pageEval(h, `
                window.__codeToolbarSaved = {
                    cfg: S.globalStore.get(atoms.fullConfigAtom),
                    stored: S.globalStore.get(C.lastCodeProjectAtom),
                    project: S.globalStore.get(C.codeProjectAtom),
                };
                S.globalStore.set(atoms.fullConfigAtom, { ...window.__codeToolbarSaved.cfg, projects: {} });
                S.globalStore.set(C.lastCodeProjectAtom, null);
                await C.selectProject(null);
                const shown = await until(() => /Add a project to browse its source here\\./.test(flat(document.body)), 4000);
                await nap(300);
                return { shown, actions: [...document.querySelectorAll("button")].filter((b) => flat(b) === "New project").length };
            `);
            await shot(h, "empty-state");
            dialog = await pageEval(h, `
                [...document.querySelectorAll("button")].find((b) => flat(b) === "New project")?.click();
                const shown = await until(() => [...document.querySelectorAll('[role="dialog"] h2')].some((e) => flat(e) === "New project"), 4000);
                await nap(200);
                return { shown, open: S.globalStore.get(model.newProjectOpenAtom) };
            `);
            await shot(h, "empty-new-project");
        } finally {
            await pageEval(h, `
                S.globalStore.set(model.newProjectOpenAtom, false);
                const saved = window.__codeToolbarSaved;
                delete window.__codeToolbarSaved;
                if (saved != null) {
                    S.globalStore.set(atoms.fullConfigAtom, saved.cfg);
                    S.globalStore.set(C.lastCodeProjectAtom, saved.stored);
                    if (saved.project != null) await C.selectProject(saved.project);
                }
                await nap(200);
            `);
        }
        steps.push({
            step: "code-toolbar: the empty state's New project opens the New project dialog",
            ok: empty?.shown === true && empty.actions === 1 && dialog?.shown === true && dialog.open === true,
            detail: JSON.stringify({ empty, dialog }),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await codeEval(h, `${LIB}
            S.globalStore.set(model.newProjectOpenAtom, false);
            if (window.__codeToolbarPrevScope != null) S.globalStore.set(model.projectFilterAtom, window.__codeToolbarPrevScope);
            delete window.__codeToolbarPrevScope;
            // the scenario's own drafts only, whatever step stopped short
            const mine = [${JSON.stringify(ctx?.dir ?? "")}, ${JSON.stringify(ctx?.other ?? "")}].filter((d) => d !== "");
            const drafts = S.globalStore.get(C.codeDraftsAtom);
            S.globalStore.set(C.codeDraftsAtom, new Map([...drafts].filter(([k]) => !mine.some((d) => sameRepoPath(k.slice(0, d.length), d)))));
            S.globalStore.set(C.lastCodeProjectAtom, null);
            await C.selectProject(null);
        `).catch(() => {});
        if (ctx?.project) await h.rpc("deleteproject", { name: ctx.project }).catch(() => {});
        await h.goto("cockpit");
        if (ctx?.dir) removeCodeRepo(ctx.dir);
        if (ctx?.other) removeCodeRepo(ctx.other);
    },
};
