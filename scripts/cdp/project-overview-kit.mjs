// What the project Overview scenario (scenarios-project-overview.mjs) and its region modules
// (project-overview-<region>.mjs) share: the page library, the screenshot, and opening and closing the modal.
import { lookEval } from "./scenarios-shared.mjs";

export const shot = (h, name) => h.shot(`cdp-shots/project-overview-${name}.png`);

export const LIB = `
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
    const entry = (p) => document.querySelector('[data-project-overview-open="' + CSS.escape(p) + '"]');
    const overview = () => document.querySelector("[data-project-overview]");
`;
export const pageEval = (h, body) => lookEval(h, `${LIB} ${body}`);

export const REGIONS = ["activity", "now", "branches", "history"];

// Scopes the project, opens the modal through the overview button on its switcher row and waits for the body's four region
// wrappers. It never waits on the header's changes, which a project without git never draws.
export function openOverview(h, project) {
    return pageEval(h, `
        const want = ${JSON.stringify(project)};
        const regions = ${JSON.stringify(REGIONS)};
        S.globalStore.set(model.projectFilterAtom, want);
        await nap(200);
        if (entry(want) == null) switcher()?.click();
        const listed = await until(() => entry(want) != null, 4000);
        entry(want)?.click();
        const ready = () => {
            const o = document.querySelector('[data-project-overview="' + CSS.escape(want) + '"]');
            return o != null && regions.every((r) => o.querySelector('[data-overview-region="' + r + '"]') != null);
        };
        const shown = await until(ready, 8000);
        return { listed, shown };
    `);
}

export function closeOverview(h) {
    return pageEval(h, `
        S.globalStore.set(model.projectOverviewAtom, null);
        return { gone: await until(() => overview() == null, 4000) };
    `);
}
