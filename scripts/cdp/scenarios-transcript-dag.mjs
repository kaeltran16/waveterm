// Scenario `transcript-dag`: run plan, verdict, Final and completion cards, and the dag status view.
// A stub until its task fills it: it checks only that the dev fixture seam is up.

import { clearTranscript, waitSeam } from "./transcript-fixture.mjs";

// named { entries, seed?, runEvents?, ctx? } the boards scenario composes (transcript-boards)
export const fixtures = {};

export const transcriptDag = {
    name: "transcript-dag",
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
