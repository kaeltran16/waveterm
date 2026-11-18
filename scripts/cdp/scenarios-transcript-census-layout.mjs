// Scenario `transcript-census-layout`: the census's layout fixes (tool bodies and wrapping). A stub until the task that owns it replaces it: it waits for the fixture seam.

import { waitSeam } from "./transcript-fixture.mjs";

export const transcriptCensusLayout = {
    name: "transcript-census-layout",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        return [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
    },
};
