// The project Overview modal (frontend/app/view/agents/projectoverview.tsx): the app-bar switcher offers
// "Overview of <project>" only with a project scoped; picking it opens the modal over the current surface with the
// project's branch, uncommitted changes and path in its header; Escape closes it and leaves the surface as it was.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookEval } from "./scenarios-shared.mjs";
import { makeCodeRepo, removeCodeRepo } from "./scenarios-code-kit.mjs";

const shot = (h, name) => h.shot(`cdp-shots/project-overview-${name}.png`);

const LIB = `
    const S = await mod("app/store/jotaiStore.ts");
    const ps = await mod("app/view/agents/projectsstore.ts");
    const model = (() => {
        const nav = document.querySelector("nav");
        const key = nav && Object.keys(nav).find((k) => k.startsWith("__reactFiber$"));
        for (let f = key ? nav[key] : null; f != null; f = f.return) {
            if (f.memoizedProps?.model?.surfaceAtom != null) return f.memoizedProps.model;
        }
        return null;
    })();
    const switcher = () => document.querySelector('[data-project-switcher="bar"]');
    const entry = () => document.querySelector("[data-project-overview-open]");
    const overview = () => document.querySelector("[data-project-overview]");
`;
const pageEval = (h, body) => lookEval(h, `${LIB} ${body}`);

export const projectOverview = {
    name: "project-overview",
    surface: "cockpit",
    async arrange() {
        const dir = makeCodeRepo({ "README.md": "# overview\n" });
        writeFileSync(join(dir, "NEW.md"), "uncommitted\n");
        return { dir, project: `verify-overview-${Date.now().toString(36)}` };
    },
    async assert(h, ctx) {
        const steps = [];

        // 1. with every project in scope the switcher has no Overview entry
        const unscoped = await pageEval(h, `
            await ps.registerProject(${JSON.stringify(ctx.project)}, ${JSON.stringify(ctx.dir)});
            const listed = await until(() => S.globalStore.get(ps.projectsAtom)?.[${JSON.stringify(ctx.project)}] != null, 10000);
            window.__overviewPrevScope = S.globalStore.get(model.projectFilterAtom);
            S.globalStore.set(model.projectFilterAtom, "all");
            await nap(200);
            switcher()?.click();
            const opened = await until(() => document.querySelector('[data-project-option="all"]') != null, 4000);
            const hasEntry = entry() != null;
            switcher()?.click();
            await nap(200);
            return { listed, opened, hasEntry };
        `);
        steps.push({
            step: "project-overview: with All projects in scope the switcher offers no Overview",
            ok: unscoped?.listed === true && unscoped.opened === true && unscoped.hasEntry === false,
            detail: JSON.stringify(unscoped),
        });

        // 2. with the project scoped the entry names it, at the top of the dropdown
        const scoped = await pageEval(h, `
            S.globalStore.set(model.projectFilterAtom, ${JSON.stringify(ctx.project)});
            await nap(200);
            switcher()?.click();
            const shown = await until(() => entry() != null, 4000);
            await nap(250);
            return { shown, label: flat(entry()), target: entry()?.getAttribute("data-project-overview-open") };
        `);
        await shot(h, "switcher-entry");
        steps.push({
            step: "project-overview: with a project scoped the switcher's first entry is 'Overview of <project>'",
            ok: scoped?.shown === true && scoped.label === `Overview of ${ctx.project}` && scoped.target === ctx.project,
            detail: JSON.stringify(scoped),
        });

        // 3. picking it opens the modal with the project's branch, changes and path; the surface stays
        const opened = await pageEval(h, `
            const surface = S.globalStore.get(model.surfaceAtom);
            entry()?.click();
            const shown = await until(() => overview() != null && overview().querySelector("[data-overview-changes]") != null, 8000);
            await nap(400);
            const o = overview();
            return {
                shown,
                project: o?.getAttribute("data-project-overview"),
                header: flat(o?.querySelector("header")),
                changes: flat(o?.querySelector("[data-overview-changes]")),
                dropdownClosed: entry() == null,
                surfaceBefore: surface,
                surfaceAfter: S.globalStore.get(model.surfaceAtom),
            };
        `);
        await shot(h, "open");
        steps.push({
            step: "project-overview: the entry opens the modal over the surface, naming branch, changes and path",
            ok:
                opened?.shown === true &&
                opened.project === ctx.project &&
                opened.header.includes("main") &&
                opened.changes.startsWith("1 file") &&
                opened.header.includes(ctx.dir) &&
                opened.dropdownClosed === true &&
                opened.surfaceAfter === opened.surfaceBefore,
            detail: JSON.stringify(opened),
        });

        // 4. Escape closes it and leaves the surface where it was
        const closed = await pageEval(h, `
            const surface = S.globalStore.get(model.surfaceAtom);
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            const gone = await until(() => overview() == null, 4000);
            return { gone, atom: S.globalStore.get(model.projectOverviewAtom), surfaceBefore: surface, surfaceAfter: S.globalStore.get(model.surfaceAtom) };
        `);
        await shot(h, "closed");
        steps.push({
            step: "project-overview: Escape closes the modal and keeps the surface",
            ok: closed?.gone === true && closed.atom === null && closed.surfaceAfter === closed.surfaceBefore,
            detail: JSON.stringify(closed),
        });
        return steps;
    },
    async teardown(h, ctx) {
        await pageEval(h, `
            S.globalStore.set(model.projectOverviewAtom, null);
            S.globalStore.set(model.projectFilterAtom, window.__overviewPrevScope ?? "all");
            delete window.__overviewPrevScope;
        `).catch(() => {});
        if (ctx?.project) await h.rpc("deleteproject", { name: ctx.project }).catch(() => {});
        if (ctx?.dir) removeCodeRepo(ctx.dir);
    },
};
