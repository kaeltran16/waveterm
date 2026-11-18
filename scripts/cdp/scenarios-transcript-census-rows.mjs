// Scenario `transcript-census-rows`: the census's row fixes (dividers, durations, message rows). A stub until the task that owns it replaces it: it waits for the fixture seam.

import { waitSeam } from "./transcript-fixture.mjs";

export const transcriptCensusRows = {
    name: "transcript-census-rows",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        return [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
    },
};
