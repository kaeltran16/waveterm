// Scenario `transcript-census-steps`: the census's step-row fixes. A stub until the task that owns it replaces it: it waits for the fixture seam.

import { waitSeam } from "./transcript-fixture.mjs";

export const transcriptCensusSteps = {
    name: "transcript-census-steps",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        return [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
    },
};
