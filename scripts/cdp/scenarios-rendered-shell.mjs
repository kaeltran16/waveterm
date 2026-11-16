// Scenario `rendered-shell`: the Rendered view's shell: pinned prompt, working line, empty and loading states, hosts.
// A stub until its task fills it: it checks only that the dev fixture seam is up.

import { clearTranscript, waitSeam } from "./transcript-fixture.mjs";

export const renderedShell = {
    name: "rendered-shell",
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
