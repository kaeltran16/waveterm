// Scenario `transcript-census-wsh`: the census's wsh card fixes. A stub until the task that owns it replaces it: it waits for the fixture seam.

import { waitSeam } from "./transcript-fixture.mjs";

export const transcriptCensusWsh = {
    name: "transcript-census-wsh",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        return [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
    },
};
