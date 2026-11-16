// Scenario `transcript-boards`: the wsh boards end to end, composed from the family scenarios' fixtures.
// A stub until its task fills it: it checks only that the dev fixture seam is up.

import { clearTranscript, waitSeam } from "./transcript-fixture.mjs";

export const transcriptBoards = {
    name: "transcript-boards",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        return [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
    },
    async teardown(h) {
        await clearTranscript(h);
    },
};
