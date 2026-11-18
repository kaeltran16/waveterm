// Scenario `transcript-census-markdown`: the census's markdown and user-bubble fixes. A stub until the task that owns it replaces it: it waits for the fixture seam.

import { waitSeam } from "./transcript-fixture.mjs";

export const transcriptCensusMarkdown = {
    name: "transcript-census-markdown",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        return [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
    },
};
