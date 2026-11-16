// Scenario `transcript-base`: the transcript's anatomy over plain entries: steps, folds, running steps, wsh change rows.
// A stub until its task fills it: it checks that the dev fixture seam is up and that the harness mounts a transcript
// through it with every option set.

import { bash, clearTranscript, prose, ROOT, showTranscript, user, waitSeam } from "./transcript-fixture.mjs";

const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);

const HARNESS = {
    entries: [
        user("ship the retry fix", T0),
        prose("Marking the chunk done.", T0 + 1_000),
        bash({ description: "Mark chunk 3 done", command: 'wsh effort chunk status "$E" 3 done', ts: T0 + 2_000, durationMs: 400 }),
    ],
    width: 640,
    ctx: { agentId: "tab-fixture", effortId: "e-fixture" },
    compact: false,
    active: false,
    renderers: true,
    seed: { "effort:e-fixture": { id: "e-fixture" } },
    runEvents: { "r-fixture": [] },
};

export const transcriptBase = {
    name: "transcript-base",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;
        await showTranscript(h, HARNESS);
        const shown = await h.ev(`(() => {
            const root = document.querySelector(${JSON.stringify(ROOT)});
            return root ? { bubbles: root.querySelectorAll('[data-user-bubble]').length, text: root.innerText.slice(0, 200) } : null;
        })()`);
        steps.push({
            step: "the harness mounts a transcript with ctx, seed and run events, its user bubble marked",
            ok: shown != null && shown.bubbles === 1 && shown.text.includes("Marking the chunk done."),
            detail: JSON.stringify(shown),
        });
        return steps;
    },
    async teardown(h) {
        await clearTranscript(h);
    },
};
