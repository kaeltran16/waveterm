// The project Overview modal (frontend/app/view/agents/projectoverview.tsx): each project row in the app-bar
// switcher has an overview button beside its remove button, All projects has none; picking it opens the modal over the current surface with the
// project's branch, uncommitted changes and path in its header; Escape closes it and leaves the surface as it was.
// Between opening and Escape, each region's module (project-overview-<region>.mjs) checks its own states.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as activity from "./project-overview-activity.mjs";
import * as branches from "./project-overview-branches.mjs";
import * as history from "./project-overview-history.mjs";
import { pageEval, shot } from "./project-overview-kit.mjs";
import * as now from "./project-overview-now.mjs";
import { makeCodeRepo, removeCodeRepo } from "./scenarios-code-kit.mjs";

// the order the region modules run in, and the order teardown cleans them up in
const REGION_MODULES = [activity, now, branches, history];

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

        // 1. the All projects row has no overview button; the project's row has one
        const unscoped = await pageEval(h, `
            await ps.registerProject(${JSON.stringify(ctx.project)}, ${JSON.stringify(ctx.dir)});
            const listed = await until(() => S.globalStore.get(ps.projectsAtom)?.[${JSON.stringify(ctx.project)}] != null, 10000);
            window.__overviewPrevScope = S.globalStore.get(model.projectFilterAtom);
            S.globalStore.set(model.projectFilterAtom, "all");
            await nap(200);
            switcher()?.click();
            const opened = await until(() => document.querySelector('[data-project-option="all"]') != null, 4000);
            const allHasEntry = document.querySelector('[data-project-option="all"]')?.querySelector("[data-project-overview-open]") != null;
            const hasEntry = entry(${JSON.stringify(ctx.project)}) != null;
            switcher()?.click();
            await nap(200);
            return { listed, opened, allHasEntry, hasEntry };
        `);
        steps.push({
            step: "project-overview: the project's switcher row has an overview button, All projects has none",
            ok: unscoped?.listed === true && unscoped.opened === true && unscoped.allHasEntry === false && unscoped.hasEntry === true,
            detail: JSON.stringify(unscoped),
        });

        // 2. the button sits on the project's row, beside its remove button
        const scoped = await pageEval(h, `
            S.globalStore.set(model.projectFilterAtom, ${JSON.stringify(ctx.project)});
            await nap(200);
            switcher()?.click();
            const want = ${JSON.stringify(ctx.project)};
            const shown = await until(() => entry(want) != null, 4000);
            await nap(250);
            const row = entry(want)?.closest(".group");
            return {
                shown,
                title: entry(want)?.getAttribute("title"),
                onRow: row?.querySelector("[data-project-option]")?.getAttribute("data-project-option"),
                besideRemove: row?.querySelector('[title="Remove project"]') != null,
            };
        `);
        await shot(h, "switcher-entry");
        steps.push({
            step: "project-overview: the overview button sits on the project's row beside its remove button",
            ok: scoped?.shown === true && scoped.title === "Project overview" && scoped.onRow === ctx.project && scoped.besideRemove === true,
            detail: JSON.stringify(scoped),
        });

        // 3. picking it opens the modal with the project's branch, changes and path; the surface stays
        const opened = await pageEval(h, `
            const surface = S.globalStore.get(model.surfaceAtom);
            entry(${JSON.stringify(ctx.project)})?.click();
            const shown = await until(() => overview() != null && overview().querySelector("[data-overview-changes]") != null, 8000);
            await nap(400);
            const o = overview();
            return {
                shown,
                project: o?.getAttribute("data-project-overview"),
                header: flat(o?.querySelector("header")),
                changes: flat(o?.querySelector("[data-overview-changes]")),
                dropdownClosed: entry(${JSON.stringify(ctx.project)}) == null,
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

        // the body: Activity across the top, Now above Branches on the left, History wider on the right
        const layout = await pageEval(h, `
            const box = (r) => overview()?.querySelector('[data-overview-region="' + r + '"]')?.getBoundingClientRect();
            const all = await until(() => ["activity", "now", "branches", "history"].every((r) => box(r) != null), 4000);
            const [a, n, b, hi] = ["activity", "now", "branches", "history"].map((r) => {
                const x = box(r);
                return x && { top: Math.round(x.top), bottom: Math.round(x.bottom), left: Math.round(x.left), right: Math.round(x.right), width: Math.round(x.width) };
            });
            return { all, activity: a, now: n, branches: b, history: hi };
        `);
        await shot(h, "layout");
        const L = layout ?? {};
        steps.push({
            step: "project-overview: Main board, body: Activity spans the top, Now and Branches left of History, both ending level",
            ok:
                L.all === true &&
                L.activity.bottom <= L.now.top &&
                L.activity.bottom <= L.branches.top &&
                L.activity.bottom <= L.history.top &&
                L.now.bottom <= L.branches.top &&
                L.now.right <= L.history.left &&
                L.branches.right <= L.history.left &&
                Math.abs(L.branches.bottom - L.history.bottom) <= 2 &&
                L.history.width > L.now.width,
            detail: JSON.stringify(layout),
        });

        for (const m of REGION_MODULES) {
            steps.push(...(await m.steps(h, ctx)));
        }

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
        for (const m of REGION_MODULES) {
            await m.cleanup(h, ctx).catch(() => {});
        }
        await pageEval(h, `
            S.globalStore.set(model.projectOverviewAtom, null);
            S.globalStore.set(model.projectFilterAtom, window.__overviewPrevScope ?? "all");
            delete window.__overviewPrevScope;
        `).catch(() => {});
        if (ctx?.project) await h.rpc("deleteproject", { name: ctx.project }).catch(() => {});
        if (ctx?.dir) removeCodeRepo(ctx.dir);
    },
};
