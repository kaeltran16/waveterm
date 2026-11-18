// Scenario `transcript-census-projection`: the census's projection fixes (transcriptprojection.ts). A stub until the
// task that owns it replaces it: it waits for the fixture seam, and projects one raw user record in the page.

import { projectInPage, waitSeam } from "./transcript-fixture.mjs";

const RAW_USER = JSON.stringify({ type: "user", message: { role: "user", content: "hello" } });

export const transcriptCensusProjection = {
    name: "transcript-census-projection",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        const entries = await projectInPage(h, [RAW_USER]);
        steps.push({
            step: "projectInPage projects a raw user record to a user entry",
            ok: entries?.length === 1 && entries[0].kind === "user" && entries[0].text === "hello",
            detail: JSON.stringify(entries),
        });
        return steps;
    },
};
